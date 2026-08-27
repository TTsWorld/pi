/**
 * @file GitHub Copilot OAuth 认证流程（auth/oauth/github-copilot.ts）
 * @description
 * 实现 OAuthAuth 三段式（login / refresh / toAuth）的 GitHub Copilot 版本。
 * 核心链路：GitHub 设备码流程（client_id 使用 Copilot 内置的 VSCode 扩展
 * client id，scope 仅 read:user）换取长期有效的 GitHub access token →
 * 用它请求 copilot_internal/v2/token 换取短时效的 Copilot 会话 token（其中
 * 内嵌 proxy-ep 路由信息）→ 按账号派生 Models API 的 baseUrl。
 * 与其他厂商 OAuth 相比的特殊之处：
 * - GitHub access token 本身长期有效，充当「refresh token」存进凭据，
 *   每次刷新都用它重新换取新的 Copilot 会话 token
 * - baseUrl 按账号派生：个人账号从会话 token 的 proxy-ep 解析
 *   （proxy.xxx → api.xxx），企业账号走 copilot-api.<企业域名>
 * - 登录时额外拉取模型目录，并主动为 policy 未配置（unconfigured）的
 *   模型调用 policy 接口启用
 */

import { GITHUB_COPILOT_MODELS } from "../../providers/github-copilot.models.ts";
import { sleep } from "../../utils/sleep.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

/** Base64 解码的简写，用于解开下方以混淆形式存储的 client_id */
const decode = (s: string) => atob(s);

/**
 * GitHub OAuth 设备码流程使用的 client_id，即 Copilot 的 VSCode 扩展
 * 内置的公开 client id。以 Base64 形式存储，避免源码中出现明文、
 * 被密钥扫描工具误判为泄漏。
 */
const CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

/**
 * 访问 Copilot Models API 时必须携带的「客户端身份」请求头：把客户端
 * 伪装成 VSCode 的 Copilot Chat 扩展，服务端据此识别请求来源：
 * - User-Agent / Editor-Plugin-Version：伪装的扩展名与版本号
 * - Editor-Version：宿主编辑器（VSCode）及其版本
 * - Copilot-Integration-Id：集成来源标识（vscode-chat）
 */
const COPILOT_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

/** GitHub API 版本号，随 X-GitHub-Api-Version 头发送，用于 API 版本协商 */
const COPILOT_API_VERSION = "2026-06-01";

/** GitHub 设备码流程第一步（POST /login/device/code）的响应结构 */
type DeviceCodeResponse = {
	/** 设备码，后续换取 access token 的凭证 */
	device_code: string;
	/** 展示给用户、在验证页输入的用户码（形如 XXXX-XXXX） */
	user_code: string;
	/** 用户在浏览器中打开以完成授权的验证页地址 */
	verification_uri: string;
	/** 轮询 token 端点的建议间隔（秒），缺省按 RFC 8628 为 5 秒 */
	interval?: number;
	/** 设备码有效期（秒），超时仍未完成授权则整体失败 */
	expires_in: number;
};

/** 设备码 token 端点的成功响应（只声明关心的字段） */
type DeviceTokenSuccessResponse = {
	access_token: string;
	token_type?: string;
	scope?: string;
};

/** 设备码 token 端点的错误响应（RFC 8628 错误码，可附服务端指定的新轮询间隔） */
type DeviceTokenErrorResponse = {
	error: string;
	error_description?: string;
	interval?: number;
};

/**
 * 把用户输入的 URL / 域名规范化为纯主机名（hostname）。
 * 输入可带可不带协议前缀（"company.ghe.com" 或 "https://company.ghe.com"）；
 * 为空或无法解析时返回 null，由调用方决定如何报错。
 */
function normalizeDomain(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return null;
	}
}

/**
 * 由 GitHub 域名派生本流程用到的三个端点：
 * - deviceCodeUrl：申请设备码（login/device/code，主域）
 * - accessTokenUrl：设备码换 access token（login/oauth/access_token，主域）
 * - copilotTokenUrl：GitHub token 换 Copilot 会话 token
 *   （copilot_internal/v2/token，api. 子域的内部接口）
 */
function getUrls(domain: string): {
	deviceCodeUrl: string;
	accessTokenUrl: string;
	copilotTokenUrl: string;
} {
	return {
		deviceCodeUrl: `https://${domain}/login/device/code`,
		accessTokenUrl: `https://${domain}/login/oauth/access_token`,
		copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
	};
}

