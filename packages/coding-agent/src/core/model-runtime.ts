/**
 * @file model-runtime.ts —— 模型运行时：对 pi-ai 模型目录 / Provider / 认证体系的统一封装
 *
 * @description
 * 本文件实现 `ModelRuntime`：coding-agent 与 SDK 使用方共用的模型运行时门面。
 * 它实现 pi-ai 的 `Models` 接口，在其之上叠加 CLI 特有的运行时能力——
 * 本地 models.json 配置、内置 Provider 目录、扩展 Provider 注册、
 * 凭据生命周期管理与可用性快照维护。
 *
 * 主要功能点：
 * - Provider 组合（composition）：内置 Provider（builtin）+ models.json 配置（overlay）
 *   + SDK 扩展注册的 Provider（extension）按 providerId 叠加合成最终 Provider；
 *   合成失败时回退到内置版本并记录 compositionErrors；
 * - 模型目录刷新：支持网络刷新（远程目录 + models-store 缓存）与纯本地刷新，
 *   并以代次号（seq）机制防止并发刷新的旧结果覆盖新结果；
 * - 认证体系：包装 RuntimeCredentials 与 pi-ai 的 login / logout / checkAuth，
 *   同一 Provider 的凭据操作经串行队列排队执行；变更提交成功后同步本地快照，
 *   同步失败抛 CredentialSynchronizationError；
 * - 流式调用入口：stream / complete / streamSimple / fetchDeferred 等统一先经
 *   prepareRequest 合成鉴权头、环境变量与 baseUrl，再委托给底层 Provider。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：Models 接口、Provider/Model/凭据类型与 createModels 工厂；
 * - `./provider-composer.ts`：Provider 合成与请求头解析；
 * - `./runtime-credentials.ts` / `./auth-storage.ts`：运行时 API key 与文件凭据存储；
 * - `./model-config.ts`：models.json（用户级 Provider 配置）的加载；
 * - `./remote-catalog-provider.ts`：为内置 Provider 叠加远程模型目录能力。
 */

import { dirname, join } from "node:path";
import {
	type Api,
	type ApiStreamOptions,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthInteraction,
	type AuthOperationOptions,
	type AuthResult,
	type AuthType,
	type Context,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	type DeferredCancelOptions,
	type DeferredFetchOptions,
	type DeferredHandle,
	lazyStream,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	ModelsError,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsRequestTransforms,
	type ModelsSimpleStreamOptions,
	type ModelsStore,
	type MutableModels,
	type Provider,
	type ProviderHeaders,
	type ProviderRequestOptions,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import * as builtinProviderCatalog from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "../config.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { AuthStorage as DefaultAuthStorage } from "./auth-storage.ts";
import { ModelConfig } from "./model-config.ts";
import { FileModelsStore, InMemoryCodingAgentModelsStore } from "./models-store.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	composeModelProvider,
	configuredRequestAuthStatus,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
	resolveConfiguredModelHeaders,
	validateExtensionProvider,
} from "./provider-composer.ts";
import { withRemoteCatalog } from "./remote-catalog-provider.ts";
import { RuntimeCredentials } from "./runtime-credentials.ts";

/**
 * 模型运行时快照：一次可用性检查落地后的只读数据汇总。
 * 全量刷新整体替换它，单 Provider 刷新基于它增量合并；UI 与上层查询都读它。
 */
interface ModelRuntimeSnapshot {
	/** 目录中已知的全部模型（含尚未配置认证的 Provider 的模型）。 */
	all: readonly Model<Api>[];
	/** 可用模型 = all 中所属 Provider 已配置认证的部分。 */
	available: readonly Model<Api>[];
	/** checkAuth 通过（已配置认证）的 Provider 集合。 */
	configuredProviders: ReadonlySet<string>;
	/** 凭据存储中实际存有凭据的 Provider 集合。 */
	storedProviders: ReadonlySet<string>;
	/** 各 Provider 最近一次认证检查结果；undefined 表示未检查或未配置。 */
	auth: ReadonlyMap<string, AuthCheck | undefined>;
}

/**
 * `ModelRuntime.create()` 的构造选项。
 *
 * 各存储项均可注入自定义实现；默认面向 CLI 场景：凭据存到 agent 目录下的
 * auth.json，模型配置读写 models.json，模型目录缓存写入 models-store.json。
 */
