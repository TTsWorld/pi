/**
 * @file 长会话的上下文压缩（compaction）核心逻辑
 * @description 当上下文逼近模型窗口上限时，把较早的历史折叠为结构化摘要，
 * 并以 CompactionEntry 落盘；之后读取上下文永不越过该 entry，历史不再进入 LLM。
 *
 * 本文件只包含纯函数逻辑，会话 I/O 由 session-manager 负责，压缩完成后由其重载会话。
 * 关键流程：
 * 1. 触发判定：shouldCompact（contextTokens > contextWindow - reserveTokens）；
 * 2. token 估算：estimateContextTokens 优先采用最后一条 assistant 消息的真实
 *    usage，其后新增消息用「字符数 / 4」启发式补估；
 * 3. 切点选择：findCutPoint 从最新往回累计 keepRecentTokens 预算，只在合法
 *    消息边界落刀，并能识别切在回合中间的 split-turn；
 * 4. 准备：prepareCompaction 划分待总结历史 / 回合前缀 / 保留尾部，并继承上
 *    一次压缩的摘要与文件清单（extension 可在此 hook）；
 * 5. 生成：compact 调 LLM 产出或增量更新结构化摘要，附文件清单，返回
 *    CompactionResult 由 SessionManager 落盘。
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { contentText, type RetryCallbacks, type RetryPolicy, retryAssistantCall, uuidv7 } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "../messages.ts";
import {
	buildSessionContext,
	type CompactionEntry,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "../session-manager.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// 模块内部组织（按出现顺序）：文件操作追踪 → 消息提取 → 类型与默认配置 →
// token 计算 → 切点检测 → 摘要生成 → 压缩准备（供扩展 hook）→ 主压缩函数。

// ============================================================================
// 文件操作追踪
// ============================================================================

/** 存储在 CompactionEntry.details 中、用于文件追踪的明细 */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

/**
 * 从「本次待总结消息 + 上一次压缩的明细」中提取文件操作。
 *
 * Why 滚动累积：历史一旦折叠成摘要，原始 tool call 不再出现在上下文里，
 * 文件清单事后无法恢复；因此每次压缩都以上一次的 details 为起点继续累加，
 * 保证 readFiles / modifiedFiles 跨多次压缩依然完整。
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// 从上一次压缩的 details 继承（仅限 pi 自身生成的，扩展生成的结构不保证兼容）
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook 字段为会话文件兼容性而保留
			const details = prevCompaction.details as CompactionDetails;
			// 防御式校验数组结构，旧会话文件可能缺失字段
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// 再从本次待总结消息的 tool call 中提取
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	// 返回累积后的集合；最终清单由 computeFileLists 统一去重排序
	return fileOps;
}

// ============================================================================
// 消息提取
// ============================================================================

/**
 * 从 entry 中提取其产生的 AgentMessage（若有的话）。
 * 不产生 LLM 上下文的 entry（如 compaction 边界）返回 undefined。
 */
function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	// 上一次压缩的摘要不重复进入待总结消息——它已通过 previousSummary 参与增量更新。
	// 与 branch-summarization 的做法不同：那里把旧摘要重建为消息，这里走增量合并
	if (entry.type === "compaction") {
		return undefined;
	}
	// 非 compaction entry 取其展开出的第一条上下文消息；不产生消息的元数据 entry 返回 undefined
	return sessionEntryToContextMessages(entry)[0];
}

/** compact() 的结果——SessionManager 落盘时会补上 uuid/parentUuid */
export interface CompactionResult<T = unknown> {
	/** 生成的结构化摘要（含文件清单） */
	summary: string;
	/** 保留尾部中第一条 entry 的 UUID，即压缩边界 */
	firstKeptEntryId: string;
	/** 压缩前的上下文 token 数 */
	tokensBefore: number;
	/** 压缩后估算 token 数（可选） */
	estimatedTokensAfter?: number;
	/** 生成该摘要的 LLM 调用（可能多次）合计 usage（若可用） */
	usage?: Usage;
	/** 扩展自定义数据（如 ArtifactIndex、结构化压缩的版本标记） */
	details?: T;
}

