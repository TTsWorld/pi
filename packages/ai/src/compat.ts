/**
 * @file 旧版全局 pi-ai API 的兼容层（compat 入口）
 * @description 完整保留旧的全局 API 表面，供存量应用平滑迁移：
 *   - 全局 api-registry：registerApiProvider / getApiProvider / unregisterApiProviders
 *   - 按 model 分发的全局 stream / complete / streamSimple / completeSimple
 *     （内置 provider 命中 builtinModels() 实例，经 withEnvApiKey 注入环境变量密钥）
 *   - 生成的模型目录静态读取：getModel / getModels / getProviders
 *     （已标 @deprecated，指向 providers/all 的 getBuiltin* 系列）
 *   - 各 API 的 lazy stream 包装、图像生成（images / image-models）等再导出
 *
 * 存量应用只需把 import 从 "@earendil-works/pi-ai" 换成
 * "@earendil-works/pi-ai/compat"，调用代码无需改动；新代码应改用
 * `createModels()` 与各 provider 工厂。本模块将在 coding-agent 的
 * ModelManager 迁移完成后删除。
 */

// ========== 兼容表面的整体再导出 ==========
// 重新导出构成旧全局 API 的各子模块：各 API 的 lazy 包装、环境变量密钥解析stream、
// 图像模型与图像生成、images api-registry、新版主入口（index.ts）、
// 旧 API 别名（legacy-api-aliases.ts）以及内置图像 provider 注册。
export * from "./api/anthropic-messages.lazy.ts";
export * from "./api/azure-openai-responses.lazy.ts";
export * from "./api/bedrock-converse-stream.lazy.ts";
export * from "./api/google-generative-ai.lazy.ts";
export * from "./api/google-vertex.lazy.ts";
export * from "./api/mistral-conversations.lazy.ts";
export * from "./api/openai-codex-responses.lazy.ts";
export * from "./api/openai-completions.lazy.ts";
export * from "./api/openai-responses.lazy.ts";
export * from "./api/pi-messages.lazy.ts";
export * from "./env-api-keys.ts";
export * from "./image-models.ts";
export * from "./images.ts";
export * from "./images-api-registry.ts";
export * from "./index.ts";
export * from "./legacy-api-aliases.ts";
export * from "./providers/images/register-builtins.ts";

// ========== 内部依赖 ==========
// 各 api-*.lazy.ts 工厂返回惰性 ProviderStreams：厂商 SDK 在首次真正调用时才加载，
// 避免模块加载即拉起全部 SDK 依赖。
import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.ts";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
import { piMessagesApi } from "./api/pi-messages.lazy.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type { ModelsApiStreamOptions } from "./models.ts";
import { builtinModels, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.ts";

// 重导出内置 provider 名的联合类型，旧代码常用它约束泛型参数
export type { BuiltinProvider } from "./providers/all.ts";

import { createFauxCore, type FauxProviderRegistration, type RegisterFauxProviderOptions } from "./providers/faux.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.ts";

// ========== 已废弃的静态目录读取别名 ==========
// 以下三个导出直接指向 providers/all 的 getBuiltin* 系列，仅保留旧函数名。

/**
 * 按名字读取生成的内置模型目录中的单个模型
 * @deprecated 静态目录读取。请改用 "@earendil-works/pi-ai/providers/all" 的
 * `getBuiltinModel`，或 `Models.getModel()`。
 */
export const getModel = getBuiltinModel;

/**
 * 列出生成的内置模型目录中的全部（或指定 provider 的）模型
 * @deprecated 静态目录读取。请改用 "@earendil-works/pi-ai/providers/all" 的
 * `getBuiltinModels`，或 `Models.getModels()`。
 */
export const getModels = getBuiltinModels;

/**
 * 列出生成的内置模型目录中的全部 provider 名字
 * @deprecated 静态目录读取。请改用 "@earendil-works/pi-ai/providers/all" 的
 * `getBuiltinProviders`，或 `Models.getProviders()`。
 */
export const getProviders = getBuiltinProviders;

// ========== 注册表相关的统一类型 ==========

/**
 * 统一（泛型擦除后）的 stream 函数签名：接收任意 `Model<Api>` 并返回事件流
 *
 * Why：Map 的键只能是 string，无法携带泛型 Api，注册表内部统一存这种擦除形态；
 * 具体约束由 wrapStream 在每次调用时做运行时校验来恢复。
 */
export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

/**
 * 统一（泛型擦除后）的 streamSimple 函数签名：简化选项（SimpleStreamOptions）
 * 版本的快捷流式调用，语义同 ApiStreamFunction
 */
export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * 注册到全局 api-registry 的 provider 条目：一个 api id 绑定一对 stream 实现
 * @typeParam TApi 该 provider 处理的 Api 类型（如 "anthropic-messages"）
 * @typeParam TOptions stream 实现所接受的选项类型
 */
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	// 目标 Api 标识，作为注册表的键
	api: TApi;
	// 完整选项版本的流式实现
	stream: StreamFunction<TApi, TOptions>;
	// 简化选项版本的流式实现
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

/**
 * 注册表内部实际存放的 provider 形态：stream/streamSimple 均已擦除泛型并加上
 * 运行时 api 校验；外部经 getApiProvider 拿到的就是这个类型
 */
interface ApiProviderInternal {
	// 目标 Api 标识
	api: Api;
	// 带 api 校验的统一 stream 实现
	stream: ApiStreamFunction;
	// 带 api 校验的统一 streamSimple 实现
	streamSimple: ApiStreamSimpleFunction;
}

/**
 * 注册表条目：provider 本体 + 可选的来源标识（用于按来源批量注销）
 */
type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	// 注册方传入的来源标识，如 faux provider 的随机 id
	sourceId?: string;
};

