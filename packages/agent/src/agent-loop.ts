/**
 * @file agent-loop.ts —— Agent 循环核心实现（框架心脏）
 *
 * @description
 * 本文件实现 `runAgentLoop` / `runAgentLoopContinue`，即有状态 LLM Agent 的主循环：
 * 循环执行「流式调用 LLM → 解析助手消息 → 执行工具调用 → 把工具结果追加回上下文 → 进入下一轮」，
 * 直到助手不再发起工具调用、且没有待处理的 steering / follow-up 消息为止。
 *
 * 主要功能点：
 * - 全程以 `AgentMessage` 作为内部消息表示，仅在调用 LLM 的边界处（`streamAssistantResponse`）
 *   通过 `convertToLlm` 转换为 pi-ai 的 `Message[]`；
 * - 流式接收助手响应，边收边发出 `message_start` / `message_update` / `message_end` 等 AgentEvent；
 * - 工具执行支持两种策略：sequential（逐个串行）与 parallel（预检串行、执行并发），
 *   并统一走 `prepareToolCall`（校验 + beforeToolCall 钩子）→ 执行 → `finalizeExecutedToolCall`
 *   （afterToolCall 钩子改写结果）的三段式流水线；
 * - 中断处理：贯穿全流程感知 AbortSignal，工具执行中途 abort 时尽快收尾；
 * - 边界情形：输出 token 截断（stopReason === "length"）时所有工具调用一律判错而不执行；
 * - 支持中途 steering 消息注入、停机前 follow-up 消息排队、`prepareNextTurn` 热更新
 *   模型/思考级别、`shouldStopAfterTurn` 优雅停机等宿主层（harness）扩展点。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：LLM 统一接口（流式事件、工具参数校验、消息类型）；
 * - `./stream-fn.ts`：默认的流式调用函数；
 * - `./types.ts`：AgentContext / AgentEvent / AgentLoopConfig / AgentTool 等类型定义。
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@earendil-works/pi-ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

/**
 * AgentEvent 事件接收器（sink）：循环内部所有事件都经由此回调发出。
 * 支持同步或异步（返回 Promise），循环会按顺序 await，保证事件有序。
 */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * 以一条新的 prompt 消息启动 Agent 循环（EventStream 版本）。
 *
 * prompt 会被追加到 context 中并为其发出 message 事件；
 * 内部委托给 {@link runAgentLoop}，把产生的事件逐个 push 进新建的 EventStream，
 * 循环结束后以完整的新增消息列表作为流的最终结果收尾。
 *
 * @param prompts - 本次运行要注入的新消息（通常是用户输入），按序追加到上下文
 * @param context - Agent 当前上下文（消息历史、工具、系统提示词等）
 * @param config - 循环配置（模型、convertToLlm、各类钩子）
 * @param signal - 中断信号；abort 后循环尽快收尾并发 aborted 相关事件
 * @param streamFn - 实际执行 LLM 流式调用的函数
 * @returns 以 `agent_end` 为终止事件的 AgentEvent 流，最终值为本次运行新增的全部消息
 */

export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 不注入新消息，从当前上下文直接继续 Agent 循环（EventStream 版本）。
 *
 * 用于重试等场景——上下文里已经带有 user 消息或工具结果，
 * 直接发起下一次 LLM 调用即可，不需要再追加 prompt。
 *
 * **重要：** 上下文中的最后一条消息必须能通过 `convertToLlm` 转换为
 * `user` 或 `toolResult` 消息，否则 LLM 供应商会拒绝请求。
 * 此处无法提前校验，因为 `convertToLlm` 每轮只会被调用一次（在 LLM 调用边界）。
 *
 * @param context - Agent 当前上下文，最后一条消息不能是 assistant 消息
 * @param config - 循环配置
 * @param signal - 中断信号
 * @param streamFn - 实际执行 LLM 流式调用的函数
 * @returns 以 `agent_end` 为终止事件的 AgentEvent 流，最终值为本次运行新增的全部消息
 * @throws 当上下文为空，或最后一条消息角色为 assistant 时抛出 Error
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	// 空上下文无法继续：LLM 至少需要一条可转换的 user/toolResult 消息
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	// 以上一条 assistant 消息结尾时不能直接续跑——
	// LLM 协议要求 assistant 消息后必须跟 user 或 toolResult 消息
	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	// 后台启动循环（不 await），把事件转发进流；结束后以新增消息列表收尾流
	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * 以新 prompt 消息运行 Agent 循环（async 回调版本，供宿主层直接消费事件流）。
 *
 * 与 {@link agentLoop} 的区别：不包装 EventStream，而是通过 `emit` 回调同步/异步地
 * 推送事件，调用方自行决定如何消费；返回值为本次运行新增的全部消息（含 prompt）。
 *
 * @param prompts - 本次注入的新消息，按序追加到上下文尾部
 * @param context - Agent 当前上下文
 * @param config - 循环配置
 * @param emit - 事件接收器，循环产生的所有 AgentEvent 都会传给它
 * @param signal - 中断信号
 * @param streamFn - 实际执行 LLM 流式调用的函数；为空时回退到默认实现
 * @returns 本次运行新增的全部消息（prompt + 助手消息 + 工具结果等）
 */
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	// newMessages 只记录“本次运行新增”的消息（含 prompt），作为最终返回值；
	// currentContext 则是拷贝出的运行期上下文，避免直接改写调用方传入的 context
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	// 发出生命周期事件：agent 启动、第一轮开始，以及每条 prompt 的消息事件
	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	// 进入共享主循环；streamFn 未提供时使用默认流式实现
	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

