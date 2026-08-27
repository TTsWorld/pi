/**
 * @file AWS Bedrock Converse 流式实现（Node-only 文件，仅限 Node/Bun 环境）。
 * @description
 * 本文件实现 `bedrock-converse-stream` 协议：把统一的 Context（消息、系统提示词、
 * 工具定义、thinking 配置）转换为 AWS Bedrock 的 ConverseStream 请求，装配区域
 * 与凭据（SigV4 环境变量凭据 / profile / Bearer Token / 代理），再把 Bedrock 的
 * 事件流（messageStart / contentBlock* / messageStop / metadata）解析为 SDK 标准
 * 事件流，并基于 metadata.usage 计算计费成本。
 *
 * 本文件依赖 @aws-sdk/client-bedrock-runtime，只能运行在 Node/Bun 下；它通过
 * bedrock-converse-stream.lazy.ts 中 bundler-opaque 的动态 import（变量形式的
 * specifier）做隔离，避免 AWS SDK 被打进浏览器 bundle。
 *
 * 错误格式化（formatBedrockError）的输出会被 overflow.ts 与重试逻辑等下游按
 * 字符串模式匹配，因此错误前缀格式必须保持稳定。
 */
import type { Agent as HttpsAgent } from "node:https";
import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	BedrockRuntimeServiceException,
	StopReason as BedrockStopReason,
	type Tool as BedrockTool,
	CachePointType,
	CacheTTL,
	type ContentBlock,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	ConversationRole,
	ConverseStreamCommand,
	type ConverseStreamMetadataEvent,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	type ToolResultContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { BuildMiddleware, DeserializeMiddleware, DocumentType, HttpResponse, MetadataBearer } from "@smithy/types";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Model,
	ProviderEnv,
	ProviderResponse,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ThinkingLevel,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * Claude thinking 内容在响应中的展示方式。
 * - "summarized"：thinking 块携带摘要化的思考文本。
 * - "omitted"：思考内容被擦除（redacted），但签名仍随消息往返以保持多轮
 *   连续性，可降低首文本 token 的延迟。
 */
export type BedrockThinkingDisplay = "summarized" | "omitted";

/**
 * bedrock-converse-stream 协议的流式选项（在通用 StreamOptions 之上扩展
 * Bedrock 专属配置）。
 */
export interface BedrockOptions extends StreamOptions {
	/** 目标 AWS 区域（如 us-east-1）；不设置时按 ARN/端点/环境变量依次回退。 */
	region?: string;
	/** AWS 共享凭据文件中的 profile 名，优先级高于环境变量里的静态密钥。 */
	profile?: string;
	/** 工具选择策略："auto" 模型自决 / "any" 必须调用工具 / "none" 禁用工具 / 指定具体工具。 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* 思考（reasoning）等级，支持的模型见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html */
	reasoning?: ThinkingLevel;
	/* 按思考等级自定义的 token 预算，会覆盖默认预算。 */
	thinkingBudgets?: ThinkingBudgets;
	/* 交错思考（interleaved thinking）仅 Claude 4.x 模型支持，见 https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * 控制 Claude 的 thinking 内容在响应中的返回方式。
	 * - "summarized"：thinking 块携带摘要化的思考文本（本实现的默认值）。
	 * - "omitted"：思考内容被擦除（redacted），但签名仍随消息往返以保持
	 *   多轮连续性，可降低首文本 token 的延迟。
	 *
	 * 注意：Anthropic API 对 Claude Opus 4.8 与 Mythos Preview 的默认值是
	 * "omitted"；这里默认 "summarized" 以保持与旧 Claude 4 模型行为一致。
	 * 仅对 Bedrock 上的 Claude 模型生效。
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
	/** 附加到推理请求上的键值对，用于成本分摊标签。
	 * 键：最长 64 字符，不允许 `aws:` 前缀。值：最长 256 字符。最多 50 对。
	 * 标签会出现在 AWS Cost Explorer 的分摊成本数据中。
	 * @see https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html */
	requestMetadata?: Record<string, string>;
	/** Bedrock API Key 鉴权用的 Bearer token。
	 * 设置后绕过 SigV4 签名，改为发送 Authorization: Bearer <token>。
	 * 要求 token 对应身份具有 `bedrock:CallWithBearerToken` IAM 权限。
	 * 可通过 AWS_BEARER_TOKEN_BEDROCK 环境变量设置，或直接传入。
	 * @see https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html */
	bearerToken?: string;
}

/**
 * 流式装配过程中的内容块（text / thinking / toolCall），在标准类型之上附加
 * 仅流式期间使用的临时字段；这些字段最终由 finalizeStreamingBlock 清理，
 * 不应进入持久化的消息。
 */
type Block = (TextContent | ThinkingContent | ToolCall) & {
	/** Bedrock 事件流中的 contentBlockIndex，用于把后续 delta 归位到对应块。 */
	index?: number;
	/** 工具入参的流式 JSON 片段缓冲，块结束时解析为 arguments。 */
	partialJson?: string;
	/** 加密 reasoning 增量的暂存缓冲，最终编码后并入 `thinkingSignature`。 */
	redactedChunks?: Uint8Array[];
};

/** Bedrock 拒绝空文本消息/空内容数组，用该占位符填充空白内容。 */
const EMPTY_TEXT_PLACEHOLDER = "<empty>";

/** 与 Anthropic API 路径用于 redacted thinking 的占位符保持一致。 */
const REDACTED_THINKING_PLACEHOLDER = "[Reasoning redacted]";

/**
 * bedrock-converse-stream 协议的流式入口（导出给 lazy 包装层使用）。
 *
 * 整体流程：装配客户端配置（区域、凭据、代理、Bearer token）→ 组装
 * ConverseStream 命令（消息/系统提示词/工具/thinking 字段转换）→ 发送请求 →
 * 逐事件解析 Bedrock 事件流并转发为标准事件 → 正常结束或出错时统一收尾。
 *
 * @param model 模型定义（id、baseUrl、compat 能力标记等）
 * @param context 统一对话上下文（消息、系统提示词、工具列表）
 * @param options Bedrock 专属及通用流式选项
 * @returns 标准的 AssistantMessageEventStream（start/delta/end/done/error 事件）
 */
