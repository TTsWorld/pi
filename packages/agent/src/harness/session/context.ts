/**
 * @file session/context.ts —— 上下文投影：把 lane 分支上的 Entry 路径投影为
 * 可直接用于 LLM 请求的 SessionContext（消息序列 + 生效配置）。
 *
 * @description
 * buildSessionContext 是「Entry 树 → 消息列表」的权威转换，处理顺序固定为：
 * 1. **扫描推导**（deriveSessionContextState）：沿路径自旧向新推导
 *    thinkingLevel / model / activeToolNames 等生效配置；
 * 2. **截断整形**（defaultContextEntryTransform + entryTransforms）：丢弃
 *    最近一次 compaction 之前的全部 entry，由该 compaction 的 summary +
 *    retainedTail 代表更早历史，再依次应用自定义 transform 链；
 * 3. **逐条映射**（sessionEntryToContextMessages）：entry → 消息——deferred
 *    的 assistant 被丢弃，配置类 entry 折叠进状态而非消息流，custom entry
 *    经 projector 注入，最后 flatMap 拼成最终消息序列。
 * 输入 pathEntries 约定为从根到叶排列（旧在前、新在后，末尾即叶子侧）。
 */
import type { AgentMessage } from "../../types.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import type { CompactionEntry, CustomEntry, Entry } from "./types.ts";

/** 会话上下文：发起一次 LLM 请求所需的全部投影结果（消息 + 生效配置）。 */
export interface SessionContext {
	/** 投影得到的按序消息序列，可直接作为请求的 messages。 */
	messages: AgentMessage[];
	/** 路径上最后一次 thinking_level_change 生效的思考级别（从未设置时缺省 "off"）。 */
	thinkingLevel: string;
	/**
	 * 路径上生效的模型：取最后一次显式 model_change，或最后一条 assistant
	 * 消息实际使用的模型；路径上无从得知时为 null。
	 */
	model: { provider: string; modelId: string } | null;
	/** 路径上最后一次 active_tools_change 生效的工具名列表；从未设置过时为 null（由调用方决定默认工具集）。 */
	activeToolNames: string[] | null;
}

/**
 * 上下文 entry 序列的整形器：在默认 compaction 截断之后、消息映射之前运行，
 * 可对序列做增删改（如再裁剪、重排）。多个 transform 按数组顺序链式应用，
 * 后一个的输入是前一个的输出。
 */
export type ContextEntryTransform = (entries: readonly Entry[]) => readonly Entry[];

/**
 * custom entry → 上下文消息的投影器，按 customType 注册到 entryProjectors。
 * 返回 undefined / 空数组表示该 entry 不产生消息（仅留存于会话转录）。
 */
export type CustomEntryContextMessageProjector = (
	entry: CustomEntry,
	index: number,
	entries: readonly Entry[],
) => readonly AgentMessage[] | undefined;

/** buildSessionContext 的可选扩展点。 */
export interface SessionContextBuildOptions {
	/** 自定义 entry 序列整形链，在默认 compaction 截断之后依序应用。 */
	entryTransforms?: readonly ContextEntryTransform[];
	/** customType → 投影器的注册表；未注册的 custom entry 不进入上下文。 */
	entryProjectors?: Readonly<Record<string, CustomEntryContextMessageProjector>>;
}

/**
 * 从路径 entry 推导生效配置（thinkingLevel / model / activeToolNames）。
 *
 * 自旧向新线性扫描，靠「后写覆盖先写」得到最终生效值。特别地，assistant
 * 消息也会覆盖 model：消息上记录的是实际产出它的模型，比可能滞后的
 * model_change 更可信——恢复会话时下一个请求默认沿用真正用过的模型。
 *
 * @param pathEntries 从根到叶（旧→新）排列的路径 entry
 * @returns 除 messages 之外的 {@link SessionContext} 字段
 */
function deriveSessionContextState(pathEntries: readonly Entry[]): Omit<SessionContext, "messages"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;
	let activeToolNames: string[] | null = null;

	// 依序覆盖：最后被扫描到的值即最终生效值
	for (const entry of pathEntries) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		} else if (entry.type === "active_tools_change") {
			activeToolNames = [...entry.activeToolNames];
		}
	}

	return { thinkingLevel, model, activeToolNames };
}

/**
 * 默认的上下文整形：截断到最近一次 compaction。
 *
 * 自新向旧找路径上**最后一个** compaction entry（多次压缩时只有最近一次
 * 生效）；找到则以「该 compaction entry 本身 + 其后的全部 entry」替换整个
 * 序列——compaction 之前的原始消息全部丢弃，由它的 summary（映射阶段展开为
 * 摘要消息 + retainedTail）概括代表；未找到则原样返回整条路径。
 * 注意边界：早于该 compaction 的 branch_summary 等非消息 entry 也会一并截掉；
 * compaction 自身保留一份，紧随其后的 entry 从 index + 1 原样接续。
 *
 * @param pathEntries 从根到叶（旧→新）排列的路径 entry
 * @returns 进入消息映射阶段的 entry 序列
 */
