/**
 * @file faux 测试替身 provider
 * @description 不连真实 API 的脚本化 provider：测试方预先把一组「响应步骤」（静态消息或
 *              工厂函数）排队，faux 按序回放，并把消息按随机 token 粒度切分、以
 *              text/thinking/toolcall 的 start/delta/end 事件流式吐出——完整模拟真实
 *              provider 的事件时序、abort 语义、延迟响应（deferred）与 usage 估算，
 *              供 test/ 下的测试与上游包（agent 等）做确定性断言。
 *
 * 主要功能：
 * - fauxProvider()：基于显式 Models 集合的测试 provider（createProvider 组装）
 * - createFauxCore()：核心状态机（响应队列 / deferred 注册表 / usage 模拟）
 * - fauxAssistantMessage() 等构造助手：快速搭建脚本化消息
 *
 * 依赖关系：
 * - ../models.ts 的 createProvider / Provider
 * - ../types.ts 的消息与流类型；../utils/event-stream.ts 的事件流原语
 */

import { createProvider, type Provider } from "../models.ts";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	DeferredCancelOptions,
	DeferredFetchOptions,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";

// ========== 默认标识与流式参数 ==========
// 端口 0 表示「不真正监听」——faux 不发网络请求，baseUrl 仅作占位
const DEFAULT_API = "faux";
const DEFAULT_PROVIDER = "faux";
const DEFAULT_MODEL_ID = "faux-1";
const DEFAULT_MODEL_NAME = "Faux Model";
const DEFAULT_BASE_URL = "http://localhost:0";
// 模拟 token 的字符粒度区间：每个假 token 约 3~5 个「token」（每 token 按 4 字符估算）
const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

// 全零 usage 兜底：未启用估算时直接引用，避免每条消息重复分配
const DEFAULT_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** faux 模型定义：只声明测试关心的字段，其余由 createFauxCore 补默认值 */
export interface FauxModelDefinition {
	id: string;
	/** 展示名；缺省用 id */
	name?: string;
	/** 是否支持 reasoning（影响上层是否认为可用 thinking） */
	reasoning?: boolean;
	/** 支持的输入模态；缺省文本+图片 */
	input?: ("text" | "image")[];
	/** 每百万 token 单价（测试断言计费用）；缺省全零 */
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** 上下文窗口；缺省 128k */
	contextWindow?: number;
	/** 单次最大输出 token；缺省 16k */
	maxTokens?: number;
}

/** faux 消息支持的内容块类型（不含图片：模拟输出侧用不到） */
export type FauxContentBlock = TextContent | ThinkingContent | ToolCall;

/** 构造文本内容块（脚本化响应的原子积木） */
export function fauxText(text: string): TextContent {
	return { type: "text", text };
}

/** 构造思考内容块 */
export function fauxThinking(thinking: string): ThinkingContent {
	return { type: "thinking", thinking };
}

/** 构造工具调用块；可指定 id 以便测试断言与工具结果配对，缺省随机生成 */
export function fauxToolCall(name: string, arguments_: ToolCall["arguments"], options: { id?: string } = {}): ToolCall {
	return {
		type: "toolCall",
		id: options.id ?? randomId("tool"),
		name,
		arguments: arguments_,
	};
}

/** 归一化脚本内容：字符串 → 单个文本块；单块 → 数组 */
function normalizeFauxAssistantContent(content: string | FauxContentBlock | FauxContentBlock[]): FauxContentBlock[] {
	if (typeof content === "string") {
		return [fauxText(content)];
	}
	return Array.isArray(content) ? content : [content];
}

/**
 * 构造一条完整的 faux 助手消息（终态）。
 * api/provider/model 固定为 faux 默认值，stopReason 缺省 "stop"；
 * 可选注入 deferred 句柄、错误信息、响应 id 与时间戳以覆盖各终态分支。
 */
export function fauxAssistantMessage(
	content: string | FauxContentBlock | FauxContentBlock[],
	options: {
		stopReason?: AssistantMessage["stopReason"];
		deferred?: DeferredHandle;
		errorMessage?: string;
		responseId?: string;
		timestamp?: number;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: normalizeFauxAssistantContent(content),
		api: DEFAULT_API,
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL_ID,
		usage: DEFAULT_USAGE,
		stopReason: options.stopReason ?? "stop",
		deferred: options.deferred,
		errorMessage: options.errorMessage,
		responseId: options.responseId,
		timestamp: options.timestamp ?? Date.now(),
	};
}