/** 把两次 LLM 调用的 usage 逐项相加；可选字段只要有一方存在就保留并按 0 补齐。 */
function combineUsage(first: Usage, second: Usage): Usage {
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		// 可选字段（1h 缓存、reasoning）：任一侧有值就输出字段，缺失侧按 0 计
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }
			: {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }
			: {}),
		totalTokens: first.totalTokens + second.totalTokens,
		// 费用同样逐项相加，保持与 usage 分量一一对应
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 压缩配置（来自 settings.jsonl），决定是否触发以及压缩幅度。
 * 注意 reserveTokens 身兼两职：既是触发阈值的一部分，也是摘要输出 token 上限的基数。
 */
export interface CompactionSettings {
	/** 是否启用自动压缩 */
	enabled: boolean;
	/** 触发阈值：上下文超过 contextWindow - reserveTokens 时压缩 */
	reserveTokens: number;
	/** 保留预算：切点之后约保留这么多 token 的最近消息不压缩 */
	keepRecentTokens: number;
}

/**
 * 压缩配置的默认值：默认开启；预留 16384 token 的触发缓冲；
 * 压缩时保留约 20000 token 的最近消息不折叠。
 */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

// ============================================================================
// token 计算
// ============================================================================

/**
 * 由 usage 计算上下文总 token：优先使用 provider 返回的原生 totalTokens，
 * 缺失（为 0）时退回各分量之和（含 cache 读/写）。
 */
export function calculateContextTokens(usage: Usage): number {
	// totalTokens 为 0/缺失时退回分量求和；cache 部分也占上下文窗口，必须计入
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * 取 assistant 消息中可用的 usage。
 * 跳过中止、出错、usage 全为 0 的消息——它们没有有效的用量数据，
 * 贸然采用会把上下文规模误估为 0。
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		// 三个条件分别排除：被中止（usage 不完整）、出错（无有效用量）、全 0
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

/**
 * 从 session entries 中找最后一条有效 assistant usage。
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	// 从最新往回找，遇到第一个有效 usage 即返回。
	// 只检查 message 类型：usage 只存在于 assistant 消息上
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** 上下文规模的估算结果，区分「真实 usage」与「启发式估算」两部分。 */
export interface ContextUsageEstimate {
	/** 估算的上下文总 token（usage + 尾部估算） */
	tokens: number;
	/** 来自最后一条 assistant usage 的真实 token 数 */
	usageTokens: number;
	/** usage 之后新增消息的启发式估算 token 数 */
	trailingTokens: number;
	/** 最后一条有效 usage 的消息下标（无则 null） */
	lastUsageIndex: number | null;
}

/**
 * 在消息序列中找最后一条有效 assistant usage，同时返回其下标
 * （下标用于界定「usage 已覆盖的范围」与「需要补估的尾部」）。
 */
function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	// 从尾部往回找，遇到第一条有效 usage 即返回
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * 估算整段消息的上下文 token：有真实 usage 时以最后一条 assistant usage 为准
 * （该 usage 即当时完整请求的 input 规模），其后追加的消息用 estimateTokens 补估；
 * 完全没有 usage 时（如会话刚起步）全部用启发式估算。
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		// ===== 无真实 usage：整段退化为纯启发式估算 =====
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

	// ===== 有真实 usage：以它为锚点，补估其后的新增消息 =====
	const usageTokens = calculateContextTokens(usageInfo.usage);
	// 只补估 usage 之后的消息：usage 本身已覆盖其之前的全部上下文
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

/**
 * 判断是否应触发压缩：上下文 token 超过「窗口 - 预留」即触发。
 * 未启用压缩时恒为 false。
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	// 未启用压缩时恒为 false——手动压缩不走此判定
	if (!settings.enabled) return false;
	// 留出 reserveTokens 的缓冲：在真正撞上窗口上限之前就触发
	return contextTokens > contextWindow - settings.reserveTokens;
}

// ============================================================================
// 切点检测
// ============================================================================

/** 单张图片按字符计的估算值：约 4800 字符 ≈ 1200 token（典型小图编码规模）。 */
const ESTIMATED_IMAGE_CHARS = 4800;

/** 统计内容的字符规模：text 块按实际长度，image 块按固定估算值折算。 */
function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	// 纯字符串内容直接计长
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			// 图片没有文本长度，用固定字符量折算（见 ESTIMATED_IMAGE_CHARS）
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * 用「字符数 / 4」启发式估算单条消息的 token 数。
 * 英文文本约 4 字符/token，此法偏保守（高估），用于预算判断宁可早压缩。
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
			// assistant 的三种内容块分别计长：正文、thinking、工具调用（名字+参数序列化）
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			// custom / toolResult：内容可能是文本或图文混排，统一走字符统计
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			// 命令本身与其输出都计入
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			// 摘要类消息只按摘要正文的长度估算
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	// 未知消息类型：按 0 计，不参与预算
	return 0;
}

