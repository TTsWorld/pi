/**
 * @file image-resize-core.ts —— 进程内图片压缩/缩放核心逻辑
 *
 * @description
 * 在把图片发给多模态模型前，将其压到 API 允许的尺寸与体积以内：
 * 先按 EXIF 方向转正，再在「最长边 ≤ maxWidth/maxHeight」与
 * 「base64 编码后体积 < maxBytes」双重约束下，尝试 PNG/JPEG 多档质量编码，
 * 必要时逐级缩小尺寸（每轮 ×0.75），直到 1×1 仍超标则返回 null。
 *
 * 依赖关系：
 * - `./photon.ts`：加载 Photon（Rust/WASM）图像处理模块；
 * - `./exif-orientation.ts`：按 EXIF Orientation 标签纠正图片方向。
 */
import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

/** 缩放选项，全部可选，缺省值见 DEFAULT_OPTIONS */
export interface ImageResizeOptions {
	maxWidth?: number; // 最大宽度，默认 2000
	maxHeight?: number; // 最大高度，默认 2000
	maxBytes?: number; // base64 载荷体积上限，默认 4.5MB（低于 Anthropic 的 5MB 限制）
	jpegQuality?: number; // JPEG 初始质量档位，默认 80
}

/** 缩放结果：编码数据 + 原始/输出尺寸 + 是否实际发生过缩放 */
export interface ResizedImage {
	data: string; // base64 编码的图片数据
	mimeType: string; // 最终输出格式（image/png 或 image/jpeg）
	originalWidth: number; // 原始宽度（EXIF 转正后）
	originalHeight: number; // 原始高度（EXIF 转正后）
	width: number; // 输出宽度
	height: number; // 输出高度
	wasResized: boolean; // 是否发生了缩放/重编码（未超限时为 false，保留原始数据）
}

// 4.5MB 的 base64 载荷上限：为 Anthropic 的 5MB 限制留出余量。
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

// 各选项的缺省值（最长边 2000、JPEG 质量 80）
const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

/** 一次编码尝试的结果：base64 数据、编码后的 UTF-8 字节数、对应 MIME 类型 */
interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

/** 把编码后的原始字节包装成候选；encodedSize 按 UTF-8 字节数计，即请求载荷的真实大小 */
function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * 把图片缩放到指定的最大尺寸与编码体积以内。
 * 若无法压到 maxBytes 以下则返回 null。
 *
 * 使用 Photon（Rust/WASM）做图像处理；Photon 不可用时返回 null。
 *
 * 压到 maxBytes 以内的策略：
 * 1. 先缩放到 maxWidth/maxHeight 以内；
 * 2. 同时尝试 PNG 与 JPEG（多档质量）编码，取第一个达标的候选；
 * 3. 仍超标则逐轮把尺寸乘 0.75 继续尝试；
 * 4. 缩到 1×1 仍超标才放弃（返回 null）。
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	// 原始字节 base64 编码后的长度（每 3 字节膨胀为 4 个字符），不足 3 字节按 4 取整
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	// Photon 加载失败（如 WASM 文件缺失）：无法处理，返回 null 交由调用方降级
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		// 先按 EXIF 方向转正；旋转场景会返回新对象，旧对象需手动释放
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// 尺寸与编码体积均已达标：直接返回原始数据，不做重编码（保留原始质量）
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// 计算初始目标尺寸：等比缩放到 maxWidth/maxHeight 以内（先夹宽度再夹高度，保持纵横比）
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		/**
		 * 在指定尺寸下生成编码候选：先 resize（Lanczos3 采样），再编码为
		 * PNG + 各档质量的 JPEG；中间图像用完立即释放，避免 WASM 内存泄漏。
		 */
		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		// 质量档位：用户指定值 + 固定递减序列，去重且保持顺序（首个即用户档位）
		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		// ===== 尺寸递减循环：每轮取第一个体积达标的候选 =====
		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			// 已缩到最小尺寸 1×1 仍超标：放弃
			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			// 各维度按 0.75 缩小，但不小于 1；已为 1 的维度保持 1（允许只缩一边）
			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			// 尺寸无法再缩小（已到整数下限）：退出避免死循环
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		// 解码/编码过程中的任何异常都按「无法处理」处理，返回 null
		return null;
	} finally {
		// 无论成败都释放原始图像占用的 WASM 内存
		if (image) {
			image.free();
		}
	}
}
