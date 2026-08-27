/**
 * @file packages/ai 的核心类型定义文件(全包的「类型中枢」)
 * @description
 * 本文件集中定义这个多厂商 AI SDK 的公共类型契约,主要导出分六大块:
 *
 * 1. 标识体系:KnownApi/Api(线协议家族)、KnownProvider/ProviderId(厂商/渠道),
 *    以及图像生成侧的 KnownImagesApi/KnownImagesProvider 等;
 * 2. 请求与流式选项:ProviderRequestOptions(认证/HTTP/生命周期回调基类)、
 *    StreamOptions(采样/缓存/传输/会话)、SimpleStreamOptions(带统一推理等级的简化入口),
 *    以及按 API 精确分发的 ApiOptionsMap/ApiStreamOptions 与 ProviderStreams 模块契约;
 * 3. 消息协议:UserMessage/AssistantMessage/ToolResultMessage 三类消息、
 *    AssistantMessageEvent 流式事件协议、DeferredHandle 延迟响应句柄;
 * 4. 内容块/工具/上下文:TextContent、ThinkingContent、ImageContent、ToolCall、
 *    Tool、ConstrainedSamplingConfig、Context,以及图像生成的 ImagesContext/AssistantImages;
 * 5. provider 兼容性开关(compat)与路由偏好:OpenAICompletionsCompat、OpenAIResponsesCompat、
 *    AnthropicMessagesCompat、BedrockCompat、OpenRouterRouting、VercelGatewayRouting;
 * 6. 统一模型目录与计费:Model、ImagesModel、ModelCost/ModelCostTier。
 *
 * 依赖方向:被 src/api/ 下各 provider 适配层、src/index.ts 公共导出面以及
 * 上层 coding-agent / agent 等包广泛引用;改动字段语义前需全仓检索影响面。
 */

// 以下均为 type-only import:编译产物中会被完全擦除,不影响 tree-shaking 与运行时体积
import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import type { BedrockOptions } from "./api/bedrock-converse-stream.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { PiMessagesOptions } from "./api/pi-messages.ts";
import type { AssistantMessageDiagnostic } from "./utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// 便捷再导出:流事件流的类型,调用方无需直接深入 utils/event-stream.ts
export type { AssistantMessageEventStream } from "./utils/event-stream.ts";

// ========== 第一部分:API / provider 标识体系 ==========

/**
 * SDK 内置支持的 API 类型(指「线协议家族」,而非厂商品牌)。
 * 每种 API 在 src/api/ 下都有同名实现模块,导出统一的 stream/streamSimple 契约;
 * 同一厂商可能同时暴露多种 API(如 OpenAI 兼容服务器走 openai-completions,
 * 官方 Responses 接口走 openai-responses,微软托管版走 azure-openai-responses)。
 */
export type KnownApi =
	| "openai-completions"
	| "mistral-conversations"
	| "openai-responses"
	| "azure-openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "pi-messages";

/**
 * 任意 API 标识:交叉 `(string & {})` 是常用技巧,既保留 KnownApi 的
 * 自动补全与悬浮文档,又允许传入自定义字符串(用户自建 API 适配层)。
 */
export type Api = KnownApi | (string & {});

/** 内置支持的图像生成 API 类型(目前仅 OpenRouter Images)。 */
export type KnownImagesApi = "openrouter-images";

/** 任意图像生成 API 标识,同样允许自定义字符串扩展。 */
export type ImagesApi = KnownImagesApi | (string & {});

/**
 * SDK 内置认识的 provider(厂商或接入渠道)清单。
 * provider 决定认证方式、默认 baseUrl 与模型目录归属;它与 API 类型正交,
 * 例如 openrouter 这个 provider 可同时服务多种线协议的模型。大致分组见下方行内注释。
 */
export type KnownProvider =
	// —— 头部厂商直连 / 云厂商托管 ——
	| "amazon-bedrock"
	| "ant-ling"
	| "anthropic"
	| "google"
	| "google-vertex"
	| "openai"
	| "azure-openai-responses"
	| "openai-codex"
	| "radius"
	| "nvidia"
	| "deepseek"
	| "github-copilot"
	| "xai"
	| "groq"
	| "cerebras"
	// —— 聚合网关 / 路由层 ——
	| "openrouter"
	| "vercel-ai-gateway"
	// —— 欧洲与国内厂商直连(mistral / zai / minimax / moonshot,-cn 为国内端点) ——
	| "zai"
	| "zai-coding-cn"
	| "mistral"
	| "minimax"
	| "minimax-cn"
	| "moonshotai"
	| "moonshotai-cn"
	// —— 推理云 / 模型托管平台 ——
	| "huggingface"
	| "fireworks"
	| "together"
	| "baseten"
	// —— 编码场景订阅类接入 ——
	| "opencode"
	| "opencode-go"
	| "kimi-coding"
	// —— Cloudflare 边缘推理与网关 ——
	| "cloudflare-workers-ai"
	| "cloudflare-ai-gateway"
	// —— Qwen / 小米的 token 套餐类接入(cn 为国内端点,ams/sgp 为海外机房) ——
	| "qwen-token-plan"
	| "qwen-token-plan-cn"
	| "qwen-token-plan-individual"
	| "xiaomi"
	| "xiaomi-token-plan-cn"
	| "xiaomi-token-plan-ams"
	| "xiaomi-token-plan-sgp";
/** 任意 provider 标识:内置清单之外的字符串也允许(自定义接入渠道)。 */
export type ProviderId = KnownProvider | string;

/** 内置支持的图像生成 provider(目前仅 OpenRouter)。 */
export type KnownImagesProvider = "openrouter";

/** 任意图像生成 provider 标识。 */
export type ImagesProviderId = KnownImagesProvider | string;

// ========== 第二部分:工具选择与思维链(reasoning)基元 ==========

/** 工具选择策略:"auto" 由模型自行决定是否调用工具;"none" 禁用所有工具调用。 */
export type ToolChoice = "auto" | "none";

/**
 * pi 统一的推理(thinking)强度等级,从低到高:
 * minimal < low < medium < high < xhigh < max。
 * 各 provider 适配层通过 ThinkingLevelMap 把它映射为自己的参数表示。
 */
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 模型可设置的思维链等级:比 ThinkingLevel 多一个 "off"(完全关闭推理)。 */
export type ModelThinkingLevel = "off" | ThinkingLevel;

