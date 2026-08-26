/**
 * @file proxy.ts
 * @description LLM 流式调用的代理（proxy）转发层：为需要把 LLM 请求经由自建服务端中转的应用提供 streamFn 实现。
 *
 * 主要功能点：
 * - `streamProxy`：可直接作为 Agent `streamFn` 选项的流式函数，向代理服务端的 `/api/stream` 发起 POST 请求；
 * - 消费服务端下发的 SSE 事件流（`data: <JSON>` 行）；服务端已剥离事件中的 `partial` 字段以节省带宽，
 *   客户端通过 `processProxyEvent` 在本地逐事件重建完整的 partial 消息；
 * - 统一处理本地 AbortSignal 中止、HTTP 错误与服务端 error 事件，均转换为流上的 error 事件。
 *
 * 依赖关系：基于 `@earendil-works/pi-ai` 的 EventStream 基类、AssistantMessageEvent 等类型，
 * 以及 `parseStreamingJson` 流式 JSON 解析工具；LLM 凭证由代理服务端统一管理，客户端不直连 LLM 提供商。
 */

// 内部导入：pi-ai 的类型、EventStream 基类与流式 JSON 解析工具 parseStreamingJson
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@earendil-works/pi-ai";

// 创建本模块专用的事件流类 ProxyMessageEventStream
/**
 * 代理模式下的 assistant 事件流：继承 pi-ai 的 EventStream 基类，
 * 使 `streamProxy` 的返回值满足 Agent 对 `streamFn` 的类型约定。
 */
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			// 结束谓词：收到 done 或 error 事件即视为流终止
			(event) => event.type === "done" || event.type === "error",
			// 结果提取器：done 事件取最终消息，error 事件取携带错误的 partial 消息
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * 代理事件类型 —— 服务端下发的精简事件。
 *
 * 与 pi-ai 的 AssistantMessageEvent 一一对应，但剥离了 `partial` 字段以降低带宽占用，
 * 由客户端在 `processProxyEvent` 中据此重建 partial 消息。
 * `done`/`error` 事件的 reason 各自仅保留允许的 StopReason 子集。
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

// 可随请求安全 JSON 序列化并发给代理服务端的流式选项子集（排除 signal/authToken/proxyUrl 等仅客户端本地使用的字段）
type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "samplingParams"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

/**
 * `streamProxy` 的完整选项：可序列化的采样/请求选项，叠加代理连接所需的本地字段。
 */
export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** 代理请求的本地中止信号（AbortSignal） */
	signal?: AbortSignal;
	/** 访问代理服务端的认证 token */
	authToken: string;
	/** 代理服务端 URL（例如 "https://genai.example.com"） */
	proxyUrl: string;
}

/**
 * （注：此段文档描述的是本文件的主入口 `streamProxy`，见下方函数定义。）
 *
 * 流式函数：经由代理服务端转发请求，而非由客户端直连 LLM 提供商。
 * 服务端会从 delta 事件中剥离 partial 字段以降低带宽占用，
 * partial 消息由客户端在本地重建。
 *
 * 创建需要经由代理的 Agent 时，将本函数作为 `streamFn` 选项传入。
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */

/**
 * 从完整选项中挑出可序列化的字段，构建发往代理服务端的请求选项。
 * signal/authToken/proxyUrl 仅在客户端本地使用，不应随请求体发给服务端。
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		samplingParams: options.samplingParams,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

/**
 * 通过代理服务端转发 LLM 调用的流式函数（streamFn，用法见上方示例）。
 *
 * 流程：立即返回事件流 → 后台异步 fetch 代理服务端 → 逐行解析 SSE →
 * 重建 partial 消息并把事件推入流。网络异常、HTTP 错误、用户中止与服务端
 * error 事件统一转换为流上的 error 事件。
 *
 * @param model 目标模型描述（原样序列化传给服务端）
 * @param context 对话上下文（原样序列化传给服务端）
 * @param options 代理连接信息与可序列化的采样选项
 * @returns 立即返回的 ProxyMessageEventStream，事件在后台异步填充
 */
