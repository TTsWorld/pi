/**
 * @file Google 系 API 共享工具（Gemini / Vertex / Cloud Code Assist）
 * @description 被 google-generative-ai.ts（AI Studio）与 google-vertex.ts（Vertex AI）
 *              两个 provider 实现共享的公共逻辑：
 *              - thinking level 归一化（pi 档位 → Google 档位，含 per-model 映射）
 *              - 思考签名（thoughtSignature）的判定 / 保留 / 合法性校验
 *              - Context → Gemini Content[] 消息转换、Tool → functionDeclarations 转换
 *              - toolChoice → FunctionCallingConfigMode 映射与严格采样模式判定
 *              - FinishReason → StopReason 映射、统一的重试包装
 */

import { type Content, FinishReason, FunctionCallingConfigMode, type Part } from "@google/genai";
import type {
	Context,
	ImageContent,
	Model,
	ModelThinkingLevel,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingLevel,
	Tool,
} from "../types.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

// Google 系 provider 的类型标识：AI Studio（google-generative-ai）或 Vertex AI（google-vertex）
type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Gemini 3 模型的思考档位。
 * 与 Google 官方 ThinkingLevel 枚举值一一对应。
 */
export type GoogleApiThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

// 解析后的档位类型：排除 pi 侧的 "xhigh"/"max"（Google 没有对应的更高档位）
export type ResolvedGoogleThinkingLevel = Exclude<ThinkingLevel, "xhigh" | "max">;

/**
 * 把 pi 的思考档位解析为 Google 标准档位。
 *
 * 解析顺序：先查模型自定义映射（thinkingLevelMap），没有映射时直接使用 pi 档位；
 * 两种来源都要求最终落在 minimal/low/medium/high 四档之一。
 *
 * @param model 目标模型（可能带 thinkingLevelMap 自定义档位映射）
 * @param level pi 侧的思考档位
 * @returns Google 标准思考档位
 * @throws 模型的 thinkingLevelMap 映射出了四档之外的非法值时抛错
 */
export function resolveGoogleThinkingLevel<T extends GoogleApiType>(
	model: Model<T>,
	level: ModelThinkingLevel,
): ResolvedGoogleThinkingLevel {
	// pi 的 "off" 无法在 Google 侧真正关闭思考，统一升到 high 档
	if (level === "off") return "high";

	// 优先取模型专属映射（字符串、大小写不敏感）；无映射时沿用 pi 档位本身
	const mapped = model.thinkingLevelMap?.[level];
	const resolvedLevel = typeof mapped === "string" ? mapped.toLowerCase() : level;
	switch (resolvedLevel) {
		case "minimal":
		case "low":
		case "medium":
		case "high":
			return resolvedLevel;
		default:
			throw new Error(
				`Unsupported Google thinking level mapping for ${model.provider}/${model.id}: ${level} -> ${String(mapped)}`,
			);
	}
}

/**
 * 判断流式返回的 Gemini `Part` 是否应被当作「思考」内容。
 *
 * 协议要点（Gemini / Vertex AI 的 thought signatures）：
 * - `thought: true` 是思考内容（thought summaries）的判定标志，以此为准；
 * - `thoughtSignature` 是模型内部思考过程的加密表示，用于在多轮交互间保持推理上下文；
 * - `thoughtSignature` 可能出现在任意 part 类型上（text、functionCall 等）——
 *   它的存在并不代表该 part 本身就是思考内容；
 * - 对于非 functionCall 的响应，签名会挂在最后一个 part 上以便回放上下文；
 * - 持久化/回放模型输出时，带签名的 part 必须原样保留，不要跨 part 合并或移动签名。
 *
 * 参见：https://ai.google.dev/gemini-api/docs/thought-signatures
 *
 * @param part Gemini Part（只关心 thought / thoughtSignature 两个字段）
 * @returns 该 part 是否为思考内容
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * 流式过程中保留思考签名。
 *
 * 某些后端只在一个 part/块的第一个 delta 上携带 `thoughtSignature`，后续 delta 会省略它。
 * 该辅助函数为当前块保留最后一个非空签名，避免签名被 undefined 覆盖丢失。
 *
 * 注意：它不会跨不同响应 part 合并或移动签名，只在同一个流式块内防止签名丢失。
 *
 * @param existing 当前已保留的签名
 * @param incoming 本个 delta 到达的签名
 * @returns 应当继续保留的签名
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Google API 的思考签名必须是 base64（proto TYPE_BYTES），以下正则据此校验
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 校验思考签名是否为合法 base64：非空、长度为 4 的倍数、只含 base64 字符。
 *
 * @param signature 待校验的签名
 * @returns 是否合法
 */
