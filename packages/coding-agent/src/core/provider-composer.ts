/**
 * @file provider-composer.ts —— Provider 组合器：内置 Provider、models.json 用户配置
 * 与扩展（extension / SDK registerProvider）注册的自定义 Provider 三层合并
 *
 * @description
 * 本文件是 coding-agent 模型接入层的核心组装器。对一个 providerId，按以下层次叠加配置：
 * 1. base —— pi-ai 内置 Provider（内置模型列表、默认鉴权方式、流式实现）；
 * 2. models.json —— 用户在配置文件中声明的自定义模型 / 模型覆盖 / baseUrl / headers /
 *    compat / apiKey / oauth；
 * 3. extension —— SDK 扩展通过 registerProvider 注册的模型列表、OAuth 流程与自定义流式函数。
 *
 * 主要导出：
 * - {@link composeModelProvider}：三层合并的入口，产出最终 Provider（不读取凭据）；
 * - {@link validateExtensionProvider}：注册期结构校验；
 * - {@link resolveConfiguredModelHeaders} / {@link resolveCompatibilityRequestConfig}：
 *   请求期解析模型级 / provider 级 headers 与 authHeader 开关；
 * - {@link configuredRequestAuthStatus}：供 UI 展示鉴权配置状态的轻量探测。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：Provider / Model / Auth 等统一类型与 lazyStream 工具；
 * - `@earendil-works/pi-ai/compat`：按 api 名称查找通用 API Provider（流式实现兜底）；
 * - `./model-config.ts`：models.json 的类型定义（ModelsJsonProvider / ModelsJsonModel 等）；
 * - `./resolve-config-value.ts`：apiKey / headers 中 `${ENV_VAR}` 引用与命令式取值的解析。
 */
