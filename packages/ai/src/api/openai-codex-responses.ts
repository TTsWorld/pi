/**
 * @file OpenAI Codex 专用 Responses 协议适配层（openai-codex-responses）。
 * @description
 * 面向 ChatGPT 订阅账号（OAuth 授权，凭据见 auth/oauth/openai-codex.ts）访问
 * chatgpt.com/backend-api 的 Codex 后端，而非标准 OpenAI API。与标准
 * Responses 适配层（openai-responses / openai-responses-azure）的主要差异：
 * - 双传输：默认 "auto"——优先 WebSocket（支持按会话/账号池化复用连接、
 *   以 previous_response_id 做上下文增量续传），失败且尚未开始输出时自动
 *   降级 SSE 并在会话内记住降级态；也可经 transport 选项强制 "sse"。
 *   SSE 请求体支持 zstd 压缩。
 * - 鉴权：chatgpt-account-id 头从 access token（JWT）重新解析（不信凭据里
 *   存的副本）；originator 头声明客户端来源；两者均为 Codex 后端专有要求。
 * - 消息/工具转换与流事件解析复用 openai-responses-shared.ts，本文件只做
 *   Codex 特有部分：事件归一化（response.done → response.completed）、
 *   service_tier 计费倍率、WebSocket 连接池与 SSE 降级、会话资源清理。
 */
import type * as NodeZlib from "node:zlib";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { resolveHttpProxyUrlForTarget } from "../utils/node-http-proxy.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { convertResponsesMessages, convertResponsesTools, processResponsesStream } from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// ============================================================================
// 配置常量
// ============================================================================

/** Codex 后端默认基地址：chatgpt.com 的 backend-api（而非 api.openai.com）。 */
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
/** JWT payload 中 ChatGPT 认证声明的命名空间路径，chatgpt_account_id 挂在该命名空间下。 */
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
/** SSE 路径默认不重试：订阅额度场景盲目重试易加剧限流（OpenAI SDK 默认为 2）。 */
const DEFAULT_MAX_RETRIES = 0;
/** 重试的基础退避时长（毫秒），实际等待按指数退避 BASE_DELAY_MS * 2^attempt 递增。 */
const BASE_DELAY_MS = 1000;
/** 服务器要求的重试等待上限（毫秒）：retry-after 指示超过它则直接失败而非干等。 */
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
/** WebSocket 握手（连接建立）阶段的默认超时（毫秒）。 */
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
// Codex 后端的 SSE responses 端点接受 zstd 压缩的请求体
// （官方 Codex 客户端对同一端点也做压缩），此处对齐其压缩级别。
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
/**
 * 允许「工具名直传」语义的 provider 集合：目标 provider 在集合内时，
 * 工具调用 ID 在消息转换中无需脱敏归一化（详见 openai-responses-shared.ts）。
 */
const CODEX_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);
/** WebSocket 关闭码 1009：消息（帧）超过对端大小限制。 */
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
/** Codex 后端错误码：该账号的 WebSocket 并发连接数已达上限。 */
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
/** Codex 后端错误码：previous_response_id 指向的响应不存在（服务端续传状态已丢失）。 */
const PREVIOUS_RESPONSE_NOT_FOUND_CODE = "previous_response_not_found";

/** Codex 后端回报的响应状态全集（终态与 queued/in_progress 等中间态），用于状态白名单归一化。 */
const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// 类型定义
// ============================================================================

/** Codex 专属流式选项：在通用 StreamOptions 之上追加 Responses/Codex 特有参数。 */
export interface OpenAICodexResponsesOptions extends StreamOptions {
	/** 思考力度档位（经模型 thinkingLevelMap 映射后写入 reasoning.effort）。 */
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/** 思考摘要档位，写入 reasoning.summary。 */
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	/** 服务层级（flex/priority 等），影响路由与计费倍率。 */
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	/** 回答详略程度，写入 text.verbosity。 */
	textVerbosity?: "low" | "medium" | "high";
	/** 工具调用策略：auto 由模型决定 / none 禁用 / required 强制调用。 */
	toolChoice?: "auto" | "none" | "required";
}

/** Codex 后端可能回报的响应状态（含 queued/in_progress 等中间态）。 */
type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

/**
 * Codex Responses 请求体形态：宽松结构（允许任意扩展键，供 onPayload 钩子等
 * 场景透传），仅显式声明本适配层关心的字段。
 */
interface RequestBody {
	/** 模型 id。 */
	model: string;
	/** 服务端状态保留开关：Codex 后端要求必须为 false。 */
	store?: boolean;
	/** 是否流式返回：本适配层恒为 true。 */
	stream?: boolean;
	/** 顶层指令（system prompt）：Codex 不走消息数组内的 system 消息。 */
	instructions?: string;
	/** WebSocket 续传：指向同连接上一轮响应，配合 input 只发增量。 */
	previous_response_id?: string;
	/** 消息/输出条目数组（完整上下文或增量）。 */
	input?: ResponseInput;
	/** 工具定义列表。 */
	tools?: OpenAITool[];
	/** 工具调用策略。 */
	tool_choice?: OpenAICodexResponsesOptions["toolChoice"];
	/** 是否允许并行工具调用。 */
	parallel_tool_calls?: boolean;
	/** 采样温度。 */
	temperature?: number;
	/** 思考配置：力度（effort）与摘要（summary）。 */
	reasoning?: { effort?: string; summary?: string };
	/** 服务层级。 */
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	/** 回答详略配置。 */
	text?: { verbosity?: string };
	/** 附加 include 声明（如加密推理内容）。 */
	include?: string[];
	/** 提示词缓存键（会话 id）。 */
	prompt_cache_key?: string;
	/** 任意扩展键。 */
	[key: string]: unknown;
}

/** 成功收尾的助手消息：停止原因必须是三类「正常完成」之一。 */
type SuccessfulAssistantMessage = AssistantMessage & { stopReason: "stop" | "length" | "toolUse" };

/**
 * 断言流式输出以成功状态收尾：仍为 pending（流异常中断）或 error/aborted 时
 * 抛错，交由外层 catch 统一转成 error 事件。
 *
 * @param output 待校验的助手消息
 */
function assertSuccessfulOutput(output: AssistantMessage): asserts output is SuccessfulAssistantMessage {
	if (output.stopReason === "pending") {
		throw new Error("Codex stream ended without a stop reason");
	}
	if (output.stopReason === "error" || output.stopReason === "aborted") {
		throw new Error(output.errorMessage || "An unknown error occurred");
	}
}

// ============================================================================
// 重试辅助
// ============================================================================

/**
 * 判断 429 是否为「终端」限额错误（订阅用量/计费余额耗尽）：这类错误重试也无
 * 意义，直接失败并让上层给用户明确提示。
 *
 * @param errorText 响应错误文本
 */