/**
 * pi 思维链等级 -> provider 专属取值的映射表。
 * 值为字符串(如 Anthropic 的 "high"、OpenAI 的 reasoning effort 取值),
 * null 表示该模型不支持此等级;缺失的键回落到 provider 默认值。
 */
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;

/**
 * chat 模板参数(chat_template_kwargs / chat_template_args)中单个值的类型:
 * 既可以是字面量(string/number/boolean/null),也可以是 `$var` 占位符,
 * 由 pi 在发请求时替换为受控的思维链取值:
 * - "thinking.enabled":推理是否开启(布尔);
 * - "thinking.effort":推理强度(经 ThinkingLevelMap 映射后的值);
 * - "thinking.budget":推理 token 预算数字。
 * omitWhenOff 为 true 时,推理关闭则整个参数不发送。
 * 供 baseten、qwen-chat-template 等基于 chat 模板的推理服务器使用。
 */
export type ChatTemplateKwargValue =
	| string
	| number
	| boolean
	| null
	| {
			$var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
			omitWhenOff?: boolean;
	  };

/** 用于在 OpenAI 兼容服务器上限住推理 token 数的顶层请求字段名(各家命名不同,详见 OpenAICompletionsCompat.thinkingTokenBudgetField)。 */
export type ThinkingTokenBudgetField = "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";

/** 各思维链等级对应的 token 预算(仅适用于按 token 数控预算的 provider,如 vLLM / Qwen / llama.cpp 系) */
export interface ThinkingBudgets {
	/** "minimal" 等级对应的 token 预算;未设置的等级由 provider 决定。 */
	minimal?: number;
	/** "low" 等级对应的 token 预算。 */
	low?: number;
	/** "medium" 等级对应的 token 预算。 */
	medium?: number;
	/** "high" 等级对应的 token 预算。 */
	high?: number;
}

// ========== 第三部分:所有 provider 共享的基础选项 ==========

/**
 * 提示词缓存(prompt cache)保留时长偏好:
 * "none" 不使用缓存,"short" 常规短保留(默认),"long" 长保留
 * (如 OpenAI 的 24h、Anthropic 的 1h)。各 provider 适配层自行映射为其支持的取值。
 */
export type CacheRetention = "none" | "short" | "long";

/**
 * 流式传输方式:"sse" 走 HTTP SSE,"websocket" 走 WebSocket,
 * "websocket-cached" 复用缓存的长连 WebSocket,"auto" 由 provider 自行选择。
 */
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";

/** provider 级环境变量覆盖。其中的值优先于 process.env(用于区域设置、endpoint 占位符、代理变量等)。 */
export type ProviderEnv = Record<string, string>;
/** 自定义 HTTP 请求头映射;value 为 null 表示显式屏蔽 provider 同名默认请求头。 */
export type ProviderHeaders = Record<string, string | null>;
/** fetch 实现的函数签名,默认取全局 globalThis.fetch。 */
export type FetchFunction = typeof globalThis.fetch;
/**
 * 会话亲和(session affinity)请求头的格式家族:把同一会话的请求路由到同一后端副本,
 * 以最大化提示词缓存命中。"openai" 发送 session_id / x-client-request-id / x-session-affinity,
 * "openai-nosession" 少发 session_id,"openrouter" 发送 x-session-id。
 */
export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

/** provider 原始 HTTP 响应的精简快照(仅状态码与响应头),供 onResponse 回调检视。 */
export interface ProviderResponse {
	/** HTTP 状态码。 */
	status: number;
	/** 响应头键值对。 */
	headers: Record<string, string>;
}

/**
 * provider 请求共享的认证、HTTP 传输与生命周期回调选项;
 * 是 StreamOptions / ImagesOptions / DeferredFetchOptions 等的公共基类。
 */
export interface ProviderRequestOptions<TModel = Model<Api>> {
	/** 中止信号,用于取消本次请求。 */
	signal?: AbortSignal;
	/** 本次逻辑请求产生的遥测(telemetry)数据所挂载的显式父上下文。 */
	telemetryContext?: TelemetryContext;
	/** 显式传入的 API 密钥,覆盖 provider 默认的凭据来源。 */
	apiKey?: string;
	/**
	 * provider HTTP 请求的可选 fetch 实现,默认为 `globalThis.fetch`。
	 * 无法注入自定义实现的 provider 适配层可以拒绝该参数;
	 * 该参数不影响 WebSocket 传输。
	 */
	fetch?: FetchFunction;
	/**
	 * provider 级环境变量。对区域设置、endpoint 占位符、代理变量等 provider 配置,
	 * 这些值优先于 process.env。
	 */
	env?: ProviderEnv;
	/**
	 * 可选回调:在发送前检视或替换 provider 请求负载(payload)。
	 * 返回 undefined 表示保持负载不变。
	 */
	onPayload?: (payload: unknown, model: TModel) => unknown | undefined | Promise<unknown | undefined>;
	/**
	 * 可选回调:收到 HTTP 响应后调用。
	 */
	onResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
	/**
	 * 随 API 请求发送的可选自定义 HTTP 头。
	 * 与 provider 默认头合并,调用方的值覆盖默认头。
	 * 在 AWS Bedrock 上,这些头通过 Smithy `build` 阶段中间件注入,
	 * 从而纳入 SigV4 签名范围;保留头(`x-amz-*`、`authorization`、`host`)
	 * 会被静默忽略,以保住 SigV4 / bearer 认证。
	 * 值为 null 时屏蔽同名的 provider/API 默认头。
	 */
	headers?: ProviderHeaders;
	/**
	 * provider/SDK 支持时的 HTTP 请求超时(毫秒)。
	 * 例如 OpenAI 与 Anthropic 的 SDK 客户端默认为 10 分钟。
	 */
	timeoutMs?: number;
	/**
	 * provider/SDK 支持客户端重试时的最大重试次数。
	 * 例如 OpenAI 与 Anthropic 的 SDK 客户端默认为 2。
	 */
	maxRetries?: number;
	/**
	 * 服务器要求过长等待时,重试前最多等待的毫秒数。
	 * 若服务器要求的等待超过该值,请求立即失败,
	 * 报错信息中包含服务器要求的等待时长,便于上层重试逻辑以用户可见的方式处理。
	 * 默认 60000(60 秒);设为 0 表示不设上限。
	 */
	maxRetryDelayMs?: number;
}

