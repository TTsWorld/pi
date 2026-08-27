/**
 * @file token 数估算
 * @description 在拿不到真实 tokenizer 时按「4 字符 ≈ 1 token」的启发式估算上下文 token 用量。
 *              核心优化：若消息序列中存在「可信赖的助手 usage 块」（provider 真实上报），
 *              以它为基线、只估算其后的消息（trailing），避免逐条累计的误差放大。
 *
 * 主要功能：
 * - estimateContextTokens：整个 Context（systemPrompt + 消息 + 工具）的用量估算
 * - estimateMessageTokens / estimateTextTokens：单消息 / 单文本的粗估
 *
 * 依赖关系：
 * - ../types.ts 的消息 / 工具 / Usage 类型
 */

import type { AssistantMessage, Context, ImageContent, Message, TextContent, Tool, Usage } from "../types.ts";

/** 上下文用量估算结果：总量 + 真实 usage 基线 + 基线之后的估算增量 */
export interface ContextUsageEstimate {
	/** 估算的上下文总 token 数。 */
	tokens: number;
	/** 最近一个可用助手 usage 块上报的 token 数。 */
	usageTokens: number;
	/** 该 usage 块之后的消息的估算 token 数。 */
	trailingTokens: number;
	/** 提供 usage 的消息下标；不存在时为 null。 */
	lastUsageIndex: number | null;
}

// 启发式常数：文本按 4 字符 1 token；图片固定按 4800 字符（≈1200 token）计
const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

/** 汇总 usage 的上下文 token 数：优先 totalTokens，缺失时按四项之和兜底 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/** 安全序列化：循环引用等异常值降级为占位字符串，保证估算永不抛错 */
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** 统计用户侧内容的字符数：纯字符串直接量长度；图片块按固定常数计 */
function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

/** 纯文本 token 粗估（4 字符 1 token，向上取整） */
export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 用户侧内容（文本+图片）token 粗估 */
export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

/**
 * 单条消息 token 粗估。用户/工具结果消息走内容块估算；
 * 助手消息逐块累加：text/thinking 按长度、工具调用按「名称 + JSON 参数」。
 */
export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);

	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * 找出「最能代表当前前缀」的助手 usage 块：必须是最新前缀时间戳之后产生的、
 * 非 aborted/error 终态、且 token 数大于 0 的助手消息。
 * 之后若插入了更新的消息（如压缩摘要），旧 usage 不再描述当前前缀，应跳过。
 */
function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// 若该响应之后插入了更新的前缀消息（例如压缩摘要），
			// 其 usage 无法描述当前前缀
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

/** 消息序列估算：有可信 usage 基线则「基线 + 后续估算」，否则全量估算 */
function estimateMessages(messages: readonly Message[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/** 工具定义的 token 估算：整体 JSON 序列化后按文本估算 */
function estimateToolsTokens(tools: readonly Tool[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}

/** 类型守卫：区分裸消息数组与完整 Context */
function isMessageArray(value: Context | readonly Message[]): value is readonly Message[] {
	return Array.isArray(value);
}

/**
 * 估算整个上下文的 token 用量（接受完整 Context 或裸消息数组）。
 *
 * 有 usage 基线时：基线已涵盖其前的一切（含当时的工具定义），只需额外补上
 * 「基线之后新增的工具」（由工具结果消息的 addedToolNames 标记）。
 * 无基线时：全量估算消息 + systemPrompt + 全部工具定义。
 */
export function estimateContextTokens(context: Context | readonly Message[]): ContextUsageEstimate {
	if (isMessageArray(context)) return estimateMessages(context);

	const estimate = estimateMessages(context.messages);
	if (estimate.lastUsageIndex !== null) {
		// 收集基线之后新增的工具名（工具结果消息携带 addedToolNames 标记），
		// 只把这些新工具的定义计入增量——基线 usage 已包含当时的工具
		const addedNames = new Set(
			context.messages
				.slice(estimate.lastUsageIndex + 1)
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		);
		const addedToolTokens = estimateToolsTokens(context.tools?.filter((tool) => addedNames.has(tool.name)));
		return {
			tokens: estimate.tokens + addedToolTokens,
			usageTokens: estimate.usageTokens,
			trailingTokens: estimate.trailingTokens + addedToolTokens,
			lastUsageIndex: estimate.lastUsageIndex,
		};
	}

	// 无基线：systemPrompt 与全部工具定义都计入前缀
	const prefixTokens =
		(context.systemPrompt ? estimateTextTokens(context.systemPrompt) : 0) + estimateToolsTokens(context.tools);

	return {
		tokens: estimate.tokens + prefixTokens,
		usageTokens: estimate.usageTokens,
		trailingTokens: estimate.trailingTokens + prefixTokens,
		lastUsageIndex: estimate.lastUsageIndex,
	};
}
