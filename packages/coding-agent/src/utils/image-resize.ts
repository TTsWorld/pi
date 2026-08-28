/**
 * @file image-resize.ts —— 图片缩放入口（Worker 线程优先 + 进程内兜底）
 *
 * @description
 * 对外暴露 `resizeImage` / `formatDimensionNote`：
 * 优先在 worker 线程中运行 Photon（WASM）完成解码、缩放与重新编码，避免阻塞 TUI 事件循环；
 * worker 加载失败时回退到进程内（image-resize-core.ts）缩放，保证图片读取功能始终可用。
 */

import { Worker } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

export type { ImageResizeOptions, ResizedImage } from "./image-resize-core.ts";

/** worker 回传的响应结构：成功时携带缩放结果，失败时携带错误信息字符串。 */
interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

/**
 * 复制一份可安全 transfer 的字节副本。
 */
function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer 会 detach 底层 buffer，因此转移的是归 worker 所有的副本，
	// 调用方的原始字节保持完整不被破坏。
	return new Uint8Array(input);
}

/** 极简结构守卫：worker 返回的响应至少是一个非空对象。 */
function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return value !== null && typeof value === "object";
}

/** 按指定入口（字符串路径或 URL）创建一个图片缩放 worker 线程。 */
function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

/**
 * 在独立 worker 线程中执行一次图片缩放。
 * 通过 postMessage 以 transfer 方式移交输入字节，等待单次 message 回包；
 * 无论成功失败，finally 中都会 terminate worker，防止线程泄漏。
 */
async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			// message / error / exit 三种事件都可能到来，用 settled 标记保证 Promise 只结算一次
			let settled = false;
			const settle = (result: ResizedImage | null): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.once("message", (message: unknown) => {
				if (!isResizeImageWorkerResponse(message)) {
					fail(new Error("Invalid image resize worker response"));
					return;
				}
				if (message.error) {
					fail(new Error(message.error));
					return;
				}
				settle(message.result ?? null);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * 将图片缩放到指定的最大宽高与编码后文件大小以内。
 * 在 worker 线程中运行 Photon，使 WASM 解码、缩放与编码不阻塞 TUI 事件循环；
 * 若 worker 无法加载（例如某些 Bun 编译产物的布局），则回退到进程内缩放，
 * 保证图片读取仍然可用。
 *
 * @param inputBytes - 原始图片字节
 * @param mimeType - 图片 MIME 类型
 * @param options - 缩放选项（最大宽高、最大字节数等），省略时用默认值
 * @returns 缩放结果；无法处理时返回 null
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	// Bun 编译产物按字符串路径解析 worker 入口，而不是 new URL(..., import.meta.url)。
	// 在 Bun 下优先尝试字符串路径，让发布二进制能用上内嵌的 worker，而不是回退到进程内缩放。
	if (typeof process.versions.bun === "string") {
		try {
			return await resizeImageInWorker("./src/utils/image-resize-worker.ts", inputBytes, mimeType, options);
		} catch {}
	}

	try {
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch {
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}

/**
 * 为缩放后的图片生成一条尺寸说明文本。
 * 帮助模型理解显示尺寸与原图之间的坐标映射（坐标需乘以缩放系数才能对应回原图）。
 *
 * @param result - 缩放结果
 * @returns 说明文本；图片未被缩放时返回 undefined
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