/**
 * 流式请求选项:在 ProviderRequestOptions 基础上追加采样参数、缓存、传输方式、
 * 会话等会话层选项,是各 stream() 调用的统一入参类型。
 */
export interface StreamOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * 可选回调:收到 HTTP 响应之后、响应体流被消费之前调用。
	 */
	onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
	/** 采样温度;未设置时使用 provider 默认值。 */
	temperature?: number;
	/**
	 * 任意采样参数,按原样合并进请求体,且排在具名请求字段之后,
	 * 因此这里的键会覆盖具名字段。用于让自定义 OpenAI 兼容服务器
	 * (llama.cpp、vLLM、SGLang 等)接收 pi 未建模的参数,例如
	 * `top_p`、`top_k`、`min_p`、`repetition_penalty`。
	 * 按 key 覆盖合并到 `Model.samplingParams` 之上。
	 * 仅由 OpenAI 兼容适配层(completions、responses、Azure responses)应用;
	 * 其他 API 会忽略它。
	 */
	samplingParams?: Record<string, unknown>;
	/** 本次响应的输出 token 上限;未设置时使用模型默认值。 */
	maxTokens?: number;
	/**
	 * 传输方式偏好,供支持多种传输的 provider 使用。
	 * 不支持该选项的 provider 会忽略它。
	 */
	transport?: Transport;
	/**
	 * 提示词缓存保留时长偏好。provider 会将其映射为自己支持的取值。
	 * 默认 "short"。
	 */
	cacheRetention?: CacheRetention;
	/**
	 * 会话标识,供支持基于会话的缓存的 provider 使用。
	 * provider 可用它启用提示词缓存、请求路由或其他会话感知特性;
	 * 不支持的 provider 会忽略它。
	 */
	sessionId?: string;
	/**
	 * WebSocket 连接超时(毫秒),供支持 WebSocket 传输的 provider 使用。
	 * 仅覆盖连接/握手阶段;连接建立后的流空闲超时用 timeoutMs 控制。
	 */
	websocketConnectTimeoutMs?: number;
	/**
	 * 随 API 请求发送的可选元数据。
	 * provider 提取自己认识的字段、忽略其余字段,
	 * 例如 Anthropic 用 `user_id` 做滥用追踪与限流。
	 */
	metadata?: Record<string, unknown>;
}

/** 允许携带任意扩展键的 StreamOptions(供自定义 API 适配层透传额外参数)。 */
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;

/** 延迟响应(deferred response)的取回选项:fetchDeferred 长轮询等待异步结果时使用。 */
export interface DeferredFetchOptions extends ProviderRequestOptions<Model<Api>> {
	/**
	 * provider 长轮询的最大持续时长(毫秒)。
	 * 默认为 0,即只做一次状态检查。
	 */
	wait?: number;
}

/** 尽力而为(best-effort)取消延迟响应的请求选项。 */
export type DeferredCancelOptions = ProviderRequestOptions<Model<Api>>;

/**
 * 把已知 API 映射到其完整的 provider 专属流式选项类型。
 * 来自 API 实现模块的均为 type-only import,编译产物中会被擦除,
 * 因此这里是 tree-shake 安全的(不会把实现模块打进包体)。
 */
export interface ApiOptionsMap {
	"anthropic-messages": AnthropicOptions;
	"openai-completions": OpenAICompletionsOptions;
	"openai-responses": OpenAIResponsesOptions;
	"openai-codex-responses": OpenAICodexResponsesOptions;
	"azure-openai-responses": AzureOpenAIResponsesOptions;
	"google-generative-ai": GoogleOptions;
	"google-vertex": GoogleVertexOptions;
	"mistral-conversations": MistralOptions;
	"bedrock-converse-stream": BedrockOptions;
	"pi-messages": PiMessagesOptions;
}

/**
 * 某个 API 对应的完整流式选项类型:已知 API 解析为具体选项类型,
 * 自定义 API 字符串回落到通用形态(StreamOptions + 任意扩展键)。
 */
export type ApiStreamOptions<TApi extends Api> = TApi extends keyof ApiOptionsMap
	? ApiOptionsMap[TApi]
	: StreamOptions & Record<string, unknown>;

/**
 * API 实现模块的统一流契约:src/api/ 下每个模块都导出
 * `stream` 与 `streamSimple`;有能力的模块还可以导出延迟响应相关方法。
 * 惰性包装器(`lazyApi()`)与 provider 工厂以值的形式传递这些函数。
 * 这是未细分类型的统一分派形态;按 API 的精确选项类型
 * 位于各实现模块自身,以及 `Provider.stream()` 上(经 `ApiStreamOptions`)。
 */
export interface ProviderStreams {
	/** 常规流式调用:完整 StreamOptions 入参。 */
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	/** 简化流式调用:带统一推理等级的 SimpleStreamOptions 入参。 */
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	/** 取回延迟响应(可选能力):把异步完成的句柄重新转回流。 */
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	/** 取消延迟响应(可选能力)。 */
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}

/**
 * 图像生成 API 实现模块的统一契约:src/api/ 下每个图像 API 模块
 * 恰好导出一个 `generateImages`,模块本身即满足该接口。
 * 惰性包装器与图像 provider 工厂以值的形式传递它。
 */
export interface ProviderImages {
	/** 生成图像:输入上下文 + 选项,返回图像结果(含输出内容与用量)。 */
	generateImages(
		model: ImagesModel<ImagesApi>,
		context: ImagesContext,
		options?: ImagesOptions,
	): Promise<AssistantImages>;
}

/** 图像生成请求选项:ProviderRequestOptions 加上图像特有的扩展点。 */
export interface ImagesOptions extends ProviderRequestOptions<ImagesModel<ImagesApi>> {
	/**
	 * 随 API 请求发送的可选元数据。
	 * provider 提取自己认识的字段、忽略其余字段。
	 */
	metadata?: Record<string, unknown>;
}

/** 允许携带任意扩展键的 ImagesOptions(供自定义图像 API 适配层使用)。 */
export type ProviderImagesOptions = ImagesOptions & Record<string, unknown>;

/**
 * Anthropic 服务端拒绝回退(server-side refusal fallback)允许使用的模型项:
 * `fallbacks` 请求字段中允许出现的模型,及其本地计费元数据。
 */
export interface AnthropicAllowedFallbackModel {
	/** 回退目标所属 provider。 */
	provider: ProviderId;
	/** 回退目标模型 id。 */
	model: string;
	/** 该模型的计费信息,用于统计回退响应的用量成本。 */
	cost: ModelCost;
}

