/**
 * @file agent.ts
 * @description pi monorepo AI coding agent 的核心文件，由三大部分组成：
 *
 * 1. 事件协议层：`AgentEvent` 判别联合类型 + `AgentEventReceiver` 接收器接口。
 *    Agent 与外界（UI 渲染器、会话持久化）之间唯一的通信通道——所有行为
 *    （推理过程、工具调用、最终回答、token 用量等）都以事件流形式向外广播。
 *
 * 2. Provider 方言适配层：`detectProvider` / `parseReasoningFromMessage` /
 *    `adjustRequestForProvider` / `checkReasoningSupport`。
 *    统一通过 openai SDK 访问所有厂商，但各家在「推理（reasoning）参数怎么传、
 *    推理内容在响应里怎么放」上互不兼容，这一层负责抹平差异。
 *
 * 3. Agent 类主循环：管理会话消息历史，按配置分发到 Responses API 或
 *    Chat Completions API 两种主循环（工具调用结果回填到消息历史、循环直到模型
 *    给出最终回答），并支持中断（`interrupt`）与基于事件流的会话重放（`setEvents`）。
 *
 * 依赖关系：openai SDK（统一的 HTTP 客户端）、./session-manager.js（会话持久化，
 * 同样以 AgentEventReceiver 形式消费事件）、./tools/tools.js（工具定义与执行）。
 */
import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
import type { SessionManager } from "./session-manager.js";
import { executeTool, toolsForChat, toolsForResponses } from "./tools/tools.js";

/**
 * Agent 事件类型（判别联合，判别字段为 `type`）。
 *
 * 这是整个 agent 的事件总线协议：UI 渲染与会话持久化都通过监听这些事件
 * 来感知 agent 的一举一动，因此每新增一种对外可见的行为都应扩展此联合类型。
 */
export type AgentEvent =
	/** 会话开始：携带会话元信息（会话 ID、模型、API 类型、base URL、系统提示词） */
	| { type: "session_start"; sessionId: string; model: string; api: string; baseURL: string; systemPrompt: string }
	/** 一轮助手回答开始（每次用户提问后触发一次） */
	| { type: "assistant_start" }
	/** 模型的推理（思考）过程文本，供 UI 折叠展示 */
	| { type: "reasoning"; text: string }
	/** 模型发起一次工具调用：调用 ID、工具名、JSON 字符串形式的参数 */
	| { type: "tool_call"; toolCallId: string; name: string; args: string }
	/** 一次工具调用的执行结果；isError 标记执行是否失败 */
	| { type: "tool_result"; toolCallId: string; result: string; isError: boolean }
	/** 模型的最终回答文本（不含推理内容） */
	| { type: "assistant_message"; text: string }
	/** 错误信息（模型拒答、未知响应类型等） */
	| { type: "error"; message: string }
	/** 用户输入的一条消息 */
	| { type: "user_message"; text: string }
	/** 当前这轮回答被用户中断 */
	| { type: "interrupted" }
	/** 本轮请求的 token 用量统计（输入/输出/总计/缓存读/缓存写/推理 token） */
	| {
			type: "token_usage";
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
			reasoningTokens: number;
	  };

/**
 * 事件接收器接口：任何想消费 AgentEvent 事件流的对象（UI 渲染器、会话管理器）都实现此接口。
 * `on` 返回 Promise，agent 会 await 它，保证事件被顺序处理完再继续。
 */
export interface AgentEventReceiver {
	on(event: AgentEvent): Promise<void>;
}

/**
 * Agent 配置项。
 */
export interface AgentConfig {
	/** API 密钥 */
	apiKey: string;
	/** API 端点地址（也是 provider 探测的依据） */
	baseURL: string;
	/** 模型名称 */
	model: string;
	/** 使用哪种 OpenAI API 协议：completions（Chat Completions）或 responses（Responses） */
	api: "completions" | "responses";
	/** 系统提示词 */
	systemPrompt: string;
}

