/**
 * @file 图片工具：基于魔数（magic bytes）的 MIME 类型检测与手写 base64 编码。
 *
 * @description 为 read 等工具提供零第三方依赖的纯 JS 图片识别与编码能力：
 * - detectSupportedImageMimeType 依据文件头部字节特征识别 LLM 供应商普遍支持的
 *   jpeg/png/gif/webp/bmp（扩展名不可信，必须看内容）；
 * - encodeBase64 不依赖 Buffer/btoa，浏览器与 Node 环境行为一致。
 * 识别不通过（含动画 PNG、JPEG-LS 变体、结构异常的 BMP）一律返回 undefined，
 * 由调用方按普通文本处理。
 */

/** PNG 文件签名（8 字节魔数）：固定为 0x89 "P" "N" "G" \r \n 0x1a \n */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 通过文件头魔数检测图片 MIME 类型。
 *
 * 以下情况返回 undefined（视为非图片，交由调用方按文本处理）：
 * - JPEG 第 4 字节为 0xF7（JPEG-LS 变体，供应商普遍不支持）；
 * - PNG 为动画 PNG（APNG，含 acTL chunk）或首 chunk 不是 IHDR；
 * - BMP 结构校验不通过（见 {@link isBmp}）。
 *
 * @param buffer 文件原始字节
 * @returns 命中时返回 MIME 类型（如 "image/png"），识别失败返回 undefined
 */
export function detectSupportedImageMimeType(buffer: Uint8Array): string | undefined {
	if (startsWith(buffer, [0xff, 0xd8, 0xff])) return buffer[3] === 0xf7 ? undefined : "image/jpeg";
	if (startsWith(buffer, PNG_SIGNATURE)) return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : undefined;
	if (startsWithAscii(buffer, 0, "GIF")) return "image/gif";
	if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) return "image/webp";
	if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) return "image/bmp";
	return undefined;
}

/**
 * 将字节序列编码为标准 base64 字符串（含 "=" 填充）。
 *
 * Why：不使用 Buffer / btoa 等环境 API，保证在 Node 与浏览器等环境行为一致。
 * 按 3 字节为一组处理；不足 3 字节的组按 0 参与位运算，缺位用 "=" 补齐。
 *
 * @param bytes 待编码的字节序列
 * @returns base64 编码字符串
 */
export function encodeBase64(bytes: Uint8Array): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let output = "";
	// 每 3 字节（24 bit）一组，拆成 4 个 6 bit 下标查表得到 4 个 base64 字符
	for (let index = 0; index < bytes.length; index += 3) {
		const first = bytes[index] ?? 0;
		const second = bytes[index + 1];
		const third = bytes[index + 2];
		output += alphabet[first >> 2];
		output += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
		output += second === undefined ? "=" : alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
		output += third === undefined ? "=" : alphabet[third & 0x3f];
	}
	return output;
}

/**
 * 校验 PNG 结构是否规范：PNG 规范要求首个 chunk 为 IHDR 且数据长度为 13 字节。
 * 仅凭签名匹配可能是恰好以相同字节开头的其他数据，故需此二次校验。
 */
function isPng(buffer: Uint8Array): boolean {
	return (
		buffer.length >= 16 && readUint32BE(buffer, PNG_SIGNATURE.length) === 13 && startsWithAscii(buffer, 12, "IHDR")
	);
}

/**
 * 判断 PNG 是否为动画 PNG（APNG）：沿 chunk 链扫描，出现 acTL（动画控制）chunk 即为动画。
 * 先遇到 IDAT chunk 仍未见 acTL 则为静态 PNG；chunk 长度异常或缓冲区被截断时按非动画处理。
 */
function isAnimatedPng(buffer: Uint8Array): boolean {
	// 从紧跟 PNG 签名之后的第一个 chunk 开始（chunk 布局：4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC）
	let offset = PNG_SIGNATURE.length;
	while (offset + 8 <= buffer.length) {
		const chunkLength = readUint32BE(buffer, offset);
		const chunkTypeOffset = offset + 4;
		if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) return true;
		if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) return false;
		// 跳过当前 chunk：长度 + 类型 + 数据 + CRC
		const nextOffset = offset + 8 + chunkLength + 4;
		// 防御性检查：长度字段异常导致 offset 回退或越过缓冲区末尾，按非动画处理
		if (nextOffset <= offset || nextOffset > buffer.length) return false;
		offset = nextOffset;
	}
	return false;
}

/**
 * 对 "BM" 开头的数据做 BMP 结构校验，降低误判率。
 *
 * 依次校验文件头各字段的相互关系：声明文件大小（offset 2，0 表示未知）、
 * 像素数据偏移（offset 10，不得小于文件头 14 字节 + DIB 头）、DIB 头大小（offset 14）；
 * 再按 DIB 头版本读取色彩平面数（合法 BMP 必须为 1）与每像素位数
 * （必须属于 {1, 4, 8, 16, 24, 32}）。
 * 12 字节对应旧版 BITMAPCOREHEADER（两字段位于 22/24），
 * 40~124 字节对应 BITMAPINFOHEADER 及其扩展版本（字段位于 26/28）。
 */
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
	if (dibHeaderSize === 12) {
		// BITMAPCOREHEADER：字段紧跟在 10 字节核心头之后
		colorPlanes = readUint16LE(buffer, 22);
		bitsPerPixel = readUint16LE(buffer, 24);
	} else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
		// BITMAPINFOHEADER 及其扩展版本：需先确认缓冲区覆盖到字段位置
		if (buffer.length < 30) return false;
		colorPlanes = readUint16LE(buffer, 26);
		bitsPerPixel = readUint16LE(buffer, 28);
	} else {
		// 未知/不支持的 DIB 头版本
		return false;
	}
	return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

/** 读取 offset 处的 16 位无符号小端（little-endian）整数；越界字节按 0 处理 */
function readUint16LE(buffer: Uint8Array, offset: number): number {
	return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

/** 读取 offset 处的 32 位无符号大端（big-endian）整数；越界字节按 0 处理 */
function readUint32BE(buffer: Uint8Array, offset: number): number {
	// 最高位字节用乘 0x1000000 而非左移 24 位，避免进入符号位被当作负数
	return (
		(buffer[offset] ?? 0) * 0x1000000 +
		((buffer[offset + 1] ?? 0) << 16) +
		((buffer[offset + 2] ?? 0) << 8) +
		(buffer[offset + 3] ?? 0)
	);
}

/** 读取 offset 处的 32 位无符号小端（little-endian）整数；越界字节按 0 处理 */
function readUint32LE(buffer: Uint8Array, offset: number): number {
	// 最低位字节在前的镜像布局，最高位字节同样用乘法避免符号位问题
	return (
		(buffer[offset] ?? 0) +
		((buffer[offset + 1] ?? 0) << 8) +
		((buffer[offset + 2] ?? 0) << 16) +
		(buffer[offset + 3] ?? 0) * 0x1000000
	);
}

/** 判断 buffer 是否以给定字节序列开头 */
function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
	if (buffer.length < bytes.length) return false;
	return bytes.every((byte, index) => buffer[index] === byte);
}

/** 判断 buffer 自 offset 起的连续字节是否等于指定 ASCII 字符串（逐字符比较 charCode） */
function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
	if (buffer.length < offset + text.length) return false;
	for (let index = 0; index < text.length; index++) {
		if (buffer[offset + index] !== text.charCodeAt(index)) return false;
	}
	return true;
}