// 传给 streamSimple()/completeSimple() 的统一选项:
// 在 StreamOptions 之上叠加 provider 中立的推理等级等简化入参
export interface SimpleStreamOptions extends StreamOptions {
	/** 简化请求的 provider 中立工具选择策略。默认 "auto"。 */
	toolChoice?: ToolChoice;
	/** 推理(thinking)强度等级,由适配层映射为 provider 参数。 */
	reasoning?: ThinkingLevel;
	/** 请求有能力的 provider 返回持久句柄并把请求转为异步继续(延迟响应);window 为结果保留时间窗。 */
	deferred?: boolean | { window?: "15m" | "1h" | "24h" };
	/** 各思维链等级的自定义 token 预算(仅 token 型 provider 使用) */
	thinkingBudgets?: ThinkingBudgets;
}

// 带类型化选项的通用 StreamFunction。
//
// 契约:
// - 必须返回 AssistantMessageEventStream。
// - 一旦被调用,请求/模型/运行时失败都应编码进返回的流中,而不是抛出异常。
// - 以错误终止时,必须产生 stopReason 为 "error" 或 "aborted"、
//   并带 errorMessage 的 AssistantMessage,通过流协议发出。
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

/** 图像生成版的 StreamFunction:非流式,直接返回 Promise<AssistantImages>。 */
export type ImagesFunction<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> = (
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: TOptions,
) => Promise<AssistantImages>;

// ========== 第四部分:内容块 / 消息 / 用量协议 ==========

/**
 * 文本内容签名的 v1 结构(序列化为 JSON 后存进 TextContent.textSignature)。
 * OpenAI Responses 等协议用它把签名随文本一起回传,保证多轮对话一致性。
 */
export interface TextSignatureV1 {
	/** 结构版本号,固定为 1。 */
	v: 1;
	/** 签名 id(旧版本直接以字符串形式存这个 id)。 */
	id: string;
	/** 产生该文本的阶段:"commentary" 为过程性说明,"final_answer" 为最终回答。 */
	phase?: "commentary" | "final_answer";
}

/** 纯文本内容块。 */
export interface TextContent {
	type: "text";
	/** 文本内容。 */
	text: string;
	textSignature?: string; // 例如 OpenAI responses 会用它携带消息元数据(旧版 id 字符串或 TextSignatureV1 的 JSON)
}

/** 思维链(reasoning)内容块:模型的推理文本及其回放签名。 */
export interface ThinkingContent {
	type: "thinking";
	/** 推理文本。 */
	thinking: string;
	thinkingSignature?: string; // provider 专属的不透明签名或序列化的推理回放数据
	/** 为 true 时表示该思维链内容被安全过滤器遮蔽(redacted)。
	 *  不透明加密负载存放在 `thinkingSignature` 中,以便回传 API 保持多轮连续性。 */
	redacted?: boolean;
}

/** 图片内容块(base64 内联,不带外部 URL)。 */
export interface ImageContent {
	type: "image";
	data: string; // base64 编码的图片数据
	mimeType: string; // MIME 类型,如 "image/jpeg"、"image/png"
}

/** 模型发起的一次工具调用请求(对应停止原因 "toolUse")。 */
export interface ToolCall {
	type: "toolCall";
	/** 调用 id,与 ToolResultMessage.toolCallId 配对。 */
	id: string;
	/** 要调用的工具名(对应 Context.tools 中的 name)。 */
	name: string;
	/** 已从 JSON 解析为对象的工具参数。 */
	arguments: Record<string, any>;
	thoughtSignature?: string; // Google 专属:复用思考上下文所需的不透明签名
	/** OpenAI Responses 的命名空间,用于动态加载或命名空间化的工具调用。 */
	namespace?: string;
}

/**
 * 一次请求的 token 用量与费用统计(美元计价)。
 * cacheRead / cacheWrite 分别为提示词缓存命中读取与写入的 token 数;
 * reasoning 是 output 的子集(output 已包含推理 token)。
 */
export interface Usage {
	/** 输入(prompt)token 数。 */
	input: number;
	/** 输出(completion)token 数(已包含 reasoning 部分)。 */
	output: number;
	/** 提示词缓存命中读取的 token 数。 */
	cacheRead: number;
	/** 提示词缓存写入的 token 数。 */
	cacheWrite: number;
	/** `cacheWrite` 中以 1 小时保留写入的部分。仅 Anthropic 上报这一拆分。 */
	cacheWrite1h?: number;
	/**
	 * 推理/思维链 token 数,provider 上报时才有。它是 `output` 的子集:
	 * `output` 已包含这些 token。暴露推理拆分的 provider 会把它设为数字
	 * (可能是 0);不暴露的 provider 则保持 undefined。
	 */
	reasoning?: number;
	/** 总 token 数。 */
	totalTokens: number;
	/** 按类别拆分的费用。 */
	cost: {
		/** 输入 token 费用。 */
		input: number;
		/** 输出 token 费用。 */
		output: number;
		/** 缓存命中读取费用。 */
		cacheRead: number;
		/** 缓存写入费用。 */
		cacheWrite: number;
		/** 总费用。 */
		total: number;
	};
}

/**
 * 一条助手消息的终止原因:
 * "pending" 尚未结束(流式中间态)、"stop" 自然结束、"length" 达到 token 上限、
 * "toolUse" 因请求调用工具而暂停、"error" 出错、"aborted" 被主动中止、
 * "deferred" 转为延迟异步继续(见 DeferredHandle)。
 */
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

/** 递归 JSON 值类型,用于 DeferredHandle.data 等可序列化负载。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * 延迟响应的持久句柄:由支持 deferred 的 provider 返回,
 * 之后可用 fetchDeferred 取回最终结果、用 cancelDeferred 取消。
 * 设计为可持久化(跨进程/跨重启存续)。
 */
export interface DeferredHandle {
	/** 所属 provider。 */
	provider: string;
	/** 模型 id。 */
	modelId: string;
	/** API 类型。 */
	api: string;
	/** provider 侧令牌,例如响应 id / 批处理 id 加行号。 */
	id: string;
	/** 句柄过期时间(Unix 时间戳)。 */
	expiresAt?: number;
	/** 建议多久之后再轮询(毫秒)。 */
	pollAfterMs?: number;
	/** 重建最终助手消息所需的 provider 转换数据(可序列化 JSON)。 */
	data?: JsonValue;
}

