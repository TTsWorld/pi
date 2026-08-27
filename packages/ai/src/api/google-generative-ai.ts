/**
 * @file Google Generative AI（Gemini / AI Studio）流式适配器
 *
 * @description
 * 本文件是 @earendil-works/pi-ai 多厂商 AI SDK 中 "google-generative-ai" provider 的流式实现，
 * 基于官方 @google/genai SDK，以 API Key 认证调用 generateContentStream 接口（AI Studio 后端）。
 *
 * 与兄弟文件的分工：
 * - 本文件：API Key 客户端构建、请求参数组装（generationConfig / thinkingConfig / toolConfig）、
 *   流式 chunk 解析（文本 / 思考 / 工具调用三类内容块的事件流转换）、usage 统计与计费，
 *   以及按模型家族（Gemini 3 / Gemma 4 / Gemini 2.5）选择思考控制策略。
 * - google-shared.ts：两个 Google 后端（本文件与 google-vertex.ts）的共享逻辑——
 *   消息/工具转换、finishReason 映射、思考档位解析、请求重试包装等。
 * - google-vertex.ts：同一 SDK 的 Vertex AI 后端版本（ADC / 服务账号认证）。
 */
import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
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
 * google-generative-ai 专属流式选项。
 *
 * 在通用 StreamOptions 之上扩展了工具选择与思考（thinking）控制：
 * - toolChoice：函数调用模式（auto=模型自决 / none=禁用 / any=强制调用）。
 * - thinking：思考控制，level 与 budgetTokens 二选一——
 *   Gemini 3 / Gemma 4 系模型走 level（离散档位），Gemini 2.x 系模型走 budgetTokens（token 预算）。
 */
export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 表示动态预算（由服务端决定思考量），0 表示关闭思考
		level?: GoogleApiThinkingLevel;
	};
}

// 自增计数器：为未返回 ID（或 ID 重复）的工具调用生成唯一 ID
let toolCallCounter = 0;

/**
 * 主流式函数：把一次 Gemini generateContentStream 调用转换为 pi 统一的
 * AssistantMessageEventStream 事件流。
 *
 * @param model - 目标模型描述（含 id、baseUrl、reasoning 能力等）
 * @param context - 对话上下文（消息历史、系统提示、工具列表）
 * @param options - Google 专属流式选项（apiKey、thinking、toolChoice、signal 等）
 * @returns 异步推送事件的 AssistantMessageEventStream（start / *_delta / done 或 error）
 */
