/**
 * @file agent.ts
 * @description Agent 核心 —— LLM 对话循环、工具调用与统一事件流协议
 * @module pi-agent
 *
 * 主要功能：
 * - 定义 AgentEvent 统一事件总线协议（10 种事件），渲染器与 SessionManager 都基于该协议消费事件
 * - 提供两套核心对话循环：callModelChatCompletionsApi（Chat Completions API）与
 *   callModelResponsesApi（Responses API），均支持工具调用与 AbortSignal 中断
 * - 封装 Agent 类：组装事件扇出（renderer + sessionManager）、管理系统提示词，
 *   提供 ask() / interrupt() / setEvents() 等交互入口
 *
 * 依赖关系：
 * - openai SDK（模型调用）、./tools/tools.js（工具定义与执行）、./session-manager.js（会话持久化）
 */
import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
import type { SessionManager } from "./session-manager.js";
import { executeTool, toolsForChat, toolsForResponses } from "./tools/tools.js";

/**
 * 统一事件总线协议 —— Agent 运行过程中对外发出的全部事件（10 种）的联合类型。
 *
 * 所有下游组件（终端/HTML 渲染器、SessionManager 会话持久化）都实现
 * AgentEventReceiver 接口来消费这些事件；会话恢复（--continue）也完全依赖
 * 重放已记录的事件流，因此事件流即对话的"单一事实来源"。
 */
export type AgentEvent =
	/** 会话开始：构造 Agent 且存在 sessionManager 时发出，携带完整运行配置快照。 */
	| { type: "session_start"; sessionId: string; model: string; api: string; baseURL: string; systemPrompt: string }
	/** 助手回合开始：每次 ask() 驱动模型循环前发出，标志一轮新的 LLM 交互。 */
	| { type: "assistant_start" }
	/** 模型思考/推理文本：Responses API 返回 reasoning 内容时逐段发出。 */
	| { type: "thinking"; text: string }
	/** 工具调用请求：模型决定调用某个工具时（执行前）发出。 */
	| { type: "tool_call"; toolCallId: string; name: string; args: string }
	/** 工具执行结果：工具执行完成（成功或失败）后发出，isError 标记是否出错。 */
	| { type: "tool_result"; toolCallId: string; result: string; isError: boolean }
	/** 助手最终文本回复：模型不再发起工具调用、给出最终答案时发出。 */
	| { type: "assistant_message"; text: string }
	/** 错误通知：模型拒答（refusal）、出现未知响应类型等异常时发出。 */
	| { type: "error"; message: string }
	/** 用户消息回显：ask() 被调用时发出，让渲染器与会话日志同步看到用户输入。 */
	| { type: "user_message"; text: string }
	/** 中断通知：AbortSignal 触发（用户中断）时发出，随后循环抛出 "Interrupted" 错误。 */
	| { type: "interrupted" }
	/** token 用量统计：每次模型响应携带 usage 时发出，用于成本追踪与展示。 */
	| {
			type: "token_usage";
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
	  };

/**
 * 事件接收器接口 —— 所有 AgentEvent 的消费方（渲染器、SessionManager 等）需实现此接口。
 *
 * on() 返回 Promise：核心循环在发出下一个事件前会 await 它，
 * 因此接收器可以通过挂起 Promise 来暂停事件流（例如等待渲染完成）。
 */
export interface AgentEventReceiver {
	/** 接收一个 Agent 事件；实现方负责渲染或持久化 */
	on(event: AgentEvent): Promise<void>;
}

/** Agent 运行配置 —— 连接哪个模型服务、用哪套 API 协议、以及系统提示词。 */
export interface AgentConfig {
	/** OpenAI 兼容 API 的密钥 */
	apiKey: string;
	/** API 端点基础 URL（可指向 OpenAI 官方或任意兼容网关 / vLLM 等） */
	baseURL: string;
	/** 模型名称，如 "gpt-5.1" */
	model: string;
	/** 使用的 API 协议："completions"（Chat Completions）或 "responses"（Responses API），决定走哪个核心循环 */
	api: "completions" | "responses";
	/** 系统提示词，构造 Agent 时作为首条 system 消息注入 */
	systemPrompt: string;
}

