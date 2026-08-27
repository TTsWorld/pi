/**
 * @file Google Vertex AI 流式适配器
 *
 * @description
 * 本文件是 @earendil-works/pi-ai 多厂商 AI SDK 中 "google-vertex" provider 的流式实现，
 * 基于官方 @google/genai SDK（以 vertexai: true 走 Vertex AI 后端）调用
 * generateContentStream 接口。
 *
 * 与 Gemini（AI Studio）后端最大的差异在「认证装配」：Vertex 是环境凭据型服务，
 * 客户端有两条构建路径——
 * - API Key 路径：resolveApiKey 过滤掉占位符与魔法标记后拿到真实 key，
 *   直接以 { vertexai: true, apiKey } 构建客户端（不需要 project / location）；
 * - ADC 路径：无有效 key 时回落到 Application Default Credentials，要求
 *   project（GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT）与 location（GOOGLE_CLOUD_LOCATION），
 *   并把 GOOGLE_APPLICATION_CREDENTIALS 作为 keyFileName 传给 SDK 的 GoogleAuth；
 *   三者均缺省时令牌获取完全交给 SDK 内置的 ADC 探测链（gcloud 凭据文件、
 *   元数据服务器等）。
 *
 * 其余职责与 google-generative-ai.ts 同构：请求参数组装（generationConfig /
 * thinkingConfig / toolConfig）、流式 chunk 解析（文本 / 思考 / 工具调用三类内容块的
 * 事件流转换）、usage 统计与计费，以及按模型家族（Gemini 3 / Gemini 2.5）选择
 * thinkingLevel（离散档位）或 thinkingBudget（token 预算）两种思考控制策略。
 *
 * 与兄弟文件的分工：
 * - google-shared.ts：两个 Google 后端的共享逻辑——消息/工具转换、finishReason 映射、
 *   思考档位解析、请求重试包装等。
 * - google-generative-ai.ts：同一 SDK 的 Gemini API（AI Studio）后端版本（仅 API Key 认证）。
 */
import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type HttpOptions,
	ResourceScope,
	type ThinkingConfig,
	ThinkingLevel,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
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
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	retryGoogleRequest,
	supportsGoogleStrictToolSampling,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

/**
 * google-vertex 专属流式选项。
 *
 * 在通用 StreamOptions 之上扩展：
 * - toolChoice：函数调用模式（auto=模型自决 / none=禁用 / any=强制调用）。
 * - thinking：思考控制，level 与 budgetTokens 二选一——
 *   Gemini 3 系模型走 level（离散档位），Gemini 2.x 系模型走 budgetTokens（token 预算）。
 * - project / location：ADC 路径必需的 GCP 项目 ID 与区域（如 us-central1、europe-west1）。
 *   Vertex 是区域化服务，请求会路由到 {location}-aiplatform.googleapis.com 端点，
 *   且部分区域（如 eu）在数据合规上有额外约束，因此不像 AI Studio 那样全局唯一入口。
 */
export interface GoogleVertexOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 表示动态预算（由服务端决定思考量），0 表示关闭思考
		level?: GoogleApiThinkingLevel;
	};
	project?: string;
	location?: string;
}

// Vertex AI REST 端点的 API 版本号，固定使用稳定版 v1
const API_VERSION = "v1";

/**
 * API Key 的「魔法标记」值：部分调用方（上层封装）在走 ADC / 服务账号认证时，
 * 会往 options.apiKey 塞这个字面量以表示「已认证但并非 API Key」。
 * resolveApiKey 识别到它时按无 key 处理，回落到 ADC 客户端路径。
 */
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";

/**
 * 思考档位映射表：把我们内部定义的字符串联合类型 GoogleApiThinkingLevel
 * （值与 Google 官方枚举同名）映射为 @google/genai 的 ThinkingLevel 枚举值。
 * Gemini 3 系模型的 thinkingConfig.thinkingLevel 只接受该枚举。
 */
