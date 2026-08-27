/**
 * @file xAI（Grok / X 订阅）OAuth 设备码授权流程
 * @description
 * 实现 OAuthAuth 三段式（类型见 auth/types.ts），用于 SuperGrok /
 * X Premium 订阅账号登录：
 * - login：申请设备码（RFC 8628），通过 notify 把用户码与验证页地址
 *   推给 UI，复用共享的 device-code.ts 轮询循环等待授权完成
 * - refresh：用 refresh_token 调 token 端点换取新凭据（由上层在
 *   CredentialStore.modify 锁内调用，防止并发双重刷新）
 * - toAuth：把凭据中的 access token 映射为请求认证（apiKey 形式）
 */

import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

// xAI 为 pi 客户端预注册的 OAuth client_id（公共客户端，设备码流无需 client_secret）
const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
// 申请的权限范围：openid / profile / email 提供身份信息；offline_access
// 保证下发 refresh_token；grok-cli:access 与 api:access 授予 CLI 与 API 的订阅访问
const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
// 设备授权端点（RFC 8628 device authorization endpoint）：申请 device_code / user_code
const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
// token 端点：设备码轮询换 token 与 refresh_token 刷新都走这里
const XAI_TOKEN_URL = "https://auth.x.ai/oauth2/token";
// 相比名义过期时间提前刷新（5 分钟），避免使用一个在请求途中就会失效的 token
const REFRESH_SKEW_MS = 5 * 60 * 1000;
// xAI 未返回 expires_in 时假定的 access token 有效期（1 小时）
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** 任意 JSON 对象（从 OAuth 端点响应解析而来）。 */
type JsonObject = Record<string, unknown>;

/** 对 OAuth 端点一次 POST 的规整结果：HTTP 是否成功、状态码与已解析的 JSON body。 */
type OAuthHttpResponse = {
	// HTTP 层是否成功（2xx）
	ok: boolean;
	// HTTP 状态码
	status: number;
	// 已解析的 JSON 响应体
	body: JsonObject;
};

/** 设备授权端点的响应（RFC 8628 device authorization response），驱动后续轮询。 */
type XaiDeviceCode = {
	// 轮询 token 端点时提交的设备码
	deviceCode: string;
	// 用户在验证页手工输入的短码
	userCode: string;
	// 验证页地址（在用户浏览器中打开）
	verificationUri: string;
	// 已预填 user_code 的验证页地址，存在时优先展示，免去用户手工输入
	verificationUriComplete?: string;
	// 服务端建议的轮询间隔（秒）；缺省时由共享轮询器按 RFC 8628 取 5 秒
	intervalSeconds?: number;
	// 设备码整体有效期（秒），超时仍未授权则流程失败
	expiresInSeconds: number;
};

/**
 * 取出必填的非空字符串字段。
 * 缺失、非字符串或空串时抛出带字段名的错误，用于快速暴露畸形响应。
 */
function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

/**
 * 取出必填的正有限数字字段。
 * 缺失、非数字、非有限或非正数时抛出带字段名的错误。
 */
