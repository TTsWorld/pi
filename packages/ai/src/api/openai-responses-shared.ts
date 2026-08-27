/**
 * @file OpenAI Responses 家族共享逻辑（消息/工具转换 + SSE 流解析）
 * @description 被 openai-responses.ts、azure-openai-responses.ts、openai-codex-responses.ts
 *              三个实现复用的核心层，职责分三块：
 *              1. convertResponsesMessages：把统一 Context（消息历史）转换为 Responses API
 *                 的 input 数组——含 reasoning 加密内容（encrypted_content）回放、文本块
 *                 签名（msg id + phase）、跨模型工具调用 ID 归一化、文法（grammar）工具
 *                 的 custom_tool_call 占位、以及 deferred 工具的历史回放注入；
 *              2. convertResponsesTools：把统一 Tool 转换为 Responses 工具定义
 *                 （function / custom 两种形态，处理 strict 模式与 defer_loading）；
 *              3. processResponsesStream：消费 response.* SSE 事件流，驱动「输出条目 →
 *                 内容块」的分块状态机，产出标准 AssistantMessageEvent（thinking/text/
 *                 toolcall 的 start/delta/end），并在终止事件里结算 usage 计费与 stopReason。
 *
 * 依赖关系：
 * - openai SDK 的 Responses 类型（ResponseInput / ResponseStreamEvent 等）
 * - ./constrained-sampling.ts（文法约束采样、JSON Schema strict 处理、输入流缓冲）
 * - ./transform-messages.ts（跨 provider 消息改写，含工具调用 ID 归一化钩子）
 * - ../utils/*（流式 JSON 增量解析、lone surrogate 清理、短哈希、事件流）
 */

import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// 工具函数（签名编解码、工具结果输出转换）
// =============================================================================

/**
 * 把消息条目 id（及可选 phase）编码为 TextSignatureV1 JSON 字符串，作为文本块的
 * textSignature 存储。回放历史时需要原样带回该 id，否则 Responses API 会校验失败。
 *
 * @param id Responses 消息条目的 id（msg_xxx）
 * @param phase 产生该文本的阶段："commentary"（过程性说明）或 "final_answer"（最终回答）
 * @returns 序列化后的签名字符串
 */
function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

/**
 * 解析文本块签名：新版为 TextSignatureV1 JSON（以 "{" 开头，可携带 phase），
 * 旧版为裸 id 字符串。JSON 解析失败或版本不符时按旧版裸字符串处理，
 * 保证旧会话文件（历史遗留签名）也能回放。
 *
 * @param signature 签名原始字符串（可能为 undefined）
 * @returns 解析出的 { id, phase }；无签名时返回 undefined
 */
function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// 解析失败则落入下方旧版裸字符串处理。
		}
	}
	return { id: signature };
}

/** 工具结果输出内容：纯文本，或「文本 + 图片」混合数组（Responses 多模态 output 格式） */
type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

/**
 * 把统一的工具结果内容转换为 Responses 的 function_call_output 输出格式。
 * 模型不支持图片输入、或结果里没有图片时退化为纯字符串（空结果用占位文案）；
 * 有图片时组装 input_text + input_image 数组，图片转 base64 data URL 内联。
 * 文本一律做 lone surrogate 清理（避免无效 UTF-16 导致请求被拒）。
 *
 * @param model 目标模型（用于判断是否支持图片输入）
 * @param content 统一格式的工具结果内容块
 * @returns Responses 接受的 output：字符串或多模态内容数组
 */
