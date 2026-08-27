/**
 * @file 认证解析核心：把 provider 声明的认证方式（API key / OAuth）、
 * 应用侧凭据存储（CredentialStore）与环境上下文（AuthContext）解析为
 * 单次请求可用的 AuthResult（apiKey / headers / baseUrl）。
 * @description 核心入口是 resolveProviderAuth，供 `Models` 与 `ImagesModels`
 * 共享。关键语义：
 * - 优先级：显式 overrides.apiKey > 存储凭据 > 环境变量等 ambient 来源；
 * - 存储凭据独占 provider：CredentialStore 中已有凭据时不再查环境变量；
 * - OAuth 凭据按需在 credentials.modify 锁内刷新（防并发/多进程双重刷新），
 *   再用 oauth.toAuth 派生 ModelAuth（如 GitHub Copilot 的按账号 baseUrl）；
 * - API key 走 apiKey.resolve()（存储 key 优先于环境变量）；
 * - 刷新失败不静默回退环境变量，而是抛出带错误码的 ModelsError。
 */

import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

/** ModelsError 的错误码集合（模型层与认证层共用这一个错误类型）。 */
export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

/** 认证解析的调用方覆盖项，用于按请求改写解析输入。 */
export interface AuthResolutionOverrides {
	/** 本次请求显式指定的 API key：优先级最高，绕过存储凭据与环境变量。 */
	apiKey?: string;
	/** 环境变量覆盖表：叠加在原 AuthContext 之上（先查覆盖值，查不到再回落原值）。 */
	env?: ProviderEnv;
	/** 要求 OAuth token 至少剩余这么长的有效期（毫秒）；默认五分钟。 */
	minOAuthValidityMs?: number;
	/** 取消整个解析操作的信号。 */
	signal?: AbortSignal;
}

/**
 * 模型/认证相关的统一错误。code 标识失败类别（auth=认证解析失败、
 * oauth=刷新/派生失败，其余为模型层错误码）；cause 的细节会被并入
 * message，方便上层直接展示。
 */
export class ModelsError extends Error {
	/** 错误类别，取值见 ModelsErrorCode。 */
	readonly code: ModelsErrorCode;

	/**
	 * @param code 错误类别
	 * @param message 面向用户的主错误信息
	 * @param options 底层原因 cause（其细节会拼进最终 message）
	 */
	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** 调用方只会展示 error.message，因此要把底层原因（cause）的细节保留在 message 中。 */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}

/**
 * 解析 provider 的请求认证，`Models` 与 `ImagesModels` 两个集合共享此入口。
 *
 * 优先级与独占语义（本函数的核心契约）：
 * - 显式 overrides.apiKey > 存储凭据 > ambient（环境变量等）；
 * - 存储凭据独占 provider：CredentialStore 里已有凭据时不再查环境变量；
 * - 仅当存储为空时才回退到 ambient 来源（环境变量、AWS profile、ADC 文件等）；
 * - 刷新失败、或存储凭据类型与 provider 声明的认证方式不匹配时，
 *   绝不静默回退环境变量：要么返回 undefined（未配置），要么抛 ModelsError。
 *
 * @param provider 带认证声明的 provider（apiKey / oauth 至少其一）
 * @param credentials 应用持有的凭据存储（按 provider id 存取）
 * @param authContext 环境访问上下文（env / 文件存在性），可注入用于测试与浏览器
 * @param overrides 调用方覆盖项：显式 apiKey、环境变量覆盖、OAuth 最小剩余有效期、取消信号
 * @returns 解析出的 AuthResult；provider 未配置认证时返回 undefined
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	// 外层用 raceWithAbortSignal 兜底：即使内部实现遗漏了 signal 检查也能及时中断
	return raceWithAbortSignal(
		resolveProviderAuthWithSignal(provider, credentials, authContext, overrides, signal),
		signal,
	);
}

/**
 * resolveProviderAuth 的内部实现：已把 overrides.signal 规整为始终存在的操作信号。
 *
 * @param provider 带认证声明的 provider
 * @param credentials 凭据存储
 * @param authContext 原始环境访问上下文（可能被 overrides.env 叠加覆盖）
 * @param overrides 调用方覆盖项（可能为 undefined）
 * @param signal 操作信号，贯穿存储读写与网络刷新
 * @returns 解析出的 AuthResult；未配置认证时返回 undefined
 */
