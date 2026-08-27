/**
 * @file pi-messages API 实现（pi 生态自有 Messages 协议）
 * @description 把 pi 自身的消息协议直接流式发给后端：请求是向 `<baseUrl>/messages`
 *              发送的单次 POST，请求体为 `{ model, context, options }`（统一 Context
 *              已接近协议原生形态，因此几乎无需转换）；响应是一条 SSE 流，内容为
 *              序列化的助手消息事件序列，并以 `done` / `error` 终结事件收尾。
 *              这是 Radius 网关使用的线上协议（wire protocol），但任何实现了该协议
 *              的后端都可以接入，例如通过 models.json 自定义 provider 并指定
 *              `"api": "pi-messages"`。
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	CacheRetention,
	Context,
	Model,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	ThinkingLevel,
	ToolCall,
} from "../types.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";

/** pi-messages 协议的流式请求选项：在通用 StreamOptions 之上补充协议专属参数。 */
export interface PiMessagesOptions extends StreamOptions {
	/** 推理（thinking）强度等级，原样透传给后端。 */
	reasoning?: ThinkingLevel;
	/** 工具选择策略：OpenAI 风格的 auto/none/required，或点名具体函数。 */
	toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
	/** 请求后端返回调试元数据（例如路由相关的响应头）。 */
	debug?: boolean;
}

/** 用量（usage）结构：直接复用 AssistantMessage 上的计费统计形态。 */
type PiMessagesUsage = AssistantMessage["usage"];
/** 停止原因：直接复用 AssistantMessage 上的 stopReason 取值集合。 */
type PiMessagesStopReason = AssistantMessage["stopReason"];

/**
 * 服务端改写（rewrite）消息的影响摘要（例如网关策略改写了请求上下文）。
 * 由后端随终结事件回传，客户端据此得知原始请求被如何调整。
 */
export type PiMessagesRewriteImpact = {
	/** 触发改写的策略 id。 */
	policyId: string;
	/** 策略版本号。 */
	policyVersion: number;
	/** 是否实际发生了改写。 */
	changed: boolean;
	/** 改写引起的 token 数变化（正为增加、负为减少）。 */
	tokenCountChange: number;
	/** 改写引起的消息条数变化。 */
	messageCountChange: number;
	/** 系统提示词是否被改写。 */
	systemPromptChanged: boolean;
};

/**
 * pi-messages 后端发来的序列化助手消息事件（SSE data 负载反序列化后的形态）。
 *
 * 事件时序：以 `start` 开场；text / thinking / toolcall 三类内容块共用
 * `<块>_start` → 若干 `<块>_delta` → `<块>_end` 的三段式骨架，
 * `contentIndex` 标识块在消息 content 数组中的位置；
 * 最终以 `done`（正常）或 `error`（异常）终结，两者都携带最终 usage，
 * 因此计费统计只在终结事件到达后才可信。
 */
export type PiMessagesEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| {
			type: "thinking_end";
			contentIndex: number;
			content: string;
			contentSignature?: string;
			redacted?: boolean;
	  }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	/** 正常终结事件：携带最终 stopReason、usage、响应 id 与可选的服务端改写摘要。 */
	| {
			type: "done";
			reason: Extract<PiMessagesStopReason, "stop" | "length" | "toolUse">;
			usage: PiMessagesUsage;
			responseId?: string;
			rewrite?: PiMessagesRewriteImpact;
	  }
	/** 异常终结事件：reason 为 aborted/error，携带 usage、错误信息与响应 id。 */
	| {
			type: "error";
			reason: Extract<PiMessagesStopReason, "aborted" | "error">;
			usage: PiMessagesUsage;
			errorMessage?: string;
			responseId?: string;
			rewrite?: PiMessagesRewriteImpact;
	  };

/**
 * HTTP 错误响应体的宽松形态：约定 error 对象内含 message / code / details 等字段。
 * 所有字段一律按 unknown 处理，使用前需逐字段做类型收窄。
 */
