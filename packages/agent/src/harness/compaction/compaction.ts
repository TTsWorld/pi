/**
 * @file 上下文压缩（compaction）模块主文件
 * @description 实现会话上下文压缩全流程：触发 → 切点 → 总结 → 落盘。
 *
 * 当上下文逼近模型 context window 时，把较早的历史折叠为结构化总结：
 *
 * 1. 触发：{@link shouldCompact} 判定 contextTokens > contextWindow - reserveTokens；
 * 2. 估算：{@link estimateTokens} / {@link estimateContextTokens} 优先使用 provider
 *   返回的真实 usage，缺失时退回「字符数 / 4」的保守启发式；
 * 3. 切点：{@link findCutPoint} 从尾部累计 keepRecentTokens 预算，只在合法消息
 *   边界落刀，并能识别切在回合中间的 split-turn；
 * 4. 准备：{@link prepareCompaction} 把 session entries 划分为待总结历史 /
 *   回合前缀 / 保留尾部，并继承上一次压缩的总结与文件清单；
 * 5. 总结：{@link compact} 通过独立的 completeSimple 请求（cacheRetention:"none"）
 *   生成或增量更新 Goal/Progress/Next Steps 格式的结构化总结，附文件清单；
 * 6. 落盘：结果为 {@link CompactResult}，由上层写成 CompactionEntry（summary +
 *   retainedTail）追加进 session；后续读取上下文永不越过该 entry，被压缩的
 *   历史不再进入 LLM 上下文。
 */
import {
	type Api,
	type AssistantMessage,
	type Context,
	contentText,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	type SimpleStreamOptions,
	type Usage,
	uuidv7,
} from "@earendil-works/pi-ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import { buildSessionContext } from "../session/context.ts";
import type { CompactionEntry, Entry } from "../session/types.ts";
import { CompactionError, err, ok, type Result } from "../types.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** 存储在生成的 compaction entry 上的文件操作明细。 */
export interface CompactionDetails {
	/** 被压缩历史中读取过的文件。 */
	readFiles: string[];
	/** 被压缩历史中修改过的文件。 */
	modifiedFiles: string[];
}
/** 安全的 JSON 序列化：失败（如循环引用）时返回占位符而非抛错。 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/**
 * 汇总被压缩历史中的文件操作（read / write / edit tool call）。
 *
 * Why：历史一旦被折叠成总结，原始 tool call 就不再出现在上下文里，文件清单
 * 无法事后恢复；因此每次压缩都从「上次压缩的 details + 本次待总结消息」滚动
 * 累积，保证 readFiles/modifiedFiles 跨多次压缩依然完整。
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: Entry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	// 以上一次压缩累计的文件清单作为起点
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
/**
 * 把 session entry 还原为等价的 AgentMessage。
 * message 原样返回；branch_summary / compaction entry 则重建为对应的总结消息，
 * 使旧总结也能作为普通内容参与后续的 summarization。
 */
