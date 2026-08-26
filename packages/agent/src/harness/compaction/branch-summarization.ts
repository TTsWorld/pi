/**
 * @file branch-summarization.ts
 * @description 分支摘要（branch summary）生成模块。
 *
 * 当用户通过 navigateTree 在会话树（session tree）中从当前叶子节点跳到其他节点时，
 * 即将被离开的分支会失去"活跃"状态。本模块负责把这段被放弃的分支历史压缩成一条
 * 结构化摘要，持久化为 branch_summary entry，使日后切回该分支时上下文仍然可用。
 *
 * 主要流程：
 * 1. collectEntriesForBranchSummary：找到旧分支与目标路径的最近公共祖先，
 *    收集公共祖先之后（旧分支独有）的 entry；
 * 2. prepareBranchEntries：把 entry 转为消息，继承历史摘要中的文件操作，
 *    并在 token 预算内从新到旧挑选消息；
 * 3. generateBranchSummary：拼装提示词调用 LLM 生成结构化摘要，
 *    并附带文件操作元数据。
 *
 * 与 compaction.ts（上下文压缩）共享摘要基础设施（completeSimpleWithRetries、
 * SUMMARIZATION_SYSTEM_PROMPT）以及同目录 utils.ts 中的工具函数。
 */
import {
	type Api,
	contentText,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	type Usage,
} from "@earendil-works/pi-ai";

import type { AgentMessage } from "../../types.ts";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import { type Entry, type Session, SessionError } from "../session/index.ts";
import { BranchSummaryError, err, ok, type Result } from "../types.ts";
import { completeSimpleWithRetries, estimateTokens, SUMMARIZATION_SYSTEM_PROMPT } from "./compaction.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** 已生成的分支摘要数据，可直接持久化为一条 branch_summary entry。 */
export interface BranchSummaryResult {
	/** 摘要正文（含前导说明与文件操作元数据）。 */
	summary: string;
	/** 生成该摘要的 LLM 调用产生的用量信息（如可用）。 */
	usage?: Usage;
	/** 分支中被读取过的文件列表（已排序）。 */
	readFiles: string[];
	/** 分支中被修改过的文件列表（已排序）。 */
	modifiedFiles: string[];
}

/** 存储在 branch_summary entry 上的文件操作详情（供后续摘要继承累积）。 */
export interface BranchSummaryDetails {
	/** 探索该分支期间读取过的文件。 */
	readFiles: string[];
	/** 探索该分支期间修改过的文件。 */
	modifiedFiles: string[];
}

// 透传 utils.ts 中的 FileOperations 类型，方便外部直接从本模块导入。
export type { FileOperations } from "./utils.ts";

/** 完成预处理、待送入摘要生成的分支内容。 */
export interface BranchPreparation {
	/** 按 token 预算挑选出、将参与摘要的消息（时间正序）。 */
	messages: AgentMessage[];
	/** 从分支中提取（并跨历史摘要累积）的文件操作。 */
	fileOps: FileOperations;
	/** 选中消息的估算 token 总数。 */
	totalTokens: number;
}

/** collectEntriesForBranchSummary 的结果：待摘要的 entry 集合。 */
export interface CollectEntriesResult {
	/** 待摘要的 entry，按时间正序排列。 */
	entries: Entry[];
	/** 旧叶子节点与目标节点之间最深（最近）的公共祖先 entry id；无旧叶子时为 null。 */
	commonAncestorId: string | null;
}

/** 生成分支摘要的配置项。 */
export interface GenerateBranchSummaryOptions {
	/** 摘要请求所经由的 provider 集合，负责鉴权解析。 */
	models: Models;
	/** 用于生成摘要的模型。 */
	model: Model<Api>;
	/** 摘要请求的中止信号。 */
	signal: AbortSignal;
	/** 可选的自定义指令，默认追加在内置提示词之后。 */
	customInstructions?: string;
	/** 为 true 时用 customInstructions 完全替换默认提示词，而非追加。 */
	replaceInstructions?: boolean;
	/** 为提示词与模型输出预留的 token 数，默认 16384。 */
	reserveTokens?: number;
	/** 可选的重试策略，用于瞬时摘要错误。 */
	retry?: RetryPolicy;
	/** 可选的重试回调，用于重试过程上报。 */
	callbacks?: RetryCallbacks;
}

