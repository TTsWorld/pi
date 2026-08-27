/**
 * @file OpenRouter OAuth PKCE 登录流程（auth/oauth/openrouter.ts）
 * @description
 * OpenRouter 的 OAuth 与常规「access + refresh token 对」不同：它把授权码
 * 兑换成一把由用户掌控的永久 API key，而不是一对会过期的令牌，因此
 * refresh 是空操作、凭据永不过期。
 *
 * 回调由一个监听临时端口的一次性本地回环服务器接收，并与手工输入提示
 * （manual_code）竞速：远程/无头环境下浏览器无法访问回环服务器时，
 * 用户可以把最终的重定向 URL（或授权码）粘贴进提示里完成登录。
 *
 * 注意：本模块用 Node.js 的 http.createServer 搭建 OAuth 回调服务器，
 * 只面向 CLI 使用，不适用于浏览器环境。
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

/** OpenRouter 授权页地址，用户在浏览器中此处完成登录授权。 */
const AUTHORIZE_URL = "https://openrouter.ai/auth";
/** 授权码兑换端点：POST 授权码 + PKCE verifier，成功响应中返回永久 API key。 */
const TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
/** 整个登录流程（等待浏览器回调或手工输入）的总超时：5 分钟。 */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** 单次授权码兑换请求的超时：30 秒。 */
const TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;

/**
 * 读取回调服务器绑定的主机地址。
 * 默认 127.0.0.1（仅本机回环）；可用 PI_OAUTH_CALLBACK_HOST 覆盖，
 * 例如通过端口转发把回调引进容器/虚拟机的场景。
 */
function getCallbackHost(): string {
	return getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
}

/** 字段未知的 JSON 对象，用于承接 OAuth 端点的响应体。 */
type JsonObject = Record<string, unknown>;

/**
 * 回调服务器句柄：login 流程通过它与「等待凭据」的 Promise 交互。
 * 一次性使用——单个授权码只允许兑换一次。
 */
type OpenRouterCallbackServer = {
	/** 浏览器完成授权后被重定向到的回调地址（含随机路径与实际分配的端口）。 */
	callbackUrl: string;
	/** 停止监听并释放定时器，但不结算 `waitForCredential`（不 resolve/reject）。 */
	close: () => void;
	/** 把登录移交给手工输入分支；若回调尚未认领兑换则以 null 结算等待。 */
	cancelWait: () => void;
	/**
	 * 等待登录结果：浏览器回调完成 key 兑换后 resolve 凭据；
	 * `cancelWait` 移交手工输入后 resolve null；
	 * 超时、取消或兑换失败时 reject。
	 */
	waitForCredential: () => Promise<OAuthCredential | null>;
};

/**
 * 向回调请求写回 HTML 响应（成功/失败提示页）。
 * 设置 no-store 防止浏览器缓存一次性的结果页。
 */
function sendHtml(response: ServerResponse, status: number, html: string): void {
	response.statusCode = status;
	response.setHeader("content-type", "text/html; charset=utf-8");
	response.setHeader("cache-control", "no-store");
	response.end(html);
}

/**
 * 解析用户手工粘贴的输入，提取授权码。按顺序兼容三种形态：
 * 1. 完整的重定向 URL——取其 code 查询参数；
 * 2. 形如 "code=xxx" 的查询串——解析后取 code；
 * 3. 裸授权码——原样返回。
 *
 * @param input 用户粘贴的原始文本
 * @returns 解析出的授权码；输入为空时返回 undefined
 */
function parseAuthorizationInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;

	try {
		return new URL(value).searchParams.get("code") ?? undefined;
	} catch {
		// 不是合法 URL，继续按查询串 / 裸码尝试
	}

	if (value.includes("code=")) {
		return new URLSearchParams(value).get("code") ?? undefined;
	}

	// 其余情况视为裸授权码
	return value;
}

