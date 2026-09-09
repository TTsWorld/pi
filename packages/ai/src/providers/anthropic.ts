/**
 * @file Anthropic provider 适配器（统一 AI 包的第一个 provider 实现）
 *
 * @description
 * 本文件是 AI 抽象层的 Anthropic 方言适配器，职责是「双向转换」：
 *
 * 1. 请求方向：把统一的 `Request`（统一 Message 格式、统一 tool 定义）转换为
 *    Anthropic Messages API 的请求参数（`MessageCreateParamsStreaming`）——
 *    包括把统一 Message 拆成 Anthropic 的 content blocks、把 system prompt
 *    从消息列表中抽出独立传参、把统一 tool schema 转成 Anthropic 的 Tool 定义。
 *
 * 2. 响应方向：消费 Anthropic 的流式响应（stream events），把 content block
 *    delta（text_delta / thinking_delta）实时回调给上层，最终把
 *    `finalMessage()` 里的 content blocks（thinking / text / tool_use）聚合回
 *    统一的 `AssistantMessage`，并把 Anthropic 的 stop_reason 映射为统一的
 *    `StopReason`。
 *
 * 依赖关系：
 * - 依赖 `@anthropic-ai/sdk`（官方客户端，含 stream 辅助）。
 * - 依赖本包 `../types.js` 中的统一类型（AI / Request / Event / Message /
 *   AssistantMessage / StopReason / TokenUsage / ToolCall），通过实现
 *   `AI<AnthropicOptions>` 接口接入统一抽象层。
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	Tool,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { AI, AssistantMessage, Event, Message, Request, StopReason, TokenUsage, ToolCall } from "../types.js";

/**
 * Anthropic provider 的专有选项。
 *
 * - `thinking`：扩展思考（extended thinking）开关与 token 预算。
 * - `toolChoice`：工具选择策略，`auto`（模型自行决定）/ `any`（必须调用某个工具）/
 *   `none`（禁止调用工具），或指定必须调用某个具名工具。
 */
export interface AnthropicOptions {
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
	};
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
}

/**
 * 基于 Anthropic Messages API 的 AI provider 实现。
 *
 * 实现 `AI<AnthropicOptions>` 接口，对上暴露统一的 `complete()` 方法，
 * 对下封装 Anthropic SDK 客户端的创建、请求转换与流式响应解析。
 */
export class AnthropicAI implements AI<AnthropicOptions> {
	/** Anthropic 官方 SDK 客户端实例 */
	private client: Anthropic;
	/** 使用的模型名（如 "claude-sonnet-4-5" 等） */
	private model: string;

	/**
	 * 构造 Anthropic provider 实例。
	 *
	 * @param model - 模型名称
	 * @param apiKey - API 密钥；缺省时回退读取 `ANTHROPIC_API_KEY` 环境变量，
	 *                 两者都没有则直接抛错（fail-fast，避免请求阶段才失败）
	 * @param baseUrl - 可选的自定义 API 地址（如走代理/网关）
	 */
	constructor(model: string, apiKey?: string, baseUrl?: string) {
		if (!apiKey) {
			if (!process.env.ANTHROPIC_API_KEY) {
				throw new Error(
					"Anthropic API key is required. Set ANTHROPIC_API_KEY environment variable or pass it as an argument.",
				);
			}
			apiKey = process.env.ANTHROPIC_API_KEY;
		}
		this.client = new Anthropic({ apiKey, baseURL: baseUrl });
		this.model = model;
	}