type PiMessagesErrorBody = {
	error?: {
		message?: unknown;
		code?: unknown;
		details?: unknown;
		[key: string]: unknown;
	};
};

/** pi-messages 后端返回非 2xx 时抛出的错误：在 Error 之上附带错误码与结构化诊断明细。 */
export class PiMessagesResponseError extends Error {
	/** 后端错误码（仅当 error.code 为字符串时有值）。 */
	code?: string;
	/** 结构化诊断明细（版本、provider、模型、URL、状态码、错误体等），供事后排查。 */
	readonly diagnosticDetails: Record<string, unknown>;

	/**
	 * @param message 人可读错误信息（已拼接状态码与后端错误详情）
	 * @param code 后端错误码（可能为 undefined）
	 * @param diagnosticDetails 随错误携带的结构化诊断明细
	 */
	constructor(message: string, code: string | undefined, diagnosticDetails: Record<string, unknown>) {
		super(message);
		this.name = "PiMessagesResponseError";
		this.code = code;
		this.diagnosticDetails = diagnosticDetails;
	}
}

/**
 * 尝试把响应体解析为 pi-messages 错误体。
 * 仅当 body 是合法 JSON 且含有非 null、非数组的 error 对象时才认可；
 * 其余情况（非 JSON、解析为 null、error 缺失或形态不对）一律返回 undefined，
 * 让调用方回落到使用原始 body 文本。
 *
 * @param body 原始响应体文本
 * @returns 解析成功时返回错误体，否则返回 undefined
 */
function parsePiMessagesErrorBody(body: string): PiMessagesErrorBody | undefined {
	try {
		const parsed = JSON.parse(body) as PiMessagesErrorBody | null;
		const error = parsed?.error;
		// 逐项校验 error 形态：必须是对象（排除 null 与数组），否则视为非错误体
		return parsed && typeof error === "object" && error !== null && !Array.isArray(error) ? parsed : undefined;
	} catch {
		// JSON.parse 失败说明 body 不是结构化错误（如纯文本或 HTML 错误页）
		return undefined;
	}
}

