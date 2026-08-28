/**
 * @file markdown-transform.ts —— Markdown 转换器的组合与适配工具
 *
 * @description
 * 把扩展注册的一组 MarkdownTransformer 组合成一条转换流水线：
 * 依次套用每个转换器，单个转换器抛错或返回非字符串时跳过并继续，
 * 保证渲染不会被某个扩展拖垮。
 */
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../core/extensions/types.ts";

/**
 * 创建一个符合 pi-tui Markdown 组件 transform 签名的适配函数，
 * 内部把固定的 messageType / isStreaming 与运行时的 availableWidth
 * 合成上下文后交给扩展转换器流水线处理。
 */
export function createMarkdownTransform(
	messageType: MarkdownTransformContext["messageType"],
	isStreaming: boolean,
	transformers: readonly MarkdownTransformer[],
): (markdown: string, availableWidth: number) => string {
	return (markdown, availableWidth) =>
		applyMarkdownTransformers(markdown, { messageType, isStreaming, availableWidth }, transformers);
}

/** 依次套用所有转换器；任一环节失败都不中断整条流水线 */
function applyMarkdownTransformers(
	markdown: string,
	context: MarkdownTransformContext,
	transformers: readonly MarkdownTransformer[],
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers) {
		try {
			const transformed = transformer(transformedMarkdown, context);
			// 仅接受字符串返回值：其他返回值（如 undefined）表示「不修改」
			if (typeof transformed === "string") {
				transformedMarkdown = transformed;
			}
		} catch {
			// 保留当前 Markdown，继续执行下一个转换器。
		}
	}
	return transformedMarkdown;
}
