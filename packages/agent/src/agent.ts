/**
 * @file agent.ts —— Agent 框架对外的门面（facade）。
 *
 * @description
 * 本文件定义核心类 {@link Agent}：一个围绕底层 agent loop（见 `./agent-loop.ts`）
 * 的有状态封装。主要职责：
 * - 持有可变的会话状态（`MutableAgentState`：系统提示、消息转录、工具列表、流式中间态等）；
 * - 维护 steering（转向）与 follow-up（追加）两条 pending 消息队列，支持在运行中注入消息；
 * - 把 prompt / continue 派发给 `runAgentLoop` / `runAgentLoopContinue` 执行，
 *   并将 loop 产生的事件（{@link AgentEvent}）先归约到内部状态，再分发给订阅者；
 * - 提供生命周期控制：abort、waitForIdle、reset，以及丰富的钩子
 *   （beforeToolCall / afterToolCall / prepareNextTurn / shouldStopAfterTurn 等）。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：LLM 统一接口的类型（Model、Message、Transport 等）；
 * - `./agent-loop.ts`：真正执行 agent 循环的纯函数；
 * - `./stream-fn.ts`：默认的流式请求函数；
 * - `./types.ts`：本包全部公共类型定义。
 */
import type {
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	Transport,
} from "@earendil-works/pi-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentState,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	PrepareNextTurnContext,
	QueueMode,
	ShouldStopAfterTurnContext,
	StreamFn,
	ToolExecutionMode,
} from "./types.ts";

export type { QueueMode } from "./types.ts";

/**
 * 默认的消息转换函数：把内部 AgentMessage 列表过滤为可发给 LLM 的消息。
 *
 * 只保留 user / assistant / toolResult 三种角色，其余（如系统级、自定义角色的消息）
 * 会被剔除，不会进入 LLM 请求。
 */
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
}

/** 空的用量（usage）快照：构造失败占位消息时使用，所有计数字段均为 0。 */
const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 占位用的默认模型：所有字段均为"unknown"/0。
 * 当 initialState 未提供 model 时使用，避免状态中出现 undefined。
 */
const DEFAULT_MODEL = {
	id: "unknown",
	name: "unknown",
	api: "unknown",
	provider: "unknown",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 0,
	maxTokens: 0,
} satisfies Model<any>;

/**
 * Agent 内部使用的可变状态类型。
 *
 * 与对外只读视图 {@link AgentState} 的区别：把几个运行时字段放宽为可写——
 * - `isStreaming`：当前是否有活跃的运行（run）；
 * - `streamingMessage`：正在流式生成中的消息快照；
 * - `pendingToolCalls`：尚未执行完的工具调用 ID 集合；
 * - `errorMessage`：最近一次 turn 的错误信息。
 */
type MutableAgentState = Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage"> & {
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: Set<string>;
	errorMessage?: string;
};

/**
 * 创建 Agent 的初始可变状态。
 *
 * 对 `tools` / `messages` 采用「getter/setter + 闭包变量」的实现：
 * 赋值时会自动浅拷贝顶层数组，防止外部直接持有并原地修改内部数组，
 * 从而保证状态快照（如 createContextSnapshot）的一致性。
 *
 * @param initialState 可选的初始状态片段；运行时字段（isStreaming 等）始终从零值开始。
 */
function createMutableAgentState(
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>,
): MutableAgentState {
	// 先做一次防御性拷贝：外部传入的初始数组不会与内部状态共享引用
	let tools = initialState?.tools?.slice() ?? [];
	let messages = initialState?.messages?.slice() ?? [];

	return {
		systemPrompt: initialState?.systemPrompt ?? "",
		model: initialState?.model ?? DEFAULT_MODEL,
		thinkingLevel: initialState?.thinkingLevel ?? "off",
		// 读取直接返回闭包数组；写入时 slice 拷贝，隔离外部引用
		get tools() {
			return tools;
		},
		set tools(nextTools: AgentTool<any>[]) {
			tools = nextTools.slice();
		},
		get messages() {
			return messages;
		},
		set messages(nextMessages: AgentMessage[]) {
			messages = nextMessages.slice();
		},
		isStreaming: false,
		streamingMessage: undefined,
		pendingToolCalls: new Set<string>(),
		errorMessage: undefined,
	};
}

