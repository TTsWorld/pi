/**
 * @file openai-completions.ts —— OpenAI Chat Completions 线协议适配层
 * @description
 * 实现 `openai-completions` API 家族的 stream / streamSimple 契约：
 * 把统一的 Context（systemPrompt + 历史消息 + 工具）翻译成 OpenAI Chat
 * Completions 请求体，再把流式 chunk 增量还原为统一的 AssistantMessageEventStream
 * （text / thinking / toolCall 三类内容块的 start / delta / end 事件）。
 *
 * 本文件是全包最大的单个 provider 适配层：xAI / Groq / Cerebras / OpenRouter /
 * DeepSeek / Together / Moonshot / Z.ai / Qwen / Cloudflare / NVIDIA 等几十家
 * provider 共用这一份实现，差异全部收敛到 OpenAICompletionsCompat 的 30 余个
 * 兼容开关与十余种 thinkingFormat 方言。复杂度集中在三处：
 *
 * 1. buildParams 的 thinkingFormat 方言链——把统一的「思维链等级」开关翻译成
 *    各家互不兼容的请求字段（reasoning_effort / thinking:{type} /
 *    enable_thinking / chat_template_kwargs / reasoning:{effort} …）；
 * 2. stream 内部的流式状态机——按 tool call 的 index / id 归并增量参数，
 *    并容错各家在 usage 摆放位置、finish_reason 缺失、reasoning 字段命名上的怪癖；
 * 3. parseChunkUsage 的计费口径归一——cached_tokens 的位置各家不同
 *    （OpenAI 放 prompt_tokens_details，DeepSeek 用 prompt_cache_hit_tokens，
 *    Kimi 放顶层 usage.cached_tokens），OpenRouter 还会额外拆出 cache_write_tokens。
 */

// ========== 依赖导入 ==========
// openai 官方 SDK：复用其 HTTP 客户端与 Chat Completions 类型定义
import OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionChunk,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionMessageToolCall,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions.js";
// 包内模型目录与统一类型契约
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	ChatTemplateKwargValue,
	Context,
	ImageContent,
	JsonValue,
	Message,
	Model,
	OpenAICompletionsCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingTokenBudgetField,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
// 通用工具：错误格式化、事件流、哈希、请求头、流式 JSON 修复、重试等
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
// 同目录辅助模块：约束采样（文法工具 / strict JSON schema）、GitHub Copilot 动态请求头、
// OpenAI 提示词缓存键、通用流式选项、跨 provider 消息改写
import {
	appendGrammarToolInputJsonDelta,
	createGrammarToolInputProperties,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { buildBaseOptions, clampThinkingBudgetToAnswerRoom, thinkingBudgetForLevel } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * 检查请求头集合中是否已存在指定名称的有效头。
 * 头名比较不区分大小写；值为 null（显式屏蔽默认头）或空白的视为不存在。
 *
 * @param headers 待检查的请求头集合
 * @param name 头名称（大小写不敏感）
 * @returns 存在且值为非空白字符串时返回 true
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

/**
 * 解析传给 OpenAI SDK 客户端的 apiKey。
 * 若调用方已在自定义请求头里带了 authorization / cf-aig-authorization
 * （例如走 Cloudflare AI Gateway 的网关令牌），SDK 仍要求非空 key，
 * 此时用占位符 "unused"；既没有显式 key 也没有认证头则直接抛错，提前失败。
 *
 * @param provider provider 标识（用于报错信息）
 * @param apiKey 显式传入的 API 密钥
 * @param headers 调用方自定义请求头
 * @returns 可传给 OpenAI 构造器的 apiKey 字符串
 */
function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

/**
 * 检查会话历史中是否包含工具调用或工具结果。
 * Anthropic（经代理转发到 Chat Completions 端点）要求：当消息里出现
 * tool_calls 或 tool 角色消息时，请求必须带 tools 参数——
 * 因此需要本探测来决定是否回填空 tools 数组。
 *
 * @param messages 会话历史消息
 * @returns 出现过任一工具调用 / 工具结果时返回 true
 */
function hasToolHistory(messages: Message[]): boolean {
	for (const msg of messages) {
		if (msg.role === "toolResult") {
			return true;
		}
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) {
				return true;
			}
		}
	}
	return false;
}

/**
 * 收集历史工具结果消息里登记过的「延迟工具」（deferred tool）名称。
 * Kimi 的延迟工具不在请求顶层 tools 里声明，而是在使用后通过特殊的
 * system+tools 消息补充注入；这里收集名称以便从顶层 tools 中剔除、
 * 并在转换消息时找回定义。
 *
 * @param messages 会话历史消息
 * @returns 已出现过的延迟工具名集合
 */
function getDeferredToolNames(messages: Message[]): Set<string> {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				names.add(name);
			}
		}
	}
	return names;
}

/**
 * 按名称从工具列表中取回工具定义（用于找回延迟工具的定义）。
 *
 * @param tools 全量工具定义
 * @param names 需要取回的工具名
 * @returns 命中的工具定义数组（忽略未知名称）
 */