function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = content.filter((c): c is ImageContent => c.type === "image");
	const hasText = textResult.length > 0;

	// 无图片或模型不支持图片输入：退化为纯字符串（有图但发不了时用占位文案提示）
	if (images.length === 0 || !model.input.includes("image")) {
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	const output: ToolResultOutputContent = [];
	if (hasText) {
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return output;
}

/**
 * 流解析（processResponsesStream）的可选配置，各实现按自身能力差异注入。
 */
export interface OpenAIResponsesStreamOptions {
	/** 请求时指定的 service_tier（flex/priority 等）；响应未回报层级时作为计费兜底 */
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	/** 工具名 → 文法输入属性名 的映射；命中的工具调用按 custom_tool_call 流式处理 */
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/**
	 * 解析「生效的 service_tier」：合并响应实际层级与请求层级。
	 * 某些网关（如 Azure/OpenRouter 兼容层）回报口径与请求不一致，需要自定义合并规则。
	 */
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	/** 按生效 service_tier 调整 usage 成本（flex 半价 / priority 加价等倍率口径） */
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

/**
 * 消息转换（convertResponsesMessages）的可选配置，各实现按自身能力差异注入。
 */
export interface ConvertResponsesMessagesOptions {
	/** 是否把 context.systemPrompt 转成消息（默认 true；Codex 走 instructions 字段故关闭） */
	includeSystemPrompt?: boolean;
	/** 工具名 → 文法输入属性名 的映射；命中的历史工具调用回放为 custom_tool_call */
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/** deferred 工具全集（工具名 → Tool），用于把 addedToolNames 回放成「工具加载」条目 */
	deferredTools?: ReadonlyMap<string, Tool>;
	/** deferred 工具回放模式：additional_tools 消息，或 tool_search_call + tool_search_output 对 */
	deferredToolsMode?: "additional-tools" | "tool-search";
	/** 透传给 convertResponsesTools 的工具转换选项 */
	toolOptions?: ConvertResponsesToolsOptions;
}

/**
 * 工具转换（convertResponsesTools）的可选配置。
 */
export interface ConvertResponsesToolsOptions {
	/** 默认 strict 取值（未指定时默认 false） */
	strict?: boolean | null;
	/** 模型是否支持 strict 模式（默认 true；不支持时省略 strict 字段） */
	supportsStrictMode?: boolean;
	/** 是否支持 OpenAI 原生文法（grammar）工具（默认 false；支持时命中文法的工具转 custom 形态） */
	supportsOpenAIGrammarTools?: boolean;
	/** 是否给工具打 defer_loading 标记（tool-search 输出中加载的工具使用） */
	deferLoading?: boolean;
}

// =============================================================================
// 消息转换：统一 Context → Responses input 数组
// =============================================================================

/**
 * 把统一 Context 的消息历史转换为 OpenAI Responses API 的 input 数组（消息转换主入口）。
 *
 * 整体流程：先经 transformMessages 做跨模型/跨 provider 改写（含工具调用 ID 归一化钩子），
 * 再按角色逐条展开：systemPrompt → developer/system 消息；user → input_text/input_image；
 * assistant → 逐内容块回放（thinking 签名原样还原、text 带签名、toolCall 按
 * function_call / custom_tool_call 二选一）；toolResult → function_call_output /
 * custom_tool_call_output，并按 addedToolNames 追加 deferred 工具加载条目。
 *
 * @param model 目标模型（决定角色选择、图片支持、同/跨模型判定）
 * @param context 统一的请求上下文（systemPrompt + 消息历史）
 * @param allowedToolCallProviders 允许「工具名直传」语义的 provider 集合；目标 provider
 *   不在集合内时，工具调用 ID 整体做脱敏归一化（跨协议搬运场景）
 * @param options 转换配置（系统提示开关、文法属性映射、deferred 工具等）
 * @returns Responses API 的 input 数组（消息与输出条目的扁平列表）
 */
export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	// 已回放过的 deferred 工具名集合：同一工具在多条工具结果里重复 added 时只注入一次
	const loadedToolNames = new Set<string>();

	/**
	 * 归一化 ID 片段：特殊字符替换为下划线、截断到 64 字符、去掉尾部连续下划线
	 * （截断可能恰好落在下划线上，去掉以免浪费长度）。
	 */
	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	/**
	 * 为「外来」工具调用的 item id 构造合法的 fc_ 前缀 ID：取短哈希避免超长
	 * （其他协议的 item id 不符合 Responses 的 fc_ 命名约束）。
	 */
	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	/**
	 * 工具调用 ID 归一化钩子（transformMessages 在跨模型改写时调用）。
	 * 统一 ID 形如 "call_id|item_id"：call_id 用于与工具结果配对，item_id 是
	 * Responses 输出条目 id（回放必需）。仅当目标 provider 允许直传时才保留
	 * 双段结构，并确保 item_id 以 fc_ 开头；否则整体脱敏为单段。
	 */
	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API 要求 item id 以 "fc" 开头
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	// ========== 系统提示：推理模型且未显式禁用时用 developer 角色（优先级高于 system） ==========
	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	// ========== 按角色展开历史消息 ==========
	let msgIndex = 0;
	for (const msg of transformedMessages) {
		// ---- 用户消息：字符串或内容块数组，统一转 input_text / input_image ----
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				// 空内容数组（如图片被 transformMessages 降级后删除殆尽）不产生消息
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			// ---- 助手消息：逐内容块回放为 Responses 输出条目 ----
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			// 同 provider+api 才有「同模型/跨模型」的区分意义（跨 provider 的签名已被
			// transformMessages 剥掉，这里只处理纯内容）
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				// ---- thinking 块：签名里存的是完整 ResponseReasoningItem（含加密推理内容），原样回放 ----
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					// ---- 文本块：回放为 message 条目，签名携带原 msg id 与 phase ----
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI 要求 id 最长 64 字符
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					// ---- 工具调用块：按是否文法工具回放为 custom_tool_call 或 function_call ----
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					let itemId: string | undefined = itemIdRaw;

					// 跨模型消息把 id 置为 undefined 以绕过配对校验：OpenAI 会记录哪些 fc_xxx ID
					// 与 rs_xxx reasoning 条目配对过；省略 id 即可避开该校验（与跨 provider 的做法一致）。
					// 把 custom 工具调用改按 function_call 回放时，同样要丢弃非 fc_* 的 id（如
					// custom_tool_call 的 ctc_* id），因为 function_call 条目 id 必须是 fc_*。
					if (
						(isDifferentModel && itemId?.startsWith("fc_")) ||
						(customInputProperty === undefined && !itemId?.startsWith("fc_"))
					) {
						itemId = undefined;
					}

					// namespace 仅在同模型回放（或该工具属于 deferred 工具）时携带：
					// 这是 provider 专属扩展字段，跨模型回放可能不被对端识别
					const canReplayNamespace = isSameModel || options?.deferredTools?.has(toolCall.name) === true;

					// 文法工具：回放为 custom_tool_call，input 取文法输入属性（如 "input"）的字符串值
					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
						} satisfies ResponseOutputItem);
					} else {
						// 普通工具：回放为 function_call，参数对象序列化为 JSON 字符串
						output.push({
							type: "function_call",
							id: itemId,
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
						});
					}
				}
			}
			// 无任何可回放内容块（如空 assistant 消息）时跳过，不产生条目
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			// ---- 工具结果消息：与调用形态一一对应（custom ↔ custom、function ↔ function） ----
			const [callId] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);

			if (options?.grammarToolInputProperties?.has(msg.toolName)) {
				messages.push({
					type: "custom_tool_call_output",
					call_id: callId,
					output,
				});
			} else {
				messages.push({
					type: "function_call_output",
					call_id: callId,
					output,
				});
			}

			// ========== deferred 工具回放：把本条结果 addedToolNames 中新出现的工具注入历史 ==========
			// 让「会话中途加载的工具」在重放时也出现在对应时间点；已加载过的工具跳过
			const deferredTools: Tool[] = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			// 模式一：additional_tools 消息（开发者角色的工具追加声明）
			if (deferredTools.length > 0 && options?.deferredToolsMode === "additional-tools") {
				messages.push({
					type: "additional_tools",
					role: "developer",
					tools: convertResponsesTools(deferredTools, options.toolOptions),
				} satisfies ResponseInputItem);
			} else if (deferredTools.length > 0 && options?.deferredToolsMode === "tool-search") {
				// 模式二：tool_search 调用 + 输出对（模拟客户端执行的工具检索加载）；
				// call_id 由「工具结果 ID + 工具名列表」哈希而来，保证重放间稳定
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: { query: names.join(" "), limit: names.length },
				} satisfies ResponseInputItem);
				// 输出条目里的工具带 defer_loading 标记（区别于请求级立即加载的工具）
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(deferredTools, {
						...options.toolOptions,
						deferLoading: true,
					}),
				} satisfies ResponseToolSearchOutputItemParam);
			}
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// 工具转换：统一 Tool → Responses 工具定义
// =============================================================================

