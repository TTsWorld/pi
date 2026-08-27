/**
 * @file OpenAI Codex OAuth 登录流程（ChatGPT Plus/Pro 订阅授权）
 * @description
 * 实现 OAuthAuth 三段式接口（login / refresh / toAuth，类型见 ../types.ts），
 * 让用户以 ChatGPT 订阅账号（Plus/Pro）授权，代替 API key 访问 Codex 后端：
 * - login：两种方式二选一——
 *   1) 浏览器登录（默认）：PKCE 授权码流程，本地 1455 端口起回调服务器
 *      接收授权码；回调不可用时降级为手工粘贴授权码/回调 URL；
 *   2) 设备码登录（无头环境）：用户在另一设备访问验证页输入 user_code，
 *      授权完成后服务端连同 code_verifier 一并返回，再走标准 token 兑换
 * - refresh：access token 过期后用 refresh token 换取新凭据
 *   （由调用方保证在 CredentialStore.modify 锁内执行）
 * - toAuth：把 access token 映射为请求认证（apiKey 字段）；请求所需的
 *   chatgpt-account-id 等头由 API 层直接从 access token JWT 重新解析
 *   （见 api/openai-codex-responses.ts），凭据里存的 accountId 主要用于
 *   登录/刷新时的校验与身份展示
 *
 * 注意：本模块用 Node.js 的 crypto（生成 state）与 http（本地回调服务器），
 * 仅面向 CLI 场景，不能在浏览器环境中使用。
 */

// 绝对不要改成顶层静态 import——会破坏浏览器/Vite 构建
// 通过动态 import 惰性加载 Node 专用模块：包可能被打进浏览器 bundle，
// 顶层静态引入 node:crypto / node:http 会让打包直接失败；这里只在检测到
// Node/Bun 运行时才异步加载，浏览器环境保持 null，使用时抛出明确错误
let _randomBytes: typeof import("node:crypto").randomBytes | null = null;
let _http: typeof import("node:http") | null = null;
// 存在 Node/Bun 运行时标记时才并行发起两个动态导入
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:crypto").then((m) => {
		_randomBytes = m.randomBytes;
	});
	import("node:http").then((m) => {
		_http = m;
	});
}

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

// ========== OpenAI Codex OAuth 端点与客户端常量 ==========

// OAuth client id：复用 OpenAI Codex CLI 在 auth.openai.com 注册的客户端，
// 因此回调端口等参数必须与其注册信息保持一致
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// OpenAI 统一认证服务器（ChatGPT 账号体系）的基地址，
// 浏览器登录与设备码登录的所有端点都由它派生
const AUTH_BASE_URL = "https://auth.openai.com";

// 授权端点：用户在此页面登录 ChatGPT 并批准授权，随后带 code 重定向回回调地址
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;

// token 端点：授权码换 token（login）与 refresh token 换新 token（refresh）共用
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;

// 浏览器登录的本地回调地址：端口 1455 与路径必须和 client 注册信息一致，
// 不能随意改动，否则授权服务器会拒绝该 redirect_uri
const REDIRECT_URI = "http://localhost:1455/auth/callback";

// 设备码流程：申请 user_code 的端点（非 RFC 8628 标准路径，OpenAI 私有实现）
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;

// 设备码流程：轮询授权结果、换取授权码与 code_verifier 的端点
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;

// 设备码流程：用户在浏览器中打开、输入 user_code 完成授权的验证页
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;

// 设备码流程兑换 token 时使用的 redirect_uri：指向 OpenAI 自己的回调页，
// 与浏览器登录的本地回调不同（设备码场景本机没有回调服务器）
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;

// 设备码有效期：15 分钟内未完成授权即超时
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;

// 登录方式选择器返回的 id：浏览器登录（默认）
const OPENAI_CODEX_BROWSER_LOGIN_METHOD = "browser";

// 登录方式选择器返回的 id：设备码登录（无头环境）
const OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD = "device_code";

