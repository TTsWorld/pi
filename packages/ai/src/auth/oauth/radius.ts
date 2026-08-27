/**
 * @file Radius 网关 OAuth 登录流程（auth/oauth/radius.ts）
 * @description
 * Radius 是 pi 自有的 LLM 网关（对外提供 pi-messages 协议）。本文件实现接入
 * Radius 网关的 OAuthAuth 三段式（接口契约见 ../types.ts）：
 * - login：由用户在「浏览器授权（授权码 + PKCE）」与「设备码授权（RFC 8628）」
 *   两种方式中选一种完成登录
 * - refresh：用 refresh_token 向网关换取新凭据（由 Models 在凭据存储锁内调用）
 * - toAuth：把 access_token 映射为请求所用的 Bearer 风格认证
 *
 * OAuth 的客户端 API（发现、token、设备码）都位于所配置的网关上；只有交互式
 * 浏览器授权端点需要通过发现接口获取。模型目录的加载由 Radius provider
 * 负责，不在本文件职责内。
 *
 * 注意：本模块使用 node:http 承载 OAuth 回调服务器，
 * 仅面向 CLI（Node.js）环境使用，不适用于浏览器环境。
 */

// 绝不能改成顶层 import —— node:http 的顶层引入会破坏浏览器/Vite 构建，
// 因此惰性加载：仅在 Node.js / Bun 运行时中才异步引入该模块
let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	// 异步加载完成后写入模块引用；回调服务器启动时会检查其是否就绪
	import("node:http").then((m) => {
		_http = m;
	});
}

import { normalizeRadiusGatewayUrl } from "../../providers/radius-config.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

// ========== OAuth 回调服务器与协议常量 ==========

// 回调服务器监听的宿主：固定绑定本机回环地址，不对外暴露
const CALLBACK_HOST = "127.0.0.1";
// 回调服务器监听的固定端口（pi 约定端口，需与授权端注册的重定向 URI 一致）
const CALLBACK_PORT = 1456;
// 回调路径：用户在浏览器完成授权后，授权服务器重定向到该路径并携带 code/state
const CALLBACK_PATH = "/oauth/callback";
// 完整重定向 URI：发起授权请求与后续兑换 token 时都要原样带回
const REDIRECT_URI = `http://${CALLBACK_HOST}:${CALLBACK_PORT}${CALLBACK_PATH}`;
// token 有效期的提前量（毫秒）：在真实到期前 60 秒就把凭据视为过期，
// 避免把临期 token 发给网关后在请求途中恰好失效
const TOKEN_EXPIRY_SKEW_MS = 60_000;
// 登录方式选择器的选项 id：浏览器授权（推荐路径）
const LOGIN_METHOD_BROWSER = "browser";
// 登录方式选择器的选项 id：设备码授权（适合在另一台设备上完成登录）
const LOGIN_METHOD_DEVICE_CODE = "device-code";
// OAuth client_id：Radius 网关为 pi 预先注册的公共客户端标识
const OAUTH_CLIENT_ID = "pi-gateway";
// 申请的 OAuth scope：gateway（网关访问权限）+ offline_access（换取 refresh token，
// 使 access token 过期后可以无感刷新）
const OAUTH_SCOPE = "gateway offline_access";
// 设备码授权的 grant_type：RFC 8628 规定的 URN 形式（不是普通字符串 "device_code"）
const OAUTH_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Radius OAuth 发现文档（GET /v1/oauth）。
 * 其余端点（token、设备码）都在网关的固定路径上，无需通过发现获取，
 * 因此发现结果只需要 authorizationEndpoint 一个字段。
 */
type RadiusOAuthDiscovery = {
	/** 交互式浏览器授权端点的完整 URL */
	authorizationEndpoint: string;
};

