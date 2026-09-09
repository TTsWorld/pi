/**
 * @file pi monorepo 统一 AI 包的核心类型定义文件
 *
 * @description
 * 定义与 provider 无关的统一类型体系：Message（消息）/ Content（内容）/ Request（请求）/
 * Event（流式事件）/ TokenUsage（token 用量）/ ToolCall（工具调用）/ StopReason（停止原因）等。
 *
 * 这是消灭 agent 包里 provider 方言代码的统一抽象基石：对应 plan.md 蓝图中
 * 「统一类型层」的部分，后续将由三个 provider adapter（Anthropic / OpenAI / Google 等）
 * 共用——各 adapter 负责把自家 API 的请求/响应格式与这套统一类型互相转换，
 * agent 层只面向本文件定义的类型编程，不再感知任何 provider 专属结构。
 */

/**
 * AI 服务统一接口。
 *
 * 所有 provider adapter 都实现该接口，agent 层通过它发起对话补全，
 * 从而与具体 provider 解耦。
 *
 * @template T - provider 专属的可选配置类型（默认 any，允许各 adapter 自定义 options 结构）
 */
export interface AI<T = any> {
	/**
	 * 执行一次对话补全请求。
	 *
	 * @param request - 统一格式的补全请求（含消息历史、工具列表、流式回调等）
	 * @param options - provider 专属的可选配置
	 * @returns 完成后Resolve为一条完整的 assistant 消息（含内容、工具调用、用量、停止原因）
	 */
	complete(request: Request, options?: T): Promise<AssistantMessage>;
}

/**
 * 模型元信息：描述某个模型的标识、能力、计费与上下文限制。
 *
 * 用于模型选择与成本估算，由各 provider adapter 提供具体数据。
 */
export interface ModelInfo {
	/** 模型唯一标识（provider 内部的 model id，如 "claude-sonnet-4-5"） */
	id: string;
	/** 模型的展示名称（面向用户的可读名称） */
	name: string;
	/** 模型所属的 provider 标识（如 "anthropic" / "openai" / "google"） */
	provider: string;
	/** 模型能力声明：据此决定是否启用推理、工具调用、视觉、音频等特性 */
	capabilities: {
		/** 是否支持推理（reasoning / thinking）输出 */
		reasoning: boolean;
		/** 是否支持工具调用（tool call） */
		toolCall: boolean;
		/** 是否支持视觉（图片输入） */
		vision: boolean;
		/** 是否支持音频输入（可选） */
		audio?: boolean;
	};
	/** 计费信息：每百万 token 的单价（美元） */
	cost: {
		/** 输入 token 单价（每百万 token） */
		input: number; // 每百万 token
		/** 输出 token 单价（每百万 token） */
		output: number; // 每百万 token
		/** 缓存读取单价（每百万 token，可选） */
		cacheRead?: number;
		/** 缓存写入单价（每百万 token，可选） */
		cacheWrite?: number;
	};
	/** 模型的 token 限制 */
	limits: {
		/** 上下文窗口大小（token 数） */
		context: number;
		/** 单次响应的最大输出 token 数 */
		output: number;
	};
	/** 模型的知识截止时间等说明（可选） */
	knowledge?: string;
}

/**
 * 用户消息：对话历史中用户输入的一条消息。
 */
export interface UserMessage {
	/** 消息角色：用户 */
	role: "user";
	/** 用户输入的文本内容 */
	content: string;
}

/**
 * 助手消息：模型返回的一条完整响应。
 *
 * 由 provider adapter 从流式事件聚合而成（或非流式直接返回），
 * 包含思考过程、正文、工具调用、token 用量与停止原因。
 */
export interface AssistantMessage {
	/** 消息角色：助手 */
	role: "assistant";
	/** 思考（reasoning）过程的文本内容（可选，仅推理模型产生） */
	thinking?: string;
	/**
	 * 思考内容的签名（可选）。
	 * NOTE Leaky abstraction（泄漏抽象）: needed for Anthropic ——
	 * Anthropic 专用字段，要求回传思考签名以校验思考内容的完整性。
	 */
	thinkingSignature?: string;
	/** 助手回复的正文文本（可选，发起工具调用时可能为空） */
	content?: string;
	/** 本次响应请求的工具调用列表（可选，每个元素含调用 id、工具名与已解析的参数对象） */
	toolCalls?: {
		/** 工具调用的唯一标识，用于关联后续的 ToolResultMessage */
		id: string;
		/** 要调用的工具名称 */
		name: string;
		/** 调用参数（已从 JSON 字符串解析为对象） */
		arguments: Record<string, any>;
	}[];
	/** 生成本消息的模型标识 */
	model: string;
	/** 本次请求的 token 用量统计 */
	usage: TokenUsage;