import {
	type Api,
	type ApiKeyAuth,
	type AssistantMessageEventStream,
	type AuthContext,
	type AuthInteraction,
	type AuthResult,
	type Context,
	type Credential,
	lazyStream,
	type Model,
	type ModelAuth,
	type OAuthAuth,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type Provider,
	type ProviderHeaders,
	type RefreshModelsContext,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { ModelConfig, ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "./model-config.ts";
import {
	clearConfigValueCache,
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

/**
 * 扩展（extension）自定义 Provider 的 OAuth 配置接口。
 *
 * 由 SDK 扩展实现并挂在 ProviderConfigInput.oauth 上，
 * 内部经 {@link adaptOAuth} 适配为 pi-ai 标准的 OAuthAuth。
 */
export interface ExtensionOAuthConfig {
	name: string;
	/** 该鉴权方式是否依托提供商的订阅（subscription）计费。 */
	isSubscription?: boolean;
	/** @deprecated 仅为扩展源码兼容保留；标准鉴权流程会忽略此字段。 */
	usesCallbackServer?: boolean;
	/** 发起 OAuth 登录，通过 callbacks 向用户推送授权 URL / 设备码 / 进度等交互事件。 */
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	/** 用 refresh token 换取新的凭据；signal 用于中断长时间等待。 */
	refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
	/** 从 OAuth 凭据中提取请求用的 API key。 */
	getApiKey(credentials: OAuthCredentials): string;
	/** 可选：登录完成后基于凭据调整模型列表（例如按订阅档位过滤可用模型）。 */
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

/**
 * 扩展 registerProvider API 的输入类型（ProviderConfigInput）。
 *
 * 描述扩展注册的一个 Provider：可覆盖名称 / baseUrl / 鉴权方式，
 * 也可自带完整模型列表与自定义流式实现（streamSimple）。
 * 各字段与 models.json 的同名语义对应，叠加优先级高于 models.json。
 */
export interface ProviderConfigInput {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	/** 自定义流式实现所走的 api 协议；提供 streamSimple 时必填。 */
	api?: Api;
	/** 完全替代默认流式实现的简单流函数（协议需与 api 匹配）。 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** 附加到每个请求的自定义 headers。 */
	headers?: Record<string, string>;
	/** 为 true 时把解析出的 key 以 Bearer 形式写入 Authorization 头。 */
	authHeader?: boolean;
	/** 扩展自定义 OAuth 流程（与 apiKey 二选一或并存）。 */
	oauth?: ExtensionOAuthConfig;
	/** 自定义模型列表；提供后完全替换合并层产出的模型列表。 */
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
		input: ("text" | "image")[];
		cost: Model<Api>["cost"];
		contextWindow: number;
		maxTokens: number;
		samplingParams?: Record<string, unknown>;
		headers?: Record<string, string>;
		compat?: Model<Api>["compat"];
	}>;
	refreshModels?(context: RefreshModelsContext): Promise<NonNullable<ProviderConfigInput["models"]>>;
}

/**
 * 某个 provider 的鉴权配置状态：供 /model 等命令与 UI 展示「是否已配置、来自哪里」。
 * 只做静态判断，不读取、不解析真实凭据值。
 */
export type AuthStatus = {
	configured: boolean;
	/** 来源：stored=已存凭据；runtime=运行时注入；environment=环境变量；fallback=扩展兜底字面量；models_json_key/command=models.json 中的字面量 key 或命令。 */
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	/** 展示标签，例如引用到的环境变量名列表。 */
	label?: string;
};

/** 清除 apiKey / headers 配置值的解析缓存（重导出 resolve-config-value 的实现，供配置变化后调用）。 */
export const clearApiKeyCache = clearConfigValueCache;

/**
 * 合并模型 compat 配置（base 被 override 覆盖）。
 *
 * 先做一级浅合并；对 openRouterRouting / vercelGatewayRouting / chatTemplateKwargs /
 * chatTemplateArgs 这四个「嵌套对象」字段再做一层子键合并：override 的子键覆盖同名项、
 * base 独有的子键保留——避免整对象替换导致内置默认的路由 / 模板参数丢失。
 */
function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

/**
 * 把 models.json 中某模型的 modelOverrides 覆盖项应用到既有模型定义上。
 *
 * 逐字段「有则覆盖、无则保留」：标量字段（name / reasoning / contextWindow /
 * maxTokens 等）直接替换；thinkingLevelMap / cost / samplingParams 做子键级合并，
 * compat 经 {@link mergeCompat} 合并。
 */
function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: (override.input as ("text" | "image")[] | undefined) ?? model.input,
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		compat: mergeCompat(model.compat, override.compat),
	};
}

/**
 * 依据 models.json 中的模型定义构造一个完整的 Model 对象。
 *
 * 字段取值优先级：模型级定义 > provider 级配置 > 同 id 内置模型（defaults）兜底。
 * 缺省默认：contextWindow=128000、maxTokens=16384、cost 全 0（计费未知按免费处理）、
 * input 仅 ["text"]、reasoning=false。
 *
 * @throws 未指定 api / baseUrl，或 contextWindow / maxTokens 为非正数时抛出配置错误
 */
function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
): Model<Api> {
	// api 取值优先级：模型级 > provider 级 > 内置默认
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	// baseUrl 逐级回退；自定义模型必须最终可解析出请求地址
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	// 边界校验：窗口 / 上限必须为正数，拦截配置笔误产生的不可用模型
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api as Api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: (definition.input ?? ["text"]) as ("text" | "image")[],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
	};
}

/**
 * 把 models.json 中该 provider 的配置叠加到内置模型列表上。
 *
 * 无配置则原样返回拷贝；有配置时先给全部内置模型套用 provider 级 baseUrl / compat，
 * 再逐个 upsert config.models 声明的自定义模型（同 id 覆盖、新 id 追加到末尾）。
 *
 * @throws 配置了 oauth 却缺 baseUrl，或配置块里 baseUrl / headers / compat /
 *         modelOverrides / models / apiKey / oauth / authHeader 一概未提供时抛错
 */