/** 截断诊断用字符串：超过 8192 字符时截断并追加省略号，避免诊断记录携带超大 body。 */
function truncateDiagnosticString(value: string): string {
	const maxLength = 8192;
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * 组装人可读的响应错误信息，形如 `404 Not Found: <详情> (code)`。
 * 详情优先取错误体中的 error.message，取不到时退回原始 body 文本；
 * 存在字符串型错误码时以 `(code)` 形式追加在末尾。
 *
 * @param response HTTP 响应（取 status / statusText）
 * @param body 原始响应体文本
 * @param errorBody 已解析的错误体（可能为 undefined）
 * @returns 拼接完成的错误信息字符串
 */
function formatPiMessagesResponseError(
	response: Response,
	body: string,
	errorBody: PiMessagesErrorBody | undefined,
): string {
	const message = typeof errorBody?.error?.message === "string" ? errorBody.error.message : undefined;
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	const suffix = message ?? body;
	const codeSuffix = code ? ` (${code})` : "";
	return `${response.status} ${response.statusText}: ${suffix}${codeSuffix}`;
}

/**
 * 构造非 2xx 响应对应的 PiMessagesResponseError。
 * 除错误消息与错误码外，还会打包一份结构化诊断明细
 * （诊断版本、provider/模型、请求 URL、状态码、错误体与时间戳），
 * 供后续把它挂到助手消息的 diagnostics 上排查问题。
 *
 * @param model 本次请求的模型
 * @param url 实际请求的 URL
 * @param response 非 2xx 的 HTTP 响应
 * @param body 原始响应体文本
 * @returns 可直接抛出的 PiMessagesResponseError
 */
function createPiMessagesResponseError(
	model: Model<"pi-messages">,
	url: URL,
	response: Response,
	body: string,
): PiMessagesResponseError {
	const errorBody = parsePiMessagesErrorBody(body);
	const code = typeof errorBody?.error?.code === "string" ? errorBody.error.code : undefined;
	return new PiMessagesResponseError(formatPiMessagesResponseError(response, body, errorBody), code, {
		version: 1,
		provider: model.provider,
		model: model.id,
		url: url.toString(),
		status: response.status,
		statusText: response.statusText,
		error: errorBody?.error,
		// 错误体解析成功时记录结构化 error 即可；失败时退回记录截断后的原始 body 文本
		body: errorBody ? undefined : truncateDiagnosticString(body),
		timestampMs: Date.now(),
	});
}

/** 构造全零 usage：本地构造的错误/中止消息没有真实计费数据，用它占位。 */
function createEmptyUsage(): PiMessagesUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * 把服务端改写摘要追加到助手消息的 diagnostics 上（诊断类型 pi_messages_rewrite）。
 *
 * @param message 目标助手消息（原地追加诊断记录）
 * @param rewrite 终结事件携带的改写摘要；为空时直接返回（无可记录内容）
 */
function appendRewriteDiagnostic(message: AssistantMessage, rewrite: PiMessagesRewriteImpact | undefined): void {
	if (!rewrite) {
		return;
	}
	appendAssistantMessageDiagnostic(message, {
		type: "pi_messages_rewrite",
		timestamp: Date.now(),
		details: { ...rewrite },
	});
}

/**
 * 创建 wire 事件 → AssistantMessageEvent 的有状态转换器。
 *
 * 内部维护同一个 partial（增量构建中的助手消息）：每收到一个 wire 事件就原地更新它，
 * 并把同一个引用附在返回的事件上，因此消费端在任意时刻读到的都是
 * 「截至当前事件」的完整消息快照；done/error 终结事件时 partial 即最终消息。
 *
 * @param model 本次请求的模型（用于填充消息的 api / provider / model 元信息）
 * @returns 转换函数：输入 wire 事件，输出附带 partial 引用的 AssistantMessageEvent
 */
function createEventConverter(model: Model<"pi-messages">) {
	// ========== 增量构建中的助手消息：所有事件共享并原地更新同一个引用 ==========
	const partial: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: "pending",
		timestamp: Date.now(),
	};
	// 工具调用块的原始 JSON 参数缓冲：contentIndex → 已收到的 JSON 片段累积结果
	const toolJson = new Map<number, string>();

	return (event: PiMessagesEvent): AssistantMessageEvent => {
		switch (event.type) {
			// ========== 终结事件：回填最终 stopReason / usage，返回最终消息 ==========
			case "done":
				Object.assign(partial, {
					stopReason: event.reason,
					usage: event.usage,
					responseId: event.responseId,
				});
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "done", reason: event.reason, message: partial };
			// 异常终结：在 partial 上额外回填服务端 errorMessage
			case "error":
				Object.assign(partial, {
					stopReason: event.reason,
					usage: event.usage,
					errorMessage: event.errorMessage,
					responseId: event.responseId,
				});
				appendRewriteDiagnostic(partial, event.rewrite);
				return { type: "error", reason: event.reason, error: partial };
			// ========== 内容块事件：start 建块占位、delta 增量拼接、end 以服务端权威结果收口 ==========
			case "start":
				// start 仅标志流开始，无需改动 partial
				break;
			case "text_start":
				// 在 contentIndex 对应位置放置空文本块占位
				partial.content[event.contentIndex] = { type: "text", text: "" };
				break;
			case "text_delta":
				// 增量追加文本
				(partial.content[event.contentIndex] as { text: string }).text += event.delta;
				break;
			case "text_end":
				// 以服务端最终全文覆盖本地拼接结果（并记录签名），消除 delta 拼接可能引入的偏差
				Object.assign(partial.content[event.contentIndex]!, {
					text: event.content,
					textSignature: event.contentSignature,
				});
				break;
			case "thinking_start":
				// 在对应位置放置空思维链块占位
				partial.content[event.contentIndex] = { type: "thinking", thinking: "" };
				break;
			case "thinking_delta":
				// 增量追加思维链文本
				(partial.content[event.contentIndex] as { thinking: string }).thinking += event.delta;
				break;
			case "thinking_end":
				// 同样以服务端权威内容收口；redacted 标记思维链被服务端加密/遮蔽
				Object.assign(partial.content[event.contentIndex]!, {
					thinking: event.content,
					thinkingSignature: event.contentSignature,
					redacted: event.redacted,
				});
				break;
			case "toolcall_start":
				// 放置参数为空对象的工具调用块，并为该块开启 JSON 参数累积缓冲
				partial.content[event.contentIndex] = {
					type: "toolCall",
					id: event.id,
					name: event.toolName,
					arguments: {},
				};
				toolJson.set(event.contentIndex, "");
				break;
			case "toolcall_delta": {
				// 累积 JSON 片段并用流式容错解析即时还原 arguments：
				// 即使 JSON 尚未闭合，也能解析出已完成的部分
				const json = `${toolJson.get(event.contentIndex) ?? ""}${event.delta}`;
				toolJson.set(event.contentIndex, json);
				(partial.content[event.contentIndex] as ToolCall).arguments =
					parseStreamingJson<ToolCall["arguments"]>(json);
				break;
			}
			case "toolcall_end":
				// 以服务端返回的完整 toolCall 覆盖本地结果并清理缓冲；
				// 注意本分支显式 return（事件需携带 contentIndex 与最终 toolCall）
				Object.assign(partial.content[event.contentIndex]!, event.toolCall);
				toolJson.delete(event.contentIndex);
				return {
					type: "toolcall_end",
					contentIndex: event.contentIndex,
					toolCall: partial.content[event.contentIndex] as ToolCall,
					partial,
				};
		}

		// 其余事件（start / 各类 start、delta、end）原样透传，仅附加 partial 引用，
		// 供消费端在流式过程中增量渲染消息
		return { ...event, partial } as AssistantMessageEvent;
	};
}

