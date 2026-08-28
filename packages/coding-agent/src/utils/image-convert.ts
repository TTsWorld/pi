/**
 * @file image-convert.ts —— 图片转 PNG（基于 Photon WASM）
 *
 * @description
 * 通过 Photon 将任意受支持的图片字节解码并重新编码为 PNG，
 * 解码时会先按 EXIF 方向信息旋转摆正；供终端显示（Kitty 图形协议要求 PNG）
 * 与不支持的格式归一化使用。
 */

import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

/**
 * 把任意图片字节转换为 PNG 字节。
 * 解码后先应用 EXIF 方向再编码；手动释放 WASM 侧的图像对象避免内存泄漏。
 *
 * @param bytes - 原始图片字节
 * @returns PNG 字节；Photon 不可用或转换失败时返回 null
 */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		// Photon 不可用，无法转换
		return null;
	}

	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		// 转换失败
		return null;
	}
}

/**
 * 把图片转换为 PNG 格式以便在终端显示。
 * Kitty 图形协议要求 PNG 格式（f=100）。
 *
 * @param base64Data - base64 编码的图片数据
 * @param mimeType - 图片 MIME 类型
 * @returns PNG 的 base64 数据与 MIME；已是 PNG 则原样返回，转换失败返回 null
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// 已经是 PNG，无需转换
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}