/** faux 实例的可观测状态：调用计数 / deferred 拉取计数 / 被取消的句柄（供测试断言副作用） */
export interface FauxProviderState {
	callCount: number;
	deferredFetchCount: number;
	cancelledDeferred: DeferredHandle[];
}

/**
 * 响应工厂函数：每次「轮到它」时动态计算响应。
 * 可读取 context / options / state / model，适合断言「上层确实把工具结果传回来了」这类场景。
 */
export type FauxResponseFactory = (
	context: Context,
	options: SimpleStreamOptions | undefined,
	state: FauxProviderState,
	model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;

/** 响应队列的单个步骤：静态消息或工厂函数 */
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

/** 注册 faux provider 的选项 */
export interface RegisterFauxProviderOptions {
	/** 自定义 api 标识；缺省随机 id（多实例测试互不串线） */
	api?: string;
	/** 自定义 provider id；缺省 "faux" */
	provider?: string;
	/** 模型定义列表；缺省单个 faux-1 */
	models?: FauxModelDefinition[];
	/** 延迟响应（deferred）行为的模拟参数 */
	deferred?: {
		/** 在脚本响应就绪前，先返回原始句柄的 fetch 次数（模拟轮询未就绪）。 */
		pendingFetches?: number;
		/** 句柄建议的轮询间隔（毫秒），透传给 DeferredHandle.pollAfterMs */
		pollAfterMs?: number;
	};
	/** 模拟流速（token/秒）；缺省或 <=0 表示每个分块微任务级即时发出 */
	tokensPerSecond?: number;
	/** 模拟 token 的粒度区间（token 数） */
	tokenSize?: {
		min?: number;
		max?: number;
	};
}

/**
 * 旧版全局注册（compat.ts registerFauxProvider）返回的注册句柄；
 * 比 Handle 多一个 unregister（从全局注册表摘除）。
 */
export interface FauxProviderRegistration {
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	unregister: () => void;
}

/** fauxProvider() 返回的操作句柄：provider 实例 + 队列控制与状态观测 */
export interface FauxProviderHandle {
	provider: Provider;
	api: string;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	state: FauxProviderState;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
}

/** 粗估 token 数：按每 4 字符 1 个 token（与 estimate.ts 的启发式一致量级） */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** 生成带前缀的随机 id：时间戳 + 随机串，保证多实例内唯一 */
function randomId(prefix: string): string {
	return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

/** 把用户侧内容块序列化为文本；图片以 `[image:MIME:长度]` 占位（不 dump base64） */
function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			return `[image:${block.mimeType}:${block.data.length}]`;
		})
		.join("\n");
}

/** 把助手侧内容块序列化为文本；工具调用序列化为 `名称:JSON参数` */
function assistantContentToText(content: Array<TextContent | ThinkingContent | ToolCall>): string {
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			if (block.type === "thinking") {
				return block.thinking;
			}
			return `${block.name}:${JSON.stringify(block.arguments)}`;
		})
		.join("\n");
}

/** 把工具结果消息序列化为文本：工具名 + 各内容块 */
function toolResultToText(message: ToolResultMessage): string {
	return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

/** 按消息角色分派到对应的序列化函数 */
function messageToText(message: Message): string {
	if (message.role === "user") {
		return contentToText(message.content);
	}
	if (message.role === "assistant") {
		return assistantContentToText(message.content);
	}
	return toolResultToText(message);
}

/** 把整个请求上下文序列化为可比对文本：system + 各消息 + 工具定义（usage 估算的输入） */
function serializeContext(context: Context): string {
	const parts: string[] = [];
	if (context.systemPrompt) {
		parts.push(`system:${context.systemPrompt}`);
	}
	for (const message of context.messages) {
		parts.push(`${message.role}:${messageToText(message)}`);
	}
	if (context.tools?.length) {
		parts.push(`tools:${JSON.stringify(context.tools)}`);
	}
	return parts.join("\n\n");
}

/** 两字符串的最长公共前缀长度（模拟 prompt cache 命中范围） */
function commonPrefixLength(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) {
		index++;
	}
	return index;
}

