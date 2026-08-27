/**
 * @file 模型运行时核心：Provider（模型提供方）与 Models（模型集合）的定义及默认实现。
 * @description
 * 本文件是多厂商 AI SDK（@earendil-works/pi-ai）的模型运行时主逻辑：
 * - `Provider` 是具体的运行时单元，持有 id/name/baseUrl 元数据、鉴权方式
 *   （apiKey/oauth）、模型目录以及 stream/streamSimple 等流式行为；
 * - `Models`（默认实现 `ModelsImpl`）是 Provider 的运行时集合，负责凭据存取、
 *   鉴权解析（applyAuth）、模型目录刷新（refresh，含代际作废与发布串行化），
 *   并把每个请求分派给拥有该模型的 Provider；
 * - `createProvider` 用声明式配置组装 Provider（内置 Provider 工厂与
 *   models.json 自定义 Provider 都经过它）；`createModels` 创建可变集合实例；
 * - 工具函数：`hasApi` 类型收窄、`calculateCost` 用量计费、
 *   `getSupportedThinkingLevels` / `clampThinkingLevel` 思考档位换算、
 *   `modelsAreEqual` 模型相等比较。
 */
import { lazyStream } from "./api/lazy.ts";
import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	ProviderAuth,
} from "./auth/types.ts";
import { InMemoryModelsStore, type ModelsStore, type ModelsStoreEntry } from "./models-store.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	Model,
	ModelCostRates,
	ModelThinkingLevel,
	ProviderHeaders,
	ProviderRequestOptions,
	ProviderStreams,
	SimpleStreamOptions,
	Usage,
} from "./types.ts";
import { operationSignal, raceWithAbortSignal } from "./utils/abort.ts";

// 重新导出鉴权解析错误类型，调用方只需从本模块导入
export { ModelsError, type ModelsErrorCode } from "./auth/resolve.ts";

/**
 * 一次模型目录「发布」动作：由 Provider 在 refreshModels 阶段挑选要持久化的内容。
 */
export interface ModelsPublication {
	/** Provider 选定并要持久化的目录条目；省略表示保持存储不变，传 null 表示删除。 */
	persist?: ModelsStoreEntry | null;
	/** 可选的同步回调：只更新 Provider 私有的内存目录状态。 */
	update?: () => void;
}

/**
 * 传给 Provider.refreshModels 的刷新上下文：包含有效凭据、持久化快照、
 * 受代际（generation）保护的 publish() 发布通道，以及联网/中止控制。
 */
export interface RefreshModelsContext {
	/** 当前生效的凭据；OAuth 凭据会在访问网络前先完成刷新。 */
	credential?: Credential;
	/** 本次刷新阶段开始前捕获的、该 Provider 作用域内的不可变目录快照。 */
	stored?: Readonly<ModelsStoreEntry>;
	/**
	 * 经过代际（generation）校验的发布通道。持久化策略仍归 Provider 所有；
	 * update 回调只在选定的持久化变更落地之后才会同步执行。
	 */
	publish(publication: ModelsPublication): Promise<boolean>;
	/** 离线 / 仅用缓存初始化时为 false，禁止任何网络访问。 */
	allowNetwork: boolean;
	/** 允许联网时，跳过 Provider 自身的新鲜度检查、立即发起抓取。 */
	force?: boolean;
	/** 中止信号；始终存在——即使公开的 refresh 调用方没传 signal。 */
	signal: AbortSignal;
}

/** `Models.refresh()` 的可选参数。 */
export interface ModelsRefreshOptions {
	/** 是否允许联网抓取；默认 true。为 false 时只做本地缓存恢复。 */
	allowNetwork?: boolean;
	/** 只刷新这些 provider id；未知与静态 Provider 会被忽略。 */
	providers?: readonly string[];
	/** 允许联网时，跳过 Provider 的新鲜度检查、立即抓取。 */
	force?: boolean;
	/** 调用方的中止信号。 */
	signal?: AbortSignal;
}

/** `Models.refresh()` 的结果：是否被中止，以及按 provider id 索引的错误表。 */
export interface ModelsRefreshResult {
	/** 整体刷新是否被调用方的 signal 中止。 */
	aborted: boolean;
	/** 各 Provider 刷新失败的原因（key 为 provider id）。 */
	errors: ReadonlyMap<string, Error>;
}

/** 仅在 Models 层生效的请求变换钩子（不透传给 Provider 内部实现）。 */
export interface ModelsRequestTransforms {
	/** 在 model/auth/request 请求头全部组装完成、即将分派给 Provider 之前做最终变换。 */
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
}

// 在各流式选项类型之上叠加 Models 层的请求变换钩子
export type ModelsApiStreamOptions<TApi extends Api> = ApiStreamOptions<TApi> & ModelsRequestTransforms;
export type ModelsSimpleStreamOptions = SimpleStreamOptions & ModelsRequestTransforms;
export type ModelsDeferredFetchOptions = DeferredFetchOptions & ModelsRequestTransforms;
export type ModelsDeferredCancelOptions = DeferredCancelOptions & ModelsRequestTransforms;