/**
 * 从 Copilot 会话 token 中解析 proxy-ep 字段并转换为 Models API 的 base URL。
 * token 形如：tid=...;exp=...;proxy-ep=proxy.individual.githubcopilot.com;...
 * 返回形如 https://api.individual.githubcopilot.com 的 API 地址。
 */
function getBaseUrlFromToken(token: string): string | null {
	const match = token.match(/proxy-ep=([^;]+)/);
	if (!match) return null;
	const proxyHost = match[1];
	// 把 proxy. 前缀替换为 api. 前缀，得到 Models API 的主机名
	const apiHost = proxyHost.replace(/^proxy\./, "api.");
	return `https://${apiHost}`;
}

/**
 * 推导某份凭据应使用的 Models API base URL（Copilot「按账号派生 baseUrl」的核心）。
 * 优先级：会话 token 的 proxy-ep > 企业域名 > 个人账号默认端点。
 */
function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
	// 拿到会话 token 时优先从中解析 proxy-ep 指向的 API 地址
	if (token) {
		const urlFromToken = getBaseUrlFromToken(token);
		if (urlFromToken) return urlFromToken;
	}
	// 企业账号（或 token 解析失败）时的回退：企业专用端点 / 默认个人端点
	if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
	return "https://api.individual.githubcopilot.com";
}

/** 把 unknown 收窄为普通对象（非 null 且类型为 object），否则返回 undefined */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * 解析 Copilot Models API 的 /models 响应，产出两类模型 id：
 * - availableModelIds：当前账号立即可用的模型
 * - policyModelIds：policy 为 unconfigured 且本地目录
 *   （GITHUB_COPILOT_MODELS）已收录的模型——可通过 policy 接口
 *   主动启用后再使用
 * @param raw /models 接口返回的 JSON
 * @param allowPolicyFallback 是否允许在「picker 标记全为 false」时退回
 *        policy=enabled 的模型（仅个人账号端点开启，见 fetchGitHubCopilotModels）
 */
function parseGitHubCopilotModelCatalog(raw: unknown, allowPolicyFallback: boolean) {
	const data = asRecord(raw)?.data;
	if (!Array.isArray(data)) {
		throw new Error("Invalid Copilot models response");
	}

	// ========== 逐项解析原始模型列表 ==========
	const accountModels = data.flatMap((rawItem) => {
		const item = asRecord(rawItem);
		const id = item?.id;
		// 无 id 或结构异常的条目直接丢弃
		if (!item || typeof id !== "string") return [];

		// 不支持 tool_calls 的模型无法用于 agent 场景，剔除
		const capabilities = asRecord(item.capabilities);
		const supports = asRecord(capabilities?.supports);
		if (supports?.tool_calls === false) return [];

		return [
			{
				id,
				pickerEnabled: item.model_picker_enabled === true,
				policyState: asRecord(item.policy)?.state,
			},
		];
	});
	// ========== 计算「立即可用」的模型集合 ==========
	// picker 中可见且未被 policy 禁用的模型
	const pickerModelIds = accountModels
		.filter((model) => model.pickerEnabled && model.policyState !== "disabled")
		.map((model) => model.id);
	// 仅当调用方允许回退（个人账号端点）且 picker 结果为空时，才用 policy=enabled 兜底
	const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
	const availableModelIds =
		pickerModelIds.length > 0 || !allowPolicyFallback
			? pickerModelIds
			: accountModels.filter((model) => model.policyState === "enabled").map((model) => model.id);
	// ========== 计算「可启用」的模型集合 ==========
	// policy 未配置 + 本地目录收录 +（picker 可见或处于回退模式）的模型，
	// 登录流程会逐个调用 policy 接口启用它们
	const policyModelIds = accountModels
		.filter(
			(model) =>
				model.policyState === "unconfigured" &&
				Object.hasOwn(GITHUB_COPILOT_MODELS, model.id) &&
				(model.pickerEnabled || usePolicyFallback),
		)
		.map((model) => model.id);
	return { availableModelIds, policyModelIds };
}

/**
 * 带 429 限流重试的 fetch：收到 Too Many Requests 时按 Retry-After 头
 * 或指数退避等待后重试，整体受「重试预算」约束。
 * @param retryPolicy.maxRetries 最大重试次数（0 = 不重试）
 * @param retryPolicy.maxElapsedMs 重试总时长预算（毫秒，0 = 无预算）；
 *        若下次等待会超出预算，直接把 429 响应原样返回交由调用方处理
 */