/**
 * 从 OAuth 端点的错误响应体中尽力提取人类可读的错误信息。
 * 各端点错误字段不统一，按 error_description → message → error（字符串）
 * → error.message（对象）的优先级探测。
 *
 * @param body 解析后的 JSON 响应体（可能不含任何错误字段）
 * @returns 错误描述；提取不到时返回 undefined
 */
function errorDetail(body: JsonObject): string | undefined {
	if (typeof body.error_description === "string") return body.error_description;
	if (typeof body.message === "string") return body.message;
	if (typeof body.error === "string") return body.error;
	if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
		const message = (body.error as JsonObject).message;
		if (typeof message === "string") return message;
	}
	return undefined;
}

/**
 * 用授权码 + PKCE verifier 向 OpenRouter 兑换永久 API key。
 *
 * 兑换结果包装成 OAuthCredential：key 存入 access、refresh 留空、
 * expires 设为 MAX_SAFE_INTEGER（永久有效），因此后续流程无需刷新。
 *
 * @param code 授权码（来自浏览器回调或手工粘贴）
 * @param verifier PKCE code_verifier，与授权请求中的 challenge 配对校验
 * @param signal 登录流程的中止信号（用户取消）
 * @returns 永久 API key 形态的 OAuth 凭据
 */
async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (signal.aborted) throw new Error("Login cancelled");

	// ========== 中止与超时接线 ==========
	// 把外层 signal（用户取消）与 30 秒超时统一汇入同一个 AbortController，
	// 请求失败后只需检查 controller.signal 即可归因
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(new Error("OpenRouter OAuth token exchange timed out")),
		TOKEN_EXCHANGE_TIMEOUT_MS,
	);

	let response: Response;
	let body: JsonObject = {};
	try {
		// ========== 发起兑换请求 ==========
		response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json" },
			body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
			signal: controller.signal,
		});
		// ========== 解析响应体 ==========
		// 尽力解析为 JSON 对象；解析失败且状态码正常时才视为异常，
		// 错误响应（可能非 JSON）留待下方统一按 HTTP 状态处理
		try {
			const parsed = (await response.json()) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as JsonObject;
		} catch {
			if (response.ok) throw new Error("OpenRouter OAuth returned invalid JSON");
		}
	} catch (error) {
		// ========== 失败原因归一 ==========
		// abort 归因为「用户取消」或「兑换超时」；其余错误原样抛出
		if (signal.aborted) throw new Error("Login cancelled");
		if (controller.signal.aborted) throw new Error("OpenRouter OAuth token exchange timed out");
		throw error;
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", onAbort);
	}

	// ========== 校验响应 ==========
	// 非期望状态码时，尽量附带响应体中的错误详情
	if (!response.ok) {
		const detail = errorDetail(body);
		throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
	}

	// OpenRouter 的兑换结果是 { key: "<API key>" }，而非 access_token
	if (typeof body.key !== "string" || body.key.length === 0) {
		throw new Error('OpenRouter OAuth response carries no "key"');
	}

	// ========== 构造永久凭据 ==========
	// 无 refresh token、永不过期，refresh() 因此是空操作
	return {
		type: "oauth",
		access: body.key,
		refresh: "",
		expires: Number.MAX_SAFE_INTEGER,
	};
}

/**
 * 启动一次性本地回调服务器，监听临时端口等待浏览器重定向。
 *
 * 服务器只在首个携带授权码的回调请求上完成兑换（claimed 标记保证
 * 授权码只用一次）；listen(0) 由系统分配空闲端口。整体受
 * LOGIN_TIMEOUT_MS 超时与外部 signal（用户取消）约束。
 *
 * @param callbackPath 随机化的回调路径（含 UUID），用于构造 callback_url
 * @param verifier PKCE code_verifier，供回调请求内直接发起兑换
 * @param signal 登录流程的中止信号
 * @returns 回调服务器句柄（callbackUrl / close / cancelWait / waitForCredential）
 */