function getMessageFromEntry(entry: Entry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

/**
 * 压缩专用的 entry → message 还原：跳过旧的 compaction entry。
 * Why：旧总结的内容已通过 previousSummary 增量并入新总结，若再作为消息
 * 喂给 LLM 会导致同样的内容被重复 summarization。
 */
function getMessageFromEntryForCompaction(entry: Entry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** 已生成的压缩数据，可直接落盘为一条 compaction entry。 */
export interface CompactResult<T = unknown> {
	/** 总结文本；被压缩的历史在后续上下文中由它替代。 */
	summary: string;
	/** 压缩前的上下文 token 估算值。 */
	tokensBefore: number;
	/** 生成该总结的 LLM 调用（可能多次）产生的 usage，若可用。 */
	usage?: Usage;
	/** 压缩后保留的近期消息，直接存放在 compaction entry 上。 */
	retainedTail: AgentMessage[];
	/** 可选的实现相关明细，随 compaction entry 一并存储。 */
	details?: T;
}

/**
 * 带重试的独立 completeSimple 调用，专用于总结生成。
 * 每次尝试覆盖 cacheRetention 为 "none" 并生成新的 sessionId。
 */
export async function completeSimpleWithRetries(
	models: Models,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// Why：总结是独立的一次性请求——隔离路由（新 sessionId），并禁用 cache 写入，
	// 因为这条请求的 cache 前缀无法被主会话复用，写入只是浪费。
	const requestOptions: SimpleStreamOptions = {
		...options,
		cacheRetention: "none",
		sessionId: uuidv7(),
	};
	return retryAssistantCall(
		() => models.completeSimple(model, context, requestOptions),
		retry,
		requestOptions.signal,
		callbacks,
	);
}

/** 合并两次 LLM 调用（如历史总结 + 回合前缀总结）的 usage 与费用；可选字段仅在实际出现时保留。 */
function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

/** 压缩阈值与保留设置。 */
export interface CompactionSettings {
	/** 是否启用自动压缩判定。 */
	enabled: boolean;
	/** 为总结 prompt 与输出预留的 token 数。 */
	reserveTokens: number;
	/** 压缩后保留的近期上下文 token 预算（近似值）。 */
	keepRecentTokens: number;
}

/** harness 使用的默认压缩设置（预留 16384 token，保留约 20000 token 近期上下文）。 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** 从 provider usage 计算总上下文 token 数；totalTokens 未上报（为 0）时退回各分项之和。 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
/**
 * 提取 assistant 消息上可信的 usage。
 * Why：stopReason 为 aborted / error 的响应其 usage 不反映完整上下文，
 * token 为 0 的 usage 也没有参考价值，均排除。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/** 返回 session entries 中最后一条有效 assistant 消息的 usage。 */
export function getLastAssistantUsage(entries: Entry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** 消息列表的上下文 token 用量估算结果。 */
export interface ContextUsageEstimate {
	/** 估算的总上下文 token。 */
	tokens: number;
	/** 最近一个 assistant usage 上报的 token 数。 */
	usageTokens: number;
	/** 最近一个 assistant usage 之后消息的估算 token。 */
	trailingTokens: number;
	/** 提供 usage 的消息下标；不存在时为 null。 */
	lastUsageIndex: number | null;
}

/** 返回最后一个带有效 usage 的 assistant 消息及其下标（从尾部向前查找）。 */
function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * 估算消息列表的上下文 token。
 *
 * Why（token 估算策略）：provider 在 assistant 响应里上报的 usage 是最准确的
 * 基准，因此优先采用最近一次 usage，只对其后的 trailing 消息做启发式估算；
 * 完全没有 usage 时才退回对整段消息的启发式估算。
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		// ========== 无 usage 基准：整段启发式估算 ==========
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	// ========== 有 usage 基准：真实 usage + 尾部消息启发式估算 ==========
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** 判断上下文用量是否越过配置的压缩阈值（contextTokens > contextWindow - reserveTokens）。 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

/** 图片块没有可数的文本长度，用固定字符数折算其 token 开销（4800 字符 ≈ 1200 token）。 */
const ESTIMATED_IMAGE_CHARS = 4800;

/** 统计文本/图片混合内容的字符数：文本块计实际长度，图片块按 ESTIMATED_IMAGE_CHARS 折算。 */
function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * 用保守的字符启发式（约 4 字符 = 1 token）估算单条消息的 token 数。
 *
 * Why：这是拿不到 tokenizer 时的兜底方案——宁可高估（提前触发压缩），
 * 也不能低估导致上下文溢出。按角色分别统计可见文本、thinking、
 * tool call 的名称与参数等会实际进入上下文的部分。
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
/**
 * 枚举 [startIndex, endIndex) 内所有合法切点的 entry 下标。
 *
 * Why（切点合法性判定）：切点必须落在完整消息的起点上——
 * - toolResult 不能作为切点：会把 tool call 与其结果拆开，违反 LLM API 的配对约束；
 * - 配置类 entry（model_change / thinking_level_change / active_tools_change 等）
 *   不单独构成消息边界，跳过；
 * - branch_summary 是例外：它自带回合起点的完整语义，可作为切点。
 */
function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "active_tools_change":
			case "compaction":
			case "branch_summary":
			case "custom":
				break;
		}
		if (entry.type === "branch_summary") cutPoints.push(i);
	}
	return cutPoints;
}

/** 找到包含指定 entry 的回合的起始用户可见消息（user / bashExecution 消息或 branch_summary），找不到返回 -1。 */
export function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** 压缩选定的切点结果。 */
export interface CutPointResult {
	/** 压缩后保留的第一个 entry 的下标。 */
	firstKeptEntryIndex: number;
	/** 切点拆分回合时该回合起始 entry 的下标，否则为 -1。 */
	turnStartIndex: number;
	/** 选定切点是否拆分了一个进行中的回合（split-turn）。 */
	isSplitTurn: boolean;
}

