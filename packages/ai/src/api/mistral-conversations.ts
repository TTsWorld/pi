/**
 * @file Mistral Conversations API 流式适配（mistral-conversations 专有协议）
 * @description Mistral 是少数不走 OpenAI 兼容层的厂商：本文件直接请求 Mistral 原生
 *              /v1/chat/completions SSE 端点，完成三层适配：
 *              1. 请求组装：统一 Context → Mistral Chat 消息（system/user/assistant/tool）、
 *                 函数工具定义（JSON Schema + strict 采样）、推理参数
 *                 （prompt_mode / reasoning_effort 两代开关按模型区分）、
 *                 提示缓存（prompt_cache_key + x-affinity 会话亲和头）
 *              2. 流解析：手写 SSE 分帧读取器 → CompletionChunk 增量 → 标准
 *                 text/thinking/toolCall 内容块与 AssistantMessageEventStream 事件
 *              3. 计费与错误：usage（含缓存命中拆分）→ calculateCost 成本核算；
 *                 HTTP / 中断 / 协议异常统一格式化为可读错误消息
 *
 * 依赖关系：
 * - ../models.ts 的 calculateCost / clampThinkingLevel（计费、思考档位钳制）
 * - ./transform-messages.ts 的 transformMessages（跨模型消息改写 + 工具调用 ID 归一化）
 * - ../utils/json-parse.ts 的 parseStreamingJson（工具参数部分 JSON 增量解析）
 */
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

// Mistral 工具调用 ID 的目标长度：上游（如 OpenAI）的 450+ 字符特殊字符 ID 过不了
// 服务端校验，需折叠成短的纯字母数字 ID
const MISTRAL_TOOL_CALL_ID_LENGTH = 9;
// 错误响应体最多保留的字符数：防止超长 HTML/JSON 错误页撑爆 errorMessage
const MAX_MISTRAL_ERROR_BODY_CHARS = 4000;

/**
 * Mistral 专有的推理力度取值：目前仅「关闭（none）/ 高（high）」两档。
 */
type MistralReasoningEffort = "none" | "high";

/**
 * Mistral 专有流式选项：在通用 StreamOptions 之上扩展 Mistral 特有参数。
 */
export interface MistralOptions extends StreamOptions {
	// 工具选择策略：any/required 强制模型调用工具，对象形式指定必调的工具名
	toolChoice?: "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } };
	// 推理提示模式（对应请求体 prompt_mode=reasoning）：上一代推理模型的思考开关
	promptMode?: "reasoning";
	// 推理力度（对应请求体 reasoning_effort）：新一代推理模型的思考开关
	reasoningEffort?: MistralReasoningEffort;
}

/** 请求侧内容块：纯文本 / 图片（data URL）/ 思考内容（文本片段数组） */
type MistralContentChunk =
	| { type: "text"; text: string }
	| { type: "image_url"; imageUrl: string }
	| { type: "thinking"; thinking: Array<{ type: "text"; text: string }> };

/** 请求侧工具调用：arguments 为 JSON 字符串；index 供服务端对位流式增量 */
type MistralRequestToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
	index: number;
};

/** 请求侧消息：content 可为字符串或内容块数组；tool 消息另带 toolCallId 与工具名 */
type MistralChatMessage = {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | MistralContentChunk[];
	toolCalls?: MistralRequestToolCall[];
	toolCallId?: string;
	name?: string;
	// prefix=false 表示这是一条完整的助手消息（Mistral 的续写前缀标记）
	prefix?: boolean;
};

/** 请求侧函数工具：parameters 为 JSON Schema；strict 控制严格采样 */
type MistralFunctionTool = {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
		strict: boolean;
	};
};

/**
 * 请求负载（内部 camelCase 格式）：发送前由 toMistralWirePayload 统一转 snake_case；
 * 索引签名允许 onPayload 钩子注入任意自定义字段。
 */
type MistralChatPayload = {
	// 开放索引签名以容纳调用方通过 onPayload 注入的扩展字段
	[key: string]: unknown;
	model: string;
	stream: boolean;
	messages: MistralChatMessage[];
	tools?: MistralFunctionTool[];
	temperature?: number;
	maxTokens?: number;
	toolChoice?: Exclude<MistralOptions["toolChoice"], undefined>;
	promptMode?: "reasoning";
	reasoningEffort?: MistralReasoningEffort;
	promptCacheKey?: string;
};

/** 流式响应内容块增量：与请求侧结构对齐，thinking 仍是文本片段数组 */
type MistralStreamContentChunk = {
	type: string;
	text?: string;
	thinking?: Array<{ text?: string }>;
};

/** 流式工具调用增量：id/index 可缺省；arguments 可能是增量字符串也可能是已解析对象 */
type MistralStreamToolCall = {
	id?: string;
	index?: number;
	function: {
		name: string;
		arguments: string | Record<string, unknown>;
	};
};

/** 单条 SSE 事件解析结果（Mistral CompletionChunk）：delta 携带内容与工具调用增量 */
type MistralCompletionEvent = {
	data: {
		id?: string;
		usage?: {
			[key: string]: unknown;
			prompt_tokens?: number;
			completion_tokens?: number;
			total_tokens?: number;
		};
		choices: Array<{
			finish_reason?: string | null;
			delta: {
				content?: string | MistralStreamContentChunk[] | null;
				tool_calls?: MistralStreamToolCall[] | null;
			};
		}>;
	};
};

/**
 * 以流式方式请求 Mistral 原生 Chat Completions 端点，并把 SSE 增量翻译为标准事件流。
 * @param model 绑定 mistral-conversations 协议的模型描述
 * @param context 会话上下文（消息历史、工具、系统提示）
 * @param options Mistral 专有流式选项
 * @returns AssistantMessageEventStream 标准事件流（start / *_delta / done / error）
 */