function getToolsByName(tools: Tool[] | undefined, names: Iterable<string>): Tool[] {
	if (!tools) return [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	return Array.from(names)
		.map((name) => toolsByName.get(name))
		.filter((tool): tool is Tool => tool !== undefined);
}

// ========== 内容块类型守卫（缩小 Message.content 元素的联合类型） ==========

/** 是否为文本内容块。 */
function isTextContentBlock(block: { type: string }): block is TextContent {
	return block.type === "text";
}

/** 是否为思维链内容块。 */
function isThinkingContentBlock(block: { type: string }): block is ThinkingContent {
	return block.type === "thinking";
}

/** 是否为工具调用块。 */
function isToolCallBlock(block: { type: string }): block is ToolCall {
	return block.type === "toolCall";
}

/** 是否为图片内容块。 */
function isImageContentBlock(block: { type: string }): block is ImageContent {
	return block.type === "image";
}

// ========== reasoning detail 的运行时校验 ==========
// reasoning_details 是 OpenRouter / OpenAI 系的结构化思维链载体，回放时需要
// 严格校验形状，避免把任意 JSON 误当成可回放的思维链数据。

/** 判断未知值是否为非数组的普通对象（reasoning detail 的载体形状）。 */
function isReasoningDetailObject(detail: unknown): detail is Record<string, unknown> {
	return typeof detail === "object" && detail !== null && !Array.isArray(detail);
}

/** 校验 reasoning detail 的公共可选字段（id / format / index）类型是否合法。 */
function hasValidCommonReasoningDetailFields(candidate: Record<string, unknown>): boolean {
	return (
		(candidate.id === undefined || candidate.id === null || typeof candidate.id === "string") &&
		(candidate.format === undefined || typeof candidate.format === "string") &&
		(candidate.index === undefined || typeof candidate.index === "number")
	);
}

/**
 * 校验未知值是否为合法的 OpenAI reasoning detail 条目。
 * 覆盖三类：reasoning.summary（摘要文本）、reasoning.encrypted
 * （服务端加密的思维链原文，多轮回放用）、reasoning.text（明文思维链，可带签名）。
 *
 * @param detail 待校验的未知值
 * @returns 形状合法时返回 true
 */
function isOpenAIReasoningDetail(detail: unknown): detail is OpenAIReasoningDetail {
	if (!isReasoningDetailObject(detail) || !hasValidCommonReasoningDetailFields(detail)) {
		return false;
	}
	switch (detail.type) {
		case "reasoning.summary":
			return typeof detail.summary === "string";
		case "reasoning.encrypted":
			return typeof detail.data === "string";
		case "reasoning.text":
			return (
				typeof detail.text === "string" &&
				(detail.signature === undefined || detail.signature === null || typeof detail.signature === "string")
			);
		default:
			return false;
	}
}

/**
 * openai-completions 流式调用的完整选项。
 * 在所有 provider 共享的 StreamOptions 之上，补充 Chat Completions 特有参数。
 */
export interface OpenAICompletionsOptions extends StreamOptions {
	/** 强制工具选择（OpenAI tool_choice 原样格式）。 */
	toolChoice?: OpenAI.Chat.Completions.ChatCompletionToolChoiceOption;
	/** 思维链力度等级；off / 未设置表示不开启推理。 */
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** 各思维链等级的 token 预算。当设置了 `compat.thinkingTokenBudgetField` 或 `compat.supportsThinkingTokenBudget`，或 chat_template_kwargs 引用 `{ "$var": "thinking.budget" }` 时使用。 */
	thinkingBudgets?: ThinkingBudgets;
}

/** convertMessages 的可选参数。 */
export interface ConvertCompletionsMessagesOptions {
	/** 工具名 → 文法工具输入属性名 的映射（supportsOpenAIGrammarTools 启用时生成）。 */
	grammarToolInputProperties?: ReadonlyMap<string, string>;
}

/** Anthropic 风格 cache_control 标记（经 OpenRouter 等 Anthropic 兼容端点透传）。 */
interface OpenAICompatCacheControl {
	type: "ephemeral";
	ttl?: string;
}

/**
 * 「已解析」的兼容配置：把 OpenAICompletionsCompat 的全可选字段提升为必填
 * （默认值已由 detectCompat / getCompat 补齐），仅少数语义化字段保留可选。
 * 本文件内部统一使用该类型，避免到处判空。
 */
type ResolvedOpenAICompletionsCompat = Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "deferredToolsMode" | "supportsThinkingTokenBudget" | "thinkingTokenBudgetField"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
	supportsThinkingTokenBudget?: OpenAICompletionsCompat["supportsThinkingTokenBudget"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
};

/** chat_template_kwargs / chat_template_args 解析后的标量取值（$var 占位符已被替换）。 */
type ResolvedChatTemplateKwargValue = string | number | boolean | null;

/** 指令类消息（system 或 developer 角色）。 */
type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

/** Kimi 延迟工具注入用的特殊消息：role=system，直接携带 tools 字段且无 content。 */
type KimiToolSystemMessageParam = {
	role: "system";
	tools: OpenAI.Chat.Completions.ChatCompletionTool[];
};

/** reasoning detail 的公共基础字段。 */
type OpenAIReasoningDetailBase = Record<string, JsonValue> & {
	id?: string | null;
	format?: string;
	index?: number;
};

/** 摘要型 reasoning detail（OpenAI o 系 / gpt-5 的思维链摘要）。 */
type OpenAIReasoningSummaryDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.summary";
	summary: string;
};

/** 加密型 reasoning detail（服务端加密的思维链原文，多轮回放时原样透传）。 */
type OpenAIEncryptedReasoningDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.encrypted";
	data: string;
};

/** 明文 reasoning detail（部分 OpenAI 兼容端点使用，可附签名）。 */
type OpenAIReasoningTextDetail = OpenAIReasoningDetailBase & {
	type: "reasoning.text";
	text: string;
	signature?: string | null;
};

/** 三类 reasoning detail 的联合。 */
type OpenAIReasoningDetail = OpenAIReasoningSummaryDetail | OpenAIEncryptedReasoningDetail | OpenAIReasoningTextDetail;

/**
 * 尝试把 thinkingSignature 解析回 reasoning detail 数组。
 * thinkingSignature 平时承载各家的「思维链签名」，但 OpenRouter 流式场景会把
 * reasoning_details 数组 JSON 序列化后塞进同一槽位；解析失败或形状不合法时
 * 返回 undefined，调用方回退到普通签名处理。
 *
 * @param signature thinking 块的签名字符串
 * @returns 合法的非空 detail 数组，否则 undefined
 */
function parseOpenAIReasoningDetails(signature: string | undefined): OpenAIReasoningDetail[] | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isOpenAIReasoningDetail) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 解析旧版格式：工具调用的 thoughtSignature 里存的加密 reasoning detail。
 * 旧版本把加密思维链挂在 toolCall.thoughtSignature 上，回放时迁移到 assistant
 * 消息的 reasoning_details；仅接受带非空 id 与非空 data 的加密条目。
 *
 * @param signature 工具调用的 thoughtSignature
 * @returns 合法的加密 detail，否则 undefined
 */
function parseLegacyEncryptedReasoningDetail(
	signature: string | undefined,
): OpenAIEncryptedReasoningDetail | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		return isOpenAIReasoningDetail(parsed) &&
			parsed.type === "reasoning.encrypted" &&
			typeof parsed.id === "string" &&
			parsed.id.length > 0 &&
			parsed.data.length > 0
			? parsed
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * 用后到的 detail 补齐目标 detail 上缺失的公共字段（id / format / index）。
 * 用于流式合并时保留首个出现的元数据。
 *
 * @param target 合并目标（就地修改）
 * @param source 后到的 detail（取值来源）
 */
function fillMissingCommonReasoningDetailFields(
	target: OpenAIReasoningDetailBase,
	source: OpenAIReasoningDetail,
): void {
	target.id ??= source.id;
	target.format ||= source.format;
	target.index ??= source.index;
}

/**
 * 把一条 reasoning detail 追加进数组：相邻的同类型 text / summary 增量就地合并，
 * 加密条目与其他类型保持独立不合并（每个加密条目都是不透明的整体）。
 *
 * @param details 累积数组（就地修改）
 * @param detail 本轮新到的增量条目
 */
