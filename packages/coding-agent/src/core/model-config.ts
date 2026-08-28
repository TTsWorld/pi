/**
 * @file model-config.ts —— models.json 的加载与校验（模型配置快照）
 *
 * @description
 * 用 typebox 定义用户级 models.json（自定义模型/供应商配置文件）的完整 JSON Schema，
 * 并提供 `ModelConfig` 类完成「读取 → 去 BOM/去注释 → 解析 → 校验 → 深冻结」的加载流水线，
 * 产出一份不可变（immutable）、不含凭据（credential-blind）的配置快照供模型注册表消费。
 *
 * 主要功能点：
 * - 各供应商 API 兼容性子模式（OpenAI Completions / OpenAI Responses / Anthropic Messages），
 *   描述不同后端在思考格式、会话亲和、缓存等能力上的差异开关；
 * - OpenRouter / Vercel Gateway 路由选项模式；
 * - 分层计费（cost.tiers）与思考级别映射（thinkingLevelMap）等模型元数据模式；
 * - 校验失败时通过 formatValidationPath 生成「字段路径 + 错误信息」的可读报告，
 *   作为 error 存入快照而非抛异常（加载永远成功，错误延迟到使用方呈现）。
 *
 * 依赖关系：
 * - typebox：Schema 构建与编译校验；
 * - `../utils/json.ts` / `../utils/text.ts`：剥 JSON 注释与 BOM；
 * - `../utils/paths.ts`：路径规范化（~ 展开）。
 */

