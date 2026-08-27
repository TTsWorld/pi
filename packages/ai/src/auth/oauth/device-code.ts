/**
 * @file OAuth 设备码授权流程（Device Authorization Grant，RFC 8628）的共享轮询实现
 *
 * @description 各厂商的设备码流（用户在另一台设备上输入 user_code 完成授权）复用本文件的
 * 通用轮询循环：按服务端指示的间隔反复请求 token 端点，处理 pending / slow_down /
 * failed / complete 四种轮询结果，并遵守有效期截止与外部取消（AbortSignal）。
 */

// 用户主动取消（AbortSignal 触发）时抛出的错误消息
const CANCEL_MESSAGE = "Login cancelled";
// 超出设备码有效期仍未完成授权时抛出的错误消息
const TIMEOUT_MESSAGE = "Device flow timed out";
// 超时且期间收到过 slow_down 响应时的专用错误消息：
// 这种情况多由 WSL / 虚拟机时钟漂移引起（客户端按本地时钟计算的下次轮询时刻早于服务端要求），
// 因此额外提示用户同步或重启虚拟机时钟后重试
const SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
// 轮询间隔下限：无论服务端如何指示，最快也只能 1 秒一次
const MINIMUM_INTERVAL_MS = 1000;
// RFC 8628 第 3.2 节：授权服务器若未返回 `interval`，客户端必须使用 5 秒作为轮询间隔。
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// RFC 8628 第 3.5 节：`slow_down` 表示轮询间隔必须在现有基础上增加 5 秒。
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

/** 单次轮询的「未完成」结果：pending 仍在等待用户授权；slow_down 要求放慢轮询（可携带服务端指定的新间隔）；failed 已失败。 */
type OAuthDeviceCodeIncompletePollResult =
	| { status: "pending" }
	| { status: "slow_down"; intervalSeconds?: number }
	| { status: "failed"; message: string };

/** 单次轮询的完整结果：在未完成状态之外，新增携带最终授权值的成功态 complete。 */
export type OAuthDeviceCodePollResult<T> = OAuthDeviceCodeIncompletePollResult | { status: "complete"; value: T };

/** 设备码轮询循环的配置。 */
export type OAuthDeviceCodePollOptions<T> = {
	// 初始轮询间隔（秒）；未提供时按 RFC 8628 缺省为 5 秒
	intervalSeconds?: number;
	// 整体有效期（秒），从调用时刻起算，超时抛出超时错误；未提供则视为无限等待
	expiresInSeconds?: number;
	// 是否在发起首次轮询前先等待一个间隔（默认立即发起首次轮询）
	waitBeforeFirstPoll?: boolean;
	// 执行一次实际 token 端点请求的回调，由各厂商的流实现提供
	poll: () => Promise<OAuthDeviceCodePollResult<T>>;
	// 外部取消信号（如用户中断登录）；触发后整个循环立即以取消错误退出
	signal: AbortSignal;
};

/**
 * 可被 AbortSignal 中断的 sleep。
 * 普通 setTimeout 睡眠无法响应取消，这里在等待期间监听 abort 事件，一旦取消立即
 * reject，避免用户中断登录后还要白等剩余时间。
 * @param ms 睡眠时长（毫秒）
 * @param signal 外部取消信号
 * @param cancelMessage 取消时抛出的错误消息
 * @returns 睡眠结束后 resolve；被取消时以 Error reject
 */
export function abortableSleep(ms: number, signal: AbortSignal, cancelMessage: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// 进入时信号已处于取消态，直接拒绝，不再安排定时器
		if (signal.aborted) {
			reject(new Error(cancelMessage));
			return;
		}

		// 取消时清理未到期的定时器并立即拒绝
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error(cancelMessage));
		};
		// 正常睡满后移除 abort 监听（防止泄漏）并 resolve
		const timeout = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		// once: 触发一次后自动解绑
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 驱动设备码授权流程的轮询循环。
 * 按当前间隔反复调用 poll 回调，直到成功（complete）、失败（failed）、超出有效期
 * 或被取消；收到 slow_down 时遵守服务端指示放大间隔（见循环内注释）。
 * @param options 轮询配置（初始间隔、有效期、poll 回调、取消信号等）
 * @returns 成功时 poll 回调返回的授权结果
 * @throws 取消、轮询失败或超时时抛出对应的 Error
 */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodePollOptions<T>): Promise<T> {
	// 把有效期换算为绝对截止时间戳；未给定时用 +Infinity 表示永不超时
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	// 初始轮询间隔：秒转毫秒，并强制不低于 1 秒下限
	let intervalMs = Math.max(
		MINIMUM_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000),
	);

	// 记录收到的 slow_down 次数，用于在最终超时时选择更具体的错误提示
	let slowDownResponses = 0;
	// 要求首询前先等一个间隔时，等待时长取「一个间隔」与「剩余有效期」的较小值，避免越过截止时间
	if (options.waitBeforeFirstPoll) {
		const remainingMs = deadline - Date.now();
		if (remainingMs > 0) {
			await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
		}
	}

	while (Date.now() < deadline) {
		// 每轮开始前再查一次取消信号，覆盖 sleep 之外的取消窗口
		if (options.signal.aborted) {
			throw new Error(CANCEL_MESSAGE);
		}

		const result = await options.poll();
		if (result.status === "complete") {
			return result.value;
		}
		if (result.status === "failed") {
			throw new Error(result.message);
		}
		if (result.status === "slow_down") {
			slowDownResponses += 1;
			// 服务端在响应里给出新间隔时（GitHub 会在 `interval` 中报告新的最小值）优先采用；
			// 只依赖客户端自己累加的间隔，在 WSL/VM 时钟漂移下可能永远过早轮询。
			// 否则按 RFC 8628 第 3.5 节处理：在当前间隔上增加 5 秒。
			intervalMs =
				typeof result.intervalSeconds === "number" &&
				Number.isFinite(result.intervalSeconds) &&
				result.intervalSeconds > 0
					? Math.max(MINIMUM_INTERVAL_MS, Math.floor(result.intervalSeconds * 1000))
					: Math.max(MINIMUM_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
		}

		// 剩余有效期不足一个完整间隔时只等剩余时间；已到期则跳出循环走超时逻辑
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}

		await abortableSleep(Math.min(intervalMs, remainingMs), options.signal, CANCEL_MESSAGE);
	}

	// 走到这里说明超出有效期仍未完成：若期间收到过 slow_down，抛出带时钟漂移排查提示的专用消息
	throw new Error(slowDownResponses > 0 ? SLOW_DOWN_TIMEOUT_MESSAGE : TIMEOUT_MESSAGE);
}