export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// ========== 输出骨架：预构造 partial AssistantMessage ==========
		// 后续所有流事件都在这个对象上就地累加；usage 先置零，metadata 事件到达时再回填并计费
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
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

		const blocks = output.content as Block[];

		// ========== 客户端配置：profile / 区域 / 端点 ==========
		// 通过 pi 鉴权流显式配置的 profile（`profile` 选项，或存储凭据 env 上的
		// scoped `AWS_PROFILE`）必须优先于环境里的 AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY。
		// SDK 默认凭据链本来就会让已配置的 profile 优先于 env 密钥，但前提是
		// 客户端 config 上没有显式设置 `credentials`。见 #6957。
		const optionsProfile = options.profile || options.env?.AWS_PROFILE;
		const config: BedrockRuntimeClientConfig = {
			profile: optionsProfile || getProviderEnvValue("AWS_PROFILE", options.env),
		};
		const configuredRegion = getConfiguredBedrockRegion(options);
		const hasAmbientConfiguredProfile = Boolean(getProviderEnvValue("AWS_PROFILE"));
		const endpointRegion = getStandardBedrockEndpointRegion(model.baseUrl);
		const useExplicitEndpoint = shouldUseExplicitBedrockEndpoint(
			model.baseUrl,
			configuredRegion,
			hasAmbientConfiguredProfile,
		);

		// 仅在没有配置区域、也没有环境级 AWS_PROFILE 时，才显式钉住标准 AWS Bedrock
		// runtime 端点。这样既保留了 #3402 引入的自定义端点（VPC/代理），又避免内置
		// 目录默认值（如 us-east-1）反过来覆盖 AWS_REGION/AWS_PROFILE。
		if (useExplicitEndpoint) {
			config.endpoint = model.baseUrl;
		}

		// ========== 鉴权：Bearer token 与免鉴权代理 ==========
		// 解析 Bedrock API Key 鉴权用的 Bearer token；AWS_BEDROCK_SKIP_AUTH=1
		// 表示走无需鉴权的代理，跳过 token。
		const skipAuth = getProviderEnvValue("AWS_BEDROCK_SKIP_AUTH", options.env) === "1";
		const bearerToken =
			options.bearerToken ||
			options.apiKey ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", options.env) ||
			undefined;
		const useBearerToken = bearerToken !== undefined && !skipAuth;

		// 仅限 Node.js/Bun 环境（浏览器没有配置文件解析能力）
		if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
			// ========== 区域解析：优先级 ARN 内嵌 > 显式选项 > 环境变量 > SDK 默认链 ==========
			// 当模型 ID 是 inference profile ARN 时，直接从 ARN 中提取区域，
			// 避免与其他服务共用的 AWS_REGION 产生冲突。
			const arnRegionMatch = model.id.match(/^arn:aws(?:-[a-z0-9-]+)?:bedrock:([a-z0-9-]+):/);
			if (arnRegionMatch) {
				config.region = arnRegionMatch[1];
			} else if (configuredRegion) {
				config.region = configuredRegion;
			} else if (endpointRegion && useExplicitEndpoint) {
				config.region = endpointRegion;
			} else if (!hasAmbientConfiguredProfile) {
				config.region = "us-east-1";
			}

			// 支持无需鉴权的代理：填入假凭据以通过 SigV4 签名流程
			if (skipAuth) {
				config.credentials = {
					accessKeyId: "dummy-access-key",
					secretAccessKey: "dummy-secret-key",
				};
			}

			// 显式读取环境变量静态凭据；仅在未配置 profile 时才注入 client config，
			// 以免覆盖 SDK 默认凭据链中 profile 的优先级（对应上面 #6957 的说明）
			const credentials = getConfiguredBedrockCredentials(options.env);
			if (!skipAuth && credentials && !optionsProfile) {
				config.credentials = credentials;
			}

			// ========== 代理与 HTTP 版本 ==========
			const proxyUrl = resolveHttpProxyUrlForTarget(model.baseUrl, options.env);
			if (proxyUrl) {
				// Bedrock runtime 自 v3.798.0 起默认使用 NodeHttp2Handler（基于 `http2`
				// 模块），不支持 http agent；因此改用 NodeHttpHandler 以支持 HTTP(S) 代理 agent。
				config.requestHandler = new NodeHttpHandler({
					httpAgent: new HttpProxyAgent(proxyUrl),
					httpsAgent: new HttpsProxyAgent(proxyUrl) as unknown as HttpsAgent,
				});
			} else if (getProviderEnvValue("AWS_BEDROCK_FORCE_HTTP1", options.env) === "1") {
				// 某些自定义端点要求 HTTP/1.1 而非 HTTP/2
				config.requestHandler = new NodeHttpHandler();
			}
		} else {
			// 非 Node 环境（浏览器）：没有配置文件解析能力，区域回退到 us-east-1
			config.region =
				configuredRegion || (endpointRegion && useExplicitEndpoint ? endpointRegion : undefined) || "us-east-1";
		}

		if (useBearerToken) {
			// Bearer token 鉴权：注入 token 并把鉴权方案限定为 httpBearerAuth，
			// 从而跳过 SigV4 签名
			config.token = { token: bearerToken };
			config.authSchemePreference = ["httpBearerAuth"];
		}

		// 故意放在 try 之外，保证 catch 仍能为"流中途失败"关联请求 ID：
		// 以流事件形式投递的异常本身不携带 HTTP 元数据。
		let responseRequestId: string | undefined;

		try {
			// ========== 组装请求：客户端、中间件、消息与参数转换 ==========
			const supportsStrictMode = model.compat?.supportsStrictMode ?? false;
			const client = new BedrockRuntimeClient(config);
			let observedRawResponse = false;
			if (options.onResponse) {
				addResponseHeadersMiddleware(client, options.onResponse, model, () => {
					observedRawResponse = true;
				});
			}
			const customHeaders = providerHeadersToRecord(options.headers);
			if (customHeaders) {
				addCustomHeadersMiddleware(client, customHeaders);
			}
			const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
			// 未显式指定 maxTokens 时，仅 Claude 模型回退到模型目录里的 maxTokens
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			let commandInput = {
				modelId: model.id,
				messages: convertMessages(context, model, cacheRetention, options.env),
				system: buildSystemPrompt(context.systemPrompt, model, cacheRetention, options.env),
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(context.tools, options.toolChoice, supportsStrictMode),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			// onPayload 钩子允许调用方在发送前审查/改写最终请求体
			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as typeof commandInput;
			}
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });
			responseRequestId = normalizeDiagnosticValue(response.$metadata.requestId);
			// 中间件没有观测到原始响应时（observedRawResponse 仍为 false），
			// 用建模后的 $metadata 补一次 onResponse 回调，保证调用方总能拿到响应头
			if (!observedRawResponse && response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options?.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			// ========== 事件流状态机：把 ConverseStream 事件映射为标准事件 ==========
			// messageStart/contentBlock*/messageStop/metadata 是内容事件；
			// internalServerException 等建模错误则以事件流成员的形式投递，
			// 统一转成异常抛出，交给下方 catch 分支格式化。
			for await (const item of response.stream!) {
				if (item.messageStart) {
					// 流必须以 assistant 角色开始，否则视为协议错误
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					// 终止原因：保留原始值，并映射为统一 StopReason
					output.rawStopReason = item.messageStop.stopReason;
					const { stopReason, errorMessage } = mapStopReason(item.messageStop.stopReason);
					output.stopReason = stopReason;
					if (errorMessage) {
						output.errorMessage = errorMessage;
					}
				} else if (item.metadata) {
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw item.internalServerException;
				} else if (item.modelStreamErrorException) {
					throw item.modelStreamErrorException;
				} else if (item.validationException) {
					throw item.validationException;
				} else if (item.throttlingException) {
					throw item.throttlingException;
				} else if (item.serviceUnavailableException) {
					throw item.serviceUnavailableException;
				}
			}

			// ========== 终态校验与收尾 ==========
			// 流消费完毕后再确认一次请求没有被中途 abort
			if (options.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// 始终没有 messageStop 事件，说明流被异常截断
			if (output.stopReason === "pending") {
				throw new Error("Bedrock stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// 流可能在未对每个块发送 contentBlockStop 的情况下结束，所以这里也要收尾一次
			for (const block of output.content) finalizeStreamingBlock(block as Block);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// 出错路径同样要收尾所有块，避免把流式临时字段泄漏进错误消息
			for (const block of output.content) {
				finalizeStreamingBlock(block as Block);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatBedrockError(error);
			// 主动 abort 不算 provider 错误，不附加结构化诊断
			if (output.stopReason === "error") {
				appendBedrockFailureDiagnostic(output, error, responseRequestId);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Bedrock SDK 异常名 → 人类可读前缀的映射表。
 * agent-session 里的下游重试逻辑会按 `server.?error`、`service.?unavailable`
 * 之类的模式做字符串匹配，因此必须保留这种历史前缀格式，
 * 而不是直接使用 SDK 原始异常名。
 */
const BEDROCK_ERROR_PREFIXES: Record<string, string> = {
	InternalServerException: "Internal server error",
	ModelStreamErrorException: "Model stream error",
	ValidationException: "Validation error",
	ThrottlingException: "Throttling error",
	ServiceUnavailableException: "Service unavailable",
};

/**
 * 部分模型会拒绝账号/profile 配置的 Bedrock 数据保留模式（例如报错
 * "data retention mode 'default' is not available for this model"）。
 * 用这个文档链接指引用户去配置受支持的模式。
 */
const BEDROCK_DATA_RETENTION_DOCS_URL = "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html";

/**
 * 把 Bedrock 错误格式化为带人类可读前缀的字符串。
 * AWS SDK 异常（无论来自 `client.send()` 还是流事件成员）都继承自
 * BedrockRuntimeServiceException。这里把 `.name` 映射为稳定的人类可读前缀，
 * 让下游消费者（重试逻辑、上下文溢出检测）可以通过简单的字符串匹配区分错误类别。
 *
 * @param error 任意捕获到的错误对象
 * @returns 形如 "前缀: 消息" 的格式化错误字符串
 */
function formatBedrockError(error: unknown): string {
	const norm = normalizeProviderError(error);
	// 当 SDK 没有把原始 HTTP body 折进 message 时，直接透出原始 body（带状态码），
	// 否则回退到 message。这正是避免网关 403 被压缩成 `Unknown: UnknownError` 的关键。
	const core =
		!norm.messageCarriesBody && norm.status !== undefined && norm.body !== undefined
			? `${norm.status}: ${norm.body}`
			: norm.message;
	// 消息命中 "data retention mode" 时附加 AWS 文档提示，帮助用户自查配置
	const dataRetentionHint = /data retention mode/i.test(core)
		? ` See ${BEDROCK_DATA_RETENTION_DOCS_URL} for supported data retention modes.`
		: "";
	if (error instanceof BedrockRuntimeServiceException) {
		// SDK 服务异常：查表取前缀，表里没有时退回原始异常名
		const prefix = BEDROCK_ERROR_PREFIXES[error.name] ?? error.name;
		return `${prefix}: ${core}${dataRetentionHint}`;
	}
	// 非 SDK 异常（如网络层错误）只拼核心消息
	return `${core}${dataRetentionHint}`;
}

/** AWS SDK 错误对象上可能存在的 `$metadata` 形状（供防御式读取）。 */
type SdkErrorMetadata = { $metadata?: { httpStatusCode?: unknown; requestId?: unknown } };

/** 超长的头字段值直接丢弃而不是截断：截断后的请求 ID 就不再是有效的请求 ID。 */
const MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS = 200;

/**
 * 规范化诊断字段值（如 requestId / errorCode）。
 * 非字符串、空白、超长值一律返回 undefined。
 *
 * @param value 原始值
 * @returns 可安全写入诊断信息的字符串，不合法时返回 undefined
 */
function normalizeDiagnosticValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_BEDROCK_DIAGNOSTIC_VALUE_CHARS) return undefined;
	return trimmed;
}

/**
 * 从错误对象上提取 Bedrock 错误码。
 * SDK 对服务异常和未建模的流错误都会把建模错误码放在 `error.name` 上，所以
 * 这里不收窄到 `BedrockRuntimeServiceException`。Bedrock 建模错误的名称都以
 * `Exception` 结尾，可与 `TimeoutError` 这类传输层名称区分开。
 *
 * @param error 任意错误对象
 * @returns 规范化后的错误码，取不到时返回 undefined
 */
function extractBedrockErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || !error.name.endsWith("Exception")) return undefined;
	return normalizeDiagnosticValue(error.name);
}

/**
 * 在 `errorMessage` 之外附加结构化诊断信息。`errorMessage` 必须保持字节级不变，
 * 因为 `isRetryableAssistantError` 直接对它做匹配。未知字段一律省略而不是去猜测：
 * 建模的流中途异常可能以裸对象字面量的形式到达，此时只剩 `fallbackRequestId`
 * 可用。只写 `details`，因为抛出的不一定是 `Error` 实例。
 *
 * @param output 失败的 assistant 消息，诊断信息追加到其上
 * @param error 捕获到的错误
 * @param fallbackRequestId 响应阶段记录的请求 ID（错误自身不带元数据时兜底）
 */
function appendBedrockFailureDiagnostic(
	output: AssistantMessage,
	error: unknown,
	fallbackRequestId: string | undefined,
): void {
	const metadata = (error as SdkErrorMetadata)?.$metadata;
	const details: Record<string, unknown> = {};

	// 仅在字段确实存在且类型合法时写入
	if (typeof metadata?.httpStatusCode === "number") details.status = metadata.httpStatusCode;

	const errorCode = extractBedrockErrorCode(error);
	if (errorCode !== undefined) details.errorCode = errorCode;

	// 错误自带的元数据里没有 requestId 时，用发送阶段记录的兜底值
	const requestId = normalizeDiagnosticValue(metadata?.requestId) ?? fallbackRequestId;
	if (requestId !== undefined) details.requestId = requestId;

	// 一个字段都没有时不产生空的诊断条目
	if (Object.keys(details).length === 0) return;

	appendAssistantMessageDiagnostic(output, { type: "bedrock_response_failure", timestamp: Date.now(), details });
}

/**
 * 绝不允许被调用方自定义头覆盖的请求头键集合。
 * `host` 与 `x-amz-*` 参与 SigV4 规范化请求；`authorization` 由 SigV4 签名或
 * Bearer token 路径（config.token + authSchemePreference）独占。
 * 比较时不区分大小写（调用方的键会先转小写再查表）。
 */
const RESERVED_HEADER_EXACT = new Set(["authorization", "host"]);

/**
 * 判断请求头是否属于 SigV4 / 鉴权保留头，不可被调用方覆盖。
 *
 * @param key 请求头键名
 * @returns 是保留头返回 true
 */
function isReservedHeader(key: string): boolean {
	const lower = key.toLowerCase();
	return lower.startsWith("x-amz-") || RESERVED_HEADER_EXACT.has(lower);
}

/**
 * 通过 Smithy `build` 步骤中间件，把调用方自定义头附加到即将发出的 Bedrock 请求上。
 * `build` 步骤在请求序列化之后、SigV4 签名之前运行，因此注入的头会被算进签名。
 * SigV4 / 鉴权保留头（`x-amz-*`、`authorization`、`host`）会被静默跳过；
 * 其余调用方头会覆盖请求上已有的同名头。
 *
 * @param client Bedrock 客户端，中间件挂到其 middlewareStack 上
 * @param headers 调用方自定义的请求头键值对
 */
function addCustomHeadersMiddleware(client: BedrockRuntimeClient, headers: Record<string, string>): void {
	const middleware: BuildMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const request = args.request;
		if (request && typeof request === "object" && "headers" in request) {
			const requestHeaders = (request as { headers: Record<string, string> }).headers;
			for (const [key, value] of Object.entries(headers)) {
				if (!isReservedHeader(key)) {
					requestHeaders[key] = value;
				}
			}
		}
		return next(args);
	};
	client.middlewareStack.add(middleware, { step: "build", name: "pi-ai-custom-headers", priority: "low" });
}

/** 类型守卫：判断对象是否是 Smithy 的原始 HTTP 响应（含 statusCode 与 headers）。 */
function isSmithyHttpResponse(response: unknown): response is HttpResponse {
	if (!response || typeof response !== "object") return false;
	const candidate = response as Partial<HttpResponse>;
	return typeof candidate.statusCode === "number" && !!candidate.headers && typeof candidate.headers === "object";
}

/**
 * 把 Smithy 原始 HTTP 响应转换为统一的 ProviderResponse。
 *
 * @param response 中间件产物里的原始响应对象
 * @returns 转换结果；形状不符时返回 undefined
 */
function toProviderResponse(response: unknown): ProviderResponse | undefined {
	if (!isSmithyHttpResponse(response)) return undefined;
	return { status: response.statusCode, headers: { ...response.headers } };
}

/**
 * 在 deserialize 步骤截获原始 Smithy HTTP 响应并回调 onResponse。
 * Bedrock 建模后的 `$metadata` 只保留了部分 HTTP 元数据（例如 requestId），
 * 自定义网关的头在调用方看到 `onResponse` 之前就会丢失；而 deserialize 步骤
 * 恰好处于 SDK 收到响应之后、事件流被消费之前。
 *
 * @param client Bedrock 客户端
 * @param onResponse 调用方的响应回调
 * @param model 当前模型
 * @param onObserved 成功观测到原始响应后的通知（用于避免 onResponse 被重复触发）
 */
function addResponseHeadersMiddleware(
	client: BedrockRuntimeClient,
	onResponse: NonNullable<BedrockOptions["onResponse"]>,
	model: Model<"bedrock-converse-stream">,
	onObserved: () => void,
): void {
	const middleware: DeserializeMiddleware<object, MetadataBearer> = (next) => async (args) => {
		const result = await next(args);
		const providerResponse = toProviderResponse(result.response);
		if (providerResponse) {
			onObserved();
			await onResponse(providerResponse, model);
		}
		return result;
	};
	client.middlewareStack.add(middleware, { step: "deserialize", name: "pi-ai-response-headers" });
}

/**
 * bedrock-converse-stream 协议的简化流式入口。
 * 在通用 SimpleStreamOptions 之上补齐 Bedrock 需要的基础选项；处理 reasoning 时
 * 按模型能力分三条路径：未开启 reasoning 直接透传、支持 adaptive thinking 的新
 * Claude 直接透传等级、旧 Claude 需要手动预留 thinking 预算并调整 maxTokens。
 *
 * @param model 模型定义
 * @param context 统一对话上下文
 * @param options 简化流式选项（含 reasoning 等级与自定义预算）
 * @returns 标准的 AssistantMessageEventStream
 */
export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies BedrockOptions;
	// 未开启 reasoning：直接透传基础选项
	if (!options?.reasoning) {
		return stream(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		// 支持 adaptive thinking 的新 Claude：预算由服务端自适应，直接透传等级与预算
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return stream(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// Undefined 表示调用方没有要求输出上限，交给辅助函数用模型上限。
		// 这里不要强转成 0，否则 thinking 预算会变成整个 maxTokens 的值。
		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		// 夹紧到上下文窗口后，再保证 thinking 预算至少给正文留出 1024 token
		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

		return stream(model, context, {
			...base,
			maxTokens,
			reasoning: options.reasoning,
			thinkingBudgets: {
				...(options.thinkingBudgets || {}),
				[clampReasoning(options.reasoning)!]: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
			},
		} satisfies BedrockOptions);
	}

	// 非 Claude 模型：不做预算调整，直接透传
	return stream(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};

/**
 * 处理 contentBlockStart 事件：创建新的流式块。
 * Bedrock 只对 toolUse 块发送 start 事件（text / thinking 块没有对应 start，
 * 需要在 delta 到达时按需懒创建）。
 *
 * @param event Bedrock contentBlockStart 事件
 * @param blocks 流式块缓冲
 * @param output 累加中的 assistant 消息
 * @param stream 标准事件流，用于转发 toolcall_start
 */
function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

/**
 * 处理 contentBlockDelta 事件：按 delta 类型（text / toolUse / reasoningContent）
 * 把增量累加到对应块并转发标准事件。text 与 thinking 块在此按需懒创建。
 *
 * @param event Bedrock contentBlockDelta 事件
 * @param blocks 流式块缓冲（按 index 定位目标块）
 * @param output 累加中的 assistant 消息
 * @param stream 标准事件流，用于转发各类 delta 事件
 */
function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// 还没有对应文本块就先创建：Bedrock 不会为 text 块发送 contentBlockStart
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJson(block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			// `thinkingSignature` 只承载 Anthropic 签名或 opaque redacted 负载二者之一，
			// 绝不混存：混在一起会破坏先到达的那份。
			if (delta.reasoningContent.signature && !thinkingBlock.redacted) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
			if (delta.reasoningContent.redactedContent?.length) {
				// Bedrock 上非 Anthropic 模型（如 OpenAI GPT-5.6）的加密 reasoning。
				// 负载本身不可解读，因此原样存进 `thinkingSignature`（与 Anthropic 路径
				// 存 redacted thinking 的方式一致），下一轮直接回放。
				if (!thinkingBlock.redacted) {
					thinkingBlock.redacted = true;
					thinkingBlock.thinkingSignature = "";
					thinkingBlock.thinking += REDACTED_THINKING_PLACEHOLDER;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: REDACTED_THINKING_PLACEHOLDER,
						partial: output,
					});
				}
				thinkingBlock.redactedChunks ??= [];
				thinkingBlock.redactedChunks.push(delta.reasoningContent.redactedContent);
			}
		}
	}
}