/** 是否可作为切点：上下文可见的 user 型 / assistant 消息；tool result 不可（必须紧跟其 tool call）。 */
function isCutPointMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "assistant":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "toolResult":
			// tool result 不能单独成切点：与前面的 tool call 拆开会破坏配对关系
			return false;
	}
	return false;
}

/** 是否是回合起点（user 型消息）：assistant / toolResult 属于回合内部，不算起点。 */
function isTurnStartMessage(message: AgentMessage): boolean {
	switch (message.role) {
		case "user":
		case "bashExecution":
		case "custom":
		case "branchSummary":
		case "compactionSummary":
			return true;
		case "assistant":
		case "toolResult":
			// 回合的响应部分：标志着已进入某个回合的内部
			return false;
	}
	return false;
}

/** entry 层面的回合起点判断；compaction entry 永远不算。 */
function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "compaction") {
		return false;
	}
	// 一个 entry 可能展开为多条上下文消息，任一是回合起点即算
	return sessionEntryToContextMessages(entry).some(isTurnStartMessage);
}

/**
 * 找出所有合法切点：上下文可见的 user 型 / assistant 消息所在 entry 的下标。
 * 绝不在 tool result 处切——它必须紧跟所属的 tool call。
 * 若切在某条带 tool call 的 assistant 消息上，其 tool result 排在它之后，会被保留。
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	// 候选按区间内下标升序收集，后续「找最近切点」依赖这一有序性
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		// 压缩边界本身不是切点候选
		if (entry.type === "compaction") {
			continue;
		}
		if (sessionEntryToContextMessages(entry).some(isCutPointMessage)) {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * 找到包含指定下标的那个回合的起点（上下文可见的 user 型消息）。
 * 在 [startIndex, entryIndex] 范围内向前搜索，找不到返回 -1。
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	// 从给定位置向旧方向搜索，遇到的第一个回合起点即所属回合的边界
	for (let i = entryIndex; i >= startIndex; i--) {
		if (isTurnStartEntry(entries[i])) {
			return i;
		}
	}
	return -1;
}

/** findCutPoint 的结果：切点位置与「是否切在回合中间」的判定。 */
export interface CutPointResult {
	/** 保留尾部的第一个 entry 下标 */
	firstKeptEntryIndex: number;
	/** 被切开的那个回合的起点（user 消息）下标；未切在回合中间时为 -1 */
	turnStartIndex: number;
	/** 是否把一个回合从中间切开（切点不是 user 型消息） */
	isSplitTurn: boolean;
}
// isSplitTurn 为 true 时：[turnStartIndex, firstKeptEntryIndex) 是回合前缀，
// 会被单独总结并并入摘要；[firstKeptEntryIndex, ...) 原样保留

/**
 * 在 session entries 中找切点，使保留部分约为 `keepRecentTokens`。
 *
 * 算法：从最新往回累计消息的估算大小，累计值达到 keepRecentTokens 即停，
 * 在该处或其后最近的合法切点落刀。
 *
 * 可以切在 user 或 assistant 消息上（绝不在 tool result 上）。若切在带
 * tool call 的 assistant 消息上，其 tool result 排在后面会被保留。
 *
 * 返回的 CutPointResult：
 * - firstKeptEntryIndex：从该 entry 开始保留
 * - turnStartIndex：若切在回合中间，该回合的起点 user 消息下标
 * - isSplitTurn：是否切在回合中间
 *
 * 只考虑 `startIndex` 与 `endIndex`（不含）之间的 entries。
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	// 没有任何合法切点（如全是 tool result）：整体保留，从头开始
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// ===== 从最新往回累计，直到达到保留预算 =====
	// 从最新往回累计消息的估算大小
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // 默认从第一个切点开始保留（而非会话头）

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const messageTokens = sessionEntryToContextMessages(entry).reduce(
			(sum, message) => sum + estimateTokens(message),
			0,
		);
		// 不产生上下文消息的 entry（元数据类）不占预算
		if (messageTokens === 0) continue;
		accumulatedTokens += messageTokens;

		// 已累计到保留预算：在此处落刀
		if (accumulatedTokens >= keepRecentTokens) {
			// 取「位于当前 entry 或其后」的最近一个合法切点，
			// 保证切点不会落在回合内部的 tool result 上
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// 从切点向前回扫，把不影响上下文的相邻元数据 entry 一并划入保留区。
	// Why：这些 entry 不占 token，留在历史区只会被无谓地折叠；遇压缩边界
	// 或任何上下文可见 entry 即停。
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction" || sessionEntryToContextMessages(prevEntry).length > 0) {
			break;
		}
		cutIndex--;
	}

	// ===== 回扫元数据 + 判定 split turn =====
	// 判定是否切在回合中间：切点本身不是回合起点 → split turn
	const cutEntry = entries[cutIndex];
	const startsTurn = isTurnStartEntry(cutEntry);
	// 找不到回合起点（异常结构）时 turnStartIndex 为 -1，此时不算 split turn
	const turnStartIndex = startsTurn ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !startsTurn && turnStartIndex !== -1,
	};
}

// ============================================================================
// 摘要生成
// ============================================================================

/** 首次总结的提示词：产出供后续 LLM 接续工作的结构化「上下文检查点」。 */
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

