/**
 * @file management-http.ts —— 管理类 HTTP 请求的 fetch 封装（带有限重试与超时）
 *
 * @description
 * 面向幂等的管理请求（版本检查、目录、下载）提供传输层辅助 `fetchWithRetry`：
 * 对瞬时网络错误与可重试状态码做有界重试，并区分「总超时」与「单次尝试超时」。
 */

type FetchInput = Parameters<typeof fetch>[0];

/** 视为瞬时故障、可安全重试的 HTTP 状态码集合。 */
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** fetchWithRetry 的重试与超时选项。 */
export interface FetchRetryOptions {
	/** 首次请求之外额外的重试次数。默认为 2。 */
	maxRetries?: number;
	/** 除传输失败外，是否也对瞬时 HTTP 状态码重试。默认为 true。 */
	retryOnStatus?: boolean;
	/** 所有尝试共享的总时间预算。 */
	timeoutMs?: number;
	/** 单次尝试的超时。每次尝试都会新建一个超时计时。 */
	attemptTimeoutMs?: number;
}

/**
 * 抓取管理类 HTTP 资源，带有限次数的立即重试。
 *
 * 这是有意为之的传输层辅助函数，仅用于幂等的管理请求
 * （版本检查、目录、下载）。不得用于 agent/模型操作：
 * 那类请求可能在 HTTP 请求开始后才失败，应由其语义层调用方负责重试。
 *
 * 调用方取消与 timeoutMs 是终态（直接抛错不再重试）。attemptTimeoutMs
 * 只中止当前这一次尝试，因此挂死的连接可以被重试。
 *
 * @param input - 请求 URL（或 Request 对象）
 * @param init - 透传给 fetch 的初始化参数
 * @param options - 重试与超时选项
 */
export async function fetchWithRetry(
	input: FetchInput,
	init: RequestInit | undefined = undefined,
	options: FetchRetryOptions = {},
): Promise<Response> {
	const maxRetries =
		options.maxRetries === undefined || !Number.isFinite(options.maxRetries)
			? 2
			: Math.max(0, Math.floor(options.maxRetries));
	const retryOnStatus = options.retryOnStatus ?? true;
	const parentSignal = init?.signal ?? undefined;
	const timeoutSignal =
		options.timeoutMs !== undefined && options.timeoutMs > 0 ? AbortSignal.timeout(options.timeoutMs) : undefined;
	const attemptTimeoutMs =
		options.attemptTimeoutMs !== undefined && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : undefined;

	for (let attempt = 0; ; attempt++) {
		parentSignal?.throwIfAborted();
		timeoutSignal?.throwIfAborted();
		// 每次尝试新建单次超时信号，并与父信号、总超时信号合并为任一触发即中止
		const attemptTimeoutSignal = attemptTimeoutMs ? AbortSignal.timeout(attemptTimeoutMs) : undefined;
		const signals = [parentSignal, timeoutSignal, attemptTimeoutSignal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

		try {
			const response = await fetch(input, signal ? { ...init, signal } : init);
			const shouldRetry = retryOnStatus && RETRYABLE_STATUS_CODES.has(response.status) && attempt < maxRetries;
			if (!shouldRetry) return response;
			try {
				await response.body?.cancel();
			} catch {
				// 响应即将在重试前被丢弃；取消其 body 若也失败，无需再做任何处理。
			}
		} catch (error) {
			// 区分「仅单次尝试超时」（可重试）与其他中止/失败（终态）
			const attemptTimedOut =
				attemptTimeoutSignal?.aborted === true && !parentSignal?.aborted && !timeoutSignal?.aborted;
			if (
				parentSignal?.aborted ||
				timeoutSignal?.aborted ||
				(error instanceof Error &&
					error.name === "AbortError" &&
					!attemptTimedOut &&
					timeoutSignal === undefined) ||
				attempt >= maxRetries
			) {
				throw error;
			}
		}
	}
}
