/**
 * @file exif-orientation.ts —— 图片 EXIF 方向（Orientation）标签的读取与应用
 *
 * @description
 * 相机拍摄的照片常把「应旋转 90° 显示」这类信息记录在 EXIF Orientation 标签里，
 * 而像素数据本身仍是未旋转的；若解码链不自动纠正，图片就会显示为倒置或侧向。
 * 本文件做两件事：
 * 1. 从原始 JPEG / WebP 字节流中定位 TIFF 头并读出 Orientation 值（1-8），
 *    只做最小限度的解析，不引入完整 EXIF 库；
 * 2. `applyExifOrientation` 按标签值用 Photon 对解码后的图像做翻转/旋转，
 *    把像素真正转正后返回。
 *
 * 依赖关系：
 * - `./photon.ts`：Photon（Rust/WASM）模块类型与图像类型 `PhotonImageType`。
 */
import type { PhotonImageType } from "./photon.ts";

/** photon-node 模块的类型别名（避免在本文件顶层静态引入实际模块） */
type Photon = typeof import("@silvia-odwyer/photon-node");

/**
 * 从 TIFF 头开始解析 IFD0，读取 Orientation（tag 0x0112）的值。
 * 任何越界或格式异常一律返回 1（默认方向，即无需旋转），不抛错。
 */
function readOrientationFromTiff(bytes: Uint8Array, tiffStart: number): number {
	// TIFF 头固定 8 字节（2 字节序标记 + 2 版本 + 4 字节 IFD 偏移）
	if (tiffStart + 8 > bytes.length) return 1;

	const byteOrder = (bytes[tiffStart] << 8) | bytes[tiffStart + 1];
	// 0x4949 = "II"（小端）；其余（"MM"）按大端读取
	const le = byteOrder === 0x4949;

	// 按文件声明的字节序读取 16/32 位无符号整数
	const read16 = (pos: number): number => {
		if (le) return bytes[pos] | (bytes[pos + 1] << 8);
		return (bytes[pos] << 8) | bytes[pos + 1];
	};

	const read32 = (pos: number): number => {
		if (le) return bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 24);
		return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
	};

	// TIFF 头第 4-7 字节是 IFD0（第一张图像文件目录）相对 TIFF 头的偏移
	const ifdOffset = read32(tiffStart + 4);
	const ifdStart = tiffStart + ifdOffset;
	if (ifdStart + 2 > bytes.length) return 1;

	// IFD 起始两字节是目录项数量；每个目录项固定 12 字节
	const entryCount = read16(ifdStart);
	for (let i = 0; i < entryCount; i++) {
		const entryPos = ifdStart + 2 + i * 12;
		if (entryPos + 12 > bytes.length) return 1;

		// 0x0112 = Orientation 标签；SHORT 类型（2 字节）的值内联在项内偏移 8 处
		if (read16(entryPos) === 0x0112) {
			const value = read16(entryPos + 8);
			// 只接受合法范围 1-8，越界值按「未旋转」处理
			return value >= 1 && value <= 8 ? value : 1;
		}
	}

	return 1;
}

/**
 * 在 JPEG 的标记段序列中定位 APP1（0xE1，EXIF 段）内的 TIFF 头偏移。
 * 从偏移 2 起跳过 SOI（FF D8）逐段扫描；找不到返回 -1。
 */
function findJpegTiffOffset(bytes: Uint8Array): number {
	let offset = 2;
	while (offset < bytes.length - 1) {
		// 标记必须以 FF 开头，否则字节流已损坏
		if (bytes[offset] !== 0xff) return -1;
		const marker = bytes[offset + 1];
		// 连续 FF 是填充字节，前进一字节继续找真正的 marker
		if (marker === 0xff) {
			offset++;
			continue;
		}

		// 0xE1 = APP1，EXIF 数据所在的段
		if (marker === 0xe1) {
			if (offset + 4 >= bytes.length) return -1;
			// 段结构：FF E1 + 2 字节段长 + "Exif\0\0"（6 字节）+ TIFF 头
			const segmentStart = offset + 4;
			if (segmentStart + 6 > bytes.length) return -1;
			if (!hasExifHeader(bytes, segmentStart)) return -1;
			return segmentStart + 6;
		}

		// 其他段：读取 2 字节段长（含长度字段自身），整段跳过
		if (offset + 4 > bytes.length) return -1;
		const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
		offset += 2 + length;
	}

	return -1;
}

/**
 * 在 WebP 的 RIFF chunk 流中定位 EXIF chunk 里的 TIFF 头偏移。
 * 跳过 12 字节文件头（"RIFF" + 4 字节长度 + "WEBP"）后逐 chunk 扫描；找不到返回 -1。
 */