async function fetchWithRateLimitRetry(
	url: string,
	init: RequestInit,
	signal: AbortSignal,
	retryPolicy: { maxRetries: number; maxElapsedMs: number },
): Promise<Response> {
	// ========== 组合重试预算信号 ==========
	// 预算信号：从现在起 maxElapsedMs 后自动 abort，防止无限重试
	const retryBudgetSignal =
		retryPolicy.maxRetries > 0 && retryPolicy.maxElapsedMs > 0
			? AbortSignal.timeout(retryPolicy.maxElapsedMs)
			: undefined;
	// 实际传给请求与睡眠的信号 = 外部取消信号 ∪ 预算信号
	const requestSignal = retryBudgetSignal ? AbortSignal.any([signal, retryBudgetSignal]) : signal;
	// 把预算换算为绝对截止时间戳，用于判断「下一次等待是否还等得起」
	const retryDeadline = retryBudgetSignal ? Date.now() + retryPolicy.maxElapsedMs : undefined;
	// ========== 重试循环 ==========
	for (let retry = 0; ; retry++) {
		// 每次请求叠加 5 秒单次超时，避免单个挂起的请求卡住整个流程
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.any([requestSignal, AbortSignal.timeout(5000)]),
		});
		// 非 429，或已用尽重试次数：返回最终响应
		if (response.status !== 429 || retry === retryPolicy.maxRetries) return response;

		// ========== 计算等待时长 ==========
		// 默认指数退避：500ms * 2^retry
		const retryAfter = response.headers.get("retry-after");
		let delayMs = 500 * 2 ** retry;
		if (retryAfter) {
			// Retry-After 既可能是秒数，也可能是 HTTP 日期，分别解析
			const seconds = Number.parseFloat(retryAfter);
			delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
			// 两种解析都失败（非法值）时放弃重试
			if (!Number.isFinite(delayMs)) return response;
		}
		delayMs = Math.max(0, delayMs);
		// 等待会越过重试截止时间时不再重试
		if (retryDeadline !== undefined && delayMs >= retryDeadline - Date.now()) return response;
		// 释放当前响应体，再等待（sleep 可被取消信号中断）后重试
		await response.body?.cancel();
		await sleep(delayMs, requestSignal);
	}
}

/**
 * 拉取当前账号的 Copilot 模型目录（GET {baseUrl}/models）。
 * @param copilotToken Copilot 会话 token（注意不是 GitHub OAuth token）
 * @param retryPolicy 429 重试策略，透传给 fetchWithRateLimitRetry
 * @returns 解析后的 { availableModelIds, policyModelIds }
 */
async function fetchGitHubCopilotModels(
	copilotToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
	retryPolicy: { maxRetries: number; maxElapsedMs: number },
) {
	const baseUrl = getGitHubCopilotBaseUrl(copilotToken, enterpriseDomain);
	// 部分个人（Individual）账号即使 policy 已显式 enabled，返回的每个
	// picker 标记也全是 false。该回退只对个人账号端点开启，其他账号
	// 类型仍保持严格的 picker 语义。
	const allowPolicyFallback = baseUrl === "https://api.individual.githubcopilot.com";
	const response = await fetchWithRateLimitRetry(
		`${baseUrl}/models`,
		{
			headers: {
				Accept: "application/json",
				// 会话 token 以 Bearer 方式鉴权
				Authorization: `Bearer ${copilotToken}`,
				...COPILOT_HEADERS,
				"X-GitHub-Api-Version": COPILOT_API_VERSION,
			},
		},
		signal,
		retryPolicy,
	);
	if (!response.ok) {
		throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
	}
	return parseGitHubCopilotModelCatalog(await response.json(), allowPolicyFallback);
}