/**
 * 一次待执行的工具调用（模型返回的结构）。
 */
export interface ToolCall {
	/** 工具名 */
	name: string;
	/** JSON 字符串形式的调用参数 */
	arguments: string;
	/** 调用 ID，用于把工具结果回填给对应的调用 */
	id: string;
}

// 按 API 类型缓存「模型是否支持推理」的探测结果（key 为模型名）
// Why: 探测需要真实发一次请求，代价高；同一模型的结果不会变化，缓存避免重复探测
const modelReasoningSupport = new Map<string, { completions?: boolean; responses?: boolean }>();

/**
 * 根据 base URL 探测目标 provider。
 *
 * Why: 所有厂商都通过 openai SDK 的兼容层访问，SDK 本身不知道对面是谁；
 * 而各家对 reasoning 参数的要求差异很大，必须先识别厂商再做方言适配。
 *
 * @param baseURL API 端点地址
 * @returns 探测到的 provider 名称
 */
function detectProvider(baseURL?: string): "openai" | "gemini" | "groq" | "anthropic" | "openrouter" | "other" {
	if (!baseURL) return "openai";
	if (baseURL.includes("api.openai.com")) return "openai";
	if (baseURL.includes("generativelanguage.googleapis.com")) return "gemini";
	if (baseURL.includes("api.groq.com")) return "groq";
	if (baseURL.includes("api.anthropic.com")) return "anthropic";
	if (baseURL.includes("openrouter.ai")) return "openrouter";
	return "other";
}

/**
 * 从 Chat Completions 的消息中解析出厂商私有的推理（reasoning）内容。
 *
 * Why: 各厂商把「思考过程」放在不同位置——Gemini 混在正文里的 <thought> 标签中，
 * Groq/OpenRouter 放在独立的 message.reasoning 字段——需要分别提取，
 * 并把推理文本从最终回答正文中剥离，避免用户看到混着思考内容的答案。
 *
 * @param message Chat Completions 返回的 assistant 消息对象
 * @param baseURL 用于探测 provider
 * @returns cleanContent: 剥离推理后的正文；reasoningTexts: 提取出的推理文本列表
 */
function parseReasoningFromMessage(message: any, baseURL?: string): { cleanContent: string; reasoningTexts: string[] } {
	const provider = detectProvider(baseURL);
	const reasoningTexts: string[] = [];
	let cleanContent = message.content || "";

	switch (provider) {
		case "gemini":
			// Gemini 把思考过程放在 <thought> 标签里，混在正文中间
			if (cleanContent.includes("<thought>")) {
				const thoughtMatches = cleanContent.matchAll(/<thought>([\s\S]*?)<\/thought>/g);
				for (const match of thoughtMatches) {
					reasoningTexts.push(match[1].trim());
				}
				// 从响应中移除所有 thought 标签
				cleanContent = cleanContent.replace(/<thought>[\s\S]*?<\/thought>/g, "").trim();
			}
			break;

		case "groq":
			// Groq 在 reasoning_format 为 "parsed" 时，把推理放在单独的 reasoning 字段
			if (message.reasoning) {
				reasoningTexts.push(message.reasoning);
			}
			break;

		case "openrouter":
			// OpenRouter 把推理放在 message.reasoning 字段
			if (message.reasoning) {
				reasoningTexts.push(message.reasoning);
			}
			break;

		default:
			// 其他 provider 不会在消息正文中内嵌推理内容
			break;
	}

	return { cleanContent, reasoningTexts };
}

/**
 * 按各 provider 的私有要求调整请求参数（方言适配的核心）。
 *
 * Why: 标准 OpenAI 协议里只有 reasoning_effort / reasoning 这类参数，
 * 但 Gemini 需要 google.thinking_config、Groq 需要 reasoning_format、
 * OpenRouter 需要自定义的 reasoning.effort——同一个「开启推理」的意图，
 * 到每家都要翻译成不同的请求体形状，否则请求会被直接拒绝。
 *
 * @param requestOptions 即将发送的请求体（会被就地修改）
 * @param api 当前使用的 API 协议（completions / responses）
 * @param baseURL 用于探测 provider
 * @param supportsReasoning 模型是否支持推理（由 checkReasoningSupport 探测）
 * @returns 调整后的请求体
 */