// ========== 全局 api-registry ==========
// 模块级单例 Map：api id → 注册条目。所有全局 stream/complete 都经由它分发。
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

/**
 * 将强类型的 StreamFunction 包装成注册表统一的 ApiStreamFunction
 *
 * Why：注册表按 api id（string）存函数，泛型信息在注册时即被擦除；包装器在
 * 每次调用时重新校验 model.api 与注册声明的 api 一致，把编译期的类型约定
 * 恢复为运行时断言，防止 A api 的模型误走 B api 的实现。
 *
 * @param api 注册时声明的 Api 标识
 * @param stream 待包装的强类型流式实现
 * @returns 擦除泛型、带运行时 api 校验的统一 stream 函数
 */
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		// 运行时防线：api 不匹配立即抛错（类型擦除后编译器已无法保证）
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

/**
 * wrapStream 的简化选项版本：包装 streamSimple 并做同样的运行时 api 校验
 *
 * @param api 注册时声明的 Api 标识
 * @param streamSimple 待包装的强类型 streamSimple 实现
 * @returns 擦除泛型、带运行时 api 校验的统一 streamSimple 函数
 */
function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		// 同 wrapStream：运行时校验 model.api 与注册声明一致
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

/**
 * 向全局 api-registry 注册一个 API provider
 *
 * 同一 api id 重复注册会直接覆盖旧条目（Map.set 语义）。
 *
 * @param provider 含 api id 与 stream / streamSimple 实现的条目
 * @param sourceId 可选来源标识；按它调用 unregisterApiProviders 可批量注销，
 *   registerFauxProvider 即用它实现测试结束后的自动清理
 */
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			// 两个流式实现都经包装加上运行时 api 校验后再入表
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

/**
 * 按 api id 查询全局注册表
 *
 * @param api API 标识（如 "openai-responses"）
 * @returns 对应的 provider；未注册时返回 undefined
 */
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

/**
 * 列出注册表中的全部 provider（内置 + 自定义注册）
 *
 * @returns 泛型擦除后的 provider 数组
 */
export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

/**
 * 按来源标识注销该来源注册的全部 provider
 *
 * @param sourceId 注册时传入的来源标识
 */
export function unregisterApiProviders(sourceId: string): void {
	// 只移除 sourceId 匹配的条目；内置与其他来源的注册不受影响
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

// 清空整个注册表（仅供 resetApiProviders 的重置路径使用，不单独导出）
function clearApiProviders(): void {
	apiProviderRegistry.clear();
}

/**
 * 注册一个 faux（假）provider，用于测试中按脚本模拟模型响应
 *
 * 返回的句柄携带完整的响应控制接口（读取模型列表、查询状态、预设/追加响应、
 * 查询待消费响应数量）以及 unregister() —— 调用后会连同本次注册进 api-registry
 * 的条目一并清理，不影响其他注册。
 *
 * @param options faux provider 配置（预设响应、模型列表等），见 providers/faux.ts
 * @returns faux provider 注册句柄，用于控制响应与注销
 */
export function registerFauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderRegistration {
	const core = createFauxCore(options);
	// 随机 sourceId 保证多次注册互不干扰，注销时只清理自己
	const sourceId = `faux-provider-${Math.random().toString(36).slice(2, 10)}`;
	registerApiProvider({ api: core.api, stream: core.stream, streamSimple: core.streamSimple }, sourceId);
	return {
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
		// 注销本次 faux 注册（按 sourceId 反注册）
		unregister() {
			unregisterApiProviders(sourceId);
		},
	};
}

// ========== 内置 API 实现表 ==========
// 每项为 [api id, 惰性 ProviderStreams]：lazy 工厂延迟加载真正的厂商 SDK，
// 模块加载时仅建立映射，不在启动路径上拉起任何 SDK 依赖。
const BUILTIN_APIS: [Api, ProviderStreams][] = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	["pi-messages", piMessagesApi()],
];

