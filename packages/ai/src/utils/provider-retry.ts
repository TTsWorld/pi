/**
 * @file provider 请求级重试（SDK 外壳）
 * @description 复刻 OpenAI/Anthropic SDK 的内建重试行为，但让退避等待可被 AbortSignal 中断。
 *              各 API 实现（src/api/*.ts）以 `maxRetries: 0` 调用官方 SDK，再用本模块的
 *              retryProviderRequest 包装，从而拿到可中断的退避与服务端延迟上限保护。
 *
 * 依赖关系：
 * - 被 src/api/ 下各协议实现用于包装 SDK 请求
 */

// 服务端要求的重试延迟上限（默认 60 秒），超过即视为异常直接抛错
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions {
	/** 最大重试次数（默认 0，即不重试） */
	maxRetries?: number;
	/** 服务端要求延迟的上限（毫秒）；默认 60s，传 0 表示不设限 */
	maxRetryDelayMs?: number;
	/** 取消信号；等待期间被中止会以 AbortError 拒绝 */
	signal?: AbortSignal;
}

/** 带 HTTP status 与响应头的 provider 错误形态（OpenAI/Anthropic SDK 的 APIError 均满足） */
interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

/** 类型守卫：仅认可「status/headers 字段形态正确」的错误对象，避免误把普通 Error 当 provider 错误 */
function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/**
 * 判定 provider 错误是否可重试；镜像所锁定版本 OpenAI/Anthropic SDK 的重试策略，
 * 任一 SDK 升级时需要同步复核此函数。
 */
function isRetryableProviderError(error: ProviderError): boolean {
	// 服务端用 x-should-retry 头显式表态时无条件服从（true/false 都直接采信）
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	// 无状态码（纯网络层错误）默认可重试
	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

/**
 * 校验服务端要求的重试延迟不超上限；超限立即抛错（带上服务端原始错误信息），
 * 让上层有机会中止而非无限等待。maxRetryDelayMs 为 0 表示不设上限。
 */
function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

/**
 * 计算本次重试的等待时长。优先级：retry-after-ms 头 > retry-after 头 > 带抖动的指数退避。
 * retry-after 支持秒数与 HTTP 日期两种格式；指数退避为 0.5s 起、8s 封顶，
 * 再乘以 [0.75, 1] 的随机抖动以避免惊群。
 */
function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	// 第一优先：毫秒级精度的 retry-after-ms 头
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (!Number.isNaN(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	// 第二优先：retry-after 头（秒数或 HTTP 日期）
	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		// 解析不出秒数则按 HTTP 日期计算距现在的毫秒差
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	// 兜底：0.5s * 2^retryIndex、8s 封顶的指数退避，附 0~25% 的向下抖动
	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

/** 构造 name 为 AbortError 的错误（与 fetch 中止时抛出的形态一致，便于上层统一识别） */
function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

/** 可中断的睡眠：signal 中止时以 AbortError 拒绝，并清理定时器与监听器 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		// 进入睡眠前已中止：立即拒绝
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				// 正常睡醒：移除 abort 监听，避免监听器堆积
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 复刻 OpenAI/Anthropic SDK 的重试行为，同时让退避等待可中断。
 * SDK 内建的重试定时器不感知请求的 AbortSignal，因此调用方必须以
 * `maxRetries: 0` 调用 SDK、并用本函数包装请求。
 * 服务端要求的延迟超过 `maxRetryDelayMs`（默认 60 秒）时立即失败；传 0 可关闭该上限。
 *
 * @param request 真正发起 SDK 请求的函数（每次重试都重新调用）
 * @param options 重试次数 / 延迟上限 / 取消信号
 * @returns 请求的最终结果；不可重试或耗尽次数时抛出原始错误
 */
export async function retryProviderRequest<T>(
	request: () => Promise<T>,
	options: ProviderRetryOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;

	for (;;) {
		try {
			// 每次重试都是全新的 SDK 请求，因此 X-Stainless-Retry-Count 头保持为零
			return await request();
		} catch (error) {
			// 请求抛错但 signal 已中止：统一转成 AbortError 抛出（可能是 SDK 吞掉了中止语义）
			if (options.signal?.aborted) throw createAbortError();
			if (retriesRemaining <= 0 || !isProviderError(error) || !isRetryableProviderError(error)) throw error;

			// 按已发生的重试序号计算指数退避（第 0 次重试用 0.5s 起）
			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(getRetryDelayMs(error, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}