export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// ========== 初始化 partial 消息 ==========
		// 服务端事件已剥离 partial 字段，这里在客户端逐事件累积、重建这条 assistant 消息
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "pending",
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
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		// 用户中止时取消底层 reader，打断 read() 等待，及时结束流读取
		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		try {
			// ========== 发起代理请求 ==========
			// POST 目标模型、对话上下文与（经 buildProxyRequestOptions 过滤的）采样选项；凭证走 Authorization 头
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: options.signal,
			});

			// 非 2xx 响应：优先采用服务端返回的 JSON 错误信息，否则退回状态码文本
			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// 错误响应体不是合法 JSON，忽略并沿用默认错误信息
				}
				throw new Error(errorMessage);
			}

			// ========== 解析 SSE 事件流 ==========
			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			// 行缓冲：SSE 事件按行分隔，一个 chunk 可能包含多条完整事件或半条事件，半行留待下个 chunk 拼接
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				// 每读完一个 chunk 复查中止状态，确保 reader.cancel 之外的中止路径也能及时感知
				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				// 末行可能不以换行符结尾（不完整），放回缓冲区等待下一块数据
				buffer = lines.pop() || "";

				for (const line of lines) {
					// SSE 数据行格式为 "data: <JSON>"
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data) {
							const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
							// 将精简的代理事件映射回完整事件并更新 partial，随后推入本地流
							const event = processProxyEvent(proxyEvent, partial);
							if (event) {
								stream.push(event);
							}
						}
					}
				}
			}

			// 流读完后再次确认中止状态：用户已中止时不把本次当作成功结束
			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			stream.end();
		} catch (error) {
			// 统一错误出口：网络异常、HTTP 错误、用户中止都在此转换为流上的 error 事件；
			// 已中止映射为 reason="aborted"，其余映射为 "error"
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			// 无论成功与否都移除 abort 监听，避免监听器泄漏
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
		}
	})();

	return stream;
}

/**
 * 处理单个代理事件：就地更新 partial 消息，并返回与之对应的完整 AssistantMessageEvent。
 *
 * @param proxyEvent 服务端下发的精简事件（不含 partial 字段）
 * @param partial 客户端持续重建的 assistant 消息，会被本函数就地修改
 * @returns 对应的 AssistantMessageEvent；无法映射时（如 toolcall_end 的内容类型不匹配）返回 undefined
 * @throws 当 delta/end 事件对应的 contentIndex 上不是预期的内容块类型时抛错，说明事件流已错乱
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		// 会话开始：透传并附带当前 partial
		case "start":
			return { type: "start", partial };

		// 文本块三连：start 时在对应槽位初始化空文本块
		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		// 追加文本增量
		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		// 写入内容签名（缓存用），返回累积完成的完整文本
		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		// thinking（推理）块三连：与 text 三连完全同构，只是作用于推理内容
		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		// 追加推理内容增量
		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		// 写入推理内容签名，返回累积完成的完整推理内容
		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		// 工具调用块：先建占位结构；partialJson 为客户端临时字段，用于累积尚未完成的流式 JSON 参数
		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			} satisfies ToolCall & { partialJson: string } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		// 追加增量 JSON，并用 parseStreamingJson 实时解析出当前可识别的参数对象
		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				(content as any).partialJson += proxyEvent.delta;
				content.arguments = parseStreamingJson((content as any).partialJson) || {};
				partial.content[proxyEvent.contentIndex] = { ...content }; // 以新对象替换原引用，触发响应式更新
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		// 用服务端给出的完整 toolCall 覆盖本地累积结果（保证参数最终一致），并删除临时的 partialJson 字段；
		// 注意：此处内容类型不匹配时不抛错，仅返回 undefined
		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				Object.assign(content, proxyEvent.toolCall);
				delete (content as any).partialJson;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		// 正常结束：回填停止原因与用量统计，返回重建完成的最终消息
		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		// 服务端报告错误：回填停止原因、错误信息与用量统计
		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		// 穷尽性检查（exhaustive check）：新增事件类型但未处理时在此告警
		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