function findWebpTiffOffset(bytes: Uint8Array): number {
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		// chunk 头：4 字节 FourCC + 4 字节小端长度
		const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
		const chunkSize =
			bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24);
		const dataStart = offset + 8;

		if (chunkId === "EXIF") {
			if (dataStart + chunkSize > bytes.length) return -1;
			// 部分文件的 TIFF 头前带有 "Exif\0\0" 前缀，存在时一并跳过
			const tiffStart = chunkSize >= 6 && hasExifHeader(bytes, dataStart) ? dataStart + 6 : dataStart;
			return tiffStart;
		}

		// RIFF chunk 会填充到偶数字节长，奇数尺寸需多跳 1 字节
		offset = dataStart + chunkSize + (chunkSize % 2);
	}

	return -1;
}

/** 检查 offset 处是否为 "Exif\0\0" 六字节签名（0x45 0x78 0x69 0x66 0x00 0x00） */
function hasExifHeader(bytes: Uint8Array, offset: number): boolean {
	return (
		bytes[offset] === 0x45 &&
		bytes[offset + 1] === 0x78 &&
		bytes[offset + 2] === 0x69 &&
		bytes[offset + 3] === 0x66 &&
		bytes[offset + 4] === 0x00 &&
		bytes[offset + 5] === 0x00
	);
}

/**
 * 从图片原始字节中读取 EXIF Orientation 值（1-8）。
 * 按魔数区分 JPEG / WebP 后定位 TIFF 头；其余格式或定位失败一律返回 1（无需旋转）。
 */
function getExifOrientation(bytes: Uint8Array): number {
	let tiffOffset = -1;

	// JPEG：以 FF D8 开头
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		tiffOffset = findJpegTiffOffset(bytes);
	}
	// WebP：以 "RIFF" + 4 字节长度 + "WEBP" 开头
	else if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		tiffOffset = findWebpTiffOffset(bytes);
	}

	if (tiffOffset === -1) return 1;
	return readOrientationFromTiff(bytes, tiffOffset);
}

/** 目标像素下标映射：给定源图坐标 (x, y) 与源图尺寸 (w, h)，返回旋转后图中的像素下标（按像素计） */
type DstIndexFn = (x: number, y: number, w: number, h: number) => number;

/**
 * 通用 90° 旋转：逐像素（RGBA 四通道）从源图搬运到目标图，
 * 坐标映射由 dstIndex 决定（顺时针或逆时针）。Photon 未提供旋转 API，
 * 故在 JS 侧自行实现。
 */
function rotate90(photon: Photon, image: PhotonImageType, dstIndex: DstIndexFn): PhotonImageType {
	const w = image.get_width();
	const h = image.get_height();
	const src = image.get_raw_pixels();
	const dst = new Uint8Array(src.length);

	// 遍历源图每个像素，按映射写入目标位置；每像素占 4 字节（RGBA）
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const srcIdx = (y * w + x) * 4;
			const dstIdx = dstIndex(x, y, w, h) * 4;
			dst[dstIdx] = src[srcIdx];
			dst[dstIdx + 1] = src[srcIdx + 1];
			dst[dstIdx + 2] = src[srcIdx + 2];
			dst[dstIdx + 3] = src[srcIdx + 3];
		}
	}

	// 旋转后宽高互换：新图宽为 h、高为 w
	return new photon.PhotonImage(dst, h, w);
}

/**
 * 按 EXIF Orientation 标签纠正图像方向。
 * 翻转类操作（2/3/4）在原图上原地修改并返回同一对象；
 * 旋转类（5/6/7/8）返回新图像——返回值与入参不同时，调用方有责任释放旧对象。
 *
 * @param photon - photon-node 模块（提供 fliph/flipv 等原地操作）
 * @param image - 已解码的 Photon 图像
 * @param originalBytes - 图片原始字节（仅用于读取 EXIF 标签）
 * @returns 方向已转正的图像；orientation 为 1（默认方向）时原样返回
 */
export function applyExifOrientation(
	photon: Photon,
	image: PhotonImageType,
	originalBytes: Uint8Array,
): PhotonImageType {
	const orientation = getExifOrientation(originalBytes);
	// 1 = 无需旋转，直接返回原图
	if (orientation === 1) return image;

	switch (orientation) {
		// 2：水平镜像
		case 2:
			photon.fliph(image);
			return image;
		// 3：旋转 180°（水平 + 垂直两次翻转等价实现）
		case 3:
			photon.fliph(image);
			photon.flipv(image);
			return image;
		// 4：垂直镜像
		case 4:
			photon.flipv(image);
			return image;
		// 5：转置（顺时针 90° 旋转 + 水平镜像）
		case 5: {
			const rotated = rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
			photon.fliph(rotated);
			return rotated;
		}
		// 6：顺时针旋转 90°（相机竖拍的常见方向）
		case 6:
			return rotate90(photon, image, (x, y, _w, h) => x * h + (h - 1 - y));
		// 7：反转置（逆时针 90° 旋转 + 水平镜像）
		case 7: {
			const rotated = rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
			photon.fliph(rotated);
			return rotated;
		}
		// 8：逆时针旋转 90°
		case 8:
			return rotate90(photon, image, (x, y, w, h) => (w - 1 - x) * h + y);
		default:
			return image;
	}
}