// 申请的权限范围：OIDC 标准 scope（身份/资料/邮箱）加 offline_access
// （换取 refresh token，保证 access 过期后可无感续期）
const SCOPE = "openid profile email offline_access";

// access token（JWT）payload 里的命名空间化声明路径：
// chatgpt_account_id（ChatGPT 账号 id）就挂在它下面，
// 登录与刷新时都要从这里提取账号标识
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

/** 规范化后的 token 三元组：access/refresh 令牌本体 + access 过期时刻（epoch 毫秒）。 */
type OAuthToken = { access: string; refresh: string; expires: number };

/** token 端点操作类型（兑换授权码 / 刷新），仅用于拼装错误信息文案。 */
type TokenOperation = "exchange" | "refresh";

/**
 * 读取本地回调服务器要绑定的监听地址。
 * 默认 127.0.0.1（仅本机回环）；可用环境变量 PI_OAUTH_CALLBACK_HOST 覆盖
 * （例如 localhost 解析到 IPv6 导致回调打不进来时显式指定地址）。
 */
function getCallbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

/** 设备码流程发起结果：设备授权 id、用户要输入的 user_code、服务端建议的轮询间隔（秒）。 */
type DeviceAuthInfo = {
	deviceAuthId: string;
	userCode: string;
	intervalSeconds: number;
};

/**
 * 设备码轮询成功的结果。注意 code_verifier 由服务端在授权完成时返回——
 * 该流程中 PKCE verifier 由 OpenAI 服务端保管（发起时客户端不上送
 * challenge），兑换 token 时客户端再提交它做标准 PKCE 校验。
 */
type DeviceTokenSuccess = {
	authorizationCode: string;
	codeVerifier: string;
};

/** access token（JWT）的 payload 结构；OpenAI 专有声明挂在命名空间键下。 */
type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

/**
 * 生成随机 state（16 字节的十六进制串）。
 * 用于关联「发出的授权请求」与「收到的回调」：回调必须原样带回 state，
 * 不匹配即拒绝，防止 CSRF / 授权码注入。
 */
function createState(): string {
	// 动态导入未完成或浏览器环境（拿不到 Node crypto）时明确报错
	if (!_randomBytes) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}
	return _randomBytes(16).toString("hex");
}

/**
 * 解析用户手工粘贴的授权输入。
 * 浏览器可能在另一台机器/远程环境里打不开 localhost 回调，此时用户只能把
 * 最终重定向结果（或其中的 code）复制回来；本函数兼容四种输入形态：
 * 1. 完整回调 URL（http://localhost:1455/auth/callback?code=...&state=...）
 * 2. "code#state" 组合串
 * 3. 形如 "code=...&state=..." 的查询串
 * 4. 裸授权码
 */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	// 形态 1：完整 URL，直接读取 query 参数
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// 不是 URL，继续尝试下面的形态
	}

	// 形态 2：code#state（# 后面是 state）
	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	// 形态 3：查询串形式
	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	// 形态 4：整串就是裸授权码
	return { code: value };
}

/**
 * 解码 JWT 的 payload 段并解析为对象（不校验签名）。
 * 这里只为本地读取声明（chatgpt_account_id），令牌真伪由 OpenAI 服务端
 * 把关，客户端无需持有验签公钥；解析失败一律返回 null 由调用方兜底。
 */
function decodeJwt(token: string): JwtPayload | null {
	try {
		// JWT 形如 header.payload.signature，不是三段就不是合法 JWT
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		// 取中段 payload 做 base64 解码，再按 JSON 解析
		const payload = parts[1] ?? "";
		const decoded = atob(payload);
		return JSON.parse(decoded) as JwtPayload;
	} catch {
		// 任一步失败（非法 base64 / JSON）都视为无法解析
		return null;
	}
}

/**
 * 带登录取消语义的 fetch 包装。
 * 登录被 AbortSignal 中断时原生 fetch 抛的是无差别的 AbortError，这里统一
 * 改写成 "Login cancelled"——这是本 SDK 各 OAuth 流约定的「用户主动取消」
 * 错误消息，让上层能与真实网络故障区分；其余错误原样抛出。
 */