function positiveNumber(body: JsonObject, field: string): number {
	const value = body[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid xAI OAuth response field: ${field}`);
	}
	return value;
}

/**
 * 校验并规范化验证页地址。
 * 验证 URI 会在用户浏览器中打开，因此强制要求 https：
 * 防止被篡改的响应诱导 `open` 打开其他协议的地址或本地程序。
 */
function validateVerificationUri(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		// 无法解析为合法 URL
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	// 非 https 协议（如 file: / http:）一律拒绝
	if (url.protocol !== "https:") {
		throw new Error("Untrusted verification URI in xAI OAuth response");
	}
	return url.href;
}

/**
 * 以表单形式（application/x-www-form-urlencoded）POST 到 OAuth 端点，
 * 并把响应规整为 OAuthHttpResponse。
 * 网络错误与「响应体不是 JSON」各自统一抛错，且都会先检查取消信号，
 * 把用户取消（Login cancelled）与真实故障区分开。
 */
async function postForm(url: string, fields: Record<string, string>, signal: AbortSignal): Promise<OAuthHttpResponse> {
	// ========== 发起 POST 请求 ==========
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams(fields),
			signal,
		});
	} catch (error) {
		// fetch 因取消而 reject 时，转成语义清晰的「Login cancelled」
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	// ========== 解析响应体 ==========
	// 非 JSON 或 JSON 不是对象（数组/原始值）时降级为空对象，
	// 让后续的必填字段校验给出更准确的错误信息
	let body: JsonObject;
	try {
		const parsed = (await response.json()) as unknown;
		body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
	} catch {
		// json() 解析失败同样先区分取消与真实坏响应
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw new Error(`xAI OAuth returned invalid JSON (HTTP ${response.status})`);
	}
	return {
		ok: response.ok,
		status: response.status,
		body,
	};
}

/**
 * 把失败的 OAuth 响应转换为用户可读的 Error。
 * 尽量附带 body 中的 error / error_description 明细（OAuth 标准错误字段）。
 */
function requestFailure(action: string, response: OAuthHttpResponse): Error {
	const error = typeof response.body.error === "string" ? response.body.error : undefined;
	const description =
		typeof response.body.error_description === "string" ? response.body.error_description : undefined;
	const detail = [error, description].filter(Boolean).join(": ");
	return new Error(`xAI OAuth ${action} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

/**
 * 解析设备授权响应为 XaiDeviceCode。
 * device_code / user_code / verification_uri / expires_in 严格校验；
 * interval 与 verification_uri_complete 属于可选增强，宽容处理。
 */
function parseDeviceCode(body: JsonObject): XaiDeviceCode {
	// RFC 8628 允许 interval 为 0（不设最小等待间隔）；对非正数或畸形值
	// 不做硬失败，而是回退到共享轮询器的默认间隔
	const interval = body.interval;
	const intervalSeconds =
		typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : undefined;
	// 可选的预填地址存在时，同样必须通过 https 校验
	const verificationUriComplete =
		typeof body.verification_uri_complete === "string" && body.verification_uri_complete.length > 0
			? validateVerificationUri(body.verification_uri_complete)
			: undefined;
	return {
		deviceCode: requiredString(body, "device_code"),
		userCode: requiredString(body, "user_code"),
		verificationUri: validateVerificationUri(requiredString(body, "verification_uri")),
		verificationUriComplete,
		intervalSeconds,
		expiresInSeconds: positiveNumber(body, "expires_in"),
	};
}

/**
 * 把 token 端点响应转换为可存储的 OAuthCredential。
 * 过期时间 = 当前时间 + expires_in - 提前刷新量（REFRESH_SKEW_MS），
 * 让上层在 token 真正失效前就触发刷新。
 */
function credentialsFromTokenResponse(body: JsonObject, previousRefreshToken?: string): OAuthCredential {
	const access = requiredString(body, "access_token");
	// xAI 在刷新且未轮换 refresh_token 时可能省略 refresh_token 字段，
	// 此时沿用传入的旧值（登录场景则必填）
	const refresh =
		body.refresh_token === undefined && previousRefreshToken
			? previousRefreshToken
			: requiredString(body, "refresh_token");
	// expires_in 缺失时按默认 1 小时估算，避免因缺字段而丢弃有效 token
	const expiresInSeconds =
		body.expires_in === undefined ? DEFAULT_TOKEN_LIFETIME_SECONDS : positiveNumber(body, "expires_in");
	return {
		type: "oauth",
		access,
		refresh,
		// 提前 REFRESH_SKEW_MS 计入过期，见函数头说明
		expires: Date.now() + expiresInSeconds * 1000 - REFRESH_SKEW_MS,
	};
}

/**
 * 发起设备授权请求：向设备码端点提交 client_id / scope / referrer，
 * 成功时解析出 XaiDeviceCode。
 */
async function requestDeviceCode(signal: AbortSignal): Promise<XaiDeviceCode> {
	const response = await postForm(
		XAI_DEVICE_CODE_URL,
		{
			client_id: XAI_CLIENT_ID,
			scope: XAI_SCOPE,
			// 标识请求来源为 pi 客户端
			referrer: "pi",
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("device authorization", response);
	}
	return parseDeviceCode(response.body);
}

/**
 * 轮询 token 端点直到用户完成授权或流程失败。
 * 通用循环逻辑（间隔控制、slow_down 退避、超时、取消）由共享的
 * pollOAuthDeviceCodeFlow 提供，这里只负责把 xAI 的响应映射为轮询结果状态。
 */
async function pollForTokens(device: XaiDeviceCode, signal: AbortSignal): Promise<OAuthCredential> {
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		// 用户此刻多半还没打开验证页，立即首询必然 pending；先等一个间隔再开始
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postForm(
				XAI_TOKEN_URL,
				{
					// RFC 8628 设备码授权的 grant_type 固定 URI
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
					client_id: XAI_CLIENT_ID,
					device_code: device.deviceCode,
				},
				signal,
			);

			// ========== 响应 → 轮询状态映射 ==========
			if (response.ok) {
				return { status: "complete", value: credentialsFromTokenResponse(response.body) };
			}

			// 以下按 RFC 8628 第 3.5 节的错误码分支处理
			const error = response.body.error;
			// 用户尚未完成授权：继续按当前间隔轮询
			if (error === "authorization_pending") {
				return { status: "pending" };
			}
			// 轮询过快：上报给共享循环放大间隔，优先采用服务端返回的新 interval
			if (error === "slow_down") {
				const interval = response.body.interval;
				return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
			}
			// 用户拒绝授权（xAI 两种拼写都兼容）：不可恢复，直接失败
			if (error === "access_denied" || error === "authorization_denied") {
				return { status: "failed", message: "xAI device authorization was denied" };
			}
			// 设备码已过期：只能重新发起登录
			if (error === "expired_token") {
				return { status: "failed", message: "xAI device code expired" };
			}
			// 其余错误（如 invalid_grant）统一包装为失败
			return { status: "failed", message: requestFailure("device token polling", response).message };
		},
	});
}

