/**
 * @file pi-agent-core（@earendil-works/pi-agent-core）的核心类型定义文件。
 *
 * @description
 * 集中定义 Agent 循环 (agent loop) 运行所需的全部公共契约类型：
 * - `StreamFn`：发往 LLM 提供方的流式请求函数签名（`Models.streamSimple` 满足该签名）；
 * - `AgentLoopConfig` 及其配套的钩子上下文/返回值类型（`beforeToolCall`、`afterToolCall`、
 *   `shouldStopAfterTurn`、`prepareNextTurn`、steering / follow-up 消息注入等）；
 * - `AgentMessage` / `CustomAgentMessages`：在 `@earendil-works/pi-ai` 的 LLM 消息之上
 *   支持应用自定义消息类型的可扩展消息模型；
 * - `AgentState`（Agent 对外暴露的运行时状态）、`AgentTool` / `AgentToolResult`（工具定义与结果）、
 *   `AgentContext`（传入底层循环的上下文快照）；
 * - `AgentEvent`：Agent 对外发布的事件联合类型，供 UI 层更新使用。
 *
 * 这些类型被 `agent.ts`（Agent 类）、`agent-loop.ts`（底层循环）与 harness（宿主层）等
 * 模块共同引用，是整个框架的类型契约层。
 */
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

/**
 * Agent 循环使用的流式请求函数。`Models.streamSimple` 满足此签名。
 *
 * 契约：
 * - 遇到请求/模型/运行时错误时不得抛出异常，也不得返回 rejected promise。
 * - 必须返回一个 AssistantMessageEventStream。
 * - 失败必须以协议事件的形式编码进返回的流中，并以一条 stopReason 为 "error" 或
 *   "aborted"、携带 errorMessage 的最终 AssistantMessage 收尾。
 */
export type StreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

/**
 * 配置单条 assistant 消息中的多个工具调用如何执行。
 *
 * - "sequential"（串行）：每个工具调用依次完成准备、执行、收尾之后，下一个才开始。
 * - "parallel"（并行）：各工具调用先串行完成准备，然后被允许并行的工具并发执行。
 *   每个工具收尾后按工具完成顺序发出 `tool_execution_end`，
 *   而工具结果消息产物稍后按 assistant 消息中的原始顺序发出。
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * 控制 Agent 循环到达队列排水点 (queue drain point) 时，一次注入多少条排队的用户消息。
 *
 * - "all"：在该排水点注入全部排队消息。
 * - "one-at-a-time"：只注入最旧的一条排队消息，其余留在队列中等待后续排水点。
 */
export type QueueMode = "all" | "one-at-a-time";

/** assistant 消息中发出的单个工具调用内容块。 */
export type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * `beforeToolCall` 钩子的返回值。
 *
 * 返回 `{ block: true }` 会阻止该工具执行，循环会改为发出一条错误的工具结果。
 * `reason` 会成为该错误结果中展示的文本；若省略，则使用默认的拦截提示消息。
 */