export interface CreateModelRuntimeOptions {
	/** 凭据存储实现。默认使用 authPath 指向的文件。 */
	credentials?: CredentialStore;
	/** 凭据文件路径；默认 getAgentDir() 下的 auth.json。 */
	authPath?: string;
	/** models.json 配置路径；传 null 显式禁用（使用内置默认配置，不落盘）。 */
	modelsPath?: string | null;
	/** 注入的自定义模型目录缓存；缺省时按 modelsPath 是否存在选择文件或内存实现。 */
	modelsStore?: ModelsStore;
	/** 模型目录缓存文件路径；默认与 models.json 同目录的 models-store.json。 */
	modelsStorePath?: string;
	/** 允许 create() 通过网络刷新模型目录。默认 false（仅用本地缓存）。 */
	allowModelNetwork?: boolean;
	/** create() 阶段网络刷新的超时时间（毫秒）；超时中止刷新但不使 create() 失败。 */
	modelRefreshTimeoutMs?: number;
	/** 远程模型目录基址，供测试或私有部署覆盖默认下载源。 */
	catalogBaseUrl?: string;
	/** 调用方传入的中断信号，用于取消初始缓存恢复与可用性检查。 */
	signal?: AbortSignal;
	/** 跳过 create() 时的目录与可用性刷新；静态（内置）模型仍然可用。 */
	refreshOnCreate?: boolean;
}

/**
 * `getAuth()` 的覆盖参数：在 pi-ai 认证操作选项之上叠加运行时覆盖项。
 *
 * apiKey / env 用于临时覆盖已存储的凭据（例如 SDK 调用方注入自己的 key），
 * 优先级高于持久化凭据。
 */
export interface ModelRuntimeAuthOverrides extends AuthOperationOptions {
	/** 覆盖用的 API key；提供时优先于已存储凭据。 */
	apiKey?: string;
	/** 覆盖用的环境变量；会与认证解析出的 env 合并（覆盖项优先）。 */
	env?: Record<string, string>;
	/** 要求 OAuth token 剩余有效期不少于该毫秒数；默认五分钟。 */
	minOAuthValidityMs?: number;
}

/** 触发凭据状态同步的操作类型：登录 / 登出 / 设置运行时 API key / 移除运行时 API key。 */
export type CredentialSynchronizationOperation = "login" | "logout" | "setRuntimeApiKey" | "removeRuntimeApiKey";

/**
 * 凭据变更已成功提交（写入存储），但本地模型/认证快照同步失败时抛出的错误。
 *
 * 注意：此时凭据本身已经生效，只是运行时的内存视图未更新；
 * 调用方可据此提示用户，或稍后触发一次 refresh() 修复快照。
 */
export class CredentialSynchronizationError extends Error {
	/** 同步失败涉及的 Provider id。 */
	readonly providerId: string;
	/** 已提交的凭据操作类型。 */
	readonly operation: CredentialSynchronizationOperation;
	/** 操作提交后的凭据（logout / 移除 key 时为 undefined）。 */
	readonly credential: Credential | undefined;

	constructor(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		options: ErrorOptions,
	) {
		super(`Credential ${operation} committed for ${providerId}, but local synchronization failed`, options);
		this.name = "CredentialSynchronizationError";
		this.providerId = providerId;
		this.operation = operation;
		this.credential = credential;
	}
}

/**
 * 合并两组 Provider 请求头：override 中的条目覆盖 base 中的同名条目。
 *
 * HTTP 头名大小写不敏感，因此键名比较统一转小写：写入 override 条目前，
 * 先删除 base 中任意大小写变体，避免同时发出 `X-Api-Key` 与 `x-api-key` 这类重复头。
 */
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	// 两边都没有自定义头时保持 undefined，保留「无自定义头」的语义
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			// 删除 base 中同名头（任意大小写写法）
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/**
 * coding-agent 与 SDK 使用方共用的、已配置好的 pi-ai Models 集合。
 *
 * 实现了 pi-ai 的 `Models` 接口，可直接传给任何期望 Models 的 pi-ai API；
 * 在此之上额外提供：Provider 注册（registerProvider / registerNativeProvider）、
 * 可用性快照查询（getAvailableSnapshot / getError）、认证状态查询
 * 以及凭据生命周期管理（login / logout / 运行时 API key）。
 *
 * 典型生命周期：`create()` 加载配置、恢复缓存并做初始刷新 → 运行期被 UI / SDK
 * 反复查询与注册 Provider → 每次目录或凭据变更后自动增量刷新快照。
 */
