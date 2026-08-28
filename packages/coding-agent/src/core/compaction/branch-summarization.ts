/**
 * @file 树导航场景下的分支摘要生成
 * @description 会话历史是树状结构。当用户从当前分支跳转到树上另一个位置时，
 * 被离开的那条分支不会出现在新位置的上下文里；本模块在跳转前为该分支生成
 * 结构化摘要（Goal/Progress/Next Steps 等），并以 branch_summary entry 落盘，
 * 使被放弃的探索成果（做过什么、改过哪些文件）不丢失。
 *
 * 主流程：collectEntriesForBranchSummary（找公共祖先并收集分支 entries）→
 * prepareBranchEntries（在 token 预算内从新到旧挑选消息，并累积文件操作）→
 * generateBranchSummary（调 LLM 生成摘要并附文件清单）。
 */

import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { RetryCallbacks, RetryPolicy } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import type { Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai/compat";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { completeSummarization, estimateTokens, getSummarizationFailure } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// 类型定义
// ============================================================================

/** generateBranchSummary 的结果：成功时带摘要与文件清单，失败/中止时带标记。 */
export interface BranchSummaryResult {
	/** 生成的摘要文本（含前导说明与文件清单），失败时缺省 */
	summary?: string;
	/** 本次总结 LLM 调用的用量 */
	usage?: Usage;
	/** 分支中只读过的文件 */
	readFiles?: string[];
	/** 分支中修改过的文件 */
	modifiedFiles?: string[];
	/** 用户主动中止时为 true */
	aborted?: boolean;
	/** 失败原因（LLM 报错、截断、试图调用工具等） */
	error?: string;
}

/**
 * 存储在 BranchSummaryEntry.details 中、用于跨摘要累积文件追踪的明细。
 * 下次生成嵌套分支摘要时，prepareBranchEntries 会读取它继续累加。
 */
export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils.ts";

/**
 * prepareBranchEntries 的结果：预算内的消息序列、累计的文件操作与总 token 估算。
 * messages 已按时间正序排好，可直接交给总结流程。
 */
export interface BranchPreparation {
	/** 提取出来待总结的消息，按时间正序排列 */
	messages: AgentMessage[];
	/** 从 tool call 中提取的文件操作 */
	fileOps: FileOperations;
	/** messages 的估算总 token 数 */
	totalTokens: number;
}

/** collectEntriesForBranchSummary 的结果：待总结 entries 与公共祖先。 */
export interface CollectEntriesResult {
	/** 待总结的 entries，按时间正序排列 */
	entries: SessionEntry[];
	/** 新旧两个位置在会话树上的公共祖先（不存在则为 null） */
	commonAncestorId: string | null;
}

/** generateBranchSummary 的全部可配置项（模型、鉴权、预算与请求通道）。 */
export interface GenerateBranchSummaryOptions {
	/** 用于总结的模型 */
	model: Model<any>;
	/** 模型的 API key */
	apiKey?: string;
	/** 模型请求的自定义 header */
	headers?: Record<string, string>;
	/** provider 作用域的环境变量 */
	env?: Record<string, string>;
	/** 取消信号 */
	signal: AbortSignal;
	/** 可选的总结附加关注点 */
	customInstructions?: string;
	/** 为 true 时 customInstructions 完全替换默认提示词，而非追加 */
	replaceInstructions?: boolean;
	/** 为 prompt + LLM 响应预留的 token 数（默认 16384） */
	reserveTokens?: number;
	/** 可选的会话流函数。用于保持 SDK 请求行为一致，而不改动 agent 状态。 */
	streamFn?: StreamFn;
	/** 瞬时错误的重试策略，复用 coding-agent 的 settings.retry。 */
	retry?: RetryPolicy;
	/** 可选的重试回调（如 TUI 的重试指示器）。 */
	callbacks?: RetryCallbacks;
}

// ============================================================================
// Entry 收集
// ============================================================================

/**
 * 收集从 oldLeafId 跳到 targetId 时需要总结的 entries。
 *
 * 做法：从 oldLeafId 沿 parentId 一路回溯到与 targetId 的公共祖先，途经的
 * entries 即「被离开的分支」。不在 compaction 边界处停下——压缩 entry 也被
 * 收进来，它携带的旧摘要会成为新摘要的上下文。
 *
 * @param session - 会话管理器（只读访问）
 * @param oldLeafId - 当前位置（跳转出发点）
 * @param targetId - 目标位置（跳转目的地）
 * @returns 待总结的 entries 与公共祖先
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// 没有旧位置（如刚创建的会话），没有可总结内容
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// 找公共祖先：同时位于新旧两条根→叶路径上的最深节点。
	// 旧路径放入 Set 以便 O(1) 查询
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath 是从根到叶的顺序，倒序遍历找到的第一个交点即最深的公共祖先
	// （最深的交点才能使被总结的分支范围最小、只含真正被离开的部分）
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// 从旧叶子沿 parentId 回溯收集 entries，直到公共祖先（不含）
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		// 找不到父 entry（数据异常）时提前终止，避免死循环
		if (!entry) break;
		entries.push(entry);
		// 沿父链上溯：走到公共祖先（不含）即覆盖整条被离开的分支
		current = entry.parentId;
	}

	// 收集顺序是新的在前，反转得到时间正序
	entries.reverse();

	// 公共祖先本身不进 entries——两个位置共享的路径不属于「被离开的分支」
	return { entries, commonAncestorId };
}

// ============================================================================
// Entry → Message 转换
// ============================================================================

/**
 * 把 session entry 还原为等价的 AgentMessage。
 * 与 compaction.ts 中的 getMessageFromEntry 类似，但额外处理 compaction entry——
 * 旧压缩摘要会被重建成消息参与本次总结，实现摘要的滚动合并。
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 跳过 tool result —— 其内容已由 assistant 的 tool call 体现
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "custom_message":
			// 自定义消息按原参数重建，保证摘要请求里的类型一致
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);

		case "branch_summary":
			// 旧的分支摘要重建为消息，使其内容可并入新摘要
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			// 旧的压缩摘要同样重建，实现摘要跨压缩滚动合并
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);

		// 以下类型不产生对话内容
		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "session_info":
			return undefined;
	}
}

/**
 * 在 token 预算内准备待总结的 entries。
 *
 * 从最新到最旧遍历，逐条累加直到触及预算——分支太长时优先保留最近的上下文。
 *
 * 同时从两处收集文件操作：
 * - assistant 消息中的 tool call
 * - 已有 branch_summary entry 的 details（保证嵌套分支摘要的文件清单可累积）
 *
 * @param entries - 按时间正序排列的 entries
 * @param tokenBudget - 可纳入的最大 token 数（0 = 不限制）
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// ===== 第一遍：全量收集文件操作 =====
	// 第一遍：从全部 entries 收集文件操作（即使某些 entry 已超出 token 预算）。
	// Why：文件清单不能因为预算截断而丢——嵌套分支摘要里累计的文件记录必须完整继承。
	// 只从 pi 自生成的摘要（fromHook !== true）提取，扩展生成的摘要不含标准 details 结构
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			// 防御式校验数组结构，旧版会话文件可能缺字段
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				// 修改过的文件归入 edited 集合，computeFileLists 据此正确去重
				// （read 集合中的同名文件会被归入 modified 而非 readOnly）
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// ===== 第二遍：从新到旧按预算收集消息 =====
	// 第二遍：从新到旧累加消息，直到 token 预算用尽
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		// 从 assistant 消息（tool call）提取文件操作
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);

		// 加入前先检查预算
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 摘要类 entry（compaction / branch_summary）是重要上下文：
			// 只要已用量还低于预算的 90%，就尝试破例塞入
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				// 0.9 的余量防止摘要本身占据几乎全部预算、挤出真正的近期消息
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 预算已到，停止继续向更旧的方向收集
			break;
		}

		// unshift 保持收集结果仍是时间正序
		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// 摘要生成
// ============================================================================

// 以下两个常量共同决定分支摘要的「长相」：PREAMBLE 拼在正文前说明来源，
// PROMPT 约束模型输出的结构。两者拼装发生在 generateBranchSummary 内。

/** 拼在摘要正文前的一小段说明，交代「这是用户之前探索过的另一条分支」。 */
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

/**
 * 分支摘要的默认提示词：要求按 Goal / Constraints / Progress / Key Decisions /
 * Next Steps 的固定格式输出，并强调保留精确的文件路径、函数名与报错信息
 * （这些是日后回到该分支续接工作时最容易被摘要丢掉的硬信息）。
 */
const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * 为被放弃的分支 entries 生成摘要。
 *
 * @param entries - 待总结的 session entries（时间正序）
 * @param options - 生成选项（模型、鉴权、中止信号、自定义指令等）
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	// 解构默认值：reserveTokens 缺省 16384，与压缩侧的默认预留一致
	const {
		model,
		apiKey,
		headers,
		env,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		streamFn,
		retry,
		callbacks,
	} = options;

	// token 预算 = 上下文窗口 - 为 prompt 和响应预留的空间
	// 模型未声明窗口时兜底 128000，避免预算计算出现负数或 Infinity
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	// 预算内挑选消息 + 全量收集文件操作，一次完成
	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	// 分支里没有任何可总结内容：返回占位摘要而非报错，
	// 让调用方仍能落盘一个 branch_summary entry 保持结构一致
	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// 先转成 LLM 兼容消息再序列化为纯文本。
	// Why 序列化：让模型把内容当「阅读材料」而非要续写的对话；
	// 分支里可能混有 toolResult、自定义消息等类型，convertToLlm 负责先归一化
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// 组装提示词：默认格式模板，customInstructions 可追加或整体替换
	// 三种组合：替换模式用自定义指令；否则自定义指令作为额外关注点拼在默认模板后；
	// 都没有则只用默认模板
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	// 总结请求是单条 user 消息：整个分支对话只作为文本载荷出现
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// 调 LLM 生成摘要。优先使用会话级 streamFn，使 SDK 的请求行为
	//（超时、重试、归因 header）保持一致，又不必经过 agent 状态/事件。
	// 经 completeSummarization 重试，瞬时断流可按配置的重试策略恢复。
	// maxTokens 2048：结构化摘要模板的合理上限，防止个别超长输出
	const context = { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages };
	const requestOptions: SimpleStreamOptions = { apiKey, headers, env, signal, maxTokens: 2048 };
	const response = await completeSummarization(model, context, requestOptions, streamFn, retry, callbacks);

	// 处理中止与失败：截断（length）的摘要不完整，不能作为会话检查点
	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	const failure = getSummarizationFailure(response, "Branch summarization");
	if (failure) {
		return { error: failure };
	}
	// 总结请求本不该带工具，模型却发起调用说明输出被污染，拒绝落盘
	if (response.content.some((block) => block.type === "toolCall")) {
		return { error: "Branch summarization attempted to call a tool" };
	}

	let summary = contentText(response.content);

	// 前置一段说明文字，交代该摘要的来源（用户探索过的分支）。
	// Why：这条摘要会以普通上下文消息的形式出现在新位置，没有说明会被当成当前任务的一部分
	summary = BRANCH_SUMMARY_PREAMBLE + summary;

	// 计算文件清单并追加到摘要末尾：readFiles / modifiedFiles 同时作为
	// 结果字段返回，供调用方存入 entry.details 供后续摘要滚动继承
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return {
		// 空摘要兜底为占位文案，避免落盘空字符串
		summary: summary || "No summary generated",
		usage: response.usage,
		readFiles,
		modifiedFiles,
	};
}
