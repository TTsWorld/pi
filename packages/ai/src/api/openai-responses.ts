/**
 * @file OpenAI Responses API 流式实现
 * @description 官方 openai provider 的主通道（openai-responses 协议）：组装 Responses 请求
 *              （消息/工具转换复用 openai-responses-shared.ts、prompt cache、reasoning 档位、
 *              deferred 工具拆分），经可中断重试发出，把 SSE 流解析为标准事件。
 *              被 openai（及部分兼容网关）provider 使用。
 *
 * 依赖关系：
 * - openai SDK（client.responses 通道）
 * - ./openai-responses-shared.ts（消息/工具转换与流解析）
 * - ../utils/*（重试、错误归一化、事件流等）
 */

import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// 工具调用走「函数名直传」语义的 provider（其余 provider 的工具名会被规范化处理）
const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
// OpenAI Responses 拒绝低于 16 的 max_output_tokens：https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/** 大小写不敏感地检查 headers 里是否存在非空指定头 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

/**
 * 解析客户端 apiKey：显式 key 优先；若 headers 已带 authorization /
 * cf-aig-authorization（网关预认证场景），SDK 仍需要非空 key，用占位值 "unused" 充数。
 */
function getClientApiKey(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): string {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}

/** 会话亲和头格式探测：openrouter 用 x-session-id，其余按 openai 官方格式 */
function detectSessionAffinityFormat(model: Pick<Model<"openai-responses">, "provider" | "baseUrl">) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}

/**
 * 解析缓存保留偏好。默认 "short"，并保留 PI_CACHE_RETENTION 环境变量的向后兼容。
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

/** 组装 compat 开关：未声明的字段按默认值补齐（defaults 见各字段） */
function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsAdditionalTools: model.compat?.supportsAdditionalTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false,
	};
}

/** 长保留（24h）缓存只在模型声明支持时才请求 */
function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

/** 错误统一格式化：SDK 字段探测 + "OpenAI API error" 前缀 */
function formatOpenAIResponsesError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}

// OpenAI Responses 专属选项（在通用 StreamOptions 之上）
export interface OpenAIResponsesOptions extends StreamOptions {
	/** 推理努力档位（off/minimal/low/medium/high/xhigh/max） */
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** 推理摘要粒度 */
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** 服务层级（flex/priority 等，影响计费倍率） */
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	/** 工具选择强制（如强制调用某工具） */
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
}

/**
 * OpenAI Responses API 的流式生成入口。
 * 同步返回事件流；异步 setup 与流解析在幕后执行，任何失败以 error 事件收尾而非抛出。
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// 异步处理立即启动（不 await）：保持 stream() 同步返回的契约
	(async () => {
		// 预建终态消息骨架；流解析过程中逐步填充 content 与 usage
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
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
			// ===== 准备阶段：key、缓存、compat、客户端与请求参数 =====
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				compat.supportsOpenAIGrammarTools,
			);
			const client = createClient(model, context, apiKey, options?.headers, options?.fetch, cacheSessionId);
			let params = buildParams(model, context, options, compat, grammarToolInputProperties);
			// onPayload 钩子：发出前查看/改写请求载荷
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// SDK 内建重试关闭：退避统一交给 retryProviderRequest（可被 abort 中断）
				maxRetries: 0,
			};
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			// ===== 流解析：SSE 事件 → 标准事件（shared 实现负责细节） =====
			await processResponsesStream(openaiStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// ===== 终态校验：pending 不是合法终态；错误/中止转异常路径统一格式化 =====
			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// 清理流式过程中的临时字段：index/partialJson/customInput 只在解析期使用，绝不持久化
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOpenAIResponsesError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/** 简化入口：统一 reasoning 档位换算为 Responses 的 reasoningEffort 后转调 stream */
export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	// 提前校验 key 可用性：把「缺 key」错误尽早暴露给调用方
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	// 模型不支持某档位时钳制到其 thinkingLevelMap 允许的档；off 表示不开启推理
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

/**
 * 创建 OpenAI SDK 客户端：组装默认头（User-Agent、模型 headers、Copilot 动态头、
 * 会话亲和头），调用方 headers 最后合并以允许覆盖默认值。
 */
function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	sessionId?: string,
) {
	const compat = getCompat(model);
	const headers: ProviderHeaders = { "User-Agent": getPiUserAgent(), ...model.headers };
	// Copilot：按输入内容生成动态头（视觉标记、发起方标识等）
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	// 会话亲和：让同一会话的请求落到同一缓存分片
	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") {
			headers["x-session-id"] = sessionId;
		} else {
			if (compat.sessionAffinityFormat === "openai") {
				headers.session_id = sessionId;
			}
			headers["x-client-request-id"] = sessionId;
		}
	}

	// optionsHeaders 最后合并，确保能覆盖默认头
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: headers,
	});
}

/**
 * 组装 Responses 请求参数：消息转换（含 deferred 工具拆分与文法工具识别）、
 * prompt cache 设置、maxTokens/温度/服务层级、工具与 reasoning 配置；
 * samplingParams 最后合并以允许自定义键覆盖具名字段。
 */
function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	compat: Required<OpenAIResponsesCompat> = getCompat(model),
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		compat.supportsOpenAIGrammarTools,
	),
) {
	// deferred 工具的承载模式：优先 additional-tools，其次 tool-search，都不支持则不拆分
	const deferredToolsMode = compat.supportsAdditionalTools
		? "additional-tools"
		: compat.supportsToolSearch
			? "tool-search"
			: undefined;
	const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		deferredToolsMode,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		},
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;
	const params: ResponseCreateParamsStreaming & { prompt_cache_options?: { mode: "explicit" } } = {
		model: model.id,
		input: messages,
		stream: true,
		// prompt cache key 取会话 id（截断到上限）；关闭缓存时不发
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		// 显式缓存模式下由 prompt_cache_key 精确控制命中，关闭隐式缓存
		prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,
		store: false,
	};

	// 下限 16：OpenAI Responses 拒绝更小的值
	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	// 只传「立即执行」的工具；deferred 的由消息层的占位声明承载
	if (toolPlacement.immediate.length > 0) {
		params.tools = convertResponsesTools(toolPlacement.immediate, {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools,
		});
	}

	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	// ===== reasoning 配置 =====
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			// 显式档位：经 thinkingLevelMap 映射为 provider 档位；请求加密 reasoning 以便回放
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			// 未显式请求推理：按模型 off 档位显式关闭（Copilot 不支持该字段）
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
		// xai 的加密 reasoning 无需显式 include 条件也请求回来
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}

	// 最后合并 samplingParams，让自定义键能覆盖具名请求字段
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}

	return params;
}

/** 服务层级的计费倍率：flex 半价、priority 加价（gpt-5.5 为 2.5 倍、其余 2 倍） */
function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

/** 按服务层级倍率调整 usage 成本（原地修改）；标准层级（倍率 1）不动 */
function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