/**
 * 把统一 Tool 列表转换为 Responses API 的工具定义数组。
 * 命中文法约束采样的工具转 custom 形态（grammar 约束直出非 JSON 文本）；
 * 其余转 function 形态，strict 取「工具级约束判定结果 ?? 调用方默认值」，
 * 且仅在模型支持 strict 模式时才写入该字段。
 *
 * @param tools 统一格式的工具列表
 * @param options 转换配置（strict 默认值、能力开关、defer_loading）
 * @returns Responses API 的 tools 参数
 */
export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	return tools.map((tool) => {
		// 文法工具：转 custom 形态，由服务端按文法（lark/regex）约束采样
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.deferLoading ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}

		// 普通工具：先按 JSON Schema 兼容性判定工具级 strict，未判定时回落到默认值
		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool: Omit<Extract<OpenAITool, { type: "function" }>, "strict"> & {
			strict?: Extract<OpenAITool, { type: "function" }>["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as Record<string, unknown>,
			...(options?.deferLoading ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = strict;
		}
		return functionTool as OpenAITool;
	});
}

// =============================================================================
// 流处理：response.* SSE 事件 → 标准 AssistantMessageEvent
// =============================================================================

/**
 * 流式工具调用块：在统一 ToolCall 之上附加两个临时缓冲（结束后都会删除）：
 * - partialJson：function_call 的原始 JSON 参数流（增量拼接 + 部分解析）
 * - customInput：custom_tool_call（文法工具）的输入缓冲（单调追加，close 后封口）
 */