/**
 * Provider 是具体的运行时单元：持有 id/name/base 元数据、鉴权方式、
 * 模型列表以及流式调用行为。
 *
 * 泛型 `TApi` 让具体的 Provider 工厂可以声明其模型使用哪些 API
 * （例如 `openaiProvider(): Provider<"openai-responses" | "openai-completions">`），
 * 使直接使用工厂的调用方拿到带类型的模型列表。而在 `Models` 集合内部，
 * Provider 统一以 `Provider<Api>` 的形式保存。
 */
export interface Provider<TApi extends Api = Api> {
	/** Provider 唯一标识（Models 集合按它注册/替换）。 */
	readonly id: string;
	/** 展示名称。 */
	readonly name: string;

	/** 该 Provider 的默认 API 基地址（可被凭据解析结果覆盖）。 */
	readonly baseUrl?: string;
	/** 该 Provider 的默认附加请求头。 */
	readonly headers?: ProviderHeaders;

	/**
	 * 必填：至少提供 `apiKey`/`oauth` 之一。每个 Provider 都有鉴权语义——
	 * 即使是只有环境凭据（环境变量、AWS profile、ADC 文件）或免密本地服务，
	 * 也要提供 `apiKey` 鉴权，其 `resolve()` 负责报告该 Provider 是否已配置。
	 * `Models.getAuth()` 在 Provider 未配置时返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * 当前已知模型列表（同步）。静态 Provider 直接返回目录；动态 Provider
	 * 返回上一次 `refreshModels()` 之后的结果（首次刷新前为空）。
	 * 不允许抛错；`Models` 会把抛错的实现视为没有模型。
	 */
	getModels(): readonly Model<TApi>[];

	/**
	 * 仅动态 Provider 需要：恢复 `context.stored`，并可用有效凭据抓取更新的
	 * 列表。实现约定：失败时保留旧列表；持久化与同步状态变更一律通过
	 * `context.publish()` 发布；阻塞工作必须遵守共享的中止信号。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<void>;

	/**
	 * 可选：按凭据过滤模型可见性的 Provider 策略。
	 * `getModels()` 始终是完整的同步目录；`Models.getAvailable()`
	 * 在确认该 Provider 鉴权已配置后，才会应用此过滤器。
	 */
	filterModels?(models: readonly Model<TApi>[], credential: Credential | undefined): readonly Model<TApi>[];

	/** 全功能流式调用：返回助手消息事件流。 */
	stream<T extends TApi>(
		model: Model<T>,
		context: Context,
		options?: ApiStreamOptions<T>,
	): AssistantMessageEventStream;

