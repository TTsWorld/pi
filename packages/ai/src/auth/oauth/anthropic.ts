/**
 * @file Anthropic OAuth 登录流程（Claude Pro/Max 订阅）
 * @description
 * 实现 OAuthAuth 三段式接口（login / refresh / toAuth，类型见 ../types.ts），
 * 让用户以 Claude Pro/Max 订阅账号授权，代替 API key 访问模型：
 * - login：PKCE 授权码流程——启动本地 HTTP 回调服务器，用户在浏览器完成
 *   登录后授权码经回调送达（或由用户手工粘贴），再向 token 端点换取凭据
 * - refresh：access token 过期后用 refresh token 换取新凭据
 *   （由调用方保证在 CredentialStore.modify 锁内执行）
 * - toAuth：把 access token 映射为请求认证（apiKey 字段）
 *
 * 注意：本模块用 Node.js 的 http.createServer 承接 OAuth 回调，
 * 仅面向 CLI 场景，不能在浏览器环境中使用。
 */

import type { Server } from "node:http";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";

/** 本地回调服务器句柄：server 本体 + 授权码的等待/取消控制。 */
type CallbackServerInfo = {
	/** 底层 http server，登录结束后由调用方 close */
	server: Server;
	/** 注册给授权服务器的重定向地址（http://localhost:53692/callback） */
	redirectUri: string;
	/** 放弃等待：让 waitForCode 立即以 null 结束（用于取消流程或手工输入先到） */
	cancelWait: () => void;
	/** 等待浏览器回调送达 { code, state }；被取消时 resolve null 而非 reject */
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

/** 从 node:http 动态导入的最小 API 集合（仅 createServer）。 */
type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

// 已加载的 node:http API 单例缓存；用 Promise 缓存避免并发初始化时重复 import
let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

// ========== Anthropic OAuth 端点与客户端常量 ==========

// base64 解码工具：client_id 以 base64 形式内嵌，避免明文出现在源码里
const decode = (s: string) => atob(s);

// OAuth client id（解码后即官方 Claude Code 客户端的 id，本 SDK 复用其注册信息）
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");

// 授权端点：用户在此页面登录并批准授权，随后带 code 重定向回本地回调
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";

// token 端点：授权码换 token（login）与 refresh token 换新 token（refresh）共用
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

// 回调服务器监听地址，可用环境变量 PI_OAUTH_CALLBACK_HOST 覆盖（如 localhost 解析到 IPv6 时改绑 127.0.0.1）
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
// 回调端口与路径：端口固定，因为 REDIRECT_URI 必须与 client 注册信息一致
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
// 发给授权服务器的 redirect_uri（注意用的是 localhost 主机名，与实际监听地址 CALLBACK_HOST 是两回事）
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

// 申请的权限范围：创建 org API key、读取用户资料、模型推理、
// Claude Code 会话、MCP 服务器与文件上传
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/**
 * 惰性加载 node:http 并缓存 createServer。
 * 用动态 import 而非顶层静态导入：顶层静态导入会让浏览器打包直接引入
 * node:http 而失败；延迟到运行时才加载，才能把「仅限 Node」的限制
 * 变成可捕获的运行时错误。
 */
async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		// ========== 环境守卫 ==========
		// 既不在 Node 也不在 Bun（即浏览器环境）时，无法启动回调服务器
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

/**
 * 解析用户手工粘贴的授权输入。
 * 浏览器可能在另一台机器上打不开 localhost，此时用户只能把最终重定向
 * URL（或其中的 code/state）复制回来；本函数兼容四种输入形态：
 * 1. 完整回调 URL（http://localhost:53692/callback?code=...&state=...）
 * 2. "code#state" 组合串
 * 3. 形如 "code=...&state=..." 的查询串
 * 4. 裸授权码
 */
function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		// 形态 1：完整 URL，直接读取 query 参数
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

	// 形态 4：整串当作裸授权码
	return { code: value };
}

/**
 * 把任意 unknown 错误压平成单个字符串，供错误消息附带诊断细节。
 * Error 实例会展开 code/errno/递归 cause 与 stack，便于排查
 * token 请求失败（网络错误、超时等）的具体原因。
 */
function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			// cause 可能仍是 Error，递归展开（fetch 超时常把根因挂在 cause 上）
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

/**
 * 启动本地 HTTP 回调服务器，等待授权服务器把 code/state 重定向过来。
 *
 * @param expectedState 期望的 state 值——本流程中即 PKCE verifier
 *   （见 loginAnthropic：一个随机串同时充当 CSRF 防护与 PKCE 绑定）
 * @returns 服务器句柄；listen 成功后 resolve，端口占用等启动错误则 reject
 */
async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		// ========== 等待授权码的 Promise（只允许 settle 一次） ==========
		// resolve null 表示「不等了」（取消流程或手工输入先到），区别于流程失败
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			// settled 标记保证只有第一个到达的结果（回调或取消）生效
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		// ========== 请求处理：逐项校验回调参数 ==========
		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				// 非回调路径（浏览器可能顺带请求 favicon 等）→ 404 错误页
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				// 授权服务器直接带回 error（用户拒绝或授权失败）→ 400 错误页
				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
					return;
				}

				// 缺 code 或 state → 参数不完整
				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				// state 校验：防 CSRF，确认回调确实来自我们发起的那次授权请求
				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				// 全部校验通过：告知用户可关闭页面，并把授权码交付给等待方
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		// 端口被占用等启动期错误 → 让外层 Promise reject
		server.on("error", (err) => {
			reject(err);
		});

		// 监听成功后交付句柄；cancelWait 用于带外终止等待
		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

/**
 * 向指定 URL POST JSON，成功时返回响应文本。
 * 用 AbortSignal.any 合并调用方的取消信号与 30 秒超时，
 * 避免网络挂起时 token 请求无限等待。
 */