/** 用户消息。 */
export interface UserMessage {
	role: "user";
	/** 纯文本字符串,或文本/图片内容块的混合数组。 */
	content: string | (TextContent | ImageContent)[];
	timestamp: number; // Unix 时间戳(毫秒)
}

/**
 * 助手消息:一次模型响应的完整快照(流式过程中的 partial 也是该形状)。
 */
export interface AssistantMessage {
	role: "assistant";
	/** 消息内容块:文本、思维链与工具调用的有序混合。 */
	content: (TextContent | ThinkingContent | ToolCall)[];
	/** 本次响应使用的 API 类型。 */
	api: Api;
	/** 所属 provider。 */
	provider: ProviderId;
	/** 请求时指定的模型 id。 */
	model: string;
	responseModel?: string; // 实际返回的 `chunk.model`,与请求的 `model` 不同时填写(如 OpenRouter `auto` -> `anthropic/...`)
	responseId?: string; // 上游 API 暴露响应/消息 id 时,provider 专属的响应标识
	diagnostics?: AssistantMessageDiagnostic[]; // 脱敏后的 provider/运行时诊断,记录失败与恢复过程
	/** token 用量与费用统计。 */
	usage: Usage;
	/** 终止原因。 */
	stopReason: StopReason;
	/** stopReason 为 "deferred" 时携带的延迟响应句柄。 */
	deferred?: DeferredHandle;
	/** stopReason 为 "error"/"aborted" 时的错误说明。 */
	errorMessage?: string;
	/** provider 原始的停止原因字符串(映射为 StopReason 之前)。 */
	rawStopReason?: string;
	/**
	 * provider 对「模型是否显式结束了自己的回合」的指示。
	 * 仅保留用于调试,当前不影响 agent 控制流。
	 */
	endTurn?: boolean;
	timestamp: number; // Unix 时间戳(毫秒)
}

/** 工具结果消息:把一次工具执行的产出回传给模型。 */
export interface ToolResultMessage<TDetails = any> {
	role: "toolResult";
	/** 对应 ToolCall.id。 */
	toolCallId: string;
	/** 对应的工具名。 */
	toolName: string;
	content: (TextContent | ImageContent)[]; // 支持文本与图片
	/** 调用方自定义的附加详情泛型,具体语义由使用方定义。 */
	details?: TDetails;
	/** 工具执行自身的用量(如果有)。不计入主 LLM 上下文用量。 */
	usage?: Usage;
	/**
	 * `Context.tools` 中在该结果之后才可用的工具名。
	 * 支持原生延迟工具加载的 provider 以此为加载点;
	 * 其他 provider 忽略它并正常使用 `Context.tools`。
	 */
	addedToolNames?: string[];
	/** 该结果是否代表工具执行失败。 */
	isError: boolean;
	timestamp: number; // Unix 时间戳(毫秒)
}

/** 对话消息的三种形态联合:用户、助手、工具结果。 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** 图像生成的输入内容块(文本或图片)。 */
export type ImagesInputContent = TextContent | ImageContent;
/** 图像生成的输出内容块(文本或图片)。 */
export type ImagesOutputContent = TextContent | ImageContent;

/** 图像生成的请求上下文,目前仅包含输入内容块数组。 */
export interface ImagesContext {
	input: ImagesInputContent[];
}

/** 图像生成结果的终止原因(无工具调用、延迟等状态)。 */
export type ImagesStopReason = "stop" | "error" | "aborted";

/** 图像生成的结果消息(与 AssistantMessage 平行的图像版)。 */
export interface AssistantImages {
	/** 使用的图像 API 类型。 */
	api: ImagesApi;
	/** 所属图像 provider。 */
	provider: ImagesProviderId;
	/** 请求的模型 id。 */
	model: string;
	/** 生成的输出内容(图片以 base64 ImageContent 形式返回)。 */
	output: ImagesOutputContent[];
	/** 上游 API 暴露响应 id 时的 provider 专属标识。 */
	responseId?: string;
	/** token 用量(图像 provider 上报时才有)。 */
	usage?: Usage;
	/** 终止原因。 */
	stopReason: ImagesStopReason;
	/** stopReason 为 "error"/"aborted" 时的错误说明。 */
	errorMessage?: string;
	timestamp: number; // Unix 时间戳(毫秒)
}

// typebox 的 JSON Schema 类型(工具参数定义用;type-only import,产物中被擦除)
import type { TSchema } from "typebox";

/** OpenAI 约束采样(constrained sampling)的语法变体:lark 语法或正则。 */
export type GrammarFormat = "openai_lark" | "openai_regex";

/** 按 GrammarFormat 分组的语法字符串表。 */
export type GrammarVariants = Partial<Record<GrammarFormat, string>>;

/**
 * 工具的可选 provider 侧约束采样(constrained sampling)配置。
 *
 * `json_schema` 取值大致对应各 API 中 `strict` 的概念——这些 API 以
 * json-schema 约束采样的方式实现 strict;grammar 变体则允许调用方为
 * 同一目标语言提供 provider 专属的编码。
 */
export type ConstrainedSamplingConfig =
	| {
			type: "json_schema";
			/** "prefer" 尽量启用 strict,"require" 必须启用(不支持时报错)。 */
			strict: "prefer" | "require";
	  }
	| {
			type: "grammar";
			variants: GrammarVariants;
	  };

/** 工具定义:名称、描述、typebox JSON Schema 参数,外加可选的约束采样配置。 */
export interface Tool<TParameters extends TSchema = TSchema> {
	/** 工具名(与 ToolCall.name 对应)。 */
	name: string;
	/** 工具描述,供模型理解何时、如何调用。 */
	description: string;
	/** 参数的 JSON Schema(typebox TSchema)。 */
	parameters: TParameters;
	/** 约束采样配置;false 表示显式禁用。 */
	constrainedSampling?: false | ConstrainedSamplingConfig;
}

/** 一次模型调用的完整上下文:系统提示词、历史消息与可用工具。 */
export interface Context {
	/** 系统提示词(system prompt)。 */
	systemPrompt?: string;
	/** 对话历史(UserMessage / AssistantMessage / ToolResultMessage)。 */
	messages: Message[];
	/** 可供模型调用的工具列表。 */
	tools?: Tool[];
}