	/** 简化流式调用：使用与具体 API 形态无关的通用选项。 */
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	/** 拉取一个延迟（后台）响应的最终结果；不支持延迟响应的 Provider 可省略。 */
	fetchDeferred?(
		model: Model<TApi>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	/** 取消一个延迟（后台）响应；不支持延迟响应的 Provider 可省略。 */
	cancelDeferred?(model: Model<TApi>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

/**
 * Provider 的运行时集合，附加鉴权应用与流式调用便捷方法。
 * 流式行为归 Provider 所有；`Models` 负责解析鉴权，
 * 并把每个请求委托给拥有该模型的 Provider。
 */
export interface Models {
	/** 所有已注册的 Provider。 */
	getProviders(): readonly Provider[];
	/** 按 id 查找 Provider；不存在时返回 undefined。 */
	getProvider(id: string): Provider | undefined;

	/**
	 * 同步读取单个 Provider（传 provider id）或全部 Provider 最近已知的模型。
	 * 尽力而为：`getModels()` 抛错的 Provider 不贡献任何模型。
	 */
	getModels(provider?: string): readonly Model<Api>[];

	/**
	 * 基于最近已知列表的同步运行时模型查找。动态模型列表的类型是
	 * `Model<Api>`；需要收窄类型时使用 `hasApi()` 类型守卫。
	 */
	getModel(provider: string, id: string): Model<Api> | undefined;

	/**
	 * 并发刷新选中的、已配置的动态 Provider（不传 `providers` 时刷新全部）。
	 * Provider 报错与取消都不会让整体 reject，而是放进结果返回；
	 * 静态、未知与未配置的 Provider 会被跳过。
	 */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;

	/** 检查某 Provider 的鉴权配置是否完整；不会刷新 OAuth 令牌。 */
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined>;

	/** 返回其 Provider 鉴权配置完整的那些模型。 */
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;

	/**
	 * 按 provider id 解析该 Provider 作用域的鉴权；传入模型时则解析
	 * Provider 鉴权并叠加模型的静态请求头。结果带一个来源标签供状态 UI 使用。
	 * Provider 未知或未配置时返回 undefined。
	 * 以 `ModelsError` reject：令牌刷新失败时 code 为 "oauth"
	 * （已存储的凭据会保留以便重试；重新登录可修复），api-key 解析或
	 * 凭据存储失败时 code 为 "auth"。请求路径会把 reject 转为流错误。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	/** 同上，但传入模型：额外把模型的静态 headers 合并进鉴权头。 */
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/** 执行 Provider 自带的登录流程，并持久化其返回的凭据。 */
	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;

	/** 删除某 Provider 已存储的凭据。 */
	logout(providerId: string, options?: AuthOperationOptions): Promise<void>;

	/** 全功能流式调用（本层先完成鉴权解析与请求组装，再委托给 Provider）。 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream;

	/** stream 的 Promise 便捷版：等待流结束并返回完整的 AssistantMessage。 */
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage>;

	/** 简化流式调用（SimpleStreamOptions），同样走统一鉴权路径。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	/** streamSimple 的 Promise 便捷版。 */
	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
	/** 拉取一个延迟（后台）响应的最终结果。 */
	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage>;
	/** 取消一个延迟（后台）响应。 */
	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void>;
}

/** 在只读 `Models` 之上支持运行时增删 Provider 的可变集合。 */
export interface MutableModels extends Models {
	/** 按 provider.id 插入或替换（Provider id 唯一）。 */
	setProvider(provider: Provider): void;
	/** 删除指定 id 的 Provider。 */
	deleteProvider(id: string): void;
	/** 清空所有 Provider。 */
	clearProviders(): void;
}

/** `createModels()` 的可选依赖注入项；全部缺省时使用内存实现。 */
export interface CreateModelsOptions {
	/** 凭据存储；默认 InMemoryCredentialStore。 */
	credentials?: CredentialStore;
	/** 模型目录持久化存储；默认 InMemoryModelsStore。 */
	modelsStore?: ModelsStore;
	/** 鉴权上下文（环境变量等解析来源）；默认 defaultAuthContext()。 */
	authContext?: AuthContext;
}

/**
 * 合并两组 Provider 请求头：`override` 中的同名头覆盖 `base` 中的。
 * 头名比较不区分大小写（HTTP 头语义本就如此），因此写入 `override` 的新头前
 * 会先移除 `base` 中仅大小写不同的同名旧头，避免同一个头出现两个变体。
 * @param base 基础头（通常是鉴权解析结果或 Provider 默认头）
 * @param override 覆盖头（通常是请求 options 里显式传入的头）
 * @returns 合并出的新对象；两组都为空时返回 undefined
 */
function mergeHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged = { ...base };
	for (const [name, value] of Object.entries(override ?? {})) {
		// HTTP 头名大小写不敏感：先清掉 base 里大小写不同但同名的旧头，再写入新头
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

/**
 * `Models` / `MutableModels` 的默认实现。
 *
 * 三个核心机制：
 * - 刷新代际（refreshGenerations）：setProvider/deleteProvider 等集合变更会
 *   递增 provider 的代际号并中止在途刷新，防止旧结果回头覆盖新状态；
 * - 发布链（publicationChains）：同一 provider 的目录持久化严格按提交顺序
 *   串行执行，避免并发刷新交错写存储；
 * - 请求路径（stream/complete/...）：统一走 requireProvider → applyAuth，
 *   在惰性流被真正消费时才做鉴权解析与请求头组装。
 */
class ModelsImpl implements MutableModels {
	// ========== 内部状态 ==========
	/** 已注册的 Provider，按 id 索引。 */
	private providers = new Map<string, Provider>();
	/** 凭据存储。 */
	private credentials: CredentialStore;
	/** 模型目录持久化存储。 */
	private modelsStore: ModelsStore;
	/** 鉴权上下文（提供环境变量等解析来源）。 */
	private authContext: AuthContext;
	/** 每个 provider 的刷新代际号：用于作废过期的在途刷新/发布。 */
	private refreshGenerations = new Map<string, number>();
	/** 每个 provider 当前在途刷新的 AbortController：被 supersede 时中止。 */
	private refreshControllers = new Map<string, AbortController>();
	/** 每个 provider 的发布任务链尾：保证目录写入按提交顺序串行。 */
	private publicationChains = new Map<string, Promise<unknown>>();

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	// ========== Provider 集合管理（MutableModels） ==========

	setProvider(provider: Provider): void {
		// 先作废该 provider 的在途刷新再注册新实例，防止旧刷新回头覆盖
		this.supersedeProviderRefresh(provider.id);
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		// 同上：移除前先中止在途刷新
		this.supersedeProviderRefresh(id);
		this.providers.delete(id);
	}

	clearProviders(): void {
		// 取「已注册 id」与「仅有在途刷新控制的 id」的并集，避免残留控制器
		for (const id of new Set([...this.providers.keys(), ...this.refreshControllers.keys()])) {
			this.supersedeProviderRefresh(id);
		}
		this.providers.clear();
	}

	// ========== 同步读取 ==========

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		// 指定 provider：只取该 provider 的列表；未知 provider 视为空
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		// 未指定：聚合所有 provider；单个 provider 抛错只影响它自己
		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// 尽力而为：行为异常的 provider 不贡献任何模型
			}
		}
		return models;
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	// ========== 刷新代际与发布串行化 ==========

	/**
	 * 作废某 provider 的在途刷新：递增代际号并中止当前控制器。
	 * 此后按旧代际号提交的发布会被 publishProviderModels 拒绝。
	 * @returns 新的代际号
	 */
	private supersedeProviderRefresh(providerId: string): number {
		const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
		this.refreshGenerations.set(providerId, generation);
		const previous = this.refreshControllers.get(providerId);
		if (previous) {
			this.refreshControllers.delete(providerId);
			previous.abort();
		}
		return generation;
	}

	/**
	 * 开始一轮新的 provider 刷新：作废旧刷新并登记新的 AbortController。
	 * @returns 新的代际号与对应的控制器
	 */
	private beginProviderRefresh(providerId: string): { generation: number; controller: AbortController } {
		const generation = this.supersedeProviderRefresh(providerId);
		const controller = new AbortController();
		this.refreshControllers.set(providerId, controller);
		return { generation, controller };
	}

	/**
	 * 处理一次目录发布请求（Provider 经 RefreshModelsContext.publish 调到这里）。
	 *
	 * 串行化：把发布任务接到该 provider 的发布链尾部，保证同一 provider 的
	 * 存储写入严格按提交顺序执行，不被并发刷新交错。
	 *
	 * 代际校验：写入前后各检查一次「signal 未中止且代际号仍一致」，
	 * 过期发布直接返回 false，Provider 据此放弃后续动作（保留旧列表）。
	 *
	 * @returns 是否成功发布（false 表示已过期或被中止）
	 */
	private publishProviderModels(
		providerId: string,
		generation: number,
		signal: AbortSignal,
		publication: ModelsPublication,
	): Promise<boolean> {
		const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			// 等待链上上一个发布完成（忽略其错误，本任务自行决定成败）
			await previous.catch(() => {});
			// 写入前校验：过期/已中止的发布不再落盘
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;

			// 持久化策略由 Provider 决定：null 删除条目，有条目则写入，省略则不动存储
			if (publication.persist === null) {
				await this.modelsStore.delete(providerId, { signal });
			} else if (publication.persist !== undefined) {
				// structuredClone 做快照隔离：内存态与持久化态不共享可变引用
				await this.modelsStore.write(providerId, structuredClone(publication.persist), { signal });
			}

			// 写入后再次校验，通过后才同步更新 Provider 的内存目录
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;
			publication.update?.();
			return true;
		})();
		// 记录新的链尾；吞掉错误保证链不会因单次失败而断掉
		const tail = queued.catch(() => {});
		this.publicationChains.set(providerId, tail);
		void tail.then(() => {
			// 链尾仍是自己时才清理登记，避免 Map 无限增长
			if (this.publicationChains.get(providerId) === tail) this.publicationChains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	/**
	 * 执行某 provider 的一轮刷新阶段（缓存恢复与联网抓取共用）：
	 * 从存储读出该 provider 的目录快照（structuredClone 隔离），
	 * 连同凭据与发布通道一起交给 provider.refreshModels 处理。
	 */
	private async runProviderRefreshPhase(
		provider: Provider & Required<Pick<Provider, "refreshModels">>,
		credential: Credential | undefined,
		allowNetwork: boolean,
		force: boolean | undefined,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		const stored = await this.modelsStore.read(provider.id, { signal });
		await provider.refreshModels({
			credential,
			stored: stored ? structuredClone(stored) : undefined,
			publish: (publication) => this.publishProviderModels(provider.id, generation, signal, publication),
			allowNetwork,
			force: allowNetwork ? force : undefined,
			signal,
		});
	}

	/**
	 * 并发刷新动态 Provider 的模型目录（Models.refresh 的实现）。
	 *
	 * 每个 provider 分两阶段：
	 * 1. 离线阶段：先用已存凭据恢复缓存目录（即使凭据读取失败也先恢复）；
	 * 2. 联网阶段：解析（必要时刷新 OAuth）出有效凭据后抓取最新目录。
	 * 每个阶段各自带代际号校验，被 supersede 的旧轮次会静默作废。
	 *
	 * @returns 是否被调用方 signal 中止 + 各 provider 的错误表（整体不会 reject）
	 */
	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		// operationSignal：调用方没传 signal 时也保证有可用的 AbortSignal
		const callerSignal = operationSignal(options.signal);
		const errors = new Map<string, Error>();
		if (callerSignal.aborted) return { aborted: true, errors };
		// 只挑选：实现了 refreshModels 且（若指定了 providers）在名单内的动态 Provider
		const selected = options.providers ? new Set(options.providers) : undefined;
		const refreshable = Array.from(this.providers.values()).filter(
			(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
				provider.refreshModels !== undefined && (!selected || selected.has(provider.id)),
		);

		const refresh = Promise.all(
			refreshable.map(async (provider) => {
				// 每个 provider 的刷新有独立的代际号与控制器
				const { generation, controller } = this.beginProviderRefresh(provider.id);
				// 合并调用方信号与 supersede 控制器信号：任一触发即中止本轮
				const signal = AbortSignal.any([callerSignal, controller.signal]);
				const operation = (async () => {
					let storedCredential: Credential | undefined;
					let credentialError: unknown;
					try {
						storedCredential = await this.readCredential(provider.id, signal);
					} catch (error) {
						// 凭据读取失败先记下：优先恢复缓存目录，之后再抛出该错误
						credentialError = error;
					}

					// 在解析鉴权/访问网络之前，先用缓存恢复 provider 状态（离线阶段）
					await this.runProviderRefreshPhase(provider, storedCredential, false, undefined, generation, signal);
					if (credentialError !== undefined) throw credentialError;
					if (!allowNetwork || signal.aborted) return;

					// 联网阶段：解析出有效凭据（必要时刷新 OAuth），再抓取最新目录
					const credential = await this.resolveRefreshCredential(provider, storedCredential, signal);
					if (!credential) return;
					await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);
				})();

				try {
					await raceWithAbortSignal(operation, signal);
				} catch (error) {
					// 只有非中止导致的失败才计入错误表；中止属于正常作废
					if (!signal.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
				} finally {
					// 清理控制器登记（仅当未被更新的刷新取代时）
					if (this.refreshControllers.get(provider.id) === controller) {
						this.refreshControllers.delete(provider.id);
					}
				}
			}),
		);

		try {
			await raceWithAbortSignal(refresh, callerSignal);
		} catch (error) {
			// 调用方中止不算错误，直接落入下方的 aborted 返回
			if (!callerSignal.aborted) throw error;
		}

		return { aborted: callerSignal.aborted, errors: new Map(errors) };
	}

	/**
	 * 为联网刷新阶段解析出有效凭据。
	 *
	 * OAuth：未过期直接复用；已过期则在凭据存储的 modify 临界区内刷新令牌
	 * （进入临界区后 double-check 当前值，避免并发重复刷新），结果写回存储，
	 * 且只接受仍为 oauth 类型的返回值。
	 *
	 * API key：调用 provider.auth.apiKey.resolve（可从环境变量等来源获取）。
	 *
	 * @returns 可用凭据；取不到时返回 undefined（该轮跳过联网刷新）
	 */
	private async resolveRefreshCredential(
		provider: Provider,
		stored: Credential | undefined,
		signal: AbortSignal,
	): Promise<Credential | undefined> {
		if (stored?.type === "oauth") {
			const oauth = provider.auth.oauth;
			if (!oauth) return undefined;
			// 仍在有效期内：直接复用，省一次网络往返
			if (Date.now() < stored.expires) return stored;
			if (signal.aborted) return undefined;
			// modify 提供互斥：并发刷新下只有一个调用真正执行 oauth.refresh
			const post = await this.credentials.modify(
				provider.id,
				async (current) => {
					// double-check：排队期间可能已被并发刷新续期
					if (current?.type !== "oauth" || Date.now() < current.expires) return undefined;
					return oauth.refresh(current, signal);
				},
				{ signal },
			);
			return post?.type === "oauth" ? post : undefined;
		}

		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		const credential = stored?.type === "api_key" ? stored : undefined;
		const result = await apiKey.resolve({ ctx: this.authContext, credential, signal });
		if (!result) return undefined;
		return { type: "api_key", key: result.auth.apiKey, env: result.env };
	}

	/** 读取 provider 的已存凭据；存储失败时包装为 ModelsError("auth") 抛出。 */
	private async readCredential(providerId: string, signal: AbortSignal): Promise<Credential | undefined> {
		try {
			return await this.credentials.read(providerId, { signal });
		} catch (error) {
			throw new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		}
	}

	/**
	 * 检查 provider 鉴权是否配置完整（checkAuth / getAvailable 共用）。
	 * 判定顺序：已存 OAuth 凭据 → provider 自带的 apiKey.check 专用钩子 →
	 * 通用 resolveProviderAuth 兜底解析。返回 undefined 表示未配置。
	 */
	private async checkProviderAuth(
		provider: Provider,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<AuthCheck | undefined> {
		if (credential?.type === "oauth") {
			// 有已存 OAuth 凭据且 provider 支持 OAuth：视为已配置
			return provider.auth.oauth ? { source: "OAuth", type: "oauth" } : undefined;
		}
		const apiKey = provider.auth.apiKey;
		if (!apiKey) return undefined;
		if (apiKey.check) {
			// Provider 提供了专用检查钩子：委托给它（失败包装为 ModelsError 抛出）
			try {
				return await apiKey.check({
					ctx: this.authContext,
					credential: credential?.type === "api_key" ? credential : undefined,
					signal,
				});
			} catch (error) {
				throw new ModelsError("auth", `API key auth check failed for provider ${provider.id}`, { cause: error });
			}
		}

		// 兜底：走通用解析（环境变量等来源），只保留来源标签
		const resolution = await resolveProviderAuth(provider, this.credentials, this.authContext, { signal });
		return resolution ? { source: resolution.source, type: "api_key" } : undefined;
	}

	/** 检查某 provider 鉴权是否配置完整；不会触发 OAuth 令牌刷新。 */
	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = operationSignal(options?.signal);
		const check = (async () => {
			signal.throwIfAborted();
			const provider = this.providers.get(providerId);
			if (!provider) return undefined;
			return this.checkProviderAuth(provider, await this.readCredential(providerId, signal), signal);
		})();
		return raceWithAbortSignal(check, signal);
	}

	/** 返回鉴权已配置完整的 provider 的模型（并应用 provider 的 filterModels 过滤）。 */
	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			signal.throwIfAborted();
			// 未指定 providerId 时检查全部 provider
			const providers = providerId
				? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
				: this.getProviders();
			const checks = await Promise.all(
				providers.map(async (provider) => {
					const credential = await this.readCredential(provider.id, signal);
					return { provider, credential, auth: await this.checkProviderAuth(provider, credential, signal) };
				}),
			);
			// 只保留鉴权检查通过的 provider，再按凭据过滤其模型列表
			return checks.flatMap(({ provider, credential, auth }) => {
				if (!auth) return [];
				const models = provider.getModels();
				return provider.filterModels?.(models, credential) ?? models;
			});
		})();
		return raceWithAbortSignal(available, signal);
	}