function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * 只保留「同 provider + 同模型」且 base64 合法的签名，其余一律丢弃。
 *
 * Why：思考签名是模型特定的加密负载，换模型/换 provider 后回传不仅无效，
 * 还可能被 API 校验拒绝，因此跨模型时直接剥掉。
 *
 * @param isSameProviderAndModel 消息是否来自当前 provider 且同一模型
 * @param signature 待裁决的签名
 * @returns 可保留的签名；不满足条件时为 undefined
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * 判断经由 Google API 调用的模型是否要求在 function call / response 中显式携带工具调用 ID。
 *
 * 覆盖三类模型：Claude 系（Cloud Code Assist 代理）、gpt-oss 系、Gemini 3 及以上。
 *
 * @param modelId 模型 ID
 * @returns 是否要求显式 ID
 */
export function requiresToolCallId(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(geminiMajorVersion !== undefined && geminiMajorVersion >= 3)
	);
}

/**
 * 从模型 ID 解析 Gemini 主版本号。
 *
 * @param modelId 模型 ID（兼容 gemini- 与 gemini-live- 两种前缀，大小写不敏感）
 * @returns 主版本号；不是 Gemini 命名的模型返回 undefined
 */
function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

/**
 * 判断模型是否支持多模态 function response（图片直接嵌在 functionResponse.parts 里）。
 *
 * 规则：Gemini 按主版本判断（3+ 支持，< 3 不支持）；非 Gemini 模型
 * （如经 Cloud Code Assist 代理的 Claude）默认按支持处理。
 *
 * @param modelId 模型 ID
 * @returns 是否支持
 */
