/**
 * @file abort.ts —— AbortSignal 辅助函数
 *
 * @description
 * 提供两种常见的中断处理模式：把可选信号归一化为始终存在的信号，
 * 以及「等待时响应中断、中断后不再等待（但操作继续在后台完成）」的竞速封装。
 */

/** 取出 signal 上携带的中止原因；未显式设置时构造标准 AbortError。 */
function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

/** 归一化可选的外部信号：未提供时返回一个永不中止的信号（不附加任何超时）。 */
export function operationSignal(signal?: AbortSignal): AbortSignal {
	return signal ?? new AbortController().signal;
}

/**
 * 让等待过程响应 abort 信号：一旦中止立即 reject，
 * 而被抛弃的操作本身仍继续执行（其结果/错误通过 settlement 被静默观察，不产生未处理拒绝）。
 *
 * @param operation - 需要等待的操作 Promise
 * @param signal - 可选的中止信号
 * @returns 与 operation 同值 settle 的 Promise；signal 中止时以中止原因 reject
 */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return operation;
	if (signal.aborted) {
		// 信号已中止：吞掉 operation 后续可能的拒绝，直接以中止原因 reject
		void operation.catch(() => {});
		return Promise.reject(abortReason(signal));
	}

	return new Promise<T>((resolve, reject) => {
		// settled 标记保证 abort 与 operation 只有一方生效，并在结束后摘除监听
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
		if (signal.aborted) onAbort();
	});
}
