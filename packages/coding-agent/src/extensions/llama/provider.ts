import type {
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Model,
	Provider,
	ProviderStreamOptions,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";
import { LlamaClient, type LlamaModelInfo, llamaInferenceUrl, normalizeLlamaServerUrl } from "./client.ts";

/**
 * @file provider.ts —— 把本地 llama.cpp 服务端注册为 pi-ai Provider
 *
 * @description
 * 本文件定义 provider id `llama.cpp`，并通过 createLlamaProvider 构造一个
 * OpenAI 兼容（openai-completions API）的 Provider：模型目录来自 llama.cpp 服务端，
 * 推理请求直接复用 pi-ai 的通用 stream/streamSimple 实现（服务端自带 /v1 兼容端点）。
 *
 * 主要功能点：
 * - toPiModel：把 llama.cpp 目录条目转换为 pi Model（上下文窗口、输入模态、兼容开关等）；
 * - modelIsSelectable：过滤出可切换的模型（已加载/休眠恒可选；autoload 开启时的
 *   未加载预设模型也可选）；
 * - API Key 凭据流：login 交互式收集服务器地址与可选密钥并验证连通性，
 *   check/resolve 从存储凭据或 LLAMA_BASE_URL 环境变量解析出可用配置；
 * - refreshModels：优先恢复上次持久化的目录；允许联网时实时拉取并重新持久化。
 *
 * 依赖关系：
 * - @earendil-works/pi-ai：Provider/Model/Auth 类型与通用流式实现（compat）；
 * - ./client.ts：LlamaClient（连通性验证、目录拉取）与 URL 归一化工具。
 */

/** 注册到模型系统中的 provider id。 */
export const LLAMA_PROVIDER_ID = "llama.cpp";
/** 未配置任何地址时假定的默认 llama.cpp 服务器地址（本机 8080 端口）。 */
export const DEFAULT_LLAMA_SERVER_URL = "http://127.0.0.1:8080";

/** 从凭据 env 中读取并归一化 LLAMA_BASE_URL；缺失或为空白时返回 undefined。 */
function credentialServerUrl(credential: ApiKeyCredential | undefined): string | undefined {
	const value = credential?.env?.LLAMA_BASE_URL;
	return typeof value === "string" && value.trim() ? normalizeLlamaServerUrl(value) : undefined;
}

/**
 * 解析 llama.cpp 服务器地址：优先凭据 env 中的 LLAMA_BASE_URL，
 * 其次回退到进程环境变量 LLAMA_BASE_URL；均未配置时返回 undefined。
 */
async function resolveServerUrl(
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
): Promise<string | undefined> {
	const configured = credentialServerUrl(credential) ?? (await ctx.env("LLAMA_BASE_URL"))?.trim();
	return configured ? normalizeLlamaServerUrl(configured) : undefined;
}

/**
 * 判断目录中的模型能否作为可选模型暴露给用户：
 * 已加载模型恒可选；休眠（sleeping）模型收到请求会被自动唤醒，同样可选；
 * 未加载的预设模型只有在 router 开启 autoload（首次使用自动加载）时才可选。
 */
function modelIsSelectable(model: LlamaModelInfo, routerAutoload: boolean): boolean {
	if (model.status.value === "loaded") return true;
	// llama.cpp 把空闲自动休眠的模型报告为 "sleeping"；请求会自动唤醒它们。
	if (model.status.value === "sleeping") return true;
	// 未加载的预设模型只有在 llama.cpp router 允许 autoload 首次使用时加载的情况下才可被路由。
	return routerAutoload && model.status.value === "unloaded" && !model.status.failed && model.source === "preset";
}

/**
 * 目录中存在未加载的预设模型时，查询 /props 判断 router 是否开启 models_autoload。
 * 查询失败按「未开启」处理（保守策略：宁可少暴露模型，也不暴露无法加载的项）。
 */
async function routerAutoloadEnabled(
	client: LlamaClient,
	catalog: readonly LlamaModelInfo[],
	signal: AbortSignal,
): Promise<boolean> {
	if (!catalog.some((model) => model.status.value === "unloaded" && model.source === "preset")) return false;
	try {
		return (await client.props({ signal })).models_autoload === true;
	} catch {
		return false;
	}
}

/**
 * 把 llama.cpp 目录条目转换为 pi 的 Model 定义。
 * 兼容开关按 llama.cpp 的 OpenAI 端点裁剪：不支持 store / developer role / 推理力度，
 * max_tokens 字段用旧名；上下文窗口缺失时回退 128000；成本恒为 0（本地推理不产生费用）。
 */
function toPiModel(model: LlamaModelInfo, serverUrl: string): Model<"openai-completions"> {
	// 优先用运行时上下文 n_ctx，其次训练长度 n_ctx_train；两者缺失或非法时回退保守默认值
	const reportedContextWindow = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	const contextWindow = reportedContextWindow && reportedContextWindow > 0 ? reportedContextWindow : 128000;
	return {
		id: model.id,
		name: model.id,
		api: "openai-completions",
		provider: LLAMA_PROVIDER_ID,
		baseUrl: llamaInferenceUrl(serverUrl),
		reasoning: false,
		input: model.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: contextWindow,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		},
	};
}