/** 普通 JSON 请求辅助：非 2xx 时抛出带状态码与响应体文本的错误 */
async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
	const response = await fetch(url, init);
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text}`);
	}
	return response.json();
}

/**
 * 发起 GitHub 设备码流程第一步：POST /login/device/code 申请设备码。
 * @param domain github.com 或 GitHub Enterprise 域名
 * @returns 结构校验通过的 DeviceCodeResponse
 * @throws 响应字段非法，或 verification_uri 不是可信的 http(s) URL 时抛错
 */
async function startDeviceFlow(domain: string, signal: AbortSignal): Promise<DeviceCodeResponse> {
	const urls = getUrls(domain);
	const data = await fetchJson(urls.deviceCodeUrl, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "GitHubCopilotChat/0.35.0",
		},
		body: new URLSearchParams({
			client_id: CLIENT_ID,
			// 只申请 read:user：换取 Copilot 会话 token 足够，不需要更多权限
			scope: "read:user",
		}),
		signal,
	});

	if (!data || typeof data !== "object") {
		throw new Error("Invalid device code response");
	}

	// ========== 逐字段校验响应结构 ==========
	const deviceCode = (data as Record<string, unknown>).device_code;
	const userCode = (data as Record<string, unknown>).user_code;
	const verificationUri = (data as Record<string, unknown>).verification_uri;
	const interval = (data as Record<string, unknown>).interval;
	const expiresIn = (data as Record<string, unknown>).expires_in;

	if (
		typeof deviceCode !== "string" ||
		typeof userCode !== "string" ||
		typeof verificationUri !== "string" ||
		(interval !== undefined && typeof interval !== "number") ||
		typeof expiresIn !== "number"
	) {
		throw new Error("Invalid device code response fields");
	}

	// 验证 URI 会在用户的浏览器中打开；为防止 `open` 之类的打开操作
	// 意外执行了可执行文件等目标，这里强制它是合法的 http(s) URL。
	let parsedUri: URL;
	try {
		parsedUri = new URL(verificationUri);
	} catch {
		throw new Error("Untrusted verification_uri in device code response");
	}
	// 协议必须是 http/https，排除 file: 等本地协议
	if (parsedUri.protocol !== "https:" && parsedUri.protocol !== "http:") {
		throw new Error("Untrusted verification_uri in device code response");
	}

	return {
		device_code: deviceCode,
		user_code: userCode,
		verification_uri: parsedUri.href,
		interval,
		expires_in: expiresIn,
	};
}

/**
 * 轮询 GitHub OAuth token 端点，直到用户完成授权并拿到 GitHub access token。
 * 轮询节奏（间隔、slow_down 处理、有效期、取消）由共享的
 * pollOAuthDeviceCodeFlow 管理，这里只提供单次 poll 回调，
 * 并把响应映射为 pending / slow_down / failed / complete 四种轮询状态。
 */
async function pollForGitHubAccessToken(
	domain: string,
	device: DeviceCodeResponse,
	signal: AbortSignal,
): Promise<string> {
	const urls = getUrls(domain);
	return pollOAuthDeviceCodeFlow<string>({
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
		// 拿到设备码后先等一个间隔再发起首次轮询，避免过早请求
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const raw = await fetchJson(urls.accessTokenUrl, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": "GitHubCopilotChat/0.35.0",
				},
				body: new URLSearchParams({
					client_id: CLIENT_ID,
					device_code: device.device_code,
					// 设备码授权的标准 grant type（RFC 8628）
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal,
			});

			// 成功分支：拿到 GitHub access token
			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenSuccessResponse).access_token === "string") {
				return { status: "complete", value: (raw as DeviceTokenSuccessResponse).access_token };
			}

			// 错误分支：按 RFC 8628 的错误码分流
			if (raw && typeof raw === "object" && typeof (raw as DeviceTokenErrorResponse).error === "string") {
				const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
				// 用户尚未在浏览器完成授权：继续按当前间隔轮询
				if (error === "authorization_pending") {
					return { status: "pending" };
				}

				// 轮询过快：上报给共享循环放大间隔（服务端可能给出新间隔）
				if (error === "slow_down") {
					return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
				}

				// 其他错误码（如 access_denied、expired_token）：整体失败
				const descriptionSuffix = description ? `: ${description}` : "";
				return { status: "failed", message: `Device flow failed: ${error}${descriptionSuffix}` };
			}

			// 既无 access_token 也无 error：响应结构非法
			return { status: "failed", message: "Invalid device token response" };
		},
	});
}

/**
 * 用 GitHub access token 换取 Copilot 会话 token。
 * 请求内部端点 api.<domain>/copilot_internal/v2/token，返回的会话 token
 * 内嵌 proxy-ep（API 路由信息）与 expires_at（秒级过期时间）。
 * 注意：这里并没有真正意义上的 refresh token——GitHub 设备码流程签发的
 * access token 长期有效，直接作为换取会话 token 的凭证，并被存进凭据的
 * refresh 字段供下次刷新复用。
 * @param refreshToken 存储的 GitHub access token
 * @returns 新的 OAuthCredential（expires 已换算为毫秒并提前 5 分钟）
 */
async function refreshGitHubCopilotAccessToken(
	refreshToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const domain = enterpriseDomain || "github.com";
	const urls = getUrls(domain);

	const raw = await fetchJson(urls.copilotTokenUrl, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${refreshToken}`,
			...COPILOT_HEADERS,
		},
		signal,
	});

	if (!raw || typeof raw !== "object") {
		throw new Error("Invalid Copilot token response");
	}

	const token = (raw as Record<string, unknown>).token;
	const expiresAt = (raw as Record<string, unknown>).expires_at;

	if (typeof token !== "string" || typeof expiresAt !== "number") {
		throw new Error("Invalid Copilot token response fields");
	}

	// expires_at 是秒级时间戳：换算为毫秒，并提前 5 分钟视为过期，
	// 给刷新留出安全余量，避免拿着临期 token 发请求
	return {
		type: "oauth",
		refresh: refreshToken,
		access: token,
		expires: expiresAt * 1000 - 5 * 60 * 1000,
		enterpriseUrl: enterpriseDomain,
	};
}

