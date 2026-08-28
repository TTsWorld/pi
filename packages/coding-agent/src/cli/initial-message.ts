/**
 * @file initial-message.ts —— 非交互模式初始 prompt 的组装
 *
 * @description
 * 把 stdin 管道内容、@file 展开得到的文本，以及 CLI 位置参数中的第一条消息，
 * 按固定顺序拼接为单条初始消息，供非交互（-p/--print）模式作为会话的
 * 第一条用户消息直接发送给模型。
 */
import type { ImageContent } from "@earendil-works/pi-ai";
import type { Args } from "./args.ts";

/** buildInitialMessage 的输入：已解析的 CLI 参数与各来源的可选内容。 */
export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

/** buildInitialMessage 的输出：组装完成的初始消息与随附图片（无内容时为 undefined）。 */
export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * 把 stdin 内容、@file 文本与第一条 CLI 消息合并为单条初始 prompt（非交互模式用）。
 *
 * 拼接顺序固定为 stdin → @file 文本 → 第一条命令行消息，各部分均可省略，
 * 直接首尾相接（join("")）不加任何分隔符；同时会把已消费的第一条消息从
 * parsed.messages 中移除，避免它在后续流程中被重复注入。
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	// 按固定顺序收集各来源文本：stdin → @file 文本 → 命令行消息
	const parts: string[] = [];
	if (stdinContent !== undefined) {
		parts.push(stdinContent);
	}
	if (fileText) {
		parts.push(fileText);
	}

	// 只取第一条位置参数消息并入 prompt，并把它从消息列表中移除，
	// 避免后续流程中同一条消息被再次发送
	if (parsed.messages.length > 0) {
		parts.push(parsed.messages[0]);
		parsed.messages.shift();
	}

	// 三个来源都为空时返回 undefined，调用方据此判断无需发送初始消息
	return {
		initialMessage: parts.length > 0 ? parts.join("") : undefined,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