/**
 * 从 HTTP 响应体流中读取 SSE 并逐个产出 wire 事件。
 *
 * 手动做 SSE 分帧（而非使用 EventSource）：输入是 POST 响应的 ReadableStream，
 * 而 EventSource 只能发起 GET 请求。帧以空行（\n\n）分隔，
 * 不完整的帧留在缓冲区等待下一个 chunk 补齐。
 *
 * @param stream fetch 响应的字节流
 * @yields 解析出的 wire 事件（跳过 [DONE] 哨兵等非事件帧）
 */
async function* readPiMessagesEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<PiMessagesEvent> {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			// 流结束时调用无参 decode() 冲刷解码器内部残留的多字节序列，避免丢尾字符
			buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
			// 统一 CRLF 为 LF，兼容两种换行风格的 SSE 输出
			buffer = buffer.replace(/\r\n/g, "\n");

			// 循环取出缓冲区中所有已完整的帧（以 \n\n 为界）
			let split = buffer.indexOf("\n\n");
			while (split !== -1) {
				const event = parsePiMessagesEvent(buffer.slice(0, split));
				if (event) {
					yield event;
				}
				// 丢掉已消费的帧与分隔符（\n\n 占 2 个字符）
				buffer = buffer.slice(split + 2);
				split = buffer.indexOf("\n\n");
			}

			if (done) {
				break;
			}
		}

		// 流结束时缓冲区可能残留最后一帧（无空行收尾），也尝试解析产出
		if (buffer.trim()) {
			const event = parsePiMessagesEvent(buffer);
			if (event) {
				yield event;
			}
		}
	} finally {
		// 无论正常结束还是提前退出（如消费方 break），都释放 reader 锁
		reader.releaseLock();
	}
}