/**
 * 寻找压缩切点，使保留部分近似满足 keepRecentTokens 预算。
 *
 * 策略：从尾部向前累计消息 token，在首次累计到预算的消息处，取其后第一个
 * 合法切点；再把切点左移跨过紧邻的配置类 entry（保证会话状态随尾部保留）。
 * 若最终切点不是 user 消息，则判定为拆分了回合（split-turn）。
 */
export function findCutPoint(
	entries: Entry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		// ========== 无合法切点：保底保留全部，从 startIndex 开始 ==========
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	// ========== 从尾部累计 token，定位满足预算的最早切点 ==========
	// Why：反向累计保证保留的一定是「最近」的上下文；在首次达到预算的消息 i 处，
	// 取第一个 >= i 的合法切点，使保留区至少覆盖 keepRecentTokens。
	// 若整个区间都达不到预算，则维持 cutPoints[0]（尽可能多保留）。
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	// ========== 把切点左移跨过紧邻的配置类 entry ==========
	// Why：model_change / active_tools_change 等配置 entry 承载会话状态，若被切进
	// 总结区就会丢失；左移切点让它们随保留尾部继续生效。切点前一条是 message
	//（自然边界）或 compaction（旧压缩 entry 不并入新尾部，其内容由
	// previousSummary 承载）时停止。
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	// ========== 判定 split-turn ==========
	// Why：切在 user 消息上是干净的回合边界；否则说明一个回合被从中间切开，
	// 需要定位该回合的起点，供调用方单独总结「回合前缀」。
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

/**
 * 总结任务的 system prompt：限定模型只输出结构化总结，
 * 严禁续写对话或回答对话内容里的问题。
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

/**
 * 全新总结的 user prompt 模板（无旧总结时使用）。
 * 要求按 Goal / Constraints & Preferences / Progress / Key Decisions /
 * Next Steps / Critical Context 的固定格式生成结构化 checkpoint，
 * 供下一个 LLM 无缝接续工作。
 */
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 增量更新总结的 user prompt 模板（存在 previousSummary 时使用）。
 * Why：二次压缩若从零重新总结会丢失更早压缩的历史；改为在旧总结基础上
 * 合并新消息——保留既有信息、推进 Progress / Next Steps，仅移除不再相关的内容。
 */
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** 为压缩生成或更新对话总结（{@link generateSummaryWithUsage} 的便捷封装，丢弃 usage）。 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<Result<string, CompactionError>> {
	const result = await generateSummaryWithUsage(
		currentMessages,
		models,
		model,
		reserveTokens,
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
		callbacks,
	);
	return result.ok ? ok(result.value.text) : err(result.error);
}

/** 生成或更新对话总结，并返回总结文本与 provider usage。 */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	// ========== 计算输出预算 ==========
	// Why：总结输出最多占用 reserveTokens 的 80%——总结本身不能大到把上下文
	// 再次撑爆；同时不超过模型自身的 maxTokens 上限。
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	// ========== 构造 prompt：增量更新与全新总结的分界 ==========
	// 有 previousSummary 走 UPDATE 模板（在旧总结上合并新消息），否则走全新总结
	// 模板；customInstructions 作为调用方的额外聚焦点追加到模板之后。
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}
	// 对话与旧总结分别用 XML 标签包裹，帮助模型清晰区分各部分内容
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };

	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		retry,
		callbacks,
	);
	// ========== 失败处理 ==========
	// aborted（外部中止）与 error（模型/请求失败）映射为不同的错误 code，
	// 供上层决定是重试还是放弃本次压缩。
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	const textContent = contentText(response.content);

	return ok({ text: textContent, usage: response.usage });
}

/** 一次压缩运行所需的全部输入（由 {@link prepareCompaction} 产出）。 */
export interface CompactionPreparation {
	/** 被折叠进历史总结的消息。 */
	messagesToSummarize: AgentMessage[];
	/** 压缩拆分回合（split-turn）时单独总结的回合前缀消息。 */
	turnPrefixMessages: AgentMessage[];
	/** 压缩后保留的近期消息，直接存放在 compaction entry 上。 */
	retainedTail: AgentMessage[];
	/** 是否拆分了回合。 */
	isSplitTurn: boolean;
	/** 压缩前的上下文 token 估算值。 */
	tokensBefore: number;
	/** 用于增量更新的上一次压缩总结。 */
	previousSummary?: string;
	/** 从被总结历史中提取的文件操作。 */
	fileOps: FileOperations;
	/** 本次压缩使用的设置。 */
	settings: CompactionSettings;
}

