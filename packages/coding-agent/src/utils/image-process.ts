/**
 * @file image-process.ts —— 发送给模型的内联图片预处理流水线
 *
 * @description
 * 负责「归一化格式 → 可选自动缩放 → 生成 base64 数据与提示文本」：
 * 不支持的图片格式先转换为 PNG，再按供应商限制缩放，
 * 并附带格式转换 / 尺寸映射提示（hints），帮助模型正确理解图片。
 */

import { convertImageBytesToPng } from "./image-convert.ts";
import { formatDimensionNote, type ImageResizeOptions, resizeImage } from "./image-resize.ts";

/** 图片处理选项。 */
export interface ProcessImageOptions {
	/** 是否按内联（inline）图片的供应商限制自动缩放图片。默认：true */
	autoResizeImages?: boolean;
	/** 可选的缩放参数覆盖。省略时使用 resizeImage 的默认值。 */
	resizeOptions?: ImageResizeOptions;
}

/** 图片处理结果：成功时携带 base64 数据、MIME 与提示列表；失败时仅携带给模型看的说明文本。 */
export type ProcessImageResult =
	| {
			ok: true;
			data: string;
			mimeType: string;
			hints: string[];
	  }
	| {
			ok: false;
			message: string;
	  };

/** 归一化后的图片：字节 + 规范化 MIME，以及被转换前的原始 MIME（如有）。 */
interface NormalizedImage {
	bytes: Uint8Array;
	mimeType: string;
	convertedFrom?: string;
}

/** 去掉 MIME 中的参数部分（如 `image/png; charset=...`），返回小写的主类型。 */
function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/**
 * 判断 MIME 是否属于内联图片支持的类型（png / jpeg / gif / webp）。
 * 是则返回规范化后的 MIME，否则返回 null（表示需要转码）。
 */
function normalizeSupportedImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "image/png";
		case "image/jpeg":
		case "image/jpg":
			return "image/jpeg";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		default:
			return null;
	}
}

/**
 * 将图片归一化为受支持的格式：原生支持则直接使用原字节，
 * 否则尝试转换为 PNG；转换失败返回 null。
 */
async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<NormalizedImage | null> {
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	if (normalizedMimeType) {
		return { bytes, mimeType: normalizedMimeType };
	}

	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		bytes: pngBytes,
		mimeType: "image/png",
		convertedFrom: baseMimeType(mimeType),
	};
}

/** 生成「格式从 from 转换为 to」的提示文本；未发生转换时返回 undefined。 */
function conversionHint(from: string | undefined, to: string): string | undefined {
	if (!from || from === to) return undefined;
	return `[Image converted from ${from} to ${to}.]`;
}

/**
 * 处理一张待内联发送给模型的图片。
 * 流程：归一化格式（必要时转 PNG）→ 按需缩放到供应商限制内 →
 * base64 编码，并附带格式转换 / 尺寸映射提示。
 *
 * @param bytes - 原始图片字节
 * @param mimeType - 图片 MIME 类型
 * @param options - 处理选项（是否自动缩放、缩放参数覆盖）
 * @returns 成功时含 base64 数据与提示；无法转换或缩放失败时返回给模型的占位说明
 */
export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized = await normalizeImage(bytes, mimeType);
	if (!normalized) {
		return {
			ok: false,
			message: "[Image omitted: could not be converted to a supported inline image format.]",
		};
	}

	if (autoResizeImages) {
		const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		if (!resized) {
			return {
				ok: false,
				message: "[Image omitted: could not be resized below the inline image size limit.]",
			};
		}

		const hints: string[] = [];
		const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
		if (convertedHint) hints.push(convertedHint);
		const dimensionNote = formatDimensionNote(resized);
		if (dimensionNote) hints.push(dimensionNote);

		return {
			ok: true,
			data: resized.data,
			mimeType: resized.mimeType,
			hints,
		};
	}

	const hints: string[] = [];
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);

	return {
		ok: true,
		data: Buffer.from(normalized.bytes).toString("base64"),
		mimeType: normalized.mimeType,
		hints,
	};
}