	/**
	 * 执行一次补全请求：转换统一 Request → 调用 Anthropic 流式 API → 聚合为统一 AssistantMessage。
	 *
	 * @param request - 统一格式的请求（消息历史、system prompt、工具、采样参数、
	 *                  流式回调 onText/onThinking、取消信号 signal 等）
	 * @param options - Anthropic 专有选项（thinking / toolChoice）
	 * @returns 统一格式的 AssistantMessage；任何异常都会被捕获并转成
	 *          `stopResaon: "error"` 的错误消息（不向上抛异常）
	 */
	async complete(request: Request, options?: AnthropicOptions): Promise<AssistantMessage> {
		try {
			// ========== 请求转换：统一 Message → Anthropic messages ==========
			// 先把统一消息历史转换为 Anthropic 的 MessageParam 格式
			const messages = this.convertMessages(request.messages);

			// ========== 组装 Anthropic 请求参数 ==========
			// 注意始终以流式模式请求（stream: true），即使上层不需要增量回调，
			// 统一走流式可以让实现更简单（一套代码路径）
			const params: MessageCreateParamsStreaming = {
				model: this.model,
				messages,
				max_tokens: request.maxTokens || 4096,
				stream: true,
			};

			// system prompt 在 Anthropic API 中不是消息列表的一员，而是独立的顶层参数
			if (request.systemPrompt) {
				params.system = request.systemPrompt;
			}

			if (request.temperature !== undefined) {
				params.temperature = request.temperature;
			}

			// 统一 tool 定义 → Anthropic Tool 定义
			if (request.tools) {
				params.tools = this.convertTools(request.tools);
			}

			// 扩展思考：开启后模型会先产出 thinking block 再给正文；
			// budget_tokens 控制思考过程最多可消耗的 token 数
			if (options?.thinking?.enabled) {
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinking.budgetTokens || 1024,
				};
			}

			// toolChoice：统一层的字符串枚举要包一层 Anthropic 的 { type } 结构；
			// 具名工具（{ type: "tool", name }）本身就是 Anthropic 格式，直接透传
			if (options?.toolChoice) {
				if (typeof options.toolChoice === "string") {
					params.tool_choice = { type: options.toolChoice };
				} else {
					params.tool_choice = options.toolChoice;
				}
			}

			// ========== 发起流式请求 ==========
			// 把取消信号透传给底层 fetch，支持上层中断长请求
			const stream = this.client.messages.stream(
				{
					...params,
					stream: true,
				},
				{
					signal: request.signal,
				},
			);

			// ========== 流式消费：content block delta → 统一回调 ==========
			// 边流边把增量分发给上层回调（onText / onThinking），
			// 最终聚合则交给下面的 finalMessage()
			for await (const event of stream) {
				if (event.type === "content_block_delta") {
					// 文本增量 → onText
					if (event.delta.type === "text_delta") {
						request.onText?.(event.delta.text);
					}
					// 思考增量 → onThinking
					if (event.delta.type === "thinking_delta") {
						request.onThinking?.(event.delta.thinking);
					}
				}
			}

			// ========== 聚合最终结果：content blocks → 统一 AssistantMessage ==========
			// SDK 的 stream 辅助会在流结束后给出聚合好的完整消息（含全部 content blocks）
			const msg = await stream.finalMessage();

			// thinking 文本：过滤出所有 thinking block 并拼接
			const thinking = msg.content.some((block) => block.type === "thinking")
				? msg.content
						.filter((block) => block.type === "thinking")
						.map((block) => block.thinking)
						.join("\n")
				: undefined;
			// This is kinda wrong if there is more than one thinking block. We do not use interleaved thinking though, so we should
			// always have a single thinking block.
			// （如果存在多个 thinking block，签名这样拼接其实是不对的。不过我们不用 interleaved thinking，
			// 所以正常情况下只会有一个 thinking block。）
			// thinking 签名：Anthropic 要求多轮对话中原样回传 thinking block 的签名，
			// 用于服务端校验思考内容未被篡改
			const thinkingSignature = msg.content.some((block) => block.type === "thinking")
				? msg.content
						.filter((block) => block.type === "thinking")
						.map((block) => block.signature)
						.join("\n")
				: undefined;
			// 正文文本：过滤出所有 text block 并拼接
			const content = msg.content.some((block) => block.type === "text")
				? msg.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n")
				: undefined;
			// 工具调用：tool_use block → 统一 ToolCall
			const toolCalls: ToolCall[] = msg.content
				.filter((block) => block.type === "tool_use")
				.map((block) => ({
					id: block.id,
					name: block.name,
					arguments: block.input as Record<string, any>,
				}));
			// token 用量：含 cache 读写两侧的统计
			const usage: TokenUsage = {
				input: msg.usage.input_tokens,
				output: msg.usage.output_tokens,
				cacheRead: msg.usage.cache_read_input_tokens || 0,
				cacheWrite: msg.usage.cache_creation_input_tokens || 0,
				// TODO add cost
			};

			return {
				role: "assistant",
				content,
				thinking,
				thinkingSignature,
				toolCalls,
				model: this.model,
				usage,
				stopResaon: this.mapStopReason(msg.stop_reason),
			};
		} catch (error) {
			// ========== 错误兜底：转成错误消息而非抛异常 ==========
			// 统一层的约定是错误也通过 AssistantMessage 返回（stopResaon: "error"），
			// 让调用方用同一套逻辑处理成功与失败
			return {
				role: "assistant",
				model: this.model,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				stopResaon: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * 把统一 Message 列表转换为 Anthropic 的 MessageParam 列表。
	 *
	 * 三种统一角色的映射规则：
	 * - `user` → 直接作为 user 消息透传（统一层与 Anthropic 的纯文本格式一致）；
	 * - `assistant` → 拆成有序的 content blocks：thinking（含签名）→ text → tool_use，
	 *   顺序必须与模型当初产出时一致，Anthropic 服务端会校验（尤其 thinking 签名）；
	 * - `toolResult` → Anthropic 没有 tool 角色消息，工具结果要作为 user 消息里的
	 *   `tool_result` block 传回。
	 *
	 * @param messages - 统一格式的消息历史
	 * @returns Anthropic Messages API 的 messages 参数
	 */
	private convertMessages(messages: Message[]): MessageParam[] {
		const params: MessageParam[] = [];

		for (const msg of messages) {
			// ========== user 消息：直接透传 ==========
			if (msg.role === "user") {
				params.push({
					role: "user",
					content: msg.content,
				});
			} else if (msg.role === "assistant") {
				// ========== assistant 消息：拆成 content blocks ==========
				const blocks: ContentBlockParam[] = [];

				// thinking block 必须放在最前面；必须携带原始签名回传，
				// 否则开启 extended thinking 的多轮对话会被服务端拒绝
				if (msg.thinking && msg.thinkingSignature) {
					blocks.push({
						type: "thinking",
						thinking: msg.thinking,
						signature: msg.thinkingSignature,
					});
				}

				if (msg.content) {
					blocks.push({
						type: "text",
						text: msg.content,
					});
				}

				// 工具调用 block，放在文本之后
				if (msg.toolCalls) {
					for (const toolCall of msg.toolCalls) {
						blocks.push({
							type: "tool_use",
							id: toolCall.id,
							name: toolCall.name,
							input: toolCall.arguments,
						});
					}
				}

				params.push({
					role: "assistant",
					content: blocks,
				});
			} else if (msg.role === "toolResult") {
				// ========== toolResult 消息：包装成 user 侧的 tool_result block ==========
				// Anthropic 协议中工具结果属于 user 回合，通过 tool_use_id
				// 与对应的 tool_use block 关联
				params.push({
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: msg.toolCallId,
							content: msg.content,
							is_error: msg.isError,
						},
					],
				});
			}
		}
		return params;
	}