/**
 * 在导航到会话树的其他 entry 之前，收集需要生成分支摘要的 entry。
 *
 * 只收集「旧分支独有」的部分：从旧叶子节点沿 parentId 向根回溯，直到与目标路径的
 * 最近公共祖先为止；公共祖先之前的共享历史两个分支都会保留，无需重复摘要。
 *
 * @param session 当前会话（用于查询分支路径与 entry）
 * @param oldLeafId 导航前所在的叶子节点 id；为 null 表示没有旧分支可摘要
 * @param targetId 即将导航到的目标节点 id
 * @returns 待摘要 entry（时间正序）与最近公共祖先 id
 * @throws SessionError 回溯路径上存在缺失的 entry 时抛出
 */
export async function collectEntriesForBranchSummary(
	session: Session,
	oldLeafId: string | null,
	targetId: string,
): Promise<CollectEntriesResult> {
	// ========== 早退：没有旧叶子节点 ==========
	// 会话尚无历史（或导航前不在任何分支上）时无内容可摘要，直接返回空结果。
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// ========== 定位最近公共祖先 ==========
	// findEntriesOnBranch 默认从 start 向根遍历（新→旧）。先取旧叶子到根的路径 id 集合，
	// 再遍历目标路径（由近及远），第一个同时落在旧路径上的 entry 即为最近公共祖先。
	const oldPath = new Set((await session.findEntriesOnBranch({ start: oldLeafId })).map((entry) => entry.id));
	const targetPath = await session.findEntriesOnBranch({ start: targetId });
	let commonAncestorId: string | null = null;
	for (const entry of targetPath) {
		if (oldPath.has(entry.id)) {
			commonAncestorId = entry.id;
			break;
		}
	}

	// ========== 回溯收集旧分支独有的 entry ==========
	// 从旧叶子沿 parentId 逐级向上，直到公共祖先为止；收集顺序为新→旧。
	const entries: Entry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = await session.getEntry(current);
		if (!entry) throw new SessionError("invalid_entry", `Entry ${current} not found`);
		entries.push(entry);
		current = entry.parentId;
	}
	entries.reverse(); // 反转为时间正序，方便后续按对话顺序挑选与摘要

	return { entries, commonAncestorId };
}
/**
 * 把单个 session entry 转换为可参与摘要的 AgentMessage。
 *
 * @param entry 待转换的 entry
 * @returns 可用于摘要的消息；对摘要无意义的 entry 返回 undefined：
 *   - toolResult：内容依附于对应的工具调用，脱离上下文无法理解；
 *   - thinking_level_change / model_change / active_tools_change / custom：
 *     纯设置或自定义记录，不承载对话内容。
 */
function getMessageFromEntry(entry: Entry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			// 工具结果单独出现没有意义，跳过；其余消息直接透传。
			if (entry.message.role === "toolResult") return undefined;
			return entry.message;

		case "branch_summary":
			// 历史分支摘要还原为一条可读消息，保证嵌套摘要时信息不丢失。
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			// 历史压缩摘要同样还原为一条消息参与本次摘要（摘要的摘要，逐级浓缩）。
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		case "thinking_level_change":
		case "model_change":
		case "active_tools_change":
		case "custom":
			return undefined;
	}
}

/**
 * 在可选的 token 预算内，把分支 entry 预处理为待摘要的消息集合。
 *
 * @param entries 时间正序排列的分支 entry
 * @param tokenBudget 选中消息的 token 上限；0 或负数表示不限制
 * @returns 选中的消息（时间正序）、累积的文件操作与实际 token 总数
 */
