/**
 * @file harness 层的自定义 Agent 消息类型定义与 LLM 消息转换器。
 *
 * @description
 * 本文件是 TypeScript 声明合并 (declaration merging) 的实战范例：
 * 文件中间通过 `declare module "../types.ts"` 向 `CustomAgentMessages`
 * 空接口（定义于 src/types.ts）合并 4 个成员，一次性注册 4 种自定义
 * Agent 消息类型——`bashExecution`（bash 执行记录）、`custom`（应用自定义
 * 消息）、`branchSummary`（分支摘要）、`compactionSummary`（压缩摘要）。
 * 合并生效后，它们即成为 `AgentMessage` 联合类型的组成部分，
 * 可类型安全地混入会话转录，由整个框架统一调度。
 *
 * 本文件同时提供 harness 版 `convertToLlm`：在每次调用 LLM 前，把
 * AgentMessage[] 转换为标准 Message[]。它承担「过滤」职责——自定义消息
 * 被包装为 user 消息（摘要类附前后缀标记），标准消息原样透传，未知/
 * UI 专用消息被剔除，确保只有 LLM 能理解的内容进入请求上下文。
 */
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../types.ts";

/** 压缩摘要正文的前缀：声明其后的 <summary> 内容是此前历史被压缩后的摘要。 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

/** 压缩摘要正文的后缀：闭合 </summary> 标签。 */
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** 分支摘要正文的前缀：声明其后的 <summary> 内容是本会话刚返回的那条分支的摘要。 */
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

/** 分支摘要正文的后缀：闭合 </summary> 标签。 */
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * bash 执行记录消息：记录一条 bash 命令的执行过程与结果。
 * 转换为 LLM 消息时，由 `bashExecutionToText()` 渲染为纯文本。
 */
export interface BashExecutionMessage {
	/** 角色标识，固定为 "bashExecution"。 */
	role: "bashExecution";
	/** 被执行的命令行。 */
	command: string;
	/** 命令输出（可能已被截断）。 */
	output: string;
	/** 命令退出码；命令被取消时为 undefined。 */
	exitCode: number | undefined;
	/** 命令是否被取消。 */
	cancelled: boolean;
	/** 输出是否因超长被截断。 */
	truncated: boolean;
	/** 完整输出所在的文件路径（仅输出被截断时提供，供追溯原文）。 */
	fullOutputPath?: string;
	/** 消息产生时间戳（毫秒）。 */
	timestamp: number;
	/** 为 true 时该消息不进入 LLM 上下文，但仍保留在转录中供 UI 展示（如 `!!` 前缀命令）。 */
	excludeFromContext?: boolean;
}

/**
 * 应用自定义消息：带 `customType` 语义标签的通用消息容器，
 * 内容既可以是纯字符串，也可以是 text/image 内容块数组。
 */