const THINKING_LEVEL_MAP: Record<GoogleApiThinkingLevel, ThinkingLevel> = {
	THINKING_LEVEL_UNSPECIFIED: ThinkingLevel.THINKING_LEVEL_UNSPECIFIED,
	MINIMAL: ThinkingLevel.MINIMAL,
	LOW: ThinkingLevel.LOW,
	MEDIUM: ThinkingLevel.MEDIUM,
	HIGH: ThinkingLevel.HIGH,
};

// 自增计数器：为未返回 ID（或 ID 重复）的工具调用生成唯一 ID
let toolCallCounter = 0;

/**
 * 主流式函数：把一次 Vertex AI generateContentStream 调用转换为 pi 统一的
 * AssistantMessageEventStream 事件流。
 *
 * @param model - 目标模型描述（含 id、baseUrl、reasoning 能力等）
 * @param context - 对话上下文（消息历史、系统提示、工具列表）
 * @param options - Vertex 专属流式选项（apiKey / project / location、thinking、toolChoice、signal 等）
 * @returns 异步推送事件的 AssistantMessageEventStream（start / *_delta / done 或 error）
 */
export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// ========== 初始化聚合结果对象 ==========
		// output 贯穿整个流的生命周期：所有 chunk 的内容都累积到这里，并作为 partial
		// 随每个事件下发；流结束（done / error）时它就是最终消息。
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-vertex" as Api,
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
			// ========== 前置校验与客户端构建 ==========
			// @google/genai SDK 自管 HTTP 传输层，不支持注入自定义 fetch，
			// 这里显式拒绝，避免调用方误以为自定义 fetch 已生效。
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error("Custom fetch is not supported by the Google Vertex adapter");
			}
			// 解析 API Key：过滤空值、魔法标记与占位符后无有效 key 则返回 undefined
			const apiKey = resolveApiKey(options);
			// 双路径构建客户端：优先用 Vertex API Key（若提供），
			// 否则用 ADC（Application Default Credentials）+ project + location
			const client = apiKey
				? createClientWithApiKey(model, apiKey, options?.headers)
				: createClient(model, resolveProject(options), resolveLocation(options), options?.headers, options?.env);
			// ========== 组装请求参数并发出调用 ==========
			let params = buildParams(model, context, options);
			// onPayload 钩子：允许调用方在发请求前拦截 / 改写最终 payload
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			// 经共享的重试包装发起流式请求（对可重试的 SDK 错误自动重试）
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			// ========== 流式解析：chunk → 事件流 ==========
			stream.push({ type: "start", partial: output });
			// 当前正在累积的文本 / 思考块；为 null 表示当前没有打开的内容块
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			// 始终指向 output.content 最后一个块的索引（新块刚 push 完即取）
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				// Vertex 使用与 Gemini 相同的 @google/genai GenerateContentResponse 类型。
				// responseId 在其中被文档化为每个响应的输出专用标识符，
				// 取首个非空值保留在最终消息上即可。
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						// ========== 文本 / 思考块的增量累积 ==========
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							// 类型切换（text ↔ thinking）或尚无打开的块时，先关闭旧块再开新块，
							// 保证一个内容块内不混入另一种类型
							if (
								!currentBlock ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
								// 思考签名随增量到达，保留最新非空值（回传给 API 用于加密思考的连续性）
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							} else {
								currentBlock.text += part.text;
								currentBlock.textSignature = retainThoughtSignature(
									currentBlock.textSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: part.text,
									partial: output,
								});
							}
						}

						// ========== 工具调用块 ==========
						if (part.functionCall) {
							// 工具调用是独立的内容块：先关闭当前打开的文本 / 思考块
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							const providedId = part.functionCall.id;
							// 服务端未返回 ID，或返回的 ID 与已有工具调用重复时，本地生成唯一 ID，
							// 避免 toolCall_id 冲突导致后续消息回传被服务端拒绝
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							// 工具调用不走增量协议：start → 单次 delta（完整参数 JSON）→ end
							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				// ========== 结束原因映射 ==========
				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					// Vertex 以 STOP 结束但内容里含工具调用时，归一化为 toolUse，
					// 供上层 agent 循环识别「该执行工具了」
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				// ========== usage 统计与计费 ==========
				// 口径说明：input 扣除命中隐式缓存的部分（cacheRead 单列）；
				// output = 正文 + 思考 token；Vertex 的隐式缓存只上报读命中，
				// 没有显式缓存写入，故 cacheWrite 恒为 0。usage 块可能随任一 chunk 到达，
				// 后到的覆盖先到的（通常在最后一个 chunk 携带最终值）。
				if (chunk.usageMetadata) {
					output.usage = {
						input:
							(chunk.usageMetadata.promptTokenCount || 0) - (chunk.usageMetadata.cachedContentTokenCount || 0),
						output:
							(chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
						cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
						totalTokens: chunk.usageMetadata.totalTokenCount || 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					};
					calculateCost(model, output.usage);
				}
			}

			// ========== 收尾：关闭仍打开的最后一个块 ==========
			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			// ========== 流结束校验 ==========
			// 中止信号可能在流式过程中已触发，这里统一转为异常走错误分支
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// 整个流没有收到任何 finishReason，视为异常流
			if (output.stopReason === "pending") {
				throw new Error("Google Vertex stream ended without a finish reason");
			}
			// 服务端以中止 / 错误类原因收尾时，统一转成异常抛出，
			// 并携带原始 rawStopReason 便于排查
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			// ========== 正常结束：输出 done 事件 ==========
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// ========== 错误处理：清理内部属性并输出 error 事件 ==========
			// 清理流式过程中残留在内容块上的内部 index 属性，避免泄漏到最终消息
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			// 依据 signal 状态区分「用户主动中止」与「真实错误」
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 简化入口：把通用 SimpleStreamOptions 适配为 GoogleVertexOptions 后复用主流式函数。
 *
 * 与 AI Studio 版的差异：apiKey 位置传 undefined——Vertex 允许无 key 的 ADC 认证，
 * 客户端构建交由 stream 内部按「有 key 走 key、无 key 走 ADC」决策；
 * 思考策略则按模型家族分流：Gemini 3 系走 thinkingLevel 档位，其余走预算。
 *
 * @param model - 目标模型描述
 * @param context - 对话上下文
 * @param options - 通用简化流式选项
 * @returns 复用 stream() 的 AssistantMessageEventStream
 */
export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies GoogleVertexOptions;
	// 未开启思考：显式传 thinking.enabled=false，让 buildParams 生成「关闭思考」配置
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinking: { enabled: false },
		} satisfies GoogleVertexOptions);
	}

	// 把通用 reasoning 档位收敛到模型支持的区间，再解析为 Google 侧档位
	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);
	// 复用 AI Studio 的模型类型做家族判断（两后端的模型 id 命名一致）
	const geminiModel = model as unknown as Model<"google-generative-ai">;

	// Gemini 3 系：只支持离散 thinkingLevel，不支持 token 预算
	if (isGemini3ProModel(geminiModel) || isGemini3FlashModel(geminiModel)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getGemini3ThinkingLevel(resolvedLevel, geminiModel),
			},
		} satisfies GoogleVertexOptions);
	}

	// 其余（Gemini 2.x 等）：走 thinkingBudget token 预算
	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(geminiModel, resolvedLevel, options.thinkingBudgets),
		},
	} satisfies GoogleVertexOptions);
};