async function startCallbackServer(
	callbackPath: string,
	verifier: string,
	signal: AbortSignal,
): Promise<OpenRouterCallbackServer> {
	if (signal.aborted) throw new Error("Login cancelled");
	const callbackHost = getCallbackHost();

	// ========== Promise 接线 ==========
	// 手动保存 resolve/reject，供 finish() 在请求处理、超时、中止等路径结算
	let resolveCredential: (credential: OAuthCredential | null) => void = () => {};
	let rejectCredential: (error: Error) => void = () => {};
	const credential = new Promise<OAuthCredential | null>((resolve, reject) => {
		resolveCredential = resolve;
		rejectCredential = reject;
	});

	let server: Server;
	// claimed：已有回调认领本次登录（兑换进行中），拒绝后续回调
	// settled：Promise 是否已结算，是 finish() 幂等的依据
	let claimed = false;
	let settled = false;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;

	// ========== 清理与结算 ==========
	// close 只释放资源、不结算 Promise；finish 保证只结算一次
	const close = (): void => {
		if (timeout) clearTimeout(timeout);
		if (onAbort) signal.removeEventListener("abort", onAbort);
		server.close();
	};

	const finish = (result: { credential: OAuthCredential | null } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		close();
		if ("credential" in result) resolveCredential(result.credential);
		else rejectCredential(result.error);
	};

	// ========== 回调请求处理 ==========
	server = createServer((request, response) => {
		void (async () => {
			const requestUrl = new URL(request.url ?? "/", `http://${callbackHost}`);
			// 只接受预期的回调路由，其余请求一律 404
			if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
				sendHtml(response, 404, oauthErrorHtml("OAuth callback route not found."));
				return;
			}
			// 回调已被使用（如浏览器重复重定向/刷新）：授权码只能兑换一次
			if (claimed || settled) {
				sendHtml(response, 409, oauthErrorHtml("This OAuth callback has already been used."));
				return;
			}

			// 授权服务器回报的错误（如用户拒绝授权）：直接失败收场
			const oauthError = requestUrl.searchParams.get("error");
			if (oauthError) {
				const description = requestUrl.searchParams.get("error_description") ?? oauthError;
				sendHtml(response, 400, oauthErrorHtml("OpenRouter authorization was denied.", description));
				finish({ error: new Error(`OpenRouter authorization failed: ${description}`) });
				return;
			}

			// 缺少授权码：只回 400 不结算，用户可在浏览器重试后再次回调
			const code = requestUrl.searchParams.get("code");
			if (!code) {
				sendHtml(response, 400, oauthErrorHtml("OpenRouter returned no authorization code."));
				return;
			}
			claimed = true;

			// 就地兑换授权码，成功/失败都通过回调页面反馈给用户
			try {
				const result = await exchangeAuthorizationCode(code, verifier, signal);
				sendHtml(response, 200, oauthSuccessHtml("Signed in to OpenRouter. You may now close this page."));
				finish({ credential: result });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown token exchange error";
				sendHtml(response, 502, oauthErrorHtml("OpenRouter key exchange failed.", message));
				finish({ error: error instanceof Error ? error : new Error(message) });
			}
		})();
	});

	// ========== 监听临时端口 ==========
	// listen(0) 让系统分配空闲端口，避免端口冲突或被抢占
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, callbackHost, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});

	// 监听成功后再挂常驻的错误处理、中止处理与总超时
	server.on("error", (error) => finish({ error }));
	onAbort = () => finish({ error: new Error("Login cancelled") });
	signal.addEventListener("abort", onAbort, { once: true });
	// 挂上监听后补查一次：signal 可能恰在挂监听前已中止
	if (signal.aborted) {
		close();
		throw new Error("Login cancelled");
	}
	timeout = setTimeout(() => finish({ error: new Error("OpenRouter OAuth login timed out") }), LOGIN_TIMEOUT_MS);

	// 取出实际分配的端口构造回调地址；拿不到端口则流程无法继续
	const address = server.address();
	if (!address || typeof address === "string") {
		close();
		throw new Error("Could not determine the OpenRouter OAuth callback port");
	}

	return {
		callbackUrl: `http://${callbackHost}:${address.port}${callbackPath}`,
		close,
		// 已认领的回调正在兑换授权码；让它继续完成并结算登录，避免打断
		cancelWait: () => {
			if (!claimed) finish({ credential: null });
		},
		waitForCredential: () => credential,
	};
}