type StreamingToolCall = ToolCall & {
	partialJson?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

/**
 * 读取 custom 工具调用当前已累积的输入文本（从 arguments 里的文法输入属性取）。
 */
function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}

/**
 * 追加 custom 工具调用的输入文本并产出 JSON 参数流的 delta。
 * 内部经 appendGrammarToolInputJsonDelta 把「裸文本增量」翻译为带 JSON 转义的
 * 参数增量（首块带 {"属性名":" 前缀、close 时补 "} 收尾），同时把最新全文写回
 * arguments，保证流结束后 arguments 即为完整参数对象。
 *
 * @param block 流式工具调用块
 * @param nextInput 追加后的完整输入文本（非增量）
 * @param close 是否为最后一块（封口）
 * @returns 可下发的参数 delta；无新增内容且未封口时返回 undefined
 */
function appendCustomToolCallInput(block: StreamingToolCall, nextInput: string, close: boolean): string | undefined {
	const customInput = block.customInput;
	if (!customInput) return undefined;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	return delta;
}

/**
 * 输出条目槽位：Responses 的 output_index（响应内条目序号）到统一消息内容块的映射。
 * 三种形态分别对应 thinking / text / toolCall 内容块，contentIndex 记录块在
 * output.content 中的位置（事件里没有这个信息，创建槽位时记下）。
 */
type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

/** 工具调用形态的槽位（ResponsesOutputSlot 的 toolCall 分支） */
type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

/**
 * 消费 Responses API 的 SSE 事件流，解析为标准 AssistantMessageEvent 写入 stream，
 * 并把最终内容、签名、usage 与 stopReason 汇总到 output（原地修改）。
 *
 * 核心是「分块状态机」：Responses 用 output_index 标识响应内的输出条目
 * （reasoning / message / function_call / custom_tool_call），本函数为每个条目
 * 创建一个槽位（对应 output.content 里的一个内容块），后续 delta 事件按
 * output_index 找回槽位做增量累积；条目 done 时收尾、落签名并移除槽位。
 * 流必须以 response.completed / incomplete / failed 之一收尾，否则视为异常。
 *
 * @param openaiStream Responses 原始事件流（AsyncIterable）
 * @param output 待填充的助手消息（内容块、usage、stopReason 均原地写入）
 * @param stream 标准事件流（thinking/text/toolcall 的 start/delta/end 逐个推送）
 * @param model 目标模型（用于计费与能力判断）
 * @param options 流解析配置（service tier 计费、文法工具属性映射）
 * @returns 流消费完毕后 resolve；中途出错（error/failed 事件）直接抛异常
 */
