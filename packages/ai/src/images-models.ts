import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ImagesOptions, ProviderImages } from "./types.ts";

/**
 * @file 新版图像集合：ImagesProvider / ImagesModels（chat 侧 Models 的镜像）。
 * @description
 * 把图像生成从「旧全局面」（image-models.ts 的全局目录 + images-api-registry.ts
 * 的全局注册表，依赖 import 副作用）迁到与 chat 侧 Models 同款的显式集合模型：
 * provider 自带 auth 语义与模型列表，集合负责 auth 解析与生成入口，
 * 无任何全局共享状态。
 *
 * 关键契约：generateImages() 一次性返回完整结果且永不 reject——
 * 任何失败都以 stopReason: "error" 的 AssistantImages 返回，
 * 调用方无需区分「成功返回」与「异常抛出」两条路径。
 */

/**
 * 图像生成 provider：chat 侧 `Provider` 在图像侧的对应物。
 * 持有 id/name 元数据、auth 配置、模型列表与生成行为。
 */
export interface ImagesProvider {
	readonly id: string;
	readonly name: string;

	/**
	 * 必填：apiKey/oauth 至少其一。语义与 chat 侧 provider 一致；
	 * provider 未配置时 `ImagesModels.getAuth()` 返回 undefined。
	 */
	readonly auth: ProviderAuth;

	/**
	 * 同步返回当前已知模型。静态 provider 直接返回目录；动态 provider
	 * 返回最近一次 `refreshModels()` 的结果（首次刷新前为空）。
	 * 约定不得抛错；实现若抛错，`ImagesModels` 视作「该 provider 无模型」。
	 */
	getModels(): readonly ImagesModel<ImagesApi>[];

	/**
	 * 仅动态 provider 需要：拉取并更新模型列表。允许 reject（如网络错误）；
	 * reject 时列表保持上次已知状态，后续调用会重试。
	 */
	refreshModels?(): Promise<void>;

	/**
	 * 执行图像生成。auth 的解析与合并由 ImagesModels.generateImages() 负责，
	 * 这里拿到的 options 已含最终的 apiKey/headers/env。
	 *
	 * @param model   - 要使用的图像模型
	 * @param context - 生成上下文（提示词等）
	 * @param options - 已合并 auth 的请求选项
	 * @returns 生成的 AssistantImages
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 图像生成 provider 的运行时集合，附带 auth 应用与生成入口：
 * chat 侧 `Models` 在图像侧的对应物，新轨的对外门面。
 * 与旧轨不同：provider 显式注册进集合，不依赖全局注册表与 import 副作用。
 */
export interface ImagesModels {
	/** 列出集合中的全部 provider。 */
	getProviders(): readonly ImagesProvider[];

	/**
	 * 按 id 查找单个 provider。
	 * @param id - provider 标识
	 * @returns 对应 provider；不存在时为 undefined
	 */
	getProvider(id: string): ImagesProvider | undefined;

	/**
	 * 同步读取单个 provider 或全部 provider 的最近已知模型。
	 * 尽力而为：`getModels()` 抛错的 provider 不贡献任何模型。
	 *
	 * @param provider - 可选 provider id；缺省时聚合全部
	 * @returns 模型数组
	 */
	getModels(provider?: string): readonly ImagesModel<ImagesApi>[];

	/**
	 * 在最近已知列表中同步查找模型。
	 * @param provider - provider id
	 * @param id       - 模型 id
	 * @returns 命中的模型；未命中时为 undefined
	 */
	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined;

	/**
	 * 让动态 provider 重新拉取模型列表。指定 provider id 时，该 provider
	 * 拉取失败会以 `ModelsError`（"model_source"）reject；不指定时并发刷新
	 * 全部 provider、尽力而为（单个失败不影响整体）。静态 provider（无
	 * `refreshModels`）为空操作。
	 *
	 * @param provider - 可选 provider id；缺省时刷新全部
	 */
	refresh(provider?: string): Promise<void>;

	/**
	 * 按 provider id 或图像模型解析请求 auth。契约与 `Models.getAuth()` 一致：
	 * 未知/未配置返回 undefined；真实失败以 `ModelsError`（"oauth"/"auth"）reject。
	 *
	 * @param providerId - provider 标识（重载入参之一）
	 * @param model      - 图像模型，取其 provider 字段（重载入参之二）
	 * @param overrides  - 请求级覆盖（显式 apiKey/env/signal）
	 * @returns auth 解析结果；未知/未配置时为 undefined
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/**
	 * 通过模型所属 provider 生成图像：先解析并合并 auth（显式选项按字段优先），
	 * 再调用 provider 的生成函数。永不 reject——失败以
	 * `stopReason: "error"` 的 `AssistantImages` 返回。
	 *
	 * @param model   - 要使用的图像模型
	 * @param context - 生成上下文（提示词等）
	 * @param options - 可选请求选项（显式字段覆盖 auth 结果）
	 * @returns 生成的 AssistantImages；失败时 stopReason 为 "error"
	 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/**
 * 可变版本的 ImagesModels：允许在运行时增删 provider。
 * createImagesModels() 返回的就是这个接口。
 */
export interface MutableImagesModels extends ImagesModels {
	/**
	 * 按 provider.id 插入或替换（provider id 唯一）。
	 * @param provider - 要注册进集合的 provider
	 */
	setProvider(provider: ImagesProvider): void;