/**
 * 不注入新消息、从当前上下文继续运行 Agent 循环（async 回调版本）。
 *
 * 用于重试：上下文末尾已带有 user 消息或工具结果，直接发起下一次 LLM 调用。
 * 与 {@link runAgentLoop} 一样通过 `emit` 推送事件，但 newMessages 不包含
 * 循环开始前上下文中已有的历史消息。
 *
 * @param context - Agent 当前上下文，最后一条消息不能为空、也不能是 assistant 消息
 * @param config - 循环配置
 * @param emit - 事件接收器
 * @param signal - 中断信号
 * @param streamFn - 实际执行 LLM 流式调用的函数；为空时回退到默认实现
 * @returns 本次运行新增的全部消息（不含循环开始前的历史消息）
 * @throws 当上下文为空，或最后一条消息角色为 assistant 时抛出 Error
 */
export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	// 与 agentLoopContinue 相同的前置校验：必须有消息，且不能以 assistant 消息结尾
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	// 续跑不注入 prompt：newMessages 从空开始，只收集本次循环产生的消息
	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

/**
 * 创建 Agent 循环使用的 EventStream。
 *
 * 终止条件：收到 `agent_end` 事件；流的最终值取该事件携带的 messages（本次运行新增的全部消息）。
 */
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/**
 * agentLoop 与 agentLoopContinue 共享的主循环逻辑。
 *
 * 双层循环结构：
 * - 内层循环：每轮执行「注入 pending 消息 → 流式获取助手响应 → 执行工具 → 轮次收尾」，
 *   只要本轮产生了工具调用或有待处理的 steering 消息就继续下一轮；
 * - 外层循环：当内层结束（Agent 本应停止）时，轮询 follow-up 队列，
 *   有排队消息则重新进入内层，否则结束整个循环。
 *
 * 循环终止条件（任一满足即 emit `agent_end` 并返回）：
 * 1. 助手响应的 stopReason 为 `error` 或 `aborted`（立即终止，不执行工具）；
 * 2. `shouldStopAfterTurn` 钩子返回 true（优雅停机）；
 * 3. 内层循环自然结束且 follow-up 队列为空。
 *
 * @param initialContext - 运行期上下文（messages 会被就地追加）
 * @param newMessages - 输出列表：收集本次运行产生的所有新消息，随事件一并暴露给调用方
 * @param initialConfig - 初始循环配置；每轮可能被 `prepareNextTurn` 返回的快照替换
 * @param signal - 中断信号，工具执行与消息注入路径均会感知
 * @param emit - 事件接收器
 * @param streamFunction - 实际执行 LLM 流式调用的函数
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// 启动时就检查 steering 消息：用户可能在上一轮 LLM 响应期间输入了新指令
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// ========== 外层循环：Agent 本应停止时，若 follow-up 队列有排队消息则继续 ==========
	while (true) {
		// 初始置 true 是为了至少跑一轮（首轮可能只需响应注入的 steering 消息）
		let hasMoreToolCalls = true;

		// ========== 内层循环：处理工具调用与 steering 消息 ==========
		// 终止条件：本轮没有再产生工具调用，且没有待注入的 steering 消息
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			// 首轮的 turn_start 已由外层（runAgentLoop/runAgentLoopContinue）发出，
			// 这里只对后续轮次补发，避免重复
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// 注入 pending 消息：在助手下一次响应之前并入上下文，
			// 使模型能“看到”用户中途插入的指令
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// ========== 流式接收：获取助手响应并转发增量事件 ==========
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			// 错误或中断路径：不再执行任何工具，直接结束本轮并终止整个循环
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 提取本轮助手消息中的全部工具调用
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// stopReason 为 "length" 表示输出被 token 上限截断，消息中的
				// 每个工具调用都可能携带不完整的参数。与其执行可能损坏的调用，
				// 不如把它们全部判错，让模型重新发起。
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				// 工具批量要求 terminate（如某工具显式请求终止）时，内层循环不再继续
				hasMoreToolCalls = !executedToolBatch.terminate;

				// 工具结果同时写入运行期上下文与新增消息列表
				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			// ========== 轮次收尾：turn_end → prepareNextTurn → shouldStopAfterTurn → 轮询 steering ==========
			await emit({ type: "turn_end", message, toolResults });

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			// 宿主层可在下一轮 LLM 调用前热更新上下文/模型/思考级别（如上下文压缩后换模型）
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					// thinkingLevel: 未提供则保持原值；"off" 表示关闭推理（置 undefined）
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			// 优雅停机：宿主层判断当前轮结束后应停止（如上下文即将超限），
			// 当前助手响应与工具执行已正常完成，只是不再发起新一轮 LLM 调用
			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// 轮末轮询 steering 队列：有新消息则内层循环继续（不跳过本轮工具调用）
			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// ========== 外层收尾：Agent 本应停止，检查 follow-up 队列 ==========
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// 作为 pending 消息交给内层循环注入处理
			pendingMessages = followUpMessages;
			continue;
		}

		// 队列为空，没有更多工作，正常退出
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * 流式获取一次助手响应（一次完整的 LLM 调用）。
 * 这里是 AgentMessage[] 转换为 Message[] 的唯一边界——仅在真正调用 LLM 前转换。
 *
 * 处理流程：transformContext（可选的上下文变换，如裁剪/压缩）→ convertToLlm（转为
 * LLM 可读消息）→ 解析 API key → 发起流式调用 → 消费流事件并把增量透传为
 * message_update 事件 → 用最终消息替换上下文中最后一条 partial 消息。
 *
 * @param context - Agent 当前上下文（助手 partial/最终消息会就地写入 messages）
 * @param config - 循环配置
 * @param signal - 中断信号，透传给流式调用
 * @param emit - 事件接收器
 * @param streamFunction - 实际执行 LLM 流式调用的函数
 * @returns 助手的最终 AssistantMessage（已写入上下文并发出 message_end）
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	// 应用可选的上下文变换（AgentMessage[] → AgentMessage[]）：
	// 用于上下文窗口管理（裁剪旧消息）或注入外部信息
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// 转换为 LLM 兼容消息（AgentMessage[] → Message[]），过滤 UI 专用消息等
	const llmMessages = await config.convertToLlm(messages);

	// 组装 LLM 上下文：系统提示词 + 消息 + 工具定义
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// 每次调用前动态解析 API key：对会过期的短期 token（如 OAuth）尤为重要
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// 发起流式调用，abort 信号随配置一并下发
	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});

	// ========== 流式接收：边消费事件边更新上下文中的 partial 消息 ==========
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			// 流开始：把首个 partial 消息立即写入上下文并发出 message_start
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			// 文本 / 思考 / 工具调用的各类增量事件：
			// 用最新 partial 覆盖上下文最后一条消息，并把原始事件透传为 message_update
			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			// 流结束（正常 done 或出错 error）：取最终消息替换上下文中的 partial。
			// 若从未收到过 start 事件（addedPartial 为 false，例如极早出错），
			// 则补发 message_start，保证事件序列完整：start → end
			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}

	// 兜底路径：流自然耗尽但未触发 done/error 事件，仍需取最终消息并补齐事件序列
	const finalMessage = await response.result();
	if (addedPartial) {
		context.messages[context.messages.length - 1] = finalMessage;
	} else {
		context.messages.push(finalMessage);
		await emit({ type: "message_start", message: { ...finalMessage } });
	}
	await emit({ type: "message_end", message: finalMessage });
	return finalMessage;
}

/**
 * 把因输出 token 上限被截断的助手消息中的所有工具调用统一判错（不执行）。
 *
 * Why：流式工具调用参数由尽力而为的 JSON 补救解析器收尾，因此被截断的消息
 * 仍可能产出「参数能通过解析与校验、实则悄悄不完整」的工具调用。这些调用
 * 都不安全，一律报告为错误结果，让模型重新发起完整调用。
 *
 * @param toolCalls - 被截断消息中的工具调用列表
 * @param emit - 事件接收器（仍发出完整的 start/end/结果消息事件序列）
 * @returns 工具结果消息批量；terminate 固定为 false（不要求终止循环）
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		// 即使不执行，也照常发出 tool_execution_start，让事件序列与正常执行一致
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		// 构造错误结果，提示模型参数可能被截断、需重新发起
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * 执行一条助手消息中的全部工具调用（工具调度入口）。
 *
 * 调度策略：全局配置为 "sequential"，或本批中任一工具自身声明
 * executionMode === "sequential" 时，整批退化为串行执行（保证安全顺序）；
 * 否则走并行执行（预检串行、执行并发）。
 *
 * @param currentContext - Agent 当前上下文（用于查找工具定义）
 * @param assistantMessage - 触发本次工具执行的助手消息
 * @param config - 循环配置（toolExecution 决定全局执行模式）
 * @param signal - 中断信号
 * @param emit - 事件接收器
 * @returns 工具结果消息批量及是否要求终止循环
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	// 只要有一个工具要求串行，整批都必须串行：并行预检阶段可能已产生副作用，顺序无法保证
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

/**
 * 一批工具调用的执行结果。
 */