export class ModelRuntime implements Models {
	/** 底层 pi-ai Models 实例：持有真正的 Provider 目录与流式调用实现。 */
	private readonly models: MutableModels;
	/** 运行时凭据管理：包装 CredentialStore，叠加进程内 API key。 */
	private readonly credentials: RuntimeCredentials;
	/** create() 传入的内置 Provider 原始目录（未被 radius 网关配置改写）。 */
	private readonly defaultBuiltins: ReadonlyMap<string, Provider>;
	/** 实际生效的内置 Provider 目录；configureRadiusProviders 会按配置改写它。 */
	private readonly builtins = new Map<string, Provider>();
	/** SDK 扩展注册的原生 Provider（完整 Provider 对象，而非配置式输入）。 */
	private readonly nativeExtensionProviders = new Map<string, Provider>();
	/** SDK 扩展注册的配置式 Provider（baseUrl / apiKey / headers 等输入）。 */
	private readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Provider 合成失败的错误信息（按 providerId），经 getError() 汇总上报。 */
	private readonly compositionErrors = new Map<string, string>();
	/** models.json 配置文件路径；undefined 表示不落盘（纯内置默认配置）。 */
	private readonly modelsPath: string | undefined;
	/** 是否允许网络刷新；未设置 PI_OFFLINE 环境变量时为 true。 */
	private readonly modelNetworkEnabled: boolean;
	/** models.json 解析出的用户级 Provider 配置。 */
	private config: ModelConfig;
	/** 当前的目录 / 可用性 / 认证快照；所有刷新路径最终都落到这里。 */
	private snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	/** 全量可用性刷新的代次号：新刷新开始时递增，在途的旧刷新据此作废自己的结果。 */
	private availabilityRefreshSeq = 0;
	/** availabilityError 的代次号：只有最新一轮刷新才有权写入或清除错误。 */
	private availabilityErrorSeq = 0;
	/** 按 Provider 记录的单点刷新代次号，语义同上。 */
	private readonly providerAvailabilitySeq = new Map<string, number>();
	/** 最近一次可用性刷新失败的错误信息（下一轮成功后被清除）。 */
	private availabilityError: string | undefined;
	/** 按 Provider 串行排队凭据操作的 Promise 链尾（见 enqueueCredentialOperation）。 */
	private readonly credentialOperations = new Map<string, Promise<unknown>>();

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.config = config;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.defaultBuiltins = new Map(providers.map((provider) => [provider.id, provider]));
		// builtins 初始与 defaultBuiltins 相同；随后可被 radius 网关配置覆盖
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		// 底层 Models 直接复用我们的凭据实现，保证两边看到同一份凭据状态
		this.models = createModels({ credentials, modelsStore });
		this.rebuildProviders();
	}

	/**
	 * 创建并初始化 ModelRuntime（唯一公开构造入口；构造函数为 private）。
	 *
	 * 步骤：解析各路径默认值 → 加载 models.json → 构建 Provider 目录
	 * （内置 Provider 叠加远程目录能力，radius 除外）→ 默认做一次目录刷新
	 * 与全量可用性检查。
	 *
	 * 网络刷新需同时满足：未设置 PI_OFFLINE（modelNetworkEnabled）且
	 * allowModelNetwork 显式为 true；modelRefreshTimeoutMs 只约束 create 期
	 * 的这次刷新，超时经 AbortController 中止，不会让 create() 本身失败。
	 */
	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const credentials = new RuntimeCredentials(options.credentials ?? DefaultAuthStorage.create(options.authPath));
		const modelsPath =
			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
		const config = await ModelConfig.load(modelsPath);
		const modelsStore =
			options.modelsStore ??
			(modelsPath
				? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))
				: new InMemoryCodingAgentModelsStore());
		const builtinModelDataGeneratedAt = builtinProviderCatalog.getBuiltinModelDataGeneratedAt();
		const providers = builtinProviderCatalog
			.builtinProviders()
			.map((provider) =>
				// radius 除外：它按用户配置动态构造（见 configureRadiusProviders）
				provider.id === "radius"
					? provider
					: withRemoteCatalog(provider, options.catalogBaseUrl, builtinModelDataGeneratedAt),
			);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			// PI_OFFLINE 未设置才允许网络刷新
			process.env.PI_OFFLINE === undefined,
		);
		runtime.configureRadiusProviders();
		runtime.rebuildProviders();
		const refreshFromNetwork = runtime.modelNetworkEnabled && options.allowModelNetwork === true;
		// 仅当确实要走网络且给了超时时才建 AbortController，避免无谓的定时器
		const controller =
			refreshFromNetwork && options.modelRefreshTimeoutMs !== undefined ? new AbortController() : undefined;
		const timeout = controller ? setTimeout(() => controller.abort(), options.modelRefreshTimeoutMs) : undefined;
		// 把调用方信号与超时信号合并；未启用超时则直接透传调用方信号
		const signal = controller
			? options.signal
				? AbortSignal.any([options.signal, controller.signal])
				: controller.signal
			: options.signal;
		try {
			if (options.refreshOnCreate !== false) {
				await runtime.refresh({ allowNetwork: refreshFromNetwork, signal });
			}
		} finally {
			// 无论刷新成败都要清掉超时定时器
			if (timeout) clearTimeout(timeout);
		}
		return runtime;
	}

	/**
	 * 重建内置 radius Provider：先恢复默认目录，再把 models.json 中声明了
	 * baseUrl 的 radius OAuth 配置逐个实例化为指向对应网关的 radius Provider。
	 */
	private configureRadiusProviders(): void {
		this.builtins.clear();
		// 先恢复出厂的内置目录，再在其上叠加用户配置的 radius 网关
		for (const [providerId, provider] of this.defaultBuiltins) this.builtins.set(providerId, provider);
		for (const providerId of this.config.getProviderIds()) {
			const config = this.config.getProvider(providerId);
			// 只处理 oauth 类型为 radius 且带网关地址的配置
			if (config?.oauth !== "radius" || !config.baseUrl) continue;
			// 剥掉 baseUrl 末尾的 /v1 或 /v1/，得到网关根地址
			this.builtins.set(
				providerId,
				builtinProviderCatalog.radiusProvider({
					id: providerId,
					name: config.name ?? providerId,
					gateway: config.baseUrl.replace(/\/v1\/?$/u, ""),
				}),
			);
		}
	}

	/** 四个来源（内置 / 原生扩展 / models.json 配置 / 配置式扩展）的 providerId 并集。 */
	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
		]);
	}

	/**
	 * 按 providerId 重新合成 Provider 并写入底层 Models 目录。
	 *
	 * 合成输入：base（原生扩展优先于内置）+ models.json 配置 + 配置式扩展，
	 * 三种结果：
	 * 1. 任何来源都不存在 → 从底层目录删除该 Provider；
	 * 2. 只有 base、无任何叠加层 → 原样使用内置 Provider；
	 * 3. 存在叠加层 → 调 composeModelProvider 合成；合成抛错则记录错误并回退 base。
	 */
	private recomposeProvider(providerId: string): void {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!base && !this.config.getProvider(providerId) && !extension) {
			// 四个来源都没有该 Provider：从底层目录移除并清掉历史合成错误
			this.models.deleteProvider(providerId);
			this.compositionErrors.delete(providerId);
			return;
		}
		if (base && !this.config.getProvider(providerId) && !extension) {
			// 没有任何叠加层：原样使用内置 Provider，保证其认证/登录/流式行为与官方实现完全一致
			this.models.setProvider(base);
			this.compositionErrors.delete(providerId);
			return;
		}
		try {
			this.models.setProvider(composeModelProvider(providerId, base, this.config, extension));
			this.compositionErrors.delete(providerId);
		} catch (error) {
			// 合成失败：记录错误供 getError() 上报，Provider 回退到内置版本（或直接删除）
			this.compositionErrors.set(providerId, error instanceof Error ? error.message : String(error));
			if (base) this.models.setProvider(base);
			else this.models.deleteProvider(providerId);
		}
	}

	/** 全量重建：清空底层目录后按 providerIds 逐个重新合成，最后刷新快照。 */
	private rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
		this.updateModelSnapshot();
	}

	/**
	 * 用底层 Models 的当前目录重建快照的 all / available 部分。
	 *
	 * 注意：认证相关字段（configuredProviders 等）沿用快照旧值——目录重建
	 * 不应使已知的认证状态丢失，它们只在可用性刷新时更新。
	 */
	private updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	/**
	 * 全量可用性刷新：并发做三件事——列出全部可用模型、逐个 Provider 认证检查、
	 * 列出已存凭据——然后整体替换快照。
	 *
	 * @param seq 本轮全量刷新的代次号；await 返回后若已过期（又有新一轮开始）则丢弃结果
	 * @param errorSeq 错误代次号；只有最新一轮才有权清除 availabilityError
	 */
	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(undefined, { signal }),
			Promise.all(
				providers.map(
					async (provider): Promise<[string, AuthCheck | undefined]> => [
						provider.id,
						await this.models.checkAuth(provider.id, { signal }),
					],
				),
			),
			this.credentials.list({ signal }),
		]);
		// 等待期间又有新一轮全量刷新开始：丢弃本轮结果，避免旧数据覆盖新数据
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(checks);
		// checkAuth 返回非 undefined 的 Provider 视为「已配置认证」
		const configuredProviders = new Set(
			checks
				.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined)
				.map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	/**
	 * 发起一轮新的全量可用性刷新（使所有在途的全量与单 Provider 刷新结果过期）。
	 *
	 * 刷新失败时：仅当本轮仍是最新一轮且不是被调用方中止，才把错误写入
	 * availabilityError；随后错误继续向上抛出。
	 */
	private queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		// 使所有在途的单 Provider 刷新结果过期（它们的代次号已落后）
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		});
	}

	/**
	 * 单个 Provider 的可用性增量刷新（凭据变更后调用，避免全量刷新的开销）。
	 *
	 * 只并发拉取该 Provider 的可用模型、认证检查与凭据读取，再基于现有快照
	 * 增量合并——其他 Provider 的数据原样保留。同样用代次号防止并发交错。
	 */
	private async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// 使本轮开始前发起的全量刷新结果过期（凭据已变，全量结果可能陈旧）
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [available, auth, credential] = await Promise.all([
				this.models.getAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			// 等待期间该 Provider 又有新的刷新发起：本轮作废
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			// 以现有快照为基础做增量合并
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			// 以 `provider\0model` 为键合并：旧快照剔除该 Provider 的模型后，换成新结果
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			// 仅当本轮仍是最新一轮、且失败不是由调用方主动中止引起时才记录错误
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = error instanceof Error ? error.message : String(error);
			}
			throw error;
		}
	}

	/** 底层目录中的全部 Provider。 */
	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}

	/** 按 id 查找 Provider；不存在返回 undefined。 */
	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}

	/** 列出全部模型，可按 Provider 过滤。 */
	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	/** 按 providerId + modelId 精确查找模型。 */
	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	/** 对单个 Provider 执行认证检查（是否已配置、凭据是否有效）。 */
	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	/**
	 * 获取可用模型。
	 *
	 * 指定 providerId 时直接透传底层查询（同时接管 availabilityError 的
	 * 写入与清除）；未指定时先触发一轮全量可用性刷新，再返回最新快照。
	 */
	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			// 单 Provider 查询：直接透传，并让本轮接管错误记录
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = error instanceof Error ? error.message : String(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.snapshot.available;
	}

	/** 最新快照中的可用模型；纯同步读取，不触发任何刷新或 IO。 */
	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.snapshot.available;
	}

	/**
	 * 汇总所有非致命错误：models.json 配置错误 + Provider 合成错误 + 可用性刷新错误。
	 * 返回 undefined 表示一切正常；多条错误以空行拼接。
	 */
	getError(): string | undefined {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		if (this.availabilityError) errors.push(`Availability refresh: ${this.availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
	}

	/** 读取扩展注册的配置式 Provider 输入（未注册返回 undefined）。 */
	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.extensionProviders.get(providerId);
	}

	/** 扩展注册的全部 providerId（配置式 + 原生，去重）。 */
	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.extensionProviders.keys(), ...this.nativeExtensionProviders.keys()])];
	}

	/** 读取扩展注册的原生 Provider 对象（未注册返回 undefined）。 */
	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.nativeExtensionProviders.get(providerId);
	}

	/** @internal 兼容回退：Provider 认证未配置时，供 ModelRegistry 使用的兼容请求配置。 */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.config.getProvider(model.provider),
			this.extensionProviders.get(model.provider),
		);
	}

	/** 该 Provider 当前是否通过 OAuth 认证（依据最近一次认证检查的快照）。 */
	isUsingOAuth(providerId: string): boolean {
		return this.snapshot.auth.get(providerId)?.type === "oauth";
	}

	/** 是否通过 OAuth 且为订阅型凭据（如 Claude Pro/Max 这类订阅身份）。 */
	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	/** 该 Provider 是否已完成认证配置（以 configuredProviders 快照判定）。 */
	hasConfiguredAuth(providerId: string): boolean {
		return this.snapshot.configuredProviders.has(providerId);
	}

	/**
	 * 获取认证解析结果（含鉴权头、apiKey、env、baseUrl 等）。
	 * 支持按 providerId 或按模型（取其所属 Provider）两种入参。
	 *
	 * 按模型获取时，会在底层解析结果之上叠加 models.json / 扩展注册中配置的
	 * 请求头：配置头与认证头按大小写不敏感规则合并，配置头优先。
	 */
	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		// 按模型获取：底层解析 + 叠加用户配置的请求头
		const resolution = await this.models.getAuth(providerOrModel, overrides);
		if (!resolution) return undefined;
		const configuredHeaders = resolveConfiguredModelHeaders(
			providerOrModel,
			this.config.getProvider(providerOrModel.provider),
			this.extensionProviders.get(providerOrModel.provider),
			{ ...(resolution.env ?? {}), ...(overrides.env ?? {}) },
		);
		return {
			...resolution,
			auth: {
				...resolution.auth,
				headers: mergeHeaders(resolution.auth.headers, configuredHeaders),
			},
		};
	}

	/**
	 * 把一个凭据操作排入该 Provider 的串行队列，防止并发登录/登出/换 key 交错执行。
	 *
	 * 语义要点：
	 * - 新操作等待同 Provider 的前一个操作落定（无论成败）后才开始；
	 * - 排队期间 signal 被 abort 时，等待立刻以 abort 失败，尚未开始的任务不会执行；
	 * - 任务一旦开始执行，其结果照常进入队列链尾，保证链式顺序不中断。
	 */
	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			// 等前一个操作落定；吞掉它的错误——串行只关心先后顺序，不传播失败
			await previous.catch(() => {});
			// 开始前再检查一次中断：排队期间被 abort 的操作直接不执行
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		// 记录链尾；若期间又入队了新操作，链尾已被替换，清理逻辑不会误删
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		// 先等到「任务真正开始」（而非仅入队成功）再返回，abort 语义才准确
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	/**
	 * 凭据变更提交后的本地同步：重合成该 Provider → 本地刷新其目录 →
	 * 更新模型快照 → 单 Provider 可用性刷新。
	 *
	 * 任一步失败都抛 CredentialSynchronizationError——凭据已提交生效，
	 * 只是运行时内存视图未同步。
	 */
	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		try {
			signal.throwIfAborted();
			this.recomposeProvider(providerId);
			// 合成失败（配置互相矛盾等）视为同步失败
			const compositionError = this.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			// 只做本地刷新：凭据刚写入，无需也不应再走网络拉目录
			const result = await this.models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			this.updateModelSnapshot();
			await this.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	/** 设置进程内运行时 API key（不落盘），提交后同步本地状态。 */
	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(
				providerId,
				"setRuntimeApiKey",
				{ type: "api_key", key: apiKey },
				signal,
			);
		});
	}

	/** 移除运行时 API key，提交后同步本地状态。 */
	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	/** 列出凭据存储中的全部凭据信息。 */
	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}

	/**
	 * 判定 Provider 的认证配置状态与来源，优先级从高到低：
	 * 运行时 API key → 已存储凭据 → models.json / 扩展注册中的显式配置 →
	 * 环境变量（依据最近一次 checkAuth 的 source）；全都没有则未配置。
	 */
	getProviderAuthStatus(providerId: string): AuthStatus {
		if (this.credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			this.config.getProvider(providerId),
			this.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}

	/**
	 * 流式调用前的统一预处理：解析认证 → 合成请求头 → 合并环境变量 →
	 * 用认证结果中的 baseUrl 覆盖模型默认地址。
	 *
	 * 请求头优先级（低到高）：认证解析头 → 调用方传入的 headers →
	 * transformHeaders 钩子改写。transformHeaders 是 Models 层的钩子，
	 * 处理后从透传给 Provider 的选项中剥除。
	 *
	 * @throws provider 不存在（ModelsError "provider"）或认证未配置（ModelsError "auth"）
	 */
	private async prepareRequest<TOptions extends ProviderRequestOptions & ModelsRequestTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{
		provider: Provider;
		model: Model<Api>;
		options: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions;
	}> {
		const provider = this.models.getProvider(model.provider);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);

		const { transformHeaders, ...rawProviderOptions } = options ?? {};
		const providerOptions = rawProviderOptions as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions;
		// 认证头（低）+ 调用方 headers（高），再交给钩子做最终改写
		let headers = mergeHeaders(resolution.auth.headers, providerOptions.headers);
		if (transformHeaders) headers = await transformHeaders(headers ?? {});
		const env =
			resolution.env || providerOptions.env
				? { ...(resolution.env ?? {}), ...(providerOptions.env ?? {}) }
				: undefined;
		return {
			provider,
			// 认证解析出 baseUrl（如自定义网关）时覆盖模型自带地址
			model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model,
			options: {
				...providerOptions,
				// 认证结果兜底：调用方未显式传 key 时使用解析出的 apiKey
				apiKey: providerOptions.apiKey ?? resolution.auth.apiKey,
				headers,
				env,
			} as Omit<TOptions, "transformHeaders"> & ProviderRequestOptions,
		};
	}

	/**
	 * 流式调用（类型化 API 版）：返回助手消息事件流。
	 * 惰性执行——直到事件流被消费才解析认证并发起真正的请求。
	 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			// 首次订阅流时才做认证解析与请求预处理
			const prepared = await this.prepareRequest(
				model,
				options as (StreamOptions & ModelsRequestTransforms) | undefined,
			);
			return prepared.provider.stream(
				prepared.model as Model<TApi>,
				context,
				prepared.options as ApiStreamOptions<TApi>,
			);
		});
	}

	/** 非流式补全：取 stream() 事件流的最终结果。 */
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	/** 流式调用（simple 版：以 SimpleStreamOptions 调用 Provider 的简化接口）。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			return prepared.provider.streamSimple(prepared.model, context, prepared.options as SimpleStreamOptions);
		});
	}

	/** 非流式补全（simple 版）：取 streamSimple() 的最终结果。 */
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	/** 拉取延迟（deferred）响应的最终结果；Provider 不支持延迟响应时抛 ModelsError。 */
	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return lazyStream(model, async () => {
			const prepared = await this.prepareRequest(model, options);
			if (!prepared.provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			return prepared.provider.fetchDeferred(prepared.model, handle, prepared.options as DeferredFetchOptions);
		}).result();
	}

	/** 取消一个延迟响应；Provider 不支持延迟响应时抛 ModelsError。 */
	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const prepared = await this.prepareRequest(model, options);
		if (!prepared.provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		await prepared.provider.cancelDeferred(prepared.model, handle, prepared.options as DeferredCancelOptions);
	}

	/**
	 * 交互式登录（OAuth / API key 等），成功后同步本地状态。
	 * 操作在该 Provider 的串行队列中执行；interaction.signal 被包装为
	 * 可随队列等待的中断信号（排队期间 abort 会让操作不执行）。
	 */
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.models.login(providerId, type, { ...interaction, signal });
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	/** 登出并删除该 Provider 的凭据，随后同步本地状态。 */
	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}

	/**
	 * 刷新模型目录（同时重新加载 models.json 配置）。
	 *
	 * 指定 options.providers 时只重合成并刷新这些 Provider，成功后逐个做
	 * 单点可用性刷新；未指定时全量重建所有 Provider 并做一次全量可用性刷新。
	 * 可用性刷新失败不会使 refresh 整体失败——错误记录在快照中，目录数据仍可用。
	 */
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		this.config = await ModelConfig.load(this.modelsPath);
		this.configureRadiusProviders();
		if (options.providers) {
			// 定向刷新：只重合成指定的 Provider
			for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
			this.updateModelSnapshot();
		} else {
			this.rebuildProviders();
		}
		const refreshOptions = {
			...options,
			// 未显式指定时回退到运行时开关（PI_OFFLINE）
			allowNetwork: options.allowNetwork ?? this.modelNetworkEnabled,
		};
		// 早期发布的 pi-ai 构建（引入 ModelsStore 之前）refresh 返回 void、且接受 provider ID 参数；
		// 该回退让源码模式下（未重建工作区依赖）的 CLI 测试仍能工作。
		const result = ((await this.models.refresh(refreshOptions)) as ModelsRefreshResult | undefined) ?? {
			aborted: refreshOptions.signal?.aborted ?? false,
			errors: new Map(),
		};
		const errors = new Map(result.errors);
		this.updateModelSnapshot();
		if (options.providers) {
			// 定向模式：逐个 Provider 做单点可用性刷新；单点失败记入 errors 而非中断
			await Promise.all(
				[...new Set(options.providers)].map(async (providerId) => {
					try {
						await this.refreshProviderAvailability(providerId, operationSignal(options.signal));
					} catch (error) {
						if (!options.signal?.aborted) {
							errors.set(providerId, error instanceof Error ? error : new Error(String(error)));
						}
					}
				}),
			);
		} else {
			try {
				await this.queueAvailabilityRefresh(options.signal);
			} catch {
				// 可用性错误已由最新一轮刷新记录；刷新出的模型目录仍然可用，故不向上抛。
			}
		}
		return { aborted: result.aborted || (options.signal?.aborted ?? false), errors };
	}

	/**
	 * 注册一个完整的原生 Provider（SDK 扩展用）。
	 * 同 id 的配置式注册会被移除；随后立即重合成该 Provider 并触发一次本地刷新。
	 */
	registerNativeProvider(provider: Provider): void {
		// 空白 id 无法寻址，直接拒绝
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.extensionProviders.delete(provider.id);
		this.nativeExtensionProviders.set(provider.id, provider);
		this.recomposeProvider(provider.id);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}

	/**
	 * 注册（或合并更新）配置式 Provider（SDK 扩展用）。
	 *
	 * 先独立校验新注册项（失败抛错且不影响已存储配置），再与上一次注册合并：
	 * 新值中显式定义的字段覆盖旧值，undefined 字段保留旧值。
	 * 若该 Provider 已有存储凭据或配置了认证，先在快照中放入临时认证条目，
	 * 让 UI 立即可见（异步刷新落地前的占位，不覆盖真实检查结果）。
	 */
	registerProvider(providerId: string, config: ProviderConfigInput): void {
		// 先独立校验新注册项（与旧版 registry 行为一致）：
		// 非法的重复注册必须直接抛错，且不能影响已存储的配置。
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// 重复注册时：显式定义的值覆盖上次注册，
		// undefined 的值保留上次注册，与旧版 ModelRegistry 的契约一致。
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		// 已有凭据或显式配置了认证：立即把该 Provider 标记为已配置，UI 无需等异步刷新
		if (
			this.snapshot.storedProviders.has(providerId) ||
			configuredRequestAuthStatus(this.config.getProvider(providerId), effective)?.configured
		) {
			const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
			const auth = new Map(this.snapshot.auth);
			// 异步刷新落地前的临时条目；绝不覆盖真实的认证检查结果。
			if (!auth.get(providerId)) {
				auth.set(providerId, {
					type: effective.oauth && !effective.apiKey ? "oauth" : "api_key",
					source: "configured provider",
				});
			}
			this.snapshot = {
				...this.snapshot,
				auth,
				configuredProviders,
				available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
			};
		}
		void this.refresh({ allowNetwork: false });
	}

	/** 注销扩展注册的 Provider（配置式与原生一并清除），随后触发一次本地刷新。 */
	unregisterProvider(providerId: string): void {
		this.extensionProviders.delete(providerId);
		this.nativeExtensionProviders.delete(providerId);
		this.recomposeProvider(providerId);
		this.updateModelSnapshot();
		void this.refresh({ allowNetwork: false });
	}
}
