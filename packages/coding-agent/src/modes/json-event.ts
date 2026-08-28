/**
 * @file json-event.ts —— JSON 事件流瘦身转换
 *
 * @description
 * 把 AgentSession 内部事件转换为面向外部消费者的线上格式（JsonAgentSessionEvent），
 * 供 JSON 模式（pi --mode json）与 RPC 模式的 stdout 协议逐行输出。
 * 核心是剥离体积随流式增长的累积快照（partial / message）：消费者依据
 * message_start + 各 delta + message_end 即可拼装完整消息；体积恒定的
 * 累计 usage、工具调用 id / 工具名仍保留。
 * 依赖：`../core/agent-session.ts`（AgentSessionEvent）、pi-ai 的 Usage 类型。
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "../core/agent-session.ts";

/** 条件类型：带 `partial` 字段（累积快照）的事件在类型层面剔除该字段，否则原样返回 */
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

/**
 * 条件类型：toolcall_start 剥掉 partial 后额外补充 id / toolName
 * （这两个字段原本只存在于累积快照里），其余事件仅剔除 partial。
 */
type ToJsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
	? WithoutPartial<T> & { id: string; toolName: string }
	: WithoutPartial<T>;

/** 从联合类型中提取出 message_update 事件（内部流式形态，含累积快照） */
type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
/**
 * message_update 的线上瘦身形态：不再携带累积的助手消息快照，
 * 只保留累计 usage（体积恒定）与剥掉 partial 的内层 delta 事件。
 */
type JsonMessageUpdateEvent = {
	type: "message_update";
	usage: Usage;
	assistantMessageEvent: ToJsonAssistantMessageEvent<MessageUpdateEvent["assistantMessageEvent"]>;
};

/** JSON 与 RPC stdout 协议输出的会话事件形态：仅 message_update 被替换为瘦身版，其余事件原样透传 */
export type JsonAgentSessionEvent = Exclude<AgentSessionEvent, { type: "message_update" }> | JsonMessageUpdateEvent;

/**
 * 瘦身 message_update 的内层事件：toolcall_start 从 partial 快照取出工具调用，
 * 把 id / toolName 提升为顶层字段；其余事件仅剔 partial 或原样透传。
 */
function toJsonAssistantMessageEvent(
	event: MessageUpdateEvent["assistantMessageEvent"],
): JsonMessageUpdateEvent["assistantMessageEvent"] {
	if (event.type === "toolcall_start") {
		const toolCall = event.partial.content[event.contentIndex];
		// 校验快照中该坐标处确实是工具调用：数据错位时宁可显式抛错，不做静默转换
		if (toolCall?.type !== "toolCall") {
			throw new Error(`toolcall_start content at index ${event.contentIndex} is not a tool call`);
		}
		const { partial: _partial, ...deltaEvent } = event;
		return { ...deltaEvent, id: toolCall.id, toolName: toolCall.name };
	}

	if (!("partial" in event)) {
		// 无累积快照的事件无需转换，直接透传
		return event;
	}

	const { partial: _partial, ...deltaEvent } = event;
	return deltaEvent;
}

/**
 * 移除流式线上事件中的累积助手快照。
 * `message_start` 提供初始消息，各增量 delta 逐步拼装，
 * `message_end` 提供最终权威消息；而累计 usage、工具调用 id 与
 * 工具名因体积恒定仍被保留，消费端可直接取用。
 */
export function toJsonEvent(event: MessageUpdateEvent): JsonMessageUpdateEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent;
export function toJsonEvent(event: AgentSessionEvent): JsonAgentSessionEvent {
	if (event.type !== "message_update") {
		// 非 message_update 事件不携带累积快照，原样透传
		return event;
	}
	if (event.message.role !== "assistant") {
		// 不变量：message_update 只应跟随助手消息出现，违背即抛错
		throw new Error("message_update message is not an assistant message");
	}

	return {
		type: "message_update",
		usage: event.message.usage,
		assistantMessageEvent: toJsonAssistantMessageEvent(event.assistantMessageEvent),
	};
}