function appendOpenAIReasoningDetail(details: OpenAIReasoningDetail[], detail: OpenAIReasoningDetail): void {
	const lastDetail = details[details.length - 1];
	if (detail.type === "reasoning.text" && lastDetail?.type === "reasoning.text") {
		lastDetail.text += detail.text;
		lastDetail.signature ||= detail.signature;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	if (detail.type === "reasoning.summary" && lastDetail?.type === "reasoning.summary") {
		lastDetail.summary += detail.summary;
		fillMissingCommonReasoningDetailFields(lastDetail, detail);
		return;
	}
	details.push({ ...detail });
}

// 各家 OpenAI 兼容端点给「思维链增量」用的顶层字段名集合
// （llama.cpp 用 reasoning_content，其余端点多用 reasoning / reasoning_text）
const OPENAI_COMPLETIONS_REASONING_FIELDS = ["reasoning", "reasoning_content", "reasoning_text"] as const;

type OpenAICompletionsReasoningField = (typeof OPENAI_COMPLETIONS_REASONING_FIELDS)[number];

/** 判断字段名是否属于已知的思维链字段。 */
function isOpenAICompletionsReasoningField(field: string): field is OpenAICompletionsReasoningField {
	return OPENAI_COMPLETIONS_REASONING_FIELDS.includes(field as OpenAICompletionsReasoningField);
}

/** assistant 消息参数扩展：允许携带各家的思维链顶层字段与结构化 reasoning_details。 */
type ChatCompletionAssistantMessageParamWithReasoning = ChatCompletionAssistantMessageParam &
	Partial<Record<OpenAICompletionsReasoningField, string>> & {
		reasoning_details?: JsonValue[];
	};

/** 文本分段扩展：允许携带 Anthropic 风格 cache_control。 */
type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

/** 工具定义扩展：允许携带 Anthropic 风格 cache_control。 */
type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

/**
 * 解析提示词缓存保留时长：显式参数优先，其次 PI_CACHE_RETENTION=long
 * 环境变量（含 provider 级覆盖），默认 short。
 *
 * @param cacheRetention 调用方显式指定的保留时长
 * @param env provider 级环境变量覆盖
 * @returns 归一后的保留时长
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

/**
 * openai-completions 的流式入口。
 * 流程：组装请求（客户端、兼容配置、参数）→ 发起带重试的流式请求 →
 * 逐 chunk 解析增量（text / thinking / toolCall）→ 收尾校验并推送 done / error。
 *
 * @param model 目标模型（含 provider、baseUrl、compat）
 * @param context 会话上下文（systemPrompt、历史消息、工具）
 * @param options 流式选项（密钥、超时、中止信号、reasoningEffort 等）
 * @returns 统一的 AssistantMessageEventStream（函数立即返回，事件随流推进）
 */
export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// ========== 输出消息骨架：usage 与 stopReason 随流逐步填充 ==========
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			// ========== 请求准备：密钥、兼容配置、文法工具属性、缓存策略与客户端 ==========
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				compat.supportsOpenAIGrammarTools,
			);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId, compat);
			let params = buildParams(model, context, options, compat, cacheRetention, grammarToolInputProperties);
			// 调用方可通过 onPayload 钩子检视 / 整体替换最终请求负载
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			// SDK 内建重试关闭（maxRetries: 0），统一交给 retryProviderRequest 做带退避的重试
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.chat.completions.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			// ========== 流式解析状态 ==========
			// 三类内容块的增量归并策略：
			// - textBlock / thinkingBlock：同一轮内文本与思维链各自只有一个活跃块，惰性创建；
			// - toolCallBlocksByIndex / ById：工具调用增量按 chunk 内 index 或调用 id 归并
			//   （有的 provider 只给 index、有的只给 id，两条索引都要兜住）。
			interface StreamingToolCallBlock extends ToolCall {
				partialArgs?: string;
				customInput?: {
					property: string;
					jsonBuffer: GrammarToolInputJsonBuffer;
				};
				streamIndex?: number;
			}
			/** 流式期间输出内容数组里可能出现的块（比最终类型多出解析中间态字段）。 */
			type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
			/** 工具调用 delta 的宽松形状：function.* 为标准格式，custom.* 为文法工具格式。 */
			type StreamingToolCallDelta = {
				index?: number;
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
				custom?: { name?: string; input?: string };
			};

			let textBlock: TextContent | null = null;
			let thinkingBlock: ThinkingContent | null = null;
			// 是否已收到过 finish_reason（部分 provider 从不下发，需要兜底推断）
			let hasFinishReason = false;
			const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
			const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
			const blocks = output.content as StreamingBlock[];
			// 取块在输出 content 数组中的下标（事件流按该下标寻址）
			const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
			// 取文法工具当前已累积的输入文本
			const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
				const property = block.customInput?.property;
				if (property === undefined) return "";
				const value = block.arguments[property];
				return typeof value === "string" ? value : "";
			};
			/**
			 * 追加文法工具的输入增量：借助 JSON 流式缓冲把「裸文本增量」翻译成
			 * 合法 JSON 参数流的 delta；close=true 时补上收尾引号并封块。
			 */
			const appendCustomToolCallInput = (
				block: StreamingToolCallBlock,
				nextInput: string,
				close: boolean,
			): string | undefined => {
				const customInput = block.customInput;
				if (!customInput) return undefined;
				const delta = appendGrammarToolInputJsonDelta(
					customInput.jsonBuffer,
					customInput.property,
					nextInput,
					close,
				);
				block.arguments = { [customInput.property]: nextInput };
				return delta;
			};
			/**
			 * 收尾单个内容块并推送对应的 *_end 事件。
			 * 工具调用块在此定稿参数：文法工具补最后一次 JSON 收尾 delta，
			 * 普通工具则把累积的 partialArgs 解析成对象；最后清掉流式专用的
			 * 临时字段，保证重放（replay）只携带已解析的 arguments。
			 */
			const finishBlock = (block: StreamingBlock) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) {
					return;
				}
				if (block.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output,
					});
				} else if (block.type === "thinking") {
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output,
					});
				} else if (block.type === "toolCall") {
					if (block.customInput) {
						const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
						if (delta !== undefined) {
							stream.push({
								type: "toolcall_delta",
								contentIndex,
								delta,
								partial: output,
							});
						}
					} else {
						block.arguments = parseStreamingJson(block.partialArgs);
					}
					// 就地定稿并清掉解析用的临时缓冲，让重放只带已解析的 arguments。
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output,
					});
				}
			};
			// 惰性创建 / 复用本轮唯一的文本块
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = { type: "text", text: "" };
					blocks.push(textBlock);
					stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
				}
				return textBlock;
			};
			// 惰性创建 / 复用本轮唯一的思维链块；thinkingSignature 记录增量来源的字段名，
			// 回放时据此把思维链文本放回 provider 认识的同名字段
			const ensureThinkingBlock = (thinkingSignature: string) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature,
					};
					blocks.push(thinkingBlock);
					stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
				}
				return thinkingBlock;
			};
			/**
			 * 惰性创建 / 归并工具调用块：先按 chunk 内 index 查找、再按调用 id 查找，
			 * 两者都未命中才新建。新建时依据 delta 的形状决定走文法工具通道
			 * （custom.input，参数由 JSON 流式缓冲重建）还是标准 function.arguments
			 * 通道（参数由累积的 partialArgs 解析）；后续增量持续回填 name / id。
			 */
			const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
				if (!block && toolCall.id) {
					block = toolCallBlocksById.get(toolCall.id);
				}
				if (!block) {
					// 注意：这里的 "input" 兜底正常情况下不应被走到。万一模型编造了
					// 一个我们不知道的工具，至少还有个地方能存放流出的内容。
					const customInputProperty =
						toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
					const hasCustomInput = customInputProperty !== undefined;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
						partialArgs: hasCustomInput ? undefined : "",
						customInput: hasCustomInput
							? { property: customInputProperty, jsonBuffer: { input: "", started: false, closed: false } }
							: undefined,
						streamIndex,
					};
					if (streamIndex !== undefined) {
						toolCallBlocksByIndex.set(streamIndex, block);
					}
					if (toolCall.id) {
						toolCallBlocksById.set(toolCall.id, block);
					}
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output,
					});
				}
				if (streamIndex !== undefined && block.streamIndex === undefined) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) {
					toolCallBlocksById.set(toolCall.id, block);
				}
				if (!block.name && name) {
					block.name = name;
				}
				if (toolCall.custom && !toolCall.function && !block.customInput) {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					block.customInput = {
						property: customInputProperty,
						jsonBuffer: { input: "", started: false, closed: false },
					};
					delete block.partialArgs;
				}
				return block;
			};

			// ========== chunk 主循环：逐块解析增量与元数据 ==========
			for await (const chunk of openaiStream) {
				if (!chunk || typeof chunk !== "object") continue;

				// OpenAI 文档规定 ChatCompletionChunk.id 是整次补全的唯一标识，
				// 同一次流式补全的每个 chunk 携带相同 id。
				output.responseId ||= chunk.id;
				// 记录服务端实际使用的模型名（仅在与请求 id 不同时有意义）
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
					output.responseModel ||= chunk.model;
				}
				if (chunk.usage) {
					output.usage = parseChunkUsage(chunk.usage, model);
				}

				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
				if (!choice) continue;

				// 兜底：部分 provider（如 Moonshot）把 usage 放在 choice.usage，
				// 而不是标准的 chunk.usage
				if (!chunk.usage && (choice as any).usage) {
					output.usage = parseChunkUsage((choice as any).usage, model);
				}

				if (choice.finish_reason) {
					// 记录原始 finish_reason 并映射为统一 StopReason；
					// content_filter 等异常原因会映射为 error 并携带错误信息
					output.rawStopReason = choice.finish_reason;
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) {
						output.errorMessage = finishReasonResult.errorMessage;
					}
					hasFinishReason = true;
				}

				if (choice.delta) {
					// ---- 文本增量 ----
					if (
						choice.delta.content !== null &&
						choice.delta.content !== undefined &&
						choice.delta.content.length > 0
					) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output,
						});
					}

					// ---- 思维链增量（文本字段方言） ----
					// 部分端点把思维链放在 reasoning_content（llama.cpp），
					// 或 reasoning / reasoning_text（其他 OpenAI 兼容端点）。
					// 只取第一个非空字段，避免重复计数
					// （如 chutes.ai 会把相同内容同时放进 reasoning_content 和 reasoning）
					const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
					const deltaFields = choice.delta as Record<string, unknown>;
					let foundReasoningField: string | null = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}

					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						// opencode-go 特例：其 reasoning 字段回放时要映射为 reasoning_content
						if (typeof delta === "string" && delta.length > 0) {
							const thinkingSignature =
								model.provider === "opencode-go" && foundReasoningField === "reasoning"
									? "reasoning_content"
									: foundReasoningField;
							const block = ensureThinkingBlock(thinkingSignature);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					// ---- 工具调用增量：标准 function.arguments 与文法工具 custom.input 两种通道 ----
					if (choice?.delta?.tool_calls) {
						for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
							const block = ensureToolCallBlock(toolCall);
							if (!block.id && toolCall.id) {
								block.id = toolCall.id;
								toolCallBlocksById.set(toolCall.id, block);
							}
							const name = toolCall.function?.name ?? toolCall.custom?.name;
							if (!block.name && name) {
								block.name = name;
							}

							let delta = "";
							// 标准通道：累积原始 JSON 片段并即时尝试解析成部分对象；
							// 文法通道：累积裸文本增量并翻译成 JSON 流 delta
							if (toolCall.function?.arguments) {
								delta = toolCall.function.arguments;
								block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
								block.arguments = parseStreamingJson(block.partialArgs);
							} else if (toolCall.custom?.input) {
								const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
								delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
							}
							stream.push({
								type: "toolcall_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output,
							});
						}
					}

					// ---- 结构化 reasoning_details 增量（OpenRouter 方言） ----
					const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) {
							if (!isOpenAIReasoningDetail(detail)) continue;
							const block = ensureThinkingBlock("");
							const preservedDetails = parseOpenAIReasoningDetails(block.thinkingSignature) ?? [];
							appendOpenAIReasoningDetail(preservedDetails, detail);
							// 把 provider 回放数据保存在既有的签名槽位里。OpenRouter 以
							// delta 形式流式下发 reasoning_details：连续的 text / summary 增量
							// 合并成逻辑条目，加密条目则保持独立、不透明。
							block.thinkingSignature = JSON.stringify(preservedDetails);
						}
					}
				}
			}

			// ========== 收尾：逐块定稿并校验终止条件 ==========
			for (const block of blocks) {
				finishBlock(block);
			}
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			// provider 从不下发 finish_reason 时自行推断：有工具调用即 toolUse，否则 stop
			if (!hasFinishReason && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			// 声称支持 finish_reason 的 provider 却没给，或状态仍停留在 pending：
			// 视为流被异常截断
			if ((compat.supportsFinishReason && !hasFinishReason) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// ========== 错误分支：清理临时字段并输出带错误信息的 partial ==========
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// 流式解析的临时缓冲只在解析期间使用，绝不持久化到最终消息。
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { customInput?: unknown }).customInput;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			// 部分经 OpenRouter 转发的 provider 会在该字段附加上下文信息。
			// normalizeProviderError 已把解析出的响应体（error.error）字符串化进
			// errorMessage，这里只在原始 metadata 尚未被包含时追加，避免重复输出。
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * openai-completions 的简化流式入口。
 * 用 buildBaseOptions 归一通用选项（maxTokens 按上下文裁剪、reasoning 等级钳制等），
 * 再把思维链等级（off 除外）透传为 reasoningEffort，委托给上面的 stream。
 * 开头先调 getClientApiKey 是为了「提前失败」：密钥缺失时立刻抛错，
 * 而不是等到发请求后由 SDK 报错。
 *
 * @param model 目标模型
 * @param context 会话上下文
 * @param options 简化流式选项
 * @returns 统一的 AssistantMessageEventStream
 */
export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions;
	// 钳制到模型支持的思维链等级；off 档转为 undefined（不请求推理）
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		thinkingBudgets: options?.thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
};