/**
 * 给消息附上估算的 usage：输入/输出按 4 字符 1 token 粗估；
 * 同一 sessionId 且未关闭 cacheRetention 时，用「上一轮 prompt 文本」模拟
 * prompt cache——公共前缀记为 cacheRead、增量记为 cacheWrite，
 * input 扣除命中部分。成本恒为零（faux 不真实计费）。
 */
function withUsageEstimate(
	message: AssistantMessage,
	context: Context,
	options: StreamOptions | undefined,
	promptCache: Map<string, string>,
): AssistantMessage {
	const promptText = serializeContext(context);
	const promptTokens = estimateTokens(promptText);
	const outputTokens = estimateTokens(assistantContentToText(message.content));
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sessionId = options?.sessionId;

	if (sessionId && options?.cacheRetention !== "none") {
		const previousPrompt = promptCache.get(sessionId);
		if (previousPrompt) {
			// 有历史 prompt：公共前缀视为缓存命中，其余视为本轮新写入
			const cachedChars = commonPrefixLength(previousPrompt, promptText);
			cacheRead = estimateTokens(previousPrompt.slice(0, cachedChars));
			cacheWrite = estimateTokens(promptText.slice(cachedChars));
			input = Math.max(0, promptTokens - cacheRead);
		} else {
			// 该会话首轮：全部记为缓存写入
			cacheWrite = promptTokens;
		}
		promptCache.set(sessionId, promptText);
	}

	return {
		...message,
		usage: {
			input,
			output: outputTokens,
			cacheRead,
			cacheWrite,
			totalTokens: input + outputTokens + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

/** 把文本按随机 token 粒度切块：每块 token 数在 [min, max] 内随机，换算为 4 倍字符数 */
function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
		const charSize = Math.max(1, tokenSize * 4);
		chunks.push(text.slice(index, index + charSize));
		index += charSize;
	}
	// 空文本也要返回一个空块，保证流式时序完整（start + end）
	return chunks.length > 0 ? chunks : [""];
}

/** 深拷贝脚本消息并盖上 faux 的 api/provider/model 标识与时间戳兜底 */
function cloneMessage(message: AssistantMessage, api: string, provider: string, modelId: string): AssistantMessage {
	const cloned = structuredClone(message);
	return {
		...cloned,
		api,
		provider,
		model: modelId,
		timestamp: cloned.timestamp ?? Date.now(),
		usage: cloned.usage ?? DEFAULT_USAGE,
	};
}

/** 构造「延迟响应已受理」的消息：stopReason 为 deferred 并携带句柄 */
function createDeferredMessage(model: Model<string>, handle: DeferredHandle): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: DEFAULT_USAGE,
		stopReason: "deferred",
		deferred: handle,
		timestamp: Date.now(),
	};
}

