/**
 * @file 跨 provider 消息改写（上下文接力）
 * @description 在把历史消息发给目标模型前做兼容性改写，解决「会话中途换模型」的问题：
 *              - 非视觉模型的图片降级为占位符文本（相邻图片合并为一个占位）
 *              - thinking 块：同模型保留（含回放签名），跨模型转为纯文本、redacted 丢弃
 *              - 工具调用：跨模型时剥掉 provider 专属签名、按需归一化 ID（OpenAI 的
 *                450+ 字符特殊字符 ID 过不了 Anthropic 的 ^[a-zA-Z0-9_-]+$ 校验）
 *              - 孤儿工具调用（无对应结果）补合成错误结果；error/aborted 的助手回合整条跳过
 *
 * 依赖关系：
 * - ../types.ts 的消息/模型类型；被各 API 实现在发送前调用
 */

import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

// 非视觉模型的图片占位文案（用户消息与工具结果分别措辞）
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/**
 * 把图片块替换为占位文本块；连续多个图片只保留一个占位（避免占位刷屏），
 * 且「与占位文案相同的文本块」后紧跟图片时也不重复插入。
 */
function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

/** 模型不支持图片输入时，把用户消息与工具结果中的图片降级为占位文本 */
function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * 为跨 provider 兼容性改写消息历史（上下文接力的核心）。
 * 归一化工具调用 ID：OpenAI Responses API 生成 450+ 字符、含 `|` 等特殊字符的 ID，
 * 而 Anthropic API 要求 ID 匹配 ^[a-zA-Z0-9_-]+$（最长 64 字符）。
 *
 * @param messages 原始历史消息
 * @param model 即将接收这些消息的目标模型
 * @param normalizeToolCallId 可选的 ID 归一化钩子（跨模型时才调用），各 API 自带规则
 * @returns 改写后的消息（两遍处理：内容改写 → 孤儿工具调用补结果）
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// 原始工具调用 ID → 归一化 ID 的映射（第一遍记录，供第二遍改写工具结果的引用）
	const toolCallIdMap = new Map<string, string>();
	// 归一化 untyped 调用方（自定义工具、手搓历史、旧会话文件）带来的 null/undefined
	// content，让下游代码可以信赖类型契约
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

	// ========== 第一遍：内容改写（图片降级、thinking 块、工具调用 ID 归一化） ==========
	const transformed = imageAwareMessages.map((msg) => {
		// 用户消息原样通过（图片降级已在此前完成）
		if (msg.role === "user") {
			return msg;
		}

		// 工具结果消息：若有 ID 映射则改写 toolCallId，保持调用与结果配对
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// 助手消息：按「是否同模型」分派各内容块的改写策略
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			// 同模型 = provider/api/model 三元组一致，可原样回放 provider 专属数据
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// redacted thinking 是不透明的加密内容，只有原模型能解；
					// 跨模型发送会触发 API 错误，直接丢弃
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// 同模型：保留带签名的 thinking 块（回放必需），
					// 即使思考文本为空（OpenAI 加密 reasoning 只有签名）
					if (isSameModel && block.thinkingSignature) return block;
					// 空思考块跳过；其余跨模型的转为纯文本（保留思路信息量）
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					// 文本块本身通用；跨模型时重建为纯文本块以剥离可能携带的额外字段
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					// 跨模型剥掉 provider 专属的 thoughtSignature（目标模型无法解读）
					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					// 跨模型归一化 ID（如压短 OpenAI 超长 ID），并记录映射供工具结果改写
					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// ========== 第二遍：为孤儿工具调用补合成结果 ==========
	// 保留思考签名的同时满足「每个工具调用必须有结果」的 API 硬性要求
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				// 只补真正缺失结果的调用；已有结果的保持配对
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// 上一条助手消息还有未配对的调用：先补齐合成结果再继续
			insertSyntheticToolResults();

			// error/aborted 的助手消息整条跳过——它们是不完整回合，不该回放：
			// - 可能有残缺内容（只有 reasoning 没有消息、不完整的工具调用）
			// - 回放会触发 API 错误（如 OpenAI 的 "reasoning without following item"）
			// - 模型应从最后一个有效状态重试
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// 记录本条助手消息的工具调用，等待后续结果配对
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// 用户消息打断工具流：为悬空的调用补合成结果
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// 会话以未解决的工具调用收尾时，在此补齐
	insertSyntheticToolResults();

	return result;
}