async function postJson(url: string, body: Record<string, string | number>, signal: AbortSignal): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		// 把状态码与响应体带进错误消息，方便诊断（如 invalid_grant）
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

/**
 * 用授权码向 token 端点换取 OAuth 凭据（标准授权码 + PKCE 交换）。
 *
 * @param code 授权码（来自本地回调或用户手工粘贴）
 * @param state 回传的 state（本流程中与 verifier 相同）
 * @param verifier PKCE code_verifier——证明发起授权的客户端持有原始随机串
 * @param redirectUri 必须与授权请求中的 redirect_uri 完全一致
 */
async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		// ========== 授权码换 token：grant_type=authorization_code + code_verifier ==========
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				state,
				redirect_uri: redirectUri,
				code_verifier: verifier,
			},
			signal,
		);
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	// ========== 组装凭据：过期时间提前 5 分钟 ==========
	// 留出安全余量，规避时钟偏差，也避免「刚判断有效、发请求时就过期」
	return {
		type: "oauth",
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Anthropic OAuth 登录主流程（PKCE 授权码模式）。
 *
 * 流程：生成 PKCE → 启动本地回调服务器 → 通知 UI 打开授权 URL →
 * 「回调送达授权码」与「用户手工粘贴授权码」竞速 → 用授权码换凭据。
 *
 * 设计要点：state 直接复用 PKCE verifier——同一串随机值既是 CSRF
 * 防护（回调处校验），又是 PKCE 绑定（token 交换时作 code_verifier）。
 */
async function loginAnthropic(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const server = await startCallbackServer(verifier);
	// 独立的 AbortController：回调先到达时用它取消「手工粘贴」提示
	const manualAbort = new AbortController();
	const onAbort = () => server.cancelWait();
	interaction.signal.addEventListener("abort", onAbort, { once: true });
	// 注册监听前 signal 可能已经 abort，补一次手动触发
	if (interaction.signal.aborted) onAbort();
	let code: string | undefined;
	let state: string | undefined;
	let manualInput: string | undefined;
	let manualError: Error | undefined;

	try {
		// ========== 构建授权 URL 参数（PKCE + state） ==========
		// code=true 表示走授权码流程；state 传 verifier 本身
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		// ========== 手工粘贴通道：与本地回调竞速 ==========
		// 浏览器可能在另一台机器上（打不开 localhost），此时用户可以改贴
		// 最终重定向 URL 或授权码；无论哪个通道先完成都会取消回调等待
		const manualPromise = interaction
			.prompt({
				type: "manual_code",
				message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
				placeholder: REDIRECT_URI,
				signal: manualAbort.signal,
			})
			.then((input) => {
				manualInput = input;
				server.cancelWait();
			})
			.catch((error) => {
				manualError = error instanceof Error ? error : new Error(String(error));
				server.cancelWait();
			});

		// ========== 等待授权码：回调或手工输入，先到先用 ==========
		const result = await server.waitForCode();
		if (manualError) throw manualError;
		if (result?.code) {
			// 路径 A：本地回调送达（服务端已校验过 state）
			code = result.code;
			state = result.state;
		} else if (manualInput) {
			// 路径 B：手工输入先到；携带的 state 必须等于 verifier（防伪造），
			// 未携带则视为就是本次发起的授权（用户只贴了 code）
			const parsed = parseAuthorizationInput(manualInput);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
			state = parsed.state ?? verifier;
		}

		if (!code) {
			// waitForCode 返回 null 可能只是提示尚未完成（被手工通道取消），
			// 此时等待手工粘贴出结果再解析一次
			await manualPromise;
			if (manualError) throw manualError;
			if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
				code = parsed.code;
				state = parsed.state ?? verifier;
			}
		}

		if (!code) throw new Error("Missing authorization code");
		if (!state) throw new Error("Missing OAuth state");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		// ========== 授权码换凭据 ==========
		return exchangeAuthorizationCode(code, state, verifier, REDIRECT_URI, interaction.signal);
	} finally {
		// ========== 收尾：移除监听、中止残留的手工提示、关闭回调服务器 ==========
		interaction.signal.removeEventListener("abort", onAbort);
		manualAbort.abort();
		server.server.close();
	}
}

/**
 * 刷新 Anthropic OAuth token：用 refresh token 换取新凭据。
 * 由 Models 在 CredentialStore.modify 锁内调用，避免并发请求对同一
 * refresh token 双重刷新；响应会返回新的 refresh token（轮换），
 * 旧 refresh token 随之作废，必须整体落库。
 */
async function refreshAnthropicToken(refreshToken: string, signal: AbortSignal): Promise<OAuthCredential> {
	let responseBody: string;
	try {
		// ========== refresh_token 授权：只需 client_id + refresh_token ==========
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			signal,
		);
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	// 与登录时相同：过期时间提前 5 分钟，留出安全余量
	return {
		type: "oauth",
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Anthropic 的 OAuthAuth 实现：以 Claude Pro/Max 订阅账号作为认证来源。
 */
export const anthropicOAuth: OAuthAuth = {
	name: "Anthropic (Claude Pro/Max)",
	// 订阅型认证：模型访问走 Claude Pro/Max 订阅额度，而非按量 API 计费
	isSubscription: true,
	login: loginAnthropic,
	// 刷新只消费凭据里存的 refresh token，产出全新凭据（含轮换后的 refresh token）
	refresh: (credential, signal) => refreshAnthropicToken(credential.refresh, signal),

	async toAuth(credential) {
		// access token 直接作为请求 apiKey 派发（由 Anthropic provider 写入相应请求头）
		return { apiKey: credential.access };
	},
};