/**
 * 解析单帧 SSE 原始文本：取出其中第一个 `data:` 行的负载并 trim。
 * `data: [DONE]` 是 OpenAI 风格的流结束哨兵，这里映射为 undefined
 * （流结束语义由 done/error 终结事件承担，缺失时上层会报协议错误）。
 * 注意：负载 JSON 非法时 JSON.parse 直接抛出，由外层统一转为 error 事件。
 *
 * @param raw 单帧 SSE 文本（不含 \n\n 分隔符）
 * @returns 解析出的 wire 事件；无 data 行或为 [DONE] 哨兵时返回 undefined
 */
function parsePiMessagesEvent(raw: string): PiMessagesEvent | undefined {
	const data = raw
		.split("\n")
		.find((line) => line.startsWith("data:"))
		?.slice(5)
		.trim();

	return data && data !== "[DONE]" ? (JSON.parse(data) as PiMessagesEvent) : undefined;
}

/**
 * 为本地（非后端）异常构造 error 终结事件。
 *
 * abort 语义：调用方 signal 已中止时 stopReason 记为 "aborted" 而非 "error"，
 * 便于上层区分主动取消与真实故障；两条路径的 usage 都是本地造的全零占位值。
 * 仅在非 abort 且错误为 PiMessagesResponseError（HTTP 层失败）时，
 * 额外把结构化诊断记录挂到消息的 diagnostics 上。
 *
 * @param model 本次请求的模型
 * @param error 捕获到的异常
 * @param aborted 调用方是否已主动中止本次请求
 * @returns 可直接推入事件流的 error 终结事件
 */
function createErrorEvent(model: Model<"pi-messages">, error: unknown, aborted: boolean): AssistantMessageEvent {
	const reason = aborted ? "aborted" : "error";
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason: reason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};

	if (!aborted && error instanceof PiMessagesResponseError) {
		appendAssistantMessageDiagnostic(
			assistantMessage,
			createAssistantMessageDiagnostic("pi_messages_response_failure", error, error.diagnosticDetails),
		);
	}

	return { type: "error", reason, error: assistantMessage };
}

/**
 * 解析提示词缓存保留时长。
 * 显式参数优先；未设置时仅识别旧版环境变量 PI_CACHE_RETENTION=long 的 opt-in，
 * 其余情况返回 undefined，交由后端默认值处理。
 *
 * @param cacheRetention 调用方显式传入的缓存保留偏好
 * @param env provider 级环境变量覆盖
 * @returns 实际生效的缓存保留时长；未指定时为 undefined
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention | undefined {
	if (cacheRetention) {
		return cacheRetention;
	}
	// 未设置时由后端默认值接管；这里只映射旧版环境变量的显式 opt-in。
	return getProviderEnvValue("PI_CACHE_RETENTION", env) === "long" ? "long" : undefined;
}

/**
 * pi-messages 的流式入口（StreamFunction 契约实现）。
 *
 * 请求形态：向 `<baseUrl>/messages` 发送单次 POST，Bearer 认证、Accept 为
 * text/event-stream，请求体 `{ model, context, options }` —— 统一 Context 原样直传，
 * 不做 provider 侧的消息格式转换。响应形态：SSE 流，事件经转换器累积成
 * AssistantMessage 推入事件流，收到 done/error 终结事件即结束。
 *
 * 遵循 StreamFunction 契约：函数同步返回事件流，请求在后台异步执行；
 * 任何失败（缺 key、HTTP 错误、流中断）都编码为流内的 error 事件而不是抛出异常。
 *
 * @param model 目标模型（提供 baseUrl / provider / id）
 * @param context 统一上下文（消息历史、系统提示词、工具定义）
 * @param options 流式与协议选项
 * @returns 立即返回的事件流，结果全部经流交付
 */