function isTerminalRateLimitError(errorText: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i.test(
		errorText,
	);
}

/**
 * 判断错误是否值得重试：429（非终端限额）与常见 5xx 直接可重试；
 * 其余按错误文本是否命中限流/过载/上游连接失败等模式兜底判断。
 *
 * @param status HTTP 状态码
 * @param errorText 响应错误文本
 * @returns 可重试返回 true
 */
function isRetryableError(status: number, errorText: string): boolean {
	// 终端限额类的 429：重试只会继续撞墙，不重试
	if (status === 429 && isTerminalRateLimitError(errorText)) {
		return false;
	}
	// 常见瞬时错误状态码
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

/**
 * 解析服务器的重试等待指示，按优先级支持三种格式：
 * retry-after-ms（毫秒）→ retry-after（秒数）→ retry-after（HTTP 日期）。
 *
 * @param headers 响应头
 * @returns 应等待的毫秒数；服务器未指示时返回 undefined
 */
function getRetryAfterDelayMs(headers: Headers): number | undefined {
	// 优先：OpenAI 风格的 retry-after-ms 头（毫秒）
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}

	// 其次：标准 retry-after 头
	const retryAfter = headers.get("retry-after");
	if (!retryAfter) {
		return undefined;
	}

	// 秒数形式
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}

	// HTTP 日期形式：换算为距今的毫秒差
	const date = Date.parse(retryAfter);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}

	return undefined;
}

/** 服务器要求的重试等待超过 maxRetryDelayMs 上限时抛出，用于阻止无意义的长等待。 */
class RetryDelayExceededError extends Error {}

/**
 * 校验服务器指示的重试等待是否超过上限：超过则抛 RetryDelayExceededError
 * 立即失败（错误信息含两端时长，便于上层以用户可见的方式处理）。
 *
 * @param delayMs 服务器指示的等待毫秒数
 * @param options 流式选项（读取 maxRetryDelayMs，0 表示不设上限）
 * @returns 原样返回通过校验的等待毫秒数
 */