function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * 将内部消息（Context.messages）转换为 Gemini 协议的 Content[] 格式。
 *
 * 总体流程：先经 transformMessages 做跨 provider 的兼容性改写，再逐条把
 * user / assistant / toolResult 消息映射为 Gemini 的 user / model 角色与 parts。
 *
 * @param model 目标模型（决定 ID 归一化、签名保留、多模态能力等分支）
 * @param context 会话上下文
 * @returns Gemini API 的 contents 数组
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	// 工具调用 ID 归一化：要求显式 ID 的模型会把非法字符替换为 "_" 并截断到 64 字符
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	// 跨 provider 消息改写（图片降级、孤儿工具调用补结果、签名剥离等），再进入协议映射
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		// ========== user 消息：纯字符串或 text/image 块 → parts ==========
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				// 文本块 → { text }，图片块 → { inlineData }
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				// 内容块数组为空时不产出消息
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			// ========== assistant 消息：text / thinking / toolCall 块 → model parts ==========
			const parts: Part[] = [];
			// 判断消息是否来自同一 provider 且同一模型——只有此时才保留 thinking 块与思考签名
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					// 跳过空文本块——除非它带着思考签名。Gemini 可能把签名挂在可见文本为空的
					// part 上并要求原样回传；丢掉它会破坏推理链，模型会偶发地以「只有思考的
					// STOP」结束中途回合（空补全、没有工具调用）。
					if ((!block.text || block.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// 仅当同 provider 且同模型才作为 thinking 块保留；
					// 否则转为纯文本（不加 <thinking> 之类的标签，避免模型模仿标签语法）
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						// 与文本块同样的规则：空 thinking 块只在不带签名时才丢弃
						// （与 anthropic 转换器的处理保持一致）。
						if ((!block.thinking || block.thinking.trim() === "") && !thoughtSignature) continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						// 跨 provider/模型：签名不可用，空块同样保持丢弃
						if (!block.thinking || block.thinking.trim() === "") continue;
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					// 工具调用块：签名挂在 part 一级（而非 functionCall 内部），需要时携带显式 id
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			// 所有块都被过滤掉时不产出消息
			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// ========== toolResult 消息：文本/图片 → user 角色的 functionResponse ==========
			// 提取文本与图片内容
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			// 模型不支持图片输入时不带图片（transformMessages 已保证非视觉模型没有图片块，这里再兜底）
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ 支持多模态 function response：图片直接嵌在 functionResponse.parts 里。
			// Claude 等经 Cloud Code Assist 代理的非 Gemini 模型按支持处理；
			// Gemini < 3 仍需要把图片放到单独的 user 消息中。
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// 按 SDK 文档约定：成功用 "output" 键，出错用 "error" 键；
			// 只有图片没有文本时用占位文案提示模型看附件
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API 要求所有 function response 合并在同一个 user 回合里。
			// 检查最后一条 content 是否已是带 functionResponse 的 user 消息，是则直接追加合并。
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// Gemini < 3：图片放进单独的 user 消息（附带说明文本）
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

// 需要从 schema 中剔除的 JSON Schema 元声明键（OpenAPI 3.03 Schema 不认识这些 $ 系列关键字）
const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	// "definitions" 是 2019-09 之前草案里 $defs 的等价物
	"definitions",
]);

/**
 * 递归剔除 schema 对象中的元声明键（如 $schema、$defs 等）。
 *
 * Why：走 legacy `parameters` 字段时，schema 必须符合 OpenAPI 3.03 Schema，
 * 不允许携带 JSON Schema 的 $ 系列关键字。
 *
 * @param schema 待清洗的 schema（非纯对象类型原样返回）
 * @returns 清洗后的新对象（不修改入参）
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * 把内部 Tool[] 转换为 Gemini 的 functionDeclarations 工具格式。
 *
 * 默认使用 `parametersJsonSchema`，它支持完整 JSON Schema（anyOf、oneOf、const 等）。
 * 置 `useParameters` 为 true 时改用 legacy 的 `parameters` 字段（OpenAPI 3.03 Schema）——
 * 经 Cloud Code Assist 调用 Claude 模型时需要它，API 会把 `parameters` 翻译成
 * Anthropic 的 `input_schema`。
 *
 * @param tools 内部工具列表
 * @param useParameters 是否使用 legacy parameters 字段（默认 false）
 * @param supportsStrictMode 当前通道是否支持严格采样模式（默认 true）
 * @returns Gemini tools 数组；tools 为空时返回 undefined
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
	supportsStrictMode = true,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => {
				// 先决定该工具是否走严格采样，再据此生成参数 schema
				const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
				const parameters = getJsonSchemaToolParameters(tool, strict);
				return {
					name: tool.name,
					description: tool.description,
					// legacy parameters 需要先剔除 OpenAPI 不认识的 $ 系列元声明
					...(useParameters
						? { parameters: sanitizeForOpenApi(parameters as unknown) }
						: { parametersJsonSchema: parameters }),
				};
			}),
		},
	];
}

/**
 * 判断模型是否支持严格工具采样。
 * Gemini 3+ 在校验式工具调用模式（VALIDATED）下会强制校验 required 函数参数。
 *
 * @param modelId 模型 ID
 * @returns 是否支持
 */
export function supportsGoogleStrictToolSampling(modelId: string): boolean {
	const majorVersion = getGeminiMajorVersion(modelId);
	return majorVersion !== undefined && majorVersion >= 3;
}