/** 一次工具调用的结构化表示（工具名 + JSON 字符串参数 + 调用 ID）。 */
export interface ToolCall {
	/** 工具名称 */
	name: string;
	/** 工具参数（JSON 字符串） */
	arguments: string;
	/** 调用 ID，用于把工具结果与本次调用配对 */
	id: string;
}

/**
 * Responses API 版核心对话循环。
 *
 * 循环逻辑（while (!conversationDone)）：
 * 1. 中断检查点：signal 已触发则发 interrupted 事件并抛出 "Interrupted"
 * 2. 调用 client.responses.create 发起模型请求（携带工具列表与推理配置）
 * 3. 遍历响应的 output item，按类型分发：
 *    - reasoning     → 发 thinking 事件（推理文本）
 *    - message       → 发 assistant_message 事件并置 conversationDone = true，对话结束
 *    - function_call → 执行工具，把 function_call_output 推回消息历史，继续下一轮循环
 *
 * @param client OpenAI SDK 客户端
 * @param model 模型名称
 * @param messages 消息历史（会被就地修改：推入 output item 与工具结果）
 * @param signal 可选的 AbortSignal 中断信号
 * @param eventReceiver 可选的事件接收器（渲染器 / 会话记录）
 */
export async function callModelResponsesApi(
	client: OpenAI,
	model: string,
	messages: any[],
	signal?: AbortSignal,
	eventReceiver?: AgentEventReceiver,
): Promise<void> {
	// 助手回合开始：通知下游新一轮模型交互开始
	await eventReceiver?.on({ type: "assistant_start" });

	// 对话是否已完成（收到最终 message 时置 true）
	let conversationDone = false;

	// ========== 核心循环：直到模型给出最终文本消息（conversationDone）才退出 ==========
	while (!conversationDone) {
		// 中断检查点：每轮模型请求前检查 AbortSignal
		if (signal?.aborted) {
			await eventReceiver?.on({ type: "interrupted" });
			throw new Error("Interrupted");
		}

		// ========== 发起模型请求（Responses API）==========
		const response = await client.responses.create(
			{
				model,
				input: messages, // 整个消息历史（含此前推回的 output item 与工具结果）
				tools: toolsForResponses as any,
				tool_choice: "auto", // 由模型自主决定是否调用工具
				parallel_tool_calls: true, // 允许一轮并行发起多个工具调用
				reasoning: {
					effort: "medium", // 使用中等推理力度
					summary: "auto", // 自动生成推理摘要
				},
				max_output_tokens: 2000, // TODO 改为可配置
			},
			{ signal }, // 把中断信号透传给底层 HTTP 请求
		);

		// 上报 token 用量（Responses API 的 usage 字段格式）
		if (response.usage) {
			const usage = response.usage;
			eventReceiver?.on({
				type: "token_usage",
				inputTokens: usage.input_tokens || 0,
				outputTokens: usage.output_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cacheReadTokens: usage.input_tokens_details.cached_tokens || 0,
				cacheWriteTokens: 0, // API 未提供该指标
			});
		}

		// 本轮响应的全部 output item；为空则直接结束循环
		const output = response.output;
		if (!output) break;

		for (const item of output) {
			// gpt-oss vLLM 兼容 hack：需要从 "message" 事件中去掉 type 字段
			//（gpt-oss 经 vLLM 部署时 message item 的 id 固定为 "message" 而非唯一 ID，
			// 不做处理直接回传会导致下一轮请求格式报错）
			if (item.id === "message") {
				const { type, ...message } = item;
				messages.push(item);
			} else {
				messages.push(item);
			}

			// 无论走哪个分支，都把 output item 原样推回 messages —— Responses API 通过
			// 回传历史 item 维持对话状态；下面再按 item 类型发出对应事件并处理工具调用
			switch (item.type) {
				// 推理内容：逐段提取 reasoning_text，发 thinking 事件
				case "reasoning": {
					for (const content of item.content || []) {
						if (content.type === "reasoning_text") {
							await eventReceiver?.on({ type: "thinking", text: content.text });
						}
					}
					break;
				}

				// 最终文本消息：发 assistant_message 事件，并标记对话完成（结束外层循环）
				case "message": {
					for (const content of item.content || []) {
						if (content.type === "output_text") {
							await eventReceiver?.on({ type: "assistant_message", text: content.text });
						} else if (content.type === "refusal") {
							// 模型拒答：作为 error 事件上报
							await eventReceiver?.on({ type: "error", message: `Refusal: ${content.refusal}` });
						}
						conversationDone = true;
					}
					break;
				}

				// ========== 工具调用：执行工具并把结果推回消息历史 ==========
				case "function_call": {
					// 中断检查点：每个工具执行前检查，保证能及时响应用户中断
					if (signal?.aborted) {
						await eventReceiver?.on({ type: "interrupted" });
						throw new Error("Interrupted");
					}

					try {
						// 执行前先发 tool_call 事件（渲染器据此展示"正在调用 xx 工具"）
						await eventReceiver?.on({
							type: "tool_call",
							toolCallId: item.call_id || "",
							name: item.name,
							args: item.arguments,
						});
						// 执行工具（signal 同时传给工具，长耗时工具内部也能响应中断）
						const result = await executeTool(item.name, item.arguments, signal);
						await eventReceiver?.on({
							type: "tool_result",
							toolCallId: item.call_id || "",
							result,
							isError: false,
						});

						// ========== 结果推回消息历史 ==========
						// 以 function_call_output 形式推回（call_id 与本次调用配对），
						// 模型在下一轮循环中据此看到工具结果并决定后续动作
						const toolResultMsg = {
							type: "function_call_output",
							call_id: item.call_id,
							output: result,
						} as ResponseFunctionToolCallOutputItem;
						messages.push(toolResultMsg);
					} catch (e: any) {
						// 工具执行失败：发 isError 的 tool_result 事件，
						// 并把错误信息同样以 function_call_output 推回 —— 让模型看到失败原因，自行决定重试或放弃
						await eventReceiver?.on({
							type: "tool_result",
							toolCallId: item.call_id || "",
							result: e.message,
							isError: true,
						});
						const errorMsg = {
							type: "function_call_output",
							call_id: item.id,
							output: e.message,
							isError: true,
						};
						messages.push(errorMsg);
					}
					break;
				}

				// 未知输出类型：作为 error 事件上报（不中断循环）
				default: {
					eventReceiver?.on({ type: "error", message: `Unknown output type in LLM response: ${item.type}` });
					break;
				}
			}
		}
	}
}