export interface BeforeToolCallResult {
	/** 是否拦截本次工具调用（阻止其执行）。 */
	block?: boolean;
	/** 拦截原因，作为错误工具结果中展示的文本。 */
	reason?: string;
	/**
	 * 提示 Agent 在当前工具批次结束后停止（仅当本次调用被拦截时生效）。
	 * 只有当批次中每个已收尾的工具结果都将此标记设为 true 时，才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * `afterToolCall` 钩子返回的部分覆盖值。
 *
 * 合并语义为逐字段覆盖：
 * - `content`：提供时整体替换工具结果的 content 数组
 * - `details`：提供时整体替换工具结果的 details 值
 * - `isError`：提供时替换工具结果的错误标记
 * - `usage`：提供时替换工具结果的 usage
 * - `terminate`：提供时替换提前终止提示
 *
 * 省略的字段保持工具实际执行结果的原始值。
 * `content`、`details`、`usage` 均不做深度合并。
 */
export interface AfterToolCallResult {
	/** 覆盖工具结果的 content 数组（整体替换）。 */
	content?: (TextContent | ImageContent)[];
	/** 覆盖工具结果的 details 值（整体替换）。 */
	details?: unknown;
	/** 覆盖工具结果的错误标记。 */
	isError?: boolean;
	/** 工具最终执行自身产生的 usage（如有）。不计入主 LLM 上下文的 token 统计。 */
	usage?: Usage;
	/**
	 * 提示 Agent 在当前工具批次结束后停止。
	 * 只有当批次中每个已收尾的工具结果都将此标记设为 true 时，才会提前终止。
	 */
	terminate?: boolean;
}

/** 传给 `beforeToolCall` 钩子的上下文。 */
export interface BeforeToolCallContext {
	/** 请求本次工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** 取自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 已按目标工具 schema 校验通过的工具参数。 */
	args: unknown;
	/** 准备本次工具调用时的当前 Agent 上下文。 */
	context: AgentContext;
}

/** 传给 `afterToolCall` 钩子的上下文。 */
export interface AfterToolCallContext {
	/** 请求本次工具调用的 assistant 消息。 */
	assistantMessage: AssistantMessage;
	/** 取自 `assistantMessage.content` 的原始工具调用块。 */
	toolCall: AgentToolCall;
	/** 已按目标工具 schema 校验通过的工具参数。 */
	args: unknown;
	/** 工具实际执行的结果（尚未应用任何 `afterToolCall` 覆盖）。 */
	result: AgentToolResult<any>;
	/** 该工具执行结果当前是否被视为错误。 */
	isError: boolean;
	/** 本次工具调用收尾时的当前 Agent 上下文。 */
	context: AgentContext;
}

/** 传给 `shouldStopAfterTurn` 钩子的上下文。 */
export interface ShouldStopAfterTurnContext {
	/** 完成本轮 (turn) 的 assistant 消息。 */
	message: AssistantMessage;
	/** 传给前一个 `turn_end` 事件的工具结果消息。 */
	toolResults: ToolResultMessage[];
	/** 本轮 assistant 消息与工具结果均已追加进上下文之后的当前 Agent 上下文。 */
	context: AgentContext;
	/** 若循环在此时退出，本次调用将返回的消息。prompt 运行包含初始 prompt 消息；continuation 运行不包含既有上下文消息。 */
	newMessages: AgentMessage[];
}

/** Agent 循环在发起下一次提供方请求前使用的替换运行时状态。 */
export interface AgentLoopTurnUpdate {
	/** 下一次提供方请求使用的上下文。 */
	context?: AgentContext;
	/** 下一次提供方请求使用的模型。 */
	model?: Model<any>;
	/** 下一次提供方请求使用的思考级别。 */
	thinkingLevel?: ThinkingLevel;
}

/** 传给 `prepareNextTurn` 钩子的上下文，字段与 `ShouldStopAfterTurnContext` 相同。 */
export interface PrepareNextTurnContext extends ShouldStopAfterTurnContext {}

/**
 * Agent 循环的配置，扩展自 `SimpleStreamOptions`（其余流式选项透传给底层 LLM 请求）。
 *
 * 除本次运行使用的模型与消息转换函数外，还包含各类生命周期钩子：
 * 上下文变换、动态 API key 解析、按轮停止判断、下一轮准备、steering / follow-up
 * 消息注入，以及工具执行前后的拦截与改写钩子。
 */
export interface AgentLoopConfig extends SimpleStreamOptions {
	/** 本次运行使用的模型。 */
	model: Model<any>;

	/**
	 * 在每次调用 LLM 前，把 AgentMessage[] 转换为 LLM 兼容的 Message[]。
	 *
	 * 每条 AgentMessage 都必须被转换为 LLM 能理解的 UserMessage、AssistantMessage
	 * 或 ToolResultMessage。无法转换的 AgentMessage（如仅供 UI 展示的通知、状态消息）
	 * 应被过滤掉。
	 *
	 * 契约：不得抛出异常或 reject，应返回安全的兜底值。
	 * 抛出异常会中断底层 Agent 循环，且不会产生正常的事件序列。
	 *
	 * @example
	 * ```typescript
	 * convertToLlm: (messages) => messages.flatMap(m => {
	 *   if (m.role === "custom") {
	 *     // 把自定义消息转换为 user 消息
	 *     return [{ role: "user", content: m.content, timestamp: m.timestamp }];
	 *   }
	 *   if (m.role === "notification") {
	 *     // 过滤掉仅供 UI 展示的消息
	 *     return [];
	 *   }
	 *   // 标准 LLM 消息直接透传
	 *   return [m];
	 * })
	 * ```
	 */
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;