	/**
	 * 按 id 移除 provider。
	 * @param id - provider 标识
	 */
	deleteProvider(id: string): void;

	/** 清空全部 provider（凭据与 auth 上下文保留）。 */
	clearProviders(): void;
}

/**
 * ImagesModels 的默认实现：Map 存 provider，凭据存储与 auth 上下文可注入。
 * 与 chat 侧 Models 的实现保持同构，行为契约见接口注释。
 */
class ImagesModelsImpl implements MutableImagesModels {
	private providers = new Map<string, ImagesProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	/**
	 * @param options - 可注入凭据存储与 auth 上下文；缺省用内存凭据 + 默认上下文
	 */
	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: ImagesProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly ImagesProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): ImagesProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly ImagesModel<ImagesApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			// 契约要求 getModels 不抛，这里防御式兜底：坏 provider 视作无模型，
			// 不让同步读因单个 provider 而失败。
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: ImagesModel<ImagesApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// 尽力而为：行为不端的 provider 不贡献模型，聚合其余 provider 的结果。
			}
		}
		return models;
	}

	getModel(provider: string, id: string): ImagesModel<ImagesApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	/**
	 * 单 provider 刷新：非 ModelsError 的异常统一包装成 ModelsError("model_source")，
	 * 让调用方拿到可识别的错误类型；未注册或静态 provider 静默返回。
	 */
	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		// 全量刷新不可能 reject：async mapper 会把坏 provider 的同步抛错也
		// 变成 rejection，而 allSettled 把所有 rejection 都吞掉——
		// 单个 provider 失败不中断也不影响其他 provider 的刷新（尽力而为语义）。
		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: ImagesModel<ImagesApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | ImagesModel<ImagesApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		// 两个重载在此归一：传字符串就是 provider id，传模型则取其 provider 字段。
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		// 未知 provider 视为「未配置」返回 undefined，而不是抛错（契约见接口注释）；
		// 真实的 auth 失败由 resolveProviderAuth 以 ModelsError reject。
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages> {
		// 整个流程包在 try 里：任何一步失败（未知 provider、auth reject、生成异常）
		// 都走 catch 转成 stopReason: "error" 的结果，保证「永不 reject」契约。
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			// 把请求级覆盖（显式 apiKey/env/signal）透传给 auth 解析，
			// 使显式传入的凭据优先于已配置的凭据。
			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
				signal: options?.signal,
			});
			const auth = resolution?.auth;
			// 无 auth 结果（未配置或免密 provider）：不做任何合并，原样透传。
			if (!auth) {
				return provider.generateImages(model, context, options);
			}

			// auth 解析出自定义 baseUrl 时覆盖到模型上（浅拷贝，其余字段不变）。
			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// 合并规则：显式请求选项按字段优先；headers/env 按键合并。
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.generateImages(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				output: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

/**
 * 创建一个可变的图像模型集合实例（新轨入口）。
 * 每个实例独立持有 provider 表与凭据，互不共享——与旧轨的全局注册表相反。
 *
 * @param options - 可注入凭据存储与 auth 上下文
 * @returns 可变的 ImagesModels 实例
 */
export function createImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	return new ImagesModelsImpl(options);
}

/**
 * createImagesProvider() 的入参：拼装一个图像 provider 所需的全部部件。
 */
export interface CreateImagesProviderOptions {
	/** provider 唯一标识。 */
	id: string;
	/** 展示名。缺省为 `id`。 */
	name?: string;
	/** 必填——每个 provider 都有 auth 语义，即便是免密/环境式接入。 */
	auth: ProviderAuth;
	/** 初始模型列表（纯动态 provider 传空数组）。 */
	models: readonly ImagesModel<ImagesApi>[];
	/**
	 * 动态 provider 用：拉取当前列表。成功后存下；并发调用共享同一个
	 * in-flight 请求。允许 reject：此时已存列表保持上次已知状态，rejection
	 * 传给 `refreshModels()` 的调用方（被 `ImagesModels.refresh(provider)`
	 * 包装成 ModelsError "model_source"），后续调用会重试。
	 */
	refreshModels?: () => Promise<readonly ImagesModel<ImagesApi>[]>;
	/**
	 * 按 api 分发的生成实现（结构同旧轨 images-api-registry.ts 注册的对象，
	 * 在新轨里作为 provider 的部件显式传入，而非注册到全局表）。
	 */
	api: ProviderImages;
}

/**
 * 用部件拼装一个图像生成 provider。
 * 闭包持有可变的模型列表与 in-flight 刷新句柄，实现并发去重。
 *
 * @param input - provider 的 id/name/auth/models/refreshModels/api
 * @returns 可交给 ImagesModels.setProvider() 的 ImagesProvider
 */
export function createImagesProvider(input: CreateImagesProviderOptions): ImagesProvider {
	// 闭包状态：最近已知的模型列表，refreshModels 成功后整体替换。
	let models = input.models;
	// 闭包状态：进行中的刷新请求；并发调用共享同一个 Promise，完成后清空。
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;

	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					// ??= 单飞：首次触发时创建 Promise，并发调用复用同一个，
					// 避免同时打多个相同的列表请求。
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							// 无论成败都清空句柄：失败的后续调用可以重试，
							// 成功后的下一次调用发起新一轮拉取。
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		generateImages: (model, context, options) => input.api.generateImages(model, context, options),
	};
}