/** 把 session entries 准备为一次压缩的输入；压缩不适用时返回 ok(undefined)。 */
export function prepareCompaction(
	pathEntries: Entry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	// ========== 快速退出 ==========
	// Why：空路径无可压缩；最后一个 entry 已是 compaction 说明刚压缩过，无需再压。
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	// ========== 定位上一次压缩并展开其 retainedTail ==========
	// Why：旧 compaction entry 本身不进入可压缩范围（其总结由 previousSummary
	// 承载，增量并入新总结），但它保留的 retainedTail 必须展开为虚拟 message
	// entries 并入可压缩范围——这些消息上一次压缩时被保留，这次才轮到被处理。
	let previousSummary: string | undefined;
	let compactableEntries = pathEntries;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
			type: "message",
			id: `${prevCompaction.id}:retained:${index}`,
			parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
			seq: prevCompaction.seq,
			timestamp: message.timestamp,
			message,
		}));
		compactableEntries = [...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
	}
	const boundaryEnd = compactableEntries.length;

	// tokensBefore 采用「读取上下文」的口径（含旧总结消息）估算，与触发阈值可比
	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	// ========== 计算切点并划分三个区间 ==========
	// split-turn 时历史总结止于回合起点（turnStartIndex），被切开的回合前缀
	// 单独总结；保留尾部一律从 firstKeptEntryIndex 开始。
	const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = 0; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const retainedTail: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) retainedTail.push(msg);
	}
	// ========== 汇总文件操作：历史消息 + split-turn 的回合前缀一起计入 ==========
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

/**
 * split-turn 时对「回合前缀」的总结模板：单个回合大到无法整体保留时，
 * 前缀被单独总结（Original Request / Early Progress / Context for Suffix），
 * 为保留下来的后缀（近期工作）提供理解所需的上下文。
 */
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

// 转发 serializeConversation，供外部模块复用同一套对话序列化格式
export { serializeConversation } from "./utils.ts";

/** 基于准备好的会话历史生成压缩总结数据（{@link CompactResult}）。 */
export async function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<Api>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<Result<CompactResult, CompactionError>> {
	const {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	let summaryUsage: Usage;

	// ========== 生成总结：split-turn 与常规路径的分界 ==========
	// Why：切点落在回合中间时，一次总结覆盖不了「更早历史 + 被切开的回合前缀」
	// 两种性质的内容——先（可选）增量总结更早的历史，再用专门的模板总结回合
	// 前缀，两段拼接为一条总结；常规路径只调用一次总结。
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// 历史总结可能不存在（首次压缩就发生 split-turn），此时使用占位文本
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				models,
				model,
				settings.reserveTokens,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				retry,
				callbacks,
			);
			if (!historyResult.ok) return err(historyResult.error);
			historyText = historyResult.value.text;
			historyUsage = historyResult.value.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			models,
			model,
			settings.reserveTokens,
			signal,
			thinkingLevel,
			retry,
			callbacks,
		);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
		summaryUsage = historyUsage
			? combineUsage(historyUsage, turnPrefixResult.value.usage)
			: turnPrefixResult.value.usage;
	} else {
		const summaryResult = await generateSummaryWithUsage(
			messagesToSummarize,
			models,
			model,
			settings.reserveTokens,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			retry,
			callbacks,
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value.text;
		summaryUsage = summaryResult.value.usage;
	}

	// ========== 附加文件清单 ==========
	// Why：readFiles/modifiedFiles 以 XML 标签追加到总结末尾，让接续的 LLM
	// 不必翻阅已被折叠的 tool call 就知道哪些文件动过。
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary,
		tokensBefore,
		usage: summaryUsage,
		retainedTail,
		details: { readFiles, modifiedFiles } as CompactionDetails,
	});
}
/**
 * 总结被切开的回合前缀（split-turn 专用）。
 * 输出预算取 reserveTokens 的 50%，低于完整总结——前缀只需为保留下来的
 * 后缀提供足够上下文，无需面面俱到。
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, signal, reasoning: thinkingLevel }
			: { maxTokens, signal };
	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		completionOptions,
		retry,
		callbacks,
	);
	// 失败处理：与主总结一致，aborted / error 分别映射为不同的错误 code
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	return ok({
		text: contentText(response.content),
		usage: response.usage,
	});
}