/** 增量更新的规则文本：保留旧信息、并入新信息、滚动更新 Progress/Next Steps。 */
const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
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

/** 增量更新版提示词：把新消息并入 <previous-summary> 中的旧摘要。 */
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

/**
 * 当总结响应不能安全落盘时返回错误信息。
 * stopReason 为 length 说明摘要被 token 上限截断、内容不完整，
 * 绝不能作为会话检查点持久化。
 */
export function getSummarizationFailure(response: AssistantMessage, label: string): string | undefined {
	if (response.stopReason === "error") {
		return `${label} failed: ${response.errorMessage || "Unknown error"}`;
	}
	if (response.stopReason === "length") {
		return `${label} failed: generation hit the token cap and the summary is incomplete`;
	}
	return undefined;
}

/**
 * 组装总结请求的 SimpleStreamOptions；推理型模型按 thinkingLevel 开启推理预算。
 * 三个总结入口（历史摘要 / 分支摘要 / 回合前缀摘要）共用此函数，
 * 保证鉴权、中止信号与推理参数的处理一致。
 */
function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	env: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	sessionId: string | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers, env, sessionId };
	// 只有模型支持推理且用户未关闭时才下发 reasoning
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

/**
 * 所有压缩/分支摘要 LLM 调用的统一收口。把单次调用包进 {@link retryAssistantCall}，
 * 使瞬时断流（如 `terminated`、socket 关闭）按配置的重试策略重试，
 * 而不是第一次失败就放弃整次压缩。确定性错误与中止会立即返回
 * （见 {@link retryAssistantCall}）。
 */
export async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// 一次性摘要不做缓存写入（cacheRetention: none）；路由 sessionId 优先复用调用方
	// 提供的，没有 session ID 的调用方（含分支摘要）会拿到一个新生成的路由 ID。
	const requestOptions: SimpleStreamOptions = {
		...options,
		// 三项强制覆盖：不写缓存、保证有路由 ID、禁止调用工具
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
		toolChoice: "none",
	};
	const produce = async (): Promise<AssistantMessage> =>
		streamFn
			? (await streamFn(model, context, requestOptions)).result()
			: completeSimple(model, context, requestOptions);
	// retryAssistantCall 只重试瞬时错误；确定性失败与中止透传给调用方处理
	return retryAssistantCall(produce, retry, requestOptions.signal, callbacks);
}

/**
 * 用 LLM 生成对话摘要；传入 previousSummary 时改用增量更新提示词做合并。
 * 仅返回摘要文本的便捷封装（不带 usage）。
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<string> {
	// 薄封装：复用带 usage 的实现，只取文本，供不关心用量的调用方使用
	return (
		await generateSummaryWithUsage(
			currentMessages,
			model,
			reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		)
	).text;
}

/** 为独立的总结请求构造 provider Context（system prompt + 单条 user 消息）。 */
function buildSummarizationContext(promptText: string): Context {
	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: promptText }],
				timestamp: Date.now(),
			},
		],
	};
}