/**
 * AssistantMessageEventStream 的事件协议。
 *
 * 流应先发 `start`,再发各内容块的增量更新,最终以下列两种方式之一终止:
 * - `done`:携带最终成功的 AssistantMessage;或
 * - `error`:携带 stopReason 为 "error" 或 "aborted"、并带 errorMessage 的
 *   最终 AssistantMessage。
 * 各事件中的 partial 是截至当前时刻的累积消息快照,contentIndex 是该内容块
 * 在 AssistantMessage.content 数组中的下标。
 */
export type AssistantMessageEvent =
	// —— 流开始:携带初始 partial 消息 ——
	| { type: "start"; partial: AssistantMessage }
	// —— 文本块:开始 / 增量 / 结束 ——
	| { type: "text_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// —— 思维链块:开始 / 增量 / 结束 ——
	| { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
	// —— 工具调用块:开始 / 参数增量 / 结束 ——
	| { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
	| { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
	// —— 终止:成功(done)或失败(error) ——
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
			message: AssistantMessage;
	  }
	| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * OpenAI 兼容 completions API 的兼容性设置。
 * 用于为自定义 provider 覆盖基于 URL 的自动探测结果。
 */
export interface OpenAICompletionsCompat {
	/** provider 是否支持 `store` 字段。默认:按 URL 自动探测。 */
	supportsStore?: boolean;
	/** provider 是否支持 `developer` 角色(而非 `system`)。默认:按 URL 自动探测。 */
	supportsDeveloperRole?: boolean;
	/** provider 是否支持 `reasoning_effort`。默认:按 URL 自动探测。 */
	supportsReasoningEffort?: boolean;
	/** provider 是否支持 `stream_options: { include_usage: true }` 以在流式响应中带回 token 用量。默认 true。 */
	supportsUsageInStreaming?: boolean;
	/** 流式响应是否包含 `finish_reason`。为 false 时,pi 在流结束时自行推断 `stop` 或 `toolUse`。默认 true。 */
	supportsFinishReason?: boolean;
	/** max tokens 使用哪个请求字段。默认:按 URL 自动探测。 */
	maxTokensField?: "max_completion_tokens" | "max_tokens";
	/** 工具结果是否必须携带 `name` 字段。默认:按 URL 自动探测。 */
	requiresToolResultName?: boolean;
	/** 工具结果之后紧跟用户消息时,中间是否必须插入一条助手消息。默认:按 URL 自动探测。 */
	requiresAssistantAfterToolResult?: boolean;
	/** 思维链块是否必须转换为带 <thinking> 定界符的文本块。默认:按 URL 自动探测。 */
	requiresThinkingAsText?: boolean;
	/** 开启推理时,所有回放的助手消息是否必须包含空的 reasoning_content 字段。默认:按 URL 自动探测。 */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/** 推理/思维链参数的格式:"openai" 用 reasoning_effort;"openrouter" 用 reasoning: { effort };"deepseek" 用 thinking: { type } 并在支持时附 reasoning_effort;"together" 用 reasoning: { enabled } 并在支持时附 reasoning_effort;"baseten" 用可配置的 chat_template_args 并在支持时附 reasoning_effort;"zai" 用 thinking: { type };"qwen" 用顶层 enable_thinking: boolean;"qwen-chat-template" 用 chat_template_kwargs.enable_thinking 与 preserve_thinking;"chat-template" 用可配置的 chat_template_kwargs;"string-thinking" 用顶层 thinking: string;"ant-ling" 仅在映射后的 effort 非空时用 reasoning: { effort }。默认 "openai"。 */
	thinkingFormat?:
		| "openai"
		| "openrouter"
		| "deepseek"
		| "together"
		| "baseten"
		| "zai"
		| "qwen"
		| "chat-template"
		| "qwen-chat-template"
		| "string-thinking"
		| "ant-ling";
	/** `thinkingFormat` 为 `chat-template` 时,作为 `chat_template_kwargs` 发送的键值对。可用 `{ "$var": "thinking.enabled" }`、`{ "$var": "thinking.effort" }` 或 `{ "$var": "thinking.budget" }` 引用 pi 控制的思维链取值。 */
	chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;
	/** `thinkingFormat` 为 `baseten` 时,作为 `chat_template_args` 发送的参数。可用 `{ "$var": "thinking.enabled" }`、`{ "$var": "thinking.effort" }` 或 `{ "$var": "thinking.budget" }` 引用 pi 控制的思维链取值。 */
	chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;
	/** OpenRouter 兼容的路由偏好,作为请求体的 `provider` 字段发送。 */
	openRouterRouting?: OpenRouterRouting;
	/** Vercel AI Gateway 路由偏好。仅当 baseUrl 指向 Vercel AI Gateway 时使用。 */
	vercelGatewayRouting?: VercelGatewayRouting;
	/** z.ai 是否支持顶层 `tool_stream: true` 以流式输出工具调用增量。默认 false。 */
	zaiToolStream?: boolean;
	/**
	 * 用 `thinkingBudgets` 限制推理 token 数时使用的顶层请求字段。
	 * 这些 endpoint 上推理与回答共享 `max_tokens`,因此不设预算时,
	 * 推理很重的一轮可能耗尽整个响应、不输出任何回答。
	 * "thinking_token_budget" 是 vLLM,"thinking_budget" 是 Qwen/DashScope/SGLang,
	 * "thinking_budget_tokens" 是 llama.cpp。默认关闭;生成的模型目录不设置该字段。
	 */
	thinkingTokenBudgetField?: ThinkingTokenBudgetField;
	/** `thinkingTokenBudgetField: "thinking_token_budget"`(vLLM)的别名。优先使用 thinkingTokenBudgetField。默认 false。 */
	supportsThinkingTokenBudget?: boolean;
	/** provider 是否支持带 Lark/正则语法格式的 OpenAI 自定义工具。为 false 时,语法约束工具退化为普通 function 工具。默认 false;生成的模型目录会为有能力的模型启用。 */
	supportsOpenAIGrammarTools?: boolean;
	/** provider 是否支持工具定义中的 `strict` 字段。默认 true。 */
	supportsStrictMode?: boolean;
	/** 提示词缓存的 cache control 约定:"anthropic" 表示对系统提示词、最后一个工具定义、以及最后一条 user/assistant/tool-result 文本内容应用 Anthropic 风格的 `cache_control` 标记。 */
	cacheControlFormat?: "anthropic";
	/** 是否发送来自 `options.sessionId` 的会话亲和数据。默认 false。 */
	sendSessionAffinityHeaders?: boolean;
	/** provider 专属的延迟工具(deferred tool)序列化模式。 */
	deferredToolsMode?: "kimi";
	/** 会话亲和请求头格式:`openai` 发送 `session_id`、`x-client-request-id` 与 `x-session-affinity`;`openai-nosession` 发送 `x-client-request-id` 与 `x-session-affinity`;`openrouter` 发送 `x-session-id`。不影响 `prompt_cache_key` 请求体参数(那由缓存保留时长决定)。默认:自动探测。 */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** provider 是否支持长提示词缓存保留(依格式为 `prompt_cache_retention: "24h"` 或 Anthropic 风格的 `cache_control.ttl: "1h"`)。默认 true。 */
	supportsLongCacheRetention?: boolean;
}

/** OpenAI Responses 系 API 的兼容性设置。 */
export interface OpenAIResponsesCompat {
	/** provider 是否支持 `developer` 角色(而非 `system`)。默认 true。 */
	supportsDeveloperRole?: boolean;
	/** 会话亲和请求头格式:`openai` 发送 `session_id` 与 `x-client-request-id`;`openai-nosession` 只发送 `x-client-request-id`;`openrouter` 发送 `x-session-id`。不影响 `prompt_cache_key` 请求体参数(那由缓存保留时长决定)。默认:自动探测。 */
	sessionAffinityFormat?: SessionAffinityFormat;
	/** provider 是否支持 `prompt_cache_retention: "24h"`。默认 true。 */
	supportsLongCacheRetention?: boolean;
	/** provider 是否支持 strict JSON-schema function 工具。默认值因具体 API 而异;生成的 OpenAI 模型会显式启用。 */
	supportsStrictMode?: boolean;
	/** 是否发出带 Lark/正则语法格式的 OpenAI 自定义工具。为 false 时,语法约束工具退化为普通 function 工具。默认 false;生成的模型目录会为有能力的模型启用。 */
	supportsOpenAIGrammarTools?: boolean;
	/** 模型是否支持锚定在消息上的 `additional_tools` 输入项。默认 false。 */
	supportsAdditionalTools?: boolean;
	/** 模型是否支持由客户端执行的延迟工具搜索(tool search)。默认 false。 */
	supportsToolSearch?: boolean;
	/** 模型是否接受 `prompt_cache_options`(OpenAI GPT-5.6+ 的显式提示词缓存)。较老的 OpenAI 模型会拒绝该参数。默认 false。 */
	supportsExplicitPromptCacheMode?: boolean;
}

/** Anthropic Messages 兼容 API 的兼容性设置。 */
export interface AnthropicMessagesCompat {
	/**
	 * provider 是否接受按工具设置的 `eager_input_streaming`。
	 * 为 false 时,Anthropic provider 会省略 `tools[].eager_input_streaming`,
	 * 并为启用工具的请求发送旧版 `fine-grained-tool-streaming-2025-05-14`
	 * beta 请求头。
	 * 默认 true。
	 */
	supportsEagerToolInputStreaming?: boolean;
	/** provider 是否支持 Anthropic 长缓存保留(`cache_control.ttl: "1h"`)。默认 true。 */
	supportsLongCacheRetention?: boolean;
	/**
	 * 启用缓存时,是否根据 `options.sessionId` 发送 `x-session-affinity` 请求头。
	 * Fireworks 等依赖会话亲和做提示词缓存路由的 provider 需要它
	 * (请求落到同一副本可最大化缓存命中)。
	 * 默认 false。
	 */
	sendSessionAffinityHeaders?: boolean;
	/**
	 * provider 是否支持在工具定义上使用 Anthropic 风格的 `cache_control` 标记。
	 * 为 false 时,工具参数中省略 `cache_control`。部分 Anthropic 兼容 provider
	 * (如 Fireworks)不支持工具上的该字段,可能报错或忽略。
	 * 默认 true。
	 */
	supportsCacheControlOnTools?: boolean;
	/**
	 * 模型是否接受 Anthropic 的 `temperature` 请求字段。
	 * Claude Opus 4.7+ 会拒绝非默认的 temperature 取值。
	 * 默认 true。
	 */
	supportsTemperature?: boolean;
	/**
	 * 是否无视模型 id,强制使用自适应思维链(`thinking.type: "adaptive"` 加
	 * `output_config.effort`)。需要自适应思维链的内置模型会在生成的元数据中
	 * 设置它;自定义 Anthropic 兼容 provider 可为任何上游要求自适应格式的模型
	 * 设为 `true`;对被覆盖的内置模型可设为 `false` 以退出。
	 * 默认 false。
	 */
	forceAdaptiveThinking?: boolean;
	/** 回放空的思维链签名时,是否以 `signature: ""` 原样发送,而不是把思维链转成文本。默认 false。 */
	allowEmptySignature?: boolean;
	/** provider 是否支持 Anthropic strict 工具 schema。默认 false;生成的 Anthropic 模型会显式启用。 */
	supportsStrictTools?: boolean;
	/**
	 * Anthropic 在 `fallbacks` 中接受的服务端拒绝回退模型清单,
	 * 附带回退响应所需的本地计费元数据。缺省或为空时,调用方必须省略
	 * `fallbacks`;对没有允许回退目标的模型,Anthropic 会拒绝该字段。
	 */
	allowedFallbackModels?: AnthropicAllowedFallbackModel[];
	/**
	 * provider 是否支持通过工具结果中的 `tool_reference` 块加载延迟工具。
	 * 默认:Anthropic 第一方模型(除 Haiku 及 Claude 4.5 之前的模型)为 true;
	 * 其他 provider 为 false。
	 */
	supportsToolReferences?: boolean;
}

/** Amazon Bedrock 模型的兼容性设置。 */
export interface BedrockCompat {
	/** 模型是否支持 Bedrock strict 工具 schema。默认 false。 */
	supportsStrictMode?: boolean;
}

/**
 * OpenRouter 的 provider 路由偏好。
 * 控制 OpenRouter 把请求路由给哪些上游 provider;
 * 作为 OpenRouter API 请求体中的 `provider` 字段发送。
 * @see https://openrouter.ai/docs/guides/routing/provider-selection
 */
export interface OpenRouterRouting {
	/** 是否允许备用(backup)provider 兜底服务请求。默认 true。 */
	allow_fallbacks?: boolean;
	/** 是否只保留支持请求中全部参数的 provider。默认 false。 */
	require_parameters?: boolean;
	/** 数据收集策略:"allow"(默认)允许可能存储/用数据训练的 provider;"deny" 只用不收集用户数据的 provider。 */
	data_collection?: "deny" | "allow";
	/** 是否把路由限制为仅 ZDR(Zero Data Retention,零数据保留)endpoint。 */
	zdr?: boolean;
	/** 是否把路由限制为仅允许文本蒸馏(distillation)的模型。 */
	enforce_distillable_text?: boolean;
	/** 按顺序尝试的 provider 名称/slug 列表,不可用时依次向后回退。 */
	order?: string[];
	/** 本次请求只允许使用的 provider 名称/slug 白名单。 */
	only?: string[];
	/** 本次请求要跳过的 provider 名称/slug 黑名单。 */
	ignore?: string[];
	/** 按量化精度过滤 provider 的列表(如 ["fp16", "bf16", "fp8", "fp6", "int8", "int4", "fp4", "fp32"])。 */
	quantizations?: string[];
	/** 排序策略:可以是字符串(如 "price"、"throughput"、"latency"),或带 `by` 与 `partition` 的对象。 */
	sort?:
		| string
		| {
				/** 排序指标:"price"、"throughput"、"latency"。 */
				by?: string;
				/** 分区策略:"model"(默认)或 "none"。 */
				partition?: string | null;
		  };
	/** 每百万 token 的最高价格(美元)。 */
	max_price?: {
		/** 每百万 prompt token 的价格。 */
		prompt?: number | string;
		/** 每百万 completion token 的价格。 */
		completion?: number | string;
		/** 每张图片的价格。 */
		image?: number | string;
		/** 每单位音频的价格。 */
		audio?: number | string;
		/** 每次请求的价格。 */
		request?: number | string;
	};
	/** 偏好的最低吞吐(token/秒):可为数字(作用于 p50),或按百分位分别设置下限的对象。 */
	preferred_min_throughput?:
		| number
		| {
				/** 第 50 百分位的最低 token/秒。 */
				p50?: number;
				/** 第 75 百分位的最低 token/秒。 */
				p75?: number;
				/** 第 90 百分位的最低 token/秒。 */
				p90?: number;
				/** 第 99 百分位的最低 token/秒。 */
				p99?: number;
		  };
	/** 偏好的最大延迟(秒):可为数字(作用于 p50),或按百分位分别设置上限的对象。 */
	preferred_max_latency?:
		| number
		| {
				/** 第 50 百分位的最大延迟(秒)。 */
				p50?: number;
				/** 第 75 百分位的最大延迟(秒)。 */
				p75?: number;
				/** 第 90 百分位的最大延迟(秒)。 */
				p90?: number;
				/** 第 99 百分位的最大延迟(秒)。 */
				p99?: number;
		  };
}

/**
 * Vercel AI Gateway 的路由偏好。
 * 控制网关把请求路由给哪些上游 provider。
 * @see https://vercel.com/docs/ai-gateway/models-and-providers/provider-options
 */
export interface VercelGatewayRouting {
	/** 本次请求独占使用的 provider slug 列表(如 ["bedrock", "anthropic"])。 */
	only?: string[];
	/** 按顺序尝试的 provider slug 列表(如 ["anthropic", "openai"])。 */
	order?: string[];
}

// ========== 第五部分:统一模型目录与计费 ==========

/** 各计费维度的单价表(单位:美元/百万 token)。 */
export interface ModelCostRates {
	input: number; // 输入单价:美元/百万 token
	output: number; // 输出单价:美元/百万 token
	cacheRead: number; // 缓存命中读取单价:美元/百万 token
	cacheWrite: number; // 缓存写入单价:美元/百万 token
}

/** 按输入量分档的阶梯计价档位。 */
export interface ModelCostTier extends ModelCostRates {
	/** 输入总用量超过该 token 数的请求适用本档位。 */
	inputTokensAbove: number;
}

/** 模型计费信息:基础单价,可选的按输入量阶梯计价。 */
export interface ModelCost extends ModelCostRates {
	/** 请求级计价档位。取满足输入量门槛的最高一档,应用于整个请求。 */
	tiers?: ModelCostTier[];
}

/** 统一模型系统中一个模型的描述(目录条目)。 */
export interface Model<TApi extends Api> {
	/** 模型 id(provider 内唯一,请求时使用)。 */
	id: string;
	/** 人类可读的展示名。 */
	name: string;
	/** 该模型使用的 API 类型。 */
	api: TApi;
	/** 所属 provider。 */
	provider: ProviderId;
	/** API 请求的 base URL。 */
	baseUrl: string;
	/** 模型是否支持推理/思维链。 */
	reasoning: boolean;
	/**
	 * 把 pi 思维链等级映射为 provider/模型专属取值。
	 * 缺失的键使用 provider 默认值;null 表示该等级不受支持。
	 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 模型接受的输入模态:文本/图片。 */
	input: ("text" | "image")[];
	/** 计费信息。 */
	cost: ModelCost;
	/** 上下文窗口大小(token 数)。 */
	contextWindow: number;
	/** 单次响应的最大输出 token 数。 */
	maxTokens: number;
	/** 该模型的默认采样参数。见 {@link StreamOptions.samplingParams};请求级同名键会覆盖这里的值。 */
	samplingParams?: Record<string, unknown>;
	/** 请求该模型时默认附加的 HTTP 头。 */
	headers?: Record<string, string>;
	/** 各 OpenAI 兼容 API 的兼容性覆盖。未设置时按 baseUrl 自动探测。 */
	compat?: TApi extends "openai-completions"
		? OpenAICompletionsCompat
		: TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses"
			? OpenAIResponsesCompat
			: TApi extends "anthropic-messages"
				? AnthropicMessagesCompat
				: TApi extends "bedrock-converse-stream"
					? BedrockCompat
					: never;
}

/**
 * 图像生成模型:从 Model 精简而来——去掉 api/provider 的宽类型、
 * reasoning、上下文窗口与 maxTokens、compat,改用图像侧的类型与输出模态。
 */
export interface ImagesModel<TApi extends ImagesApi>
	extends Omit<Model<Api>, "api" | "provider" | "reasoning" | "contextWindow" | "maxTokens" | "compat"> {
	/** 使用的图像 API 类型。 */
	api: TApi;
	/** 所属图像 provider。 */
	provider: ImagesProviderId;
	/** 模型的输出模态:文本/图片。 */
	output: ("text" | "image")[];
}