function adjustRequestForProvider(
	requestOptions: any,
	api: "completions" | "responses",
	baseURL?: string,
	supportsReasoning?: boolean,
): any {
	const provider = detectProvider(baseURL);

	// 按厂商分别调整请求参数
	switch (provider) {
		case "gemini":
			if (api === "completions" && supportsReasoning && requestOptions.reasoning_effort) {
				// Gemini 需要 extra_body 来开启思考内容
				// reasoning_effort 与 thinking_config 不能同时使用
				// 把 OpenAI 风格的推理档位映射为 Gemini 的思考 token 预算
				const budget =
					requestOptions.reasoning_effort === "low"
						? 1024
						: requestOptions.reasoning_effort === "medium"
							? 8192
							: 24576;

				requestOptions.extra_body = {
					google: {
						thinking_config: {
							thinking_budget: budget,
							include_thoughts: true,
						},
					},
				};
				// 使用 thinking_config 时必须移除 reasoning_effort
				delete requestOptions.reasoning_effort;
			}
			break;

		case "groq":
			if (api === "responses" && requestOptions.reasoning) {
				// Groq 的 Responses API 不支持 reasoning.summary
				delete requestOptions.reasoning.summary;
			} else if (api === "completions" && supportsReasoning && requestOptions.reasoning_effort) {
				// Groq Chat Completions 需要用 reasoning_format 而不只是 reasoning_effort
				requestOptions.reasoning_format = "parsed";
				// Groq 保留 reasoning_effort 参数
			}
			break;

		case "anthropic":
			// Anthropic 的 OpenAI 兼容层有自己的怪癖
			// 但思考内容无法通过 OpenAI 兼容层获取，这里无需调整
			break;

		case "openrouter":
			// OpenRouter 使用统一的 reasoning 参数格式
			if (api === "completions" && supportsReasoning && requestOptions.reasoning_effort) {
				// 把 reasoning_effort 转换为 OpenRouter 的 reasoning 格式
				// 注意：OpenRouter 没有 "minimal" 档位，统一降级为 "low"
				requestOptions.reasoning = {
					effort:
						requestOptions.reasoning_effort === "low"
							? "low"
							: requestOptions.reasoning_effort === "minimal"
								? "low"
								: requestOptions.reasoning_effort === "medium"
									? "medium"
									: "high",
				};
				delete requestOptions.reasoning_effort;
			}
			break;

		default:
			// OpenAI 及其他厂商使用标准格式，无需调整
			break;
	}

	return requestOptions;
}

/**
 * 探测模型是否支持推理（reasoning）能力。
 *
 * Why: 没有可靠的官方能力列表，且通过兼容层访问的第三方模型行为不一，
 * 只能真实发一次带推理参数的最小请求试探：成功即支持，报错即不支持。
 * 结果按「模型名 + API 类型」缓存（见 modelReasoningSupport），每个模型只探测一次。
 *
 * @param client OpenAI 客户端
 * @param model 模型名
 * @param api API 协议类型（completions / responses）
 * @param baseURL 用于探测 provider
 * @param signal 中断信号，探测前先检查是否已被中断
 * @returns 模型是否支持推理
 */