/** 生成或增量更新对话摘要，并返回 provider usage。 */
export async function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// 摘要输出上限：预留空间的 80%，且不超过模型自身的 maxTokens。
	// 0.8 的系数给「旧摘要+新对话」的输入部分留出 20% 余量
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// 有旧摘要用增量更新提示词，否则用首次总结提示词
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// 序列化为纯文本，避免模型把内容当成要继续的对话。
	// 先经 convertToLlm 处理自定义类型（bashExecution、custom 等）
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// 组装提示词：对话包在 <conversation> 标签里，
	// 旧摘要（若有）包在 <previous-summary> 标签里供增量更新参考
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	// 统一组装请求选项（鉴权、中止信号、推理预算、路由 sessionId）
	const completionOptions = createSummarizationOptions(
		model,
		maxTokens,
		apiKey,
		headers,
		env,
		signal,
		thinkingLevel,
		sessionId,
	);

	// 发起独立的总结请求（不影响主对话的缓存与路由）
	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		completionOptions,
		streamFn,
		retry,
		callbacks,
	);

	// 截断（length）的摘要不完整、不能作为检查点；模型试图调工具也视为失败
	const failure = getSummarizationFailure(response, "Summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Summarization attempted to call a tool");
	}

	const textContent = contentText(response.content);

	// usage 原样返回：多次压缩/分支摘要的用量由调用方按需合并（combineUsage）
	return { text: textContent, usage: response.usage };
}

// ============================================================================
// 压缩准备（供扩展使用）
// ============================================================================

/**
 * prepareCompaction 的产物：压缩所需的全部预计算数据。
 * 拆出这一步是为了让扩展（session_before_compact hook）能在真正调 LLM 前
 * 拿到并审视/修改这些数据。
 */
export interface CompactionPreparation {
	/** 保留尾部第一条 entry 的 UUID（压缩边界） */
	firstKeptEntryId: string;
	/** 将被总结并随后丢弃的消息 */
	messagesToSummarize: AgentMessage[];
	/** 若切在回合中间，将被总结为「回合前缀摘要」的消息 */
	turnPrefixMessages: AgentMessage[];
	/** 是否为 split turn（切点落在回合中间） */
	isSplitTurn: boolean;
	/** 压缩前的上下文 token 估算 */
	tokensBefore: number;
	/** 上一次压缩的摘要，用于增量更新 */
	previousSummary?: string;
	/** 从 messagesToSummarize 中提取的文件操作 */
	fileOps: FileOperations;
	/** 来自 settings.jsonl 的压缩配置	*/
	settings: CompactionSettings;
}