function validateRetryDelayMs(delayMs: number, options?: StreamOptions): number {
	const maxRetryDelayMs = options?.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxRetryDelayMs > 0 && delayMs > maxRetryDelayMs) {
		throw new RetryDelayExceededError(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxRetryDelayMs / 1000)}s)`,
		);
	}
	return delayMs;
}

/**
 * 可中止的 sleep：等待期间收到中止信号立即拒绝，不会傻等满时长。
 *
 * @param ms 等待毫秒数
 * @param signal 用户中止信号
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		});
	});
}

/**
 * 规整超时毫秒数：校验必须为有限非负数，并向下取整。
 *
 * @param value 原始超时值
 * @returns 规整后的整数毫秒；入参 undefined 时原样返回
 */
function normalizeTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`Invalid timeoutMs: ${String(value)}`);
	}
	return Math.floor(value);
}

// ============================================================================
// 请求体压缩
// ============================================================================

/** process 上 getBuiltinModule 的最小类型声明（Node 22+ 提供，旧类型定义未收录）。 */
type ProcessWithBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:zlib") => typeof NodeZlib;
};

/**
 * 惰性加载 node:zlib：仅 Node/Bun 运行时可用；浏览器/Vite 构建中返回 null
 * （通过 getBuiltinModule 而非静态 import，避免把 Node 模块打进浏览器包）。
 *
 * @returns node:zlib 模块；不可用时为 null
 */
function loadNodeZlib(): typeof NodeZlib | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithBuiltinModule).getBuiltinModule?.("node:zlib") ?? null;
}

/**
 * 用 zstd 压缩请求体；运行时不可用（浏览器/Vite 构建、zstd 函数缺失或压缩失败）
 * 时返回 null，调用方回退为发送未压缩 JSON。
 *
 * @param bodyJson 请求体 JSON 字符串
 * @returns 压缩后的字节；不可压缩时为 null
 */
function compressRequestBodyZstd(bodyJson: string): Uint8Array | null {
	const zlib = loadNodeZlib();
	if (!zlib || typeof zlib.zstdCompressSync !== "function") {
		return null;
	}
	try {
		const compressed = zlib.zstdCompressSync(bodyJson, {
			params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL },
		});
		return new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);
	} catch {
		return null;
	}
}

// ============================================================================
// 主流式入口
// ============================================================================

/**
 * Codex 流式请求主入口（StreamFunction 实现）。
 *
 * 执行流程：
 * 1. 鉴权准备：从 apiKey（OAuth access token）解析 accountId，分别构建
 *    SSE 与 WebSocket 两套请求头；
 * 2. 组装请求体（system prompt 走 instructions、store=false、加密推理回传等
 *    Codex 特有设定），并给调用方 onPayload 钩子一次改写机会；
 * 3. 按 transport 选择传输：非 "sse" 且本会话未处于 SSE 降级态时先走
 *    WebSocket（内部对连接数上限、续传失效两类错误各静默重试一次），
 *    失败且尚未对外发出 start 事件时降级 SSE；
 * 4. SSE 路径带指数退避重试（429/5xx/网络错误），请求体可选 zstd 压缩；
 * 5. 事件流经 mapCodexEvents 归一化后交给共享的 processResponsesStream 解析，
 *    填充 output 并推送 start/delta/done 标准事件。
 *
 * @param model 目标模型
 * @param context 统一请求上下文（systemPrompt + 消息历史 + 工具）
 * @param options Codex 专属与通用流式选项（transport、超时、重试、鉴权等）
 * @returns 标准事件流（内部异步执行，立即返回）
 */
export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// 初始助手消息骨架：usage 先全部置零、由流事件回填——保证即使中途出错，
		// catch 分支也能基于同一形态输出 error 事件。
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-codex-responses" as Api,
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
			// apiKey 即 OAuth access token（由 auth/oauth/openai-codex.ts 的 toAuth 映射而来）
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			// chatgpt-account-id 头所需的账号 id：以从 token 现解析的口径为准
			const accountId = extractAccountId(apiKey);
			// 文法（grammar）工具属性映射：模型支持原生文法工具时，
			// 命中的工具调用走 custom_tool_call 流式通道（见 constrained-sampling.ts）
			const grammarToolInputProperties = createGrammarToolInputProperties(
				context.tools,
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			// 会话 id 三重身份：提示词缓存键、WebSocket 连接池键、请求路由亲和标识；
			// cacheRetention 为 "none" 时不参与缓存，并截断到 OpenAI 缓存键长度上限
			const cacheSessionId = options?.cacheRetention === "none" ? undefined : options?.sessionId;
			const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
			let body = buildRequestBody(model, context, options, codexSessionId, grammarToolInputProperties);
			// onPayload 钩子：请求体发出前给调用方一次改写机会
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as RequestBody;
			}
			// WebSocket 请求标识：优先复用会话 id（同会话路由亲和），无会话时生成 uuidv7
			const websocketRequestId = codexSessionId || uuidv7();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, codexSessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			// timeoutMs 在两条传输上语义不同：SSE 约束「响应头到达」，
			// WebSocket 则作为流的空闲超时（见 parseWebSocket）
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			// 传输选择：默认 "auto"（WebSocket 优先、失败降级 SSE）
			const transport = options?.transport || "auto";
			// start 事件只允许发一次：WebSocket 内部重试与降级 SSE 共用该标记
			let startEmitted = false;
			// 本会话此前 WebSocket 失败过 → 记住降级态：非强制 SSE 时直接跳过
			// WebSocket，避免每次请求都先经历一次注定失败的握手（见 recordWebSocketFailure）
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(cacheSessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				// WebSocket 尝试循环：最多对两类可恢复错误各内部重试一次
				//（连接数达上限、previous_response_id 续传失效），其余错误按下述分支处理
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							resolveCodexWebSocketUrl(model.baseUrl),
							body,
							websocketHeaders,
							output,
							stream,
							model,
							// 首个流事件到达时才认为 WebSocket「真正开始输出」：
							// 标记 websocketStarted（此后失败不再降级 SSE）并补发 start 事件
							() => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							httpTimeoutMs,
							websocketConnectTimeoutMs,
							cacheSessionId,
							accountId,
							grammarToolInputProperties,
							options,
						);

						// WebSocket 成功走完：校验中止与停止原因后推送 done 并结束整个流
						if (options?.signal?.aborted) {
							throw new Error("Request was aborted");
						}
						assertSuccessfulOutput(output);
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						// 失败分支——按错误性质决定：内部重试 / 直接抛出 / 降级 SSE
						const aborted = options?.signal?.aborted;
						// 「连接数上限」仅在尚未开始输出时才算可重试（开始输出后无法安全重来）
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						// 续传状态在服务端丢失：清掉本地续传状态整轮重发，只重试一次
						if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
							retriedMissingWebSocketContinuation = true;
							continue;
						}
						// 并发连接瞬时达上限：静默重试一次（下次 acquire 可能复用或新建连接）
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						// 用户中止，或错误是 Codex 业务/协议错误（非传输层问题）：
						// 换 SSE 也会复现，不降级、直接抛出
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						// 传输层失败：先记录诊断信息（含配置的传输、失败阶段、请求字节数）便于排查
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								fallbackTransport: websocketStarted ? undefined : "sse",
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						recordWebSocketFailure(cacheSessionId, error);
						// 已对外发出过 start（流已开始）：无法无缝降级，只能抛错终止
						if (websocketStarted) {
							throw error;
						}
						// 尚未开始输出：登记会话级 SSE 降级态并跳出循环，改走 SSE
						recordWebSocketSseFallback(cacheSessionId);
						break;
					}
				}
			}

			// SSE 路径一次性压缩请求体：Codex 后端能解 Content-Encoding: zstd；
			// 上面的 WebSocket 传输则发送未压缩 JSON 帧，与官方 Codex 客户端行为一致
			const compressedBody = compressRequestBodyZstd(bodyJson);
			if (compressedBody) {
				sseHeaders.set("content-encoding", "zstd");
			}
			const sseBody: Uint8Array | string = compressedBody ?? bodyJson;

			// 带重试的 SSE 请求：针对限流与瞬时错误做指数退避
			let response: Response | undefined;
			let lastError: Error | undefined;
			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				try {
					// timeoutMs 只约束「响应头到达」阶段：超时信号与用户中止信号合并后传入 fetch
					const headerTimeoutSignal =
						httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					try {
						response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
							method: "POST",
							headers: sseHeaders,
							body: sseBody,
							signal: combinedSignal.signal,
						});
					} catch (error) {
						// fetch 抛错时区分来源：仅头部超时触发则改报更明确的中止错误，其余原样抛出
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`);
						}
						throw error;
					} finally {
						combinedSignal.cleanup();
					}
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					// 还可重试且错误可重试：按 retry-after 指示或指数退避等待后重试
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						const retryAfterDelayMs = getRetryAfterDelayMs(response.headers);
						const delayMs =
							retryAfterDelayMs === undefined
								? BASE_DELAY_MS * 2 ** attempt
								: validateRetryDelayMs(retryAfterDelayMs, options);

						await sleep(delayMs, options?.signal);
						continue;
					}

					// 最终一次尝试或不可重试的错误：解析响应体生成友好报错（如用量限额提示）后抛出
					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new Error(info.friendlyMessage || info.message);
				} catch (error) {
					if (error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					// 网络错误（fetch 抛错）默认可重试：同样按指数退避；
					// 服务器要求等待过久（RetryDelayExceededError）或用量限额错误不重试
					if (
						attempt < maxRetries &&
						!(lastError instanceof RetryDelayExceededError) &&
						!lastError.message.includes("usage limit")
					) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				}
			}

			// 重试耗尽仍无成功响应：抛出最后一次错误
			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			// start 事件只发一次：WebSocket 路径降级而来时可能已发过
			if (!startEmitted) {
				startEmitted = true;
				stream.push({ type: "start", partial: output });
			}
			await processStream(response, output, stream, model, grammarToolInputProperties, options);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			assertSuccessfulOutput(output);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				// 流式解析用的临时缓冲只在解析期间有意义，持久化前必须删除
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			// 按是否用户中止设置停止原因；错误信息统一格式化后推送 error 事件并结束流
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 简化流式入口：从 SimpleStreamOptions 组装完整选项后委托给 stream()。
 * 思考档位经 clampThinkingLevel 收敛到模型实际支持的档位；
 * "off" 收敛结果表示不发 reasoning 字段（交由模型默认行为）。
 */
export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
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
	} satisfies OpenAICodexResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	// "off" 映射为 undefined：Codex 请求体里省略 reasoning 即不思考
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// 请求体构建
// ============================================================================

/**
 * 组装 Codex Responses 请求体。
 *
 * Codex 特有设定：system prompt 走顶层 instructions 字段（不走消息数组）、
 * store 恒为 false（后端要求）、include 声明回传加密推理内容（跨请求续传
 * reasoning 所需）、prompt_cache_key 承载会话缓存键、verbosity 默认 low。
 *
 * @param model 目标模型
 * @param context 统一请求上下文
 * @param options 流式选项（verbosity、toolChoice、temperature、serviceTier、reasoning 等）
 * @param cacheSessionId 截断后的会话 id，作 prompt_cache_key
 * @param grammarToolInputProperties 文法工具属性映射（工具名 → 输入属性名）
 * @returns 可直接序列化的请求体
 */