function applyModelsJson(
	providerId: string,
	baseModels: readonly Model<Api>[],
	config: ModelsJsonProvider | undefined,
): Model<Api>[] {
	// 未配置则原样拷贝返回，保持入参不可变
	if (!config) return [...baseModels];
	if (config.oauth && !config.baseUrl) {
		throw new Error(`Provider ${providerId}: "baseUrl" is required when "oauth" is set.`);
	}
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
		!config.oauth &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	const models: Model<Api>[] = baseModels.map((model) => ({
		...model,
		// Radius OAuth 走代理网关路由，保留内置 baseUrl；其余情况用配置的 baseUrl 覆盖
		baseUrl: config.oauth === "radius" ? model.baseUrl : (config.baseUrl ?? model.baseUrl),
		compat: mergeCompat(model.compat, config.compat),
	}));
	// upsert 语义：同 id 替换既有模型，否则追加；defaults 取被替换模型或列表首个作字段兜底
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => model.id === definition.id);
		const defaults = existingIndex >= 0 ? models[existingIndex] : models[0];
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

/**
 * 把扩展注册的 ProviderConfigInput 应用到模型列表上。
 *
 * 未提供 models 时只在配置了 baseUrl 的情况下整体改写 baseUrl；
 * 提供了 models 则完全以扩展定义的模型列表为准（仍从既有列表按同 id /
 * 首个模型借用默认值，并沿用 models.json 的 api / baseUrl 校验规则）。
 */