/**
 * OAuthAuth.login 实现：申请设备码 → 通知 UI 展示用户码与验证页 →
 * 轮询等待用户在浏览器完成授权，产出可存储的凭据。
 */
async function loginXai(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// ========== 第一步：申请设备码 ==========
	const device = await requestDeviceCode(interaction.signal);

	// ========== 第二步：推送 device_code 事件给 UI ==========
	// 优先使用已预填 user_code 的地址，用户打开后无需手工输入
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});

	// ========== 第三步：轮询等待授权完成 ==========
	return pollForTokens(device, interaction.signal);
}

/**
 * OAuthAuth.refresh 实现：用 refresh_token 向 token 端点换取新凭据。
 * 由上层在 CredentialStore.modify 的存储锁内调用，避免并发请求对已
 * 轮换的 token 双重刷新；失败（如 invalid_grant）直接抛错。
 */
async function refreshXaiToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	const response = await postForm(
		XAI_TOKEN_URL,
		{
			grant_type: "refresh_token",
			client_id: XAI_CLIENT_ID,
			refresh_token: refreshToken,
		},
		signal,
	);
	if (!response.ok) {
		throw requestFailure("token refresh", response);
	}
	return credentialsFromTokenResponse(response.body, refreshToken);
}

/**
 * xAI（Grok / X 订阅）的 OAuthAuth 实现，注册给 provider 使用。
 * 访问由 SuperGrok / X Premium 订阅支撑，而非按量计费的 API key。
 */
export const xaiOAuth: OAuthAuth = {
	// 登录方式列表中的展示名
	name: "xAI (Grok/X subscription)",
	// 访问由 provider 订阅支撑（订阅型 OAuth）
	isSubscription: true,
	// OAuth 登录选项的选择器标签
	loginLabel: "Sign in with SuperGrok or X Premium",
	login: loginXai,
	// 刷新时传入存储凭据中的 refresh_token
	refresh: (credential, signal) => refreshXaiToken(credential.refresh, signal),

	async toAuth(credential) {
		// access token 以 apiKey 形式输出，由 provider 按其约定写入请求头
		return { apiKey: credential.access };
	},
};