async function checkReasoningSupport(
	client: OpenAI,
	model: string,
	api: "completions" | "responses",
	baseURL?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	// ========== 中断检查 ==========
	// 若已被中断则直接抛错，不再发探测请求
	if (signal?.aborted) {
		throw new Error("Interrupted");
	}

	// ========== 查缓存 ==========
	// 同一模型 + 同一 API 的探测结果不会变化，命中缓存直接返回
	const cacheKey = model;
	const cached = modelReasoningSupport.get(cacheKey);
	if (cached && cached[api] !== undefined) {
		return cached[api]!;
	}

	let supportsReasoning = false;
	const provider = detectProvider(baseURL);

	// ========== 发最小试探请求 ==========
	if (api === "responses") {
		// Responses API：带 reasoning 参数发一个最小请求试探
		try {
			const testRequest: any = {
				model,
				input: "test",
				max_output_tokens: 1024,
				reasoning: {
					effort: "low", // 用 low 而不是 minimal，确保能拿到推理摘要
				},
			};
			await client.responses.create(testRequest, { signal });
			supportsReasoning = true;
		} catch (error) {
			supportsReasoning = false;
		}
	} else {
		// Chat Completions API：带 reasoning 参数发一个最小请求试探
		try {
			const testRequest: any = {
				model,
				messages: [{ role: "user", content: "test" }],
				max_completion_tokens: 1024,
			};

			// 按 provider 添加各自方言的推理参数
			if (provider === "gemini") {
				// Gemini 用 extra_body 传递思考配置
				testRequest.extra_body = {
					google: {
						thinking_config: {
							thinking_budget: 100, // 探测用的最小可用预算
							include_thoughts: true,
						},
					},
				};
			} else if (provider === "groq") {
				// Groq 需要同时指定 reasoning_format 和 reasoning_effort
				testRequest.reasoning_format = "parsed";
				testRequest.reasoning_effort = "low";
			} else {
				// 其他厂商用 reasoning_effort
				testRequest.reasoning_effort = "minimal";
			}

			await client.chat.completions.create(testRequest, { signal });
			supportsReasoning = true;
		} catch (error) {
			supportsReasoning = false;
		}
	}

	// ========== 回写缓存 ==========
	const existing = modelReasoningSupport.get(cacheKey) || {};
	existing[api] = supportsReasoning;
	modelReasoningSupport.set(cacheKey, existing);

	return supportsReasoning;
}

/**
 * Responses API 主循环：反复调用模型，执行工具并把结果回填到消息历史，
 * 直到模型输出最终文本回答（或被中断）才返回。
 *
 * @param client OpenAI 客户端
 * @param model 模型名
 * @param messages 消息历史（Responses API 格式的 item 列表，会被就地追加）
 * @param signal 中断信号
 * @param eventReceiver 事件接收器（可选）
 * @param supportsReasoning 模型是否支持推理
 * @param baseURL 用于探测 provider
 */