async function fetchWithLoginCancellation(input: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (error) {
		// 请求失败且信号已中止：判定为用户取消
		if (init.signal?.aborted) {
			throw new Error("Login cancelled");
		}
		throw error;
	}
}

/**
 * 读取并校验 token 端点响应，规范化为 OAuthToken。
 * 非 2xx 时抛出带状态码与响应体文本的错误；JSON 缺少必要字段
 * （access_token / refresh_token / expires_in 任一缺失或类型不符）同样抛错
 * ——OAuthToken 必须三件齐全，缺 refresh_token 的凭据将无法续期。
 * @param response token 端点的 Response 对象
 * @param operation 当前操作（exchange / refresh），仅用于拼装错误文案
 */
async function readTokenResponse(response: Response, operation: TokenOperation): Promise<OAuthToken> {
	// ========== 错误分支：HTTP 层失败 ==========
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`OpenAI Codex token ${operation} failed (${response.status}): ${text || response.statusText}`);
	}

	// ========== 解析 JSON 并做字段校验 ==========
	const rawJson = await response.json();
	const json = rawJson as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	} | null;
	if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error(`OpenAI Codex token ${operation} response missing fields: ${JSON.stringify(json)}`);
	}

	// expires_in 是相对秒数，换算为绝对过期时刻（epoch 毫秒）后落库
	return {
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

/**
 * 用授权码 + PKCE verifier 换取 token（授权码流程的 token 步骤）。
 * 浏览器登录与设备码登录最终都走到这里，仅 redirect_uri 不同。
 * @param code 授权码（来自本地回调或设备码轮询）
 * @param verifier PKCE code_verifier，服务端校验其摘要与授权请求中的 challenge 匹配
 * @param redirectUri 必须与授权请求中登记的一致（本地回调或 OpenAI 设备码回调页）
 * @param signal 登录取消信号
 */
async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthToken> {
	const response = await fetchWithLoginCancellation(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal,
	});

	return readTokenResponse(response, "exchange");
}

/**
 * 用 refresh token 换取新的 access token。
 * 只上送 grant_type / refresh_token / client_id（公开客户端，无 client_secret）；
 * 网络层异常统一包装为带原因的错误文本，与 HTTP 层错误区分开。
 */
async function refreshAccessToken(refreshToken: string, signal: AbortSignal): Promise<OAuthToken> {
	let response: Response;
	// 网络错误（断网 / DNS / 中止）单独捕获包装，附上原始原因
	try {
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
			signal,
		});
	} catch (error) {
		throw new Error(`OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`);
	}

	return readTokenResponse(response, "refresh");
}

/**
 * 发起设备码流程：向 usercode 端点申请 user_code。
 * 请求体只带 client_id，不涉及 PKCE（verifier 由服务端保管，见 DeviceTokenSuccess）。
 * @param signal 登录取消信号
 * @returns 设备授权 id、用户码与服务端建议的轮询间隔
 * @throws 404 表示该服务器未启用设备码登录（应改用浏览器登录）；
 * 响应字段缺失/非法时同样抛错
 */
