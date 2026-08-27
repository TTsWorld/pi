/**
 * @file 助手调用的重试策略与错误分类
 * @description 定义「哪些错误可以重试」与「如何重试」两层：错误分类器（正则匹配错误文本）
 *              判定瞬态/永久错误，重试循环按指数退避重跑助手调用，并通过回调向上层汇报进度。
 *              供 SDK 与 coding-agent 复用（对应 settings.retry 配置）。
 *
 * 主要功能：
 * - isRetryableAssistantError：按错误文本判定是否瞬态可重试（配额/账单类除外）
 * - retryAssistantCall：带指数退避的有界重试循环，abort 语义全程归一化
 * - RetryPolicy / RetryCallbacks：策略与回调类型
 *
 * 依赖关系：
 * - 仅依赖 ../types.ts 的 AssistantMessage 类型
 */

import type { AssistantMessage } from "../types.ts";

/** 把多个错误文本片段拼成单个大小写不敏感的正则（片段本身按正则语法书写，如 `rate.?limit`） */
function buildProviderErrorPattern(patterns: readonly string[]): RegExp {
	return new RegExp(patterns.join("|"), "i");
}

// ========== 不可重试的「配额/账单耗尽」类错误 ==========
// 先于可重试规则判定：同样是 429/限流字样，但属于订阅/账户额度问题，重试只会原地打转
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = buildProviderErrorPattern([
	// OpenCode Go/free-tier 的限额以 429 JSON 错误类型返回（Zen API）。
	// 这些是订阅/账户限额，不是瞬时限流。
	"GoUsageLimitError",
	"FreeUsageLimitError",

	// OpenCode Go 订阅限额文案：滚动/周/月额度用尽后提示用户启用可用余额计费
	"Monthly usage limit reached",
	"available balance",

	// 通用配额/预算/账单耗尽。insufficient_quota 是 OpenAI 的配额/计费错误码；
	// 其余字符串覆盖常见网关措辞
	"insufficient_quota",
	"out of budget",
	"quota exceeded",
	"billing",
]);

// ========== 可重试的瞬态错误（provider 负载 / 网络 / 流中断等） ==========
const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([
	// 通用 provider 过载、HTTP 状态码与服务端瞬态故障
	"overloaded",
	"rate.?limit",
	"too many requests",
	"429",
	"500",
	"502",
	"503",
	"504",
	"524",
	"service.?unavailable",
	"server.?error",
	"internal.?error",

	// 包装层/网关对上游瞬态故障的措辞，含 OpenRouter 的
	// "Provider returned error" 响应（#2264）
	"provider.?returned.?error",
	"exceeded request buffer limit while retrying upstream",

	// 网络/代理/fetch 传输层故障。含 OpenAI Codex raw-fetch 失败如
	// "upstream connect"、"connection refused"、"reset before headers"（#733），
	// 以及 OpenRouter 连接中断（#3317）
	"network.?error",
	"connection.?error",
	"connection.?refused",
	"connection.?lost",
	"other side closed",
	"fetch failed",
	"getaddrinfo",
	"ENOTFOUND",
	"EAI_AGAIN",
	"upstream.?connect",
	"reset before headers",
	"socket hang up",
	"socket connection was closed",
	"timed? out",
	"timeout",
	"terminated",

	// WebSocket 传输可能以 close/error 文案而非 HTTP/fetch 文案报错
	"websocket.?closed",
	"websocket.?error",

	// SDK/传输层的流提前结束。Anthropic 可能抛
	// "stream ended without ..." 与 "Anthropic stream ended before message_stop"
	//（#4433）；Bedrock/Smithy 可能抛 HTTP/2 无响应错误（#3594）
	"ended without",
	"stream ended before message_stop",
	"stream ended before a terminal response event",
	"http2 request did not get a response",

	// 服务端要求的重试延迟超上限时应穿透到外层重试策略，
	// 让调用方有机会展示/中止退避（#1123）
	"retry delay",

	// OpenAI Responses 与 Bedrock 流式异常中明确给出的重试指引（#6019）
	"you can retry your request",
	"try your request again",
	"please retry your request",

	// 基于 gRPC 的 provider（如 NVIDIA NIM）
	"ResourceExhausted",
]);

/**
 * 重试策略：有界次数 + 指数退避（`baseDelayMs * 2^(attempt-1)`）。
 * 与 coding-agent 的 `settings.retry`（`enabled`/`maxRetries`/`baseDelayMs`）对齐；
 * 放在这里是为了让错误分类器和基于策略的重试循环住在一起，
 * 便于 SDK 与其他调用方复用。
 */
export interface RetryPolicy {
	enabled: boolean;
	/** 最大重试次数（0 = 不重试）。首次调用不计入重试次数。 */
	maxRetries: number;
	/** 基础延迟（毫秒）。每次重试的延迟为 `baseDelayMs * 2^(attempt-1)`（抖动前）。 */
	baseDelayMs: number;
}