function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	cacheSessionId: string | undefined,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		context.tools,
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
): RequestBody {
	const supportsStrictMode = model.compat?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = model.compat?.supportsOpenAIGrammarTools ?? false;
	// 延迟工具（deferred tools）模式：后端支持 additional_tools 消息或
	// tool_search 时，把历史中「已加载但尚未调用」的工具延迟声明，缩减请求体
	const deferredToolsMode = model.compat?.supportsAdditionalTools
		? "additional-tools"
		: model.compat?.supportsToolSearch
			? "tool-search"
			: undefined;
	const toolPlacement = splitDeferredTools(context, deferredToolsMode !== undefined);
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		deferredToolsMode,
		toolOptions: {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		},
	});

	// 请求体基座：instructions 承载 system prompt；store 必须为 false；
	// include 要求回传加密推理内容（下次请求原样带回即可续传思考上下文）
	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: context.systemPrompt || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: cacheSessionId,
		tool_choice: options?.toolChoice ?? "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (toolPlacement.immediate.length > 0) {
		body.tools = convertResponsesTools(toolPlacement.immediate, {
			strict: null,
			supportsStrictMode,
			supportsOpenAIGrammarTools,
		});
	}

	// 思考配置：经模型 thinkingLevelMap 映射到后端实际接受的档位；
	// 映射结果为 null 表示该模型不支持思考，整体省略 reasoning 字段
	if (options?.reasoningEffort !== undefined) {
		const effort =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	}

	return body;
}

/**
 * 计算 service_tier 的计费倍率：flex 半价、priority 加价（gpt-5.5 为 2.5 倍，
 * 其余 2 倍）、默认/未指定不调整。
 *
 * @param model 目标模型（区分 priority 档倍率）
 * @param serviceTier 生效的服务层级
 * @returns 成本倍率
 */
function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
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

/**
 * 按生效的 service_tier 倍率调整 usage 成本：对输入/输出/缓存读写各项乘以
 * 倍率后重算总额；倍率为 1（默认档）时原样返回，不做任何修改。
 *
 * @param usage 待调整的用量（原地修改）
 * @param serviceTier 生效的服务层级
 * @param model 目标模型（区分 priority 档倍率）
 */
function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-codex-responses">, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 * 合并「响应回报的 service_tier」与「请求指定的 service_tier」：
 * 后端可能把 flex/priority 请求按实际用量回落为 "default"，此时仍以请求档位
 * 计费；其余情况优先响应回报值，缺失时回退请求值。
 *
 * @param responseServiceTier 响应中回报的层级
 * @param requestServiceTier 请求中指定的层级
 * @returns 计费口径采用的层级
 */
function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

/**
 * 解析 SSE 请求端点：规整传入 baseUrl（默认 chatgpt.com/backend-api）的尾斜杠，
 * 并按现有后缀智能补齐路径——已指向 /codex/responses、/codex 或裸基地址均可。
 *
 * @param baseUrl 模型配置的基地址
 * @returns 完整的 responses 端点 URL
 */
function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

/**
 * 把 SSE 端点 URL 转换为 WebSocket 端点：https→wss、http→ws，路径不变
 * （Codex 的 WebSocket 与 SSE 共用同一路径）。
 *
 * @param baseUrl 模型配置的基地址
 * @returns WebSocket 端点 URL
 */
function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// 响应流处理
// ============================================================================

/**
 * SSE 响应的流解析：parseSSE 切分事件 → mapCodexEvents 归一化 → 共享的
 * processResponsesStream 填充 output 并推送标准事件（两条传输复用后两步）。
 *
 * @param response SSE 响应对象
 * @param output 待填充的助手消息
 * @param stream 标准事件流
 * @param model 目标模型（计费与能力判断）
 * @param grammarToolInputProperties 文法工具属性映射
 * @param options 流式选项（serviceTier 计费口径）
 */
async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	await processResponsesStream(mapCodexEvents(parseSSE(response, options?.signal), output), output, stream, model, {
		serviceTier: options?.serviceTier,
		grammarToolInputProperties,
		resolveServiceTier: resolveCodexServiceTier,
		applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
	});
}

/** Codex 后端返回的业务错误（error / response.failed 事件），携带错误码与原始 payload。 */
class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

/** Codex 传输层协议错误（SSE/WS 帧非法 JSON 等），携带原始数据便于排查。 */
class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

/**
 * 判断错误是否为 Codex 业务/协议错误（而非网络/传输层错误）：
 * 这类错误换 SSE 传输也会复现，不触发降级。
 *
 * @param error 待判断的错误
 */
function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

/** 判断是否为「账号 WebSocket 连接数达上限」错误（用于内部静默重试）。 */
function isWebSocketConnectionLimitReachedError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}

/** 判断是否为 previous_response_id 失效错误（用于丢弃续传状态后整轮重发）。 */
function isPreviousResponseNotFoundError(error: unknown): boolean {
	return error instanceof CodexApiError && error.code === PREVIOUS_RESPONSE_NOT_FOUND_CODE;
}

/**
 * 从 error 事件中提取错误码与消息：兼容顶层 { code, message } 与
 * 嵌套 { error: { code, message } } 两种事件形态。
 *
 * @param event 原始 error 事件
 */
function extractCodexEventError(event: Record<string, unknown>): { code?: string; message?: string } {
	const nested = event.error && typeof event.error === "object" ? (event.error as Record<string, unknown>) : undefined;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : undefined,
		message:
			typeof event.message === "string"
				? event.message
				: typeof nested?.message === "string"
					? nested.message
					: undefined,
	};
}

/**
 * 把 Codex 原始事件流归一化为共享解析器可识别的 ResponseStreamEvent 流
 * （SSE 与 WebSocket 两条传输共用）。处理三类特殊事件：
 * - error：提取错误信息抛 CodexApiError；
 * - response.failed：从 response.error 提取信息抛 CodexApiError；
 * - response.done / response.completed / response.incomplete：Codex 以
 *   response.done 表示完成，统一改写为 response.completed 后结束生成；
 * 其余事件原样透传。
 *
 * @param events 原始事件流（已解析为对象）
 * @param output 待填充的助手消息（透传 end_turn 等字段）
 */
async function* mapCodexEvents(
	events: AsyncIterable<Record<string, unknown>>,
	output: AssistantMessage,
): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const { code, message } = extractCodexEventError(event);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event,
			});
		}

		if (type === "response.failed") {
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown; end_turn?: unknown } }).response;
			// end_turn 是 Codex 特有字段：标记本轮是否「主动结束对话」，透传到 output
			if (typeof response?.end_turn === "boolean") {
				output.endTurn = response.end_turn;
			}
			// 状态字段做白名单归一化：未知状态置 undefined，避免共享解析器误判
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

/** 状态白名单归一化：仅接受 Codex 已知状态字符串，其余返回 undefined。 */
function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE 解析
// ============================================================================

/**
 * 手写 SSE 解析器：按空行（\n\n）切分事件块，聚合块内 data: 行为一条
 * JSON 消息并逐条产出；跳过 [DONE] 哨兵；JSON 解析失败抛 CodexProtocolError。
 * 监听中止信号主动 cancel reader，finally 中兜底释放流资源。
 *
 * @param response SSE 响应对象
 * @param signal 用户中止信号
 */