export function prepareBranchEntries(entries: Entry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// ========== 第一步：继承历史分支摘要中的文件操作 ==========
	// 旧的 branch_summary entry 只保留摘要文本，其原始工具调用已被丢弃；
	// 文件清单只能从 entry.details 恢复并逐条并入，保证跨多次摘要持续累积。
	for (const entry of entries) {
		if (entry.type === "branch_summary" && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}

	// ========== 第二步：从新到旧挑选消息（受 token 预算约束） ==========
	// 从最新 entry 向最旧遍历，用 unshift 维持时间正序；预算耗尽时优先保住最新内容。
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;
		// 注意：文件操作的提取不受预算限制——即使消息最终被丢弃，其文件信息也已记录。
		extractFileOpsFromMessage(message, fileOps);

		const tokens = estimateTokens(message);
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// 超预算的例外：若该 entry 本身是 compaction/branch_summary（一段高密度的
			// 历史浓缩），且当前用量尚未超过预算的 90%，仍破例收入——
			// 允许约 10% 的超支换取大量更早历史的上下文。
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			// 无论是否破例收入，预算已尽，停止继续向更旧的 entry 遍历。
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

// 摘要正文的前导说明：告诉后续读者（LLM）这段内容来自用户曾探索过的另一个分支。
const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

// 分支摘要的结构化提示词：要求 LLM 按 Goal / Constraints & Preferences / Progress /
// Key Decisions / Next Steps 的固定格式输出，并保留精确的文件路径、函数名与错误信息。
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
 * 为被放弃（离开）的分支 entry 生成结构化摘要。
 *
 * 流程：按 token 预算挑选分支消息 → 序列化为纯文本 → 拼装提示词（可追加/替换
 * 自定义指令）→ 调用 LLM（带重试）→ 前置前导说明、追加文件操作元数据。
 *
 * @param entries 待摘要的分支 entry（时间正序）
 * @param options 摘要配置（模型、中止信号、自定义指令、重试等）
 * @returns 成功时返回摘要文本、用量与文件清单；被中止或生成失败时返回对应错误
 */
export async function generateBranchSummary(
	entries: Entry[],
	options: GenerateBranchSummaryOptions,
): Promise<Result<BranchSummaryResult, BranchSummaryError>> {
	const {
		models,
		model,
		signal,
		customInstructions,
		replaceInstructions,
		reserveTokens = 16384,
		retry,
		callbacks,
	} = options;

	// ========== 计算 token 预算 ==========
	// 预算 = 上下文窗口 - 预留（提示词 + 模型输出）；模型未上报窗口大小时按 128k 兜底。
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	// ========== 空内容短路 ==========
	// 分支没有可摘要的消息时不发起 LLM 调用，直接返回占位摘要。
	if (messages.length === 0) {
		return ok({ summary: "No content to summarize", readFiles: [], modifiedFiles: [] });
	}

	// ========== 拼装提示词 ==========
	// 指令有三种形态：完全替换默认提示词 / 默认提示词后追加自定义聚焦点 / 仅默认提示词。
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	// 对话文本包在 <conversation> 标签中，与指令明确分隔。
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	// 摘要请求是独立的一次性调用：整个转录作为单条 user 消息发送，不进入主对话流。
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	// ========== 调用 LLM（带重试） ==========
	const response = await completeSimpleWithRetries(
		models,
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		{ signal, maxTokens: 2048 },
		retry,
		callbacks,
	);
	if (response.stopReason === "aborted") {
		return err(new BranchSummaryError("aborted", response.errorMessage || "Branch summary aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new BranchSummaryError(
				"summarization_failed",
				`Branch summary failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	// ========== 后处理：前导说明 + 文件操作元数据 ==========
	let summary = contentText(response.content);
	summary = BRANCH_SUMMARY_PREAMBLE + summary;
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);

	return ok({
		summary: summary || "No summary generated", // LLM 返回空内容时兜底
		usage: response.usage,
		readFiles,
		modifiedFiles,
	});
}