/**
 * 把当前路径（根→当前位置）的 entries 划分为「待总结历史 / 回合前缀 / 保留尾部」。
 * 无可压缩内容时返回 undefined；调用方据此跳过压缩。
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	// ===== 前置检查：无需压缩的情形直接返回 =====
	// 上一次压缩刚发生在最后一个 entry（尚未新增内容）：无需重复压缩
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	// ===== 定位上一次压缩边界，确定本次总结范围 =====
	// 找最近一次压缩 entry 的下标（不存在则 -1）
	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	// 有历史压缩：继承其摘要做增量更新；本次总结范围从其保留边界开始。
	// boundaryStart 保持在上一轮压缩的边界上，避免重复总结已折叠的历史
	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		// 找不到记录的边界 entry（旧版会话文件）时，退化为压缩 entry 的下一条
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	// 本次总结范围的终点：当前路径的最末端（不含）
	const boundaryEnd = pathEntries.length;

	// 压缩前规模：基于整条路径重建上下文后估算。
	// 注意这是「当前活跃路径」的规模，已被丢弃的其他分支不计入
	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	// 只在 [boundaryStart, boundaryEnd) 范围内找切点，避免重压已压缩过的历史
	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// ===== 计算切点并划分三个区段 =====
	// 取保留尾部第一条 entry 的 UUID 作为压缩边界
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // 旧会话 entry 无 UUID，需要先做迁移
	}
	const firstKeptEntryId = firstKeptEntry.id;

	// 历史区终点：split turn 时到回合起点为止（前缀单独总结），否则到切点。
	// 三段划分：[boundaryStart, historyEnd) 历史 / [turnStart, firstKept) 回合前缀 /
	// [firstKeptEntryIndex, boundaryEnd) 保留尾部
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// ===== 收集待总结消息 =====
	// 待总结的历史消息（生成摘要后即被折叠丢弃）
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// 回合前缀消息（仅 split turn 时存在：回合起点到切点之间的部分）
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// 两类消息都为空：没有可总结内容，放弃压缩
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	// ===== 提取文件操作（含上一次压缩的累计清单） =====
	// 从待总结消息 + 上一次压缩明细中提取文件操作
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// split turn 时回合前缀也会被折叠，其文件操作同样要并入清单
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	// settings 原样带回：compact 生成摘要时需要读 reserveTokens 等配置
	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// 主压缩函数
// ============================================================================

/** 回合前缀摘要的提示词：回合太大被切成两段时，总结前缀以衔接被保留的后缀。 */
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * 基于准备数据生成压缩摘要，返回 CompactionResult——SessionManager 落盘时
 * 会补上 uuid/parentUuid。
 *
 * split turn 时先总结历史（可与旧摘要增量合并），再单独总结被切开的回合前缀，
 * 两段摘要拼接为一条；否则只生成历史摘要。最终统一附上文件清单。
 *
 * @param preparation - prepareCompaction() 预计算好的准备数据
 * @param customInstructions - 可选的总结附加关注点
 * @param sessionId - 可选的路由 session ID（只用于路由，不启用 prompt 缓存）
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	env?: Record<string, string>,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<CompactionResult> {
	// 解构准备数据：切点相关的划分已在 prepareCompaction 完成，这里只负责生成
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	// ===== 生成摘要（可能两段）并合并为一条 =====
	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		// split turn：历史摘要 + 回合前缀摘要两段拼接
		let historyText = "No prior history.";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			// 先总结较早的历史（previousSummary 参与增量合并）。
			// historyText 的占位初值用于「只有回合前缀、无更早历史」的极端情形
			const historyResult = await generateSummaryWithUsage(
				messagesToSummarize,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				customInstructions,
				previousSummary,
				thinkingLevel,
				streamFn,
				env,
				retry,
				callbacks,
				sessionId,
			);
			historyText = historyResult.text;
			historyUsage = historyResult.usage;
		}
		// 再总结被切开的回合前缀（无法与旧摘要合并，用专用的前缀提示词）
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			env,
			signal,
			thinkingLevel,
			streamFn,
			retry,
			callbacks,
			sessionId,
		);
		// 两段摘要拼成一条，usage 逐项相加
		summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
		summaryUsage = historyUsage ? combineUsage(historyUsage, turnPrefixResult.usage) : turnPrefixResult.usage;
	} else {
		// 非 split turn：只需生成历史摘要
		const result = await generateSummaryWithUsage(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
			env,
			retry,
			callbacks,
			sessionId,
		);
		summary = result.text;
		summaryUsage = result.usage;
	}

	// ===== 追加文件清单并组装结果 =====
	// 计算文件清单并追加到摘要末尾
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	// prepareCompaction 已保证存在；此处兜底防御，避免落盘出无边界 entry
	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		usage: summaryUsage,
		// 文件清单同时写进 details：下次压缩据此滚动继承（见 extractFileOperations）
		details: { readFiles, modifiedFiles } as CompactionDetails,
	};
}

/**
 * 为被切开的回合前缀生成摘要（split turn 场景）。
 * 与整段历史摘要不同：只总结这个回合的前半部分，重点交代原始请求与
 * 早期进展，让被保留的后半段（近期工作）可以被读懂。
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	env?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
	retry?: RetryPolicy,
	callbacks?: RetryCallbacks,
	sessionId?: string,
): Promise<{ text: string; usage: Usage }> {
	// 前缀只是补充上下文，预算取半（reserveTokens 的 50%），给历史摘要留出空间
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // 回合前缀使用更小的预算
	// 与历史摘要相同的序列化与组包流程，只是换用前缀专用提示词
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const response = await completeSummarization(
		model,
		buildSummarizationContext(promptText),
		createSummarizationOptions(model, maxTokens, apiKey, headers, env, signal, thinkingLevel, sessionId),
		streamFn,
		retry,
		callbacks,
	);

	// 与历史摘要同样的失败判定：截断/调工具都不允许落盘
	const failure = getSummarizationFailure(response, "Turn prefix summarization");
	if (failure) {
		throw new Error(failure);
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		throw new Error("Turn prefix summarization attempted to call a tool");
	}

	return {
		// 文本与 usage 一并返回，供 compact 与历史摘要的 usage 合并
		text: contentText(response.content),
		usage: response.usage,
	};
}