async function* parseSSE(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	// 中止时主动取消 reader，让正在挂起的 read() 尽快返回
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			const { done, value } = await reader.read();
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (done) break;
			// 增量解码累积到缓冲，循环切出完整事件块（以空行分隔）
			buffer += decoder.decode(value, { stream: true });

			let idx = buffer.indexOf("\n\n");
			while (idx !== -1) {
				const chunk = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 2);

				// 一个事件块可含多行 data:，拼接后整体解析为一条 JSON 消息
				const dataLines = chunk
					.split("\n")
					.filter((l) => l.startsWith("data:"))
					.map((l) => l.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								cause,
								payload: data,
							});
						}
					}
				}
				idx = buffer.indexOf("\n\n");
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// WebSocket 解析与连接池
// ============================================================================

/** WebSocket 传输的 OpenAI-Beta 协议版本（值为协议启用日期）。 */
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
/** 空闲连接回收时长：闲置超过 5 分钟即关闭池中连接。 */
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;
/** 连接最长存活时长：在接近服务端会话上限（约 1 小时）前主动换新，避免用到过期连接。 */
const SESSION_WEBSOCKET_MAX_AGE_MS = 55 * 60 * 1000;

/** 本抽象用到的 WebSocket 事件类型（抹平运行时差异的最小子集）。 */
type WebSocketEventType = "open" | "message" | "error" | "close";
/** WebSocket 事件监听器（事件对象形态因运行时而异，统一以 unknown 接收）。 */
type WebSocketListener = (event: unknown) => void;

/**
 * WebSocket 最小接口抽象：只依赖 close/send/addEventListener/removeEventListener
 * 四个方法，兼容浏览器 WebSocket、Node ws、Bun 等实现。
 */
interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

/**
 * 连接级续传状态：记录上一轮的请求体与响应，供下一轮做增量（delta）请求——
 * 服务端在同一连接范围内保留 previous_response_id 对应的上下文。
 */
interface CachedWebSocketContinuationState {
	/** 上一轮发出的完整请求体（不含续传改写）。 */
	lastRequestBody: RequestBody;
	/** 上一轮响应的 id（下一轮的 previous_response_id）。 */
	lastResponseId: string;
	/** 上一轮响应转换出的 input 条目（不含工具结果，见 processWebSocketStream）。 */
	lastResponseItems: ResponseInput;
}

/** 连接池条目：连接本体 + 占用标记 + 创建时间 + 空闲回收定时器 + 续传状态。 */
interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	createdAt: number;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

/**
 * WebSocket 传输的按会话调试统计（经导出函数供测试与问题排查读取）：
 * 记录请求总数、连接新建/复用、缓存上下文请求、全量/增量请求与失败降级情况。
 */
export interface OpenAICodexWebSocketDebugStats {
	/** 经 WebSocket 传输发出的请求总数。 */
	requests: number;
	/** 新建的连接数。 */
	connectionsCreated: number;
	/** 从池中复用的连接数。 */
	connectionsReused: number;
	/** 走缓存上下文（websocket-cached / auto）的请求数。 */
	cachedContextRequests: number;
	/** 请求体携带 store: true 的次数（应为 0，作防回归计数器）。 */
	storeTrueRequests: number;
	/** 发送完整上下文的请求数（未命中续传）。 */
	fullContextRequests: number;
	/** 增量续传（带 previous_response_id）的请求数。 */
	deltaRequests: number;
	/** 最近一次请求的 input 条目数。 */
	lastInputItems: number;
	/** 最近一次增量请求的 input 条目数（非增量时为 undefined）。 */
	lastDeltaInputItems?: number;
	/** 最近一次增量请求使用的 previous_response_id。 */
	lastPreviousResponseId?: string;
	/** WebSocket 传输失败次数。 */
	websocketFailures: number;
	/** 因降级而走 SSE 的请求数。 */
	sseFallbacks: number;
	/** 会话是否处于 WebSocket→SSE 降级态。 */
	websocketFallbackActive?: boolean;
	/** 最近一次 WebSocket 错误的文本。 */
	lastWebSocketError?: string;
}

// WebSocket 连接池：sessionId → (accountId → 缓存连接)。双键设计让同一会话
// 切换账号后不复用旧账号的连接（服务端上下文按账号隔离）
const websocketSessionCache = new Map<string, Map<string, CachedWebSocketConnection>>();
// 按会话维护的调试统计
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
// 已因 WebSocket 失败而降级 SSE 的会话集合：命中后本进程内不再尝试 WebSocket
const websocketSseFallbackSessions = new Set<string>();

/** 取（或按需初始化）指定会话的调试统计对象。 */
function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

/** 读取指定会话的 WebSocket 调试统计（返回浅拷贝，避免外部改动内部状态）。 */
export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

/**
 * 重置调试数据：传入 sessionId 只清该会话的统计与降级标记，省略则全部清空
 * （测试间隔离用）。
 *
 * @param sessionId 目标会话；省略表示全部
 */
export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

/**
 * 关闭池中缓存的 WebSocket 连接：传入 sessionId 只关该会话的连接，省略则全部。
 * 经下方 registerSessionResourceCleanup 登记为会话资源清理回调，由宿主在
 * 会话结束时调用（见 session-resources.ts）。
 *
 * @param sessionId 目标会话；省略表示全部
 */
export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		for (const entry of websocketSessionCache.get(sessionId)?.values() ?? []) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const accountEntries of websocketSessionCache.values()) {
		for (const entry of accountEntries.values()) closeEntry(entry);
	}
	websocketSessionCache.clear();
}

// 登记为本模块的会话资源清理入口：宿主调用 cleanupSessionResources 时关闭连接池
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

/** 判断会话是否已处于 WebSocket→SSE 降级态（失败过一次即降级）。 */
function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

/** 记录一次 SSE 降级（仅累加计数并刷新标记，不改变降级集合）。 */
function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

/**
 * 记录一次 WebSocket 传输失败：把会话加入降级集合（此后本会话直接走 SSE，
 * 避免反复失败），并留存最近一次错误信息。
 *
 * @param sessionId 会话 id
 * @param error 传输失败的原因
 */
function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

/** WebSocket 构造器签名：第二参数兼容 protocols 数组/字符串或带 headers 的选项对象。 */
type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

let _cachedWebsocket: WebSocketConstructor | null = null;

/**
 * 获取当前运行时可用的 WebSocket 构造器：Bun 下返回内置 HTTP 代理支持的
 * 包装类（Bun 的 WebSocket 不读代理环境变量）；其余运行时取
 * globalThis.WebSocket；不可用时返回 null（调用方据此走不了 WebSocket）。
 *
 * @param env provider 环境变量覆盖（参与代理解析；有覆盖时不命中缓存）
 * @returns WebSocket 构造器；运行时无 WebSocket 时为 null
 */