/**
 * Chat Completions API 版核心对话循环。
 *
 * 循环逻辑（while (!assistantResponded)）：
 * 1. 中断检查点：signal 已触发则发 interrupted 事件并抛出 "Interrupted"
 * 2. 调用 client.chat.completions.create 发起模型请求
 * 3. 若响应携带 tool_calls：
 *    - 先把带 tool_calls 的 assistant 消息推回历史（协议要求 role:"tool" 消息
 *      必须通过 tool_call_id 关联到一条 assistant 消息之后）
 *    - 逐个执行工具，结果以 role:"tool" 消息推回，然后回到步骤 1 再次调用模型
 * 4. 若响应是纯文本（无 tool_calls）：发 assistant_message 事件并置
 *    assistantResponded = true，循环结束
 *
 * @param client OpenAI SDK 客户端
 * @param model 模型名称
 * @param messages 消息历史（会被就地修改：推入 assistant / tool 消息）
 * @param signal 可选的 AbortSignal 中断信号
 * @param eventReceiver 可选的事件接收器（渲染器 / 会话记录）
 */
export async function callModelChatCompletionsApi(
	client: OpenAI,
	model: string,
	messages: any[],
	signal?: AbortSignal,
	eventReceiver?: AgentEventReceiver,
): Promise<void> {
	// 助手回合开始：通知下游新一轮模型交互开始
	await eventReceiver?.on({ type: "assistant_start" });

	// 模型是否已给出最终文本回复（收到无 tool_calls 的响应时置 true）
	let assistantResponded = false;

	// ========== 核心循环：直到模型给出最终文本回复（assistantResponded）才退出 ==========
	while (!assistantResponded) {
		// 中断检查点：每轮模型请求前检查 AbortSignal
		if (signal?.aborted) {
			await eventReceiver?.on({ type: "interrupted" });
			throw new Error("Interrupted");
		}

		// ========== 发起模型请求（Chat Completions API）==========
		const response = await client.chat.completions.create(
			{
				model,
				messages, // 整个消息历史（含此前推回的 assistant / tool 消息）
				tools: toolsForChat,
				tool_choice: "auto", // 由模型自主决定是否调用工具
				max_completion_tokens: 2000, // TODO 改为可配置
			},
			{ signal }, // 把中断信号透传给底层 HTTP 请求
		);

		// 取出首个候选回复（非流式且未调高 n 时 choices 只有一个）
		const message = response.choices[0].message;

		// 上报 token 用量（Chat Completions 的 usage 字段格式）
		if (response.usage) {
			const usage = response.usage;
			await eventReceiver?.on({
				type: "token_usage",
				inputTokens: usage.prompt_tokens || 0,
				outputTokens: usage.completion_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0,
				cacheWriteTokens: 0, // API 未提供该指标
			});
		}

		// ========== 处理 tool_calls：模型要求执行工具 ==========
		if (message.tool_calls && message.tool_calls.length > 0) {
			// 先把带 tool_calls 的 assistant 消息推回历史 —— Why：Chat Completions 协议要求
			// 每条 role:"tool" 消息必须通过 tool_call_id 关联到它前面的 assistant tool_calls 消息，
			// 缺少这条消息，下一轮请求会直接被 API 拒绝
			const assistantMsg: any = {
				role: "assistant",
				content: message.content || null,
				tool_calls: message.tool_calls,
			};
			messages.push(assistantMsg);

			// 逐个展示并执行工具调用（渲染器通过 tool_call 事件展示调用过程）
			for (const toolCall of message.tool_calls) {
				// 中断检查点：每个工具执行前检查，保证能及时响应用户中断
				if (signal?.aborted) {
					await eventReceiver?.on({ type: "interrupted" });
					throw new Error("Interrupted");
				}

				try {
					// 兼容两种调用形态：标准 function 类型取 function 字段，custom 类型取 custom 字段
					const funcName = toolCall.type === "function" ? toolCall.function.name : toolCall.custom.name;
					const funcArgs = toolCall.type === "function" ? toolCall.function.arguments : toolCall.custom.input;

					// 执行前先发 tool_call 事件（渲染器据此展示"正在调用 xx 工具"）
					await eventReceiver?.on({ type: "tool_call", toolCallId: toolCall.id, name: funcName, args: funcArgs });
					// 执行工具（signal 同时传给工具，长耗时工具内部也能响应中断）
					const result = await executeTool(funcName, funcArgs, signal);
					await eventReceiver?.on({ type: "tool_result", toolCallId: toolCall.id, result, isError: false });

					// ========== 结果推回消息历史 ==========
					// 以 role:"tool" + tool_call_id 推回 —— 模型在下一轮请求中
					// 据此知道每个工具调用的结果，进而决定继续调用工具还是给出最终回答
					const toolMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					};
					messages.push(toolMsg);
				} catch (e: any) {
					// 工具执行失败：发 isError 的 tool_result 事件，
					// 并把错误信息同样以 role:"tool" 推回 —— 让模型看到失败原因，自行决定重试或放弃
					eventReceiver?.on({ type: "tool_result", toolCallId: toolCall.id, result: e.message, isError: true });
					const errorMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					};
					messages.push(errorMsg);
				}
			}
		} else if (message.content) {
			// ========== 最终回复：模型给出纯文本，本轮对话结束 ==========
			eventReceiver?.on({ type: "assistant_message", text: message.content });
			const finalMsg = { role: "assistant", content: message.content };
			messages.push(finalMsg);
			assistantResponded = true;
		}
	}
}