/**
 * OpenRouter 交互式登录：授权码 + PKCE 流程。
 *
 * 流程概览：
 * 1. 生成 PKCE 密钥对，在随机路径上启动本地回调服务器；
 * 2. 推送授权 URL，用户在浏览器完成登录授权；
 * 3. 浏览器回调与手工粘贴提示竞速——回调先到则就地兑换返回，
 *    否则解析用户粘贴的重定向 URL / 授权码走手工兑换。
 *
 * @param interaction 登录交互（通知事件、手工输入提示、取消信号）
 * @returns 永久 API key 形态的 OAuth 凭据
 */
async function loginOpenRouter(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// ========== 准备 PKCE 与一次性回调服务器 ==========
	// 回调路径含随机 UUID：只有本次登录的授权请求会重定向到它
	const { verifier, challenge } = await generatePKCE();
	const callbackPath = `/oauth/callback/${crypto.randomUUID()}`;
	const callback = await startCallbackServer(callbackPath, verifier, interaction.signal);
	const manualAbort = new AbortController();
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		// ========== 构造授权 URL ==========
		// callback_url 告知 OpenRouter 授权后重定向回本地服务器；
		// PKCE 只传 challenge（S256），verifier 留到兑换时才提交
		const authorizeUrl = new URL(AUTHORIZE_URL);
		authorizeUrl.search = new URLSearchParams({
			callback_url: callback.callbackUrl,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();

		interaction.notify({
			type: "progress",
			message: `Listening for OpenRouter OAuth callback on ${callback.callbackUrl}`,
		});
		interaction.notify({
			type: "auth_url",
			url: authorizeUrl.toString(),
			instructions:
				"Complete sign-in in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		// ========== 手工输入分支（与回调竞速） ==========
		// 远程/无浏览器场景下浏览器够不到回环服务器，用户可改为粘贴
		// 最终重定向 URL 或授权码；输入完成后通过 cancelWait 移交
		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete sign-in in your browser, or paste the authorization code / redirect URL here:",
				placeholder: callback.callbackUrl,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualInput = input;
				callback.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				callback.cancelWait();
			});

		// ========== 等待结果：回调优先 ==========
		// null 表示回调未认领、登录已移交手工分支
		const credential = await callback.waitForCredential();
		if (manualError) throw manualError;
		if (credential) return credential;

		// ========== 手工兑换分支 ==========
		await manualPromise;
		if (manualError) throw manualError;
		const code = manualInput ? parseAuthorizationInput(manualInput) : undefined;
		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for an API key..." });
		return await exchangeAuthorizationCode(code, verifier, interaction.signal);
	} finally {
		// 收尾：中止仍挂着的手工提示并关闭回调服务器（不影响已结算的 Promise）
		manualAbort.abort();
		callback.close();
	}
}

/**
 * OpenRouter 的 OAuthAuth 实现。
 * 特点：登录产出的是永久 API key，因此 refresh 为空操作、
 * toAuth 直接把 key 作为请求 apiKey 返回。
 */
export const openRouterOAuth: OAuthAuth = {
	name: "OpenRouter OAuth",
	loginLabel: "Sign in with OpenRouter",
	login: loginOpenRouter,
	/**
	 * 空刷新：OpenRouter 兑换出的是永不过期的 API key
	 * （expires 为 MAX_SAFE_INTEGER），无需也无法刷新，原样返回凭据。
	 */
	async refresh(credential, _signal) {
		return credential;
	},
	/** 凭据 → 请求认证：永久 key 直接作为 apiKey 使用。 */
	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