async function resolveProviderAuthWithSignal(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides: AuthResolutionOverrides | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	// ========== 前置检查与环境上下文构造 ==========
	// 进入解析前先检查一次取消状态
	signal.throwIfAborted();
	// overrides.env 叠加在原上下文之上：先查覆盖值，查不到再回落原上下文
	const requestAuthContext = overrides?.env ? overlayEnvAuthContext(authContext, overrides.env) : authContext;

	// ========== 显式 apiKey 覆盖（优先级最高） ==========
	// 调用方为本次请求显式给定了 key（如命令行参数），直接按纯 API key 解析：
	// 不读存储、也不受环境变量中的 key 影响
	if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
		return resolveApiKey(
			requestAuthContext,
			provider.auth.apiKey,
			provider.id,
			{
				type: "api_key",
				key: overrides.apiKey,
				env: overrides.env,
			},
			signal,
		);
	}

	// ========== 存储凭据（独占 provider） ==========
	// Why 独占：用户已显式登录该 provider，存储凭据才是唯一事实来源；
	// 若再叠加环境变量，会出现“登录了 A 账号、实际请求用的却是 env 里 B key”的隐蔽错配
	const stored = await readCredential(credentials, provider.id, signal);
	if (stored) {
		// 存储的是 OAuth 凭据且 provider 声明了 oauth：锁内按需刷新后派生请求认证
		if (stored.type === "oauth" && provider.auth.oauth) {
			return resolveStoredOAuth(
				credentials,
				provider.id,
				provider.auth.oauth,
				stored,
				signal,
				overrides?.minOAuthValidityMs,
			);
		}
		// 存储的是 API key 凭据且 provider 声明了 apiKey：
		// resolve 内部按字段合并，存储 key/env 优先于环境变量；
		// overrides.env 需并进凭据的 env 字段，保证 provider 作用域配置也被覆盖
		if (stored.type === "api_key" && provider.auth.apiKey) {
			const credential = overrides?.env ? { ...stored, env: { ...stored.env, ...overrides.env } } : stored;
			return resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, credential, signal);
		}
		// 凭据类型与 provider 声明的认证方式不匹配：按“未配置”处理而非回退环境变量，
		// 避免掩盖登录状态与实际请求来源不一致的问题
		return undefined;
	}

	// ========== ambient 来源（环境变量、AWS profile、ADC 文件等） ==========
	// 仅当没有任何存储凭据时才走这里
	return provider.auth.apiKey
		? resolveApiKey(requestAuthContext, provider.auth.apiKey, provider.id, undefined, signal)
		: undefined;
}

/**
 * 把 overrides.env 叠加成新的 AuthContext：环境变量先查覆盖表、查不到再回落
 * 原上下文；文件存在性检查保持不变（环境变量覆盖不影响文件系统判断）。
 */
function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

/** 默认的 OAuth token 最小剩余有效期：剩余不足 5 分钟即视为“即将过期”，触发刷新。 */
const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
/** 单次 OAuth 刷新（网络调用）的超时时间，防止 refresh 挂死长期占用存储锁。 */
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * 解析存储的 OAuth 凭据，采用双重检查加锁：
 * 剩余有效期不足（默认五分钟）的 token 先在 `credentials.modify` 锁内
 * 复查过期，确需刷新时执行一次全局唯一的刷新，并在释放锁之前把轮换后
 * 的新凭据写回存储。
 *
 * Why 在锁内刷新：modify 是唯一写入路径且按 provider 串行（含跨进程文件锁），
 * 并发请求/多进程同时发现过期时，只有第一个真正发起网络刷新，其余在锁内
 * 复查时看到新 token 直接复用 —— 避免对同一 refresh token 的双重刷新。
 *
 * @param credentials 凭据存储（modify 提供互斥）
 * @param providerId provider 标识
 * @param oauth provider 声明的 OAuth 实现（refresh / toAuth）
 * @param stored 存储中读出的 OAuth 凭据（可能已过期）
 * @param signal 操作取消信号
 * @param minOAuthValidityMs 调用方要求的 token 最小剩余有效期（毫秒）
 * @returns 派生出的 AuthResult；等待期间凭据被登出（删除/类型改变）时返回 undefined
 */