/**
 * Agent —— 编码代理的核心封装，整个包对外的心脏。
 *
 * 职责：
 * - 持有 OpenAI 客户端、消息历史与运行配置
 * - 通过 comboReceiver 把每个事件同时扇出给 renderer（UI 渲染）与
 *   sessionManager（会话日志持久化），核心循环无需关心下游消费者
 * - ask() 按 config.api 二选一分发到对应的核心循环；interrupt() 触发中断
 * - setEvents() 从历史事件流重建消息历史，支撑 --continue 会话恢复
 */
export class Agent {
	/** OpenAI SDK 客户端（构造器中按 config 创建） */
	private client: OpenAI;
	/** 对外只读的运行配置 */
	public readonly config: AgentConfig;
	/** 消息历史：completions 模式为 role 消息数组；responses 模式为 output item 数组 */
	private messages: any[] = [];
	/** 可选的渲染器（终端 / HTML 等），接收全部事件用于展示 */
	private renderer?: AgentEventReceiver;
	/** 可选的会话管理器，接收全部事件并持久化为 JSONL 日志 */
	private sessionManager?: SessionManager;
	/** 组合接收器：把每个事件串行扇出给 renderer 与 sessionManager */
	private comboReceiver: AgentEventReceiver;
	/** 当前 ask() 轮次的中断控制器（空闲时为 null） */
	private abortController: AbortController | null = null;