/** {@link retryAssistantCall} 在每次重试前后发出的可选回调。 */
export interface RetryCallbacks {
	/** 每次重试进入退避等待前发出（attempt 从 1 计数）。 */
	onRetryScheduled?: (
		attempt: number,
		maxAttempts: number,
		delayMs: number,
		errorMessage: string,
	) => void | Promise<void>;
	/** 退避等待结束后、重试调用开始前立即发出。 */
	onRetryAttemptStart?: () => void | Promise<void>;
	/** 循环结束时发出一次：若后续调用正常完成则 success 为 true。 */
	onRetryFinished?: (success: boolean, attempt: number, finalError?: string) => void | Promise<void>;
}

/** 退避睡眠期间被 abort 时抛出的内部错误类型（用于与真实响应的 aborted 语义归一） */
class RetrySleepAbortError extends Error {
	constructor() {
		super("Aborted");
	}
}

/** 可中断的睡眠：signal 已中止或中途中止时以 RetrySleepAbortError 拒绝 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		// 进入睡眠前就已中止：立即拒绝，不安排定时器
		if (signal?.aborted) {
			reject(new RetrySleepAbortError());
			return;
		}
		const timeout = setTimeout(resolve, ms);
		// 中止时清掉定时器再拒绝，避免定时器泄漏后重复 resolve
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				reject(new RetrySleepAbortError());
			},
			{ once: true },
		);
	});
}

/**
 * 执行一次「产出助手消息」的调用，并对瞬态错误做有界重试。
 *
 * 行为：
 * - 成功响应立即返回。abort 是终态、绝不重试，但若发生在已调度过重试之后，
 *   会以「不成功」上报。退避睡眠期间的 abort 也归一化为 aborted 的
 *   AssistantMessage，调用方无需关心取消发生在哪个阶段。
 * - 不可重试错误（见 {@link isRetryableAssistantError}，含配额/账单耗尽）
 *   立即返回，让确定性错误快速失败。
 * - 其余情况按指数退避最多重试 `maxRetries` 次：每次睡眠前发 `onRetryScheduled`，
 *   睡眠后、重试调用前发 `onRetryAttemptStart`，循环结束时发一次
 *   `onRetryFinished`（无论成功、重试耗尽还是退避中被 abort）。
 *
 * 当 `policy` 未传或未启用时，首次响应原样返回（等价于直接调用 `produce()`）。
 *
 * @param produce 真正执行助手调用的函数（每次重试都会重新调用）
 * @param policy 重试策略；undefined 或 enabled=false 时不重试
 * @param signal 取消信号；退避睡眠期间被中止会归一化为 aborted 消息
 * @param callbacks 可选的重试进度回调
 * @returns 终态 AssistantMessage（成功 / 最终错误 / aborted）
 */
export async function retryAssistantCall(
	produce: () => Promise<AssistantMessage>,
	policy: RetryPolicy | undefined,
	signal: AbortSignal | undefined,
	callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
	// 策略未启用时 maxAttempts 为 0：循环首轮的「预算耗尽」分支直接透传首次响应
	const maxAttempts = policy?.enabled ? policy.maxRetries : 0;

	let attempt = 0;
	let lastRetry: { attempt: number; errorMessage: string } | undefined;
	for (;;) {
		const response = await produce();

		// abort：终态且不算成功。aborted 的消息绝不重试
		if (response.stopReason === "aborted") {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt);
			return response;
		}

		// 成功：非 error、非 aborted 的响应原样返回
		if (response.stopReason !== "error") {
			if (lastRetry) await callbacks?.onRetryFinished?.(true, lastRetry.attempt);
			return response;
		}

		// 不可重试、或重试预算已耗尽：返回最终的错误消息
		if (attempt >= maxAttempts || !isRetryableAssistantError(response)) {
			if (lastRetry) await callbacks?.onRetryFinished?.(false, lastRetry.attempt, response.errorMessage);
			return response;
		}

		// ========== 调度下一次重试：指数退避 + 回调 ==========
		attempt++;
		lastRetry = { attempt, errorMessage: response.errorMessage || "Unknown error" };
		const delayMs = policy!.baseDelayMs * 2 ** (attempt - 1);
		await callbacks?.onRetryScheduled?.(attempt, maxAttempts, delayMs, lastRetry.errorMessage);

		// 退避睡眠期间的 abort 归一化为与 provider 流中止相同的 AssistantMessage 形状，
		// 调用方无需关心取消发生在哪个阶段
		try {
			await sleep(delayMs, signal);
		} catch (error) {
			await callbacks?.onRetryFinished?.(false, attempt, lastRetry.errorMessage);
			if (error instanceof RetrySleepAbortError) {
				return { ...response, stopReason: "aborted", errorMessage: undefined };
			}
			throw error;
		}
		await callbacks?.onRetryAttemptStart?.();
	}
}

/**
 * 判定失败的助手消息是否「看起来像」瞬态 provider/传输错误，
 * 供调用方决定是否重启最后一轮助手回合。
 *
 * 本函数不实现重试策略。调用方应先单独处理上下文溢出，
 * 再套用自己的重试预算、退避与上报逻辑后重启助手回合。
 *
 * @param message 待判定的助手消息
 * @returns true 表示错误文本命中可重试模式且未命中配额/账单类不可重试模式
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	// 先排除配额/账单类：同样含 429/limit 字样但重试无意义
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}