/** 设备码授权响应（POST /v1/oauth/device，RFC 8628 第 3.2 节）。 */
type DeviceAuthorizationResponse = {
	/** 设备码：轮询 token 端点时携带的凭据，仅在本组流程内有效 */
	device_code: string;
	/** 用户码：用户在验证页上手动输入的短码 */
	user_code: string;
	/** 验证页地址：用户在此输入 user_code 完成授权 */
	verification_uri: string;
	/** 整组设备码的有效期（秒） */
	expires_in: number;
	/** 服务端建议的轮询间隔（秒）；缺省时轮询实现按 RFC 8628 缺省为 5 秒 */
	interval?: number;
};

/**
 * 加载 Radius OAuth 发现配置。
 *
 * 只有交互式浏览器授权端点是网关侧可配置的，所以登录走浏览器流程前
 * 必须先调用本函数拿到该端点。
 *
 * @param gateway 规范化后的网关基地址
 * @param signal 中止信号
 * @returns 仅包含授权端点 URL 的发现结果
 */
async function loadRadiusOAuthDiscovery(gateway: string, signal: AbortSignal): Promise<RadiusOAuthDiscovery> {
	const response = await fetch(new URL("/v1/oauth", gateway), {
		headers: { accept: "application/json" },
		signal,
	});

	// 发现接口请求失败：说明网关地址有误或网关未开启 OAuth，带上状态码与响应体报错
	if (!response.ok) {
		throw new Error(
			`Could not load Radius OAuth config from ${gateway}: ${response.status} ${await response.text()}`,
		);
	}

	// 只挑出并校验真正用到的字段：authorizationEndpoint 不是字符串则视为非法配置
	const discovery = (await response.json()) as Partial<RadiusOAuthDiscovery>;
	if (typeof discovery.authorizationEndpoint !== "string") {
		throw new Error(`Invalid Radius OAuth config from ${gateway}`);
	}
	return { authorizationEndpoint: discovery.authorizationEndpoint };
}

/**
 * OAuth 端点返回非 2xx 时抛出的错误类型。
 *
 * 在普通 Error 之外保留 HTTP 状态码与 OAuth 标准错误码（响应体的 error
 * 字段，如 authorization_pending、invalid_grant），供设备码轮询等调用方
 * 按错误码分支处理；错误消息则拼入错误码与描述，便于直接展示给用户。
 */
class OAuthResponseError extends Error {
	/** HTTP 状态码 */
	readonly status: number;
	/** OAuth 标准错误码（响应体 error 字段）；响应不是标准 OAuth 错误形态时可能缺失 */
	readonly oauthError?: string;

	constructor(status: number, oauthError: string | undefined, description: string | undefined, message: string) {
		// 按可用信息组织错误详情：优先「错误码: 描述」，其次仅错误码或仅描述，
		// 都没有时退化为裸状态码
		const detail = oauthError
			? description
				? `${oauthError}: ${description}`
				: oauthError
			: description || String(status);
		super(`${message}: ${detail}`);
		this.status = status;
		this.oauthError = oauthError;
	}
}

/**
 * 把 OAuth 端点的失败响应解析为 OAuthResponseError。
 *
 * 尽力提取 OAuth 标准的 error / error_description 字段；响应体不是 JSON
 * （例如网关返回纯文本/HTML 错误页）时退化为把整段文本当描述，
 * 保证调用方拿到的错误信息尽量可读。
 *
 * @param response 失败的 fetch Response
 * @param message 错误消息前缀（标明是哪一步请求失败）
 * @returns 组装好的 OAuthResponseError
 */
async function readOAuthResponseError(response: Response, message: string): Promise<OAuthResponseError> {
	// 读响应体失败（连接中断等）按空文本处理，不掩盖原始错误
	const text = await response.text().catch(() => "");
	let oauthError: string | undefined;
	let description: string | undefined;

	if (text) {
		try {
			// 标准 OAuth 错误响应形如 { error, error_description }；仅当字段确为字符串时采纳
			const data = JSON.parse(text) as { error?: unknown; error_description?: unknown };
			oauthError = typeof data.error === "string" ? data.error : undefined;
			description = typeof data.error_description === "string" ? data.error_description : undefined;
		} catch {
			// 响应体不是合法 JSON：整段文本作为错误描述
			description = text;
		}
	}

	return new OAuthResponseError(response.status, oauthError, description, message);
}

