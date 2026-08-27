/**
 * @file abort 取消工具：围绕 AbortSignal 的辅助函数。
 *
 * 提供：为 signal 可选的公开 API 补一个本地 signal（operationSignal），
 * 以及让 Promise 与 abort 信号竞速（raceWithAbortSignal）——信号中止时立即以取消原因拒绝，
 * 同时吞掉被放弃操作后续的拒绝，避免 unhandled rejection。
 */

/**
 * 读取 signal 的中止原因。
 *
 * @param signal - 已中止的 AbortSignal
 * @returns 中止原因；若运行时未填充 reason（旧环境或未带原因的 abort()），则合成一个标准 AbortError
 */
function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	// 兜底：部分旧运行时没有 abort reason，手动构造标准 AbortError，保证拒绝值形状与原生一致
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

/**
 * 为 signal 参数可选的公开 API 提供一个操作本地的 AbortSignal。
 *
 * @param signal - 调用方传入的 signal，可省略
 * @returns 传入的 signal 本身；未传入时返回一个永不触发的全新 AbortController 的 signal，
 *          让内部代码可以统一按「必有 signal」处理而无需逐处判空
 */
export function operationSignal(signal?: AbortSignal): AbortSignal {
	return signal ?? new AbortController().signal;
}

/**
 * 让 operation 与 signal 竞速：信号中止时停止等待、立即以中止原因拒绝；
 * 同时继续观察被放弃的 promise，确保其后续的拒绝总有人处理（避免 unhandled rejection）。
 *
 * @param operation - 被等待的操作
 * @param signal - 取消信号
 * @returns 正常时与 operation 同值 resolve；signal 中止时以中止原因 reject
 */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		// 附加空 catch：被放弃的操作稍后若拒绝，这里吞掉以免 unhandled rejection
		void operation.catch(() => {});
		return Promise.reject(abortReason(signal));
	}

	return new Promise<T>((resolve, reject) => {
		// settled 标记保证 resolve/reject 只生效一次（abort 与操作完成可能几乎同时发生）
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortReason(signal));
		};

		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		// 兜底再查一次：覆盖注册监听到执行至此之间信号已被中止的竞态
		if (signal.aborted) onAbort();
	});
}