	/**
	 * 解析鉴权（重载一：按 provider id；重载二：传模型，额外合并模型静态头）。
	 * 完整语义与错误码见 Models 接口上 getAuth 的注释。
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: Model<Api>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | Model<Api>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const signal = operationSignal(overrides?.signal);
		// Model 输入时取其 provider 字段；string 输入即 provider id 本身
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, { ...overrides, signal });
		// string 输入、解析失败或模型没有静态头：直接返回解析结果
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		// Model 输入：把模型自带的静态头叠加到鉴权头之上（模型头优先）
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	/**
	 * 执行 provider 自带的登录流程并持久化返回的凭据。
	 *
	 * 持久化竞态处理：credentials.modify 是串行互斥的，可能需要排队等锁。
	 * 为避免「排队期间被 signal 中止、但凭据最终还是被写入」（或反之丢失），
	 * 用 mutationStarted 标记 modify 临界区是否已真正开始执行：
	 * - 中止发生在临界区开始前 → 立刻 reject，不再写入；
	 * - 中止发生在临界区开始后 → 等待写入完成，保证登录成果不丢。
	 */
	async login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		signal.throwIfAborted();
		const provider = this.providers.get(providerId);
		if (!provider) throw new ModelsError("provider", `Unknown provider: ${providerId}`);
		// 按 type 选择 OAuth 或 API key 登录方法
		const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
		if (!method?.login) {
			throw new ModelsError("auth", `${provider.name} does not support ${type} login`);
		}
		const loginOperation: Promise<Credential> = method.login({ ...interaction, signal });
		const credential = await raceWithAbortSignal(loginOperation, signal);
		// ========== 持久化：处理与 abort 的竞态 ==========
		let mutationStarted = false;
		let markMutationStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markMutationStarted = resolve;
		});
		const mutation = this.credentials.modify(
			providerId,
			async () => {
				// 已进入临界区：此后即使中止也让写入完成，避免凭据丢失
				mutationStarted = true;
				markMutationStarted?.();
				return credential;
			},
			{ signal },
		);
		// 提前挂 catch 吞掉未等待分支的 rejection；错误由下方 await mutation 统一处理
		void mutation.catch(() => {});
		try {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					// 仅当临界区尚未开始时，才把中止当作错误抛出
					if (!mutationStarted) reject(signal.reason);
				};
				signal.addEventListener("abort", onAbort, { once: true });
				// started 与 mutation 任一先落定即放行
				void Promise.race([started, mutation]).then(
					() => {
						signal.removeEventListener("abort", onAbort);
						resolve();
					},
					(error: unknown) => {
						signal.removeEventListener("abort", onAbort);
						reject(error);
					},
				);
				if (signal.aborted) onAbort();
			});
			await mutation;
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
		}
		return credential;
	}

	/** 删除 provider 的已存凭据；存储失败时包装为 ModelsError("auth") 抛出。 */
	async logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		const signal = operationSignal(options?.signal);
		signal.throwIfAborted();
		try {
			await this.credentials.delete(providerId, { signal });
		} catch (error) {
			signal.throwIfAborted();
			throw new ModelsError("auth", `Credential store delete failed for ${providerId}`, { cause: error });
		}
	}

	/** 取得拥有该模型的 provider；未注册时抛 ModelsError("provider")。 */
	private requireProvider(model: Model<Api>): Provider {
		const provider = this.providers.get(model.provider);
		if (!provider) {
			throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
		}
		return provider;
	}

	/**
	 * 请求路径的鉴权应用：为即将发出的请求组装最终模型与请求选项。
	 *
	 * 合并优先级（后者覆盖前者）：
	 * 1. 凭据解析出的鉴权结果（apiKey / headers / env / baseUrl）；
	 * 2. 请求 options 的显式字段（apiKey、headers 逐字段覆盖）；
	 * 3. Models 层独有的 transformHeaders 钩子最后运行，可整体改写头。
	 *
	 * baseUrl 以解析结果优先：凭据指定了 baseUrl 时克隆模型并覆盖。
	 * env 为浅合并（两边都为空时保持 undefined，避免传空对象）。
	 *
	 * @returns requestModel（可能带 baseUrl 覆盖的模型）与已注入
	 *          apiKey/headers/env、去掉了 transformHeaders 的 requestOptions
	 */
	private async applyAuth<TOptions extends ProviderRequestOptions & ModelsRequestTransforms>(
		model: Model<Api>,
		options: TOptions | undefined,
	): Promise<{
		requestModel: Model<Api>;
		requestOptions: Omit<TOptions, "transformHeaders"> & ProviderRequestOptions;
	}> {
		this.requireProvider(model);
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) {
			// Provider 未配置鉴权：无法发出请求
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// 显式请求字段逐项优先；Models 层的 transform 最后执行
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		// 凭据解析出 baseUrl 时，克隆模型并覆盖其自带值
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		// transformHeaders 是 Models 层钩子，剥离后不透传给 Provider
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as Omit<TOptions, "transformHeaders"> &
			ProviderRequestOptions;

		return { requestModel, requestOptions };
	}

	// ========== 请求路径：惰性流 + 鉴权应用 + Provider 分派 ==========

	/**
	 * 全功能流式调用。用 lazyStream 包裹：只有在流被真正消费时才解析鉴权、
	 * 组装请求并分派给 Provider——未消费的流不产生任何副作用。
	 */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(
				model,
				options as ModelsApiStreamOptions<Api> | undefined,
			);
			return provider.stream(requestModel as Model<TApi>, context, requestOptions as ApiStreamOptions<TApi>);
		});
	}

	/** stream 的 Promise 版：等待流结束并返回完整的 AssistantMessage。 */
	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	/** 简化流式调用（SimpleStreamOptions），同样惰性启动并走统一鉴权路径。 */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
		});
	}

	/** streamSimple 的 Promise 版。 */
	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	/**
	 * 拉取延迟（后台）响应的最终结果；Provider 不支持延迟响应时抛
	 * ModelsError("provider")。鉴权应用后委托给 provider.fetchDeferred。
	 */
	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			if (!provider.fetchDeferred) {
				throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
			}
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.fetchDeferred(requestModel, handle, requestOptions as DeferredFetchOptions);
		}).result();
	}

	/** 取消延迟（后台）响应；Provider 不支持时抛 ModelsError("provider")。 */
	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		const provider = this.requireProvider(model);
		if (!provider.cancelDeferred) {
			throw new ModelsError("provider", `Provider ${model.provider} does not support deferred responses`);
		}
		const { requestModel, requestOptions } = await this.applyAuth(model, options);
		await provider.cancelDeferred(requestModel, handle, requestOptions);
	}
}