export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// ========== 初始化聚合结果对象 ==========
		// output 贯穿整个流的生命周期：所有 chunk 的内容都累积到这里，并作为 partial
		// 随每个事件下发；流结束（done / error）时它就是最终消息。
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai" as Api,
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
				throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
			}
			// API Key 认证是本文件与 Vertex 版（ADC / 服务账号）的核心差异：
			// 缺失密钥直接抛错，统一走 error 事件通道。
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options?.headers);
			let params = buildParams(model, context, options);
			// onPayload 钩子：发送前允许调用方观测 / 改写最终请求参数
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			// 经共享重试策略发起流式请求（408/409/429/5xx 指数退避，见 google-shared.ts）
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });

			// ========== 流式解析主循环 ==========
			// currentBlock 追踪当前正在累积的文本/思考块：Gemini 流中文本与思考片段可能
			// 交替出现，靠它判断何时收尾旧块、开启新块。
			// blockIndex 始终指向 content 数组的最后一个块（即当前活跃块）。
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				// @google/genai 文档标注 GenerateContentResponse.responseId 为 output-only 字段，
				// 用于标识每个响应；流中只保留首个非空值即可。
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const part of candidate.content.parts) {
						// ---- 文本 / 思考增量处理 ----
						if (part.text !== undefined) {
							const isThinking = isThinkingPart(part);
							// 块切换条件：当前无活跃块，或新片段类型与当前块类型不一致
							// （思考片段流入文本块、文本片段流入思考块，都需先收尾再开新块）
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
							// 累积增量并转发事件；thoughtSignature 经 retainThoughtSignature 保留——
							// 部分后端只在某片段携带签名、后续增量缺失时不能将其覆盖丢失
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += part.text;
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

						// ---- 工具调用处理：函数调用不走增量累积，一次性下发完整调用 ----
						if (part.functionCall) {
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

							// 后端未返回 ID 或 ID 与已有调用重复时本地生成唯一 ID；
							// 某些模型（Gemini 3+ 等）要求显式 ID 才能与 functionResponse 配对
							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							// thoughtSignature 可能挂在 functionCall 片段上，原样透传以便多轮续链
							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

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

				// ---- 结束原因：映射为统一 StopReason ----
				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					// 模型给出 STOP 但内容里有工具调用时，把 stop 修正为 toolUse，
					// 让上层 agent 循环能正确识别「该执行工具了」
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				// ---- usage 统计与计费 ----
				// 口径说明：
				// - input 从 promptTokenCount 中扣除缓存命中部分（cachedContentTokenCount），
				//   命中的 token 单独记入 cacheRead（计费单价不同，避免重复计入 input）；
				// - output 把思考消耗（thoughtsTokenCount）并入候选 token，
				//   并单独记入 reasoning 字段供上层展示思考用量；
				// - cacheWrite 恒为 0：Gemini 使用隐式缓存，没有显式的缓存写入计费。
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

			// ========== 收尾：闭合最后一个未结束的块，并校验流的完整性 ==========
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

			// 中途被 abort：在发出 done 之前转入错误路径
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// 流结束却没有任何 finishReason，视为协议异常
			if (output.stopReason === "pending") {
				throw new Error("Google stream ended without a finish reason");
			}
			// finishReason 映射为 aborted / error 的（安全拦截、MALFORMED_FUNCTION_CALL 等），
			// 统一转成异常抛出，并携带原始 rawStopReason 便于排查
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

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
 * 简化流式入口：把 SimpleStreamOptions（reasoning 档位等通用参数）翻译成
 * 本 provider 的 GoogleOptions 后委托给 stream()。
 *
 * 关键决策：思考控制的形态由模型家族决定——
 * - 未开启 reasoning：显式下发 thinking.enabled=false（buildParams 内按模型选择关闭策略）；
 * - Gemini 3 Pro/Flash、Gemma 4：使用离散 thinkingLevel 档位；
 * - 其余推理模型（Gemini 2.5 系）：使用 thinkingBudget token 预算。
 *
 * @param model - 目标模型描述
 * @param context - 对话上下文
 * @param options - 简化流式选项（apiKey、reasoning、toolChoice、thinkingBudgets 等）
 * @returns 委托 stream() 产生的事件流
 * @throws 缺少 API Key 时同步抛错（区别于 stream 的异步 error 事件）
 */
export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 组装通用基础选项（apiKey 等）并透传 toolChoice
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleOptions;
	// 未要求推理：显式关闭思考，走 buildParams 的关闭策略分支
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	// reasoning 档位先按模型能力收敛（clamp），再解析为 Google 标准档位
	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);
	const googleModel = model as Model<"google-generative-ai">;

	// Gemini 3 / Gemma 4 系：走 thinkingLevel 离散档位
	if (isGemini3ProModel(googleModel) || isGemini3FlashModel(googleModel) || isGemma4Model(googleModel)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: getThinkingLevel(resolvedLevel, googleModel),
			},
		} satisfies GoogleOptions);
	}

	// 其余推理模型（Gemini 2.5 系）：走 thinkingBudget token 预算
	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(googleModel, resolvedLevel, options.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

/**
 * 创建 @google/genai 客户端（API Key 认证）。
 *
 * @param model - 目标模型（baseUrl / headers 可携带自定义接入点与请求头）
 * @param apiKey - Gemini API 密钥
 * @param optionsHeaders - 调用方在流式选项里传入的额外请求头
 * @returns 配置好 httpOptions 的 GoogleGenAI 客户端实例
 */
function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl 已含版本路径，置空以禁止 SDK 再追加版本号
	}
	// 请求头优先级：调用方选项头 > 模型配置头 > pi 默认 User-Agent（展开顺序保证后者被前者覆盖）
	const headers = providerHeadersToRecord({ "User-Agent": getPiUserAgent(), ...model.headers, ...optionsHeaders });
	if (headers) {
		httpOptions.headers = headers;
	}

	// 仅当确有自定义配置时才传 httpOptions，否则保持 SDK 默认行为
	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

/**
 * 组装 generateContentStream 所需的 GenerateContentParameters 请求参数。
 *
 * @param model - 目标模型描述
 * @param context - 对话上下文（系统提示、工具、消息历史）
 * @param options - Google 专属流式选项
 * @returns 可直接传给 SDK 的请求参数（model / contents / config 三段式）
 */