import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { stripJsonComments } from "../utils/json.ts";
import { normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";

/** 吞吐/延迟偏好的分位数阈值：允许按 p50/p75/p90/p99 分别给出目标值。 */
const PercentileCutoffsSchema = Type.Object({
	p50: Type.Optional(Type.Number()),
	p75: Type.Optional(Type.Number()),
	p90: Type.Optional(Type.Number()),
	p99: Type.Optional(Type.Number()),
});

/** OpenRouter 供应商路由选项，字段与 OpenRouter API 的 routing 参数一一对应（供应商/量化档过滤、价格上限、排序等）。 */
const OpenRouterRoutingSchema = Type.Object({
	allow_fallbacks: Type.Optional(Type.Boolean()),
	require_parameters: Type.Optional(Type.Boolean()),
	data_collection: Type.Optional(Type.Union([Type.Literal("deny"), Type.Literal("allow")])),
	zdr: Type.Optional(Type.Boolean()),
	enforce_distillable_text: Type.Optional(Type.Boolean()),
	order: Type.Optional(Type.Array(Type.String())),
	only: Type.Optional(Type.Array(Type.String())),
	ignore: Type.Optional(Type.Array(Type.String())),
	quantizations: Type.Optional(Type.Array(Type.String())),
	sort: Type.Optional(
		Type.Union([
			Type.String(),
			Type.Object({
				by: Type.Optional(Type.String()),
				partition: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			}),
		]),
	),
	max_price: Type.Optional(
		Type.Object({
			prompt: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			completion: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			image: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			audio: Type.Optional(Type.Union([Type.Number(), Type.String()])),
			request: Type.Optional(Type.Union([Type.Number(), Type.String()])),
		}),
	),
	preferred_min_throughput: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
	preferred_max_latency: Type.Optional(Type.Union([Type.Number(), PercentileCutoffsSchema])),
});

/** Vercel AI Gateway 路由选项：仅支持白名单（only）与优先顺序（order）两个维度。 */
const VercelGatewayRoutingSchema = Type.Object({
	only: Type.Optional(Type.Array(Type.String())),
	order: Type.Optional(Type.Array(Type.String())),
});

/** 思考级别映射的目标值：供应商特定的级别字符串，null 表示该级别映射为「关闭」。 */
const ThinkingLevelMapValueSchema = Type.Union([Type.String(), Type.Null()]);
/**
 * 思考级别映射表：把 CLI 的统一思考级别（off/minimal/low/medium/high/xhigh/max）
 * 翻译成当前供应商实际接受的参数值，未列出的级别走默认行为。
 */
const ThinkingLevelMapSchema = Type.Object({
	off: Type.Optional(ThinkingLevelMapValueSchema),
	minimal: Type.Optional(ThinkingLevelMapValueSchema),
	low: Type.Optional(ThinkingLevelMapValueSchema),
	medium: Type.Optional(ThinkingLevelMapValueSchema),
	high: Type.Optional(ThinkingLevelMapValueSchema),
	xhigh: Type.Optional(ThinkingLevelMapValueSchema),
	max: Type.Optional(ThinkingLevelMapValueSchema),
});

/** chat template 额外参数的标量取值：字符串/数字/布尔/null 直接透传。 */
const ChatTemplateKwargScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
/**
 * chat template 额外参数的变量引用形式：值在运行时由思考配置动态决定——
 * $var 指明引用 thinking.enabled（开关）或 thinking.effort（力度），
 * omitWhenOff 为 true 时思考关闭则整个参数不发送。
 */
const ChatTemplateKwargVariableSchema = Type.Object({
	$var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort")]),
	omitWhenOff: Type.Optional(Type.Boolean()),
});
const ChatTemplateKwargSchema = Type.Union([ChatTemplateKwargScalarSchema, ChatTemplateKwargVariableSchema]);

/**
 * OpenAI Completions 类 API 的兼容性开关集合：
 * 描述该后端是否支持 store 参数、developer 角色、reasoning_effort、
 * 流式 usage、思考格式的各种方言（openrouter/together/deepseek/qwen 等），
 * 以及工具结果格式、缓存控制、会话亲和头等协议差异。
 */
const OpenAICompletionsCompatSchema = Type.Object({
	supportsStore: Type.Optional(Type.Boolean()),
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	supportsReasoningEffort: Type.Optional(Type.Boolean()),
	supportsUsageInStreaming: Type.Optional(Type.Boolean()),
	supportsFinishReason: Type.Optional(Type.Boolean()),
	maxTokensField: Type.Optional(Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")])),
	requiresToolResultName: Type.Optional(Type.Boolean()),
	requiresAssistantAfterToolResult: Type.Optional(Type.Boolean()),
	requiresThinkingAsText: Type.Optional(Type.Boolean()),
	requiresReasoningContentOnAssistantMessages: Type.Optional(Type.Boolean()),
	thinkingFormat: Type.Optional(
		Type.Union([
			Type.Literal("openai"),
			Type.Literal("openrouter"),
			Type.Literal("together"),
			Type.Literal("baseten"),
			Type.Literal("deepseek"),
			Type.Literal("zai"),
			Type.Literal("qwen"),
			Type.Literal("chat-template"),
			Type.Literal("qwen-chat-template"),
			Type.Literal("string-thinking"),
			Type.Literal("ant-ling"),
		]),
	),
	chatTemplateKwargs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
	chatTemplateArgs: Type.Optional(Type.Record(Type.String(), ChatTemplateKwargSchema)),
	cacheControlFormat: Type.Optional(Type.Literal("anthropic")),
	openRouterRouting: Type.Optional(OpenRouterRoutingSchema),
	vercelGatewayRouting: Type.Optional(VercelGatewayRoutingSchema),
	supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	deferredToolsMode: Type.Optional(Type.Literal("kimi")),
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
});

/** OpenAI Responses 类 API 的兼容性开关集合：developer 角色、会话亲和格式、严格模式、语法工具、工具搜索等。 */
const OpenAIResponsesCompatSchema = Type.Object({
	supportsDeveloperRole: Type.Optional(Type.Boolean()),
	sessionAffinityFormat: Type.Optional(
		Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]),
	),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	supportsStrictMode: Type.Optional(Type.Boolean()),
	supportsOpenAIGrammarTools: Type.Optional(Type.Boolean()),
	supportsAdditionalTools: Type.Optional(Type.Boolean()),
	supportsToolSearch: Type.Optional(Type.Boolean()),
});