	/** 停止原因：标识模型为何停止生成 */
	stopResaon: StopReason;
	/** 错误信息（可选）：本次补全失败时记录的错误 */
	error?: string | Error;
}

/**
 * 工具结果消息：工具执行完毕后回传给模型的结果。
 *
 * 作为消息历史的一部分，在下一次请求中交给模型继续推理。
 */
export interface ToolResultMessage {
	/** 消息角色：工具结果 */
	role: "toolResult";
	/** 工具执行的输出内容（通常为文本） */
	content: string;
	/** 对应的工具调用 id（与 AssistantMessage.toolCalls[].id 匹配） */
	toolCallId: string;
	/** 是否为执行出错的结果（true 时模型会看到工具失败的信息） */
	isError: boolean;
}

/**
 * 统一消息类型：对话历史中一条消息的判别联合。
 *
 * - UserMessage：用户输入，由用户发起
 * - AssistantMessage：模型响应，每次补全产生
 * - ToolResultMessage：工具执行结果，在模型发起工具调用后由执行方回填
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * 工具定义：向模型声明一个可调用的工具。
 */
export interface Tool {
	/** 工具名称（模型据此发起调用） */
	name: string;
	/** 工具功能描述（帮助模型判断何时使用该工具） */
	description: string;
	/** 工具参数的 JSON Schema 定义 */
	parameters: Record<string, any>; // JSON Schema 格式
}

/**
 * 统一补全请求：agent 层构造、provider adapter 消费。
 */
export interface Request {
	/** 系统提示词（可选，设定模型的角色与行为） */
	systemPrompt?: string;
	/** 对话历史消息列表（含用户、助手与工具结果消息） */
	messages: Message[];
	/** 可供模型调用的工具列表（可选） */
	tools?: Tool[];
	/** 采样温度（可选，越高越随机） */
	temperature?: number;
	/** 最大输出 token 数（可选） */
	maxTokens?: number;
	/** 流式正文回调（可选）：每当有新的正文增量文本时触发 */
	onText?: (text: string) => void;
	/** 流式思考回调（可选）：每当有新的思考（reasoning）增量文本时触发 */
	onThinking?: (thinking: string) => void;
	/** 中断信号（可选）：abort 时取消本次请求 */
	signal?: AbortSignal;
}

/**
 * 统一流式事件：补全过程中的判别联合事件序列。
 *
 * - "start"：请求开始，携带模型与 provider 标识
 * - "text"：正文增量；delta 为本次新增文本，content 为至今累计正文
 * - "thinking"：思考增量；delta 为本次新增思考，content 为至今累计思考
 * - "toolCall"：模型发起了一次工具调用
 * - "usage"：携带 token 用量统计（通常在响应尾部出现）
 * - "done"：生成结束，携带停止原因与聚合完成的 assistant 消息
 * - "error"：发生错误，携带错误对象，流程终止
 */
export type Event =
	| { type: "start"; model: string; provider: string }
	| { type: "text"; content: string; delta: string }
	| { type: "thinking"; content: string; delta: string }
	| { type: "toolCall"; toolCall: ToolCall }
	| { type: "usage"; usage: TokenUsage }
	| { type: "done"; reason: StopReason; message: AssistantMessage }
	| { type: "error"; error: Error };

/**
 * 工具调用：模型请求执行某个工具的一次调用。
 */
export interface ToolCall {
	/** 调用唯一标识，用于关联工具结果 */
	id: string;
	/** 要调用的工具名称 */
	name: string;
	/** 调用参数（已从 JSON 字符串解析为对象） */
	arguments: Record<string, any>;
}

/**
 * token 用量统计：一次补全请求消耗的 token 与费用。
 */
export interface TokenUsage {
	/** 输入 token 消耗数 */
	input: number;
	/** 输出 token 消耗数 */
	output: number;
	/** 缓存读取的 token 数 */
	cacheRead: number;
	/** 缓存写入的 token 数 */
	cacheWrite: number;
	/** 按模型单价折算的费用明细（可选） */
	cost?: {
		/** 输入 token 费用 */
		input: number;
		/** 输出 token 费用 */
		output: number;
		/** 缓存读取费用 */
		cacheRead: number;
		/** 缓存写入费用 */
		cacheWrite: number;
		/** 总费用 */
		total: number;
	};
}

/**
 * 停止原因：模型停止生成的统一判别枚举。
 *
 * - "stop"：模型自然输出完毕（正常结束）
 * - "length"：达到 maxTokens / 输出上限被截断
 * - "toolUse"：模型发起工具调用，等待工具结果后继续
 * - "safety"：因安全策略（内容过滤 / 拒答）停止
 * - "error"：发生错误而终止
 */
export type StopReason = "stop" | "length" | "toolUse" | "safety" | "error";