/**
 * 把暂存的加密 reasoning 编码进 `thinkingSignature` 并删除暂存缓冲。
 * 该缓冲绝不能进入持久化消息：`Uint8Array` 序列化成按下标为键的对象后，
 * 体积约是 base64 负载的十倍。
 *
 * @param block 待收尾的 thinking 块
 */
function flushRedactedContent(block: Block): void {
	if (block.type !== "thinking" || !block.redactedChunks) return;
	block.thinkingSignature = bytesToBase64(block.redactedChunks);
	delete block.redactedChunks;
}

/**
 * 清除块上所有流式临时字段。除了 `contentBlockStop` 之外，done/error 等
 * 终态路径也会调用它，因为流可能在未逐块 stop 的情况下结束。
 *
 * @param block 待清理的流式块
 */
function finalizeStreamingBlock(block: Block): void {
	delete block.index;
	// partialJson 只是流式期间的暂存缓冲，绝不持久化
	delete block.partialJson;
	flushRedactedContent(block);
}

/**
 * 处理 metadata 事件：回填 token 用量并按模型价格计算成本。
 * metadata 出现在流的最末尾，是计费数据的唯一来源。
 *
 * @param event Bedrock metadata 事件（含 usage 等统计）
 * @param model 模型定义（用于计价）
 * @param output 累加中的 assistant 消息，usage 写入其中
 */