/**
 * Provider 控制器：除 Provider 本身外还暴露 setCatalog，
 * 供 /llama 命令在目录变化（加载/卸载/下载）时即时热更新可选模型列表。
 */
export interface LlamaProviderController {
	provider: Provider<"openai-completions">;
	setCatalog(models: readonly LlamaModelInfo[], serverUrl: string, options?: { routerAutoload?: boolean }): void;
}

/**
 * 创建 llama.cpp Provider 及其目录控制器。
 * 闭包内的 models 数组是 Provider 对外暴露的可选模型快照：
 * refreshModels 负责恢复持久化目录或联网拉取，setCatalog 由扩展侧在用户操作后即时写入。
 */
export function createLlamaProvider(): LlamaProviderController {
	let models: readonly Model<"openai-completions">[] = [];

	/** 用最新目录重建可选模型快照：先按可选择性过滤，再逐个转换为 pi Model。 */
	const setCatalog = (
		catalog: readonly LlamaModelInfo[],
		serverUrl: string,
		options: { routerAutoload?: boolean } = {},
	): void => {
		models = catalog
			.filter((model) => modelIsSelectable(model, options.routerAutoload === true))
			.map((model) => toPiModel(model, serverUrl));
	};

	const provider: Provider<"openai-completions"> = {
		id: LLAMA_PROVIDER_ID,
		name: "llama.cpp",
		baseUrl: llamaInferenceUrl(DEFAULT_LLAMA_SERVER_URL),
		auth: {
			apiKey: {
				name: "llama.cpp server",
				login: async (interaction): Promise<ApiKeyCredential> => {
					const enteredUrl = await interaction.prompt({
						type: "text",
						message: "llama.cpp server URL",
						placeholder: process.env.LLAMA_BASE_URL ?? DEFAULT_LLAMA_SERVER_URL,
					});
					const serverUrl = normalizeLlamaServerUrl(
						enteredUrl.trim() || process.env.LLAMA_BASE_URL || DEFAULT_LLAMA_SERVER_URL,
					);
					// 密钥可选：llama.cpp 默认不启用鉴权，留空即匿名访问
					const apiKey = (
						await interaction.prompt({
							type: "secret",
							message: "API key (optional)",
						})
					).trim();
					// 用输入的地址实际拉取一次目录，尽早验证连通性与 router 模式，避免保存无效配置
					await new LlamaClient(serverUrl, apiKey || undefined).list({ signal: interaction.signal });
					return {
						type: "api_key",
						key: apiKey || undefined,
						env: { LLAMA_BASE_URL: serverUrl },
					};
				},
				check: async ({ ctx, credential }) => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					return serverUrl
						? { type: "api_key", source: credential ? "stored credential" : "LLAMA_BASE_URL" }
						: undefined;
				},
				resolve: async ({ ctx, credential }): Promise<AuthResult | undefined> => {
					const serverUrl = await resolveServerUrl(ctx, credential);
					if (!serverUrl) return undefined;
					// 密钥逐级回退：存储凭据 → LLAMA_API_KEY 环境变量 → 占位符 "local"
					//（服务端未鉴权时只需要非空值即可通过通用请求层）
					const apiKey = credential?.key ?? (await ctx.env("LLAMA_API_KEY")) ?? "local";
					return {
						auth: { apiKey, baseUrl: llamaInferenceUrl(serverUrl) },
						env: { ...credential?.env, LLAMA_BASE_URL: serverUrl },
						source: credential ? "stored credential" : "LLAMA_BASE_URL",
					};
				},
			},
		},
		getModels: () => models,
		refreshModels: async (context: RefreshModelsContext): Promise<void> => {
			// 阶段一：恢复上次持久化的模型目录，离线或服务器未启动时也能列出模型
			if (context.stored) {
				const restored = context.stored.models.filter(
					(model): model is Model<"openai-completions"> =>
						model.provider === LLAMA_PROVIDER_ID && model.api === "openai-completions",
				);
				if (
					!(await context.publish({
						update: () => {
							models = restored;
						},
					}))
				) {
					return;
				}
			}

			// 阶段二：联网实时拉取目录；离线模式、已取消或凭据并非 API Key 时到此为止
			if (!context.allowNetwork || context.signal.aborted || context.credential?.type !== "api_key") return;
			const serverUrl = credentialServerUrl(context.credential);
			if (!serverUrl) return;
			const client = new LlamaClient(serverUrl, context.credential.key);
			const catalog = await client.list({ signal: context.signal });
			if (context.signal.aborted) return;
			const routerAutoload = await routerAutoloadEnabled(client, catalog, context.signal);
			if (context.signal.aborted) return;
			const refreshed = catalog
				.filter((model) => modelIsSelectable(model, routerAutoload))
				.map((model) => toPiModel(model, serverUrl));
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions | undefined),
		streamSimple: (model, context, options) => streamSimple(model, context, options),
	};

	return { provider, setCatalog };
}