/** 构造 {@link Agent} 的选项。 */
export interface AgentOptions {
	/** 初始状态片段（不含运行时字段，运行时字段总是从零值开始）。 */
	initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
	/** 自定义「内部消息 → LLM 消息」的转换函数；缺省时只保留 user/assistant/toolResult。 */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** 发送前对上下文做最后的变换（例如上下文压缩 compaction）。 */
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 执行 LLM 流式请求的函数（必填）。 */
	streamFn: StreamFn;
	/** 按 provider 动态获取 API key。 */
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 每个发往 provider 的原始 payload 回调（可用于遥测 telemetry）。 */
	onPayload?: SimpleStreamOptions["onPayload"];
	/** 每个来自 provider 的原始响应回调。 */
	onResponse?: SimpleStreamOptions["onResponse"];
	/** 工具调用执行前的拦截钩子，可返回修改结果或阻止执行。 */
	beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/** 工具调用执行后的钩子，可对结果做修正（例如向下一 turn 注入提示）。 */
	afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** 每个 turn 结束时的自定义停止判定；返回 true 则提前结束 agent 循环。 */
	shouldStopAfterTurn?: (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>;
	/** 下一 turn 开始前的准备钩子（旧签名，无上下文参数）。 */
	prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** 下一 turn 开始前的准备钩子（新签名，带 PrepareNextTurnContext；优先于 prepareNextTurn）。 */
	prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** steering 队列的排空模式（one-at-a-time / all）。 */
	steeringMode?: QueueMode;
	/** follow-up 队列的排空模式。 */
	followUpMode?: QueueMode;
	/** 会话 ID，透传给支持会话缓存的 provider 后端。 */
	sessionId?: string;
	/** 各思考等级的 token 预算。 */
	thinkingBudgets?: ThinkingBudgets;
	/** 首选传输方式，透传给流式请求函数。 */
	transport?: Transport;
	/** provider 请求重试延迟的上限。 */
	maxRetryDelayMs?: number;
	/** 单条 assistant 消息含多个工具调用时的执行策略（parallel / sequential）。 */
	toolExecution?: ToolExecutionMode;
}

/**
 * 待处理消息队列：缓存运行期间注入的 steering / follow-up 消息。
 *
 * 排空（drain）行为由 mode 决定：
 * - `"all"`：一次性取出全部消息；
 * - `"one-at-a-time"`：每次只取最早的一条（FIFO），保证消息逐条生效。
 */
class PendingMessageQueue {
	private messages: AgentMessage[] = [];
	public mode: QueueMode;

	/**
	 * @param mode 排空模式，运行期可通过修改 `mode` 属性动态切换。
	 */
	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	/** 将一条消息追加到队尾。 */
	enqueue(message: AgentMessage): void {
		this.messages.push(message);
	}

	/** 队列中是否还有待处理消息。 */
	hasItems(): boolean {
		return this.messages.length > 0;
	}

	/**
	 * 按当前模式取出消息并从队列中移除。
	 *
	 * - `"all"` 模式：返回全部消息并清空队列；
	 * - `"one-at-a-time"` 模式：只返回队首一条；队列为空时返回空数组。
	 *
	 * @returns 取出的消息数组（可能为空）。
	 */
	drain(): AgentMessage[] {
		if (this.mode === "all") {
			const drained = this.messages.slice();
			this.messages = [];
			return drained;
		}

		// one-at-a-time：只取队首一条，剩余留在队列中等待下次 drain
		const first = this.messages[0];
		if (!first) {
			return [];
		}
		this.messages = this.messages.slice(1);
		return [first];
	}

