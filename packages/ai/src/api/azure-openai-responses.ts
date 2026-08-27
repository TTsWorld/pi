/**
 * @file Azure OpenAI Responses API 协议实现
 * @description 用 openai SDK 的 AzureOpenAI 客户端访问 Azure 托管的 Responses API。
 *              与官方 openai-responses.ts 的关键差异：
 *              1. provider 不配置 baseUrl——请求端点在运行时按「资源名 + /openai/v1」
 *                 拼装或经多级回退链解析（见 resolveAzureConfig）；
 *              2. 请求体 model 字段填 Azure deployment 名而非 model.id
 *                 （经 AZURE_OPENAI_DEPLOYMENT_NAME_MAP 映射，见 resolveDeploymentName）；
 *              3. 认证走 Azure 专属的 api-key 请求头（而非 Bearer），并附带
 *                 api-version 查询参数（默认 "v1"）。
 *              消息转换与流式事件解析没有 Azure 特化，直接复用 openai-responses-shared.ts。
 *
 * 依赖关系：
 * - openai SDK 的 AzureOpenAI 客户端：负责 api-key 头注入、api-version 查询参数与端点拼装
 * - openai-responses-shared.ts：convertResponsesMessages / convertResponsesTools
 *   （消息与工具转换）、processResponsesStream（SSE 流解析）
 * - providers/azure-openai-responses.ts：provider 侧不设 baseUrl，API key 取自
 *   AZURE_OPENAI_API_KEY 环境变量
 */
import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

/** Azure v1 API 面的默认 api-version 值（与 /openai/v1 路径形态配套） */
const DEFAULT_AZURE_API_VERSION = "v1";

/** 消息回放时采用 OpenAI Responses 风格工具调用记录的 provider 集合；本实现自身也在其中 */
const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure-openai-responses"]);
// OpenAI Responses 会拒绝低于 16 的 max_output_tokens：https://github.com/earendil-works/pi/issues/6265
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * 解析 deployment 映射字符串为 Map。
 *
 * 输入形如 "modelId=deploymentName,modelId2=deploymentName2"（逗号分隔、等号成对）；
 * 空段、缺 modelId 或缺 deploymentName 的条目直接跳过，键值两侧空白会被 trim。
 *
 * @param value 环境变量 AZURE_OPENAI_DEPLOYMENT_NAME_MAP 的原始值
 * @returns model.id → Azure deployment 名 的映射；输入为空时返回空 Map
 */