/**
 * 构造 OpenAI SDK 客户端实例。
 * 请求头按优先级依次叠加：pi User-Agent 与模型默认头 → GitHub Copilot 动态头
 * （有 vision 输入时）→ 会话亲和头（用于提示词缓存路由）→ 调用方自定义头（最高优先）。
 *
 * @param model 目标模型
 * @param context 会话上下文（Copilot 动态头需要检视消息）
 * @param apiKey API 密钥（可能是 "unused" 占位）
 * @param optionsHeaders 调用方自定义请求头（最后合并，可覆盖默认头）
 * @param fetch 自定义 fetch 实现
 * @param sessionId 会话 id（启用会话亲和时发送）
 * @param compat 已解析的兼容配置
 * @returns 配置好的 OpenAI 客户端
 */
function createClient(
	model: Model<"openai-completions">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	// 会话亲和头：把同一会话的请求路由到同一后端副本，以最大化提示词缓存命中。
	// OpenRouter 用 x-session-id；OpenAI 系发 session_id + 两个亲和头
	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}

	// 调用方请求头最后合并，保证能覆盖上述默认头
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	// dangerouslyAllowBrowser：本 SDK 需支持浏览器环境直连各兼容端点
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

/**
 * 组装 Chat Completions 流式请求体。
 * 处理顺序（后者可覆盖前者）：消息转换与缓存字段 → 通用采样参数 →
 * 工具（含延迟工具剔除 / 空 tools 回填）→ Anthropic 风格 cache_control →
 * thinkingFormat 方言字段 → 思维链 token 预算 → 路由偏好 → 自定义 samplingParams。
 *
 * @param model 目标模型
 * @param context 会话上下文
 * @param options 流式选项
 * @param compat 已解析的兼容配置
 * @param cacheRetention 提示词缓存保留时长
 * @param grammarToolInputProperties 文法工具的输入属性映射
 * @returns 可直接发给 /chat/completions 的流式请求参数
 */