/**
 * 创建一个可变的 `Models` 运行时集合（默认使用全内存的凭据/目录存储）。
 * @param options 可选注入：凭据存储、模型目录存储、鉴权上下文
 * @returns MutableModels 实例
 */
export function createModels(options?: CreateModelsOptions): MutableModels {
	return new ModelsImpl(options);
}

/** `createProvider()` 的声明式输入。 */
export interface CreateProviderOptions<TApi extends Api = Api> {
	/** Provider 唯一 id。 */
	id: string;
	/** 展示名；默认取 `id`。 */
	name?: string;
	/** 默认 API 基地址。 */
	baseUrl?: string;
	/** 默认附加请求头。 */
	headers?: ProviderHeaders;
	/** 必填——每个 Provider 都有鉴权语义，即便是环境凭据/免密场景。 */
	auth: ProviderAuth;
	/** 静态基线模型列表（纯动态 Provider 传空数组）。 */
	models: readonly Model<TApi>[];
	/** 抓取动态模型覆盖层的钩子；createProvider 负责事务式恢复与发布。 */
	fetchModels?: (context: RefreshModelsContext) => Promise<readonly Model<TApi>[]>;
	/** 按凭据过滤模型的策略（透传为 Provider.filterModels）。 */
	filterModels?: (models: readonly Model<TApi>[], credential: Credential | undefined) => readonly Model<TApi>[];
	/** 单一流实现，或按 `model.api` 键控的映射（混合 API 的 Provider 用后者）。 */
	api: ProviderStreams | Partial<Record<TApi, ProviderStreams>>;
}