async function getWebSocketConstructor(env?: ProviderEnv): Promise<WebSocketConstructor | null> {
	// 仅无 env 覆盖时才使用缓存：env 会改变代理解析结果
	if (!env && _cachedWebsocket) return _cachedWebsocket;

	// bun 不读 http 代理环境变量，参考: https://github.com/oven-sh/bun/issues/15489
	// TODO: 等 bun 支持在 websocket 中读取代理环境变量后移除此包装。
	if (typeof process !== "undefined" && process.versions?.bun) {
		const WebSocketWithProxy = class extends WebSocket {
			constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
				let _opts: Record<string, unknown> = {};
				if (Array.isArray(options) || typeof options === "string") {
					_opts = { protocols: options };
				} else {
					_opts = { ...options };
				}

				// 把 ws(s) 目标转回 http(s) 再解析代理，命中则透传 Bun 的 proxy 选项
				const proxyUrl = resolveHttpProxyUrlForTarget(
					url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"),
					env,
				);
				super(url, { ..._opts, ...(proxyUrl ? { proxy: proxyUrl.toString() } : {}) } as any);
			}
		};
		// 同样仅无 env 覆盖时写入缓存
		if (!env) {
			_cachedWebsocket = WebSocketWithProxy;
		}
		return WebSocketWithProxy;
	}

	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}

/** WebSocket 关闭错误：携带关闭码、原因字符串与是否正常关闭标记。 */
class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

/** 读取连接的 readyState（部分运行时不暴露时返回 undefined）。 */
function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

/** 判断连接是否仍可复用：readyState 为 1（OPEN）；拿不到 readyState 时默认可复用。 */
function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	// readyState 不可用时，假定运行时会让连接保持打开/可复用
	return readyState === undefined || readyState === 1;
}

/** 判断连接是否超过最长存活时长（55 分钟），到期强制废弃换新。 */
function isWebSocketSessionExpired(entry: CachedWebSocketConnection): boolean {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}

/** 静默关闭连接：吞掉 close 可能抛出的异常（连接已死等场景无需处理）。 */
function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

/**
 * 为空闲连接安排回收定时器：到点仍未被占用则关闭连接并从池中移除
 * （含清理空的外层 Map）；每次调用先清旧定时器——连接被复用或重新
 * 释放时都会重置计时。
 *
 * @param sessionId 会话 id（池的外层键）
 * @param accountId 账号 id（池的内层键）
 * @param entry 待回收的连接条目
 */
function scheduleSessionWebSocketExpiry(sessionId: string, accountId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		const accountEntries = websocketSessionCache.get(sessionId);
		if (accountEntries?.get(accountId) === entry) accountEntries.delete(accountId);
		if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}

/**
 * 建立新的 WebSocket 连接（含握手超时、错误与中止处理）。
 * 连接结果以 Promise 返回：open 即 resolve，error/close/超时/中止即 reject。
 *
 * @param url WebSocket 端点
 * @param headers 鉴权等请求头（展开为记录后随构造器选项发送）
 * @param signal 用户中止信号
 * @param connectTimeoutMs 握手超时（毫秒），<=0 表示不限时
 * @param env provider 环境变量覆盖（Bun 代理解析用）
 * @returns 建立成功的连接
 */
async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	connectTimeoutMs = DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS,
	env?: ProviderEnv,
): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor(env);
	if (!WebSocketCtor) {
		throw new Error("WebSocket transport is not available in this runtime");
	}

	// 展开为普通记录并防御性删除混合大小写的 OpenAI-Beta 键——Headers 迭代出的
	// 键为小写，websocket 版 Beta 头（buildWebSocketHeaders 设置）不受影响，
	// 会以小写键随握手请求发送
	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let socket: WebSocketLike;

		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		// 统一善后：清超时定时器并摘掉全部临时监听（settled 后保证只执行一次）
		const cleanup = () => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		// 失败路径：可选地带原因关闭 socket 后 reject
		const fail = (error: Error, closeReason?: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (closeReason) {
				closeWebSocketSilently(socket, 1000, closeReason);
			}
			reject(error);
		};
		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			fail(extractWebSocketError(event));
		};
		const onClose: WebSocketListener = (event) => {
			fail(extractWebSocketCloseError(event));
		};
		const onAbort = () => {
			fail(new Error("Request was aborted"), "aborted");
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);

		// 握手超时：到点仍未 open 则按失败处理并关闭连接
		if (connectTimeoutMs > 0) {
			timeout = setTimeout(() => {
				fail(new Error(`WebSocket connect timeout after ${connectTimeoutMs}ms`), "connect_timeout");
			}, connectTimeoutMs);
		}
		// 注册监听后补查一次中止状态：信号可能在挂载前就已触发
		if (signal?.aborted) {
			onAbort();
		}
	});
}

/**
 * 从连接池获取连接（池的核心入口）：无会话 id 时直连直用不进池；有会话 id 时
 * 按 (sessionId, accountId) 双键取缓存连接，按其状态分四种处理：
 * 1. 空闲且未过期 → 复用（标记 busy，归还时 keep 才回池并重排空闲回收）；
 * 2. 空闲但超龄（55 分钟）→ 关旧建新入池；
 * 3. 正被占用 → 额外建一条一次性连接（不进池，release 即关闭）；
 * 4. 已不可复用（非 OPEN）→ 清理后建新入池。
 *
 * @param url WebSocket 端点
 * @param headers 鉴权等请求头
 * @param sessionId 会话 id（池的外层键）；省略则不使用池
 * @param accountId 账号 id（池的内层键）
 * @param signal 用户中止信号
 * @param connectTimeoutMs 握手超时（毫秒）
 * @param env provider 环境变量覆盖
 * @returns 连接与归还句柄：entry 仅在连接入池时存在；release({keep}) 决定
 *   归还后是回池等待复用还是直接关闭移除
 */