function buildParams(
	model: Model<"openai-completions">,
	context: Context,
	options?: OpenAICompletionsOptions,
	compat: ResolvedOpenAICompletionsCompat = getCompat(model),
	cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		compat.supportsOpenAIGrammarTools,
	),
) {
	const messages = convertMessages(model, context, compat, { grammarToolInputProperties });
	const cacheControl = getCompatCacheControl(compat, cacheRetention);

	// ========== 基础参数与提示词缓存 ==========
	// prompt_cache_key 让同会话请求命中同一缓存分片：仅在 OpenAI 官方端点，
	// 或显式要求长保留且 provider 支持时发送；key 超长时会被裁剪
	const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key:
			(model.baseUrl.includes("api.openai.com") && cacheRetention !== "none") ||
			(cacheRetention === "long" && compat.supportsLongCacheRetention)
				? clampOpenAIPromptCacheKey(options?.sessionId)
				: undefined,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined,
	};

	// 请求流式响应附带 usage（不支持 stream_options 的 provider 跳过）
	if (compat.supportsUsageInStreaming !== false) {
		(params as any).stream_options = { include_usage: true };
	}

	// store 会把补全结果保存在服务端，这里显式关闭；非标 provider 不认该字段
	if (compat.supportsStore) {
		params.store = false;
	}

	// ========== 输出上限与温度 ==========
	// max_tokens vs max_completion_tokens：老命名仍被大量兼容端点要求
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") {
			(params as any).max_tokens = options.maxTokens;
		} else {
			params.max_completion_tokens = options.maxTokens;
		}
	}

	if (options?.temperature !== undefined) {
		params.temperature = options.temperature;
	}

	// ========== 工具参数 ==========
	// Kimi 延迟工具：已注入过的工具从顶层 tools 里剔除，改由消息流内的
	// system+tools 消息携带定义（见 convertMessages）
	const deferredToolNames =
		compat.deferredToolsMode === "kimi" ? getDeferredToolNames(context.messages) : new Set<string>();
	const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));
	if (activeTools && activeTools.length > 0) {
		params.tools = convertTools(activeTools, compat);
		// z.ai 的工具调用流式开关
		if (compat.zaiToolStream) {
			(params as any).tool_stream = true;
		}
	} else if (hasToolHistory(context.messages)) {
		// Anthropic（经 LiteLLM/代理转发）要求：会话里已有 tool_calls / tool 结果时
		// 请求必须带 tools 参数，此时回填空数组
		params.tools = [];
	}

	// Anthropic 风格缓存标记：打在系统提示词、最后一个工具与最后一条对话消息上
	if (cacheControl) {
		applyAnthropicCacheControl(messages, params.tools, cacheControl);
	}

	if (options?.toolChoice && params.tools?.length) {
		params.tool_choice = options.toolChoice;
	}

	// ========== thinkingFormat 方言：把统一的思维链开关翻译成各家请求字段 ==========
	// 以下分支互斥，按 compat.thinkingFormat 选择；model.reasoning 为假
	// （非推理模型）时全部跳过。部分方言在 off 档也要显式下发关闭指令，
	// 避免服务端按默认配置开启推理。等级值优先经 model.thinkingLevelMap
	// 映射成 provider 自己的档位命名，映射不到时回退统一等级字符串。
	const thinkingTokenBudgetField = resolveThinkingTokenBudgetField(compat);
	const thinkingBudget = resolveClampedThinkingBudget(model, options, params);

	// zai 方言：thinking:{type} 总开关（clear_thinking=false 保留思维链）+ 可选 reasoning_effort
	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params as Omit<typeof params, "reasoning_effort"> & {
			thinking?: { type: "enabled" | "disabled"; clear_thinking?: boolean };
			reasoning_effort?: string;
		};
		zaiParams.thinking = options?.reasoningEffort ? { type: "enabled", clear_thinking: false } : { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === undefined ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") {
				zaiParams.reasoning_effort = effort;
			}
		}
	// qwen 方言：顶层 enable_thinking 布尔开关 + 可选 reasoning_effort
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) {
		(params as any).enable_thinking = !!options?.reasoningEffort;
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
			if (typeof effort === "string") {
				(params as any).reasoning_effort = effort;
			}
		}
	// qwen-chat-template 方言：vLLM 承载 Qwen 时经 chat_template_kwargs 控制，
	// preserve_thinking=true 让思维链在多轮之间保留
	} else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) {
		(params as any).chat_template_kwargs = {
			enable_thinking: !!options?.reasoningEffort,
			preserve_thinking: true,
		};
	// chat-template 方言：完全由模型目录配置的 chat_template_kwargs 模板渲染，
	// 值中可用 { "$var": ... } 占位符引用 thinking.enabled / thinking.budget 等取值
	} else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateValues(model, options, compat.chatTemplateKwargs, thinkingBudget);
		if (chatTemplateKwargs) {
			(params as any).chat_template_kwargs = chatTemplateKwargs;
		}
	// baseten 方言：chat_template_args（同样支持 $var 占位符）+ 可选 reasoning_effort；
	// off 时也尝试下发映射后的 off 档，确保关闭推理
	} else if (compat.thinkingFormat === "baseten" && model.reasoning) {
		const basetenParams = params as Omit<typeof params, "reasoning_effort"> & {
			chat_template_args?: Record<string, ResolvedChatTemplateKwargValue>;
			reasoning_effort?: string;
		};
		const chatTemplateArgs = buildChatTemplateValues(model, options, compat.chatTemplateArgs, thinkingBudget);
		if (chatTemplateArgs) {
			basetenParams.chat_template_args = chatTemplateArgs;
		}
		if (compat.supportsReasoningEffort) {
			const requestedEffort = options?.reasoningEffort;
			const mappedEffort = requestedEffort ? model.thinkingLevelMap?.[requestedEffort] : model.thinkingLevelMap?.off;
			const effort = mappedEffort === undefined ? requestedEffort : mappedEffort;
			if (typeof effort === "string") {
				basetenParams.reasoning_effort = effort;
			}
		}
	// deepseek 方言：thinking:{type:"enabled"|"disabled"} 开关；off 档存在映射时才显式关闭
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		if (options?.reasoningEffort) {
			(params as any).thinking = { type: "enabled" };
		} else if (model.thinkingLevelMap?.off !== null) {
			(params as any).thinking = { type: "disabled" };
		}
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			(params as any).reasoning_effort =
				model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	// openrouter 方言：OpenRouter 用嵌套 reasoning 对象归一化各上游的推理控制；
	// off 时也下发 effort:"none"（或映射的 off 档）
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		const openRouterParams = params as typeof params & { reasoning?: { effort?: string } };
		if (options?.reasoningEffort) {
			openRouterParams.reasoning = {
				effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort,
			};
		} else if (model.thinkingLevelMap?.off !== null) {
			openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		}
	// ant-ling 方言：仅在映射后的 effort 是字符串时才发 reasoning:{effort}，
	// off 档（无 reasoningEffort）不下发任何字段
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") {
			(params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort };
		}
	// together 方言：reasoning:{enabled} 布尔开关 + 可选 reasoning_effort
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params as Omit<typeof params, "reasoning_effort"> & {
			reasoning?: { enabled: boolean };
			reasoning_effort?: string;
		};
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		}
	// string-thinking 方言：顶层 thinking 直接收字符串形式的档位（含 off 档名）
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params as typeof params & { thinking?: string };
		if (options?.reasoningEffort) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		} else if (model.thinkingLevelMap?.off !== null) {
			stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
		}
	// 默认 openai 方言：顶层 reasoning_effort
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		(params as any).reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		// 未请求推理时，若模型定义了 off 档映射则显式下发，确保关闭推理
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") {
			(params as any).reasoning_effort = offValue;
		}
	}

	// ========== 思维链 token 预算封顶（与 thinkingFormat 正交） ==========
	// 同一服务器可能同时服务 zai / qwen / chat-template 模型。这些端点上推理与
	// 回答共享 max_tokens，不设预算时推理阶段可能吃光整个响应，导致既没有回答
	// 也没有工具调用。
	if (thinkingTokenBudgetField && thinkingBudget !== undefined) {
		Object.assign(params, { [thinkingTokenBudgetField]: thinkingBudget });
	}

	// ========== 路由偏好 ==========
	// OpenRouter 的上游路由偏好，作为请求体的 provider 字段发送
	if (model.compat?.openRouterRouting) {
		(params as any).provider = model.compat.openRouterRouting;
	}

	// Vercel AI Gateway 的路由偏好，映射为 providerOptions.gateway
	if (model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions: Record<string, string[]> = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			(params as any).providerOptions = { gateway: gatewayOptions };
		}
	}

	// 自定义采样参数最后合并，保证能覆盖上面已写入的具名请求字段
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}

	return params;
}