/**
 * 向网关 token 端点（POST /v1/oauth/token）发起请求并换取 OAuth 凭据。
 *
 * 三种 grant 共用本函数：浏览器授权码（authorization_code）、刷新
 * （refresh_token）、设备码（RFC 8628 的 URN grant），差异全部由调用方
 * 组装的表单参数体现。
 *
 * @param gateway 规范化后的网关基地址
 * @param body 组装好的表单参数（grant_type、client_id 等）
 * @param signal 中止信号
 * @returns 标准化的 OAuthCredential（expires 已扣除时钟提前量）
 */
async function requestOAuthToken(
	gateway: string,
	body: URLSearchParams,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let response: Response;
	try {
		response = await fetch(new URL("/v1/oauth/token", gateway), {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body,
			signal,
		});
	} catch (error) {
		// fetch 抛错且中止信号已触发：按「用户取消登录」处理，而不是网络故障
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	// 非 2xx：统一解析为携带 OAuth 错误码的 OAuthResponseError
	if (!response.ok) {
		throw await readOAuthResponseError(response, "Radius OAuth token request failed");
	}

	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
		scope?: string;
	};

	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token,
		// 折算 epoch 毫秒过期时间，并提前 TOKEN_EXPIRY_SKEW_MS 视为过期，
		// 避免临期 token 在发往网关的请求途中恰好失效
		expires: Date.now() + data.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
		scope: data.scope,
	};
}

/** 本地 OAuth 回调服务器的句柄。 */
type OAuthCallbackServer = {
	/** 等待授权码：拿到 code 时 resolve；流程取消或回调失败时 resolve null */
	waitForCode(): Promise<string | null>;
	/** 结束等待并关闭服务器；可在 finally 中安全调用（幂等） */
	close(): void;
};

/**
 * 在本机启动一次性的 OAuth 回调 HTTP 服务器。
 *
 * 监听 REDIRECT_URI（127.0.0.1:1456/oauth/callback），接收授权服务器在
 * 用户完成授权后发起的重定向，经 state 校验与错误分支处理后取出授权码。
 * 整条等待链路同时受外部 AbortSignal 控制：信号触发即按「未拿到授权码」收尾。
 *
 * @param expectedState 授权请求中发出的 state，用于防 CSRF / 过期回调校验
 * @param signal 登录流程的中止信号
 * @returns 服务器就绪后 resolve 的句柄；监听失败（如端口被占用）时
 *          resolve 一个「永远返回 null」的哑句柄，让上层按「回调未完成」报错
 */