	/** 清空队列中的所有消息。 */
	clear(): void {
		this.messages = [];
	}
}

/**
 * 一次活跃运行（run）的运行时句柄。
 *
 * - `promise` / `resolve`：手动控制的完成信号，waitForIdle() 等待它；
 * - `abortController`：本次运行专属的中止控制器，abort() 与各钩子的 signal 均来自它。
 * activeRun 为 undefined 即表示 Agent 当前空闲。
 */
type ActiveRun = {
	promise: Promise<void>;
	resolve: () => void;
	abortController: AbortController;
};

/**
 * 底层 agent loop 的有状态封装，本框架对外的核心门面。
 *
 * `Agent` 持有当前的消息转录（transcript）、发射生命周期事件、执行工具，
 * 并暴露用于 steering（转向）与 follow-up（追加）消息的排队 API。
 *
 * 典型生命周期：
 * 1. `prompt()` / `continue()` 启动一次运行（activeRun），派发给 agent-loop；
 * 2. loop 每产生一个事件，先由 {@link processEvents} 归约到内部状态，
 *    再按订阅顺序 await 每个监听器；
 * 3. 运行结束（或失败/中止）后 {@link finishRun} 清理运行时状态并 resolve
 *    `waitForIdle()` 等待的 promise。
 */
export class Agent {
	/** 内部可变状态（tools/messages 赋值时自动浅拷贝顶层数组）。 */
	private _state: MutableAgentState;
	/** 事件监听器集合；用 Set 保证去重，迭代顺序即订阅顺序。 */
	private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
	/** steering 消息队列：当前 assistant turn 结束后注入。 */
	private readonly steeringQueue: PendingMessageQueue;
	/** follow-up 消息队列：Agent 本应停止后才继续执行。 */
	private readonly followUpQueue: PendingMessageQueue;

