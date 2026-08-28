/**
 * @file messages.ts —— coding-agent 的自定义消息类型与转换器
 *
 * @description
 * 在基础 AgentMessage 之上扩展 coding-agent 专有的消息类型：
 * bash 执行记录（! 命令）、扩展注入的自定义消息、分支摘要与压缩摘要，
 * 并提供把这些消息统一转换为 LLM 可识别消息（{@link convertToLlm}）的转换器。
 *
 * 通过 declaration merging 把自定义角色（bashExecution/custom/branchSummary/
 * compactionSummary）合并进 pi-agent-core 的 CustomAgentMessages 接口，
 * 使 AgentContext 可以类型安全地持有这些消息。
 *
 * 依赖关系：
 * - `@earendil-works/pi-agent-core`：AgentMessage 基础类型与扩展点；
 * - `@earendil-works/pi-ai`：LLM 侧的 Message / TextContent / ImageContent 类型。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

/** 压缩摘要注入 LLM 上下文时的前缀（英文文案会原样进入提示词，勿翻译其值）。 */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

/** 压缩摘要的闭合标签后缀。 */
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** 分支摘要注入 LLM 上下文时的前缀（从某分支回退后对其内容的摘要说明）。 */
export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

/** 分支摘要的闭合标签后缀。 */
export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * 通过 `!` 命令执行的 bash 会话消息类型。
 * 记录用户直接执行（非 LLM 工具调用）的命令及其输出。
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	/** 执行的命令行内容。 */
	command: string;
	/** 合并后的输出（已净化、可能被截断）。 */
	output: string;
	/** 进程退出码；被杀死/取消时为 undefined。 */
	exitCode: number | undefined;
	/** 是否被用户通过信号取消。 */
	cancelled: boolean;
	/** 输出是否被截断。 */
	truncated: boolean;
	/** 输出超长时保存完整输出的临时文件路径。 */
	fullOutputPath?: string;
	timestamp: number;
	/** 为 true 时该消息不进入 LLM 上下文（`!!` 前缀触发） */
	excludeFromContext?: boolean;
}

/**
 * 扩展通过 sendMessage() 注入的自定义消息类型。
 * 这是扩展向会话注入内容的通用载体（customType 区分具体种类）。
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	/** 自定义消息的种类标识，由扩展自行定义。 */
	customType: string;
	/** 文本或图文混合内容。 */
	content: string | (TextContent | ImageContent)[];
	/** 是否在 UI 中展示（false 时仅供 LLM 上下文使用）。 */
	display: boolean;
	/** 附加的结构化载荷，类型由扩展约定。 */
	details?: T;
	timestamp: number;
}

/** 会话从某分支回退时生成的分支摘要消息（摘要该分支上发生过的内容）。 */
export interface BranchSummaryMessage {
	role: "branchSummary";
	/** 分支内容的文字摘要。 */
	summary: string;
	/** 回退出发点（分支起点）的标识。 */
	fromId: string;
	timestamp: number;
}

/** 上下文压缩（compaction）时生成的历史摘要消息。 */
export interface CompactionSummaryMessage {
	role: "compactionSummary";
	/** 被压缩掉的历史对话的文字摘要。 */
	summary: string;
	/** 压缩前的 token 数，用于统计展示。 */
	tokensBefore: number;
	timestamp: number;
}

// 通过 declaration merging 扩展 CustomAgentMessages（为上述角色注册类型）
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}

/**
 * 把 BashExecutionMessage 转换为供 LLM 上下文使用的 user 消息文本。
 * 依次拼装：命令 → 输出（代码块包裹）→ 取消/非零退出码标注 → 截断提示。
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		// 无输出也要显式说明，避免模型误以为输出丢失
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		// 只有非零退出码才值得标注；退出码 0 是常态
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

/** 由分支摘要字段构造 BranchSummaryMessage；timestamp 为 ISO 字符串，转为毫秒时间戳。 */
export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** 由压缩摘要字段构造 CompactionSummaryMessage；tokensBefore 记录压缩前的 token 数。 */
export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** 把 CustomMessageEntry 的各字段组装为 CustomMessage 消息对象 */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * 把 AgentMessage（含自定义类型）转换为 LLM 可识别的 Message 列表。
 *
 * 自定义角色统一降级为 user 消息：bash 执行转为文本、分支/压缩摘要用
 * 前后缀包裹成 <summary> 结构；user/assistant/toolResult 原样透传。
 *
 * 使用方：
 * - Agent 的 transormToLlm 选项（prompt 调用与排队消息）；
 * - 压缩（Compaction）的 generateSummary（用于生成摘要）；
 * - 自定义扩展与工具。
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// 跳过被排除出上下文的消息（!! 前缀）
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// 穷尽性检查：未来新增角色若未处理，这里会在编译期报错
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		// 丢弃被排除（undefined）的消息后压平为最终列表
		.filter((m) => m !== undefined);
}