export interface CustomMessage<T = unknown> {
	/** 角色标识，固定为 "custom"。 */
	role: "custom";
	/** 应用自定义的消息类型标签，用于区分不同种类的自定义消息。 */
	customType: string;
	/** 消息内容：纯字符串或 text/image 内容块数组。 */
	content: string | (TextContent | ImageContent)[];
	/** 是否在 UI 中展示（仅影响展示层，转换时内容始终发给 LLM）。 */
	display: boolean;
	/** 供 UI / 日志使用的任意结构化附加数据。 */
	details?: T;
	/** 消息产生时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * 分支摘要消息：会话从某条分支返回主线时，记录那条被放弃分支的摘要，
 * 让 LLM 无需完整分支转录也能了解分支中发生过什么。
 */
export interface BranchSummaryMessage {
	/** 角色标识，固定为 "branchSummary"。 */
	role: "branchSummary";
	/** 被放弃分支的摘要文本。 */
	summary: string;
	/** 被放弃分支的叶子 (leaf) 消息 id，标识该分支的结束位置。 */
	fromId: string;
	/** 消息产生时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * 压缩摘要消息：上下文压缩 (compaction) 发生时，把较早的历史记录压缩成
 * 一条摘要，在转录中替代被压缩掉的原始消息。
 */
export interface CompactionSummaryMessage {
	/** 角色标识，固定为 "compactionSummary"。 */
	role: "compactionSummary";
	/** 压缩后的历史摘要文本。 */
	summary: string;
	/** 压缩发生前的 token 数量（用于统计与 UI 展示）。 */
	tokensBefore: number;
	/** 消息产生时间戳（毫秒）。 */
	timestamp: number;
}

/**
 * 声明合并 (declaration merging) 注册点：向 src/types.ts 中的空接口
 * `CustomAgentMessages` 合入本文件的 4 种自定义消息类型。
 * 合并后它们成为 `AgentMessage` 联合类型的成员，框架即可类型安全地
 * 存储与分发这些消息。
 */
declare module "../types.ts" {
	interface CustomAgentMessages {
		/** bash 执行记录消息。 */
		bashExecution: BashExecutionMessage;
		/** 应用自定义消息。 */
		custom: CustomMessage;
		/** 分支摘要消息。 */
		branchSummary: BranchSummaryMessage;
		/** 压缩摘要消息。 */
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * 把 bash 执行记录渲染为发给 LLM 的纯文本。
 *
 * 渲染内容依次为：命令本身、命令输出（无输出时标记 "(no output)"）、
 * 取消提示或非零退出码提示、输出被截断时的完整输出路径说明。
 *
 * @param msg 要渲染的 bash 执行记录消息
 * @returns 可直接作为 user 消息文本内容的渲染结果
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

/**
 * 创建分支摘要消息的工厂函数。
 *
 * @param summary 被放弃分支的摘要文本
 * @param fromId 被放弃分支的叶子消息 id
 * @param timestamp 消息时间戳；传字符串时按 Date 可解析格式自动转为毫秒
 * @returns 新建的 {@link BranchSummaryMessage}
 */
export function createBranchSummaryMessage(
	summary: string,
	fromId: string,
	timestamp: string | number,
): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime(),
	};
}

/**
 * 创建压缩摘要消息的工厂函数。
 *
 * @param summary 压缩后的历史摘要文本
 * @param tokensBefore 压缩发生前的 token 数量
 * @param timestamp 消息时间戳；传字符串时按 Date 可解析格式自动转为毫秒
 * @returns 新建的 {@link CompactionSummaryMessage}
 */
export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string | number,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary,
		tokensBefore,
		timestamp: typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime(),
	};
}

/**
 * 创建应用自定义消息的工厂函数。
 *
 * @param customType 应用自定义的消息类型标签
 * @param content 消息内容（纯字符串或 text/image 内容块数组）
 * @param display 是否在 UI 中展示
 * @param details 供 UI / 日志使用的附加数据
 * @param timestamp 消息时间戳；传字符串时按 Date 可解析格式自动转为毫秒
 * @returns 新建的 {@link CustomMessage}
 */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string | number,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime(),
	};
}

/**
 * harness 版 `convertToLlm`：把 Agent 会话转录中的 AgentMessage[] 转换为
 * 可直接发给 LLM 的标准 Message[]。
 *
 * 转换规则：
 * - 4 种自定义消息分别包装为 user 消息（bash 记录渲染为纯文本，
 *   摘要类消息附加前后缀标记）；
 * - 标准 LLM 消息（user/assistant/toolResult）原样透传；
 * - 无法识别的消息类型被过滤丢弃，避免把宿主未知的 UI 专用内容发给 LLM。
 *
 * @param messages Agent 会话转录中的消息数组
 * @returns 只含 LLM 可理解内容的 Message 数组
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				// bash 执行记录：默认渲染为纯文本、包装为 user 消息发给 LLM
				case "bashExecution":
					// 被 excludeFromContext 标记的记录只供 UI 展示，过滤掉、不进入 LLM 上下文
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				// 应用自定义消息：内容始终保留，统一包装为 user 消息
				case "custom": {
					// 字符串内容包装为 text 内容块，内容块数组则原样使用
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				// 分支摘要：套上前缀/后缀标记后作为 user 消息注入，让 LLM 了解被放弃分支的经过
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				// 压缩摘要：套上前缀/后缀标记后作为 user 消息注入，替代被压缩掉的早期历史
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				// 标准 LLM 消息：本来就是发给 LLM 的格式，无需转换、原样透传
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				// 未识别的消息类型（如其他模块注册的 UI 专用消息）：过滤丢弃，不发给 LLM
				default:
					return undefined;
			}
		})
		// 剔除各过滤分支返回的 undefined
		.filter((m): m is Message => m !== undefined);
}