function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		// 回填各维度 token 用量；totalTokens 缺失时以输入+输出之和兜底
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

/**
 * 处理 contentBlockStop 事件：按块类型收尾并转发对应的 *_end 标准事件。
 *
 * @param event Bedrock contentBlockStop 事件
 * @param blocks 流式块缓冲
 * @param output 累加中的 assistant 消息
 * @param stream 标准事件流
 */
function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	// index 只用于流期间定位，块结束时立即移除
	delete (block as Block).index;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			// 先把暂存的加密 reasoning 编码进签名，再结束块
			flushRedactedContent(block);
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			// 用完整 JSON 缓冲做最终解析，并就地剥离暂存缓冲，
			// 保证重放时只携带解析好的 arguments
			block.arguments = parseStreamingJson(block.partialJson);
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * 生成用于模型能力匹配的候选字符串列表。
 * 同时使用模型 ID 与模型名做匹配，以兼容 ARN 中不含模型名的
 * application inference profile。每个候选值会派生"转小写原样"和
 * "空白与分隔符统一归一为连字符"两个变体。
 *
 * @param modelId 模型 ID（可能是 ARN）
 * @param modelName 可选的模型名（models.json / registerProvider 中由用户控制）
 * @returns 归一化后的候选匹配串数组
 */
function getModelMatchCandidates(modelId: string, modelName?: string): string[] {
	const values = modelName ? [modelId, modelName] : [modelId];
	return values.flatMap((value) => {
		const lower = value.toLowerCase();
		return [lower, lower.replace(/[\s_.:]+/g, "-")];
	});
}