function startOAuthCallbackServer(expectedState: string, signal: AbortSignal): Promise<OAuthCallbackServer> {
	// node:http 未就绪（浏览器环境或模块尚未加载完）：本登录方式不可用
	if (!_http) {
		throw new Error("Radius OAuth is only available in Node.js environments");
	}

	// ========== 一次性等待结果（settled 模式） ==========
	let settle: (code: string | null) => void = () => {};
	// 防止结果被重复落定（如 close 与某个回调同时触发时，只有第一次生效）
	let settled = false;
	const wait = new Promise<string | null>((resolve) => {
		settle = resolve;
	});
	// 落定等待结果：首个调用者胜出，并移除 abort 监听防止泄漏
	const finish = (code: string | null) => {
		if (settled) {
			return;
		}
		settled = true;
		signal.removeEventListener("abort", onAbort);
		settle(code);
	};
	// 外部取消登录：等价于「未拿到授权码」结束等待
	const onAbort = () => finish(null);
	signal.addEventListener("abort", onAbort, { once: true });

	// 统一的 HTML 回执 helper：保证状态码与 content-type 一致
	const sendPage = (response: import("node:http").ServerResponse, status: number, html: string) => {
		response.statusCode = status;
		response.setHeader("content-type", "text/html; charset=utf-8");
		response.end(html);
	};

	// ========== 回调路由处理 ==========
	// 以 REDIRECT_URI 为基准解析请求目标，保证 request.url 为相对路径时也能解析
	const server = _http.createServer((request, response) => {
		const url = new URL(request.url ?? "/", REDIRECT_URI);
		// 非回调路径（端口被扫描等）：直接 404，不影响等待
		if (url.pathname !== CALLBACK_PATH) {
			sendPage(response, 404, oauthErrorHtml("Callback route not found."));
			return;
		}
		// state 不匹配：可能是 CSRF 或过期回调，拒绝本次请求但继续等待合法回调
		if (url.searchParams.get("state") !== expectedState) {
			sendPage(response, 400, oauthErrorHtml("OAuth state mismatch."));
			return;
		}

		// 授权服务器显式返回错误（如用户拒绝授权）：展示错误并以失败结束等待
		const error = url.searchParams.get("error");
		if (error) {
			sendPage(response, 400, oauthErrorHtml(url.searchParams.get("error_description") ?? error));
			finish(null);
			return;
		}

		// 正常回调必须携带授权码；缺失则提示错误，但不结束等待（给后续合法回调机会）
		const code = url.searchParams.get("code");
		if (!code) {
			sendPage(response, 400, oauthErrorHtml("Missing authorization code."));
			return;
		}

		// 成功：回执成功页面（提示用户可关闭浏览器）并落定授权码
		sendPage(response, 200, oauthSuccessHtml("Signed in to Radius. You may now close this page."));
		finish(code);
	});

	// ========== 启动服务器并交付句柄 ==========
	return new Promise((resolve) => {
		server
			.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
				resolve({
					waitForCode: () => wait,
					close: () => {
						// 先落定等待（null）再关服务器，保证 close 之后 waitForCode 必然有结果
						finish(null);
						server.close();
					},
				});
			})
			.once("error", () => {
				// 监听失败（典型如端口被占用）：不抛出，交出等价于「未完成」的哑句柄
				finish(null);
				resolve({ waitForCode: async () => null, close: () => {} });
			});
	});
}

/**
 * 浏览器授权码流程（Authorization Code + PKCE）。
 *
 * 流程：生成 PKCE 与 state → 启动本地回调服务器 → 通过 notify 把授权 URL
 * 交给用户在浏览器中打开 → 等待回调拿到授权码 → 连同 code_verifier 一起
 * 向 token 端点兑换凭据。
 *
 * @param gateway 规范化后的网关基地址
 * @param authorizationEndpoint 发现接口返回的浏览器授权端点
 * @param interaction 登录交互回调（notify 推送 URL/进度，signal 取消流程）
 */