	/**
	 * 可选变换：在 `convertToLlm` 之前应用于上下文。
	 *
	 * 用于在 AgentMessage 层面进行的操作：
	 * - 上下文窗口管理（裁剪旧消息）
	 * - 从外部来源注入上下文
	 *
	 * 契约：不得抛出异常或 reject。应返回原始消息或其他安全的兜底值。
	 *
	 * @example
	 * ```typescript
	 * transformContext: async (messages) => {
	 *   if (estimateTokens(messages) > MAX_TOKENS) {
	 *     return pruneOldMessages(messages);
	 *   }
	 *   return messages;
	 * }
	 * ```
	 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

	/**
	 * 为每次 LLM 调用动态解析 API key。
	 *
	 * 适用于可能在长时间工具执行阶段过期的短时效 OAuth token（如 GitHub Copilot）。
	 *
	 * 契约：不得抛出异常或 reject。拿不到 key 时返回 undefined。
	 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;

	/**
	 * 每轮完全结束、`turn_end` 已发出后调用。
	 *
	 * 若返回 true，循环会发出 `agent_end` 并退出——在轮询 steering 或 follow-up 队列之前、
	 * 也不发起新的 LLM 调用。当前的 assistant 响应及所有工具执行仍会正常完成。
	 *
	 * 可用于请求在当前轮之后优雅停止，例如在上下文快满之前。
	 *
	 * 契约：不得抛出异常或 reject。抛出异常会中断底层 Agent 循环，且不会产生正常的事件序列。
	 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext) => boolean | Promise<boolean>;

	/**
	 * 在 `turn_end` 之后、循环决定是否发起下一次提供方请求之前调用。
	 * 返回替换的 context/model/thinking 状态即可影响本次运行中的下一轮。
	 * 返回 undefined 则继续使用当前的上下文/配置。
	 */
	prepareNextTurn?: (
		context: PrepareNextTurnContext,
	) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;

	/**
	 * 返回要在运行中途注入会话的 steering（转向）消息。
	 *
	 * 在当前 assistant 轮执行完其工具调用之后调用（除非 `shouldStopAfterTurn` 已先行退出）。
	 * 若返回消息，它们会在下一次 LLM 调用前加入上下文。
	 * 当前 assistant 消息中的工具调用不会被跳过。
	 *
	 * 适合用于在 Agent 工作期间「steering」其方向。
	 *
	 * 契约：不得抛出异常或 reject。没有 steering 消息时返回 []。
	 */
	getSteeringMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 返回在 Agent 本应停止之后再处理的消息。
	 *
	 * 当 Agent 没有更多工具调用、也没有 steering 消息时调用。
	 * 若返回消息，它们会被加入上下文，Agent 随之继续下一轮。
	 *
	 * 适合用于应当等到 Agent 结束后再处理的跟进消息。
	 *
	 * 契约：不得抛出异常或 reject。没有跟进消息时返回 []。
	 */
	getFollowUpMessages?: () => Promise<AgentMessage[]>;

	/**
	 * 工具执行模式。
	 * - "sequential"：逐个执行工具调用
	 * - "parallel"：先串行预检 (preflight) 各工具调用，再并发执行被允许的工具；
	 *   每个工具收尾后按工具完成顺序发出 `tool_execution_end`，
	 *   工具结果消息产物则稍后按 assistant 消息中的原始顺序发出
	 *
	 * 默认值："parallel"
	 */
	toolExecution?: ToolExecutionMode;