	/**
	 * 把统一 tool 定义转换为 Anthropic 的 Tool 定义。
	 *
	 * 统一层用 JSON Schema 风格的 parameters（properties/required），
	 * Anthropic 要求包装成 `input_schema` 字段；缺失字段兜底为空对象/空数组。
	 *
	 * @param tools - 统一格式的工具定义列表
	 * @returns Anthropic Tools API 格式的工具列表；入参为空时返回空数组
	 */
	private convertTools(tools: Request["tools"]): Tool[] {
		if (!tools) return [];

		return tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			input_schema: {
				type: "object" as const,
				properties: tool.parameters.properties || {},
				required: tool.parameters.required || [],
			},
		}));
	}

	/**
	 * 把 Anthropic 的 stop_reason 映射为统一 StopReason。
	 *
	 * 映射表：
	 * - `end_turn` → `stop`（模型自然结束）
	 * - `max_tokens` → `length`（因 token 上限被截断）
	 * - `tool_use` → `toolUse`（模型请求调用工具）
	 * - `refusal` → `safety`（模型拒绝回答）
	 * - `pause_turn` / `stop_sequence` / 其他 → `stop`
	 *
	 * @param reason - Anthropic 返回的停止原因（可能为 null）
	 * @returns 统一层的 StopReason
	 */
	private mapStopReason(reason: Anthropic.Messages.StopReason | null): StopReason {
		switch (reason) {
			case "end_turn":
				return "stop";
			case "max_tokens":
				return "length";
			case "tool_use":
				return "toolUse";
			case "refusal":
				return "safety";
			case "pause_turn": // Stop is good enough -> resubmit
				// pause_turn：当作 stop 即可 -> 由上层重新提交
				return "stop";
			case "stop_sequence":
				// 我们不传 stop sequences，所以理论上不会走到这个分支
				return "stop"; // We don't supply stop sequences, so this should never happen
			default:
				return "stop";
		}
	}
}