function parseDeploymentNameMap(value: string | undefined): Map<string, string> {
	const map = new Map<string, string>();
	if (!value) return map;
	for (const entry of value.split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		// split 限长 2：值里多余的 "=" 会被整体截断丢弃，只取前两段
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

/**
 * 解析本次请求应使用的 Azure deployment 名（优先级从高到低）：
 * 1. options.azureDeploymentName（调用方显式指定）；
 * 2. 环境变量 AZURE_OPENAI_DEPLOYMENT_NAME_MAP 中 model.id 对应的映射值；
 * 3. 兜底直接用 model.id（适用于 deployment 名与模型 id 同名的场景）。
 */
function resolveDeploymentName(model: Model<"azure-openai-responses">, options?: AzureOpenAIResponsesOptions): string {
	if (options?.azureDeploymentName) {
		return options.azureDeploymentName;
	}
	const mappedDeployment = parseDeploymentNameMap(
		getProviderEnvValue("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", options?.env),
	).get(model.id);
	return mappedDeployment || model.id;
}

/** 统一错误格式化：规范化 provider 错误后加上 "Azure OpenAI API error" 前缀文案 */
function formatAzureOpenAIError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

// Azure OpenAI Responses 专属的流式选项
export interface AzureOpenAIResponsesOptions extends StreamOptions {
	/** 推理力度档位；下发前会先经 model.thinkingLevelMap 映射为协议档位 */
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** 强制指定 tool_choice（结构同 OpenAI Responses 的 tool_choice） */
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	/** 推理摘要粒度；未传或传 null 时回落为 "auto" */
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	/** 覆盖 api-version 查询参数（默认走环境变量或 "v1"） */
	azureApiVersion?: string;
	/** Azure 资源名，用于拼装默认端点 https://<资源名>.openai.azure.com/openai/v1 */
	azureResourceName?: string;
	/** 完整 base URL；优先级高于资源名拼装与环境变量 */
	azureBaseUrl?: string;
	/** 显式指定本次请求使用的 deployment 名（优先级最高） */
	azureDeploymentName?: string;
}

/**
 * Azure OpenAI Responses API 的流式生成函数：
 * 解析 deployment 名 → 建 AzureOpenAI 客户端 → 组装请求参数（可被 onPayload 改写）
 * → 带可中断重试地发起流式请求 → 复用共享解析器把 SSE 事件写入事件流。
 */
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// 异步执行主体：先返回事件流，网络请求与流解析在后台推进
	(async () => {
		const deploymentName = resolveDeploymentName(model, options);

		// ========== 输出骨架：预置零值 usage/cost 的 AssistantMessage，流式过程中逐步回填 ==========
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			// 协议 id 直接写死为本实现（官方 openai-responses 实现取 model.api）
			api: "azure-openai-responses" as Api,
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
			// 创建 Azure OpenAI 客户端；缺 API key 直接失败
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options);
			// 受约束采样：模型支持 grammar 工具时，收集各工具入参的受限属性映射
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			let params = buildParams(model, context, options, deploymentName, grammarToolInputProperties);
			// onPayload 钩子：允许调用方在发送前查看/改写最终请求体
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			// 关闭 SDK 内建重试（maxRetries: 0），统一交给下面的 retryProviderRequest
			// 接管——其退避等待可被 AbortSignal 中断，并遵循服务端要求的重试延迟上限
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			// ========== 发起请求：withResponse 额外拿到 HTTP status 与响应头 ==========
			const { data: openaiStream, response } = await retryProviderRequest(
				() => client.responses.create(params, requestOptions).withResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			// onResponse 钩子：把原始 status/headers 交给调用方（如限流与配额信息）
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			// ========== 流式解析：复用共享解析器，把 SSE 事件写入 output 与 stream ==========
			await processResponsesStream(openaiStream, output, stream, model, { grammarToolInputProperties });

			// 外部中止：即便解析正常完成也按失败处理
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// 终止校验：流结束仍无 stop reason 视为协议异常
			if (output.stopReason === "pending") {
				throw new Error("Azure OpenAI Responses stream ended without a stop reason");
			}
			// 解析中途已标记 aborted/error：补抛错误统一走 catch 分支
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// ========== 错误兜底：清掉流式解析的临时字段后再广播 ==========
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// 流式临时缓冲只在解析期间使用，绝不随消息持久化
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			// 以 signal 是否中止区分 aborted 与 error
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatAzureOpenAIError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 简化入口：把 SimpleStreamOptions 适配为 AzureOpenAIResponsesOptions 后复用 stream。
 * 缺 API key 时同步抛错（快速失败）；统一 reasoning 档位先钳制到模型支持范围，
 * "off" 转为 undefined（不传档位），由 buildParams 按模型的 off 映射显式关闭推理。
 */
export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AzureOpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

/**
 * 规范化 Azure base URL：去首尾空白与尾部斜杠、校验 URL 合法性；
 * 对 Azure 官方域名（三种已知形态）把「裸路径、/openai、/openai/v1/responses」
 * 统一改写为 /openai/v1，并清掉自带的查询串。
 *
 * @param baseUrl 待规范化的 URL 字符串
 * @returns 以 /openai/v1 结尾（无尾斜杠）的 base URL
 */
function normalizeAzureBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Azure OpenAI base URL: ${baseUrl}`);
	}

	// Azure 官方域名的三种已知形态
	const isAzureHost =
		url.hostname.endsWith(".openai.azure.com") ||
		url.hostname.endsWith(".cognitiveservices.azure.com") ||
		url.hostname.endsWith(".ai.azure.com");
	const normalizedPath = url.pathname.replace(/\/+$/, "");

	// 确保 Azure 域名的 base path 统一为 /openai/v1，AzureOpenAI SDK 才能在此基础上
	// 正确追加 /deployments/<model>/... 等接口路径与 ?api-version=v1 查询参数
	// （用户可能把完整端点 /openai/v1/responses 整段当 baseUrl 传入，这里退回 base 形态）
	if (
		isAzureHost &&
		(normalizedPath === "" ||
			normalizedPath === "/" ||
			normalizedPath === "/openai" ||
			normalizedPath === "/openai/v1/responses")
	) {
		url.pathname = "/openai/v1";
		url.search = "";
	}

	return url.toString().replace(/\/+$/, "");
}

/** 按资源名拼装默认端点：v1 API 面固定为 https://<资源名>.openai.azure.com/openai/v1 */
function buildDefaultBaseUrl(resourceName: string): string {
	return `https://${resourceName}.openai.azure.com/openai/v1`;
}

/**
 * 解析 Azure 连接配置（baseUrl 与 api-version），逐级回退：
 * - apiVersion：options.azureApiVersion → 环境变量 AZURE_OPENAI_API_VERSION → 默认 "v1"
 * - baseUrl：options.azureBaseUrl → 环境变量 AZURE_OPENAI_BASE_URL → 按资源名拼装
 *   （options.azureResourceName / AZURE_OPENAI_RESOURCE_NAME）→ model.baseUrl → 报错
 *
 * @returns 规范化后的 baseUrl 与 apiVersion
 */
function resolveAzureConfig(
	model: Model<"azure-openai-responses">,
	options?: AzureOpenAIResponsesOptions,
): { baseUrl: string; apiVersion: string } {
	const apiVersion =
		options?.azureApiVersion ||
		getProviderEnvValue("AZURE_OPENAI_API_VERSION", options?.env) ||
		DEFAULT_AZURE_API_VERSION;

	const baseUrl =
		options?.azureBaseUrl?.trim() || getProviderEnvValue("AZURE_OPENAI_BASE_URL", options?.env)?.trim() || undefined;
	const resourceName = options?.azureResourceName || getProviderEnvValue("AZURE_OPENAI_RESOURCE_NAME", options?.env);

	let resolvedBaseUrl = baseUrl;

	if (!resolvedBaseUrl && resourceName) {
		resolvedBaseUrl = buildDefaultBaseUrl(resourceName);
	}

	if (!resolvedBaseUrl && model.baseUrl) {
		resolvedBaseUrl = model.baseUrl;
	}

	// 三级回退全部落空：给出可操作的报错提示
	if (!resolvedBaseUrl) {
		throw new Error(
			"Azure OpenAI base URL is required. Set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME, or pass azureBaseUrl, azureResourceName, or model.baseUrl.",
		);
	}

	return {
		baseUrl: normalizeAzureBaseUrl(resolvedBaseUrl),
		apiVersion,
	};
}

/**
 * 创建 AzureOpenAI 客户端。
 *
 * 要点：
 * - 头合并顺序：pi 的 User-Agent → model.headers → options.headers（后者可覆盖默认）；
 * - 以字符串 apiKey 实例化时，SDK 用 Azure 专属的 api-key 请求头认证（而非 Bearer），
 *   并把 apiVersion 追加为每个请求的 api-version 查询参数；
 * - dangerouslyAllowBrowser：放开 SDK 默认的浏览器端使用限制。
 */
function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	const headers = { "User-Agent": getPiUserAgent(), ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		fetch: options?.fetch,
		defaultHeaders: headers,
		baseURL: baseUrl,
	});
}

/**
 * 组装 Responses 流式请求参数。
 *
 * @param deploymentName 写入请求体 model 字段的 Azure deployment 名（关键差异：
 *        官方 openai-responses 实现此处填 model.id）
 * @param grammarToolInputProperties 受约束采样的属性映射；缺省时按模型 compat 现算
 */
function buildParams(
	model: Model<"azure-openai-responses">,
	context: Context,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
) {
	// 消息（含历史工具调用记录）按 OpenAI Responses 风格转换，复用共享实现
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
	});

	const params: ResponseCreateParamsStreaming = {
		// Azure 差异：model 字段填 deployment 名，服务端按 deployment 路由到具体模型
		model: deploymentName,
		input: messages,
		stream: true,
		// 用会话 id 做 prompt 缓存路由提示（截断到 OpenAI 要求的 64 字符上限）
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		// 无状态请求：不落服务端存储，多轮上下文由调用方回传
		store: false,
	};

	// ========== 输出上限与采样温度 ==========
	if (options?.maxTokens) {
		// 下限钳制：低于 16 会被 Responses API 直接拒绝
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	// ========== 工具定义与强制选择 ==========
	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools, {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		});
	}
	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	// ========== 推理参数：模型声明支持推理时才下发 ==========
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			// 显式要求推理：effort 先经 thinkingLevelMap 映射为协议档位，
			// 只给 summary 时 effort 默认 medium
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			// store: false 下多轮工具调用要续传思维链，必须请求加密推理内容带回
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			// 未显式要求推理：只要模型存在可映射的 off 档，就显式下发关闭指令，
			// 避免服务端默认开启推理白白消耗输出 token
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	// 最后合并，让自定义键覆盖上面的具名字段
	if (options?.samplingParams) {
		Object.assign(params, options.samplingParams);
	}

	return params;
}