/**
 * 用声明式 parts 组装一个 Provider。内置 Provider 工厂与 models.json
 * 自定义 Provider 都经过这里。传入单一 `api` 时所有模型共用同一套流实现；
 * 传入 `api` 映射时按 `model.api` 分派，模型对应的 api 没有条目时
 * 产生流错误（在流被消费时抛出，而非调用点同步抛出）。
 */
export function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi> {
	// ========== 模型目录：静态基线 + 动态覆盖层 ==========
	const baselineModels = input.models;
	// 动态抓取到的覆盖层：按 id 覆盖基线中的同名模型，其余追加
	let dynamicModels: readonly Model<TApi>[] = [];
	const fetchModels = input.fetchModels;
	const currentModels = (): readonly Model<TApi>[] => {
		// 合并规则：动态列表中的模型按 id 替换基线同名模型，不在基线的追加到末尾
		const merged = [...baselineModels];
		for (const model of dynamicModels) {
			const index = merged.findIndex((entry) => entry.id === model.id);
			if (index >= 0) merged[index] = model;
			else merged.push(model);
		}
		return merged;
	};
	// ========== API 分派：单一实现或按 model.api 键控 ==========
	// 判别方式：api 上直接挂有 stream 函数 → 单一实现；否则视为映射表
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	/** 取模型对应的流实现：单一实现优先，否则查映射表。 */
	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	/**
	 * 分派器：找到实现则执行 run；找不到则返回惰性报错流——
	 * 错误延迟到流被消费时才抛出，保持与正常路径一致的错误暴露时机。
	 */
	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};

	const provider: Provider<TApi> = {
		id: input.id,
		name: input.name ?? input.id,
		baseUrl: input.baseUrl,
		headers: input.headers,
		auth: input.auth,
		getModels: currentModels,
		refreshModels: fetchModels
			? async (context) => {
					// 阶段 1（离线）：恢复上次持久化的目录（只保留属于本 provider 的模型）
					if (context.stored) {
						const restored = context.stored.models
							.filter((model) => model.provider === input.id)
							.map((model) => model as Model<TApi>);
						if (
							!(await context.publish({
								update: () => {
									dynamicModels = restored;
								},
							}))
						) {
							// 发布被作废（本轮刷新已过期/被中止）：直接放弃
							return;
						}
					}
					// 阶段 2（联网）：抓取最新列表并发布（持久化 + 更新内存态）
					if (!context.allowNetwork || context.signal.aborted) return;
					const refreshed = await fetchModels(context);
					if (context.signal.aborted) return;
					await context.publish({
						persist: { models: refreshed, checkedAt: Date.now() },
						update: () => {
							dynamicModels = refreshed;
						},
					});
				}
			: undefined,
		filterModels: input.filterModels,
		stream: (model, context, options) => dispatch(model, (streams) => streams.stream(model, context, options)),
		streamSimple: (model, context, options) =>
			dispatch(model, (streams) => streams.streamSimple(model, context, options)),
	};

	// ========== 延迟（后台）响应能力：仅当至少一个流实现支持时才在 provider 上暴露 ==========
	const streams = single ? [single] : Object.values(byApi ?? {}).filter((entry) => entry !== undefined);
	if (streams.some((entry) => entry.fetchDeferred !== undefined)) {
		// 有任一实现支持 fetchDeferred：暴露统一入口，对不支持的 api 惰性报错
		provider.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async () => {
				const implementation = apiFor(model);
				if (!implementation?.fetchDeferred) {
					throw new ModelsError(
						"provider",
						`Provider ${input.id} does not support deferred responses for "${model.api}"`,
					);
				}
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	if (streams.some((entry) => entry.cancelDeferred !== undefined)) {
		// 同上：cancelDeferred
		provider.cancelDeferred = async (model, handle, options) => {
			const implementation = apiFor(model);
			if (!implementation?.cancelDeferred) {
				throw new ModelsError(
					"provider",
					`Provider ${input.id} cannot cancel deferred responses for "${model.api}"`,
				);
			}
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return provider;
}

/**
 * 对动态查到的模型做运行时类型收窄（type guard）：
 *
 * ```ts
 * const model = models.getModel("anthropic", "claude-opus-4-7");
 * if (model && hasApi(model, "anthropic-messages")) {
 *   // model: Model<"anthropic-messages">，流式选项获得完整类型
 * }
 * ```
 */
export function hasApi<TApi extends Api>(model: Model<Api>, api: TApi): model is Model<TApi> {
	return model.api === api;
}

/**
 * 按模型费率与用量计算费用，就地填充 `usage.cost` 各分项并返回。
 *
 * 费率均为「每百万 token」单价；选择阶梯档位时的输入量口径 =
 * input + cacheRead + cacheWrite（缓存读写同样按 token 计）。
 * 支持阶梯计费（tiers）：取「门槛不高于该输入量且门槛最高」的档位。
 *
 * @param model 提供费率的模型
 * @param usage 用量；函数会写入 usage.cost 的各字段
 * @returns 填充完成的 usage.cost
 */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	// 计费口径的输入量包含缓存读写：用于选择阶梯档位
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 从基础费率出发，选出满足门槛（inputTokens > inputTokensAbove）的最高档
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic 对 1 小时 TTL 的缓存写入按基础输入价的 2 倍计费
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	// 各分项除以 1e6：费率是「每百万 token」单价
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/** 全部思考档位，按强度从低到高排列（clampThinkingLevel 查找顺序的依据）。 */
const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 返回模型支持的思考档位列表。
 *
 * 规则：模型不支持推理（无 reasoning）时只有 "off"；否则在全集上过滤——
 * thinkingLevelMap 显式映射为 null 的档位被禁用；"xhigh"/"max" 两个扩展
 * 档位必须被显式映射才可用（其余档位默认可用）。
 */
export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		// 显式映射为 null：该档位被禁用
		if (mapped === null) return false;
		// xhigh/max 为扩展档位：必须显式映射才可用
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/**
 * 把请求的思考档位收敛（clamp）到模型实际支持的档位。
 *
 * 模型支持时原样返回；否则从请求档位出发，先向更高强度找最近的可用档
 * （向上取整），找不到再向更低强度回退，最终兜底为列表首项或 "off"。
 */
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	// 非法档位名：直接取最低可用档兜底
	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	// 优先向上取整：找不低于请求强度的最近可用档
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	// 向上没有可用档：再向下回退
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * 判断两个模型是否相等：同时比较 id 与 provider。
 * 任一为 null 或 undefined 时返回 false。
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