function buildParams(
	model: Model<"google-generative-ai">,
	context: Context,
	options: GoogleOptions = {},
): GenerateContentParameters {
	// 消息历史转换为 Gemini Content[] 格式（共享逻辑，见 google-shared.ts）
	const contents = convertMessages(model, context);

	// ========== 基础生成参数（temperature / maxTokens） ==========
	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	// ========== 工具与函数调用配置 ==========
	// Gemini 3+ 支持 VALIDATED 严格模式（强制校验必填参数），据此解析 functionCallingMode
	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode = context.tools?.length
		? resolveGoogleFunctionCallingMode(context.tools, options.toolChoice, supportsStrictMode)
		: undefined;
	// 条件展开：仅在有值时写入对应字段，避免下发空对象覆盖 SDK 默认行为；
	// 系统提示先清洗孤立 UTF-16 代理对，防止序列化失败
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
		...(context.tools &&
			context.tools.length > 0 && {
				tools: convertTools(context.tools, false, supportsStrictMode),
			}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	// ========== 思考配置 ==========
	// 开启思考：includeThoughts 让思考内容以 thought 片段回流；
	// level（Gemini 3 / Gemma 4 档位）与 budgetTokens（Gemini 2.x 预算）二选一
	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			// 本地 GoogleApiThinkingLevel 与 Google 的 ThinkingLevel 枚举取值一致，as any 直接透传
			thinkingConfig.thinkingLevel = options.thinking.level as any;
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		// 显式关闭思考：不同家族的关闭方式不同（见 getDisabledThinkingConfig）
		config.thinkingConfig = getDisabledThinkingConfig(model);
	}

	// ========== 中止信号 ==========
	// 已中止的请求直接抛错；否则挂到 config 上交由 SDK 在传输层生效
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
 * 判断是否为 Gemma 4 系模型。
 *
 * @param model - 目标模型
 * @returns 模型 id 匹配 gemma-4 / gemma4 时返回 true
 */
function isGemma4Model(model: Model<"google-generative-ai">): boolean {
	return /gemma-?4/.test(model.id.toLowerCase());
}

/**
 * 判断是否为 Gemini 3 Pro 系模型（含 3.x 次版本号）。
 *
 * @param model - 目标模型
 * @returns 模型 id 匹配 gemini-3-pro / gemini-3.x-pro 时返回 true
 */
function isGemini3ProModel(model: Model<"google-generative-ai">): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(model.id.toLowerCase());
}

/**
 * 判断是否为 Gemini 3 Flash 系模型。
 *
 * 除 gemini-3[-x.x]-flash 外，gemini-flash-latest / gemini-flash-lite-latest
 * 两个滚动别名当前也指向 Gemini 3 Flash 系，故一并匹配。
 *
 * @param model - 目标模型
 * @returns 命中上述任一形态时返回 true
 */
function isGemini3FlashModel(model: Model<"google-generative-ai">): boolean {
	const id = model.id.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

/**
 * 构造「关闭思考」的 ThinkingConfig。
 *
 * @param model - 目标模型
 * @returns 与模型家族匹配的关闭配置；无法彻底关闭的模型降级为最低思考档位
 */
function getDisabledThinkingConfig(model: Model<"google-generative-ai">): ThinkingConfig {
	// Google 官方文档：Gemini 3.1 Pro 无法关闭思考，Gemini 3 Flash / Flash-Lite
	// 也不支持完全关闭。对 Gemini 3 系模型，改用其支持的最低 thinkingLevel 且不带
	// includeThoughts——隐藏思考仍在进行，但不产生思考块、对 pi 不可见。
	// 各家族可用的最低档位：Pro 只能到 LOW，Flash / Gemma 4 可以到 MINIMAL
	if (isGemini3ProModel(model)) {
		return { thinkingLevel: "LOW" as any };
	}
	if (isGemini3FlashModel(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}
	if (isGemma4Model(model)) {
		return { thinkingLevel: "MINIMAL" as any };
	}

	// Gemini 2.x 支持通过 thinkingBudget = 0 彻底关闭思考
	return { thinkingBudget: 0 };
}

/**
 * 把解析后的标准思考档位映射为具体模型可用的 Google ThinkingLevel 枚举值。
 *
 * 不同家族支持的档位集合不同，需逐家族收敛：
 * - Gemini 3 Pro：仅有 LOW / HIGH 两档，低两档归 LOW、高两档归 HIGH；
 * - Gemma 4：仅有 MINIMAL / HIGH 两档，映射同理；
 * - 其余模型：四档原生可用，一一对应。
 *
 * @param effort - 已解析的标准思考档位（minimal / low / medium / high）
 * @param model - 目标模型
 * @returns 该模型可用的 ThinkingLevel 枚举值
 */
function getThinkingLevel(
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
	if (isGemma4Model(model)) {
		switch (effort) {
			case "minimal":
			case "low":
				return "MINIMAL";
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
 * 解析 Gemini 2.x 系模型的思考 token 预算（thinkingBudget）。
 *
 * @param model - 目标模型
 * @param level - 已解析的标准思考档位
 * @param customBudgets - 模型自定义的「档位 -> 预算」覆盖表（优先级最高）
 * @returns 对应档位的 token 预算；无匹配时返回 -1 表示动态预算（思考量交由服务端决定）
 */
function getGoogleBudget(
	model: Model<"google-generative-ai">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	// 自定义预算表优先，允许逐模型覆盖默认档位
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level]!;
	}

	// ========== 各 Gemini 2.5 变体的默认预算表（经验值） ==========
	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
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

	// 未知的 Gemini 2.x 变体：-1 表示动态预算，思考量交由服务端决定
	return -1;
}