async function startOpenAICodexDeviceAuth(signal: AbortSignal): Promise<DeviceAuthInfo> {
	const response = await fetchWithLoginCancellation(DEVICE_USER_CODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal,
	});

	// ========== 错误分支 ==========
	if (!response.ok) {
		// 404：服务端不支持设备码流程，提示改用浏览器登录或检查服务器地址
		if (response.status === 404) {
			throw new Error(
				"OpenAI Codex device code login is not enabled for this server. Use browser login or verify the server URL.",
			);
		}
		const responseBody = await response.text().catch(() => "");
		throw new Error(
			`OpenAI Codex device code request failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
		);
	}

	// ========== 解析响应并逐字段校验 ==========
	const rawJson = await response.json();
	const json = rawJson as {
		device_auth_id?: string;
		user_code?: string;
		interval?: number | string;
	} | null;
	// interval 可能以字符串形式返回（如 "5"），统一转成数字
	const intervalSeconds = typeof json?.interval === "string" ? Number(json.interval.trim()) : json?.interval;
	// id / 用户码缺失，或间隔非法（非有限数 / 负数）都拒绝
	if (
		!json?.device_auth_id ||
		!json.user_code ||
		typeof intervalSeconds !== "number" ||
		!Number.isFinite(intervalSeconds) ||
		intervalSeconds < 0
	) {
		throw new Error(`Invalid OpenAI Codex device code response: ${JSON.stringify(json)}`);
	}

	return {
		deviceAuthId: json.device_auth_id,
		userCode: json.user_code,
		intervalSeconds,
	};
}

/**
 * 轮询设备码授权结果，直到用户完成授权或流程终止。
 * 复用共享轮询循环 pollOAuthDeviceCodeFlow（间隔控制、slow_down 降速、
 * 超时与取消都由它管，见 device-code.ts），这里只提供单次轮询的
 * OpenAI 方言：
 * - 200：授权完成，取出 authorization_code 与 code_verifier
 * - 403 / 404：OpenAI 用它们表达「仍在等待用户授权」，映射为 pending
 * - error.code 为 deviceauth_authorization_pending / slow_down：
 *   映射为对应的轮询状态
 * - 其余情况：失败
 */
async function pollOpenAICodexDeviceAuth(device: DeviceAuthInfo, signal: AbortSignal): Promise<DeviceTokenSuccess> {
	// 把共享循环的泛型结果具化为 DeviceTokenSuccess
	return pollOAuthDeviceCodeFlow<DeviceTokenSuccess>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
		signal,
		poll: async () => {
			const response = await fetchWithLoginCancellation(DEVICE_TOKEN_URL, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					device_auth_id: device.deviceAuthId,
					user_code: device.userCode,
				}),
				signal,
			});

			// ========== 成功分支：解析授权码与 code_verifier ==========
			if (response.ok) {
				const rawJson = await response.json();
				const json = rawJson as { authorization_code?: string; code_verifier?: string } | null;
				// 响应成功但缺字段：按失败处理并透传原始 JSON 便于排查
				if (!json?.authorization_code || !json.code_verifier) {
					return {
						status: "failed",
						message: `Invalid OpenAI Codex device auth token response: ${JSON.stringify(json)}`,
					};
				}
				return {
					status: "complete",
					value: { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier },
				};
			}

			// ========== 403/404：OpenAI 语义里表示尚未完成授权，继续等 ==========
			if (response.status === 403 || response.status === 404) {
				return { status: "pending" };
			}

			// ========== 其余错误：解析 body 中的 error.code 做细分 ==========
			const responseBody = await response.text().catch(() => "");
			let errorCode: unknown;
			try {
				const json = JSON.parse(responseBody) as { error?: string | { code?: string } } | null;
				const error = json?.error;
				// error 可能是字符串，也可能是 { code } 对象，两种形态都兼容
				errorCode = typeof error === "object" ? error?.code : error;
			} catch {}

			// 仍在等待用户在验证页完成授权
			if (errorCode === "deviceauth_authorization_pending") {
				return { status: "pending" };
			}
			// 服务端要求放慢轮询频率（共享循环会按 RFC 8628 增加间隔）
			if (errorCode === "slow_down") {
				return { status: "slow_down" };
			}

			// 无法识别的错误：判定失败
			return {
				status: "failed",
				message: `OpenAI Codex device auth failed with status ${response.status}${responseBody ? `: ${responseBody}` : ""}`,
			};
		},
	});
}

/**
 * 构造浏览器登录的授权请求（PKCE + state + Codex 专用参数）。
 * @param originator 授权请求的来源标识（默认 "pi"），会传给授权服务器
 * @returns verifier（留给后续兑换 token）、state（留给回调校验）、授权页 URL
 */
async function createAuthorizationFlow(
	originator: string = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
	// 生成 PKCE 密钥对与防 CSRF 的随机 state
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	// ========== 组装授权 URL ==========
	const url = new URL(AUTHORIZE_URL);
	// 标准 OAuth/OIDC 参数：授权码模式、客户端、回调地址与权限范围
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", REDIRECT_URI);
	url.searchParams.set("scope", SCOPE);
	// PKCE：只上送 challenge 摘要与算法（S256），verifier 留到换 token 时才提交
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	// 防 CSRF：回调必须原样带回 state
	url.searchParams.set("state", state);
	// 以下为 OpenAI 侧的 Codex 专用开关：
	// 让返回的令牌附带用户所属组织信息
	url.searchParams.set("id_token_add_organizations", "true");
	// 启用 Codex CLI 简化登录页（跳过不必要的授权确认步骤）
	url.searchParams.set("codex_cli_simplified_flow", "true");
	// 标识发起登录的客户端来源
	url.searchParams.set("originator", originator);

	return { verifier, state, url: url.toString() };
}

/** 本地回调服务器句柄：server 生命周期控制与授权码的等待/取消。 */
type OAuthServerInfo = {
	/** 关闭底层 http server（登录结束后由调用方执行） */
	close: () => void;
	/** 放弃等待：让 waitForCode 立即以 null 结束（用于取消流程或手工输入先到） */
	cancelWait: () => void;
	/** 等待浏览器回调送达 { code }；被取消时 resolve null 而非 reject */
	waitForCode: () => Promise<{ code: string } | null>;
};

/**
 * 在本地 1455 端口启动一次性 HTTP 服务器接收 OAuth 回调。
 * 只处理 /auth/callback 路径：校验 state 防 CSRF、取出授权码，成功/失败都
 * 给浏览器返回一个结果页（oauth-page.ts 生成）。端口被占用等启动失败时
 * 不抛错，而是返回「永远等不到码」的退化句柄，让登录流程自然落到
 * 手工粘贴授权码的分支。
 * @param state 授权请求中生成的随机 state，用于回调一致性校验
 */
function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	// 浏览器环境加载不到 node:http，明确报错
	if (!_http) {
		throw new Error("OpenAI Codex OAuth is only available in Node.js environments");
	}

	// ========== 授权码的等待 Promise（单次结算） ==========
	// settled 标记保证只 resolve 一次：回调送达与手工取消可能并发触发
	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	// ========== 回调请求处理 ==========
	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			// 非回调路径：404 + 错误页
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}
			// state 不匹配：拒绝，防 CSRF / 串到别的登录会话
			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}
			// 缺授权码：拒绝
			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}
			// 校验全部通过：给浏览器回成功页，并结算授权码
			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch {
			// 处理回调途中异常（如请求行非法）：500 + 错误页，不结算授权码
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthErrorHtml("Internal error while processing OAuth callback."));
		}
	});

	// ========== 监听启动与失败退化 ==========
	return new Promise((resolve) => {
		server
			.listen(1455, getCallbackHost(), () => {
				// 监听成功：返回完整句柄
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						settleWait?.(null);
					},
					waitForCode: () => waitForCodePromise,
				});
			})
			.on("error", (_err: NodeJS.ErrnoException) => {
				// 监听失败（典型如 1455 端口已被占用）：不抛错，
				// 直接结算为 null 并返回退化句柄——waitForCode 永远得到 null，
				// 登录流程会转而依赖手工粘贴授权码
				settleWait?.(null);
				resolve({
					close: () => {
						try {
							server.close();
						} catch {
							// 忽略关闭未成功监听的服务器等产生的错误
						}
					},
					cancelWait: () => {},
					waitForCode: async () => null,
				});
			});
	});
}

/**
 * 从 access token（JWT）中提取 ChatGPT 账号 id。
 * 读取命名空间声明 "https://api.openai.com/auth" 下的 chatgpt_account_id；
 * 不做签名校验（令牌真伪由服务端把关），缺失或非非空字符串时返回 null。
 */
function getAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	// 取出 OpenAI 专有命名空间下的认证声明
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	// 只有非空字符串才算有效
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * 把 token 三元组组装为可存储的 OAuthCredential。
 * 必须能从 access token 中解析出 accountId，否则视为令牌形态不符合预期
 * 直接抛错——它是 Codex 请求链路必需的身份标识（API 层也会从 token
 * 重新提取）。登录与刷新都经由本函数，保证落库凭据始终带账号 id。
 */
function credentialsFromToken(token: OAuthToken): OAuthCredential {
	const accountId = getAccountId(token.access);
	// token 里拿不到 chatgpt_account_id：令牌不合法或不含 Codex 声明
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		type: "oauth",
		access: token.access,
		refresh: token.refresh,
		expires: token.expires,
		// 以自定义字段附带账号 id（OAuthCredential 允许扩展键）
		accountId,
	};
}

/**
 * 授权码 → token → OAuthCredential 的一步式封装（两种登录方式共用）。
 */
async function exchangeAuthorizationCodeForCredentials(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	return credentialsFromToken(await exchangeAuthorizationCode(code, verifier, redirectUri, signal));
}

/**
 * 设备码登录（无头环境）：申请 user_code → 通知 UI → 轮询等待 → 兑换凭据。
 * 用户需在另一设备打开 DEVICE_VERIFICATION_URI 并输入 user_code；授权完成
 * 后服务端返回授权码与 code_verifier，再以标准 PKCE 方式兑换 token。
 */
async function loginOpenAICodexDeviceCode(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// 第一步：向服务端申请 user_code 与轮询间隔
	const device = await startOpenAICodexDeviceAuth(interaction.signal);
	// 推送 device_code 事件：UI 据此展示用户码、验证页地址与有效期
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: DEVICE_VERIFICATION_URI,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
	});
	// 第二步：按服务端指示的间隔轮询，直到授权完成 / 超时 / 取消
	const code = await pollOpenAICodexDeviceAuth(device, interaction.signal);
	// 第三步：用返回的授权码与 code_verifier 兑换凭据
	// （redirect_uri 用 OpenAI 的设备码回调页，而非本地回调）
	return exchangeAuthorizationCodeForCredentials(
		code.authorizationCode,
		code.codeVerifier,
		DEVICE_REDIRECT_URI,
		interaction.signal,
	);
}

/**
 * 浏览器登录（默认方式）：本地回调 与 手工粘贴 双路竞速获取授权码。
 *
 * 流程：构造 PKCE 授权请求 → 启动本地回调服务器 → 通知 UI 打开授权页，
 * 同时并行发起 manual_code 输入提示；两路谁先给出结果就用谁：
 * - 回调先到：直接使用回调中的 code（提示被中止）
 * - 手工输入先到：解析粘贴内容（URL / code#state / 查询串 / 裸码），
 *   输入带 state 时先校验与本次请求一致，防串码
 * 两路都拿不到（如端口被占用且用户未输入）时抛「缺少授权码」。
 * finally 中统一清理：解绑 abort 监听、中止 manual 提示、关闭回调服务器。
 */
async function loginOpenAICodex(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// ========== 准备阶段：授权请求与本地回调服务器 ==========
	const { verifier, state, url } = await createAuthorizationFlow();
	const server = await startLocalOAuthServer(state);
	// manual 提示的独立中止器：流程结束时中止它，避免提示悬挂
	const manualAbort = new AbortController();
	// 外部取消（interaction.signal）联动：取消等待回调
	const onAbort = () => server.cancelWait();
	interaction.signal.addEventListener("abort", onAbort, { once: true });
	// 注册监听前信号可能已中止，补一次检查
	if (interaction.signal.aborted) onAbort();
	let code: string | undefined;
	let manualCode: string | undefined;
	let manualError: Error | undefined;

	// 通知 UI 打开授权页
	interaction.notify({
		type: "auth_url",
		url,
		instructions: "A browser window should open. Complete login to finish.",
	});

	try {
		// ========== 双路竞速：手工粘贴提示 与 回调等待并行 ==========
		// manual_code 提示不 await；无论用户完成输入还是提示出错，
		// 都 cancelWait 让 waitForCode 尽快返回
		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
				placeholder: REDIRECT_URI,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualCode = input;
				server.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				server.cancelWait();
			});

		// ========== 归集授权码 ==========
		const result = await server.waitForCode();
		// 手工输入路径出错（如用户取消提示）：直接抛
		if (manualError) throw manualError;
		// 回调路径先到：直接采用
		if (result?.code) {
			code = result.code;
		} else if (manualCode) {
			// 手工输入路径先到：解析并校验 state（带了就必须与本次请求一致）
			const parsed = parseAuthorizationInput(manualCode);
			if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
			code = parsed.code;
		}

		// 两路都暂无结果（如端口占用导致回调恒为 null，提示还没完成）：
		// 等手工提示结束再尝试取一次
		if (!code) {
			await manualPromise;
			if (manualError) throw manualError;
			if (manualCode) {
				const parsed = parseAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
				code = parsed.code;
			}
		}

		// 仍无授权码：登录失败
		if (!code) throw new Error("Missing authorization code");
		// 用授权码 + PKCE verifier 兑换凭据（redirect_uri 为本地回调）
		return exchangeAuthorizationCodeForCredentials(code, verifier, REDIRECT_URI, interaction.signal);
	} finally {
		// ========== 统一清理：解绑监听、中止提示、关闭服务器 ==========
		interaction.signal.removeEventListener("abort", onAbort);
		manualAbort.abort();
		server.close();
	}
}

/**
 * 刷新 OpenAI Codex OAuth 凭据。
 * 用存储的 refresh token 换新 token 并重新提取 accountId 组装凭据——
 * 刷新拿到的是全新 access token，账号声明可能随服务端状态变化，
 * 因此每次都从新 token 重新解析，而不是沿用旧凭据里的值。
 */
async function refreshOpenAICodexToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	return credentialsFromToken(await refreshAccessToken(refreshToken, signal));
}

/**
 * OpenAI Codex 的 OAuth 认证实现（绑定 ChatGPT Plus/Pro 订阅）。
 * - login：先让用户选择登录方式（浏览器登录为默认，设备码适合无头环境），
 *   再分派到对应实现
 * - refresh：委托 refreshOpenAICodexToken（在 CredentialStore.modify 锁内执行）
 * - toAuth：access token 直接作为 apiKey（Bearer）使用，无需附加头；
 *   chatgpt-account-id 等请求头由 API 层从 token 重新解析
 */
export const openaiCodexOAuth: OAuthAuth = {
	// 展示名：强调这是订阅（ChatGPT Plus/Pro）而非 API key 计费
	name: "OpenAI (ChatGPT Plus/Pro)",
	// 访问由 provider 订阅支撑（非按量付费 API）
	isSubscription: true,

	async login(interaction) {
		// ========== 登录方式选择 ==========
		const method = await interaction.prompt({
			type: "select",
			message: "Select OpenAI Codex login method:",
			options: [
				{ id: OPENAI_CODEX_BROWSER_LOGIN_METHOD, label: "Browser login (default)" },
				{ id: OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD, label: "Device code login (headless)" },
			],
		});

		// 分派到设备码登录（无头环境）
		if (method === OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD) {
			return loginOpenAICodexDeviceCode(interaction);
		}
		// 未知 id（理论上选择器只会返回列出的选项）：防御性报错
		if (method !== OPENAI_CODEX_BROWSER_LOGIN_METHOD) {
			throw new Error(`Unknown OpenAI Codex login method: ${method}`);
		}

		// 默认：浏览器登录
		return loginOpenAICodex(interaction);
	},

	// 刷新：取出存储的 refresh token 换新凭据
	refresh: (credential, signal) => refreshOpenAICodexToken(credential.refresh, signal),

	// access token 直接作为 apiKey 使用，无需额外头
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