	/**
	 * 构造 Agent：创建客户端、组装事件扇出、注入系统提示词并开启会话记录。
	 *
	 * @param config 运行配置（API 端点、模型、协议类型、系统提示词等）
	 * @param renderer 可选的事件渲染器（未提供则无 UI 输出）
	 * @param sessionManager 可选的会话管理器；提供时开启新会话并发出 session_start 事件
	 */
	constructor(config: AgentConfig, renderer?: AgentEventReceiver, sessionManager?: SessionManager) {
		this.config = config;
		// 按 config 创建 OpenAI SDK 客户端（指向 baseURL 指定的兼容端点）
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
		});

		// 使用调用方提供的渲染器
		this.renderer = renderer;
		this.sessionManager = sessionManager;

		// comboReceiver 扇出设计：一个事件先 await 渲染器、再 await 会话管理器，
		// 串行转发给所有下游消费者 —— 核心循环只面向这一个接收器编程，
		// 新增消费者（如统计、审计）只需在此挂载，无需改动核心循环
		this.comboReceiver = {
			on: async (event: AgentEvent): Promise<void> => {
				await this.renderer?.on(event);
				await this.sessionManager?.on(event);
			},
		};

		// 若配置了系统提示词，则作为首条 system 消息注入消息历史
		if (config.systemPrompt) {
			this.messages.push({ role: "system", content: config.systemPrompt });
		}

		// 存在会话管理器时开启会话记录
		if (sessionManager) {
			sessionManager.startSession(this.config);

			// 发出 session_start 事件（携带会话 ID 与完整配置快照）
			this.comboReceiver.on({
				type: "session_start",
				sessionId: sessionManager.getSessionId(),
				model: config.model,
				api: config.api,
				baseURL: config.baseURL,
				systemPrompt: config.systemPrompt,
			});
		}
	}

	/**
	 * 发起一轮用户交互：记录用户消息，并驱动核心循环直到模型给出最终回复。
	 *
	 * 按 config.api 二选一分发：responses → callModelResponsesApi，
	 * completions → callModelChatCompletionsApi。被中断时视为正常流程静默返回，
	 * 其余异常原样上抛。
	 *
	 * @param userMessage 用户输入文本
	 */
	async ask(userMessage: string): Promise<void> {
		// 用户消息先走事件系统（渲染 + 会话记录），保证 UI 与日志同步看到输入
		this.comboReceiver.on({ type: "user_message", text: userMessage });

		// 用户消息推入消息历史
		const userMsg = { role: "user", content: userMessage };
		this.messages.push(userMsg);

		// 为本轮对话创建独立的 AbortController（interrupt() 即触发它）
		this.abortController = new AbortController();

		try {
			// 按 API 协议分发到对应的核心循环；传入同一份 messages 引用，循环内就地追加
			if (this.config.api === "responses") {
				await callModelResponsesApi(
					this.client,
					this.config.model,
					this.messages,
					this.abortController.signal,
					this.comboReceiver,
				);
			} else {
				await callModelChatCompletionsApi(
					this.client,
					this.config.model,
					this.messages,
					this.abortController.signal,
					this.comboReceiver,
				);
			}
		} catch (e: any) {
			// 中断属于正常流程：静默返回，不向上抛错
			if (e.message === "Interrupted" || this.abortController.signal.aborted) {
				return;
			}
			throw e;
		} finally {
			// 无论成功 / 失败 / 中断，清空中断控制器，标记本轮结束
			this.abortController = null;
		}
	}

	/**
	 * 中断当前 ask() 轮次：触发 AbortController，
	 * 核心循环在下一个中断检查点检测到后发出 interrupted 事件并退出。
	 */
	interrupt(): void {
		this.abortController?.abort();
	}

	/**
	 * 从历史事件流重建消息历史（用于 --continue 恢复会话）。
	 *
	 * 两种 API 的消息结构完全不同，需分别重建：
	 * - responses：按 output item 形态重建（system / user / reasoning /
	 *   function_call / function_call_output / message）
	 * - completions：按 role 消息形态重建；tool_call 事件先暂存到 pendingToolCalls，
	 *   直到遇到第一个 tool_result 才把"带 tool_calls 的 assistant 消息"推入历史，
	 *   以满足"role:'tool' 消息必须紧跟配对的 assistant 消息"的协议约束
	 *
	 * thinking / error / interrupted / token_usage 等事件不影响消息历史，直接跳过。
	 *
	 * @param events 已记录的历史事件流（通常来自 SessionManager 读取的 JSONL 会话文件）
	 */
	setEvents(events: AgentEvent[]): void {
		// 按当前 API 类型，从事件流重建消息历史
		this.messages = [];

		if (this.config.api === "responses") {
			// ===== Responses API 格式重建 =====
			// 系统提示词在 Responses API 中是 type:"system" 的 output item
			if (this.config.systemPrompt) {
				this.messages.push({
					type: "system",
					content: [{ type: "system_text", text: this.config.systemPrompt }],
				});
			}

			for (const event of events) {
				switch (event.type) {
					// 用户消息 → user item（input_text 内容）
					case "user_message":
						this.messages.push({
							type: "user",
							content: [{ type: "input_text", text: event.text }],
						});
						break;

					// 思考事件 → reasoning item（保留模型推理上下文）
					case "thinking":
						this.messages.push({
							type: "reasoning",
							content: [{ type: "reasoning_text", text: event.text }],
						});
						break;

					// 工具调用 → function_call item
					case "tool_call":
						this.messages.push({
							type: "function_call",
							id: event.toolCallId,
							name: event.name,
							arguments: event.args,
						});
						break;

					// 工具结果 → function_call_output item（通过 call_id 与调用配对）
					case "tool_result":
						this.messages.push({
							type: "function_call_output",
							call_id: event.toolCallId,
							output: event.result,
						});
						break;

					// 最终回复 → message item（output_text）
					case "assistant_message":
						this.messages.push({
							type: "message",
							content: [{ type: "output_text", text: event.text }],
						});
						break;
				}
			}
		} else {
			// ===== Chat Completions API 格式重建 =====
			// 系统提示词在 Completions API 中是 role:"system" 消息
			if (this.config.systemPrompt) {
				this.messages.push({ role: "system", content: this.config.systemPrompt });
			}

			// pendingToolCalls 配对逻辑：按顺序暂存本轮收到的 tool_call 事件；
			// 直到第一个 tool_result 出现，才把累积的调用打包成一条
			// "带 tool_calls 的 assistant 消息"推入历史 —— 这样每条 role:"tool"
			// 结果之前都有配对的 assistant 消息，符合 Chat Completions 协议要求
			let pendingToolCalls: any[] = [];

			for (const event of events) {
				switch (event.type) {
					// 用户消息 → role:"user"
					case "user_message":
						this.messages.push({ role: "user", content: event.text });
						break;

					// 新的助手回合开始：清空上一轮残留的待配对工具调用
					case "assistant_start":
						pendingToolCalls = [];
						break;

					// 暂存工具调用（先不推入历史，等待与 tool_result 配对）
					case "tool_call":
						pendingToolCalls.push({
							id: event.toolCallId,
							type: "function",
							function: {
								name: event.name,
								arguments: event.args,
							},
						});
						break;

					case "tool_result":
						// 收到第一个工具结果时，先把累积的全部 tool_calls
						// 作为一条 assistant 消息推入（完成配对），再推工具结果
						if (pendingToolCalls.length > 0) {
							this.messages.push({
								role: "assistant",
								content: null,
								tool_calls: pendingToolCalls,
							});
							pendingToolCalls = [];
						}
						// 工具结果以 role:"tool" 推入，通过 tool_call_id 与调用关联
						this.messages.push({
							role: "tool",
							tool_call_id: event.toolCallId,
							content: event.result,
						});
						break;

					// 最终回复（无工具调用的纯文本 assistant 消息）
					case "assistant_message":
						this.messages.push({ role: "assistant", content: event.text });
						break;

					// 跳过不影响消息历史的事件类型（thinking、error、interrupted、token_usage）
				}
			}
		}
	}
}