/** 构造错误终态消息：任意异常归一化为 stopReason: "error" 的 AssistantMessage */
function createErrorMessage(error: unknown, api: string, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: DEFAULT_USAGE,
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** 基于已流出的 partial 构造 aborted 终态（保留已生成内容，盖 aborted 标记） */
function createAbortedMessage(partial: AssistantMessage): AssistantMessage {
	return {
		...partial,
		stopReason: "aborted",
		errorMessage: "Request was aborted",
		timestamp: Date.now(),
	};
}

/**
 * 模拟单个分块的到达延迟：未限速时用微任务（几乎立即），
 * 限速时按「该块估算 token 数 / tokensPerSecond」换算毫秒延时。
 */
function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
	if (!tokensPerSecond || tokensPerSecond <= 0) {
		return new Promise((resolve) => queueMicrotask(resolve));
	}
	const delayMs = (estimateTokens(chunk) / tokensPerSecond) * 1000;
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * 核心回放循环：把终态消息按内容块逐个流式吐出。
 * 三类块（thinking/text/toolCall）都遵循 start → 若干 delta → end 的事件序列，
 * 工具调用的参数以 JSON 文本形式按块流出、结束后一次性替换为真实对象。
 * 每个分块发出前后都检查 abort：中止时立即以 aborted 终态收尾（保留已流出的 partial）。
 * 消息级错误/中止则直接以 error 事件 + 终态结束。
 */
async function streamWithDeltas(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
	minTokenSize: number,
	maxTokenSize: number,
	tokensPerSecond: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	// 从「空内容的 pending 消息」开始累积 partial；每个事件都带上当前快照
	const partial: AssistantMessage = { ...message, content: [], stopReason: "pending" };
	if (signal?.aborted) {
		const aborted = createAbortedMessage(partial);
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return;
	}

	stream.push({ type: "start", partial: { ...partial } });

	// ========== 逐内容块回放 ==========
	for (let index = 0; index < message.content.length; index++) {
		if (signal?.aborted) {
			const aborted = createAbortedMessage(partial);
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end(aborted);
			return;
		}

		const block = message.content[index];

		// 思考块：thinking_start → thinking_delta* → thinking_end
		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: index, partial: { ...partial } });
			for (const chunk of splitStringByTokenSize(block.thinking, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					const aborted = createAbortedMessage(partial);
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				(partial.content[index] as ThinkingContent).thinking += chunk;
				stream.push({ type: "thinking_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			stream.push({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: { ...partial },
			});
			continue;
		}

		// 文本块：text_start → text_delta* → text_end
		if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: index, partial: { ...partial } });
			for (const chunk of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
				await scheduleChunk(chunk, tokensPerSecond);
				if (signal?.aborted) {
					const aborted = createAbortedMessage(partial);
					stream.push({ type: "error", reason: "aborted", error: aborted });
					stream.end(aborted);
					return;
				}
				(partial.content[index] as TextContent).text += chunk;
				stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
			}
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: { ...partial } });
			continue;
		}

		// 工具调用块：参数 JSON 按 delta 流出，结束时替换为真实对象（与真实 API 的增量解析对齐）
		partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
		stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...partial } });
		for (const chunk of splitStringByTokenSize(JSON.stringify(block.arguments), minTokenSize, maxTokenSize)) {
			await scheduleChunk(chunk, tokensPerSecond);
			if (signal?.aborted) {
				const aborted = createAbortedMessage(partial);
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
				return;
			}
			stream.push({ type: "toolcall_delta", contentIndex: index, delta: chunk, partial: { ...partial } });
		}
		(partial.content[index] as ToolCall).arguments = block.arguments;
		stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: { ...partial } });
	}

	// ========== 终态收尾 ==========
	// pending 不是合法终态：脚本里漏配 stopReason 属测试编写错误，直接抛出
	if (message.stopReason === "pending") {
		throw new Error("Faux response ended without a stop reason");
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
		stream.end(message);
		return;
	}

	stream.push({ type: "done", reason: message.stopReason, message });
	stream.end(message);
}

/**
 * 创建 faux 核心状态机：响应队列、deferred 注册表、usage 模拟缓存与
 * stream/streamSimple/fetchDeferred/cancelDeferred 四个流式入口。
 * fauxProvider()（显式集合）与旧版全局注册共用这一核心。
 */