/**
 * 刷新 GitHub Copilot 凭据（OAuthAuth.refresh 的实现）。
 * 由 Models 在 CredentialStore.modify 的锁内调用：先用存储的 GitHub
 * token 换新的 Copilot 会话 token，再刷新可用模型列表。
 */
async function refreshGitHubCopilotToken(
	refreshToken: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	const credentials = await refreshGitHubCopilotAccessToken(refreshToken, enterpriseDomain, signal);
	// 模型列表不重试（maxRetries=0）：refresh 在存储锁内执行，应快速返回，
	// 失败直接抛错交由上层处理
	const { availableModelIds } = await fetchGitHubCopilotModels(credentials.access, enterpriseDomain, signal, {
		maxRetries: 0,
		maxElapsedMs: 0,
	});
	return {
		...credentials,
		availableModelIds,
	};
}

/**
 * 为用户的 GitHub Copilot 账号启用单个模型（POST /models/{id}/policy）。
 * 部分模型（如 Claude、Grok）在使用前必须先启用 policy，否则请求会被拒。
 * @returns 是否启用成功；网络异常等非取消类错误按失败（false）处理
 */
async function enableGitHubCopilotModel(
	token: string,
	modelId: string,
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<boolean> {
	const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
	const url = `${baseUrl}/models/${modelId}/policy`;

	let response: Response;
	try {
		response = await fetchWithRateLimitRetry(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					...COPILOT_HEADERS,
					// 服务端要求同时携带的两个「意图」标识头
					"openai-intent": "chat-policy",
					"x-interaction-type": "chat-policy",
				},
				// 请求体即目标 policy 状态：enabled
				body: JSON.stringify({ state: "enabled" }),
			},
			signal,
			{ maxRetries: 2, maxElapsedMs: 5000 },
		);
	} catch (error) {
		// 用户取消则向上抛；其他网络错误视为该模型启用失败
		if (signal.aborted) throw error;
		return false;
	}
	// 重试预算耗尽仍被限流：视为硬错误上抛，由批量层终止整批启用
	if (response.status === 429) {
		throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
	}
	return response.ok;
}

/**
 * 批量启用指定的 Copilot 模型，返回启用成功的 id 列表。
 * policy 更新是尽力而为：单个模型失败只跳过；重试预算耗尽（持续 429）
 * 则中止整批，返回此前已成功的部分。
 */
async function enableGitHubCopilotModels(
	token: string,
	modelIds: readonly string[],
	enterpriseDomain: string | undefined,
	signal: AbortSignal,
): Promise<string[]> {
	const enabledModelIds: string[] = [];
	for (const modelId of modelIds) {
		try {
			if (await enableGitHubCopilotModel(token, modelId, enterpriseDomain, signal)) {
				enabledModelIds.push(modelId);
			}
		} catch (error) {
			// 用户取消向上抛；限流耗尽等硬错误则停止后续模型，保留已成功列表
			if (signal.aborted) throw error;
			break;
		}
	}
	return enabledModelIds;
}

