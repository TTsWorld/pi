/**
 * @file tool-result-images.ts —— 工具返回图片的入历史前归一化
 *
 * @description
 * 对工具结果中的 image 块统一跑一遍 `processImage`（格式归一 + 超限缩放），
 * 防止扩展 / MCP / 截图等工具直接产出的超大 base64 图片进入会话历史后
 * 被供应商拒绝整段对话。
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { processImage } from "./image-process.ts";

/** 工具结果内容块：文本或图片。 */
export type ToolResultContent = TextContent | ImageContent;

/** 归一化选项。 */
export interface NormalizeToolResultImagesOptions {
	/** 是否把超限图片缩放到内联（inline）图片的供应商限制以内。默认：true */
	autoResizeImages?: boolean;
}

/**
 * 归一化工具结果中的 image 块。
 *
 * `read` 工具与 `@file` 附件的图片已经过 `processImage` 处理，但自行产出图片的工具
 * （扩展、MCP 桥接、截图工具）会返回任意的 base64 数据，直接进入会话历史以及
 * 之后的每一次供应商请求。超大图片会导致供应商拒绝整个对话而不只是出问题的那一轮，
 * 因此在图片进入历史时统一归一化一次。
 *
 * 没有任何变化时返回原数组，调用方可以跳过对结果的改写。
 *
 * @param content - 工具结果内容块数组
 * @param options - 归一化选项
 * @returns 归一化后的内容块数组；无变化时原样返回
 */
export async function normalizeToolResultImages(
	content: ToolResultContent[],
	options?: NormalizeToolResultImagesOptions,
): Promise<ToolResultContent[]> {
	if (!content.some((block) => block.type === "image")) {
		return content;
	}

	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized: ToolResultContent[] = [];
	let changed = false;

	for (const block of content) {
		if (block.type !== "image") {
			normalized.push(block);
			continue;
		}

		const processed = await processImage(Buffer.from(block.data, "base64"), block.mimeType, { autoResizeImages });
		if (!processed.ok) {
			// 与 `read` 不同，这里保留原始块：图片是工具已经产出的内容，失败可能只是
			// 图片后端不可用，原样透传可维持工具现有的行为，而不是悄悄丢弃其输出。
			normalized.push(block);
			continue;
		}

		if (processed.data === block.data && processed.mimeType === block.mimeType && processed.hints.length === 0) {
			normalized.push(block);
			continue;
		}

		normalized.push({ type: "image", data: processed.data, mimeType: processed.mimeType });
		if (processed.hints.length > 0) {
			normalized.push({ type: "text", text: processed.hints.join("\n") });
		}
		changed = true;
	}

	return changed ? normalized : content;
}