export function createFauxCore(options: RegisterFauxProviderOptions) {
	const api = options.api ?? randomId(DEFAULT_API);
	const provider = options.provider ?? DEFAULT_PROVIDER;
	// 归一化 token 粒度区间：min 至少为 1，且不超过 max
	const minTokenSize = Math.max(
		1,
		Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE),
	);
	const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
	let pendingResponses: FauxResponseStep[] = [];
	const tokensPerSecond = options.tokensPerSecond;
	const state: FauxProviderState = { callCount: 0, deferredFetchCount: 0, cancelledDeferred: [] };
	// sessionId → 上一轮完整 prompt 文本（模拟 prompt cache 命中判定）
	const promptCache = new Map<string, string>();
	// deferred 句柄 id → 待完成的延迟响应条目
	const deferredResponses = new Map<
		string,
		{
			handle: DeferredHandle;
			step: FauxResponseStep;
			context: Context;
			options: SimpleStreamOptions | undefined;
			model: Model<string>;
			pendingFetches: number;
			cancelled: boolean;
			final?: AssistantMessage;
		}
	>();

	// 未提供模型定义时给一个默认 faux-1（多模态、全零成本）
	const modelDefinitions = options.models?.length
		? options.models
		: [
				{
					id: DEFAULT_MODEL_ID,
					name: DEFAULT_MODEL_NAME,
					reasoning: false,
					input: ["text", "image"] as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 16384,
				},
			];
	const models = modelDefinitions.map((definition) => ({
		id: definition.id,
		name: definition.name ?? definition.id,
		api,
		provider,
		baseUrl: DEFAULT_BASE_URL,
		reasoning: definition.reasoning ?? false,
		input: definition.input ?? ["text", "image"],
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
	})) as [Model<string>, ...Model<string>[]];

	/** 解析单个响应步骤：工厂则执行（可异步），静态则直接用；克隆后附 usage 估算 */
	const resolveResponse = async (
		step: FauxResponseStep,
		context: Context,
		streamOptions: SimpleStreamOptions | undefined,
		requestModel: Model<string>,
	): Promise<AssistantMessage> => {
		const resolved = typeof step === "function" ? await step(context, streamOptions, state, requestModel) : step;
		return withUsageEstimate(
			cloneMessage(resolved, api, provider, requestModel.id),
			context,
			streamOptions,
			promptCache,
		);
	};

	/**
	 * 流式入口：从队列取出下一个步骤并回放。
	 * 队列空 → 错误终态「No more faux responses queued」（断言测试没漏排队）。
	 * 请求带 deferred 选项 → 不立即回放，登记句柄并流式返回 deferred 受理消息。
	 */
	const stream: StreamFunction<string, SimpleStreamOptions> = (requestModel, context, streamOptions) => {
		const outer = createAssistantMessageEventStream();
		const step = pendingResponses.shift();
		state.callCount++;

		// 微任务中执行异步回放：stream() 同步返回流，与真实 provider 的懒启动语义一致
		queueMicrotask(async () => {
			try {
				await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				if (!step) {
					let message = createErrorMessage(
						new Error("No more faux responses queued"),
						api,
						provider,
						requestModel.id,
					);
					message = withUsageEstimate(message, context, streamOptions, promptCache);
					outer.push({ type: "error", reason: "error", error: message });
					outer.end(message);
					return;
				}

				// 延迟响应模式：登记条目（含剩余 pendingFetches 计数），先回放「已受理」消息
				if (streamOptions?.deferred) {
					const handle: DeferredHandle = {
						provider: requestModel.provider,
						modelId: requestModel.id,
						api: requestModel.api,
						id: randomId("deferred"),
						...(options.deferred?.pollAfterMs !== undefined ? { pollAfterMs: options.deferred.pollAfterMs } : {}),
					};
					deferredResponses.set(handle.id, {
						handle,
						step,
						context,
						options: streamOptions,
						model: requestModel,
						pendingFetches: Math.max(0, Math.floor(options.deferred?.pendingFetches ?? 0)),
						cancelled: false,
					});
					await streamWithDeltas(
						outer,
						createDeferredMessage(requestModel, handle),
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						streamOptions.signal,
					);
					return;
				}

				const message = await resolveResponse(step, context, streamOptions, requestModel);
				await streamWithDeltas(outer, message, minTokenSize, maxTokenSize, tokensPerSecond, streamOptions?.signal);
			} catch (error) {
				const message = createErrorMessage(error, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	// faux 不区分 stream 与 streamSimple：两者行为完全一致
	const streamSimple: StreamFunction<string, SimpleStreamOptions> = (streamModel, context, streamOptions) =>
		stream(streamModel, context, streamOptions);

	/**
	 * 拉取延迟响应：句柄不匹配/已取消 → 错误终态。
	 * 仍有 pendingFetches → 先再回放一次「仍为 deferred」的受理消息（模拟轮询未就绪）。
	 * 就绪 → 解析脚本（首次解析时剥离提交时的 deferred/signal 等选项）并缓存 final 后完整回放。
	 */
	const fetchDeferred = (
		requestModel: Model<string>,
		handle: DeferredHandle,
		fetchOptions?: DeferredFetchOptions,
	): AssistantMessageEventStream => {
		const outer = createAssistantMessageEventStream();
		state.deferredFetchCount++;

		queueMicrotask(async () => {
			try {
				await fetchOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
				const entry = deferredResponses.get(handle.id);
				// 校验句柄归属（provider/modelId/api 三元组），防止跨 provider 误取
				if (
					!entry ||
					entry.handle.provider !== handle.provider ||
					entry.handle.modelId !== handle.modelId ||
					entry.handle.api !== handle.api
				) {
					throw new Error(`Unknown faux deferred response: ${handle.id}`);
				}
				if (entry.cancelled) throw new Error(`Faux deferred response was cancelled: ${handle.id}`);

				// 模拟「脚本响应尚未就绪」：继续返回受理消息，消耗一次 pending 计数
				if (entry.pendingFetches > 0) {
					entry.pendingFetches--;
					await streamWithDeltas(
						outer,
						createDeferredMessage(requestModel, entry.handle),
						minTokenSize,
						maxTokenSize,
						tokensPerSecond,
						fetchOptions?.signal,
					);
					return;
				}

				// 就绪：首次解析并缓存最终消息（后续 fetch 直接复用，不再执行工厂）
				if (!entry.final) {
					const {
						deferred: _deferred,
						signal: _submissionSignal,
						onResponse: _submissionOnResponse,
						...submissionOptions
					} = entry.options ?? {};
					try {
						entry.final = await resolveResponse(entry.step, entry.context, submissionOptions, entry.model);
					} catch (error) {
						entry.final = createErrorMessage(error, api, provider, entry.model.id);
					}
				}
				await streamWithDeltas(
					outer,
					entry.final,
					minTokenSize,
					maxTokenSize,
					tokensPerSecond,
					fetchOptions?.signal,
				);
			} catch (error) {
				const message = createErrorMessage(error, api, provider, requestModel.id);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		});

		return outer;
	};

	/** 取消延迟响应：记录句柄副本供断言，标记条目为已取消（后续 fetch 报错） */
	const cancelDeferred = async (
		requestModel: Model<string>,
		handle: DeferredHandle,
		cancelOptions?: DeferredCancelOptions,
	): Promise<void> => {
		state.cancelledDeferred.push(structuredClone(handle));
		const entry = deferredResponses.get(handle.id);
		if (entry) entry.cancelled = true;
		await cancelOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
	};

	/** 按模型 id 查找；无参时返回首个模型（单一模型的常见用法） */
	function getModel(): Model<string>;
	function getModel(requestedModelId: string): Model<string> | undefined;
	function getModel(requestedModelId?: string): Model<string> | undefined {
		if (!requestedModelId) {
			return models[0];
		}
		return models.find((candidate) => candidate.id === requestedModelId);
	}

	return {
		api,
		provider,
		models,
		stream,
		streamSimple,
		fetchDeferred,
		cancelDeferred,
		getModel,
		state,
		/** 整体替换响应队列 */
		setResponses(responses: FauxResponseStep[]) {
			pendingResponses = [...responses];
		},
		/** 向队列尾部追加步骤 */
		appendResponses(responses: FauxResponseStep[]) {
			pendingResponses.push(...responses);
		},
		/** 剩余待消费步骤数（测试断言「全部脚本已回放完」用） */
		getPendingResponseCount() {
			return pendingResponses.length;
		},
	};
}

/**
 * 基于显式 `Models` 集合的测试用 faux provider：
 *
 * ```ts
 * const faux = fauxProvider();
 * const models = createModels();
 * models.setProvider(faux.provider);
 * faux.setResponses([fauxAssistantMessage("hi")]);
 * ```
 */
export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProviderHandle {
	const core = createFauxCore(options);
	// 用标准 createProvider 组装：auth 是永远成功的空 apiKey（faux 无需凭据）
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: core.stream,
			streamSimple: core.streamSimple,
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});
	return {
		provider,
		api: core.api,
		models: core.models,
		getModel: core.getModel,
		state: core.state,
		setResponses: core.setResponses,
		appendResponses: core.appendResponses,
		getPendingResponseCount: core.getPendingResponseCount,
	};
}