export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	// 是否见过终止事件（completed/incomplete/failed），流结束前必须有，否则抛错
	let sawTerminalResponseEvent = false;
	// 分块状态机：output_index → 槽位（条目开始时创建，条目 done 后删除）
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	// reasoning 条目 id → thinking 块：终止事件时用于回填加密推理内容（Azure 兼容）
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	/**
	 * 消息条目进入 final_answer 阶段时把 stopReason 定为 stop：
	 * 带 phase 的模型先产出 commentary，只有最终回答才算「正常说完」。
	 */
	const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
		if (item.type === "message" && item.phase === "final_answer") {
			output.stopReason = "stop";
		}
	};
	/**
	 * 按 output_index 取指定形态的槽位；形态不符（如事件乱序/重复）返回 undefined，
	 * 调用方以 continue 静默跳过。
	 */
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	/**
	 * 推送工具调用参数增量事件（delta 为 undefined 时无事可做）。
	 */
	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		if (delta === undefined) return;
		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output,
		});
	};
	/**
	 * 为输出条目创建槽位：在 output.content 追加对应内容块、登记槽位并推送
	 * 对应的 start 事件。不认识的条目类型（如 web_search 等内置工具）返回
	 * undefined，静默忽略。
	 */
	const createSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		// ---- reasoning 条目 → thinking 块（正文由后续 summary/text delta 填充） ----
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		// ---- message 条目 → text 块（output_index 层面可能有多条，如 commentary + final） ----
		if (item.type === "message") {
			applyMessagePhaseStopReason(item);
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		// ---- function_call 条目 → 工具调用块（id 保留 "call_id|item_id" 双段结构） ----
		if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		// ---- custom_tool_call 条目（文法工具）→ 工具调用块，参数挂在文法输入属性上 ----
		// 条目本身可能已带完整 input（如 done 事件补发），初值进 arguments；
		// jsonBuffer 从零开始以重放增量语义（后续 done 会整体封口）
		if (item.type === "custom_tool_call") {
			const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			const input = item.input || "";
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: { [inputProperty]: input },
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
				customInput: {
					property: inputProperty,
					jsonBuffer: { input: "", started: false, closed: false },
				},
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};
	/**
	 * 取槽位；不存在则按条目现场创建（output_item.done 可能先于任何 delta 到达）。
	 */
	const getOrCreateSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI 可能在 response.output_item.done 里省略 reasoning.encrypted_content，
	// 只在 response.completed.response.output 中给出。这里从终止响应回填已持久化的
	// reasoning 签名，保证 store:false 的多轮回放无需服务端存储也能无状态续接。
	// 见 https://github.com/earendil-works/pi/issues/6409。
	const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			// 已带加密内容的签名无需回填
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content,
			});
		}
	};
	/**
	 * 终止事件（completed/incomplete）收尾：回填 reasoning 签名、记录响应 id、
	 * 结算 usage 与成本（含 service tier 计费口径）、映射 stopReason。
	 */
	const finalizeResponse = (
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	): void => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(response.output ?? []);
		if (response?.id) {
			output.responseId = response.id;
		}
		// ========== usage 结算：OpenAI 把缓存读/写 token 都计入了 input_tokens，需扣除 ==========
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as
				| { cached_tokens?: number; cache_write_tokens?: number }
				| undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			output.usage = {
				// OpenAI 把缓存读与缓存写 token 都算进 input_tokens，这里两者都扣掉
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				output: response.usage.output_tokens || 0,
				cacheRead: cachedTokens,
				cacheWrite: cacheWriteTokens,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: response.usage.total_tokens || 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		calculateCost(model, output.usage);
		// service tier 计费：优先用调用方的合并规则解析生效层级（如 Azure 回报口径不同），
		// 否则「响应实际层级 ?? 请求层级」，再按倍率调整成本
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// ========== stopReason 映射 ==========
		// incomplete 时保留 provider 具体原因，让「截断（max_output_tokens）」与「内容过滤」可区分
		const status = response?.status;
		const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
		const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		const mappedStop = mapStopReason(status, incompleteReason);
		output.stopReason = mappedStop.stopReason;
		output.errorMessage = mappedStop.errorMessage;
		// 有工具调用且正常结束时，stopReason 细化为 toolUse（驱动 agent 循环继续执行工具）
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	// ========== 事件主循环：按事件类型驱动分块状态机 ==========
	for await (const event of openaiStream) {
		// 响应创建：先记下响应 id（终止事件里若带新 id 会覆盖）
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			// 输出条目开始：创建对应槽位并推送 start 事件
			createSlot(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			// 思维链摘要增量：累积到 thinking 块
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			// 摘要分段结束：补一个空行分隔多段摘要
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			// 原始思维链文本增量（非摘要形态）：同样累积到 thinking 块
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			// 正文文本增量：累积到 text 块
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			// 拒答文本增量：与正文同构处理（拒绝说明也是文本）
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			// 函数参数 JSON 增量：拼接原始流并做增量部分解析（不完整 JSON 也能解析出已闭合字段）
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			pushToolCallDelta(slot, event.delta);
		} else if (event.type === "response.function_call_arguments.done") {
			// 函数参数整段到达：以 done 的全文为准重新解析；仅当它是已累积内容的
			// 真超集时补发差量 delta（防止网关重发/压缩导致负增量）
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) pushToolCallDelta(slot, delta);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			// 文法工具输入增量：把裸文本增量经 JSON 缓冲翻译为参数 delta 后下发
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(
				slot,
				appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false),
			);
		} else if (event.type === "response.custom_tool_call_input.done") {
			// 文法工具输入整段到达：封口缓冲（补 "} 收尾）并下发最后的 delta
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || !slot.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
		} else if (event.type === "response.output_item.done") {
			// 输出条目结束：以条目终值为准收尾各内容块（终值优先于增量累积，
			// 可修正网关侧的增量偏差），落签名后移除槽位
			const item = event.item;
			applyMessagePhaseStopReason(item);
			const slot = getOrCreateSlot(event.output_index, item);

			// ---- reasoning 收尾：优先取摘要/原文终值，整个条目序列化为回放签名 ----
			// （thinkingSignature 存的就是 ResponseReasoningItem JSON，含加密推理内容，
			//  下轮回放时在 convertResponsesMessages 里原样推回）
			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				// ---- message 收尾：终值覆盖累积文本，签名携带 msg id 与 phase ----
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (
				item.type === "function_call" &&
				slot?.type === "toolCall" &&
				slot.block.partialJson !== undefined
			) {
				// ---- function_call 收尾：优先用条目参数，缺失时回落到已累积的流 ----
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				// 就地定稿并删掉临时缓冲，保证回放只携带解析后的参数对象
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
				// ---- custom_tool_call 收尾：封口输入缓冲（可能补发最后的差量），删临时缓冲 ----
				pushToolCallDelta(
					slot,
					appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true),
				);
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
				delete slot.block.customInput;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			// 终止事件：结算 usage、成本与 stopReason
			finalizeResponse(event.response);
		} else if (event.type === "error") {
			// 流内错误事件：直接转异常上抛
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			// 响应级失败：也算终止事件；记录原始状态后抛出带错误详情的异常
			sawTerminalResponseEvent = true;
			output.rawStopReason = event.response?.status;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	// 流意外中断（未见任何终止事件）：视为协议异常，避免静默产出半截消息
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

/**
 * 把 Responses 的响应状态映射为统一 StopReason。
 * incomplete 时结合具体原因：max_output_tokens 截断映射为 length；
 * 其余（内容过滤等）映射为 error 并携带可读的错误信息。
 *
 * @param status 响应状态（completed/incomplete/failed/cancelled/in_progress/queued）
 * @param incompleteReason incomplete_details 里的具体原因（可选）
 * @returns 统一 stopReason 及可选的 errorMessage
 */
function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			// 达到输出上限被截断 → length（调用方可据此提示续写）
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			// 其余未完成原因（如内容过滤）按错误处理并保留原因文本
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// 这两个状态有点怪（终止事件里不该出现），按正常结束处理
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			// 穷尽性检查：新增状态未处理时在编译期报错、运行期抛异常
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