	/**
	 * 在工具参数校验通过之后、工具执行之前调用。
	 *
	 * 返回 `{ block: true }` 可阻止执行，循环会改为发出一条错误的工具结果。
	 * 被拦截的结果还可以设置 `terminate: true`，以参与批次提前终止规则。
	 * 钩子会收到 Agent 的 abort signal，需自行负责响应它。
	 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;

	/**
	 * 在工具执行完成之后、`tool_execution_end` 与工具结果消息事件发出之前调用。
	 *
	 * 返回 `AfterToolCallResult` 可覆盖工具实际执行结果的部分字段：
	 * - `content` 整体替换 content 数组
	 * - `details` 整体替换 details 载荷
	 * - `isError` 替换错误标记
	 * - `usage` 替换工具结果的 usage
	 * - `terminate` 替换提前终止提示
	 *
	 * 省略的字段保持原值，不做深度合并。
	 * 钩子会收到 Agent 的 abort signal，需自行负责响应它。
	 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
}

/**
 * 支持思考/推理能力的模型所使用的思考 (thinking) 级别。
 * 注意："xhigh" 与 "max" 仅被部分模型家族支持。请使用 @earendil-works/pi-ai
 * 中模型 thinking-level 元数据来判断具体模型是否支持。
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 供应用自定义消息使用的可扩展接口。
 * 应用可通过声明合并 (declaration merging) 进行扩展：
 *
 * @example
 * ```typescript
 * declare module "@mariozechner/agent" {
 *   interface CustomAgentMessages {
 *     artifact: ArtifactMessage;
 *     notification: NotificationMessage;
 *   }
 * }
 * ```
 */
export interface CustomAgentMessages {
	// 默认为空 —— 应用通过声明合并扩展
}

/**
 * AgentMessage：LLM 消息 + 自定义消息的联合类型。
 * 该抽象让应用在保持类型安全、并与基础 LLM 消息兼容的前提下，
 * 添加自定义消息类型。
 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

/**
 * Agent 对外暴露的公共状态。
 *
 * `tools` 与 `messages` 使用访问器 (accessor) 属性，使实现可以在存储前
 * 复制被赋值的数组。
 */
export interface AgentState {
	/** 随每次模型请求发送的系统提示词。 */
	systemPrompt: string;
	/** 后续轮次使用的当前模型。 */
	model: Model<any>;
	/** 后续轮次请求的推理 (reasoning) 级别。 */
	thinkingLevel: ThinkingLevel;
	/** 可用工具列表。赋新数组时会复制顶层数组。 */
	set tools(tools: AgentTool<any>[]);
	get tools(): AgentTool<any>[];
	/** 会话转录 (transcript)。赋新数组时会复制顶层数组。 */
	set messages(messages: AgentMessage[]);
	get messages(): AgentMessage[];
	/**
	 * Agent 正在处理 prompt 或 continuation 期间为 true。
	 *
	 * 该状态会一直保持，直到被 await 的 `agent_end` 监听器全部结算完成。
	 */
	readonly isStreaming: boolean;
	/** 当前流式响应的部分 (partial) assistant 消息（如有）。 */
	readonly streamingMessage?: AgentMessage;
	/** 当前正在执行的工具调用 id 集合。 */
	readonly pendingToolCalls: ReadonlySet<string>;
	/** 最近一次失败或中止的 assistant 轮的错误消息（如有）。 */
	readonly errorMessage?: string;
}

/** 工具产生的最终结果或部分结果。 */
export interface AgentToolResult<T> {
	/** 返回给模型的文本或图片内容。 */
	content: (TextContent | ImageContent)[];
	/** 供日志或 UI 渲染使用的任意结构化详情。 */
	details: T;
	/** 工具最终执行自身产生的 usage（如有）。不计入主 LLM 上下文的 token 统计。 */
	usage?: Usage;
	/** 本结果引入的工具名列表，这些工具从转录的这一位置起可用。 */
	addedToolNames?: string[];
	/**
	 * 提示 Agent 在当前工具批次结束后停止。
	 * 只有当批次中每个已收尾的工具结果都将此标记设为 true 时，才会提前终止。
	 */
	terminate?: boolean;
}

/**
 * 工具用来流式输出部分执行进度的回调。
 *
 * 该回调的作用域限定于当前的 `execute()` 调用。工具 promise 结算
 * 之后再发起的调用会被忽略。
 */
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

/** Agent 运行时使用的工具定义。 */
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
	/** 供 UI 展示的人类可读标签。 */
	label: string;
	/**
	 * 可选的兼容垫片：在 schema 校验之前处理原始的工具调用参数。
	 * 必须返回符合 `TParameters` 的对象。
	 */
	prepareArguments?: (args: unknown) => Static<TParameters>;
	/** 执行工具调用。失败时请直接抛出异常，而不要把错误编码进 `content`。 */
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails>,
	) => Promise<AgentToolResult<TDetails>>;
	/**
	 * 单个工具的执行模式覆盖。
	 * - "sequential"：该工具必须与其他工具调用逐个串行执行。
	 * - "parallel"：该工具可与其他工具调用并发执行。
	 *
	 * 省略时使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;
}

/** 传入底层 Agent 循环的上下文快照。 */
export interface AgentContext {
	/** 随请求一并发送的系统提示词。 */
	systemPrompt: string;
	/** 模型可见的转录消息。 */
	messages: AgentMessage[];
	/** 本次运行可用的工具。 */
	tools?: AgentTool<any>[];
}

/**
 * Agent 发出的、供 UI 更新使用的事件。
 *
 * `agent_end` 是一次运行发出的最后一个事件，但被 await 的 `Agent.subscribe()`
 * 中针对该事件的监听器仍参与运行的结算 (settlement)。Agent 只有在这些
 * 监听器完成后才会转为空闲。
 */
export type AgentEvent =
	// Agent 生命周期
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	// 轮 (turn) 生命周期 —— 一轮 = 一次 assistant 响应 + 其工具调用/结果
	| { type: "turn_start" }
	| { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
	// 消息生命周期 —— 针对 user、assistant 和 toolResult 消息发出
	| { type: "message_start"; message: AgentMessage }
	// 仅在流式输出期间针对 assistant 消息发出
	| { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
	| { type: "message_end"; message: AgentMessage }
	// 工具执行生命周期
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