export async function callModelResponsesApi(
	client: OpenAI,
	model: string,
	messages: any[],
	signal?: AbortSignal,
	eventReceiver?: AgentEventReceiver,
	supportsReasoning?: boolean,
	baseURL?: string,
): Promise<void> {
	let conversationDone = false;

	while (!conversationDone) {
		// ========== 中断检查 ==========
		// 每轮循环开始前检查是否已被用户中断
		if (signal?.aborted) {
			throw new Error("Interrupted");
		}

		// ========== 构造请求 ==========
		let requestOptions: any = {
			model,
			input: messages,
			tools: toolsForResponses as any,
			tool_choice: "auto",
			parallel_tool_calls: true,
			max_output_tokens: 2000, // TODO 改为可配置
			...(supportsReasoning && {
				reasoning: {
					effort: "minimal", // Responses API 用 minimal 推理档位
					summary: "detailed", // 请求详细的推理摘要
				},
			}),
		};

		// 应用 provider 方言调整
		requestOptions = adjustRequestForProvider(requestOptions, "responses", baseURL, supportsReasoning);

		const response = await client.responses.create(requestOptions, { signal });

		// ========== 上报 token 用量（Responses API 格式） ==========
		if (response.usage) {
			const usage = response.usage;
			eventReceiver?.on({
				type: "token_usage",
				inputTokens: usage.input_tokens || 0,
				outputTokens: usage.output_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cacheReadTokens: usage.input_tokens_details?.cached_tokens || 0,
				cacheWriteTokens: 0, // API 不提供该数据
				reasoningTokens: usage.output_tokens_details?.reasoning_tokens || 0,
			});
		}

		const output = response.output;
		if (!output) break;

		// ========== 逐项处理模型输出 ==========
		for (const item of output) {
			// gpt-oss vLLM 的怪癖：需要从 "message" 事件中移除 type 字段
			// NOTE: 解构出的 message 变量当前未被使用，原样保留（保持既有行为）
			if (item.id === "message") {
				const { type, ...message } = item;
				messages.push(item);
			} else {
				messages.push(item);
			}

			switch (item.type) {
				case "reasoning": {
					// 兼容两种格式：content（o1/o3 系列）与 summary（gpt-5 系列）
					const reasoningItems = item.content || item.summary || [];
					for (const content of reasoningItems) {
						if (content.type === "reasoning_text" || content.type === "summary_text") {
							await eventReceiver?.on({ type: "reasoning", text: content.text });
						}
					}
					break;
				}

				case "message": {
					// 最终文本回答：遍历内容块，输出文本或报告拒答
					for (const content of item.content || []) {
						if (content.type === "output_text") {
							await eventReceiver?.on({ type: "assistant_message", text: content.text });
						} else if (content.type === "refusal") {
							await eventReceiver?.on({ type: "error", message: `Refusal: ${content.refusal}` });
						}
						conversationDone = true;
					}
					break;
				}

				case "function_call": {
					// ========== 工具调用：执行并回填结果 ==========
					// Why 回填：Responses API 是有状态的 item 列表，模型下一轮要靠
					// function_call_output item 看到 tool 执行结果才能继续推理
					if (signal?.aborted) {
						throw new Error("Interrupted");
					}

					try {
						await eventReceiver?.on({
							type: "tool_call",
							toolCallId: item.call_id || "",
							name: item.name,
							args: item.arguments,
						});
						const result = await executeTool(item.name, item.arguments, signal);
						await eventReceiver?.on({
							type: "tool_result",
							toolCallId: item.call_id || "",
							result,
							isError: false,
						});

						// 把工具结果追加进消息历史
						const toolResultMsg = {
							type: "function_call_output",
							call_id: item.call_id,
							output: result,
						} as ResponseFunctionToolCallOutputItem;
						messages.push(toolResultMsg);
					} catch (e: any) {
						// 执行失败也要回填：以 function_call_output 形式把错误信息
						// 追加进历史，让模型知道工具失败并自行决定如何处理
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

				default: {
					eventReceiver?.on({ type: "error", message: `Unknown output type in LLM response: ${item.type}` });
					break;
				}
			}
		}
	}
}

/**
 * Chat Completions API 主循环：反复调用模型，执行工具并把结果回填到消息历史，
 * 直到模型给出不含工具调用的最终回答（或被中断）才返回。
 *
 * @param client OpenAI 客户端
 * @param model 模型名
 * @param messages 消息历史（Chat Completions 格式的 role 消息数组，会被就地追加）
 * @param signal 中断信号
 * @param eventReceiver 事件接收器（可选）
 * @param supportsReasoning 模型是否支持推理
 * @param baseURL 用于探测 provider
 */
export async function callModelChatCompletionsApi(
	client: OpenAI,
	model: string,
	messages: any[],
	signal?: AbortSignal,
	eventReceiver?: AgentEventReceiver,
	supportsReasoning?: boolean,
	baseURL?: string,
): Promise<void> {
	let assistantResponded = false;

	while (!assistantResponded) {
		if (signal?.aborted) {
			throw new Error("Interrupted");
		}

		// ========== 构造请求 ==========
		let requestOptions: any = {
			model,
			messages,
			tools: toolsForChat,
			tool_choice: "auto",
			max_completion_tokens: 2000, // TODO 改为可配置
			...(supportsReasoning && {
				reasoning_effort: "low", // Chat Completions API 用 low 推理档位
			}),
		};

		// 应用 provider 方言调整
		requestOptions = adjustRequestForProvider(requestOptions, "completions", baseURL, supportsReasoning);

		const response = await client.chat.completions.create(requestOptions, { signal });

		const message = response.choices[0].message;

		// ========== 上报 token 用量（Chat Completions 格式） ==========
		if (response.usage) {
			const usage = response.usage;
			await eventReceiver?.on({
				type: "token_usage",
				inputTokens: usage.prompt_tokens || 0,
				outputTokens: usage.completion_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0,
				cacheWriteTokens: 0, // API 不提供该数据
				reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
			});
		}

		// ========== 分支一：模型发起了工具调用 ==========
		if (message.tool_calls && message.tool_calls.length > 0) {
			// 先把带 tool_calls 的 assistant 消息压入历史
			// Why: Chat Completions 协议要求 tool 结果消息之前必须有对应的
			// assistant(tool_calls) 消息，否则请求会被拒绝
			const assistantMsg: any = {
				role: "assistant",
				content: message.content || null,
				tool_calls: message.tool_calls,
			};
			messages.push(assistantMsg);

			// 展示并执行每一个工具调用
			for (const toolCall of message.tool_calls) {
				// 执行工具前先检查是否被中断
				if (signal?.aborted) {
					throw new Error("Interrupted");
				}

				try {
					// 兼容两种工具调用形态：标准 function 与自定义 custom 工具
					const funcName = toolCall.type === "function" ? toolCall.function.name : toolCall.custom.name;
					const funcArgs = toolCall.type === "function" ? toolCall.function.arguments : toolCall.custom.input;

					await eventReceiver?.on({ type: "tool_call", toolCallId: toolCall.id, name: funcName, args: funcArgs });
					const result = await executeTool(funcName, funcArgs, signal);
					await eventReceiver?.on({ type: "tool_result", toolCallId: toolCall.id, result, isError: false });

					// 以 role=tool 消息把执行结果回填进历史，供模型下一轮读取
					const toolMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					};
					messages.push(toolMsg);
				} catch (e: any) {
					// 执行失败也回填为 tool 消息，把错误内容交给模型处理
					eventReceiver?.on({ type: "tool_result", toolCallId: toolCall.id, result: e.message, isError: true });
					const errorMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					};
					messages.push(errorMsg);
				}
			}
			// 工具结果已回填，循环继续：带着结果再次请求模型
		} else if (message.content) {
			// ========== 分支二：模型给出最终回答 ==========
			// 从消息中解析 provider 私有的推理内容
			const { cleanContent, reasoningTexts } = parseReasoningFromMessage(message, baseURL);

			// 先逐条发出推理事件（若有）
			for (const reasoning of reasoningTexts) {
				await eventReceiver?.on({ type: "reasoning", text: reasoning });
			}

			// 再发出剥离推理后的最终回答，并压入历史、结束循环
			await eventReceiver?.on({ type: "assistant_message", text: cleanContent });
			const finalMsg = { role: "assistant", content: cleanContent };
			messages.push(finalMsg);
			assistantResponded = true;
		}
	}
}