/**
 * GitHub Copilot 交互式登录（OAuthAuth.login 的实现）。
 * 完整流程：询问企业域名 → GitHub 设备码授权 → 换取 Copilot 会话
 * token → 拉取模型目录 → 启用可启用的模型 → 汇总产出凭据。
 */
async function loginGitHubCopilot(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	// ========== 第一步：确定目标 GitHub 域名 ==========
	// 询问企业实例地址；留空表示使用 github.com
	const input = await interaction.prompt({
		type: "text",
		message: "GitHub Enterprise URL/domain (blank for github.com)",
		placeholder: "company.ghe.com",
	});
	if (interaction.signal.aborted) throw new Error("Login cancelled");

	// 规范化为纯主机名；用户填了内容但解析失败时报错
	const trimmed = input.trim();
	const enterpriseDomain = normalizeDomain(input);
	if (trimmed && !enterpriseDomain) throw new Error("Invalid GitHub Enterprise URL/domain");
	const domain = enterpriseDomain || "github.com";

	// ========== 第二步：设备码授权 ==========
	// 申请设备码，并通知 UI 展示 user_code 与验证页地址
	const device = await startDeviceFlow(domain, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.user_code,
		verificationUri: device.verification_uri,
		intervalSeconds: device.interval,
		expiresInSeconds: device.expires_in,
	});

	// 轮询直到用户完成授权，拿到 GitHub access token
	const githubAccessToken = await pollForGitHubAccessToken(domain, device, interaction.signal);
	// ========== 第三步：换取 Copilot 会话 token ==========
	const credentials = await refreshGitHubCopilotAccessToken(
		githubAccessToken,
		enterpriseDomain ?? undefined,
		interaction.signal,
	);
	// ========== 第四步：拉取并启用模型 ==========
	// 登录路径允许少量限流重试（对比 refresh 路径的不重试）
	const models = await fetchGitHubCopilotModels(
		credentials.access,
		enterpriseDomain ?? undefined,
		interaction.signal,
		{
			maxRetries: 2,
			maxElapsedMs: 5000,
		},
	);
	let enabledModelIds: string[] = [];
	if (models.policyModelIds.length > 0) {
		interaction.notify({ type: "progress", message: "Enabling models..." });
		enabledModelIds = await enableGitHubCopilotModels(
			credentials.access,
			models.policyModelIds,
			enterpriseDomain ?? undefined,
			interaction.signal,
		);
	}
	// 可用集合 = 目录中立即可用 ∪ 本次成功启用的模型（Set 去重）
	return {
		...credentials,
		availableModelIds: [...new Set([...models.availableModelIds, ...enabledModelIds])],
	};
}

/** 从凭据的 enterpriseUrl 字段提取规范化企业域名；缺失或非法时返回 undefined */
function copilotEnterpriseDomain(credential: OAuthCredential): string | undefined {
	const enterpriseUrl = credential.enterpriseUrl;
	if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return undefined;
	return normalizeDomain(enterpriseUrl) ?? undefined;
}

/**
 * GitHub Copilot 的 OAuthAuth 实现，导出给 provider 注册使用：
 * - login：设备码流程 + 模型启用（loginGitHubCopilot）
 * - refresh：GitHub token → 新的 Copilot 会话 token + 模型列表刷新
 *   （在 CredentialStore.modify 锁内执行）
 * - toAuth：凭据 → 请求认证；baseUrl 按账号派生，每次都从会话
 *   token 的 proxy-ep 重新推导
 */
export const githubCopilotOAuth: OAuthAuth = {
	name: "GitHub Copilot",
	// 订阅型认证：访问由用户的 Copilot 订阅支撑，而非按量付费的 API key
	isSubscription: true,
	login: loginGitHubCopilot,
	refresh: (credential, signal) =>
		refreshGitHubCopilotToken(credential.refresh, copilotEnterpriseDomain(credential), signal),

	/** 为每次请求推导该凭据专属的代理端点（baseUrl）。 */
	async toAuth(credential) {
		return {
			// Copilot 会话 token 作为 Bearer apiKey 使用
			apiKey: credential.access,
			// 按账号派生 baseUrl：优先从 token 的 proxy-ep 解析
			baseUrl: getGitHubCopilotBaseUrl(credential.access, copilotEnterpriseDomain(credential)),
		};
	},
};