/**
 * 以 ADC（Application Default Credentials）方式构建 Vertex 客户端。
 *
 * 除显式传入的 keyFileName（GOOGLE_APPLICATION_CREDENTIALS）外，
 * 令牌获取由 @google/genai 内置的 GoogleAuth 完成——它会依次探测
 * gcloud 的 ADC 凭据文件、GOOGLE_APPLICATION_CREDENTIALS 环境变量、
 * GCE 元数据服务器等标准 ADC 来源，因此本文件无需自行管理令牌。
 *
 * @param model - 目标模型描述（读取 baseUrl / headers）
 * @param project - GCP 项目 ID（由 resolveProject 解析，缺失会先抛错）
 * @param location - 区域（如 us-central1；由 resolveLocation 解析，缺失会先抛错）
 * @param optionsHeaders - 调用方附加的请求头
 * @param env - provider 层注入的环境变量快照（优先于 process.env）
 * @returns 配置好 vertexai 模式的 GoogleGenAI 客户端
 */
function createClient(
	model: Model<"google-vertex">,
	project: string,
	location: string,
	optionsHeaders?: ProviderHeaders,
	env?: ProviderEnv,
): GoogleGenAI {
	const googleAuthOptions = buildGoogleAuthOptions(env);
	return new GoogleGenAI({
		vertexai: true,
		project,
		location,
		apiVersion: API_VERSION,
		...(googleAuthOptions ? { googleAuthOptions } : {}),
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

/**
 * 以显式 API Key 方式构建 Vertex 客户端（Express 模式）。
 * 带 key 时 SDK 不需要 project / location，请求直接以 key 鉴权。
 *
 * @param model - 目标模型描述（读取 baseUrl / headers）
 * @param apiKey - 已通过 resolveApiKey 校验的真实 API Key
 * @param optionsHeaders - 调用方附加的请求头
 * @returns 配置好 vertexai 模式的 GoogleGenAI 客户端
 */
function createClientWithApiKey(
	model: Model<"google-vertex">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	return new GoogleGenAI({
		vertexai: true,
		apiKey,
		apiVersion: API_VERSION,
		httpOptions: buildHttpOptions(model, optionsHeaders),
	});
}

/**
 * 组装 SDK 的 HTTP 选项：自定义 baseUrl（含资源作用域与版本处理）与请求头。
 *
 * @param model - 目标模型描述（读取 baseUrl 与模型级 headers）
 * @param optionsHeaders - 调用方附加的请求头（可覆盖默认 User-Agent）
 * @returns 有内容时返回 HttpOptions，否则返回 undefined（让 SDK 用默认值）
 */
function buildHttpOptions(model: Model<"google-vertex">, optionsHeaders?: ProviderHeaders): HttpOptions | undefined {
	const httpOptions: HttpOptions = {};
	// ========== 自定义 baseUrl 处理 ==========
	const baseUrl = resolveCustomBaseUrl(model.baseUrl);
	if (baseUrl) {
		httpOptions.baseUrl = baseUrl;
		// 声明自定义 baseUrl 指向「集合根」：SDK 不再往资源名里拼
		// api version / project / location，只追加资源路径（如 publishers/google/models/...）
		httpOptions.baseUrlResourceScope = ResourceScope.COLLECTION;
		// baseUrl 自身已带版本段（如 /v1、/v1beta）时清空 apiVersion，避免重复拼接
		if (baseUrlIncludesApiVersion(baseUrl)) {
			httpOptions.apiVersion = "";
		}
	}

	// ========== 请求头合并 ==========
	// 默认 UA（pi 标识）优先级最低，模型级 headers 次之，调用方传入的最高
	const headers = providerHeadersToRecord({ "User-Agent": getPiUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	return Object.keys(httpOptions).length > 0 ? httpOptions : undefined;
}

/**
 * 解析模型上配置的自定义 baseUrl，返回可直接使用的值。
 * 过滤两类无效值：空白串，以及含 `{location}` 模板占位符的 URL——
 * 模型列表可能生成带区域模板的 Vertex 端点（{location}-aiplatform...），
 * 未替换的模板不能透传给 SDK，返回 undefined 让 SDK 按默认端点路由。
 *
 * @param baseUrl - 模型定义上的 baseUrl 原值
 * @returns 可用的自定义 baseUrl；无有效值时返回 undefined
 */
function resolveCustomBaseUrl(baseUrl: string): string | undefined {
	const trimmed = baseUrl.trim();
	if (!trimmed || trimmed.includes("{location}")) {
		return undefined;
	}
	return trimmed;
}

/**
 * 判断 baseUrl 的路径中是否已包含 API 版本段（v1、v2、v1beta、v3beta1 等）。
 * 优先用 URL 解析路径段；解析失败（非标准 URL）时退化为正则匹配。
 *
 * @param baseUrl - 自定义 baseUrl
 * @returns 是否包含版本段
 */
function baseUrlIncludesApiVersion(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return url.pathname.split("/").some((part) => /^v\d+(?:beta\d*)?$/.test(part));
	} catch {
		return /(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(baseUrl);
	}
}

/**
 * 从 provider 环境中提取服务账号凭据文件路径，构造 GoogleAuth 选项。
 * 未设置 GOOGLE_APPLICATION_CREDENTIALS 时返回 undefined——此时不传
 * googleAuthOptions，令牌获取交给 SDK 内置 ADC 探测链（gcloud 默认路径、
 * 元数据服务器等）。
 *
 * @param env - provider 层注入的环境变量快照（优先于 process.env）
 * @returns 含 keyFileName 的 GoogleAuth 选项，或 undefined
 */
function buildGoogleAuthOptions(env?: ProviderEnv): { keyFilename: string } | undefined {
	const keyFilename = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
	return keyFilename ? { keyFilename } : undefined;
}

/**
 * 解析 options.apiKey，判定是否存在「有效的 API Key」。
 * 三类值视为无 key（返回 undefined，走 ADC 路径）：
 * 空白串；等于 GCP_VERTEX_CREDENTIALS_MARKER 魔法标记（上层表示已用
 * ADC / 服务账号认证）；被尖括号包裹的占位符（如 "<authenticated>"）。
 *
 * @param options - Vertex 专属流式选项
 * @returns 有效 API Key，或 undefined
 */
function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	const apiKey = options?.apiKey?.trim();
	if (!apiKey || apiKey === GCP_VERTEX_CREDENTIALS_MARKER || isPlaceholderApiKey(apiKey)) {
		return undefined;
	}
	return apiKey;
}

/**
 * 判断是否为占位符形式的 API Key：形如 "<...>" 的值（登录向导等
 * 上游流程在未获取真实 key 时可能写入的占位文本）。
 *
 * @param apiKey - 待检查的 key 值
 * @returns 是否占位符
 */
function isPlaceholderApiKey(apiKey: string): boolean {
	return /^<[^>]+>$/.test(apiKey);
}

/**
 * 解析 GCP 项目 ID。优先级：options.project > GOOGLE_CLOUD_PROJECT >
 * GCLOUD_PROJECT（兼容旧变量名）。三者皆无时抛错——ADC 路径必须知道项目。
 *
 * @param options - Vertex 专属流式选项
 * @returns GCP 项目 ID
 */
function resolveProject(options?: GoogleVertexOptions): string {
	const project =
		options?.project ||
		getProviderEnvValue("GOOGLE_CLOUD_PROJECT", options?.env) ||
		getProviderEnvValue("GCLOUD_PROJECT", options?.env);
	if (!project) {
		throw new Error(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

/**
 * 解析区域。优先级：options.location > GOOGLE_CLOUD_LOCATION。
 * 皆无时抛错——Vertex 是区域化服务，必须显式指定区域。
 *
 * @param options - Vertex 专属流式选项
 * @returns 区域标识（如 us-central1）
 */
function resolveLocation(options?: GoogleVertexOptions): string {
	const location = options?.location || getProviderEnvValue("GOOGLE_CLOUD_LOCATION", options?.env);
	if (!location) {
		throw new Error("Vertex AI requires a location. Set GOOGLE_CLOUD_LOCATION or pass location in options.");
	}
	return location;
}

/**
 * 组装 generateContentStream 的请求参数（GenerateContentParameters）。
 *
 * @param model - 目标模型描述
 * @param context - 对话上下文（消息历史、系统提示、工具列表）
 * @param options - Vertex 专属流式选项
 * @returns 可直接发给 SDK 的请求参数
 */
function buildParams(
	model: Model<"google-vertex">,
	context: Context,
	options: GoogleVertexOptions = {},
): GenerateContentParameters {
	// 消息历史 → Vertex contents（共享转换逻辑）
	const contents = convertMessages(model, context);

	// ========== 采样参数（仅显式设置时携带） ==========
	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	// ========== 工具与函数调用模式 ==========
	// 部分模型支持严格工具采样（strict schema），按模型 id 判定后影响
	// 工具声明与 functionCallingMode 两处
	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode = context.tools?.length
		? resolveGoogleFunctionCallingMode(context.tools, options.toolChoice, supportsStrictMode)
		: undefined;
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		// 系统提示经代理对清理后作为 systemInstruction 传入
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools &&
			context.tools.length > 0 && {
				tools: convertTools(context.tools, false, supportsStrictMode),
			}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	// ========== 思考（thinking）配置：三分支 ==========
	// 开启思考且模型具备推理能力：level 与 budgetTokens 二选一
	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = THINKING_LEVEL_MAP[options.thinking.level];
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		// 显式关闭思考：不同模型家族的「关闭」手段不同，见 getDisabledThinkingConfig
		config.thinkingConfig = getDisabledThinkingConfig(model);
	}

	// ========== 中止信号 ==========
	// 已中止的直接抛错；未中止的透传给 SDK 作为请求 abortSignal
	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

/**
 * 判断是否为 Gemini 3 Pro 系模型（含 3.x 子版本号变体，不区分大小写）。
 *
 * @param model - 目标模型（借 AI Studio 的模型类型做家族判断）
 * @returns 是否 Gemini 3 Pro
 */
function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

/**
 * 判断是否为 Gemini 3 Flash 系模型。除 3.x flash 正则匹配外，
 * 还涵盖两个不带版本号的最新别名：gemini-flash-latest 与 gemini-flash-lite-latest
 * （它们当前指向 Gemini 3 Flash 家族，同样只支持 thinkingLevel 档位）。
 *
 * @param model - 目标模型（借 AI Studio 的模型类型做家族判断）
 * @returns 是否 Gemini 3 Flash
 */
function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	const id = model.id.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

/**
 * 构造「关闭思考」的 thinkingConfig。
 *
 * Google 文档：Gemini 3.1 Pro 无法关闭思考，Gemini 3 Flash / Flash-Lite
 * 也不支持完全关闭。对 Gemini 3 系模型，改用其支持的最低 thinkingLevel
 * 且不带 includeThoughts，让隐藏的思考对 pi 保持不可见。
 *
 * @param model - 目标模型描述
 * @returns 对应模型家族的「关闭思考」配置
 */
function getDisabledThinkingConfig(model: Model<"google-vertex">): ThinkingConfig {
	const geminiModel = model as unknown as Model<"google-generative-ai">;
	if (isGemini3ProModel(geminiModel)) {
		return { thinkingLevel: ThinkingLevel.LOW };
	}
	if (isGemini3FlashModel(geminiModel)) {
		return { thinkingLevel: ThinkingLevel.MINIMAL };
	}

	// Gemini 2.x 支持 thinkingBudget = 0 彻底关闭思考
	return { thinkingBudget: 0 };
}

/**
 * 把解析后的思考档位映射为 Gemini 3 系的 thinkingLevel。
 * Pro 系仅暴露 LOW / HIGH 两档（minimal/low 并入 LOW，medium/high 并入 HIGH）；
 * 其余（Flash 系）保留四档原样映射。
 *
 * @param effort - 经 clamp 与解析后的思考档位
 * @param model - 目标模型（用于区分 Pro / Flash 家族）
 * @returns Google API 侧的思考档位
 */
function getGemini3ThinkingLevel(
	effort: ResolvedGoogleThinkingLevel,
	model: Model<"google-generative-ai">,
): GoogleApiThinkingLevel {
	if (isGemini3ProModel(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "LOW";
			case "medium":
			case "high":
				return "HIGH";
		}
	}
	switch (effort) {
		case "minimal":
			return "MINIMAL";
		case "low":
			return "LOW";
		case "medium":
			return "MEDIUM";
		case "high":
			return "HIGH";
	}
}

/**
 * 计算模型思考的 token 预算（thinkingBudget）。优先级：
 * 1. 调用方自定义预算表（thinkingBudgets[level]）；
 * 2. gemini-2.5-pro / gemini-2.5-flash 各自的内置默认预算表
 *    （两者仅 high 档不同：pro 上限 32768，flash 上限 24576）；
 * 3. 其余模型返回 -1，表示动态预算（由服务端自行决定思考量）。
 *
 * @param model - 目标模型（按 id 中的版本串分流）
 * @param level - 解析后的思考档位
 * @param customBudgets - 调用方自定义的档位 → 预算映射
 * @returns 思考 token 预算（-1 表示动态）
 */
function getGoogleBudget(
	model: Model<"google-generative-ai">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	return -1;
}