/**
 * 解析思维链预算使用的顶层请求字段名：
 * 显式 thinkingTokenBudgetField 优先；supportsThinkingTokenBudget 是
 * vLLM 默认字段 thinking_token_budget 的别名开关；都不满足则不启用预算。
 *
 * @param compat 兼容配置（仅需这两个字段）
 * @returns 字段名，未启用时返回 undefined
 */
function resolveThinkingTokenBudgetField(
	compat: Pick<OpenAICompletionsCompat, "thinkingTokenBudgetField" | "supportsThinkingTokenBudget">,
): ThinkingTokenBudgetField | undefined {
	if (compat.thinkingTokenBudgetField) return compat.thinkingTokenBudgetField;
	if (compat.supportsThinkingTokenBudget) return "thinking_token_budget";
	return undefined;
}

/**
 * 计算钳制后的思维链 token 预算。
 * 上限取 max_tokens / max_completion_tokens / model.maxTokens 中最先命中者，
 * 再经 clampThinkingBudgetToAnswerRoom 保证给回答留出空间；
 * 未开启推理或预算非正时返回 undefined（不下发预算字段）。
 *
 * @param model 目标模型
 * @param options 流式选项（取 reasoningEffort 与 thinkingBudgets）
 * @param params 已组装的请求参数（读取输出上限）
 * @returns 钳制后的预算，或 undefined
 */
function resolveClampedThinkingBudget(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	params: { max_tokens?: number | null; max_completion_tokens?: number | null },
): number | undefined {
	if (!options?.reasoningEffort || !model.reasoning) return undefined;
	const ceiling = params.max_tokens ?? params.max_completion_tokens ?? model.maxTokens;
	const budget = clampThinkingBudgetToAnswerRoom(
		thinkingBudgetForLevel(options.reasoningEffort, options.thinkingBudgets),
		ceiling,
	);
	return budget > 0 ? budget : undefined;
}

/**
 * 渲染 chat_template_kwargs / chat_template_args 模板：
 * 逐键解析 $var 占位符，解析不出值的键直接丢弃；全部键都解析失败时返回 undefined。
 *
 * @param model 目标模型
 * @param options 流式选项
 * @param values 模型目录里配置的原始键值
 * @param thinkingBudget 钳制后的思维链预算（供 thinking.budget 占位符引用）
 * @returns 解析后的键值表，或 undefined
 */
function buildChatTemplateValues(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	values: Record<string, ChatTemplateKwargValue>,
	thinkingBudget?: number,
): Record<string, ResolvedChatTemplateKwargValue> | undefined {
	const resolvedValues: Record<string, ResolvedChatTemplateKwargValue> = {};

	for (const [key, value] of Object.entries(values)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value, thinkingBudget);
		if (resolved !== undefined) {
			resolvedValues[key] = resolved;
		}
	}

	return Object.keys(resolvedValues).length > 0 ? resolvedValues : undefined;
}

/**
 * 解析单个 chat template kwarg 的取值。
 * 标量原样返回；对象则视为 $var 占位符：
 * - thinking.enabled → 是否开启推理（布尔）；
 * - thinking.budget → 钳制后的 token 预算；
 * - 其余（视为 effort 档位）→ 经 thinkingLevelMap 映射，映射不到时回退原始档位字符串；
 * - 带 omitWhenOff 且未开启推理时整键省略。
 *
 * @param model 目标模型
 * @param options 流式选项
 * @param value 原始取值（标量或 $var 占位对象）
 * @param thinkingBudget 思维链预算
 * @returns 解析后的标量取值，或 undefined（表示丢弃该键）
 */
function resolveChatTemplateKwargValue(
	model: Model<"openai-completions">,
	options: OpenAICompletionsOptions | undefined,
	value: ChatTemplateKwargValue,
	thinkingBudget?: number,
): ResolvedChatTemplateKwargValue | undefined {
	if (typeof value !== "object" || value === null) {
		return value;
	}

	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) {
		return undefined;
	}
	if (value.$var === "thinking.enabled") {
		return !!reasoningEffort;
	}
	if (value.$var === "thinking.budget") {
		return thinkingBudget;
	}

	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === undefined ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : undefined;
}

/**
 * 计算 Anthropic 风格 cache_control 标记：
 * 仅当 cacheControlFormat 为 "anthropic" 且未禁用缓存时生效；
 * 长保留且 provider 支持时附加 ttl:"1h"，否则为无 ttl 的 ephemeral。
 *
 * @param compat 已解析的兼容配置
 * @param cacheRetention 缓存保留时长
 * @returns cache_control 标记，不适用时返回 undefined
 */
function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

/**
 * 按 Anthropic 缓存约定打标记：第一条系统提示词 + 最后一个工具定义 +
 * 最后一条 user/assistant/tool 对话消息。Anthropic 缓存以这些断点为
 * 前缀边界（经 OpenRouter 等 Anthropic 兼容端点透传）。
 *
 * @param messages 已转换的消息数组（就地修改）
 * @param tools 工具定义数组（就地修改）
 * @param cacheControl cache_control 标记
 */
function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}

/** 给第一条 system/developer 指令消息打缓存标记（只处理首条指令）。 */
function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

/** 从后往前找最后一条 user/assistant/tool 消息并打缓存标记。 */
function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

/** 给工具列表的最后一项打缓存标记。 */
function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

/** 指令消息（system/developer）的缓存标记入口。 */
function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

/** 对话消息的缓存标记入口（仅处理 user/assistant/tool 三种角色）。 */
function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

/**
 * 就地给消息内容打缓存标记：
 * 字符串内容升级为带 cache_control 的 text 分段（空串不打）；
 * 数组内容则从后往前找最后一个 text 分段打标（图片等分段不动）。
 *
 * @param message 目标消息（就地修改）
 * @param cacheControl cache_control 标记
 * @returns 是否成功打上标记（调用方据此决定是否继续向前找）
 */
function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| ChatCompletionToolMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}

/**
 * 把统一的 Context 消息历史转换为 Chat Completions 的 messages 参数。
 * 覆盖各 provider 的消息级怪癖：工具调用 ID 归一化、developer 角色选择、
 * 工具结果后补 assistant 桥接消息、思维链回放（顶层文本字段 vs 结构化
 * reasoning_details）、工具结果附带图片的搬运、Kimi 延迟工具注入等。
 *
 * @param model 目标模型
 * @param context 会话上下文
 * @param compat 已解析的兼容配置
 * @param options 附加选项（文法工具输入属性映射）
 * @returns 可放入请求体的 messages 数组
 */
