/**
 * @file Kimi Code（订阅）OAuth 登录流程
 *
 * @description
 * 面向 https://auth.kimi.com 的 RFC 8628 设备码授权（device authorization
 * grant），响应体为 JSON。取得的 access token 以 `Authorization: Bearer`
 * 请求头认证对 https://api.kimi.com/coding 的访问。本文件实现 OAuthAuth
 * 三段式：login（设备码流，复用共享轮询器 device-code.ts）、refresh（带
 * 指数退避重试）、toAuth（凭据 → Bearer 请求头）。
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

// 注册在 Kimi OAuth 服务端的 client_id；设备码流属于公开客户端，没有 secret
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
// OAuth 服务默认地址，可用环境变量覆盖（见 getOauthHost）
const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
// 设备码有效期兜底值（15 分钟）：服务端未返回 expires_in 时采用
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
// 轮询间隔兜底值（5 秒）：服务端未返回 interval 时采用（RFC 8628 缺省值同为 5 秒）
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
// 单次 HTTP 请求的超时（30 秒），与外部取消信号求并集（见 requestSignal）
const REQUEST_TIMEOUT_MS = 30 * 1000;
// 刷新失败时的最大重试次数（加上首次尝试共 4 次）
const REFRESH_MAX_RETRIES = 3;

/** 设备码授权端点（/api/oauth/device_authorization）的响应数据。 */
type DeviceAuthorization = {
	/** 设备码：轮询 token 端点时作为 device_code 提交，对用户不可见 */
	deviceCode: string;
	/** 用户码：由用户在验证页输入以确认本次登录 */
	userCode: string;
	/** 验证页地址 */
	verificationUri: string;
	/** 已附带用户码的验证页地址，用户打开即完成输入 */
	verificationUriComplete: string;
	/** 服务端指示的轮询间隔（秒） */
	intervalSeconds: number;
	/** 设备码整体有效期（秒） */
	expiresInSeconds: number;
};

/** token 端点（/api/oauth/token）成功响应解析后的规范化结果。 */
type TokenResponse = {
	/** 访问令牌（access token） */
	access: string;
	/** 刷新令牌（refresh token） */
	refresh: string;
	/** access token 的过期时刻（epoch 毫秒），由 expires_in 换算而来 */
	expires: number;
};

/**
 * 解析 OAuth 服务地址：依次读 KIMI_CODE_OAUTH_HOST、KIMI_OAUTH_HOST
 * 环境变量覆盖，均未设置时用默认地址；再剥掉结尾多余的斜杠，便于直接拼接路径。
 */
function getOauthHost(): string {
	const override = getProviderEnvValue("KIMI_CODE_OAUTH_HOST") || getProviderEnvValue("KIMI_OAUTH_HOST");
	return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

/**
 * 组合单次请求的中止信号：请求超时与外部 signal 任一触发即中止，
 * 避免单个卡死的请求拖住整个登录/刷新流程。
 */
function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

/** 把字段字典序列化为 application/x-www-form-urlencoded 请求体。 */
function formUrlEncode(fields: Record<string, string>): string {
	return new URLSearchParams(fields).toString();
}

/**
 * 读取响应体并解析为 JSON 对象。
 * 解析失败（非 JSON 或空体）时返回 null 而非抛错：错误响应不保证是 JSON，
 * 缺字段的情况交由调用方按各自分支处理。
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** 验证 URI 会在用户的浏览器中打开；仅信任 http(s) 协议的地址。 */
function trustedHttpUrl(value: unknown): string | null {
	if (typeof value !== "string" || !value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		return url.href;
	} catch {
		return null;
	}
}

/**
 * 发起设备码授权：POST /api/oauth/device_authorization，请求体仅携带
 * client_id，取回设备码、用户码、验证页地址与轮询参数。
 * @throws HTTP 非 2xx，或必填字段缺失 / 验证 URI 不可信时抛出带响应详情的 Error
 */
async function startDeviceAuthorization(oauthHost: string, signal: AbortSignal): Promise<DeviceAuthorization> {
	const response = await fetch(`${oauthHost}/api/oauth/device_authorization`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: formUrlEncode({ client_id: CLIENT_ID }),
		signal: requestSignal(signal),
	});

	// 非 2xx（如 client_id 无效）：携带状态码与响应文本抛错，便于排查
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Kimi Code device authorization failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}

	// ========== 校验响应字段 ==========
	// 四个必填字段都必须是字符串，且两个验证 URI 必须通过 trustedHttpUrl
	// 校验：这些地址将被交给用户浏览器打开，不能信任任意协议的值
	const json = await readJson(response);
	const deviceCode = json?.device_code;
	const userCode = json?.user_code;
	const verificationUri = json?.verification_uri;
	const verificationUriComplete = json?.verification_uri_complete;
	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		typeof verificationUriComplete !== "string" ||
		!trustedHttpUrl(verificationUriComplete) ||
		!trustedHttpUrl(verificationUri)
	) {
		throw new Error(`Invalid Kimi Code device authorization response: ${JSON.stringify(json)}`);
	}

	// interval / expires_in 缺失或非法时退回客户端兜底值（5 秒 / 15 分钟）
	const interval = json?.interval;
	const expiresIn = json?.expires_in;
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete,
		intervalSeconds:
			typeof interval === "number" && Number.isFinite(interval) && interval > 0
				? interval
				: DEFAULT_POLL_INTERVAL_SECONDS,
		expiresInSeconds:
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? expiresIn
				: DEVICE_CODE_TIMEOUT_SECONDS,
	};
}

