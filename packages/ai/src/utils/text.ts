/**
 * @file 消息内容文本提取工具。
 * 从消息 content（字符串或内容块数组）中抽取文本块并拼接，供日志、展示等场景获取纯文本。
 */
import type { ImageContent, TextContent, ThinkingContent, ToolCall } from "../types.ts";

type Content = TextContent | ImageContent | ThinkingContent | ToolCall;

/**
 * 提取并拼接消息内容中的文本。
 * content 为字符串时原样返回；为数组时只取 type 为 "text" 的块并按分隔符拼接（图片、思考、工具调用块被忽略）。
 * @param content 消息内容：字符串或内容块数组
 * @param separator 拼接多个文本块时的分隔符，默认换行符
 * @returns 提取拼接后的文本
 */
export function contentText(content: string | readonly Content[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}