/**
 * 把工具选择字符串映射为 Gemini 的 FunctionCallingConfigMode。
 *
 * @param choice 工具选择（auto / none / any）
 * @returns 对应的 FunctionCallingConfigMode（未知值回落到 AUTO）
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * 决定最终的 function calling 配置模式。
 *
 * 优先级：显式 toolChoice 为 none/any 时直接生效；否则任一工具要求严格采样时
 * 使用 VALIDATED；再否则按 toolChoice 映射；既无 toolChoice 又不需要严格模式时
 * 返回 undefined（不设置该配置，交由 API 默认行为）。
 *
 * @param tools 工具列表（用于判断是否要求严格采样）
 * @param toolChoice 调用方指定的工具选择
 * @param supportsStrictMode 当前通道是否支持严格模式
 * @returns FunctionCallingConfigMode 或 undefined
 */
export function resolveGoogleFunctionCallingMode(
	tools: Tool[],
	toolChoice: string | undefined,
	supportsStrictMode: boolean,
): FunctionCallingConfigMode | undefined {
	// 任一工具声明了严格采样，即认为整体要走严格模式
	const useStrictMode = tools.some((tool) => resolveJsonSchemaStrictSampling(tool, supportsStrictMode) === true);
	if (toolChoice === "none" || toolChoice === "any") {
		return mapToolChoice(toolChoice);
	}
	if (useStrictMode) {
		return FunctionCallingConfigMode.VALIDATED;
	}
	return toolChoice ? mapToolChoice(toolChoice) : undefined;
}

/**
 * 把 Gemini 的 FinishReason 枚举映射为内部的 StopReason。
 *
 * @param reason Gemini 的结束原因
 * @returns 内部 StopReason（stop / length / error）
 * @throws 出现未处理的枚举值时抛错（借助 never 穷举检查兜底）
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		// 各类异常结束原因统一归为 error：安全拦截（SAFETY/BLOCKLIST/SPII 等）、
		// 违禁内容、复述检测、图片生成失败、畸形/意外的工具调用、其他未指明原因
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			// 穷举兜底：SDK 新增枚举时编译期报 never 类型错误，运行期抛错暴露
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * 把字符串形式的结束原因映射为内部 StopReason（用于未经 SDK 枚举化的原始 API 响应）。
 *
 * @param reason 字符串形式的结束原因
 * @returns 内部 StopReason（未知值统一归为 error）
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * 用共享的 provider 重试策略包装一次 Google GenAI SDK 请求
 * （408/409/429/5xx 按退避重试，尊重 retry-after），与 Anthropic / OpenAI
 * 适配器用 retryProviderRequest 包装首个请求的做法保持一致。
 *
 * Why 补 headers：SDK 的 ApiError 有 `status` 属性但没有 `headers` 属性，而
 * retryProviderRequest 只重试同时携带两者的错误，所以这里在重抛前给错误对象
 * 补上缺失的 `headers`，使其能够进入重试判定。
 *
 * @param request 实际发起请求的函数
 * @param options 重试选项（最大重试次数 / 最大重试延迟 / 取消信号）
 * @returns 请求结果（可能经过多次重试）
 */
export function retryGoogleRequest<T>(
	request: () => Promise<T>,
	options?: Pick<StreamOptions, "maxRetries" | "maxRetryDelayMs" | "signal">,
): Promise<T> {
	return retryProviderRequest(
		async () => {
			try {
				return await request();
			} catch (error) {
				// 给只有 status、没有 headers 的 SDK 错误补一个值为 undefined 的 headers
				// 字段，让 retryProviderRequest 的判定（要求两个属性都存在）放行重试
				if (error instanceof Error && "status" in error && !("headers" in error)) {
					(error as { headers?: Headers }).headers = undefined;
				}
				throw error;
			}
		},
		{
			maxRetries: options?.maxRetries,
			maxRetryDelayMs: options?.maxRetryDelayMs,
			signal: options?.signal,
		},
	);
}