/**
 * 校验并规范化 token 端点的成功响应：access_token / refresh_token 须为
 * 非空字符串，expires_in 须为正的有限数；任一不满足即抛错——残缺凭据
 * 一旦落库会被当作有效使用，必须在入口拦下。
 * @param json token 端点响应体（可能为 null）
 * @param operation 操作描述（"poll" / "refresh"），仅用于拼接错误消息
 */
function parseTokenResponse(json: Record<string, unknown> | null, operation: string): TokenResponse {
	const accessToken = json?.access_token;
	const refreshToken = json?.refresh_token;
	const expiresIn = json?.expires_in;
	if (
		typeof accessToken !== "string" ||
		!accessToken ||
		typeof refreshToken !== "string" ||
		!refreshToken ||
		typeof expiresIn !== "number" ||
		!Number.isFinite(expiresIn) ||
		expiresIn <= 0
	) {
		throw new Error(`Kimi Code token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}
	// expires_in（相对秒数）换算为绝对过期时刻（epoch 毫秒）
	return {
		access: accessToken,
		refresh: refreshToken,
		expires: Date.now() + expiresIn * 1000,
	};
}

/**
 * 轮询 /api/oauth/token 直到用户完成授权（设备码流程的核心环节）。
 * 循环本身复用共享的 pollOAuthDeviceCodeFlow（负责按间隔等待、slow_down
 * 放大间隔、超时与取消），这里只提供单次轮询的请求发起与结果映射。
 */
async function pollForToken(
	oauthHost: string,
	device: DeviceAuthorization,
	signal: AbortSignal,
): Promise<TokenResponse> {
	return pollOAuthDeviceCodeFlow<TokenResponse>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await fetch(`${oauthHost}/api/oauth/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: formUrlEncode({
					client_id: CLIENT_ID,
					device_code: device.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal: requestSignal(signal),
			});

			// ========== 5xx：服务端临时故障 ==========
			// 共享轮询器不会自动重试 failed，因此 5xx 直接终止整个登录流程
			if (response.status >= 500) {
				const text = await response.text().catch(() => "");
				return {
					status: "failed",
					message: `Kimi Code device token request failed with status ${response.status}${text ? `: ${text}` : ""}`,
				};
			}

			// ========== 成功：解析并规范化 token ==========
			// 以 access_token 存在判定成功；parseTokenResponse 抛出的校验错误
			// 也映射为 failed，不让异常逃出轮询回调
			const json = await readJson(response);
			if (response.ok && typeof json?.access_token === "string") {
				try {
					return { status: "complete", value: parseTokenResponse(json, "poll") };
				} catch (error) {
					return { status: "failed", message: error instanceof Error ? error.message : String(error) };
				}
			}

			// ========== 按 RFC 8628 错误码映射轮询状态 ==========
			const error = json?.error;
			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			// 用户尚未完成授权：继续按间隔等待下一轮
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			// 服务端要求放慢轮询；响应携带新 interval 时优先采用
			if (error === "slow_down") {
				const interval = json?.interval;
				return {
					status: "slow_down",
					intervalSeconds: typeof interval === "number" && interval > 0 ? interval : undefined,
				};
			}
			// 设备码已过期：无法恢复，只能重新发起登录
			if (error === "expired_token") {
				return { status: "failed", message: "Kimi Code device authorization expired. Please restart login." };
			}
			// 用户在验证页拒绝了本次授权
			if (error === "access_denied") {
				return { status: "failed", message: "Kimi Code login was denied." };
			}
			// 其余错误（未知 error 码 / 4xx 等）：统一按失败终止
			return {
				status: "failed",
				message: `Kimi Code device token request failed (status ${response.status})${typeof error === "string" ? `: ${error}${description}` : ""}`,
			};
		},
	});
}