/**
 * 判断模型是否支持 adaptive thinking（Opus 4.6+、Sonnet 4.6 及更新版本）。
 * 同时检查模型 ID 和模型名，以兼容 ARN 中不含模型名的 application inference profile。
 *
 * @param modelId 模型 ID
 * @param modelName 可选的模型名
 * @returns 支持 adaptive thinking 返回 true
 */
function supportsAdaptiveThinking(modelId: string, modelName?: string): boolean {
	const candidates = getModelMatchCandidates(modelId, modelName);
	return candidates.some(
		(s) =>
			s.includes("opus-4-6") ||
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-4-6") ||
			s.includes("sonnet-5") ||
			s.includes("fable-5"),
	);
}

/**
 * 判断模型是否原生支持 "xhigh" effort 档位（较新的 Opus / Sonnet / Fable 系列）。
 *
 * @param model 模型定义
 * @returns 原生支持 xhigh 返回 true
 */
function supportsNativeXhighEffort(model: Model<"bedrock-converse-stream">): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);
	return candidates.some(
		(s) =>
			s.includes("opus-4-7") ||
			s.includes("opus-4-8") ||
			s.includes("opus-5") ||
			s.includes("sonnet-5") ||
			s.includes("fable-5"),
	);
}

/**
 * 把统一的思考等级映射为 Bedrock output_config.effort 档位。
 * 优先级：原生 xhigh 能力 > 模型 thinkingLevelMap 显式映射 > 固定兜底映射。
 *
 * @param model 模型定义（提供 thinkingLevelMap 与能力判断）
 * @param level 统一的思考等级（minimal/low/medium/high/xhigh/max）
 * @returns Bedrock effort 档位（low/medium/high/xhigh/max）
 */
