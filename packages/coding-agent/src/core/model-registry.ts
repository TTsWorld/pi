/**
 * @file model-registry.ts —— 面向扩展的模型注册表同步兼容门面
 *
 * @description
 * ModelRegistry 是暴露给扩展 API 的同步门面：内部把所有调用委托给
 * ModelRuntime，仅保留旧版同步接口形态。coding-agent 内部代码
 * 应直接使用 ModelRuntime，不要经由本类。
 *
 * 覆盖能力：模型列表/查询、认证解析（API key / OAuth / 自定义 headers）、
 * provider 注册与注销、以及 complete() 的一次补全调用。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：Model / Provider / Context 等类型；
 * - `./model-runtime.ts`：实际承载全部逻辑的运行时；
 * - `./provider-composer.ts`：ProviderConfigInput / AuthStatus 类型与缓存清理。
 */
import type {
	Api,
	AssistantMessage,
	AuthResult,
	Context,
	Model,
	ModelsApiStreamOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	Provider,
	ProviderHeaders,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "./model-runtime.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";

export type { ProviderConfigInput } from "./provider-composer.ts";
/** 一次请求的认证解析结果：成功时携带密钥/headers/baseUrl/env，失败时携带错误信息。 */
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };
export { clearApiKeyCache } from "./provider-composer.ts";

/**
 * 暴露给扩展的同步兼容门面。
 * coding-agent 内部请直接使用 ModelRuntime。
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	/** 异步重载 models.json。同步读取注册表之前必须先 await 本方法。 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	/** 最近一次刷新的错误信息；无错误时为 undefined。 */
	getError(): string | undefined {
		return this.runtime.getError();
	}

	/** 返回注册表中全部模型的副本。 */
	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	/** 返回「当前已配置认证、可用」模型快照的副本。 */
	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	/** 按 provider + modelId 精确查找模型。 */
	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/** 该模型所属 provider 是否已配置认证。 */
	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	/**
	 * 解析发起一次模型请求所需的认证信息（API key、headers、baseUrl、env）。
	 * 始终以 ResolvedRequestAuth 返回而不抛错，便于调用方按 ok 分支处理。
	 */
	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				// 无认证解析结果：若兼容配置要求 authHeader 则视为缺 key 报错，
				// 否则仅携带兼容 headers 放行（如无需认证的本地端点）
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			// 优先透出 error.cause 中的底层信息（OAuth 刷新失败等常包在 cause 里）
			const cause = error instanceof Error ? error.cause : undefined;
			const message =
				cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error:
					// 把内部的底层报错翻译成面向用户的「缺 API key」提示
					message === "authHeader requires a resolved API key"
						? `No API key found for "${model.provider}"`
						: message,
			};
		}
	}

	/** 查询指定 provider 的认证状态（已配置 / 未配置 / 状态明细）。 */
	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	/** 获取 provider 对象（含其 displayName、模型定义等）。 */
	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** 执行一次补全调用（流式选项可选），返回完整的 assistant 消息。 */
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	/** provider 的展示名；未注册时回退为 provider id 本身。 */
	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	/** 获取 provider 的认证解析结果（含 OAuth 等）。 */
	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	/** 便捷方法：只取 provider 的 API key；解析失败时返回 undefined 而非抛错。 */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		try {
			return (await this.runtime.getAuth(provider))?.auth.apiKey;
		} catch {
			return undefined;
		}
	}

	/** 该模型的 provider 是否走 OAuth 认证。 */
	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	/**
	 * 注册 provider，支持两种形态（重载实现）：
	 * 传入 Provider 对象注册「原生 provider」；
	 * 传入名称 + 配置注册「配置式 provider」。
	 */
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	/** 注销按名称注册的 provider。 */
	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	/** 读取配置式 provider 的注册配置；未注册时为 undefined。 */
	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	/** 读取原生 provider 的注册对象；未注册时为 undefined。 */
	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	/** 已注册 provider 的 id 只读列表。 */
	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