	/** 「内部消息 → LLM 消息」的转换函数。 */
	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** 发送前对上下文的变换钩子（例如上下文压缩）。 */
	public transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	/** 实际执行 LLM 流式请求的函数。 */
	public streamFunction: StreamFn;
	/** 按 provider 动态获取 API key 的钩子。 */
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** 每个发往 provider 的原始 payload 回调。 */
	public onPayload?: SimpleStreamOptions["onPayload"];
	/** 每个来自 provider 的原始响应回调。 */
	public onResponse?: SimpleStreamOptions["onResponse"];
	/** 工具调用执行前的拦截钩子。 */
	public beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<BeforeToolCallResult | undefined>;
	/** 工具调用执行后的钩子。 */
	public afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
	/** 每个 turn 结束时的自定义停止判定。 */
	public shouldStopAfterTurn?: (
		context: ShouldStopAfterTurnContext,
		signal?: AbortSignal,
	) => boolean | Promise<boolean>;
	/** 下一 turn 开始前的准备钩子（旧签名）。 */
	public prepareNextTurn?: (
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** 下一 turn 开始前的准备钩子（新签名，带上下文；优先于 prepareNextTurn）。 */
	public prepareNextTurnWithContext?: (
		context: PrepareNextTurnContext,
		signal?: AbortSignal,
	) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
	/** 当前活跃运行的句柄；undefined 表示空闲。 */
	private activeRun?: ActiveRun;
	/** 会话标识符，透传给支持缓存感知的 provider 后端。 */
	public sessionId?: string;
	/** 可选的各思考等级 token 预算，透传给流式请求函数。 */
	public thinkingBudgets?: ThinkingBudgets;
	/** 首选传输方式，透传给流式请求函数。 */
	public transport: Transport;
	/** 可选上限：限制 provider 请求的重试延迟。 */
	public maxRetryDelayMs?: number;
	/** 单条 assistant 消息含多个工具调用时的执行策略。 */
	public toolExecution: ToolExecutionMode;

	/**
	 * 构造 Agent，应用传入选项并对全部字段做缺省回退。
	 *
	 * @param options 构造选项；出于对旧编译产物的兼容，整个对象与 streamFn
	 *                均允许缺省（streamFn 缺省时回退到 getDefaultStreamFn()）。
	 */
	constructor(options: AgentOptions) {
		// 旧版本编译产物的调用方可能不传 options 或 streamFn（尽管当前 API 要求必填），故做防御性回退
		const runtimeOptions: Partial<AgentOptions> = options ?? {};
		this._state = createMutableAgentState(runtimeOptions.initialState);
		this.convertToLlm = runtimeOptions.convertToLlm ?? defaultConvertToLlm;
		this.transformContext = runtimeOptions.transformContext;
		this.streamFunction = runtimeOptions.streamFn ?? getDefaultStreamFn();
		this.getApiKey = runtimeOptions.getApiKey;
		this.onPayload = runtimeOptions.onPayload;
		this.onResponse = runtimeOptions.onResponse;
		this.beforeToolCall = runtimeOptions.beforeToolCall;
		this.afterToolCall = runtimeOptions.afterToolCall;
		this.shouldStopAfterTurn = runtimeOptions.shouldStopAfterTurn;
		this.prepareNextTurn = runtimeOptions.prepareNextTurn;
		this.prepareNextTurnWithContext = runtimeOptions.prepareNextTurnWithContext;
		this.steeringQueue = new PendingMessageQueue(runtimeOptions.steeringMode ?? "one-at-a-time");
		this.followUpQueue = new PendingMessageQueue(runtimeOptions.followUpMode ?? "one-at-a-time");
		this.sessionId = runtimeOptions.sessionId;
		this.thinkingBudgets = runtimeOptions.thinkingBudgets;
		this.transport = runtimeOptions.transport ?? "auto";
		this.maxRetryDelayMs = runtimeOptions.maxRetryDelayMs;
		this.toolExecution = runtimeOptions.toolExecution ?? "parallel";
	}

	/**
	 * 订阅 Agent 生命周期事件。
	 *
	 * 监听器返回的 promise 会按订阅顺序依次 await，并被计入当前运行的
	 * 完结（settlement）中；监听器同时会收到当前运行的活跃中止 signal。
	 *
	 * 注意：`agent_end` 是一次运行发射的最后一个事件，但在该事件的全部
	 * 监听器 settle 之前，Agent 并不会真正进入空闲状态。
	 *
	 * @param listener 事件监听器，接收事件与当前运行的中止 signal。
	 * @returns 取消订阅函数，调用后移除该监听器。
	 */
	subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 当前 Agent 状态。
	 *
	 * 对 `state.tools` / `state.messages` 赋值时会浅拷贝所提供的顶层数组。
	 */
	get state(): AgentState {
		return this._state;
	}

	/** 控制 steering 队列的排空方式。 */
	set steeringMode(mode: QueueMode) {
		this.steeringQueue.mode = mode;
	}

	get steeringMode(): QueueMode {
		return this.steeringQueue.mode;
	}

	/** 控制 follow-up 队列的排空方式。 */
	set followUpMode(mode: QueueMode) {
		this.followUpQueue.mode = mode;
	}

	get followUpMode(): QueueMode {
		return this.followUpQueue.mode;
	}

	/** 将消息入队：在当前 assistant turn 结束后注入。 */
	steer(message: AgentMessage): void {
		this.steeringQueue.enqueue(message);
	}

	/** 将消息入队：仅当 Agent 本应停止（无其他事可做）时才继续执行。 */
	followUp(message: AgentMessage): void {
		this.followUpQueue.enqueue(message);
	}

	/** 移除所有已排队的 steering 消息。 */
	clearSteeringQueue(): void {
		this.steeringQueue.clear();
	}

	/** 移除所有已排队的 follow-up 消息。 */
	clearFollowUpQueue(): void {
		this.followUpQueue.clear();
	}

	/** 移除所有已排队的 steering 与 follow-up 消息。 */
	clearAllQueues(): void {
		this.clearSteeringQueue();
		this.clearFollowUpQueue();
	}

	/** 任一队列仍有待处理消息时返回 true。 */
	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** 当前运行的中止 signal（若无活跃运行则为 undefined）。 */
	get signal(): AbortSignal | undefined {
		return this.activeRun?.abortController.signal;
	}

	/** 中止当前运行（若存在）。 */
	abort(): void {
		this.activeRun?.abortController.abort();
	}

	/**
	 * 等待当前运行及所有被 await 的事件监听器全部结束。
	 *
	 * 该 promise 会在 `agent_end` 的监听器 settle 之后才 resolve；
	 * 若当前空闲则立即 resolve。
	 */
	waitForIdle(): Promise<void> {
		return this.activeRun?.promise ?? Promise.resolve();
	}

	/**
	 * 清空转录状态、运行时状态与已排队消息。
	 *
	 * @throws 运行进行中调用会抛错——必须先等待运行完成再 reset。
	 */
	reset(): void {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before resetting.");
		}

		this._state.messages = [];
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this._state.errorMessage = undefined;
		this.clearFollowUpQueue();
		this.clearSteeringQueue();
	}