function mapThinkingLevelToEffort(
	model: Model<"bedrock-converse-stream">,
	level: SimpleStreamOptions["reasoning"],
): "low" | "medium" | "high" | "xhigh" | "max" {
	// 原生支持 xhigh 的模型才能透传 xhigh，否则会被折算到固定映射
	if (level === "xhigh" && supportsNativeXhighEffort(model)) return "xhigh";

	// 模型目录里的显式映射优先于兜底逻辑
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as "low" | "medium" | "high" | "xhigh" | "max";

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

/**
 * 解析提示词缓存的保留时长偏好。
 * 默认 "short"；为向后兼容支持 PI_CACHE_RETENTION=long。
 *
 * @param cacheRetention 显式传入的偏好
 * @param env 提供方环境变量
 * @returns 解析后的 CacheRetention
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
 * 判断是否是 Bedrock 上的 Anthropic Claude 模型。
 * 同时检查模型 ID 和模型名，以兼容 ARN 中不含模型名的 application inference profile。
 *
 * @param model 模型定义
 * @returns 是 Claude 模型返回 true
 */
function isAnthropicClaudeModel(model: Model<"bedrock-converse-stream">): boolean {
	const id = model.id.toLowerCase();
	const name = model.name?.toLowerCase() ?? "";
	return (
		id.includes("anthropic.claude") ||
		id.includes("anthropic/claude") ||
		name.includes("anthropic.claude") ||
		name.includes("anthropic/claude") ||
		name.includes("claude")
	);
}

/**
 * 判断模型是否支持提示词缓存（cache point）。
 * 支持的模型：Claude 3.5 Haiku、Claude 3.7 Sonnet、Claude 4.x、Claude 5 系列。
 *
 * 对基础模型和系统定义的 inference profile，模型 ID / ARN 中就含有模型名，
 * 可以在本地直接判断。
 *
 * 对 application inference profile（ARN 中不含模型名），额外检查 model.name
 * （该字段由用户通过 models.json 或 registerProvider 控制）。
 * 最后的手段是设置 AWS_BEDROCK_FORCE_CACHE=1 强制启用 cache point。
 * Amazon Nova 模型自带自动缓存，不需要显式 cache point。
 *
 * @param model 模型定义
 * @param env 提供方环境变量
 * @returns 支持提示词缓存返回 true
 */
function supportsPromptCaching(model: Model<"bedrock-converse-stream">, env?: ProviderEnv): boolean {
	const candidates = getModelMatchCandidates(model.id, model.name);

	const hasClaudeRef = candidates.some((s) => s.includes("claude"));
	if (!hasClaudeRef) {
		// ARN 中不含模型名的 application inference profile：
		// 允许用户通过环境变量强制启用 cache point
		if (getProviderEnvValue("AWS_BEDROCK_FORCE_CACHE", env) === "1") return true;
		return false;
	}
	// Claude 5 系列（fable-5、opus-5、sonnet-5）
	if (candidates.some((s) => s.includes("fable-5") || s.includes("opus-5") || s.includes("sonnet-5"))) return true;
	// Claude 4.x 系列（opus-4、sonnet-4、haiku-4）
	if (candidates.some((s) => s.includes("-4-"))) return true;
	// Claude 3.7 Sonnet
	if (candidates.some((s) => s.includes("claude-3-7-sonnet"))) return true;
	// Claude 3.5 Haiku
	if (candidates.some((s) => s.includes("claude-3-5-haiku"))) return true;
	return false;
}

/**
 * 判断模型是否支持 reasoningContent 中的 thinking 签名字段。
 * 只有 Anthropic Claude 模型支持 signature 字段。
 * 其他模型（OpenAI、Qwen、Minimax、Moonshot 等）会拒绝并报错：
 * "This model doesn't support the reasoningContent.reasoningText.signature field"
 *
 * 同时检查模型 ID 和模型名，以兼容 application inference profile。
 *
 * @param model 模型定义
 * @returns 支持 thinking 签名返回 true
 */
function supportsThinkingSignature(model: Model<"bedrock-converse-stream">): boolean {
	return isAnthropicClaudeModel(model);
}

/**
 * 构建系统提示词块：清洗代理字符（surrogate）后包装为 SystemContentBlock，
 * 支持缓存的 Claude 模型再追加一个 cachePoint 块（long 保留期附带 1 小时 TTL）。
 *
 * @param systemPrompt 系统提示词文本
 * @param model 模型定义
 * @param cacheRetention 缓存保留偏好
 * @param env 提供方环境变量
 * @returns 系统内容块数组；无系统提示词时返回 undefined
 */
function buildSystemPrompt(
	systemPrompt: string | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const blocks: SystemContentBlock[] = [{ text: sanitizeSurrogates(systemPrompt) }];

	// 启用缓存且模型支持时，为系统提示词追加 cache point
	if (cacheRetention !== "none" && supportsPromptCaching(model, env)) {
		blocks.push({
			cachePoint: { type: CachePointType.DEFAULT, ...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}) },
		});
	}

	return blocks;
}

/**
 * 规范化工具调用 ID：把 [a-zA-Z0-9_-] 之外的字符替换为下划线并截断到 64 字符，
 * 保证 ID 能安全通过 Bedrock 的校验并在后续轮次重放。
 *
 * @param id 原始工具调用 ID
 * @returns 规范化后的 ID
 */
function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

/**
 * 创建非空文本块：清洗代理字符（surrogate）后，内容全为空白则返回 undefined。
 *
 * @param text 原始文本
 * @returns 有效文本块；空文本返回 undefined
 */
function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

/**
 * 创建必须有内容的文本块：空文本时用占位符兜底（Bedrock 拒绝空文本消息）。
 *
 * @param text 原始文本
 * @returns 文本块（内容绝不为空）
 */
function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

/**
 * 递归清洗 Bedrock DocumentValue：过滤掉空字符串键（Bedrock 的文档校验会拒绝），
 * 数组与嵌套对象递归处理，标高原样返回。
 *
 * @param value 任意文档值
 * @returns 清洗后的文档值
 */
function sanitizeBedrockDocument(value: DocumentType): DocumentType {
	if (Array.isArray(value)) {
		return value.map(sanitizeBedrockDocument);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	return value;
}

/**
 * 把工具结果内容转换为 Bedrock ToolResultContentBlock 数组。
 * 图片转 image 块，文本清洗后非空才保留；全部为空时用占位符兜底。
 *
 * @param content 工具结果内容（文本或图片）
 * @returns Bedrock 工具结果内容块数组（至少含一个块）
 */
function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType, c.data) });
		} else {
			// 空白文本块直接丢弃
			const textBlock = createNonBlankTextBlock(c.text);
			if (textBlock) result.push(textBlock);
		}
	}
	// Bedrock 不接受空 content 数组，空时用占位符
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

/**
 * 把统一 Context 的消息列表转换为 Bedrock Converse 的 Message 数组。
 * 处理：文本清洗与空块过滤、thinking 块回放（含 redacted 负载回放与
 * 签名缺失时降级为纯文本）、toolCall/toolResult 转换、连续 toolResult
 * 合并为单条 user 消息，以及为最后一条 user 消息追加 cachePoint。
 *
 * @param context 统一对话上下文
 * @param model 模型定义
 * @param cacheRetention 缓存保留偏好
 * @param env 提供方环境变量
 * @returns Bedrock Converse 消息数组
 */