export function convertMessages(
	model: Model<"openai-completions">,
	context: Context,
	compat: ResolvedOpenAICompletionsCompat,
	options?: ConvertCompletionsMessagesOptions,
): ChatCompletionMessageParam[] {
	const params: ChatCompletionMessageParam[] = [];

	// ========== 工具调用 ID 归一化 ==========
	const normalizeToolCallId = (id: string): string => {
		// 处理 OpenAI Responses API 的竖线分隔 ID：
		// 格式为 {call_id}|{id}，其中 {id} 可达 400+ 字符且含特殊字符（+ / =），
		// 来自 github-copilot、openai-codex、opencode 等 provider。
		// 同一轮的多个工具调用可能共享 call_id 但 item_id 不同；
		// 回放进 Chat Completions 时要保留 item 级唯一性
		// （它要求工具调用 id 互不相同）。
		if (id.includes("|")) {
			// 清洗为允许的字符集，超长时截断到 40 字符（OpenAI 上限）
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) {
				return combinedId;
			}
			const hash = shortHash(id).slice(0, 8);
			const prefix = callId.slice(0, Math.max(1, 40 - hash.length - 1));
			return `${prefix}_${hash}`;
		}

		// OpenAI 官方端点：直接截断超长 id；其他 provider 原样放行
		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};

	// 跨 provider 改写消息（图片降级、孤儿工具调用补结果、ID 归一化）
	const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));

	// ========== 系统提示词：推理模型且支持时升级为 developer 角色 ==========
	if (context.systemPrompt) {
		const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
		const role = useDeveloperRole ? "developer" : "system";
		params.push({ role: role, content: sanitizeSurrogates(context.systemPrompt) });
	}

	let lastRole: string | null = null;

	// ========== 逐条转换历史消息 ==========
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		// 部分 provider 不允许用户消息紧跟在工具结果之后，
		// 插入一条合成的 assistant 消息做桥接
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") {
			params.push({
				role: "assistant",
				content: "I have processed the tool results.",
			});
		}

		if (msg.role === "user") {
			// 字符串内容直传；数组内容映射为 text / image_url 分段（图片转 base64 data URL）
			if (typeof msg.content === "string") {
				params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content),
				});
			} else {
				const content: ChatCompletionContentPart[] = msg.content.map((item): ChatCompletionContentPart => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						} satisfies ChatCompletionContentPartText;
					} else {
						return {
							type: "image_url",
							image_url: {
								url: `data:${item.mimeType};base64,${item.data}`,
							},
						} satisfies ChatCompletionContentPartImage;
					}
				});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// 部分 provider 不接受 null content，用空字符串代替
			const assistantMsg: ChatCompletionAssistantMessageParamWithReasoning = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null,
			};

			// ---- 文本部分：过滤空块后收集（最终以纯字符串形式发送） ----
			const assistantTextParts = msg.content
				.filter(isTextContentBlock)
				.filter((block) => block.text.trim().length > 0)
				.map(
					(block) =>
						({
							type: "text",
							text: sanitizeSurrogates(block.text),
						}) satisfies ChatCompletionContentPartText,
				);
			const assistantText = assistantTextParts.map((part) => part.text).join("");

			// ---- 思维链回放：优先结构化 reasoning_details，其次顶层文本字段 ----
			const thinkingBlocks = msg.content.filter(isThinkingContentBlock);
			const toolCalls = msg.content.filter(isToolCallBlock);
			// 新版路径：thinking 块签名里序列化的 reasoning_details 数组
			const signedReasoningDetails = thinkingBlocks
				.map((block) => parseOpenAIReasoningDetails(block.thinkingSignature))
				.find((details) => details !== undefined);
			// 旧版路径：加密思维链曾挂在 toolCall.thoughtSignature 上
			const legacyReasoningDetails = toolCalls
				.map((toolCall) => parseLegacyEncryptedReasoningDetail(toolCall.thoughtSignature))
				.filter((detail): detail is OpenAIEncryptedReasoningDetail => detail !== undefined);
			const preservedReasoningDetails =
				signedReasoningDetails ?? (legacyReasoningDetails.length > 0 ? legacyReasoningDetails : undefined);

			const nonEmptyThinkingBlocks = thinkingBlocks.filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) {
					// 思维链降级为纯文本（不加 <thinking> 标签，避免模型模仿标签语法）
					const thinkingText = nonEmptyThinkingBlocks
						.map((block) => sanitizeSurrogates(block.thinking))
						.join("\n\n");
					assistantMsg.content = [{ type: "text", text: thinkingText }, ...assistantTextParts];
				} else {
					// 始终以纯字符串发送 assistant content（OpenAI Chat Completions
					// API 的标准格式）。发 {type:"text", text:"..."} 对象数组是非标准做法，
					// 会导致部分模型（如经 NVIDIA NIM 的 DeepSeek V3.2）在输出里
					// 逐字镜像内容块结构，产生 [{'type':'text','text':'[{...}]'}] 这类递归嵌套。
					if (assistantText.length > 0) {
						assistantMsg.content = assistantText;
					}

					// reasoning_details 是裸 reasoning 顶层字段之外的结构化替代方案。
					if (!preservedReasoningDetails) {
						// 若首个思维链块带有来源字段签名则复用（llama.cpp server + gpt-oss 场景），
						// 把思维链文本放回 provider 认识的同名顶层字段
						let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
						if (model.provider === "opencode-go" && signature === "reasoning") {
							signature = "reasoning_content";
						}
						if (signature && isOpenAICompletionsReasoningField(signature)) {
							assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
						}
					}
				}
			} else if (assistantText.length > 0) {
				// （同上）始终以纯字符串发送 assistant content，原因见上方注释：
				// 数组形式是非标准做法，会让部分模型镜像出递归嵌套的内容块结构。
				assistantMsg.content = assistantText;
			}

			// ---- 工具调用：文法工具走 custom 通道，其余走标准 function 通道 ----
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc): ChatCompletionMessageToolCall => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== undefined) {
						return {
							id: tc.id,
							type: "custom",
							custom: {
								name: tc.name,
								input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty)),
							},
						};
					}
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					};
				});
			}
			// 结构化 reasoning_details 直接透传（优先于上面的文本字段回放）
			if (preservedReasoningDetails) {
				assistantMsg.reasoning_details = preservedReasoningDetails;
			}
			// DeepSeek：开启推理时所有回放的 assistant 消息都必须带 reasoning_content
			// 字段，缺失时补空串
			if (
				compat.requiresReasoningContentOnAssistantMessages &&
				model.reasoning &&
				assistantMsg.reasoning_content === undefined
			) {
				assistantMsg.reasoning_content = "";
			}
			// 跳过既无内容又无工具调用的 assistant 消息：
			// 部分 provider 要求「content 与 tool_calls 二者必有其一」，
			// 也有 provider 不接受空 assistant 消息；这里顺带处理被中断、
			// 尚未产出任何内容的 assistant 回复。
			const content = assistantMsg.content;
			const hasContent =
				content !== null &&
				content !== undefined &&
				(typeof content === "string" ? content.length > 0 : content.length > 0);
			if (!hasContent && !assistantMsg.tool_calls) {
				continue;
			}
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			// 工具结果可能连续多条；其中附带的图片需单独搬到后续 user 消息里
			const imageBlocks: Array<{ type: "image_url"; image_url: { url: string } }> = [];
			// 本批工具结果里登记的延迟工具名（Kimi）
			const deferredToolNames = new Set<string>();
			let j = i;

			// ========== 消化连续的 toolResult 消息 ==========
			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j] as ToolResultMessage;

				// 提取文本与图片内容
				const textResult = toolMsg.content
					.filter(isTextContentBlock)
					.map((block) => block.text)
					.join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");

				// 工具结果始终带文本（只有图片时用占位符，否则用「无输出」占位）
				const hasText = textResult.length > 0;
				const toolResultText = hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				// 部分 provider 要求工具结果携带 name 字段
				const toolResultMsg: ChatCompletionToolMessageParam = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId,
				};
				if (compat.requiresToolResultName && toolMsg.toolName) {
					(toolResultMsg as any).name = toolMsg.toolName;
				}
				params.push(toolResultMsg);

				// 记录本条结果里注入的延迟工具名，稍后统一补发定义
				if (compat.deferredToolsMode === "kimi") {
					for (const name of toolMsg.addedToolNames ?? []) {
						deferredToolNames.add(name);
					}
				}

				// 模型支持图片输入时，把工具结果里的图片收进 imageBlocks
				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) {
						if (isImageContentBlock(block)) {
							imageBlocks.push({
								type: "image_url",
								image_url: {
									url: `data:${block.mimeType};base64,${block.data}`,
								},
							});
						}
					}
				}
			}

			i = j - 1;

			// ========== 图片搬运：工具结果里的图片必须挂在 user 消息下 ==========
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) {
					// 同前：部分 provider 不允许 user 消息紧跟 tool 结果，先插一条桥接
					params.push({
						role: "assistant",
						content: "I have processed the tool results.",
					});
				}

				params.push({
					role: "user",
					content: [
						{
							type: "text",
							text: "Attached image(s) from tool result:",
						},
						...imageBlocks,
					],
				});
				lastRole = "user";
			} else {
				lastRole = "toolResult";
			}

			// ========== Kimi 延迟工具：用 system+tools 消息补发工具定义 ==========
			if (deferredToolNames.size > 0) {
				const deferredTools = getToolsByName(context.tools, deferredToolNames);
				if (deferredTools.length > 0) {
					const kimiToolMessage: KimiToolSystemMessageParam = {
						role: "system",
						tools: convertTools(deferredTools, compat),
					};
					// Kimi 接受带 tools 的 system 消息，但要求省略标准的 content 字段。
					params.push(kimiToolMessage as unknown as ChatCompletionMessageParam);
				}
			}
			continue;
		}

		lastRole = msg.role;
	}

	return params;
}