// registerBuiltInApiProviders() 装载完成后，各内置 api 条目的引用快照。
// 用于区分"注册表里的条目仍是内置原版"与"已被测试/扩展覆盖"：
// 只有前者才允许全局 stream 走内置 Models 管线（见 getBuiltinProviderForModel）。
const builtinApiProviderInstances = new Map<Api, ReturnType<typeof getApiProvider>>();

/**
 * 将内置 API 实现注册进 api-registry，且不覆盖已有条目
 *
 * Why 不直接覆盖：compat 模块可能在某个测试或扩展已经为内置 api id 注册了
 * 覆盖实现之后才被加载，此时应保留先注册的覆盖版本，避免静默吞掉 mock。
 */
export function registerBuiltInApiProviders(): void {
	for (const [api, streams] of BUILTIN_APIS) {
		// 已有注册（很可能是覆盖/mock 实现）则跳过，不进行覆盖
		if (!getApiProvider(api)) {
			registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
		}
		// 无论本次是否真正注册，都把最终生效的条目记入快照，供后续"是否原版"判断
		builtinApiProviderInstances.set(api, getApiProvider(api));
	}
}

/**
 * 将注册表重置为"仅内置实现"的初始状态
 *
 * 清空全部条目（含自定义注册与 faux provider）后重新装载内置实现，
 * 主要供测试在用例间恢复全局状态。
 */
export function resetApiProviders(): void {
	clearApiProviders();
	builtinApiProviderInstances.clear();
	registerBuiltInApiProviders();
}

// ========== 模块加载副作用 ==========
// import 本模块即完成内置 provider 注册——这是本包三个副作用之一；
// 旧全局 API 依赖该行为：无需任何手动初始化即可直接调用 stream/complete。
registerBuiltInApiProviders();

// ========== 全局分发的鉴权与环境密钥注入 ==========
// 内置 provider 的新版 Models 实例：全局 stream 命中内置模型时优先走它
// （拥有完整的凭据解析管线，Cloudflare 等特殊鉴权也由它兜底）。
const compatModels = builtinModels();
// getEnvApiKey 对"环境级凭据已就绪"（Vertex ADC、AWS 凭据链等）返回的占位符：
// 它表示"环境已认证"，并非真实密钥，不能作为 apiKey 注入。
const AMBIENT_AUTH_MARKER = "<authenticated>";

/**
 * 判断调用方是否显式传入了可用的 API key（存在、为字符串、且非纯空白）
 *
 * @param apiKey 待检查的密钥
 * @returns 有效则收窄为 string（类型守卫）
 */
function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

/**
 * 在调用方未显式提供 apiKey 时，从环境变量解析密钥并注入 options
 *
 * 注入优先级：调用方显式传入的 apiKey > 环境变量解析结果。
 * 环境返回 AMBIENT_AUTH_MARKER（表示走环境级凭据认证、并非真实密钥）时
 * 放弃注入，交由 provider 自行完成鉴权。
 *
 * @param model 目标模型（用其 provider 名定位对应的环境变量）
 * @param options 调用方原始选项
 * @returns 需要注入时返回带 apiKey 的新 options；否则原样返回
 */
function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	// 已显式传入：用户密钥优先，不做任何环境回退
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider, options?.env);
	// 无密钥，或只是环境级凭据的占位符：保持原样，让 provider 自行鉴权
	if (!apiKey || apiKey === AMBIENT_AUTH_MARKER) return options;
	return { ...options, apiKey } as TOptions;
}