function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user": {
				const content: ContentBlock[] = [];
				if (typeof m.content === "string") {
					content.push(createRequiredTextBlock(m.content));
				} else {
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const textBlock = createNonBlankTextBlock(c.text);
								if (textBlock) content.push(textBlock);
								break;
							}
							case "image":
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								continue;
						}
					}
					// 用户消息内容为空时用占位符兜底（Bedrock 拒绝空 content）
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				result.push({
					role: ConversationRole.USER,
					content,
				});
				break;
			}
			case "assistant": {
				// 跳过内容为空的 assistant 消息（如被中断的请求产生的）；
				// Bedrock 拒绝空 content 数组的消息
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text": {
							// 跳过空文本块
							const textBlock = createNonBlankTextBlock(c.text);
							if (!textBlock) continue;
							contentBlocks.push(textBlock);
							break;
						}
						case "toolCall":
							contentBlocks.push({
								toolUse: { toolUseId: c.id, name: c.name, input: sanitizeBedrockDocument(c.arguments) },
							});
							break;
						case "thinking": {
							// 加密 reasoning 不可解读：把存储的负载原样作为
							// `redactedContent` 成员回放，而不是降级成 reasoning 文本
							if (c.redacted) {
								const redactedContent = decodeRedactedContent(c.thinkingSignature);
								if (redactedContent?.length) {
									contentBlocks.push({ reasoningContent: { redactedContent } });
								}
								continue;
							}
							// 跳过空 thinking 块
							const thinking = sanitizeSurrogates(c.thinking);
							if (thinking.trim().length === 0) continue;
							// 只有 Anthropic 模型支持 reasoningText 中的 signature 字段。
							// 其他模型若带签名会报错：
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								// 签名在 thinking 增量之后到达。若部分消息或外部持久化的
								// 消息缺签名，Bedrock 会拒绝回放的 reasoning 块；此时降级为
								// 纯文本块，与 Anthropic 路径的做法一致。
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									contentBlocks.push({ text: thinking });
								} else {
									contentBlocks.push({
										reasoningContent: {
											reasoningText: {
												text: thinking,
												signature: c.thinkingSignature,
											},
										},
									});
								}
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: thinking },
									},
								});
							}
							break;
						}
						default:
							continue;
					}
				}
				// 所有内容块都被过滤掉时整条跳过
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// 把连续的 toolResult 消息合并进同一条 user 消息：
				// Bedrock 要求一轮的所有工具结果必须在同一条消息里
				const toolResults: ContentBlock.ToolResultMember[] = [];

				// 先加入当前工具结果（所有内容块合并）
				toolResults.push({
					toolResult: {
						toolUseId: m.toolCallId,
						content: convertToolResultContent(m.content),
						status: m.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
					},
				});

				// 向后查看连续的 toolResult 消息，逐个并入
				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: nextMsg.toolCallId,
							content: convertToolResultContent(nextMsg.content),
							status: nextMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					j++;
				}

				// 外层 for 的游标直接跳过已并入的消息
				i = j - 1;

				result.push({
					role: ConversationRole.USER,
					content: toolResults,
				});
				break;
			}
			default:
				continue;
		}
	}

	// 启用缓存且模型支持时，为最后一条 user 消息追加 cache point，
	// 使整个对话前缀（系统提示词 + 历史消息）都能命中缓存
	if (cacheRetention !== "none" && supportsPromptCaching(model, env) && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			(lastMessage.content as ContentBlock[]).push({
				cachePoint: {
					type: CachePointType.DEFAULT,
					...(cacheRetention === "long" ? { ttl: CacheTTL.ONE_HOUR } : {}),
				},
			});
		}
	}

	return result;
}

/**
 * 把统一工具列表转换为 Bedrock ToolConfiguration。
 * 没有工具、或 toolChoice 为 "none" 时不发送 toolConfig；strict 模式由
 * 模型能力与工具 schema 共同决定，启用时会在 toolSpec 上打 strict 标记。
 *
 * @param tools 统一工具列表
 * @param toolChoice 工具选择策略
 * @param supportsStrictMode 模型是否支持 strict 结构化输出
 * @returns Bedrock 工具配置；无需工具时返回 undefined
 */
function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	supportsStrictMode: boolean,
): ToolConfiguration | undefined {
	if (!tools?.length) return undefined;
	if (toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		return {
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: getJsonSchemaToolParameters(tool, strict) as unknown as DocumentType },
				...(strict === true ? { strict: true } : {}),
			},
		};
	});

	// 映射工具选择策略到 Bedrock ToolChoice
	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

/**
 * 把 Bedrock 停止原因映射为统一的 StopReason。
 * 未知原因归为 error 并携带原始描述，便于上层诊断。
 *
 * @param reason Bedrock 原始停止原因
 * @returns 统一 StopReason 与可选的错误说明
 */
function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		// 正常结束：自然收尾或命中停止序列
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return { stopReason: "stop" };
		// 长度用尽：maxTokens 截断或上下文窗口超限
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return { stopReason: "length" };
		// 模型请求调用工具
		case BedrockStopReason.TOOL_USE:
			return { stopReason: "toolUse" };
		default:
			// 未知原因：按错误处理并保留原始字符串
			return reason
				? { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
				: { stopReason: "error" };
	}
}

/**
 * 读取显式配置的 Bedrock 区域：选项 region > AWS_REGION > AWS_DEFAULT_REGION。
 *
 * @param options Bedrock 选项（含 env）
 * @returns 配置的区域；未配置返回 undefined
 */
function getConfiguredBedrockRegion(options: BedrockOptions): string | undefined {
	return (
		options.region ||
		getProviderEnvValue("AWS_REGION", options.env) ||
		getProviderEnvValue("AWS_DEFAULT_REGION", options.env) ||
		undefined
	);
}

/**
 * 从环境变量读取静态 SigV4 凭据（access key + secret key，可选 session token）。
 * 两个密钥字段都存在才返回；否则交回 SDK 默认凭据链解析。
 *
 * @param env 提供方环境变量
 * @returns 静态凭据；信息不全返回 undefined
 */
function getConfiguredBedrockCredentials(env?: ProviderEnv): BedrockRuntimeClientConfig["credentials"] | undefined {
	const accessKeyId = getProviderEnvValue("AWS_ACCESS_KEY_ID", env);
	const secretAccessKey = getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env);
	if (!accessKeyId || !secretAccessKey) {
		return undefined;
	}
	const sessionToken = getProviderEnvValue("AWS_SESSION_TOKEN", env);
	return {
		accessKeyId,
		secretAccessKey,
		...(sessionToken ? { sessionToken } : {}),
	};
}

