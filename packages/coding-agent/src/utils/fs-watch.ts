/**
 * @file fs-watch.ts —— fs.watch 的容错封装
 *
 * @description
 * 提供「关闭不抛错」与「创建失败 / 运行期出错都走回调」的 watcher 辅助，
 * 配合 FS_WATCH_RETRY_DELAY_MS 用于监听失败后的定时重试。
 */

import { type FSWatcher, type WatchListener, watch } from "node:fs";

/** watcher 失败后重试前等待的毫秒数。 */
export const FS_WATCH_RETRY_DELAY_MS = 5000;

/** 关闭 watcher 并吞掉可能的异常（例如底层句柄已失效）。 */
export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// 忽略关闭 watcher 时的错误
	}
}

/**
 * 创建带错误处理的 watcher：创建成功后把运行期错误转发给 onError，
 * 创建本身就失败则直接调用 onError 并返回 null。
 */
export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	try {
		const watcher = watch(path, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