async function resolveStoredOAuth(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Promise<AuthResult | undefined> {
	// ========== 过期判定基准 ==========
	// 取默认 5 分钟与调用方要求中的较大者：调用方只能收紧、不能放宽默认窗口
	const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
	// “即将过期”：now + 最小剩余有效期 已越过过期时间点
	const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
	let credential = stored;

	if (expiresSoon(credential)) {
		// ========== modify 锁内刷新（双重检查） ==========
		// 锁外的乐观检查认为已过期；权威判定在锁内重做一次
		let post: Credential | undefined;
		try {
			post = await credentials.modify(
				providerId,
				async (current) => {
					// 锁内复查 1：凭据已被删除或不再是 oauth —— 等待期间用户登出了，放弃刷新
					if (current?.type !== "oauth") return undefined;
					// 锁内复查 2：剩余有效期已足够 —— 其他进程/请求抢先完成了刷新，直接复用
					if (!expiresSoon(current)) return undefined;
					// 真正执行刷新：在操作信号之上再叠加 15s 超时，防止网络挂死长期占用存储锁
					try {
						const refreshSignal = AbortSignal.any([
							signal,
							AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
						]);
						return await oauth.refresh(current, refreshSignal);
					} catch (error) {
						// 刷新失败：抛 oauth 错误（不静默回退环境变量）；错误会经 modify 原样传播
						throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
					}
				},
				{ signal },
			);
		} catch (error) {
			// 已是 ModelsError 的原样上抛；存储层失败包装为 auth 错误
			if (error instanceof ModelsError) throw error;
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		// 刷新写回后凭据又被登出/改变：同样放弃本次解析
		if (post?.type !== "oauth") return undefined;
		credential = post;
		// 默认五分钟窗口只决定“要不要刷新”，不构成对 provider 的硬性约束；
		// 而显式传入 minOAuthValidityMs 的调用方（如 bearer-token 导出）
		// 要求刷新后的 token 仍满足其最小有效期，否则视为刷新结果不合格
		if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
			throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
		}
	}

	// ========== 派生请求认证 ==========
	// toAuth 无副作用：从最终生效的凭据（可能是本进程刷新的，也可能是其他进程
	// 刷新后被我们读到的）派生 apiKey / headers / baseUrl（如 Copilot 的按账号 baseUrl）
	try {
		return { auth: await oauth.toAuth(credential), source: "OAuth" };
	} catch (error) {
		throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
	}
}

/**
 * 解析 API key 认证：委托 provider 声明的 apiKey.resolve()。
 * 存储凭据与 ambient 来源（环境变量等）在 resolve 内部按字段合并，
 * 存储值优先（credential.key ?? env("...")）。
 *
 * @param authContext 环境访问上下文（可能是叠加了 overrides.env 的视图）
 * @param apiKey provider 声明的 API key 认证实现
 * @param providerId provider 标识（用于错误信息）
 * @param credential 存储的 API key 凭据；undefined 表示纯 ambient 解析（不查存储）
 * @param signal 取消信号
 * @returns resolve 的结果；provider 未配置时为 undefined；resolve 抛错则包装为 auth 错误
 */
async function resolveApiKey(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<AuthResult | undefined> {
	try {
		return await apiKey.resolve({ ctx: authContext, credential, signal });
	} catch (error) {
		throw new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
	}
}

/**
 * 从凭据存储读取指定 provider 的凭据，存储层失败时包装为 auth 错误。
 * 读到的凭据可能已过期 —— 过期处理（OAuth 刷新等）由上层解析流程负责。
 */
async function readCredential(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Promise<Credential | undefined> {
	try {
		return await credentials.read(providerId, { signal });
	} catch (error) {
		throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
	}
}