async function loginWithBrowser(
	gateway: string,
	authorizationEndpoint: string,
	interaction: ProviderAuthInteraction,
): Promise<OAuthCredential> {
	// PKCE：challenge 随授权请求发出，verifier 保存在本地、兑换 token 时才提交
	const { verifier, challenge } = await generatePKCE();
	// 随机 state：防 CSRF，授权服务器会在回调中原样带回、由回调服务器校验
	const state = crypto.randomUUID();
	const authorizeUrl = new URL(authorizationEndpoint);
	// 组装授权请求查询串：标准 OAuth 参数之外，handoff=url 是 Radius 特有参数，
	// 表示授权结果以重定向 URL 的方式交回客户端
	authorizeUrl.search = new URLSearchParams({
		response_type: "code",
		client_id: OAUTH_CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: OAUTH_SCOPE,
		code_challenge: challenge,
		code_challenge_method: "S256",
		handoff: "url",
		state,
	}).toString();

	// 先启动回调服务器再发出授权 URL，确保用户极快完成授权时回调也有服务在接
	const callbackServer = await startOAuthCallbackServer(state, interaction.signal);
	interaction.notify({ type: "progress", message: `Listening for OAuth callback on ${REDIRECT_URI}` });
	// 把授权 URL 交给 UI：用户在浏览器中完成账号登录与授权
	interaction.notify({
		type: "auth_url",
		url: authorizeUrl.toString(),
		instructions: "Continue in your browser.",
	});

	try {
		const code = await callbackServer.waitForCode();
		// 未拿到授权码：区分「用户取消」与「回调流程未完成」两种失败原因
		if (!code) {
			if (interaction.signal.aborted) {
				throw new Error("Login cancelled");
			}
			throw new Error("OAuth callback did not complete.");
		}
		// 用授权码 + PKCE verifier 兑换凭据（grant_type = authorization_code）
		return await requestOAuthToken(
			gateway,
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: OAUTH_CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				code,
				code_verifier: verifier,
			}),
			interaction.signal,
		);
	} finally {
		// 无论成败都关闭回调服务器，释放端口
		callbackServer.close();
	}
}

/**
 * 向网关申请设备码（POST /v1/oauth/device，RFC 8628 设备授权流程第一步）。
 *
 * @param gateway 规范化后的网关基地址
 * @param signal 中止信号
 * @returns 设备码、用户码、验证页地址与有效期等设备授权信息
 */
async function requestDeviceAuthorization(gateway: string, signal: AbortSignal): Promise<DeviceAuthorizationResponse> {
	let response: Response;
	try {
		response = await fetch(new URL("/v1/oauth/device", gateway), {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }),
			signal,
		});
	} catch (error) {
		// 与 token 请求相同：中止信号已触发时按「取消登录」而非网络错误处理
		if (signal.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}

	// 非 2xx：统一解析为携带 OAuth 错误码的 OAuthResponseError
	if (!response.ok) {
		throw await readOAuthResponseError(response, "Radius OAuth device authorization failed");
	}

	// 校验后续轮询必需的字段：缺任何一项都无法继续设备码流程
	const data = (await response.json()) as Partial<DeviceAuthorizationResponse>;
	if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in) {
		throw new Error("Radius OAuth device authorization response is missing required fields");
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		expires_in: data.expires_in,
		interval: data.interval,
	};
}

/**
 * 设备码授权流程（RFC 8628）。
 *
 * 流程：申请设备码 → 通过 notify 把用户码与验证页地址交给用户（适合在
 * 另一台设备上完成授权）→ 复用共享轮询循环按服务端指示的间隔反复尝试
 * 兑换 token，直到用户完成/拒绝授权或设备码过期。
 *
 * @param gateway 规范化后的网关基地址
 * @param interaction 登录交互回调（notify 推送设备码信息，signal 取消流程）
 */