/**
 * 从 baseUrl 中提取标准 Bedrock runtime 端点（含 FIPS 与中国区变体）的区域名。
 * 非标准端点（自定义网关 / VPC 端点）返回 undefined。
 *
 * @param baseUrl 模型配置的 baseUrl
 * @returns 标准端点中的区域名；无法识别返回 undefined
 */
function getStandardBedrockEndpointRegion(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) {
		return undefined;
	}

	try {
		const { hostname } = new URL(baseUrl);
		const match = hostname.toLowerCase().match(/^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * 判断是否应把 baseUrl 显式钉为客户端端点。
 * 非标准 Bedrock 端点（自定义网关）始终钉住；标准 AWS 端点只有在
 * 没有显式区域、也没有环境级 AWS_PROFILE 时才钉，避免内置目录默认值
 * 覆盖用户自己的区域 / profile 配置。
 *
 * @param baseUrl 模型配置的 baseUrl
 * @param configuredRegion 显式配置的区域
 * @param hasAmbientConfiguredProfile 环境中是否存在 AWS_PROFILE
 * @returns 应显式指定端点返回 true
 */
function shouldUseExplicitBedrockEndpoint(
	baseUrl: string,
	configuredRegion: string | undefined,
	hasAmbientConfiguredProfile: boolean,
): boolean {
	const endpointRegion = getStandardBedrockEndpointRegion(baseUrl);
	if (!endpointRegion) {
		return true;
	}

	return !configuredRegion && !hasAmbientConfiguredProfile;
}

/**
 * 判断目标是否为 GovCloud Bedrock：显式区域以 us-gov- 开头，
 * 或模型 ID 带有 GovCloud 前缀 / ARN 命名空间。
 *
 * @param model 模型定义
 * @param options Bedrock 选项
 * @returns 目标在 GovCloud 返回 true
 */
function isGovCloudBedrockTarget(model: Model<"bedrock-converse-stream">, options: BedrockOptions): boolean {
	const region = getConfiguredBedrockRegion(options);
	if (region?.toLowerCase().startsWith("us-gov-")) {
		return true;
	}

	const modelId = model.id.toLowerCase();
	return modelId.startsWith("us-gov.") || modelId.startsWith("arn:aws-us-gov:");
}

/**
 * 构建 additionalModelRequestFields（Bedrock 透传给模型本身的额外字段）。
 * 目前只处理 Claude 的 thinking 配置：
 * - 支持 adaptive thinking 的新模型：thinking.type=adaptive + output_config.effort；
 * - 旧 Claude：thinking.type=enabled + budget_tokens（按等级取自定义或默认预算）；
 * - 非自适应模型默认追加 interleaved-thinking beta 标记。
 * 非 Claude 模型或未开启 reasoning 时返回 undefined。
 *
 * @param model 模型定义
 * @param options Bedrock 选项（reasoning / thinkingBudgets / thinkingDisplay / interleavedThinking）
 * @returns 透传字段对象；无需配置时返回 undefined
 */
function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, any> | undefined {
	if (!options.reasoning || !model.reasoning) {
		return undefined;
	}

	if (isAnthropicClaudeModel(model)) {
		// ========== Claude 的 thinking 配置 ==========
		// GovCloud Bedrock 目前会拒绝 Claude 的 thinking.display 字段，
		// 在其 Converse schema 跟进之前先省略
		const display = isGovCloudBedrockTarget(model, options) ? undefined : (options.thinkingDisplay ?? "summarized");
		const result: Record<string, any> = supportsAdaptiveThinking(model.id, model.name)
			? {
					thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) },
					output_config: { effort: mapThinkingLevelToEffort(model, options.reasoning) },
				}
			: (() => {
					const defaultBudgets: Record<ThinkingLevel, number> = {
						minimal: 1024,
						low: 2048,
						medium: 8192,
						high: 16384,
						xhigh: 16384, // 预算模式的 Claude 会把更高等级钳制到 high
						max: 16384,
					};

					// 自定义预算只覆盖到 high 为止的基于 token 的等级
					const level = options.reasoning === "xhigh" || options.reasoning === "max" ? "high" : options.reasoning;
					const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[options.reasoning];

					return {
						thinking: {
							type: "enabled",
							budget_tokens: budget,
							...(display !== undefined ? { display } : {}),
						},
					};
				})();

		// 非自适应模型默认开启交错思考 beta（可通过 interleavedThinking: false 关闭）
		if (!supportsAdaptiveThinking(model.id, model.name) && (options.interleavedThinking ?? true)) {
			result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
		}

		return result;
	}

	return undefined;
}

/**
 * 构建图片内容块：按 MIME 类型映射 Bedrock ImageFormat 并解码 base64 数据。
 * 不支持的类型直接抛错。
 *
 * @param mimeType 图片 MIME 类型
 * @param data base64 编码的图片数据
 * @returns Bedrock 图片块（source.bytes + format）
 */
function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	return { source: { bytes: base64ToBytes(data) }, format };
}

/**
 * base64 字符串解码为 Uint8Array（逐字节填充，兼容无 Buffer 的环境）。
 *
 * @param data base64 字符串
 * @returns 解码后的字节数组
 */
function base64ToBytes(data: string): Uint8Array {
	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/**
 * 解码存储的 redacted 负载。AWS SDK 以字节形式交付该二进制块，但持久化的
 * 会话里保存的是 base64。手工编辑或外部生成的会话可能携带非 base64 的签名，
 * 此时丢弃该块而不是让整个请求失败。
 *
 * @param signature 存储的 base64 负载
 * @returns 解码后的字节；解码失败返回 undefined
 */
function decodeRedactedContent(signature: string | undefined): Uint8Array | undefined {
	if (!signature) return undefined;
	try {
		return base64ToBytes(signature);
	} catch {
		return undefined;
	}
}

/**
 * 把多个字节块编码为 base64 字符串。
 *
 * @param chunks 字节块数组
 * @returns 拼接编码后的 base64 字符串
 */
function bytesToBase64(chunks: Uint8Array[]): string {
	// 加密 reasoning 可达数十 KB，因此按窗口分片构造二进制字符串，
	// 而不是每字节一次拼接；窗口大小控制在引擎对 spread 调用的
	// 参数数量限制之下。
	const WINDOW = 0x8000;
	let binary = "";
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i += WINDOW) {
			binary += String.fromCharCode(...chunk.subarray(i, i + WINDOW));
		}
	}
	return btoa(binary);
}