/**
 * Agent 类：面向上层的主入口。
 *
 * 职责：持有会话配置与消息历史；把事件同时广播给渲染器（UI）和会话管理器
 * （持久化）（comboReceiver）；驱动两种 API 主循环；提供中断与基于事件的
 * 会话恢复能力。
 */
export class Agent {
	/** OpenAI 客户端（所有 provider 都经此兼容层访问） */
	private client: OpenAI;
	/** 只读的 agent 配置（对外暴露） */
	public readonly config: AgentConfig;
	/** 会话消息历史（格式随 config.api 而定，Responses 为 item 列表、Completions 为 role 消息数组） */
	private messages: any[] = [];
	/** 可选的 UI 渲染器（事件接收器） */
	private renderer?: AgentEventReceiver;
	/** 可选的会话管理器（事件持久化） */
	private sessionManager?: SessionManager;
	/** 组合接收器：把事件同时分发给 renderer 与 sessionManager */
	private comboReceiver: AgentEventReceiver;
	/** 当前这轮 ask() 的中断控制器；空闲时为 null */
	private abortController: AbortController | null = null;
	/** 推理能力探测结果缓存（null 表示尚未探测过） */
	private supportsReasoning: boolean | null = null;

	/**
	 * @param config agent 配置
	 * @param renderer UI 渲染器（可选，不传则不渲染）
	 * @param sessionManager 会话管理器（可选，传入则开启会话日志）
	 */
	constructor(config: AgentConfig, renderer?: AgentEventReceiver, sessionManager?: SessionManager) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
		});

		// 使用调用方提供的渲染器，否则不渲染（默认不落到控制台）
		this.renderer = renderer;
		this.sessionManager = sessionManager;

		// 组合接收器：每个事件先给 UI 渲染，再交给会话管理器持久化
		this.comboReceiver = {
			on: async (event: AgentEvent): Promise<void> => {
				await this.renderer?.on(event);
				await this.sessionManager?.on(event);
			},
		};

		// 若提供了系统提示词，则作为首条 developer 消息初始化历史
		if (config.systemPrompt) {
			this.messages.push({
				role: "developer",
				content: config.systemPrompt,
			});
		}

		// 若存在会话管理器则开启会话日志
		if (sessionManager) {
			sessionManager.startSession(this.config);

			// 发出 session_start 事件
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
	 * 发送一条用户消息并驱动模型直到本轮回答完成。
	 *
	 * @param userMessage 用户输入的文本
	 */
	async ask(userMessage: string): Promise<void> {
		// 用户消息也走事件系统渲染（保证 UI 与持久化口径一致）
		this.comboReceiver.on({ type: "user_message", text: userMessage });

		// 把用户消息压入历史
		const userMsg = { role: "user", content: userMessage };
		this.messages.push(userMsg);

		// 为本轮对话创建新的 AbortController（每轮独立，支持中断）
		this.abortController = new AbortController();

		try {
			await this.comboReceiver.on({ type: "assistant_start" });

			// 推理能力探测只做一次，结果缓存在实例上
			if (this.supportsReasoning === null) {
				this.supportsReasoning = await checkReasoningSupport(
					this.client,
					this.config.model,
					this.config.api,
					this.config.baseURL,
					this.abortController.signal,
				);
			}

			// 按配置分发到对应 API 的主循环
			if (this.config.api === "responses") {
				await callModelResponsesApi(
					this.client,
					this.config.model,
					this.messages,
					this.abortController.signal,
					this.comboReceiver,
					this.supportsReasoning,
					this.config.baseURL,
				);
			} else {
				await callModelChatCompletionsApi(
					this.client,
					this.config.model,
					this.messages,
					this.abortController.signal,
					this.comboReceiver,
					this.supportsReasoning,
					this.config.baseURL,
				);
			}
		} catch (e) {
			// ========== 中断的识别与兜底 ==========
			// Why: interrupt() 通过 abort 信号让底层请求抛错中断，错误本身没有
			// 专属类型，只能靠检查 abort 信号区分「用户主动中断」与「真实故障」：
			// 前者发出 interrupted 事件让 UI 正确收尾后正常返回，后者原样上抛
			if (this.abortController.signal.aborted) {
				// 发出 interrupted 事件，让 UI 能正确清理状态
				await this.comboReceiver?.on({ type: "interrupted" });
				return;
			}
			throw e;
		} finally {
			this.abortController = null;
		}
	}

	/**
	 * 中断当前正在进行的 ask() 调用。
	 *
	 * Why: 通过 AbortController 的 abort 信号实现——底层 OpenAI 请求与工具执行
	 * 都监听同一 signal，abort 后主循环会抛出 "Interrupted" 错误，由 ask()
	 * 的 catch 分支识别并转为 interrupted 事件。空闲时（abortController 为
	 * null）调用是安全的 no-op。
	 */
	interrupt(): void {
		this.abortController?.abort();
	}

	/**
	 * 用历史事件流重建消息历史（会话重放 / 恢复）。
	 *
	 * Why: 会话管理器持久化的是 AgentEvent 事件流而非原始消息，恢复会话时需要
	 * 把事件反向翻译回当前 API 协议要求的消息格式。两种 API 的消息形状完全不同
	 * （Responses 是带 type 的 item 列表，Completions 是 role 消息数组，且后者
	 * 要求 tool 消息前必须有携带 tool_calls 的 assistant 消息），因此分两条路径重建。
	 *
	 * @param events 按时间顺序排列的历史事件列表
	 */
	setEvents(events: AgentEvent[]): void {
		// 根据 API 类型，从事件流重建消息
		this.messages = [];

		// ========== 路径一：Responses API 格式 ==========
		if (this.config.api === "responses") {
			// 系统提示词作为 developer 消息打头
			if (this.config.systemPrompt) {
				this.messages.push({
					role: "developer",
					content: this.config.systemPrompt,
				});
			}

			for (const event of events) {
				switch (event.type) {
					case "user_message":
						// 用户消息 → role=user + input_text 内容块
						this.messages.push({
							role: "user",
							content: [{ type: "input_text", text: event.text }],
						});
						break;

					case "reasoning":
						// 推理 → reasoning item
						this.messages.push({
							type: "reasoning",
							content: [{ type: "reasoning_text", text: event.text }],
						});
						break;

					case "tool_call":
						// 工具调用 → function_call item
						this.messages.push({
							type: "function_call",
							id: event.toolCallId,
							name: event.name,
							arguments: event.args,
						});
						break;

					case "tool_result":
						// 工具结果 → function_call_output item
						this.messages.push({
							type: "function_call_output",
							call_id: event.toolCallId,
							output: event.result,
						});
						break;

					case "assistant_message":
						// 最终回答 → message item
						this.messages.push({
							type: "message",
							content: [{ type: "output_text", text: event.text }],
						});
						break;
				}
			}
		} else {
			// ========== 路径二：Chat Completions API 格式 ==========
			// 系统提示词作为 system 消息打头
			if (this.config.systemPrompt) {
				this.messages.push({ role: "system", content: this.config.systemPrompt });
			}

			// 追踪尚未回填的 tool_calls（见 tool_result 分支的说明）
			let pendingToolCalls: any[] = [];

			for (const event of events) {
				switch (event.type) {
					case "user_message":
						this.messages.push({ role: "user", content: event.text });
						break;

					case "assistant_start":
						// 新一轮回答开始，重置待回填的工具调用列表
						pendingToolCalls = [];
						break;

					case "tool_call":
						// 先累积工具调用，暂不入历史
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
						// Why 延迟回填：Chat Completions 协议要求 role=tool 消息之前
						// 必须有一条携带全部 tool_calls 的 assistant 消息；而事件流里
						// 只有看到第一条工具结果时才能确定本轮所有工具调用已收齐，
						// 此时再把累积的 tool_calls 作为一条 assistant 消息补进去
						if (pendingToolCalls.length > 0) {
							this.messages.push({
								role: "assistant",
								content: null,
								tool_calls: pendingToolCalls,
							});
							pendingToolCalls = [];
						}
						// 补充工具结果消息
						this.messages.push({
							role: "tool",
							tool_call_id: event.toolCallId,
							content: event.result,
						});
						break;

					case "assistant_message":
						// 最终的助手回答（不带工具调用）
						this.messages.push({ role: "assistant", content: event.text });
						break;

					// 跳过其他事件类型（thinking、error、interrupted、token_usage）
				}
			}
		}
	}
}
