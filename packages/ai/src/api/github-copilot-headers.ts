/**
 * @file 为 GitHub Copilot 请求推导随内容变化的动态请求头。
 * @description Copilot 网关要求按请求内容携带 X-Initiator（区分用户/agent 发起）、
 * Copilot-Vision-Request（是否含图片输入）等头，这里从消息列表推导出这些头的取值。
 */
import type { Message } from "../types.ts";

// Copilot 要求通过 X-Initiator 标明请求是用户发起还是 agent 发起
// （例如收到 assistant/tool 消息后的后续请求视为 agent 发起）。
export function inferCopilotInitiator(messages: Message[]): "user" | "agent" {
	const last = messages[messages.length - 1];
	return last && last.role !== "user" ? "agent" : "user";
}

// 发送图片时 Copilot 要求携带 Copilot-Vision-Request 头
export function hasCopilotVisionInput(messages: Message[]): boolean {
	return messages.some((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return msg.content.some((c) => c.type === "image");
		}
		return false;
	});
}

/** 组装随请求内容变化的 Copilot 动态头：X-Initiator、Openai-Intent，含图片时再加 Copilot-Vision-Request。 */
export function buildCopilotDynamicHeaders(params: {
	messages: Message[];
	hasImages: boolean;
}): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Initiator": inferCopilotInitiator(params.messages),
		"Openai-Intent": "conversation-edits",
	};

	if (params.hasImages) {
		headers["Copilot-Vision-Request"] = "true";
	}

	return headers;
}