type ExecutedToolCallBatch = {
	/** 生成的工具结果消息（顺序与助手消息中的工具调用顺序一致） */
	messages: ToolResultMessage[];
	/** 是否要求终止：仅当批内所有工具结果都显式 terminate === true 时为 true */
	terminate: boolean;
};

/**
 * 串行执行一批工具调用：逐个「预检 → 执行 → 收尾」，前一个完成后才处理下一个。
 *
 * 适用场景：全局 toolExecution 为 "sequential"，或批内存在声明为串行的工具。
 * 每个工具的 start/end/结果消息事件紧邻发出；abort 后立即停止处理后续调用。
 *
 * @returns 工具结果消息（按执行顺序）及是否要求终止循环
 */
async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		// 预检：查找工具、准备/校验参数、执行 beforeToolCall 钩子
		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			// immediate：预检阶段已直接得出结果（工具不存在 / 校验失败 / 被拦截 / 已 abort），无需执行
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			// prepared：真正执行工具，再经 afterToolCall 钩子收尾
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		// 中断处理：当前工具已完整收尾，剩余未开始的调用直接跳过
		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

/**
 * 并行执行一批工具调用：预检阶段严格串行，被放行的工具随后并发执行。
 *
 * 事件顺序约定：
 * - `tool_execution_start` 在预检阶段按调用顺序发出；
 * - `tool_execution_end` 在并行执行阶段按各工具实际完成顺序发出；
 * - 工具结果消息（message_start/message_end）在全部完成后按助手消息中的
 *   原始顺序统一发出，保证消息历史顺序确定。
 *
 * @returns 工具结果消息（按助手消息中的原始顺序）及是否要求终止循环
 */