/** Anthropic Messages 类 API 的兼容性开关集合：急切工具输入流式、长缓存保留、工具引用、温度支持等。 */
const AnthropicMessagesCompatSchema = Type.Object({
	supportsEagerToolInputStreaming: Type.Optional(Type.Boolean()),
	supportsLongCacheRetention: Type.Optional(Type.Boolean()),
	sendSessionAffinityHeaders: Type.Optional(Type.Boolean()),
	supportsCacheControlOnTools: Type.Optional(Type.Boolean()),
	supportsTemperature: Type.Optional(Type.Boolean()),
	forceAdaptiveThinking: Type.Optional(Type.Boolean()),
	allowEmptySignature: Type.Optional(Type.Boolean()),
	supportsStrictTools: Type.Optional(Type.Boolean()),
	supportsToolReferences: Type.Optional(Type.Boolean()),
});

/** 供应商兼容性配置的联合类型：三选一，由具体 API 风格决定可用的开关集合。 */
const ProviderCompatSchema = Type.Union([
	OpenAICompletionsCompatSchema,
	OpenAIResponsesCompatSchema,
	AnthropicMessagesCompatSchema,
]);

/** 基础费率（每百万 token 价格）：输入/输出/缓存读/缓存写。 */
const ModelCostRatesSchema = {
	input: Type.Number(),
	output: Type.Number(),
	cacheRead: Type.Number(),
	cacheWrite: Type.Number(),
};
/** 分层计费档位：输入 token 超过 inputTokensAbove 后适用本档费率（覆盖式定价）。 */
const ModelCostTierSchema = Type.Object({
	inputTokensAbove: Type.Number(),
	...ModelCostRatesSchema,
});
/** 模型费用：默认费率 + 可选的分层档位（按输入 token 量匹配适用档）。 */
const ModelCostSchema = Type.Object({
	...ModelCostRatesSchema,
	tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
});

/** 单个模型定义：id 必填，其余（显示名、API 类型、计费、上下文窗口、兼容开关等）均可选。 */
const ModelDefinitionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(ModelCostSchema),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

/** 对内置模型的部分覆盖：只允许改展示与行为元数据（不含 id/apiKey 等），字段全部可选。 */
const ModelOverrideSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	reasoning: Type.Optional(Type.Boolean()),
	thinkingLevelMap: Type.Optional(ThinkingLevelMapSchema),
	input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]))),
	cost: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
			tiers: Type.Optional(Type.Array(ModelCostTierSchema)),
		}),
	),
	contextWindow: Type.Optional(Type.Number()),
	maxTokens: Type.Optional(Type.Number()),
	samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
});

/** 单个供应商配置：连接信息（baseUrl/apiKey/oauth）+ 供应商级兼容开关 + 模型定义/覆盖表。 */
const ProviderConfigSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	baseUrl: Type.Optional(Type.String({ minLength: 1 })),
	apiKey: Type.Optional(Type.String({ minLength: 1 })),
	api: Type.Optional(Type.String({ minLength: 1 })),
	oauth: Type.Optional(Type.Literal("radius")),
	headers: Type.Optional(Type.Record(Type.String(), Type.String())),
	compat: Type.Optional(ProviderCompatSchema),
	authHeader: Type.Optional(Type.Boolean()),
	models: Type.Optional(Type.Array(ModelDefinitionSchema)),
	modelOverrides: Type.Optional(Type.Record(Type.String(), ModelOverrideSchema)),
});

/** models.json 顶层结构：仅一个 providers 记录表（key 为供应商标识）。 */
const ModelsConfigSchema = Type.Object({
	providers: Type.Record(Type.String(), ProviderConfigSchema),
});
// 预编译校验器：一次 Compile，之后每次 load 复用，避免重复构建校验函数
const validateModelsConfig = Compile(ModelsConfigSchema);