/**
 * 把统一工具定义转换为 Chat Completions 的 tools 参数。
 * 工具带文法约束（Lark / 正则）且 provider 支持时输出 custom 工具；
 * 否则输出标准 function 工具，strict 字段仅对支持的 provider 下发。
 *
 * @param tools 统一工具定义列表
 * @param compat 已解析的兼容配置
 * @returns Chat Completions 格式的工具定义数组
 */
function convertTools(
	tools: Tool[],
	compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		// 文法工具：以 custom 通道下发语法约束（lark / regex）
		if (grammar) {
			return {
				type: "custom",
				custom: {
					name: tool.name,
					description: tool.description,
					format: {
						type: "grammar",
						grammar: {
							syntax: grammar.format,
							definition: grammar.definition,
						},
					},
				},
			};
		}

		// 标准 function 工具
		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: getJsonSchemaToolParameters(tool, strict) as Record<string, unknown>,
				// 仅当 provider 支持时才带 strict 字段，部分 provider 会拒绝未知字段。
				...(compat.supportsStrictMode !== false && { strict: strict ?? false }),
			},
		};
	});
}

/**
 * 把各家口径不一的 usage 对象归一为统一计费口径，并即时计算费用。
 *
 * @param rawUsage provider 原始 usage（字段名兼容多种方言）
 * @param model 目标模型（提供计费表）
 * @returns 统一的 usage（含 cost）
 */
function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model<"openai-completions">,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;

	// 遵循 OpenAI/OpenRouter 文档语义：cached_tokens 是缓存读（命中）token 数。
	// 各 provider 摆放位置不一：OpenAI/OpenRouter 用 prompt_tokens_details.cached_tokens，
	// DeepSeek 用 prompt_cache_hit_tokens，Kimi 文档化在最终 usage chunk 的顶层
	// usage.cached_tokens。OpenAI 不文档化也不输出 cache_write_tokens，但
	// OpenRouter 兼容的 provider 可能把它作为独立的写入计数附带。
	// OpenRouter 自家的 provider/测试证实了这一独立映射：
	// https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
	// 不要从 cached_tokens 里扣掉写入数，否则符合规范的 provider 会被少报。
	// DS4 同样遵循该契约：https://github.com/antirez/ds4/pull/29
	// input 口径：总提示词 token 扣除缓存读与缓存写（两者都不按全价计费）
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI 的 completion_tokens 已包含 reasoning_tokens。
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage: AssistantMessage["usage"] = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, usage);
	return usage;
}

/**
 * 把 provider 的 finish_reason 映射为统一 StopReason。
 * 无法识别或异常的取值（content_filter、network_error 及未知方言）一律按
 * error 处理，并携带含原始原因的错误信息。
 *
 * @param reason 原始 finish_reason（null 视为正常结束）
 * @returns 统一停止原因；error 时附 errorMessage
 */
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string): {
	stopReason: StopReason;
	errorMessage?: string;
} {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		// "end" 是部分兼容端点使用的等价取值
		case "end":
			return { stopReason: "stop" };
		case "length":
			return { stopReason: "length" };
		// function_call 是旧版函数调用协议的等价取值
		case "function_call":
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "content_filter":
			return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
		case "network_error":
			return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
		default:
			return {
				stopReason: "error",
				errorMessage: `Provider finish_reason: ${reason}`,
			};
	}
}

/**
 * 按 provider 名与 baseUrl 自动探测兼容性设置。
 * model.compat 未设置时作为基础默认值使用；显式的 model.compat 条目
 * 会覆盖这里的探测结果（见 getCompat）。
 *
 * @param model 目标模型
 * @returns 探测出的全量默认兼容配置
 */
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	// ========== 各 provider 的识别信号（provider 名或 baseUrl 特征） ==========
	// 智谱 Z.ai / BigModel
	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	// Together（两个域名并存）
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	// Moonshot（Kimi，国内外双端点）
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	// OpenRouter 聚合网关
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	// Cloudflare Workers AI 与 AI Gateway
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	// NVIDIA NIM
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	// 蚂蚁 Ling
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	// DeepSeek
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	// 「非标」端点集合：对按 OpenAI 最新规范实现的字段（store、developer 角色等）
	// 宽容度差，容易直接拒绝请求；用于收紧相关默认开关
	const isNonStandard =
		isNvidia ||
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	// 这些端点仍要求老式 max_tokens，而非新命名 max_completion_tokens
	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	// OpenRouter 上 anthropic/ 或 openai/ 前缀的模型可透传 developer 角色
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	// OpenRouter 转发 Anthropic 模型时支持 Anthropic 风格 cache_control
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : undefined;

	// ========== 汇总输出：逐开关给出默认值（再由 getCompat 用 model.compat 覆盖） ==========
	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		// usage：默认都支持在流式响应中返回
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		// 输出上限字段按端点选择
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		// DeepSeek：开启推理时要求 assistant 消息带空的 reasoning_content
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		// thinkingFormat 优先级：deepseek > zai > together > ant-ling > openrouter > 默认 openai
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsThinkingTokenBudget: false,
		thinkingTokenBudgetField: undefined,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsOpenAIGrammarTools: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: false,
		deferredToolsMode: undefined,
		// 会话亲和头格式：OpenRouter 用自家约定，其余按 OpenAI 系
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		// 长缓存保留（24h / 1h）这批端点不支持
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

/**
 * 取模型的最终兼容配置：先经 detectCompat 自动探测，再逐字段用显式的
 * model.compat 覆盖（?? 合并），保证返回值全字段就绪（Resolved 类型）。
 *
 * @param model 目标模型
 * @returns 已解析的全量兼容配置
 */
function getCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const detected = detectCompat(model);
	if (!model.compat) return detected;

	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		supportsFinishReason: model.compat.supportsFinishReason ?? detected.supportsFinishReason,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult:
			model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages:
			model.compat.requiresReasoningContentOnAssistantMessages ??
			detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		chatTemplateArgs: model.compat.chatTemplateArgs ?? detected.chatTemplateArgs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsThinkingTokenBudget: model.compat.supportsThinkingTokenBudget ?? detected.supportsThinkingTokenBudget,
		thinkingTokenBudgetField: model.compat.thinkingTokenBudgetField ?? detected.thinkingTokenBudgetField,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention,
	};
}
