/**
 * @file 可中断的延时等待工具。
 * 提供 sleep：到时后 resolve，期间可被 AbortSignal 立即中断，供流式请求重试、轮询等异步流程使用。
 */

/**
 * 等待指定毫秒数，支持通过 AbortSignal 提前中断。
 * 进入等待前若 signal 已中止则直接抛出中止原因；等待中被中止则以 signal.reason 拒绝，正常到时则 resolve。
 * @param ms 等待的毫秒数
 * @param signal 中断信号
 * @returns 到时 resolve 的 Promise；被中止时 reject(signal.reason)
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const onAbort = () => {
			clearTimeout(timeout);
			reject(signal.reason);
		};
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