async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	// 混合容器：immediate 结果直接存值；prepared 调用存为 thunk（延迟到 Promise.all 才真正执行）
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	// ========== 预检阶段（串行）：逐个校验并决定放行与否 ==========
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			// immediate 结果无需进入并发阶段，直接定稿并发出 end 事件
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			// 中断处理：预检阶段发现 abort，剩余调用不再预检/执行
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		// prepared 调用包装为 thunk：执行 + afterToolCall 收尾 + 发出 end 事件
		// （end 事件在这里发出，因此按完成顺序而非提交顺序）
		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	// ========== 并发执行阶段：放行的工具同时执行，等待全部完成 ==========
	// （thunk 到此刻才调用，即真正并发的起点；值型条目直接透传）
	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);

	// 按助手消息中的原始顺序统一发出结果消息，保证会话历史顺序稳定
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

/** 预检通过、已就绪待执行的工具调用（参数已准备并校验完毕）。 */
type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

/** 预检阶段直接得出结果、无需执行的工具调用（工具缺失 / 参数校验失败 / 被拦截 / 已中断）。 */
type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

/** 工具真正执行后的原始结果（尚未经过 afterToolCall 钩子改写）。 */
type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

/** 定稿后的工具调用结果：已应用 afterToolCall 钩子，可直接生成结果消息。 */
type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