async function loginWithDeviceCode(gateway: string, interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const device = await requestDeviceAuthorization(gateway, interaction.signal);
	// 把设备码信息交给 UI 展示：用户在验证页输入 user_code 完成授权后，轮询才会成功
	interaction.notify({
		type: "device_code",
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	// 轮询节奏、取消与超时由共享的 pollOAuthDeviceCodeFlow 管理（见 device-code.ts），
	// 这里只提供「单次轮询」的 Radius 特定逻辑
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		signal: interaction.signal,
		poll: async () => {
			try {
				// 尝试用设备码兑换凭据；成功即整个流程完成
				const credentials = await requestOAuthToken(
					gateway,
					new URLSearchParams({
						grant_type: OAUTH_DEVICE_CODE_GRANT_TYPE,
						client_id: OAUTH_CLIENT_ID,
						device_code: device.device_code,
					}),
					interaction.signal,
				);
				return { status: "complete", value: credentials };
			} catch (error) {
				// 非 OAuth 形态的错误（网络故障等）直接上抛，终止轮询
				if (!(error instanceof OAuthResponseError)) {
					throw error;
				}
				// 把 OAuth 标准错误码映射为轮询循环可理解的状态
				switch (error.oauthError) {
					// 用户尚未完成授权：继续按当前间隔轮询
					case "authorization_pending":
						return { status: "pending" };
					// 轮询过快：轮询循环会自动放慢间隔
					case "slow_down":
						return { status: "slow_down" };
					// 设备码已过期：流程失败，需重新发起
					case "expired_token":
						return { status: "failed", message: "Device authorization expired." };
					// 用户（或授权策略）拒绝了本次授权：流程失败
					case "access_denied":
						return { status: "failed", message: "Device authorization was denied." };
					// 其余错误码（如 invalid_grant）无法恢复，原样上抛
					default:
						throw error;
				}
			}
		},
	});
}

/** createRadiusOAuth 的配置项。 */
export interface RadiusOAuthOptions {
	/** 认证方式的展示名（通常即 provider 名，用于登录提示文案） */
	name: string;
	/** 用户配置的网关地址；进入工厂后立即规范化（补协议、去尾部斜杠） */
	gateway: string;
}

/**
 * 创建 Radius 网关的 OAuthAuth 实现（三段式）。
 *
 * - login：先让用户在浏览器授权与设备码授权之间选择，再分发到对应流程
 * - refresh：用已存的 refresh_token 兑换全新凭据组；由 Models 在
 *   CredentialStore.modify 的锁内调用，防止并发双重刷新
 * - toAuth：access_token 直接作为请求的 apiKey（Bearer）使用
 */
export function createRadiusOAuth(options: RadiusOAuthOptions): OAuthAuth {
	// 规范化网关地址：无协议时补 https://，并去掉尾部斜杠；
	// 之后所有 OAuth 端点都基于该基地址拼接
	const gateway = normalizeRadiusGatewayUrl(options.gateway);

	return {
		name: options.name,

		async login(interaction): Promise<OAuthCredential> {
			// 登录方式选择：浏览器授权（推荐）或设备码授权
			const loginMethod = await interaction.prompt({
				type: "select",
				message: `Sign in to ${options.name}:`,
				options: [
					{ id: LOGIN_METHOD_BROWSER, label: "Sign in with browser (recommended)" },
					{
						id: LOGIN_METHOD_DEVICE_CODE,
						label: "Sign in with device code (when signing in from another device)",
					},
				],
			});

			// 按所选方式分发到对应的登录流程
			if (loginMethod === LOGIN_METHOD_DEVICE_CODE) {
				return loginWithDeviceCode(gateway, interaction);
			}
			if (loginMethod === LOGIN_METHOD_BROWSER) {
				// 浏览器流程的授权端点是网关侧可配置项，需先通过发现接口获取
				const discovery = await loadRadiusOAuthDiscovery(gateway, interaction.signal);
				return loginWithBrowser(gateway, discovery.authorizationEndpoint, interaction);
			}
			// prompt 返回未知选项（正常流程不应发生，多为交互层异常）：直接报错
			throw new Error(`Unknown ${options.name} sign-in method: ${loginMethod}`);
		},

		async refresh(credential, signal): Promise<OAuthCredential> {
			// 用存储的 refresh_token 兑换新的凭据组（含新下发的 refresh_token）；
			// 失败时抛错（如 invalid_grant），由上层决定是否重新登录
			const refreshed = await requestOAuthToken(
				gateway,
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: OAUTH_CLIENT_ID,
					refresh_token: credential.refresh,
				}),
				signal,
			);
			return refreshed;
		},

		async toAuth(credential) {
			// Radius 的 access_token 直接作为请求认证的 apiKey（Bearer）使用
			return { apiKey: credential.access };
		},
	};
}
