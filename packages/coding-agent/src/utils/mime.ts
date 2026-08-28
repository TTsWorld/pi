/**
 * @file mime.ts —— 基于文件头（magic bytes）的图片 MIME 类型嗅探
 *
 * @description
 * 不信任扩展名，而是直接读取字节判断图片真实格式（JPEG / PNG / GIF / WebP / BMP），
 * 同时排除 APNG（动图）与 JPEG 中的非 JPEG 变体等内联场景不支持的类型。
 */

import { open } from "node:fs/promises";

/** 识别图片类型所需的最大探测字节数。 */
const IMAGE_TYPE_SNIFF_BYTES = 4100;
/** PNG 文件头 8 字节签名。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 从字节内容探测受支持的图片 MIME 类型。
 * 依据各类格式的文件头签名判断；动图或不支持的变体返回 null。
 *
 * @param buffer - 图片字节（至少包含文件头若干字节）
 * @returns 支持的 MIME 类型；无法识别或不支持时返回 null
 */
export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
		// 第四字节 0xf7 表示 JPEG-LS / JPEG 2000 等变体，内联场景不支持
		return buffer[3] === 0xf7 ? null : "image/jpeg";
	}
	if (startsWith(buffer, PNG_SIGNATURE)) {
		// APNG（动图）不支持：需同时校验 PNG 结构合法且不含 acTL 动画块
		return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
	}
	if (startsWithAscii(buffer, 0, "GIF")) {
		return "image/gif";
	}
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
		return "image/webp";
	}
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
		return "image/bmp";
	}
	return null;
}

/**
 * 从磁盘文件探测受支持的图片 MIME 类型：只读取文件头部固定字节数后嗅探。
 *
 * @param filePath - 图片文件路径
 * @returns 支持的 MIME 类型；无法识别或不支持时返回 null
 */
export async function detectSupportedImageMimeTypeFromFile(filePath: string): Promise<string | null> {
	const fileHandle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(IMAGE_TYPE_SNIFF_BYTES);
		const { bytesRead } = await fileHandle.read(buffer, 0, IMAGE_TYPE_SNIFF_BYTES, 0);
		return detectSupportedImageMimeType(buffer.subarray(0, bytesRead));
	} finally {
		await fileHandle.close();
	}
}

/** 校验 PNG 结构合法性：首块必须长度为 13 的 IHDR 块。 */
function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

/** 遍历 PNG 块，判断是否为含 acTL 动画块的 APNG。 */
function isAnimatedPng(buffer: Uint8Array): boolean {
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		// acTL 是 APNG 的动画控制块；遇到 IDAT 还没出现 acTL 则为静态 PNG
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;

		// 跳过「长度 4 字节 + 类型 4 字节 + 数据 + CRC 4 字节」
		const nextOffset = offset + 8 + chunkLength + 4;
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

/** 校验 BMP 结构合法性：文件头 / DIB 头字段与位深组合需自洽。 */
function isBmp(buffer: Uint8Array): boolean {
	if (buffer.length < 26) return false;

	const declaredFileSize = readUint32LE(buffer, 2);
	const pixelDataOffset = readUint32LE(buffer, 10);
	const dibHeaderSize = readUint32LE(buffer, 14);
	if (declaredFileSize !== 0 && declaredFileSize < 26) return false;
	if (pixelDataOffset < 14 + dibHeaderSize) return false;
	if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) return false;

	let colorPlanes: number;
	let bitsPerPixel: number;
	// BITMAPCOREHEADER（12 字节）与 BITMAPINFOHEADER 及后续版本的字段偏移不同
	if (dibHeaderSize === 12) {
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		return false;
	}

	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

/** 从 buffer 指定偏移读取小端 uint16，越界按 0 处理。 */
function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

/** 从 buffer 指定偏移读取大端 uint32，越界按 0 处理。 */
function readUint32BE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

/** 从 buffer 指定偏移读取小端 uint32，越界按 0 处理。 */
function readUint32LE(buffer: Uint8Array, offset: number): number {
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

/** 判断 buffer 是否以指定的字节序列开头。 */
function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

/** 判断 buffer 从 offset 起是否以指定 ASCII 文本开头（逐字符比较码点）。 */
function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