/**
 * 并行执行阶段的混合条目：immediate 结果直接存值；
 * prepared 调用存为 thunk（延迟函数），在 Promise.all 阶段才并发执行。
 */
type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

/**
 * 判断一批工具调用是否要求终止整个循环。
 *
 * 规则：批内非空，且「所有」工具结果都显式 terminate === true 才终止——
 * 只要有一个工具还希望继续（未声明 terminate），循环就照常进行下一轮。
 */
function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

/**
 * 调用工具自带的 prepareArguments 对参数做预处理（如补默认值、格式转换）。
 * 未提供钩子或返回值与入参相同（同引用）时原样返回 toolCall，避免无谓拷贝。
 */
function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	// 只有参数实际变化时才生成新的 toolCall 对象
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

/**
 * 工具调用预检：在真正执行前完成「查找工具 → 准备参数 → 校验 → beforeToolCall 钩子」。
 *
 * 任何一步失败都以 `immediate` 结果短路返回（错误结果 + isError），
 * 不进入执行阶段；全部通过则返回 `prepared`，交由
 * {@link executePreparedToolCall} 执行。
 *
 * @returns prepared（可执行）或 immediate（已直接得出结果，无需执行）
 */
async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	// 步骤 1：按名称查找工具定义，找不到直接报错短路
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		// 步骤 2：参数预处理 + schema 校验（校验失败会抛错，进入下方 catch）
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		// 步骤 3：beforeToolCall 宿主层钩子（权限确认、审计等）
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			// 钩子执行期间可能已 abort，先于拦截判断处理
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			// 钩子拦截：以错误结果返回；若同时声明 terminate，则参与批量终止判定
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		// 步骤 4：最后一道 abort 检查，通过后放行执行
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		// 参数校验等同步/异步异常统一转为错误结果，避免单个坏调用打断整个循环
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

/**
 * 真正执行一个预检通过的工具调用，并转发执行期间的增量更新。
 *
 * 工具可通过 onPartialResult 回调持续产出部分结果，这里将其异步透传为
 * `tool_execution_update` 事件（不 await，先收集后统一等待），
 * 保证工具执行流不被事件消费方阻塞；执行结束后再等待所有更新事件落地。
 * 工具抛错不向外传播，转为 isError 的错误结果。
 *
 * @returns 执行结果（不抛异常；错误以 isError === true 表达）
 */
async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	// 收集进行中的 update 事件 Promise，结束时统一 await
	const updateEvents: Promise<void>[] = [];
	// 执行结束后不再接受新的增量更新，避免在结果定稿后又发出过期事件
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				// 只入队不等待：让工具尽快继续执行，事件稍后统一 flush
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		// 执行成功：关闭增量通道，等待存量 update 事件全部发出
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		// 执行失败：同样先关闭通道、flush 存量事件，再把异常转为错误结果
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

/**
 * 收尾定稿：在工具执行结果上应用 afterToolCall 宿主层钩子（改写/包装结果）。
 *
 * 钩子返回的字段按「提供即覆盖、缺省保原值」的浅覆盖规则合并（不做深合并）；
 * 钩子自身抛错时以错误结果替代原始结果，保证定稿永不失败。
 *
 * @returns 定稿结果，可直接用于生成工具结果消息
 */
async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			// 浅覆盖：仅替换钩子明确提供的字段，其余保留执行时的原值
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			// 钩子抛错：定稿结果整体替换为错误，防止异常逃逸打断循环
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

/**
 * 构造一个仅含文本内容的错误工具结果。
 */
function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

/**
 * 发出单个工具调用的 `tool_execution_end` 事件（携带最终结果与错误标记）。
 */
async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

/**
 * 把定稿的工具调用结果转换为可入会话历史的 ToolResultMessage。
 */
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// 无类型工具（JS 扩展）可能返回没有 content 的结果；在此归一化，
		// 避免 null 进入会话历史或供应商请求载荷。
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

/**
 * 以一对 message_start / message_end 事件发出工具结果消息，
 * 使其与普通消息在事件流中的形态保持一致。
 */
async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