export const stream: StreamFunction<"pi-messages", PiMessagesOptions> = (
	model: Model<"pi-messages">,
	context: Context,
	options?: PiMessagesOptions,
): AssistantMessageEventStream => {
	const eventStream = new AssistantMessageEventStream();
	const convertEvent = createEventConverter(model);

	// 整个「请求 - 消费」流程在后台异步执行；void 显式忽略返回的 Promise（结果经流交付）
	void (async () => {
		try {
			// ========== 前置校验与请求构造 ==========
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key provided for provider "${model.provider}"`);
			}

			// 去掉 baseUrl 末尾多余斜杠后拼接 /messages 端点
			const url = new URL(`${model.baseUrl.replace(/\/+$/u, "")}/messages`);
			// debug 模式通过查询参数告知后端返回调试元数据
			if (options?.debug) {
				url.searchParams.set("debug", "1");
			}

			// ========== 组装请求体：model + 原样 context + 采样/推理/缓存等选项 ==========
			// 未设置的选项字段为 undefined，JSON.stringify 序列化时会省略，后端按默认值处理
			let payload: unknown = {
				model: model.id,
				context,
				options: {
					temperature: options?.temperature,
					maxTokens: options?.maxTokens,
					reasoning: options?.reasoning,
					cacheRetention: resolveCacheRetention(options?.cacheRetention, options?.env),
					sessionId: options?.sessionId,
					toolChoice: options?.toolChoice,
				},
			};
			// 发送前钩子：允许调用方检视或整体替换请求体；返回 undefined 表示保持不变
			const nextPayload = await options?.onPayload?.(payload, model);
			if (nextPayload !== undefined) {
				payload = nextPayload;
			}

			// 发起 POST（可注入自定义 fetch 实现；signal 负责取消本次请求）
			const response = await (options?.fetch ?? globalThis.fetch)(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					accept: "text/event-stream",
					"content-type": "application/json",
					...providerHeadersToRecord(options?.headers),
				},
				body: JSON.stringify(payload),
				signal: options?.signal,
			});

			// 响应头回调：在检查 response.ok 之前触发，非 2xx 时调用方同样能拿到状态码与响应头
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);

			// ========== 错误分支：非 2xx 或空响应体 ==========
			if (!response.ok) {
				// 读出错误响应体文本，构造携带后端错误详情与诊断明细的错误
				const body = await response.text();
				throw createPiMessagesResponseError(model, url, response, body);
			}
			if (!response.body) {
				throw new Error(`${model.provider} response has no body`);
			}

			// ========== 消费 SSE 事件流：转换后推入事件流，直到终结事件 ==========
			for await (const piEvent of readPiMessagesEvents(response.body)) {
				const event = convertEvent(piEvent);
				eventStream.push(event);
				// done/error 是完成事件：push 后流自动终结，此处 return 结束后台任务
				if (event.type === "done" || event.type === "error") {
					return;
				}
			}

			// 流耗尽却未见到任何终结事件：视为后端协议违约，抛错走统一错误路径
			throw new Error(`${model.provider} stream ended without a terminal event`);
		} catch (error) {
			// 所有异常统一转为 error 事件推入流；signal 已中止时归类为 aborted 而非 error
			eventStream.push(createErrorEvent(model, error, options?.signal?.aborted ?? false));
		}
	})();

	return eventStream;
};

/**
 * 简化流式入口：把 SimpleStreamOptions 适配为 PiMessagesOptions 后委托 stream()。
 * reasoning / toolChoice 本就是 SimpleStreamOptions 的统一字段，这里原样转发；
 * 协议专属的 debug 开关则借助结构化类型从调用方的扩展键中提取（可能不存在）。
 */
export const streamSimple: StreamFunction<"pi-messages", SimpleStreamOptions> = (
	model: Model<"pi-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const extra = options as PiMessagesOptions | undefined;
	return stream(model, context, {
		...options,
		reasoning: options?.reasoning,
		toolChoice: options?.toolChoice,
		debug: extra?.debug,
	});
};