export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: MistralOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// 请求与解析放在后台异步任务里执行，同步返回事件流，
	// 调用方无需 await 即可开始消费事件
	(async () => {
		// 助手消息骨架：usage/cost 预置为 0、stopReason 为 pending；
		// 后续所有事件里的 partial 都引用这一个可变对象，就地更新
		const output = createOutput(model);

		try {
			// ========== 前置校验与消息准备 ==========
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			// 工具调用 ID 归一化器：跨模型接力时把上游超长/特殊字符 ID
			// 折叠成 Mistral 可接受的短字母数字 ID
			const normalizeMistralToolCallId = createMistralToolCallIdNormalizer();
			const transformedMessages = transformMessages(context.messages, model, (id) => normalizeMistralToolCallId(id));

			// ========== 组装请求并发出 ==========
			let payload = buildChatPayload(model, context, transformedMessages, options);
			// onPayload 钩子：调用方可在发送前查看或整体替换负载（如注入自定义字段）
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload as MistralChatPayload;
			}
			const mistralStream = await requestMistralStream(model, payload, apiKey, options);
			stream.push({ type: "start", partial: output });
			await consumeChatStream(model, output, stream, mistralStream);

			// ========== 流结束后的完整性校验 ==========
			// 中断检查放在流消费之后：先让已收到的部分内容落进 output 再报 aborted
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// 正常情况下 Mistral 必发 finish_reason；仍是 pending 说明流被截断
			if (output.stopReason === "pending") {
				throw new Error("Mistral stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// ========== 错误收尾：清理现场并发出 error 事件 ==========
			for (const block of output.content) {
				// partialArgs 只是流式期间的临时缓冲，绝不能持久化到最终消息
				delete (block as { partialArgs?: string }).partialArgs;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatMistralError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 把厂商无关的 SimpleStreamOptions 映射为 Mistral 专有选项后转调 stream。
 * @param model 绑定 mistral-conversations 协议的模型描述
 * @param context 会话上下文（消息历史、工具、系统提示）
 * @param options 厂商无关的简化流式选项
 * @returns AssistantMessageEventStream 标准事件流
 */
export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	// 复用通用基础选项（apiKey/temperature/maxTokens/sessionId 等），再补 Mistral 的 toolChoice
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies MistralOptions;
	// 思考档位先钳制到模型声明的合法区间；off 表示完全关闭推理（不下发参数）
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoning = clampedReasoning === "off" ? undefined : clampedReasoning;
	// 仅当「模型本身支持推理 且 用户显式给了档位」才下发推理参数
	const shouldUseReasoning = model.reasoning && reasoning !== undefined;

	return stream(model, context, {
		...base,
		// Mistral 两代推理开关互斥：新一代模型用 reasoning_effort，其余推理模型用 prompt_mode
		promptMode: shouldUseReasoning && usesPromptModeReasoning(model) ? "reasoning" : undefined,
		reasoningEffort:
			shouldUseReasoning && usesReasoningEffort(model) ? mapReasoningEffort(model, reasoning) : undefined,
	} satisfies MistralOptions);
};

/**
 * 创建助手消息骨架：流式过程中所有事件共享这一个可变对象，
 * usage/cost 预置为 0，stopReason 置为 pending 等待 finish_reason。
 * @param model 目标模型（用于回填 api/provider/model 元信息）
 * @returns 初始 AssistantMessage
 */
function createOutput(model: Model<"mistral-conversations">): AssistantMessage {
	return {
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
}

/**
 * 创建工具调用 ID 归一化器（带双向映射缓存）。
 * Why：会话中途从其他模型切到 Mistral 时，历史里的工具调用 ID 可能是
 * OpenAI 风格的长特殊字符串，Mistral 服务端校验不过，需折叠成短字母数字 ID。
 * 用 idMap/reverseMap 双向缓存保证：同一 ID 稳定映射到同一结果，
 * 且不同 ID 不会折叠到同一目标（碰撞时追加尝试次数重新哈希）。
 * @returns 归一化函数（同一输入始终返回同一输出）
 */
function createMistralToolCallIdNormalizer(): (id: string) => string {
	// 正向映射：原始 ID → 归一化 ID（缓存保证幂等，回放时 ID 不漂移）
	const idMap = new Map<string, string>();
	// 反向映射：归一化 ID → 原始 ID（用于碰撞检测）
	const reverseMap = new Map<string, string>();

	return (id: string): string => {
		const existing = idMap.get(id);
		if (existing) return existing;

		// 哈希折叠存在极小概率碰撞：目标 ID 已被其他原始 ID 占用时，
		// 换一个种子（拼上尝试次数）重试，直到拿到无主的目标 ID
		let attempt = 0;
		while (true) {
			const candidate = deriveMistralToolCallId(id, attempt);
			const owner = reverseMap.get(candidate);
			if (!owner || owner === id) {
				idMap.set(id, candidate);
				reverseMap.set(candidate, id);
				return candidate;
			}
			attempt++;
		}
	};
}

/**
 * 推导单个归一化工具调用 ID：先剥掉所有非字母数字字符，
 * 恰好等于目标长度则直接使用；否则用短哈希折叠后再截断。
 * @param id 原始工具调用 ID
 * @param attempt 碰撞重试次数（0 表示首次尝试）
 * @returns 长度不超过 MISTRAL_TOOL_CALL_ID_LENGTH 的纯字母数字 ID
 */
function deriveMistralToolCallId(id: string, attempt: number): string {
	const normalized = id.replace(/[^a-zA-Z0-9]/g, "");
	// 快路径：清洗后长度正好达标就无需哈希
	if (attempt === 0 && normalized.length === MISTRAL_TOOL_CALL_ID_LENGTH) return normalized;
	// 原始 ID 清洗后可能为空（纯符号串），此时退回用原始串做哈希种子
	const seedBase = normalized || id;
	// 非首次尝试时改变种子，以产生不同的哈希候选
	const seed = attempt === 0 ? seedBase : `${seedBase}:${attempt}`;
	return shortHash(seed)
		.replace(/[^a-zA-Z0-9]/g, "")
		.slice(0, MISTRAL_TOOL_CALL_ID_LENGTH);
}

/**
 * 把任意异常格式化为可读的错误消息字符串，按信息量从高到低回退：
 * 状态码 + 响应体 → 状态码 + message → 纯 message → JSON 序列化。
 * @param error 捕获到的任意异常
 * @returns 格式化后的错误消息
 */
function formatMistralError(error: unknown): string {
	if (error instanceof Error) {
		const httpError = error as Error & { statusCode?: unknown; body?: unknown };
		const statusCode = typeof httpError.statusCode === "number" ? httpError.statusCode : undefined;
		const bodyText = typeof httpError.body === "string" ? httpError.body.trim() : undefined;
		// 状态码 + 响应体都有：展示最完整的服务端错误详情（响应体截断防爆屏）
		if (statusCode !== undefined && bodyText) {
			return `Mistral API error (${statusCode}): ${truncateErrorText(bodyText, MAX_MISTRAL_ERROR_BODY_CHARS)}`;
		}
		if (statusCode !== undefined) return `Mistral API error (${statusCode}): ${error.message}`;
		return error.message;
	}
	return safeJsonStringify(error);
}

/**
 * 截断过长文本，并在尾部附带被截掉的字符数提示。
 * @param text 原始文本
 * @param maxChars 最大保留字符数
 * @returns 截断后的文本（超长时尾部带截断标记）
 */
function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

/**
 * 安全的 JSON 序列化：序列化失败（如循环引用）或结果为 undefined 时退回 String()。
 * @param value 任意值
 * @returns 序列化后的字符串
 */
function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

/**
 * 发起流式 HTTP 请求并返回 Mistral SSE 事件异步迭代器。
 * @param model 目标模型（提供 baseUrl 与模型级请求头覆盖）
 * @param payload 已组装的请求负载（camelCase，发送前转为 wire 格式）
 * @param apiKey Mistral API 密钥
 * @param options Mistral 流式选项（超时/中断信号/fetch 实现等）
 * @returns Mistral CompletionChunk 事件流
 */
async function requestMistralStream(
	model: Model<"mistral-conversations">,
	payload: MistralChatPayload,
	apiKey: string,
	options?: MistralOptions,
): Promise<AsyncIterable<MistralCompletionEvent>> {
	// baseUrl 规范化：确保以单个 / 结尾再拼接 v1/chat/completions，
	// 兼容自带路径前缀的自定义网关
	const baseUrl = new URL(model.baseUrl);
	baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/`;
	const url = new URL("v1/chat/completions", baseUrl);
	const headers = buildMistralHeaders(model, apiKey, options);
	// 默认 60s 无响应超时；与调用方传入的中断信号取「任一触发即中止」
	const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? 60_000);
	const signal = options?.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	// 允许注入自定义 fetch（测试/代理场景），默认用全局 fetch
	const response = await (options?.fetch ?? globalThis.fetch)(url, {
		method: "POST",
		headers,
		body: JSON.stringify(toMistralWirePayload(payload)),
		signal,
	});

	// onResponse 钩子：把原始响应状态与响应头回传给调用方（如做遥测）
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

	if (!response.ok) {
		// 非 2xx：读出响应体并封装成带 statusCode/body 的错误，供 formatMistralError 展示
		const body = await response.text();
		throw new MistralHttpError(response.status, body, response.statusText);
	}
	if (!response.body) {
		throw new Error("Mistral response has no body");
	}

	return readMistralEvents(response.body, signal);
}

/**
 * Mistral HTTP 错误：保留状态码与响应体原文，
 * 供 formatMistralError 提取展示完整的服务端错误详情。
 */
class MistralHttpError extends Error {
	statusCode: number;
	body: string;

	constructor(statusCode: number, body: string, statusText: string) {
		super(statusText || `Request failed with status ${statusCode}`);
		this.name = "MistralHttpError";
		this.statusCode = statusCode;
		this.body = body;
	}
}

/**
 * 构建请求头：UA / SSE accept / Bearer 鉴权 / JSON content-type 四件套，
 * 再叠加模型级与请求级覆盖，最后按需注入 x-affinity 会话亲和头。
 * @param model 目标模型（可带模型级请求头覆盖）
 * @param apiKey API 密钥
 * @param options 流式选项（可带请求级请求头覆盖、缓存会话）
 * @returns 最终请求头
 */
function buildMistralHeaders(model: Model<"mistral-conversations">, apiKey: string, options?: MistralOptions): Headers {
	const headers = new Headers({
		"User-Agent": getPiUserAgent(),
		accept: "text/event-stream",
		authorization: `Bearer ${apiKey}`,
		"content-type": "application/json",
	});
	// 覆盖顺序：模型级先、请求级后（请求级优先级更高）
	applyMistralHeaderOverrides(headers, model.headers);
	applyMistralHeaderOverrides(headers, options?.headers);

	// 开启提示缓存时用 sessionId 作为亲和键，让请求路由到同一节点以命中缓存；
	// 调用方已显式设置 x-affinity 时不覆盖
	const hasExplicitAffinity =
		hasMistralHeaderOverride(model.headers, "x-affinity") || hasMistralHeaderOverride(options?.headers, "x-affinity");
	if (shouldUsePromptCaching(options) && !hasExplicitAffinity) {
		headers.set("x-affinity", options.sessionId);
	}

	return headers;
}

/**
 * 就地应用请求头覆盖：value 为 null 表示删除该头，否则设置/覆盖。
 * @param headers 目标请求头
 * @param overrides 覆盖项（键值对，null 表示删除）
 */
function applyMistralHeaderOverrides(headers: Headers, overrides?: Record<string, string | null>): void {
	if (!overrides) return;
	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) headers.delete(name);
		else headers.set(name, value);
	}
}

/**
 * 判断覆盖表中是否包含指定请求头（头名大小写不敏感比较）。
 * @param overrides 覆盖表
 * @param target 目标头名（小写）
 * @returns 是否存在该头的覆盖
 */
function hasMistralHeaderOverride(overrides: Record<string, string | null> | undefined, target: string): boolean {
	return !!overrides && Object.keys(overrides).some((name) => name.toLowerCase() === target);
}

/**
 * 把内部 camelCase 负载转换为 Mistral wire 格式（snake_case 字段名）。
 * Why：内部代码统一 camelCase、服务端要求 snake_case，在发送前一次性重命名；
 * 这样 onPayload 钩子看到的始终是 camelCase，对调用方友好。
 * @param payload 内部格式的请求负载
 * @returns wire 格式的请求负载（可直接 JSON.stringify 发送）
 */
function toMistralWirePayload(payload: MistralChatPayload): Record<string, unknown> {
	const wirePayload: Record<string, unknown> = { ...payload };
	// 顶层字段批量 camelCase → snake_case
	for (const [source, target] of [
		["topP", "top_p"],
		["maxTokens", "max_tokens"],
		["randomSeed", "random_seed"],
		["responseFormat", "response_format"],
		["toolChoice", "tool_choice"],
		["presencePenalty", "presence_penalty"],
		["frequencyPenalty", "frequency_penalty"],
		["parallelToolCalls", "parallel_tool_calls"],
		["reasoningEffort", "reasoning_effort"],
		["promptMode", "prompt_mode"],
		["promptCacheKey", "prompt_cache_key"],
		["safePrompt", "safe_prompt"],
	] as const) {
		remapMistralProperty(wirePayload, source, target);
	}
	wirePayload.messages = payload.messages.map((message) => toMistralWireMessage(message));

	// response_format 的嵌套结构同样要重命名（结构化输出场景）：
	// jsonSchema → json_schema、schemaDefinition → schema
	const responseFormat = wirePayload.response_format;
	if (isMistralRecord(responseFormat)) {
		const wireResponseFormat = { ...responseFormat };
		remapMistralProperty(wireResponseFormat, "jsonSchema", "json_schema");
		const jsonSchema = wireResponseFormat.json_schema;
		if (isMistralRecord(jsonSchema)) {
			const wireJsonSchema = { ...jsonSchema };
			remapMistralProperty(wireJsonSchema, "schemaDefinition", "schema");
			wireResponseFormat.json_schema = wireJsonSchema;
		}
		wirePayload.response_format = wireResponseFormat;
	}

	return wirePayload;
}

/**
 * 单条消息的 wire 转换：toolCalls/toolCallId 转 snake_case，
 * 数组形态的 content 逐块转换。
 * @param message 内部格式消息
 * @returns wire 格式消息
 */
function toMistralWireMessage(message: MistralChatMessage): Record<string, unknown> {
	const wireMessage: Record<string, unknown> = { ...message };
	remapMistralProperty(wireMessage, "toolCalls", "tool_calls");
	remapMistralProperty(wireMessage, "toolCallId", "tool_call_id");
	if (Array.isArray(message.content)) {
		wireMessage.content = message.content.map((chunk) => toMistralWireContentChunk(chunk));
	}
	return wireMessage;
}

/**
 * 内容块的 wire 转换：多模态相关字段的 camelCase → snake_case。
 * @param chunk 内部格式内容块
 * @returns wire 格式内容块
 */
function toMistralWireContentChunk(chunk: MistralContentChunk): Record<string, unknown> {
	const wireChunk: Record<string, unknown> = { ...chunk };
	for (const [source, target] of [
		["imageUrl", "image_url"],
		["documentUrl", "document_url"],
		["documentName", "document_name"],
		["fileId", "file_id"],
		["referenceIds", "reference_ids"],
		["inputAudio", "input_audio"],
	] as const) {
		remapMistralProperty(wireChunk, source, target);
	}
	return wireChunk;
}

/**
 * 就地重命名对象属性：源字段存在才移动，保持「未设置的字段不出现在 wire 上」。
 * @param record 目标对象（会被就地修改）
 * @param source 原字段名
 * @param target 目标字段名
 */
function remapMistralProperty(record: Record<string, unknown>, source: string, target: string): void {
	if (!(source in record)) return;
	record[target] = record[source];
	delete record[source];
}

/**
 * 类型守卫：非 null、非数组的普通对象。
 * @param value 待判断的值
 * @returns 是否为普通对象
 */
function isMistralRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 哨兵值：解析到 SSE 的 [DONE] 行时返回，用于终止事件迭代
// （区别于 undefined 表示「本条事件没有 data 行，跳过」）
const MISTRAL_STREAM_DONE = Symbol("mistral-stream-done");

/**
 * 从响应体字节流中读取并解析 Mistral SSE 事件序列。
 * Why：不用 EventSource / SDK 解析器，手写分帧以完全掌控中断语义
 * （abort 立即取消 reader 并抛出 reason）与各种换行分隔符的兼容。
 * @param body 响应体字节流
 * @param signal 中断信号（超时或调用方中止）
 * @returns 逐个 yield 解析好的 CompletionChunk 事件
 */
async function* readMistralEvents(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): AsyncGenerator<MistralCompletionEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	// 跨 chunk 的文本缓冲：一条 SSE 事件可能被网络分片切开，需攒够边界再解析
	let buffer = "";
	// 中断时立即取消底层 reader，让挂起中的 reader.read() 尽快抛出
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			// 读取前后各查一次中断：有些运行时在 cancel 之后 read 仍会正常返回
			if (signal.aborted) throw signal.reason;
			const { done, value } = await reader.read();
			if (signal.aborted) throw signal.reason;
			// 流结束时最后一次 flush 解码器，避免多字节字符残留在解码缓冲里
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

			// ========== SSE 分帧：按「空行边界」切出完整事件并逐条解析 ==========
			let boundary = findMistralEventBoundary(buffer);
			while (boundary) {
				const event = parseMistralEvent(buffer.slice(0, boundary.index));
				buffer = buffer.slice(boundary.index + boundary.length);
				// [DONE] 哨兵：流正常结束，直接终止生成器
				if (event === MISTRAL_STREAM_DONE) return;
				if (event) yield event;
				boundary = findMistralEventBoundary(buffer);
			}

			if (done) break;
		}

		// 流读完但缓冲里还剩半条事件（服务端没以空行收尾）：仍尝试解析一次
		if (buffer.trim()) {
			const event = parseMistralEvent(buffer);
			if (event !== MISTRAL_STREAM_DONE && event) yield event;
		}
	} finally {
		// 统一清理：摘掉监听、取消 reader、释放锁；清理失败静默吞掉，
		// 此时主流程已在处理异常，不能再让清理抛出新错误
		signal.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

/**
 * 在缓冲中查找 SSE 事件边界（空行）。
 * Why：SSE 规范允许 CR/LF 的各种组合做行分隔与事件分隔
 * （\r\n\r\n、\n\n、\r\r，甚至混合的 \r\n\n、\n\r 等），
 * 穷举所有两字符换行组合避免丢事件。
 * @param buffer 当前缓冲
 * @returns 命中时返回 { index, length }，未命中返回 undefined
 */
function findMistralEventBoundary(buffer: string): { index: number; length: number } | undefined {
	const match = /\r\n\r\n|\r\n\r|\r\n\n|\r\r\n|\n\r\n|\r\r|\n\r|\n\n/u.exec(buffer);
	return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

/**
 * 解析单条 SSE 事件的 data 负载。
 * 多行 data: 按 SSE 规范以换行拼接；[DONE] 返回哨兵；
 * 其余要求 JSON.parse 出带 choices 数组的对象，否则视为协议错误。
 * @param raw 事件原文（不含边界空行）
 * @returns 解析好的事件、MISTRAL_STREAM_DONE 哨兵，或 undefined（无 data 行）
 * @throws 事件 JSON 非法或缺少 choices 数组时抛错
 */
function parseMistralEvent(raw: string): MistralCompletionEvent | typeof MISTRAL_STREAM_DONE | undefined {
	const data = raw
		.split(/\r\n|\r|\n/u)
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trimStart())
		.join("\n")
		.trim();
	if (!data) return undefined;
	if (data === "[DONE]") return MISTRAL_STREAM_DONE;

	const parsed: unknown = JSON.parse(data);
	if (!isMistralRecord(parsed) || !Array.isArray(parsed.choices)) {
		throw new Error("Invalid Mistral streaming event");
	}
	return { data: parsed as MistralCompletionEvent["data"] };
}

/**
 * 组装 Mistral Chat 请求负载（内部 camelCase 格式）。
 * @param model 目标模型
 * @param context 会话上下文（系统提示、工具列表）
 * @param messages 经 transformMessages 改写后的消息列表
 * @param options Mistral 流式选项
 * @returns 请求负载
 */
function buildChatPayload(
	model: Model<"mistral-conversations">,
	context: Context,
	messages: Message[],
	options?: MistralOptions,
): MistralChatPayload {
	const payload: MistralChatPayload = {
		model: model.id,
		// 始终流式请求：本适配器只服务 SSE 协议
		stream: true,
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	// ========== 可选字段：仅在显式设置时写入，保持「未设置不出现在 wire 上」 ==========
	if (context.tools?.length) payload.tools = toFunctionTools(context.tools);
	if (options?.temperature !== undefined) payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	if (options?.promptMode) payload.promptMode = options.promptMode;
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;
	// 提示缓存键：与 x-affinity 头配套，服务端据此命中前缀缓存
	if (shouldUsePromptCaching(options)) payload.promptCacheKey = options.sessionId;

	// 系统提示插入为第一条 system 消息；sanitizeSurrogates 清掉孤立代理对，
	// 避免非法 UTF-16 被服务端 JSON 校验拒绝
	if (context.systemPrompt) {
		payload.messages.unshift({
			role: "system",
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	return payload;
}

/**
 * 判断是否启用 Mistral 提示缓存：未显式关闭缓存 且 提供了 sessionId。
 * 写成类型谓词，让 TS 在判定通过后收窄出非空的 sessionId。
 * @param options Mistral 流式选项
 * @returns 是否启用提示缓存
 */
function shouldUsePromptCaching(options?: MistralOptions): options is MistralOptions & { sessionId: string } {
	return options?.cacheRetention !== "none" && !!options?.sessionId;
}

/**
 * 从 usage 对象里提取缓存命中的 prompt token 数。
 * Why：不同 Mistral 模型/网关返回的字段名不一致（camelCase/snakeCase、
 * promptTokensDetails/promptTokenDetails/numCachedTokens 等变体），逐一尝试；
 * 最后用 Math.min 钳制，保证缓存数不超过总 prompt 数。
 * @param usage 原始 usage 对象
 * @param promptTokens 总 prompt token 数
 * @returns 缓存命中的 token 数（无法解析时为 0）
 */
function getMistralCachedPromptTokens(usage: unknown, promptTokens: number): number {
	const rawUsage = usage as {
		promptTokensDetails?: { cachedTokens?: unknown } | null;
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
		promptTokenDetails?: { cachedTokens?: unknown } | null;
		prompt_token_details?: { cached_tokens?: unknown } | null;
		numCachedTokens?: unknown;
		num_cached_tokens?: unknown;
	};
	// 依次尝试各变体字段，全部缺失时回落到 0
	const rawCachedTokens =
		rawUsage.promptTokensDetails?.cachedTokens ??
		rawUsage.prompt_tokens_details?.cached_tokens ??
		rawUsage.promptTokenDetails?.cachedTokens ??
		rawUsage.prompt_token_details?.cached_tokens ??
		rawUsage.numCachedTokens ??
		rawUsage.num_cached_tokens ??
		0;
	const cachedTokens = typeof rawCachedTokens === "number" && Number.isFinite(rawCachedTokens) ? rawCachedTokens : 0;
	return Math.min(promptTokens, Math.max(0, cachedTokens));
}

/**
 * 消费 Mistral SSE 事件流，把增量翻译为标准内容块与事件。
 * 核心状态机：
 * - currentBlock：当前正在追加的 text/thinking 块；块类型切换时先 finish 旧块再开新块，
 *   保证 output.content 里同一类型的增量总是合并进同一个块
 * - toolBlocksByKey：以「调用 ID + index」为键记录工具调用块在 content 中的位置，
 *   Mistral 会把同一个工具调用的参数分多帧下发，后续同键增量直接定位续写
 * - partialArgs：参数 JSON 的流式临时缓冲，边收边用 parseStreamingJson 增量解析
 * @param model 目标模型（计费用）
 * @param output 就地更新的助手消息
 * @param stream 标准事件流
 * @param mistralStream Mistral 事件源
 */
async function consumeChatStream(
	model: Model<"mistral-conversations">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	mistralStream: AsyncIterable<MistralCompletionEvent>,
): Promise<void> {
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	// 当前打开块的下标 = 最后一个块（块总是追加到 content 末尾）
	const blockIndex = () => blocks.length - 1;
	const toolBlocksByKey = new Map<string, number>();

	/**
	 * 结束当前打开的 text/thinking 块，发出对应的 *_end 事件。
	 * @param block 待结束的块（空则什么都不做）
	 */
	const finishCurrentBlock = (block?: typeof currentBlock) => {
		if (!block) return;
		if (block.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: block.text,
				partial: output,
			});
			return;
		}
		if (block.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: block.thinking,
				partial: output,
			});
		}
	};

	for await (const event of mistralStream) {
		const chunk = event.data;
		// Mistral 流式 CompletionChunk 带 id 字段。只保留第一个非空值，
		// 对齐 OpenAI 风格流式协议「每条流暴露一个稳定响应标识」的语义。
		output.responseId ||= chunk.id;

		// ========== usage 计费：收到即覆盖更新（Mistral 通常在流首/流尾各发一次） ==========
		if (chunk.usage) {
			const promptTokens = chunk.usage.prompt_tokens || 0;
			// 缓存命中的 token 需从 input 中拆出来单列（两者的计费单价不同）
			const cachedPromptTokens = getMistralCachedPromptTokens(chunk.usage, promptTokens);

			// input 只计未命中缓存的部分；Mistral 没有显式 cacheWrite，恒为 0
			output.usage.input = Math.max(0, promptTokens - cachedPromptTokens);
			output.usage.output = chunk.usage.completion_tokens || 0;
			output.usage.cacheRead = cachedPromptTokens;
			output.usage.cacheWrite = 0;
			// 服务端未给 total_tokens 时用各分项之和兜底
			output.usage.totalTokens =
				chunk.usage.total_tokens ||
				output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
			calculateCost(model, output.usage);
		}

		const choice = chunk.choices[0];
		if (!choice) continue;

		// ========== finish_reason：映射为统一 stopReason，异常原因附带错误消息 ==========
		if (choice.finish_reason) {
			output.rawStopReason = choice.finish_reason;
			const stopReasonResult = mapChatStopReason(choice.finish_reason);
			output.stopReason = stopReasonResult.stopReason;
			if (stopReasonResult.errorMessage) {
				output.errorMessage = stopReasonResult.errorMessage;
			}
		}

		// ========== 文本/思考增量：维护当前块，类型切换时闭合旧块再开新块 ==========
		const delta = choice.delta;
		if (delta.content !== null && delta.content !== undefined) {
			// 纯字符串 content 包装成单元素数组，统一走块处理循环
			const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
			for (const item of contentItems) {
				// —— 分支 1：字符串增量（纯文本模型走这条路）——
				if (typeof item === "string") {
					const textDelta = sanitizeSurrogates(item);
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.text += textDelta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: textDelta,
						partial: output,
					});
					continue;
				}

				// —— 分支 2：思考增量。Mistral 把思考放在 { text } 片段数组里，
				//    拼接后整体作为一段 delta；空增量直接跳过（不产生空块）——
				if (item.type === "thinking") {
					const deltaText = (item.thinking ?? [])
						.map((part) => part.text ?? "")
						.filter((text) => text.length > 0)
						.join("");
					const thinkingDelta = sanitizeSurrogates(deltaText);
					if (!thinkingDelta) continue;
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "thinking", thinking: "" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.thinking += thinkingDelta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: thinkingDelta,
						partial: output,
					});
					continue;
				}

				// —— 分支 3：结构化文本块增量 ——
				if (item.type === "text") {
					const textDelta = sanitizeSurrogates(item.text ?? "");
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.text += textDelta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: textDelta,
						partial: output,
					});
				}
			}
		}

		// ========== 工具调用增量：按「ID+index」定位块，参数流式累积解析 ==========
		const toolCalls = delta.tool_calls || [];
		for (const toolCall of toolCalls) {
			// 工具调用与文本/思考互斥：先结束当前打开的块
			if (currentBlock) {
				finishCurrentBlock(currentBlock);
				currentBlock = null;
			}
			// id 缺失或为字面量 "null" 时（Mistral 续帧常不带 id），
			// 用 index 派生确定性 ID，保证同一工具调用的后续分帧能命中同一个块
			const callId =
				toolCall.id && toolCall.id !== "null"
					? toolCall.id
					: deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
			// 键同时含 ID 与 index：两者任一不同都视为不同的增量通道
			const key = `${callId}:${toolCall.index || 0}`;
			const existingIndex = toolBlocksByKey.get(key);
			let block: (ToolCall & { partialArgs?: string }) | undefined;

			// 命中已登记的块则复用（增量续写）
			if (existingIndex !== undefined) {
				const existing = output.content[existingIndex];
				if (existing?.type === "toolCall") {
					block = existing as ToolCall & { partialArgs?: string };
				}
			}

			// 首次出现：创建工具调用块，登记位置并发 toolcall_start
			if (!block) {
				block = {
					type: "toolCall",
					id: callId,
					name: toolCall.function.name,
					arguments: {},
					partialArgs: "",
				};
				output.content.push(block);
				toolBlocksByKey.set(key, output.content.length - 1);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}

			// 参数可能是字符串增量，也可能是已解析的对象（不同版本行为不一），
			// 统一转成字符串增量后累积进缓冲，再增量解析成部分 JSON
			const argsDelta =
				typeof toolCall.function.arguments === "string"
					? toolCall.function.arguments
					: JSON.stringify(toolCall.function.arguments || {});
			block.partialArgs = (block.partialArgs || "") + argsDelta;
			block.arguments = parseStreamingJson<Record<string, unknown>>(block.partialArgs);
			stream.push({
				type: "toolcall_delta",
				contentIndex: toolBlocksByKey.get(key)!,
				delta: argsDelta,
				partial: output,
			});
		}
	}

	// ========== 流结束收尾：闭合当前块 + 逐个终结工具调用块 ==========
	finishCurrentBlock(currentBlock);
	for (const index of toolBlocksByKey.values()) {
		const block = output.content[index];
		if (block.type !== "toolCall") continue;
		const toolBlock = block as ToolCall & { partialArgs?: string };
		// 最终再解析一次，确保拿到完整的参数对象
		toolBlock.arguments = parseStreamingJson<Record<string, unknown>>(toolBlock.partialArgs);
		// 就地终结并剥掉临时缓冲，确保回放/持久化只携带已解析的参数。
		delete toolBlock.partialArgs;
		stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: toolBlock,
			partial: output,
		});
	}
}

/**
 * 把统一 Tool 定义转换为 Mistral 函数工具格式。
 * strict 采样由工具 JSON Schema 元数据推导（默认倾向开启）；
 * Schema 先经 stripSymbolKeys 规整成纯字符串键结构。
 * @param tools 统一工具定义列表
 * @returns Mistral 格式的函数工具列表
 */
function toFunctionTools(tools: Tool[]): MistralFunctionTool[] {
	return tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool, true);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: stripSymbolKeys(getJsonSchemaToolParameters(tool, strict)) as Record<string, unknown>,
				strict: strict ?? false,
			},
		};
	});
}

/**
 * 递归重建对象只保留字符串键：Symbol 键（可能被 Schema 元数据工具用作标记）
 * 无法被 JSON 序列化、也不会出现在 Object.entries 中，重建等于把它们过滤掉，
 * 保证发到服务端的 Schema 是干净的普通对象。
 * @param value 任意值
 * @returns 只含字符串键的新结构（数组逐项递归，标量原样返回）
 */
function stripSymbolKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stripSymbolKeys(item));
	}

	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = stripSymbolKeys(entry);
		}
		return result;
	}

	return value;
}

/**
 * 把统一消息列表转换为 Mistral Chat 消息格式。
 * 处理要点：字符串/块数组两种用户消息、非视觉模型的图片降级占位、
 * assistant 的 text/thinking/toolCall 三类块拆分、tool 结果文本合成与图片附加。
 * @param messages 统一消息列表
 * @param supportsImages 模型是否支持图片输入
 * @returns Mistral 格式消息列表
 */
function toChatMessages(messages: Message[], supportsImages: boolean): MistralChatMessage[] {
	const result: MistralChatMessage[] = [];

	for (const msg of messages) {
		// ========== 用户消息：纯字符串直传；块数组按模型能力过滤图片 ==========
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				continue;
			}
			// 记录是否原本含图片：内容被过滤成空时要补占位说明
			const hadImages = msg.content.some((item) => item.type === "image");
			// 文本块始终保留；图片块仅在模型支持时保留（转成 data URL 形式）
			const content: MistralContentChunk[] = msg.content
				.filter((item) => item.type === "text" || supportsImages)
				.map((item) => {
					if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
					return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
				});
			if (content.length > 0) {
				result.push({ role: "user", content });
				continue;
			}
			// 内容全是图片且模型不支持：降级为占位文本，避免发空 content
			if (hadImages && !supportsImages) {
				result.push({ role: "user", content: "(image omitted: model does not support images)" });
			}
			continue;
		}

		// ========== 助手消息：content 块拆为「内容块 + 工具调用」两类 ==========
		if (msg.role === "assistant") {
			const contentParts: MistralContentChunk[] = [];
			const toolCalls: MistralRequestToolCall[] = [];

			for (const block of msg.content) {
				// 文本块：空白文本跳过（不发空块）
				if (block.type === "text") {
					if (block.text.trim().length > 0) {
						contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					continue;
				}
				// 思考块：包回 Mistral 的 thinking 片段数组结构，空白跳过
				if (block.type === "thinking") {
					if (block.thinking.trim().length > 0) {
						contentParts.push({
							type: "thinking",
							thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						});
					}
					continue;
				}
				// 工具调用块：参数对象序列化回 JSON 字符串
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
					index: 0,
				});
			}

			// prefix=false 表示这是完整的助手消息（非续写前缀）
			const assistantMessage: MistralChatMessage = { role: "assistant", prefix: false };
			if (contentParts.length > 0) assistantMessage.content = contentParts;
			if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
			// 两类都为空则整条丢弃（避免发出空消息）
			if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
			continue;
		}

		// ========== 工具结果消息：role=tool，带 toolCallId 与工具名 ==========
		const toolContent: MistralContentChunk[] = [];
		// 文本部分拼接为单条（多个文本块用换行连接）
		const textResult = msg.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? sanitizeSurrogates(part.text) : ""))
			.join("\n");
		const hasImages = msg.content.some((part) => part.type === "image");
		// 合成工具结果文本：错误前缀 / 图片省略提示 / 空输出提示
		const toolText = buildToolResultText(textResult, hasImages, supportsImages, msg.isError);
		toolContent.push({ type: "text", text: toolText });
		// 图片部分仅在模型支持时以 data URL 附加
		for (const part of msg.content) {
			if (!supportsImages) continue;
			if (part.type !== "image") continue;
			toolContent.push({
				type: "image_url",
				imageUrl: `data:${part.mimeType};base64,${part.data}`,
			});
		}
		result.push({
			role: "tool",
			toolCallId: msg.toolCallId,
			name: msg.toolName,
			content: toolContent,
		});
	}

	return result;
}

/**
 * 合成工具结果的占位/提示文本，覆盖四种情形：
 * 有文本（带可选的图片省略后缀）、纯图片且支持（提示看附图）、
 * 纯图片且不支持（提示图片被省略）、完全空输出。
 * @param text 工具输出的文本部分（多块已换行拼接）
 * @param hasImages 是否含图片
 * @param supportsImages 模型是否支持图片
 * @param isError 工具是否执行出错
 * @returns 最终写入 tool 消息的文本
 */
function buildToolResultText(text: string, hasImages: boolean, supportsImages: boolean, isError: boolean): string {
	const trimmed = text.trim();
	const errorPrefix = isError ? "[tool error] " : "";

	if (trimmed.length > 0) {
		const imageSuffix = hasImages && !supportsImages ? "\n[tool image omitted: model does not support images]" : "";
		return `${errorPrefix}${trimmed}${imageSuffix}`;
	}

	if (hasImages) {
		if (supportsImages) {
			return isError ? "[tool error] (see attached image)" : "(see attached image)";
		}
		return isError
			? "[tool error] (image omitted: model does not support images)"
			: "(image omitted: model does not support images)";
	}

	return isError ? "[tool error] (no tool output)" : "(no tool output)";
}

/**
 * 判断模型是否走 reasoning_effort 参数（新一代 Mistral Small/Medium）。
 * Why：Mistral 两代推理开关并存且参数不同，只能按模型 ID 硬编码区分。
 * @param model 目标模型
 * @returns 是否支持 reasoning_effort
 */
function usesReasoningEffort(model: Model<"mistral-conversations">): boolean {
	return model.id === "mistral-small-2603" || model.id === "mistral-small-latest" || model.id === "mistral-medium-3.5";
}

/**
 * 判断模型是否走 prompt_mode=reasoning：除 reasoning_effort 系模型外的
 * 其余推理模型（如 Magistral 系列）。
 * @param model 目标模型
 * @returns 是否应使用 prompt_mode 推理开关
 */
function usesPromptModeReasoning(model: Model<"mistral-conversations">): boolean {
	return model.reasoning && !usesReasoningEffort(model);
}

/**
 * 把统一思考档位映射为 Mistral 的 reasoning_effort。
 * 优先查模型的 thinkingLevelMap 自定义映射，缺省回落到 "high"。
 * @param model 目标模型
 * @param level 统一思考档位（clamp 后的非 undefined 值）
 * @returns Mistral 推理力度
 */
function mapReasoningEffort(
	model: Model<"mistral-conversations">,
	level: Exclude<SimpleStreamOptions["reasoning"], undefined>,
): MistralReasoningEffort {
	return (model.thinkingLevelMap?.[level] ?? "high") as MistralReasoningEffort;
}

/**
 * 规范化工具选择：字符串枚举原样透传，对象形式重建为新对象。
 * @param choice Mistral 工具选择
 * @returns wire 格式的 tool_choice（未设置时为 undefined）
 */
function mapToolChoice(
	choice: MistralOptions["toolChoice"],
): "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } } | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		return choice;
	}
	return {
		type: "function",
		function: { name: choice.function.name },
	};
}

/**
 * 把 Mistral finish_reason 映射为统一 StopReason。
 * length/model_length → length；tool_calls → toolUse；stop/null → stop；
 * 其余（含 error 与未知值）一律按 error 处理并附带原始原因文本。
 * @param reason Mistral 原始 finish_reason
 * @returns 统一 stopReason，error 时附带 errorMessage
 */
function mapChatStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
		case "model_length":
			return { stopReason: "length" };
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "error":
			return { stopReason: "error", errorMessage: "Provider stopped with: error" };
		default:
			return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
	}
}
