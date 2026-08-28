/**
 * @file transcript.ts —— 会话转录（transcript）的客户端状态机
 *
 * @description
 * 以纯函数方式维护「服务端快照 + 流式增量进度」折叠出的转录视图：
 * createTranscriptState（建状态）、applyTranscriptSnapshot（快照整体重置，
 * 带 revision 乱序保护）、applyTranscriptProgress（条目事件与内容增量应用）、
 * selectTranscript（快照 / 增量 / 排队转向合并为有序数组）。
 * 所有函数都是「旧状态进、新状态出」的不可变更新，RemoteSession 直接替换
 * 引用即可触发订阅者通知。依赖关系：仅依赖 pi-protocol 的协议类型。
 */

import type { JsonValue, SessionSnapshot, TranscriptItem, TranscriptProgress } from "@earendil-works/pi-protocol";

/**
 * 转录折叠状态：snapshot 为最近采纳的服务端快照；progressItems / progressOrder
 * 为快照之后的增量条目及其首次出现顺序；toolCallBuffers 为流式工具调用参数的
 * 原始文本缓冲（key 为 `${消息id}:${内容下标}`）。
 */
export interface TranscriptState {
	readonly snapshot: SessionSnapshot;
	readonly progressItems: ReadonlyMap<string, TranscriptItem>;
	readonly progressOrder: readonly string[];
	readonly toolCallBuffers: ReadonlyMap<string, string>;
}

/** 类型守卫：值是否为纯 JSON（不含 NaN/Infinity，对象必须是 plain object）。 */
function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
	return Object.values(value).every(isJsonValue);
}

/**
 * 尝试把流式累积的工具参数文本解析为 JSON；解析失败（参数尚不完整）时
 * 原样返回文本前缀，等后续增量补齐后再重试。
 */
function parsePartialToolInput(value: string): JsonValue {
	try {
		const parsed: unknown = JSON.parse(value);
		if (isJsonValue(parsed)) return parsed;
	} catch {
		// 工具参数在流式传输中尚不完整：先保留原始前缀，直到凑成合法 JSON。
	}
	return value;
}

/** 从快照创建初始状态；structuredClone 深拷贝，避免外部修改污染内部状态。 */
export function createTranscriptState(snapshot: SessionSnapshot): TranscriptState {
	return {
		snapshot: structuredClone(snapshot),
		progressItems: new Map(),
		progressOrder: [],
		toolCallBuffers: new Map(),
	};
}

/** 应用新快照：同会话且 revision 更小视为乱序旧包直接忽略；否则整体重置（丢弃增量缓冲）。 */
export function applyTranscriptSnapshot(state: TranscriptState, snapshot: SessionSnapshot): TranscriptState {
	if (state.snapshot.id === snapshot.id && snapshot.revision < state.snapshot.revision) return state;
	return createTranscriptState(snapshot);
}

/**
 * 应用一条流式增量进度，返回新状态（不可变更新）：
 * item_started / updated 覆盖对应条目；item_finished 清掉工具参数缓冲后落盘
 * 最终条目；content_delta（默认分支）在目标 assistant 消息的指定内容块上拼接增量。
 */
export function applyTranscriptProgress(state: TranscriptState, progress: TranscriptProgress): TranscriptState {
	if (progress.type === "item_started" || progress.type === "item_updated") {
		return setProgressItem(state, progress.item);
	}
	if (progress.type === "item_finished") {
		const toolCallBuffers = new Map(state.toolCallBuffers);
		// 条目已完成：清掉以 `${条目id}:` 为前缀的参数缓冲（key 按内容下标展开）
		for (const key of toolCallBuffers.keys()) {
			if (key.startsWith(`${progress.item.id}:`)) toolCallBuffers.delete(key);
		}
		return setProgressItem({ ...state, toolCallBuffers }, progress.item);
	}

	// 增量可能落在之前的增量条目上，也可能落在快照中的条目上，两处都查
	const item =
		state.progressItems.get(progress.messageId) ??
		state.snapshot.transcript.find(({ id }) => id === progress.messageId);
	// 只有 assistant 消息会产生内容增量；找不到目标条目则忽略本条进度
	if (!item || item.role !== "assistant") return state;
	let toolCallBuffers = state.toolCallBuffers;
	const content = item.content.map((part, index) => {
		if (index !== progress.contentIndex) return structuredClone(part);
		if (progress.kind === "text" && part.type === "text") return { ...part, text: part.text + progress.delta };
		if (progress.kind === "thinking" && part.type === "thinking") {
			return { ...part, thinking: part.thinking + progress.delta };
		}
		if (progress.kind === "toolCall" && part.type === "toolCall") {
			// 工具参数按原始文本增量拼接，每轮都尝试解析为 JSON（失败则暂存字符串前缀）
			const key = `${progress.messageId}:${progress.contentIndex}`;
			const existing = state.toolCallBuffers.get(key) ?? (typeof part.input === "string" ? part.input : "");
			const buffer = existing + progress.delta;
			toolCallBuffers = new Map(state.toolCallBuffers).set(key, buffer);
			return { ...part, input: parsePartialToolInput(buffer) };
		}
		return structuredClone(part);
	});
	return setProgressItem({ ...state, toolCallBuffers }, { ...item, content });
}

/**
 * 计算最终展示用的有序转录：
 * 1. 快照条目优先被同 id 的增量条目覆盖；
 * 2. 追加快照中不存在、仅由增量产生的新条目（按首次出现顺序）；
 * 3. 追加尚未进入转录的排队转向消息（queuedSteer）。
 */
export function selectTranscript(state: TranscriptState): readonly TranscriptItem[] {
	const transcript = state.snapshot.transcript.map((item) => state.progressItems.get(item.id) ?? item);
	const ids = new Set(transcript.map((item) => item.id));
	for (const id of state.progressOrder) {
		if (ids.has(id)) continue;
		const item = state.progressItems.get(id);
		if (item) {
			transcript.push(item);
			ids.add(id);
		}
	}
	for (const item of state.snapshot.queuedSteer) {
		if (ids.has(item.id)) continue;
		transcript.push(item);
		ids.add(item.id);
	}
	return transcript;
}

/** 记录/覆盖一条增量条目；首次出现时同时登记到 progressOrder 以保持顺序。 */
function setProgressItem(state: TranscriptState, item: TranscriptItem): TranscriptState {
	const progressItems = new Map(state.progressItems);
	const progressOrder = progressItems.has(item.id) ? state.progressOrder : [...state.progressOrder, item.id];
	progressItems.set(item.id, structuredClone(item));
	return { ...state, progressItems, progressOrder };
}