export function defaultContextEntryTransform(pathEntries: readonly Entry[]): Entry[] {
	let compaction: CompactionEntry | undefined;
	let compactionIndex = -1;
	// 从最新端向前找最近的 compaction：越靠后越新，截断以最新的一次为准
	for (let index = pathEntries.length - 1; index >= 0; index--) {
		const entry = pathEntries[index]!;
		if (entry.type === "compaction") {
			compaction = entry;
			compactionIndex = index;
			break;
		}
	}
	// compaction entry 顶替其全部前驱；retainedTail 不在此处展开，而在消息映射阶段接在摘要消息之后
	return compaction === undefined ? [...pathEntries] : [compaction, ...pathEntries.slice(compactionIndex + 1)];
}

/**
 * 组装最终进入消息映射的 entry 序列：先做默认 compaction 截断，再依序应用
 * 自定义 transform 链（每个 transform 的输出是下一个的输入）。
 *
 * @param pathEntries 从根到叶（旧→新）排列的路径 entry
 * @param options 携带 entryTransforms 链
 * @returns 截断 + 整形后的 entry 序列
 */
export function buildContextEntries(pathEntries: readonly Entry[], options: SessionContextBuildOptions = {}): Entry[] {
	let entries = defaultContextEntryTransform(pathEntries);
	for (const transform of options.entryTransforms ?? []) entries = [...transform(entries)];
	return entries;
}

/**
 * 把单个 entry 映射为 0..n 条上下文消息——投影的过滤 / 展开规则所在。
 *
 * - message：原样透传；但 stopReason 为 "deferred" 的 assistant 除外——其
 *   真实结果尚未取回，注入占位内容只会误导模型，故丢弃；
 * - compaction：展开为一条压缩摘要消息，随后原样接上 retainedTail 中保留
 *   的近期消息；
 * - branch_summary：摘要非空时展开为一条分支摘要消息（空摘要不注入）；
 * - custom：交给按 customType 注册的 projector 注入；未注册或返回
 *   undefined 则不产生消息；
 * - model_change / thinking_level_change / active_tools_change：不产生
 *   消息，它们只影响 deriveSessionContextState 推导的生效配置。
 *
 * @param entry 待映射的 entry
 * @param index 该 entry 在序列中的下标（透传给 projector）
 * @param entries 完整 entry 序列（透传给 projector，供上下文相关的投影）
 * @param options 构建选项（提供 entryProjectors）
 * @returns 该 entry 产生的消息数组（可为空数组）
 */
export function sessionEntryToContextMessages(
	entry: Entry,
	index: number,
	entries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): AgentMessage[] {
	if (entry.type === "message") {
		// deferred 的 assistant 真实结果需按句柄另行取回，先丢弃避免占位内容污染上下文
		if (entry.message.role === "assistant" && entry.message.stopReason === "deferred") return [];
		return [entry.message];
	}
	if (entry.type === "compaction") {
		// 摘要消息代表被压缩的前段历史；retainedTail 是压缩时原样保留的近期消息
		return [
			createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
			...entry.retainedTail,
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "custom") {
		// 由应用按 customType 注册的 projector 决定注入什么；未注册则静默跳过
		return [...(options.entryProjectors?.[entry.customType]?.(entry, index, entries) ?? [])];
	}
	return [];
}

/**
 * 上下文投影总入口：lane 路径 entry → {@link SessionContext}。
 *
 * 固定顺序：先 deriveSessionContextState 推导生效配置，再 buildContextEntries
 * 做 compaction 截断 + transform 整形，最后逐 entry 映射并 flatMap 成消息序列。
 * 注意配置推导基于**未截断**的原始路径——即便生效的 model_change 已被压缩进
 * 摘要，模型选择等配置依然取自完整分支历史。
 *
 * @param pathEntries 从根到叶（旧→新）排列的路径 entry
 * @param options 构建选项（entryTransforms / entryProjectors）
 * @returns 含消息序列与生效配置的会话上下文
 */
export function buildSessionContext(
	pathEntries: readonly Entry[],
	options: SessionContextBuildOptions = {},
): SessionContext {
	const state = deriveSessionContextState(pathEntries);
	const contextEntries = buildContextEntries(pathEntries, options);
	const messages = contextEntries.flatMap((entry, index) =>
		sessionEntryToContextMessages(entry, index, contextEntries, options),
	);
	return { ...state, messages };
}