function applyExtension(
	providerId: string,
	models: readonly Model<Api>[],
	config: ProviderConfigInput | undefined,
): Model<Api>[] {
	if (!config) return [...models];
	if (!config.models) {
		return config.baseUrl ? models.map((model) => ({ ...model, baseUrl: config.baseUrl! })) : [...models];
	}
	// 有自定义模型列表：逐个转换，api / baseUrl 同样按「模型级 > provider 级 > 借用默认」回退
	return config.models.map((definition) => {
		const defaults = models.find((model) => model.id === definition.id) ?? models[0];
		const api = definition.api ?? config.api ?? defaults?.api;
		if (!api) {
			throw new Error(
				`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
			);
		}
		const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
		if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
		return {
			...definition,
			api,
			provider: providerId,
			baseUrl,
			headers: undefined,
		};
	});
}

/**
 * 把扩展自定义的 {@link ExtensionOAuthConfig} 适配为 pi-ai 标准的 OAuthAuth。
 *
 * 核心工作是把扩展侧基于回调对象的交互协议翻译成标准 AuthInteraction 的
 * notify / prompt 事件流（授权 URL、设备码、进度、手工粘贴授权码、选择项等）；
 * 登录与刷新的返回凭据统一补充 `type: "oauth"` 标记。
 */
function adaptOAuth(config: ExtensionOAuthConfig): OAuthAuth {
	return {
		name: config.name,
		isSubscription: config.isSubscription,
		login: async (callbacks) => {
			const credential = await config.login({
				onAuth: (info) => callbacks.notify({ type: "auth_url", ...info }),
				onDeviceCode: (info) => callbacks.notify({ type: "device_code", ...info }),
				onPrompt: (prompt) => callbacks.prompt({ type: "text", ...prompt }),
				onProgress: (message) => callbacks.notify({ type: "progress", message }),
				onManualCodeInput: () => callbacks.prompt({ type: "manual_code", message: "Paste the authorization code" }),
				onSelect: (prompt) => callbacks.prompt({ type: "select", ...prompt }),
				signal: callbacks.signal,
			});
			return { ...credential, type: "oauth" };
		},
		refresh: async (credential, signal) => ({ ...(await config.refreshToken(credential, signal)), type: "oauth" }),
		toAuth: async (credential) => ({ apiKey: config.getApiKey(credential) }),
	};
}

/**
 * 在已解析出的鉴权信息上叠加用户配置的 headers，并按需注入 Authorization 头。
 *
 * headers 合并顺序：内置 auth.headers < 用户配置 headers；
 * authHeader 为 true 时再把已解析的 apiKey 以 Bearer 形式写入 Authorization
 * （用于不走标准鉴权参数、只认请求头的网关）。
 *
 * @throws authHeader 为 true 但 auth.apiKey 尚未解析出时抛错（无法构造头）
 */
function withConfiguredAuth(
	auth: ModelAuth,
	headers: Record<string, string> | undefined,
	authHeader: boolean,
): ModelAuth {
	let mergedHeaders: ProviderHeaders | undefined =
		auth.headers || headers ? { ...auth.headers, ...headers } : undefined;
	if (authHeader) {
		if (!auth.apiKey) throw new Error("authHeader requires a resolved API key");
		mergedHeaders = { ...mergedHeaders, Authorization: `Bearer ${auth.apiKey}` };
	}
	return { ...auth, headers: mergedHeaders };
}

/** 读取用户显式配置的原始 apiKey（配置值可能是字面量 / ${ENV} 引用 / 命令式取值；扩展配置优先于 models.json）。 */
function configuredApiKey(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): string | undefined {
	return extension?.apiKey ?? config?.apiKey;
}

/** 合并 models.json 与扩展配置的 provider 级 headers（扩展侧同名字段优先）。 */
function configuredHeaders(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	if (!config?.headers && !extension?.headers) return undefined;
	return { ...config?.headers, ...extension?.headers };
}

/**
 * 收集解析配置值所需的环境变量快照。
 *
 * 对 values（apiKey / headers 等配置原文）中引用到的全部环境变量名去重，
 * 逐个通过 ctx.env 读取；explicit 已提供的值优先（视为已注入的环境）。
 * 返回 undefined 表示无需任何变量。
 */
async function configContextEnv(
	values: readonly string[],
	ctx: AuthContext,
	explicit?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
	const env = { ...explicit };
	for (const name of new Set(values.flatMap(getConfigValueEnvVarNames))) {
		if (env[name] !== undefined) continue;
		const value = await ctx.env(name);
		if (value !== undefined) env[name] = value;
	}
	return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * 组合 API key 鉴权方式：内置鉴权逻辑 + 用户配置的 key 与 headers。
 *
 * 三个回调的职责：
 * - login：优先复用内置 provider 的登录交互，否则退化为「提示输入 API key」；
 * - check：按 已存凭据 → 配置的 rawKey → 内置 check/resolve 的顺序判断是否已配置；
 * - resolve：从存储凭据或配置 key 解析出最终 apiKey，再叠加 headers / Authorization 头。
 *
 * @returns 无任何可用鉴权路径时返回 undefined（调用方据此判定该 provider 不提供 API key 方式）
 */
function composeApiKeyAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): ApiKeyAuth | undefined {
	const inherited = base?.auth.apiKey;
	const rawKey = configuredApiKey(config, extension);
	const oauth = extension?.oauth ?? base?.auth.oauth;
	// 纯 OAuth 的 provider 不伪造 API key 登录方式。
	if (!inherited && rawKey === undefined && oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		name: inherited?.name ?? "API key",
		login:
			inherited?.login ??
			(async (interaction: AuthInteraction) => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter API key" }),
			})),
		check: async (input) => {
			// ===== 分支一：已有存储凭据 =====
			if (input.credential) {
				if (inherited?.check) return inherited.check(input);
				if (input.credential.key) return { type: "api_key", source: "stored credential" };
				const resolved = await inherited?.resolve(input);
				return resolved ? { type: "api_key", source: resolved.source } : undefined;
			}
			// ===== 分支二：用户配置了 rawKey =====
			// 命令式取值无法静态判断，视为已配置；环境变量引用则要求每个变量都已存在
			if (rawKey !== undefined) {
				if (isCommandConfigValue(rawKey)) return { type: "api_key", source: "configured API key" };
				const envNames = getConfigValueEnvVarNames(rawKey);
				for (const name of envNames) {
					if ((await input.ctx.env(name)) === undefined) return undefined;
				}
				return { type: "api_key", source: "configured API key" };
			}
			// ===== 分支三：回退到内置 provider 的判断 =====
			if (inherited?.check) return inherited.check(input);
			const resolved = await inherited?.resolve(input);
			return resolved ? { type: "api_key", source: resolved.source } : undefined;
		},
		resolve: async (input) => {
			// 同样三分支：存储凭据（含命令式 key 的执行解析）/ 配置 key / 内置兜底
			let result: AuthResult | undefined;
			if (input.credential) {
				result = inherited
					? await inherited.resolve(input)
					: input.credential.key
						? { auth: { apiKey: input.credential.key }, env: input.credential.env, source: "stored credential" }
						: undefined;
			} else if (rawKey !== undefined) {
				const env = await configContextEnv([rawKey], input.ctx);
				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
				// 解析出的 key 再交给内置 resolve（例如需要换签 token 的 provider）
				result = inherited
					? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
					: { auth: { apiKey: key }, source: "configured API key" };
			} else {
				result = await inherited?.resolve(input);
			}
			if (!result) return undefined;
			// 最后把用户配置 headers 中的 ${VAR} 一并解析，并按需附加 Authorization 头
			const explicitEnv = { ...(input.credential?.env ?? {}), ...(result.env ?? {}) };
			const headerEnv = await configContextEnv(Object.values(rawHeaders ?? {}), input.ctx, explicitEnv);
			const headers = resolveHeadersOrThrow(rawHeaders, `provider "${providerId}"`, headerEnv);
			return { ...result, auth: withConfiguredAuth(result.auth, headers, authHeader) };
		},
	};
}

/**
 * 组合 OAuth 鉴权方式：优先用扩展自定义 OAuth（经 {@link adaptOAuth} 适配），
 * 否则回退内置 provider 的 OAuth；两者皆无则返回 undefined。
 *
 * 仅在 toAuth（凭据 → 请求鉴权信息）环节叠加用户配置的 headers 与 authHeader，
 * 登录 / 刷新流程本身保持原样。
 */
function composeOAuthAuth(
	providerId: string,
	base: Provider | undefined,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): OAuthAuth | undefined {
	const oauth = extension?.oauth ? adaptOAuth(extension.oauth) : base?.auth.oauth;
	if (!oauth) return undefined;
	const rawHeaders = configuredHeaders(config, extension);
	const authHeader = extension?.authHeader ?? config?.authHeader ?? false;
	return {
		...oauth,
		toAuth: async (credential) => {
			const auth = await oauth.toAuth(credential);
			const env = credential.env;
			const headers = resolveHeadersOrThrow(
				rawHeaders,
				`provider "${providerId}"`,
				typeof env === "object" && env !== null ? (env as Record<string, string>) : undefined,
			);
			return withConfiguredAuth(auth, headers, authHeader);
		},
	};
}

/**
 * 汇总某个模型在各配置层声明的模型级专属 headers（不含 provider 级）。
 *
 * 合并优先级从低到高：models.json 的 modelOverrides < models.json 模型定义 <
 * 扩展模型定义。全空时返回 undefined（表示无模型级 headers）。
 */
function rawModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	const definition = config?.models?.find((entry) => entry.id === model.id);
	const extensionModel = extension?.models?.find((entry) => entry.id === model.id);
	const headers = {
		...config?.modelOverrides?.[model.id]?.headers,
		...definition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * 注册期结构校验：验证扩展 Provider 配置能正常组装出模型列表（不读取凭据）。
 *
 * 通过「实际执行一遍合并流水线」来完成校验，配置错误会在注册 / reload 时立即抛出，
 * 而不是等到首次请求才失败。
 *
 * @throws 提供了 streamSimple 但未声明 api，或模型配置缺少 api / baseUrl 时抛错
 */
export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyExtension(providerId, applyModelsJson(providerId, base?.getModels() ?? [], modelsConfig), extension);
}

/**
 * 组合内置、models.json、扩展三层配置，产出最终 Provider（全程不读取凭据）。
 *
 * 模型列表（getModels）的构造顺序：
 * 内置 base → applyModelsJson（套用 baseUrl/compat、upsert 自定义模型）→
 * applyExtension（扩展模型替换）→ 扩展 OAuth 的 modifyModels（如按订阅过滤）→
 * modelOverrides 逐模型覆盖。
 * 鉴权由 composeApiKeyAuth / composeOAuthAuth 组合，二者至少要有其一；
 * 流式实现按「扩展 streamSimple → 内置 base → 通用 API Provider」顺序选择。
 *
 * @throws 无任何鉴权方式可用时抛错
 */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
): Provider {
	const config = modelConfig.getProvider(providerId);
	// 最近一次 OAuth 登录的扩展凭据：供 modifyModels 在 getModels 时按需调整模型列表
	let extensionOAuthCredential: OAuthCredentials | undefined;
	// refreshModels 拉取到的新模型列表；存在时覆盖扩展原始 models（热更新）
	let refreshedExtensionModels: ProviderConfigInput["models"];
	const currentExtension = (): ProviderConfigInput | undefined =>
		extension && refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;
	// models.json 的 modelOverrides 是最上层的用户配置：在自定义模型 upsert、
	// 扩展模型替换与旧版 OAuth 投影之后再统一应用一次。
	const getModels = () => {
		let models = applyExtension(
			providerId,
			applyModelsJson(providerId, base?.getModels() ?? [], config),
			currentExtension(),
		);
		if (extensionOAuthCredential && extension?.oauth?.modifyModels) {
			models = extension.oauth.modifyModels(models, extensionOAuthCredential);
		}
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override ? applyModelOverride(model, override) : model;
		});
	};
	// 立即执行一次 getModels：让注册 / reload 时就暴露结构性配置错误。
	getModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	// 流式实现选择顺序：扩展自定义 streamSimple → 内置 base（须支持该 api）→ 通用 API Provider 兜底
	const streamWith = (
		model: Model<Api>,
		context: Context,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, options as SimpleStreamOptions);
			}
			if (base && supportsBaseApi(model)) {
				return simple
					? base.streamSimple(model, context, options as SimpleStreamOptions)
					: base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple
				? api.streamSimple(model, context, options as SimpleStreamOptions)
				: api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels,
		// 有任一刷新来源（base / 扩展 / modifyModels）时才提供 refreshModels；
		// 刷新结果经 context.publish 的 update 回调原子切换，保证所有读者同时看到新列表
		refreshModels:
			base?.refreshModels || extension?.refreshModels || extension?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						// abort 后直接放弃发布，保持旧列表不变
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								if (refreshed) {
									// 发布新的同步模型列表前先验证其结构合法。
									applyExtension(providerId, applyModelsJson(providerId, base?.getModels() ?? [], config), {
										...extension,
										models: refreshed,
									});
									refreshedExtensionModels = refreshed;
								}
								extensionOAuthCredential = oauthCredential;
							},
						});
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	// 延迟流（deferred streaming）能力按需透传自 base：有才挂载
	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}

	return provider;
}

/**
 * 解析某个模型配置的专属 headers（含 `${ENV_VAR}` 展开），供请求期直接使用。
 *
 * @throws 引用的环境变量缺失时抛出指明 `provider/model` 与变量的错误
 */
export function resolveConfiguredModelHeaders(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(
		rawModelHeaders(model, config, extension),
		`model "${model.provider}/${model.id}"`,
		env,
	);
}

/** 兼容（compat）实现所需的请求配置：透传给通用 API Provider 的 headers 与 Authorization 头开关。 */
export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

/**
 * 解析 compat（兼容）请求所需的 headers 与 authHeader 开关。
 *
 * 合并 provider 级配置 headers 与模型级 headers，再叠加模型自带 headers
 * （模型自带优先级最低，可被用户配置覆盖）；供 openai-completions 等
 * 兼容实现构造请求头使用。
 */
export function resolveCompatibilityRequestConfig(
	model: Model<Api>,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

/**
 * 轻量探测该 provider 的 apiKey 配置状态（不解析、不读取真实凭据值）。
 *
 * 返回 undefined 表示用户未配置 apiKey，此时状态由存储凭据 / OAuth 决定；
 * 环境变量引用会检查进程环境是否全部就绪，未就绪返回 configured: false。
 */
export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) return undefined;
	// 命令式取值（$(cmd ...)）无法静态判断结果，直接视为已配置
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		// 环境变量引用：isConfigValueConfigured 检查当前环境中引用的变量是否全部存在
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	// 字面量 key：来自扩展的直接值标记为 fallback，来自 models.json 的标记为 models_json_key
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