async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	accountId: string,
	signal?: AbortSignal,
	connectTimeoutMs?: number,
	env?: ProviderEnv,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	// 无会话 id：一次性连接，release 直接关闭，不进入连接池
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
		return {
			socket,
			reused: false,
			release: () => closeWebSocketSilently(socket),
		};
	}

	let accountEntries = websocketSessionCache.get(sessionId);
	const cached = accountEntries?.get(accountId);
	if (cached) {
		// 复用前先取消挂在其上的空闲回收定时器
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		// 空闲但超龄：关旧建新（走下方新建逻辑），避免依赖临期的服务端会话
		if (!cached.busy && isWebSocketSessionExpired(cached)) {
			closeWebSocketSilently(cached.socket, 1000, "connection_age_limit");
			accountEntries?.delete(accountId);
			if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
			// 空闲且健康：直接复用，标记 busy 防并发使用
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						const currentEntries = websocketSessionCache.get(sessionId);
						if (currentEntries?.get(accountId) === cached) currentEntries.delete(accountId);
						if (currentEntries?.size === 0) websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, accountId, cached);
				},
			};
		}
		// 被占用（上一轮还没归还）：另建一次性连接应急，不顶替池内条目
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		// 既非忙碌也非健康：已死连接，清理后走下方新建逻辑
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			accountEntries?.delete(accountId);
			if (accountEntries?.size === 0) websocketSessionCache.delete(sessionId);
		}
	}

	// 新建连接并入池（重新获取外层 Map：前面的清理可能已把它整体删除）
	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs, env);
	const entry: CachedWebSocketConnection = { socket, busy: true, createdAt: Date.now() };
	accountEntries = websocketSessionCache.get(sessionId);
	if (!accountEntries) {
		accountEntries = new Map();
		websocketSessionCache.set(sessionId, accountEntries);
	}
	accountEntries.set(accountId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				const currentEntries = websocketSessionCache.get(sessionId);
				if (currentEntries?.get(accountId) === entry) currentEntries.delete(accountId);
				if (currentEntries?.size === 0) websocketSessionCache.delete(sessionId);
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, accountId, entry);
		},
	};
}

/**
 * 从 WebSocket error 事件中尽量提取可读错误：依次尝试事件的 message 字段、
 * 嵌套 error（Error 实例或带 message 的对象），都取不到则返回兜底信息。
 *
 * @param event error 事件对象（运行时形态不一）
 */
function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

/**
 * 把 WebSocket close 事件转换为带上下文的错误：拼接关闭码与原因生成消息，
 * 并保留 code/reason/wasClean 供上层分支判断（如按码区分失败原因）。
 *
 * @param event close 事件对象
 */
function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		// 关闭码 1009（消息过大）但服务端没给原因时，补上可读提示
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

/**
 * 把 WebSocket 消息数据统一解码为字符串：兼容 string、ArrayBuffer、
 * TypedArray/DataView 视图与 Blob 形态（不同运行时给的 data 类型不同）。
 *
 * @param data 消息事件中的 data 字段
 * @returns 解码后的文本；形态不认识时为 null
 */
async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return new TextDecoder().decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return new TextDecoder().decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

/**
 * 把 WebSocket 消息流适配为异步事件生成器（拉模式）：事件先入队列，消费者
 * 逐条取走；无事件时挂起等待，由 wake() 唤醒。终止条件为收到完成事件
 * （response.completed/done/incomplete）；close 早于完成视为错误。
 * idleTimeoutMs 控制流的空闲超时（对应 SSE 路径的 timeoutMs 语义）。
 *
 * @param socket 已建立的连接
 * @param signal 用户中止信号
 * @param idleTimeoutMs 空闲超时（毫秒），<=0 表示不限时
 */
async function* parseWebSocket(
	socket: WebSocketLike,
	signal?: AbortSignal,
	idleTimeoutMs?: number,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	// 唤醒挂起的消费者（先把 pending 置空再 resolve，防止重复唤醒）
	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	const onMessage: WebSocketListener = (event) => {
		void (async () => {
			let text: string | null = null;
			try {
				if (!event || typeof event !== "object" || !("data" in event)) return;
				text = await decodeWebSocketData((event as { data?: unknown }).data);
				if (!text) return;
				const parsed = JSON.parse(text) as Record<string, unknown>;
				const type = typeof parsed.type === "string" ? parsed.type : "";
				// 完成事件：标记已见完成并结束接收（close 随后到来不算错误）
				if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
					sawCompletion = true;
					done = true;
				}
				queue.push(parsed);
				wake();
			} catch (cause) {
				failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
					cause,
					payload: text,
				});
				done = true;
				wake();
			}
		})();
	};

	const onError: WebSocketListener = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		// 完成后服务端正常关连接：只结束流，不当作错误
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) {
			failed = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			// 队列有积压事件：先取走再考虑挂起
			if (queue.length > 0) {
				yield queue.shift()!;
				continue;
			}
			if (done) break;
			// 无事件且未结束：挂起等待新事件/错误/关闭，可选空闲超时
			let timeout: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve, reject) => {
				pending = resolve;
				if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) {
					timeout = setTimeout(() => {
						const error = new Error(`WebSocket idle timeout after ${idleTimeoutMs}ms`);
						failed = error;
						done = true;
						pending = null;
						closeWebSocketSilently(socket, 1000, "idle_timeout");
						reject(error);
					}, idleTimeoutMs);
				}
			}).finally(() => {
				if (timeout) {
					clearTimeout(timeout);
				}
			});
		}

		if (failed) {
			throw failed;
		}
		// 既无错误也没等到完成事件就被关闭：按传输失败处理（上层可降级 SSE）
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** 剥离请求体中的 input 与 previous_response_id，只留「其余部分」用于对比。 */
function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

/** 以 JSON 序列化对比两组 input 是否等价（undefined 视为空数组）。 */
function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

/** 判断两个请求体除 input / previous_response_id 外是否完全一致。 */
function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}

/**
 * 计算本轮请求相对续传基线的 input 增量（前缀匹配法）。
 *
 * 基线 = 上一轮请求的 input + 上一轮响应条目（不含工具结果）；本轮 input 必须
 * 严格以基线为前缀，超出部分即为增量（新工具结果 + 新用户消息等）。
 * 任一条件不满足（其余请求参数变了、上下文被截断/改写、前缀不符）都返回
 * undefined，表示无法续传、需发全量。
 *
 * @param body 本轮完整请求体
 * @param continuation 连接上记录的上一轮续传状态
 * @returns 增量 input；无法续传时为 undefined
 */
function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	// 其余请求参数（模型、instructions、tools 等）必须与上一轮完全一致
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	// 上下文变短（被截断/压缩）说明历史已改写，不能按前缀续传
	if (currentInput.length < baseline.length) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baseline.length);
	if (!responseInputsEqual(prefix, baseline)) {
		return undefined;
	}

	return currentInput.slice(baseline.length);
}

/**
 * 基于连接的续传状态改写请求体：能算出增量且持有上一轮响应 id 时，
 * 返回带 previous_response_id、input 只含增量的请求体；否则清掉失效的
 * 续传状态并原样返回全量请求体。
 *
 * @param entry 池中的连接条目（含续传状态）
 * @param body 本轮完整请求体
 * @returns 实际要发送的请求体（增量或全量）
 */
function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		// 续传状态已不可用：立即作废，避免下次再做无谓的前缀比较
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

/**
 * 包装事件流：首个事件到达时触发 onStart 再透传——把「输出开始」的时机
 * 推迟到后端确实开始回应，握手/建连阶段的失败因此仍可无缝降级 SSE。
 */
async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
		}
		yield event;
	}
}