/** models.json 中的单个模型定义（由 Schema 推导出的静态类型）。 */
export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;
/** models.json 中的单个模型覆盖项类型。 */
export type ModelsJsonModelOverride = Static<typeof ModelOverrideSchema>;
/** models.json 中的单个供应商配置类型。 */
export type ModelsJsonProvider = Static<typeof ProviderConfigSchema>;
/** models.json 整体类型（内部使用）。 */
type ModelsJson = Static<typeof ModelsConfigSchema>;

/**
 * 把 typebox 校验错误的实例路径（JSON Pointer 风格 "/providers/x/models/0/id"）
 * 转换为点分路径（"providers.x.models.0.id"），提升错误报告的可读性。
 */
function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		// 缺失必填字段的错误挂在父对象上：把缺失的属性名拼到父路径之后
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

/** 递归深冻结对象及其所有嵌套属性，防止快照被使用方意外修改。 */
function deepFreeze<T>(value: T): T {
	// 非对象、null 或已冻结的子树直接返回（已冻结则其子节点也必然已冻结）
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/**
 * models.json 的一次不可变加载结果。
 * 无论文件缺失、解析失败还是校验失败都不会抛异常——错误以文本形式
 * 存在 error 字段中，providers 则为空表；由调用方决定如何呈现错误。
 */
export class ModelConfig {
	/** 已加载（并深冻结）的供应商配置表；出错时为空表 */
	private readonly providers: ReadonlyMap<string, ModelsJsonProvider>;
	/** 加载失败的错误报告文本；加载成功时为 undefined */
	private readonly error: string | undefined;

	// 构造器私有：外部只能通过静态 load() 创建实例，保证统一走错误处理流水线
	private constructor(providers: ReadonlyMap<string, ModelsJsonProvider>, error?: string) {
		this.providers = providers;
		this.error = error;
	}

	/**
	 * 加载并校验 models.json，产出不可变快照。
	 * 任何失败（读取/解析/校验）都不抛异常，而是返回带 error 描述的空快照。
	 * @param modelsJsonPath - 配置文件路径；undefined 或文件不存在时返回空快照（视为未配置）
	 */
	static async load(modelsJsonPath: string | undefined): Promise<ModelConfig> {
		if (!modelsJsonPath) return new ModelConfig(new Map());
		const path = normalizePath(modelsJsonPath);
		let content: string;
		try {
			content = await readFile(path, "utf-8");
		} catch (error) {
			// 文件不存在是正常情况（用户未自定义模型），静默返回空配置
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return new ModelConfig(new Map());
			return new ModelConfig(
				new Map(),
				`Failed to load models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		let parsed: unknown;
		try {
			// 先剥 BOM 再剥 JSON 注释，允许 models.json 带 // 注释书写
			parsed = JSON.parse(stripJsonComments(stripBom(content)));
		} catch (error) {
			return new ModelConfig(
				new Map(),
				`Failed to parse models.json: ${error instanceof Error ? error.message : error}\n\nFile: ${path}`,
			);
		}

		if (!validateModelsConfig.Check(parsed)) {
			// 校验失败：汇总全部错误（路径 + 信息）生成可读报告，而非只报第一个
			const errors =
				validateModelsConfig
					.Errors(parsed)
					.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
					.join("\n") || "Unknown schema error";
			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
		}

		const config = parsed as ModelsJson;
		const providers = new Map<string, ModelsJsonProvider>();
		for (const [providerId, provider] of Object.entries(config.providers)) {
			// structuredClone 先与 parsed 原对象断开引用，再深冻结，防止外部通过 parsed 改动快照
			providers.set(providerId, deepFreeze(structuredClone(provider)));
		}
		return new ModelConfig(providers);
	}

	/** 按供应商标识取配置；不存在时返回 undefined。 */
	getProvider(providerId: string): ModelsJsonProvider | undefined {
		return this.providers.get(providerId);
	}

	/** 全部供应商标识列表。 */
	getProviderIds(): readonly string[] {
		return [...this.providers.keys()];
	}

	/** 加载错误报告；加载成功时为 undefined。 */
	getError(): string | undefined {
		return this.error;
	}
}
