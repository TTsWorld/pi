/**
 * @file image-resize-worker.ts —— 图片缩放 worker 线程入口
 *
 * @description
 * 由 image-resize.ts 创建的 worker 线程执行体：从父端口接收一次
 * 「图片字节 + MIME + 缩放选项」的请求，在进程内完成缩放后回传结果或错误。
 */

import { parentPort } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./image-resize-core.ts";

/** 主线程发来的请求结构。 */
interface ResizeImageWorkerRequest {
	inputBytes: Uint8Array;
	mimeType: string;
	options?: ImageResizeOptions;
}

/** 回传给主线程的响应结构：成功带 result，失败带 error。 */
interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

/** 结构守卫：校验消息确实是带 Uint8Array 字节与字符串 MIME 的合法请求。 */
function isResizeImageWorkerRequest(value: unknown): value is ResizeImageWorkerRequest {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return record.inputBytes instanceof Uint8Array && typeof record.mimeType === "string";
}

const port = parentPort;
if (!port) {
	throw new Error("image resize worker requires parentPort");
}

// 只处理一条消息：完成或失败后即回传，由主线程负责 terminate
port.once("message", (message: unknown) => {
	void (async () => {
		try {
			if (!isResizeImageWorkerRequest(message)) {
				throw new Error("Invalid image resize worker request");
			}
			const result = await resizeImageInProcess(message.inputBytes, message.mimeType, message.options);
			const response: ResizeImageWorkerResponse = { result };
			port.postMessage(response);
		} catch (error) {
			const response: ResizeImageWorkerResponse = {
				error: error instanceof Error ? error.message : String(error),
			};
			port.postMessage(response);
		}
	})();
});