/**
 * 判断 Cloudflare 系 provider 是否已具备鉴权
 *
 * 显式 apiKey 或自定义 cf-aig-authorization 请求头任一存在即视为已鉴权；
 * 二者皆无则说明调用方未处理 Cloudflare 凭据，需要退回新版管线解析。
 *
 * @param options 调用方原始选项
 * @returns 已鉴权返回 true
 */
function hasResolvedCloudflareAuth(options: StreamOptions | undefined): boolean {
	return hasExplicitApiKey(options?.apiKey) || typeof options?.headers?.["cf-aig-authorization"] === "string";
}

/**
 * 判断模型能否走"内置 provider 直连"路径，命中则返回对应的内置 provider
 *
 * 需同时满足两个条件：
 * 1. 注册表中该 api 的条目仍是内置原版（与装载时的快照是同一引用，
 *    即未被测试/扩展覆盖）；
 * 2. 内置目录里该 provider 确实提供了此 api 的模型（防止自定义模型借道内置路径）。
 *
 * @param model 目标模型
 * @returns 命中返回内置 provider；应走自定义注册路径时返回 undefined
 */
function getBuiltinProviderForModel(model: Model<Api>) {
	// 条件 1：注册表条目与快照引用不一致 => 已被覆盖，改走注册表分发
	if (getApiProvider(model.api) !== builtinApiProviderInstances.get(model.api)) return undefined;
	// 条件 2：内置目录中该 provider 必须真的提供这个 api 的模型
	const provider = compatModels.getProvider(model.provider);
	return provider?.getModels().some((candidate) => candidate.api === model.api) ? provider : undefined;
}

/**
 * 从注册表解析 provider，未注册时抛出带 api 名的明确错误
 *
 * @param api API 标识
 * @returns 注册表中对应的 provider
 */
function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

// ========== 旧全局四入口：stream / complete / streamSimple / completeSimple ==========

/**
 * 旧全局流式入口：按模型分发到内置 Models 管线或注册表中的自定义 provider
 *
 * 分发顺序：
 * 1. 命中内置 provider，且是 Cloudflare 系但调用方未鉴权 → 走 compatModels
 *    （新版管线）。Why：Cloudflare 需要 API key + 账号/网关 ID 的组合凭据，
 *    仅靠 withEnvApiKey 注入单个 apiKey 不够，交给新版管线的凭据解析兜底；
 * 2. 命中内置 provider → 直接调 provider.stream，并注入环境变量密钥；
 * 3. 其余（api 被自定义注册/覆盖）→ 经全局 api-registry 按 model.api 分发。
 *
 * @param model 目标模型
 * @param context 对话上下文（消息历史等）
 * @param options 可选流式选项（可含 apiKey / env / headers 等）
 * @returns 助手消息事件流
 */
export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		// 分支 1：Cloudflare 且无显式鉴权 → 退回新版 Models 管线解析凭据
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			return compatModels.stream(model, context, options as ModelsApiStreamOptions<TApi> | undefined);
		}
		// 分支 2：内置直连——注入环境密钥后交给内置 provider
		return builtinProvider.stream(model, context, withEnvApiKey(model, options) as ApiStreamOptions<TApi>);
	}
	// 分支 3：自定义注册——按 model.api 从注册表分发（未注册则抛错）
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, withEnvApiKey(model, options) as StreamOptions);
}

/**
 * 旧全局非流式入口：复用 stream() 并等待事件流收敛出最终结果
 *
 * @param model 目标模型
 * @param context 对话上下文
 * @param options 可选流式选项
 * @returns 完整的助手消息（含用量、停止原因等）
 */
export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

/**
 * 旧全局简化流式入口：stream() 的 SimpleStreamOptions 版本，分发逻辑完全一致
 *
 * @param model 目标模型
 * @param context 对话上下文
 * @param options 可选简化流式选项
 * @returns 助手消息事件流
 */
export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		// 分支 1：Cloudflare 且无显式鉴权 → 退回新版 Models 管线解析凭据
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			return compatModels.streamSimple(model, context, options);
		}
		// 分支 2：内置直连——注入环境密钥后交给内置 provider
		return builtinProvider.streamSimple(model, context, withEnvApiKey(model, options));
	}
	// 分支 3：自定义注册——按 model.api 从注册表分发（未注册则抛错）
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, withEnvApiKey(model, options));
}

/**
 * 旧全局简化非流式入口：复用 streamSimple() 并等待最终结果
 *
 * @param model 目标模型
 * @param context 对话上下文
 * @param options 可选简化流式选项
 * @returns 完整的助手消息（含用量、停止原因等）
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
