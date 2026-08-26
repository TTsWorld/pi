/**
 * @file utils.ts
 * @description compaction 模块的共享工具函数。
 *
 * 提供三类能力，被 compaction.ts（上下文压缩）与 branch-summarization.ts（分支摘要）
 * 共同使用：
 * - 文件操作提取：从助手消息的工具调用中识别 read/write/edit，累积文件清单；
 * - 文件清单计算与格式化：输出 <read-files> / <modified-files> 元数据标签；
 * - 对话序列化：把 LLM 消息转为纯文本转录，作为摘要提示词的输入。
 */
import { contentText, type Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";

/** 会话分支或压缩区间内被触碰过的文件路径集合（累积器）。 */
export interface FileOperations {
	/** 被读取过的文件（不一定被修改）。 */
	read: Set<string>;
	/** 通过整文件写入（write）操作写过的文件。 */
	written: Set<string>;
	/** 通过局部编辑（edit）操作修改过的文件。 */
	edited: Set<string>;
}

/** 创建一个空的文件操作累积器。 */
export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * 从助手消息的工具调用中提取文件操作，并入累积器。
 *
 * @param message 待扫描的消息（仅 assistant 消息可能包含工具调用）
 * @param fileOps 文件操作累积器，识别结果就地写入
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	// 防御式早退：非 assistant 消息不可能携带工具调用。
	if (message.role !== "assistant") return;
	// content 可能缺失或不是块数组（如被中断的消息），直接跳过。
	if (!("content" in message) || !Array.isArray(message.content)) return;

	// ========== 逐块扫描，识别文件类工具调用 ==========
	for (const block of message.content) {
		// 结构防御：只处理带 name/arguments 且类型为 toolCall 的块。
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		// 只认参数名为 path 的调用；其他参数形状无法确定目标文件。
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		// 按工具名归入对应集合：read → read，write → written，edit → edited。
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

/** 由累积的文件操作计算排序后的只读/已修改文件清单。 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// modified = 编辑 ∪ 整文件写入：两种方式都算「修改过」。
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	// 只读清单需排除后来又被修改过的文件，避免同一路径同时出现在两个清单里。
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort(); // 排序保证输出稳定可复现
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * 把文件清单格式化为附在摘要末尾的元数据标签。
 *
 * @param readFiles 只读文件清单
 * @param modifiedFiles 已修改文件清单
 * @returns `<read-files>` / `<modified-files>` 标签文本（前置空行与摘要正文分隔）；
 *   两个清单都为空时返回空字符串
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	// 各清单仅在非空时输出对应标签，避免产生空的占位标签。
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	// 前置两个换行，把元数据与摘要正文明确分隔开。
	return `\n\n${sections.join("\n\n")}`;
}

// 工具结果写入摘要转录时的最大字符数：工具输出往往极长，全量保留会挤占摘要的 token 预算。
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * 安全的 JSON 序列化：供摘要转录使用，绝不能因序列化失败打断整个摘要流程。
 *
 * @param value 待序列化的任意值
 * @returns JSON 字符串；JSON.stringify 返回 undefined 时兜底为 "undefined"，
 *   遇到循环引用等无法序列化的情况返回占位符 "[unserializable]"
 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		// 循环引用等异常场景：返回占位符而不是抛错。
		return "[unserializable]";
	}
}

/**
 * 把超长文本截断到 maxChars，并在末尾标注被截掉的字符数。
 *
 * @param text 原始文本
 * @param maxChars 保留的最大字符数
 * @returns 截断后的文本；未超长时原样返回
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	// 截断后追加省略标记，让摘要 LLM 知道内容不完整。
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}

/**
 * 把 LLM 消息序列化为纯文本对话转录，作为摘要提示词的输入。
 *
 * 输出按消息顺序排列、段与段以空行分隔，每段带角色前缀：
 * [User] / [Assistant thinking] / [Assistant] / [Assistant tool calls] / [Tool result]。
 * 工具调用渲染为 `name(k=v, ...)` 形式，工具结果截断到上限长度。
 *
 * @param messages 已转换为 LLM 格式的消息列表
 * @returns 可直接嵌入提示词的纯文本；无文本内容的消息会被跳过
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];

	for (const msg of messages) {
		// 用户消息：直接取文本内容（无文本时回退为空串，跳过该段）。
		if (msg.role === "user") {
			const content = contentText(msg.content, "");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			// 助手消息：thinking / 工具调用 / 正文文本分开收集，再各自成段。
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "thinking") {
					// 思考内容单独成段，为摘要保留推理线索。
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					// 工具调用渲染为 name(k=v, ...)，参数逐个 JSON 序列化。
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			// 只有确实存在文本块时才输出 [Assistant] 段，避免制造空段。
			if (msg.content.some((block) => block.type === "text")) {
				parts.push(`[Assistant]: ${contentText(msg.content)}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			// 工具结果：截断到上限长度后输出，防止超长输出撑爆摘要预算。
			const content = contentText(msg.content, "");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	// 段与段之间用空行分隔，提升摘要 LLM 的可读性。
	return parts.join("\n\n");
}
