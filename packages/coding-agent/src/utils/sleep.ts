/**
 * @file sleep.ts —— 支持中止信号的休眠
 *
 * @description
 * Promise 版 sleep，可被 AbortSignal 提前打断（以 "Aborted" 错误 reject）。
 */

/**
 * 休眠指定毫秒数，支持通过 AbortSignal 提前中断。
 *
 * @param ms - 休眠时长（毫秒）
 * @param signal - 可选中止信号；中止时清除定时器并以 "Aborted" 错误 reject
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		// 信号已中止时不再等待，立即 reject
		if (signal?.aborted) {
			reject(new Error("Aborted"));
			return;
		}

		const timeout = setTimeout(resolve, ms);

		// 中止时清除定时器，避免 reject 之后又 resolve
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Aborted"));
		});
	});
}