/** 刷新请求是否值得重试：429（限流）与 5xx（服务端临时故障）。 */
function isRetryableRefreshFailure(response: Response): boolean {
	return response.status === 429 || response.status >= 500;
}

/**
 * 用 refresh token 换取新凭据（POST /api/oauth/token，grant_type=refresh_token）。
 * 网络异常与可重试状态码（429/5xx）按 1s/2s/4s 指数退避重试，最多
 * REFRESH_MAX_RETRIES 次；凭据失效（401/403/invalid_grant）与其余错误立即
 * 抛出。本方法由 Models 在 CredentialStore.modify 锁内调用，避免并发请求
 * 对同一 token 双重刷新。
 */
async function refreshToken(oauthHost: string, refreshTokenValue: string, signal: AbortSignal): Promise<TokenResponse> {
	let lastError: Error | undefined;
	// 共尝试 1 + REFRESH_MAX_RETRIES 次；重试前指数退避，给限流/故障中的服务端恢复时间
	for (let attempt = 0; attempt <= REFRESH_MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(1000 * 2 ** (attempt - 1), signal);
		}
		// 退避等待期间用户可能已取消，每轮开工前再检查一次
		if (signal.aborted) {
			throw new Error("Kimi Code token refresh aborted");
		}

		let response: Response;
		try {
			response = await fetch(`${oauthHost}/api/oauth/token`, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					Accept: "application/json",
				},
				body: formUrlEncode({
					client_id: CLIENT_ID,
					grant_type: "refresh_token",
					refresh_token: refreshTokenValue,
				}),
				signal: requestSignal(signal),
			});
		} catch (error) {
			// 网络层异常（超时 / 断网等）视为可重试：记录后进入下一轮
			lastError = error instanceof Error ? error : new Error(String(error));
			continue;
		}

		// 成功：解析并返回新凭据
		const json = await readJson(response);
		if (response.ok) {
			return parseTokenResponse(json, "refresh");
		}

		// 未授权：存储的凭据已失效；Models 会清除它并提示重新登录。
		// 这类错误重试无意义，必须立即抛出
		if (response.status === 401 || response.status === 403 || json?.error === "invalid_grant") {
			const description = typeof json?.error_description === "string" ? `: ${json.error_description}` : "";
			throw new Error(`Kimi Code token refresh unauthorized (status ${response.status})${description}`);
		}

		// 限流 / 服务端临时故障且仍有重试额度：记录后退避重试
		if (isRetryableRefreshFailure(response) && attempt < REFRESH_MAX_RETRIES) {
			lastError = new Error(`Kimi Code token refresh failed with status ${response.status}`);
			continue;
		}

		// 其余 4xx 等不可重试错误：立即失败并带上响应体
		const text = JSON.stringify(json);
		throw new Error(`Kimi Code token refresh failed with status ${response.status}${text ? `: ${text}` : ""}`);
	}

	// 重试全部耗尽仍无结果：抛出最后一次记录的错误
	throw lastError ?? new Error("Kimi Code token refresh failed");
}

/**
 * 交互式登录入口：申请设备码 → 通过 notify 把用户码与验证页推给 UI →
 * 轮询 token 端点直到用户完成授权，产出可存储的 OAuth 凭据。
 */
async function loginKimiCoding(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const oauthHost = getOauthHost();
	// 第一步：申请设备码 / 用户码 / 验证页地址
	const device = await startDeviceAuthorization(oauthHost, interaction.signal);
	// 第二步：推送设备码事件；优先给已附带用户码的 verificationUriComplete，
	// 用户打开链接即完成输入，无需手敲 userCode
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	// 第三步：后台轮询直到授权完成（或超时 / 被取消）
	const token = await pollForToken(oauthHost, device, interaction.signal);
	return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
}

/** Kimi Code（订阅）认证方式：设备码登录 + 带重试的刷新 + Bearer 请求头。 */
export const kimiCodingOAuth: OAuthAuth = {
	name: "Kimi Code (subscription)",
	// 该认证下的访问由 Kimi 订阅支撑（区别于按量付费的 API key）
	isSubscription: true,
	// 登录选项在选择器中展示的文案
	loginLabel: "Sign in with Kimi Code",

	login: loginKimiCoding,

	// 刷新由 Models 在 CredentialStore.modify 锁内调用（见 refreshToken 注释）
	refresh: async (credential, signal) => {
		const token = await refreshToken(getOauthHost(), credential.refresh, signal);
		return { type: "oauth", access: token.access, refresh: token.refresh, expires: token.expires };
	},

	// 凭据 → 请求认证：access token 放入 Authorization Bearer 头
	async toAuth(credential) {
		return { headers: { Authorization: `Bearer ${credential.access}` } };
	},
};
