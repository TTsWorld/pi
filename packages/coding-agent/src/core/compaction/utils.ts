/**
 * @file 压缩与分支摘要共享的工具函数
 * @description 提供三类能力：文件操作追踪（从 tool call 中提取读/写/编辑过的文件，
 * 供摘要附上文件清单）、消息序列化（把对话压平为纯文本供总结 LLM 阅读，避免其
 * 把对话当成要继续的上下文）、以及总结用的 system prompt 常量。
 * 被 compaction.ts 与 branch-summarization.ts 两个流程共同复用。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, type Message } from "@earendil-works/pi-ai";

// ============================================================================
// 文件操作追踪
// ============================================================================

/** 按「读 / 写 / 编辑」三类累计的文件路径集合（Set 自动去重）。 */
export interface FileOperations {
	/** 通过 read 工具读取过的文件 */
	read: Set<string>;
	/** 通过 write 工具整文件写入过的文件 */
	written: Set<string>;
	/** 通过 edit 工具编辑过的文件 */
	edited: Set<string>;
}

/** 创建一个空的文件操作集合（三个 Set 均为空）。 */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * 从 assistant 消息的 tool call 中提取文件操作，累积进 fileOps。
 *
 * 只识别约定好的三种工具名：read / write / edit，且要求参数里有字符串型 path；
 * 其他工具或缺失 path 的调用一律跳过（防御式检查，避免异常消息结构导致崩溃）。
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	// 文件操作只可能出现在 assistant 消息的 toolCall 块中
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		// 逐层校验块结构，只处理 toolCall 且带 name/arguments 的块
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * 由累积的文件操作计算最终清单：
 * modifiedFiles = 被编辑或写入过的文件；readFiles = 只读过、从未修改过的文件
 * （同一文件既读过又改过则归入 modified，避免重复出现）。两个列表均排序保证稳定输出。
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// edited 与 written 合并视为「修改过」
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	// 只读清单要剔除后来又修改过的文件，避免同一文件出现在两个清单里
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * 把文件清单格式化为 XML 标签块（如 <read-files>...</read-files>），
 * 追加到摘要文本末尾；两个清单都为空时返回空串（摘要保持原样）。
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	// 只输出非空清单；两个清单之间用空行分隔
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	// 无任何文件操作时返回空串，摘要正文保持原样
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// 消息序列化
// ============================================================================

/** 序列化进摘要时单条 tool result 允许的最大字符数；超出部分截断（全文对总结无必要）。 */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * 把文本截断到 maxChars：保留开头，末尾附「还截掉了多少字符」的标记。
 * 只保留开头是因为工具输出的关键信息（报错、结论）通常在前面。
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * 把 LLM 消息序列化为纯文本，供总结请求使用。
 * Why 序列化成「[User]: ...」这类带角色前缀的记录体：让模型明确处于「阅读材料」
 * 而非「对话现场」，避免它把内容当成要继续的对话来回复。
 * 调用前需先经 convertToLlm() 处理自定义消息类型（bashExecution、custom 等）。
 *
 * tool result 会被截断，以控制总结请求的 token 规模——总结只需要结果要点，不需要全文。
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		// user：提取纯文本（无文本内容的消息直接跳过）
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			// assistant 消息可能同时含 thinking / text / toolCall，分别归类输出
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					// 工具调用压缩成 name(k=v, ...) 的单行签名，只保留调用意图不保留结果
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			// 工具结果超长时截断，防止一次巨大的输出撑爆总结请求
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return parts.join("\n\n");
}

// ============================================================================
// 总结用 System Prompt
// ============================================================================

/**
 * 所有总结请求（compaction / 分支摘要 / 回合前缀摘要）共用的 system prompt：
 * 约束模型只做「读对话 → 按指定格式产出结构化总结」，禁止续写对话或回答对话里的问题。
 */
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