	/**
	 * 以新 prompt 启动一次运行：支持纯文本、单条消息或一批消息。
	 *
	 * @param input 用户输入：字符串、单条 AgentMessage 或消息数组。
	 * @param images 当 input 为字符串时可选的图片附件列表。
	 * @throws 已有运行进行中时抛错；此时应改用 steer()/followUp() 排队或等待完成。
	 */
	async prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
	async prompt(input: string, images?: ImageContent[]): Promise<void>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (this.activeRun) {
			throw new Error(
				"Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.",
			);
		}
		const messages = this.normalizePromptInput(input, images);
		await this.runPromptMessages(messages);
	}

	/**
	 * 从当前转录继续运行。最后一条消息必须是 user 或 toolResult 角色。
	 *
	 * 若最后一条是 assistant 消息（说明上次中断在 assistant turn 之后），
	 * 会优先尝试排空的 steering 队列，其次 follow-up 队列，
	 * 把队列中的消息作为新输入重新启动 loop；两者皆空则抛错。
	 *
	 * @throws 已有运行进行中、转录为空、或最后一条为 assistant 且两个队列均为空时抛错。
	 */
	async continue(): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing. Wait for completion before continuing.");
		}

		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage) {
			throw new Error("No messages to continue from");
		}

		// ========== 处理「最后一条是 assistant」的续跑场景 ==========
		// assistant 消息不能直接作为续跑起点，必须先注入新的 user 侧消息：
		// 1) 优先消费 steering 队列（消息刚被本方法取出，跳过 loop 开头的
		//    首次 steering 轮询，避免同一条消息被消费两次）；
		// 2) steering 为空再消费 follow-up 队列；
		// 3) 两者皆空则无法续跑，抛错。
		if (lastMessage.role === "assistant") {
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}

			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}

			throw new Error("Cannot continue from message role: assistant");
		}

		await this.runContinuation();
	}

	/**
	 * 把 prompt 的多种输入形态统一归一化为 AgentMessage 数组。
	 *
	 * - 数组：原样返回；
	 * - 单条 AgentMessage：包一层单元素数组；
	 * - 字符串：包装为 user 消息，文本在前、可选图片在后，时间戳取当前时间。
	 *
	 * @param input 用户输入。
	 * @param images 字符串输入时附加的图片内容。
	 * @returns 归一化后的消息数组。
	 */
	private normalizePromptInput(
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
	): AgentMessage[] {
		if (Array.isArray(input)) {
			return input;
		}

		if (typeof input !== "string") {
			return [input];
		}

		const content: Array<TextContent | ImageContent> = [{ type: "text", text: input }];
		if (images && images.length > 0) {
			content.push(...images);
		}
		return [{ role: "user", content, timestamp: Date.now() }];
	}

	/**
	 * 以给定的新消息启动一次完整 agent loop（带生命周期包装）。
	 *
	 * @param messages 作为本轮输入的新消息。
	 * @param options.skipInitialSteeringPoll 为 true 时，loop 开头的首次
	 *        steering 轮询跳过一次（continue() 场景下消息已被提前 drain）。
	 */
	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	/** 从当前转录直接续跑 agent loop（不注入新消息）。 */
	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	/**
	 * 创建当前状态的浅拷贝快照，作为传给 agent loop 的上下文。
	 *
	 * 拷贝 messages 与 tools 的顶层数组，隔离 loop 执行期间外部对状态的并发修改。
	 */
	private createContextSnapshot(): AgentContext {
		return {
			systemPrompt: this._state.systemPrompt,
			messages: this._state.messages.slice(),
			tools: this._state.tools.slice(),
		};
	}

	/**
	 * 把 Agent 自身的配置与钩子组装为传给 agent loop 的运行配置
	 * （{@link AgentLoopConfig}），并在钩子外层注入当前运行的 signal。
	 *
	 * @param options.skipInitialSteeringPoll 见 {@link runPromptMessages}。
	 */
	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		const shouldStopAfterTurn = this.shouldStopAfterTurn;
		return {
			model: this._state.model,
			// thinkingLevel 为 "off" 时显式传 undefined，表示不开启推理
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			onPayload: this.onPayload,
			onResponse: this.onResponse,
			transport: this.transport,
			thinkingBudgets: this.thinkingBudgets,
			maxRetryDelayMs: this.maxRetryDelayMs,
			toolExecution: this.toolExecution,
			beforeToolCall: this.beforeToolCall,
			afterToolCall: this.afterToolCall,
			// 包装一层以注入当前运行的 signal，让用户钩子能感知运行中止
			shouldStopAfterTurn: shouldStopAfterTurn
				? async (context) => await shouldStopAfterTurn(context, this.signal)
				: undefined,
			// prepareNextTurnWithContext（带上下文的新签名）优先于 prepareNextTurn
			prepareNextTurn:
				this.prepareNextTurnWithContext || this.prepareNextTurn
					? async (context) => {
							if (this.prepareNextTurnWithContext) {
								return await this.prepareNextTurnWithContext(context, this.signal);
							}
							return await this.prepareNextTurn?.(this.signal);
						}
					: undefined,
			convertToLlm: this.convertToLlm,
			transformContext: this.transformContext,
			getApiKey: this.getApiKey,
			// 首次轮询可能被 continue() 场景跳过一次（消息已被提前 drain），
			// 之后每次轮询都按当前模式排空 steering 队列
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
		};
	}

	/**
	 * 用统一的生命周期包装一次运行（run）。
	 *
	 * 职责：创建本次运行专属的 AbortController 与手动完成的 promise
	 * （供 waitForIdle() 等待）；运行前重置流式中间态；运行中捕获异常
	 * 转交 {@link handleRunFailure}（失败也会发出完整事件序列，而不是静默 reject）；
	 * 无论成败最终由 {@link finishRun} 收尾。
	 *
	 * @param executor 实际执行 agent loop 的异步函数，接收本次运行的中止 signal。
	 * @throws 已有活跃运行时抛错（Agent 不支持并发运行）。
	 */
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		if (this.activeRun) {
			throw new Error("Agent is already processing.");
		}

		// ========== 初始化本次运行的运行时句柄 ==========
		const abortController = new AbortController();
		let resolvePromise = () => {};
		// 用外部可触发的 resolve 构造 promise，使 finishRun() 能精确控制
		// waitForIdle() 的 resolve 时机（在所有清理完成之后）
		const promise = new Promise<void>((resolve) => {
			resolvePromise = resolve;
		});
		this.activeRun = { promise, resolve: resolvePromise, abortController };

		// 运行前清空上一次运行残留的流式中间态与错误信息
		this._state.isStreaming = true;
		this._state.streamingMessage = undefined;
		this._state.errorMessage = undefined;

		try {
			await executor(abortController.signal);
		} catch (error) {
			// 异常不向外抛出，而是合成为事件序列（含 agent_end），
			// 保证订阅者总能观察到一次完整、闭合的运行
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.finishRun();
		}
	}

	/**
	 * 把运行中的异常合成为一条 assistant 失败消息，并补发完整的事件序列。
	 *
	 * 发出 message_start → message_end → turn_end → agent_end 四个事件，
	 * 让监听方像处理正常结束一样处理失败/中止，保持事件流的形态一致。
	 *
	 * @param error 捕获到的异常。
	 * @param aborted 是否因中止（abort）触发；决定 stopReason 取 "aborted" 还是 "error"。
	 */
	private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
		// 构造占位的 assistant 失败消息：usage 记零值（EMPTY_USAGE），
		// 错误信息统一转成字符串，stopReason 区分「中止」与「错误」
		const failureMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: this._state.model.api,
			provider: this._state.model.provider,
			model: this._state.model.id,
			usage: EMPTY_USAGE,
			stopReason: aborted ? "aborted" : "error",
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		} satisfies AgentMessage;
		await this.processEvents({ type: "message_start", message: failureMessage });
		await this.processEvents({ type: "message_end", message: failureMessage });
		await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
		await this.processEvents({ type: "agent_end", messages: [failureMessage] });
	}

	/**
	 * 运行收尾：清理运行时状态、resolve waitForIdle() 等待的 promise、
	 * 释放 activeRun（Agent 回到空闲态）。
	 */
	private finishRun(): void {
		this._state.isStreaming = false;
		this._state.streamingMessage = undefined;
		this._state.pendingToolCalls = new Set<string>();
		this.activeRun?.resolve();
		this.activeRun = undefined;
	}

	/**
	 * 先把一个 loop 事件归约到内部状态，再逐个 await 监听器。
	 *
	 * `agent_end` 仅表示 loop 不会再产生后续事件；运行真正算作空闲要更晚——
	 * 需等 `agent_end` 的所有被 await 的监听器执行完毕、且 {@link finishRun}
	 * 清理完运行时状态之后。
	 *
	 * @param event agent loop 产生的事件。
	 * @throws 无活跃运行时收到事件会抛错（监听器必须在活跃运行的上下文中调用）。
	 */
	private async processEvents(event: AgentEvent): Promise<void> {
		// ========== 第一步：把事件归约到内部状态 ==========
		switch (event.type) {
			case "message_start":
				this._state.streamingMessage = event.message;
				break;

			case "message_update":
				this._state.streamingMessage = event.message;
				break;

			case "message_end":
				// 消息定型：清掉流式快照，并追加进转录
				this._state.streamingMessage = undefined;
				this._state.messages.push(event.message);
				break;

			case "tool_execution_start": {
				// 通过「拷贝新 Set 再整体替换」来更新，避免监听器持有旧引用后看不到变更
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.add(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "tool_execution_end": {
				const pendingToolCalls = new Set(this._state.pendingToolCalls);
				pendingToolCalls.delete(event.toolCallId);
				this._state.pendingToolCalls = pendingToolCalls;
				break;
			}

			case "turn_end":
				// 仅记录 assistant 消息上的错误信息，供 UI 在 turn 结束时展示
				if (event.message.role === "assistant" && event.message.errorMessage) {
					this._state.errorMessage = event.message.errorMessage;
				}
				break;

			case "agent_end":
				this._state.streamingMessage = undefined;
				break;
		}

		// ========== 第二步：按订阅顺序 await 每个监听器 ==========
		// 监听器收到的 signal 来自当前活跃运行；若无活跃运行则属于
		// 编程错误（事件只应在 runWithLifecycle 的执行期间产生）
		const signal = this.activeRun?.abortController.signal;
		if (!signal) {
			throw new Error("Agent listener invoked outside active run");
		}
		for (const listener of this.listeners) {
			await listener(event, signal);
		}
	}
}