/**
 * WebSocket 传输的单次请求全流程：取连接（池化复用）→ （可选）改写为增量
 * 续传请求体 → 发送 response.create 帧 → 复用共享解析器消费事件流 →
 * 成功时把本轮请求/响应记入连接的续传状态 → 归还连接。
 *
 * @param url WebSocket 端点
 * @param body 完整请求体（续传改写前的原始形态）
 * @param headers WebSocket 请求头
 * @param output 待填充的助手消息
 * @param stream 标准事件流
 * @param model 目标模型
 * @param onStart 输出开始回调（首个流事件到达时触发，见 startWebSocketOutputOnFirstEvent）
 * @param idleTimeoutMs 流空闲超时（毫秒）
 * @param websocketConnectTimeoutMs 握手超时（毫秒）
 * @param cacheSessionId 会话 id（连接池键）
 * @param accountId 账号 id（连接池键）
 * @param grammarToolInputProperties 文法工具属性映射
 * @param options 流式选项
 */
async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	idleTimeoutMs: number | undefined,
	websocketConnectTimeoutMs: number | undefined,
	cacheSessionId: string | undefined,
	accountId: string,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	options?: OpenAICodexResponsesOptions,
): Promise<void> {
	const { socket, entry, reused, release } = await acquireWebSocket(
		url,
		headers,
		cacheSessionId,
		accountId,
		options?.signal,
		websocketConnectTimeoutMs,
		options?.env,
	);
	// 默认归还时保留连接；出错或用户中止时置 false（直接关闭并移出池）
	let keepConnection = true;
	// 增量续传仅在显式 websocket-cached 或默认 auto 时启用
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	// ChatGPT Codex Responses 拒绝 `store: true`（要求 "Store must be set to false"）。
	// WebSocket 续传不依赖服务端持久化，而是靠连接范围内的 previous_response_id 状态。
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	// 维护按会话的调试统计（全量/增量请求、连接复用等计数）
	const stats = cacheSessionId ? getOrCreateWebSocketDebugStats(cacheSessionId) : undefined;
	if (stats) {
		stats.requests++;
		if (reused) stats.connectionsReused++;
		else stats.connectionsCreated++;
		if (useCachedContext) stats.cachedContextRequests++;
		if (requestBody.store === true) stats.storeTrueRequests++;
		stats.lastInputItems = requestBody.input?.length ?? 0;
		if (requestBody.previous_response_id) {
			stats.deltaRequests++;
			stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
			stats.lastPreviousResponseId = requestBody.previous_response_id;
		} else {
			stats.fullContextRequests++;
			stats.lastDeltaInputItems = undefined;
			stats.lastPreviousResponseId = undefined;
		}
	}
	try {
		// 以 response.create 帧发送请求体（其余字段直接平铺进帧对象）
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(parseWebSocket(socket, options?.signal, idleTimeoutMs), output),
				onStart,
			),
			output,
			stream,
			model,
			{
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			},
		);
		if (options?.signal?.aborted) {
			// 用户中止：连接状态不可信，归还时不保留
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			// 成功完成：把本轮响应转成 input 条目记入续传状态，供下一轮做增量。
			// 过滤掉工具调用输出条目——下一轮请求的 input 会由调用方以
			// toolResult 消息的形式重新携带，不能重复计入基线
			const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
				includeSystemPrompt: false,
				grammarToolInputProperties,
			}).filter((item) => item.type !== "function_call_output" && item.type !== "custom_tool_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			};
		}
	} catch (error) {
		// 失败：续传状态一并作废（下一轮从全量开始），连接不保留
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

// ============================================================================
// 错误响应解析
// ============================================================================

/**
 * 解析非 2xx 响应为错误信息：优先取 JSON 错误对象的 message；对用量限额类
 * 错误（429 或 usage_limit_reached 等错误码）额外生成面向用户的友好提示，
 * 附带订阅计划类型与预计重置时间。响应体不是 JSON 时回退原文/状态文本。
 *
 * @param response 错误响应对象
 * @returns 原始 message 与可选的友好提示 friendlyMessage
 */
async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			// 用量限额类错误：拼出带计划类型与重置倒计时的用户提示
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {}

	return { message, friendlyMessage };
}

// ============================================================================
// 鉴权与请求头
// ============================================================================

/**
 * 从 access token（JWT）中解析 ChatGPT 账号 id：手动解码 payload 段，读取
 * "https://api.openai.com/auth" 命名空间下的 chatgpt_account_id。不做签名
 * 校验（令牌真伪由服务端把关），任何环节失败都抛统一错误。
 * OAuth 凭据里也存有 accountId，但请求链路始终以这里现解析的为准。
 *
 * @param token OAuth access token（JWT 形态）
 * @returns 账号 id
 */
function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		const payload = JSON.parse(atob(parts[1]));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

/**
 * 构建 Codex 请求的公共基础头：模型配置头打底，叠加调用方附加头
 * （值为 null 表示显式删除该头），再写入四个必备头——Bearer 鉴权、
 * chatgpt-account-id（订阅账号标识，后端必需）、originator: pi（客户端来源
 * 标识）、pi 的 User-Agent。
 *
 * @param initHeaders 模型配置的初始头
 * @param additionalHeaders 调用方附加头（null 值表示删除）
 * @param accountId 从 token 解析的账号 id
 * @param token OAuth access token
 * @returns 组装好的 Headers 对象
 */
function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		if (value === null) {
			headers.delete(key);
		} else {
			headers.set(key, value);
		}
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	headers.set("User-Agent", getPiUserAgent());
	return headers;
}

/**
 * 构建 SSE 传输专用头：基础头之上设置实验版 Beta 声明（responses=experimental）、
 * event-stream 与 JSON 内容类型；有会话 id 时附带 session-id 与
 * x-client-request-id（会话亲和路由，提高提示词缓存命中）。
 *
 * @param initHeaders 模型配置的初始头
 * @param additionalHeaders 调用方附加头
 * @param accountId 账号 id
 * @param token OAuth access token
 * @param sessionId 会话 id（可选）
 * @returns SSE 请求头
 */
function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session-id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

/**
 * 构建 WebSocket 传输专用头：基础头之上先删掉 SSE 语义的头（accept、
 * content-type 与两种大小写的 OpenAI-Beta），再设置 websocket 版 Beta 协议
 * 版本，并把 x-client-request-id / session-id 统一设为本次请求标识
 * （WebSocket 每帧复用同一条连接，标识在握手时给定）。
 *
 * @param initHeaders 模型配置的初始头
 * @param additionalHeaders 调用方附加头
 * @param accountId 账号 id
 * @param token OAuth access token
 * @param requestId WebSocket 请求标识（会话 id 或 uuidv7）
 * @returns WebSocket 请求头
 */
function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: ProviderHeaders | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session-id", requestId);
	return headers;
}
