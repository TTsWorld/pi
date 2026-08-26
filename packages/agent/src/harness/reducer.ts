/**
 * @file reducer.ts —— lane 耐久层的恢复核心：record 操作日志 → LaneState 的确定性规约。
 *
 * @description
 * harness 以「单写者 record 协议」把每次状态迁移记为追加式的 record
 * （operation_started / abort_requested / operation_finished / step_attempt /
 * tool_started / queue_enqueued / write_deferred / usage 等，见
 * `./session/types.ts` 的 {@link LaneRecord}），本文件负责在崩溃恢复与损坏检测时
 * 把这些日志切回内存状态，对外提供两个纯函数：
 * - {@link validateRecordLog}：校验一个 lane 的有界恢复切片（record 序列 + 相关
 *   entry），只读、不触碰会话状态；发现矛盾即抛 {@link RecordLogCorruption}
 *   （机器可读 reason 共 12 种，见 {@link RecordLogCorruptionReason}）。这类矛盾
 *   是单写者协议不可能产生的状态，恢复方必须拒绝而不是修复或继续。
 * - {@link reduceLaneState}：在校验通过的基础上，纯函数式地重建该 lane 的编排
 *   状态 {@link LaneState}（未完成操作、进行中的 step / toolBatch、待消费队列、
 *   deferred 句柄、终态失败等）与生效配置 {@link EffectiveLaneConfiguration}。
 *
 * 崩溃恢复语义：record 日志可能在任意两次原子提交之间被截断，规约必须区分
 * 「intent 已声明、结果已落盘」与「intent 已声明、结果未落盘」——后者（如
 * step_attempt 的 resultEntryId、write_deferred / queue_enqueued 的 target、操作
 * intent 的结构目标）都属于合法的中间态，归入 pending / 进行中集合，由 harness
 * 决定重试、补写，或按工具的 replay 策略重新驱动（never = 有副作用不得重放，
 * safe = 可用持久化参数安全重放）。只有逻辑上不可能的序列才判损坏。
 * 规约是确定性的：不修改、不别名引用任何输入，输出一律深拷贝。
 */
import type { AssistantMessage, DeferredHandle, StopReason } from "@earendil-works/pi-ai";
import { Guard } from "typebox/guard";
import type { AgentMessage, AgentToolCall, ThinkingLevel } from "../types.ts";
import type {
	Entry,
	LaneRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueEnqueuedRecord,
	StepAttemptRecord,
	ToolStartedRecord,
	WriteDeferredRecord,
} from "./session/types.ts";

/**
 * lane 耐久恢复切片中出现矛盾时的机器可读分类。
 *
 * 这些 reason 表示「单写者 record 协议」正常情况下不可能产生的状态——既不是普通的
 * 操作失败，也不是「intent 已记录、结果尚未落盘」这类不完整但可恢复的前缀。恢复方
 * 必须拒绝此类状态，而不是修复或继续执行；人类可读的细节由随附的错误消息提供。
 */
export type RecordLogCorruptionReason =
	// 同一 lane 至少存在两个未完成的操作（协议保证单 lane 至多一个 open operation）
	| "multiple_open_operations"
	// record 引用了不存在的操作 runId
	| "unknown_operation"
	// 操作 finish 之后又出现了属于该操作的 record
	| "record_after_finish"
	// step 尝试的 attempt 序号不连续（延续系列未 +1，或新系列不为 1）
	| "non_consecutive_attempt"
	// compaction 尝试缺少合法 reason，或非 compaction 尝试携带了 reason
	| "invalid_compaction_reason"
	// 操作 abort 之后又向其 steer/followUp 队列入队新输入
	| "queue_after_abort"
	// 队列取消找不到匹配且尚未消费的同操作 enqueue
	| "invalid_queue_cancellation"
	// 同一系列的步骤尝试在 resultEntryId / compactionReason 上互相矛盾
	| "inconsistent_step"
	// tool_started 与 assistant entry 中 toolCall 的序号 / 内容不匹配
	| "tool_call_mismatch"
	// 同一 (assistantEntryId, toolIndex) 的工具调用被重复开始
	| "duplicate_tool_invocation"
	// 预置 entry 已落盘，但内容与 record 中声明的 intent 不一致
	| "provisioned_entry_mismatch"
	// stopReason 为 deferred 的 assistant entry 未携带 deferred 句柄
	| "invalid_deferred_handle";

/**
 * 恢复切片矛盾的预期错误：`reason` 为机器可读分类
 * （{@link RecordLogCorruptionReason}），`message` 供人阅读。
 */
export class RecordLogCorruption extends Error {
	readonly reason: RecordLogCorruptionReason;

	constructor(reason: RecordLogCorruptionReason, message: string) {
		super(message);
		this.name = "RecordLogCorruption";
		this.reason = reason;
	}
}

/** 一个 lane 的有界恢复切片：validate / reduce 的全部只读输入。 */
export interface RecordLogSlice {
	/** lane 名。 */
	lane: string;
	/** 未完成的 operation_started（协议保证至多一个；多于一个即 multiple_open_operations 损坏）。 */
	openOperations: readonly OperationStartedRecord[];
	/** 该切片内的 record 操作日志（输入顺序不限，规约前统一按 seq 升序排序）。 */
	records: readonly LaneRecord[];
	/** 操作持有的 entry，加上按预置 id 或被引用 id 直接取回的 entry。 */
	entries: readonly Entry[];
}

/** lane 的生效配置：恢复后继续运行时应使用的模型 / 思考级别 / 启用工具集（由持久化配置 entry 逐步覆盖 defaults 得出）。 */
export interface EffectiveLaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

/**
 * 终态失败：未完成操作的最新自身 entry 是 assistant error 消息，且来源可归因
 * （step 产出，或 deferred 取回失败）。恢复时不重试，直接向调用方汇报失败。
 */
export interface TerminalFailureState {
	/** 承载失败消息的 assistant entry id。 */
	entryId: string;
	/** 失败来源：step 直接产出，还是 deferred 句柄取回时产出。 */
	source: "step" | "deferred_fetch";
	/** 失败的 assistant 消息（克隆副本）。 */
	message: AssistantMessage;
}

/** 进行中的工具批：最新含 toolCall 的 assistant entry 之下，每个工具调用的执行 / 结果进度。 */
export interface ToolBatchState {
	/** 承载这批 toolCall 的 assistant entry id。 */
	assistantEntryId: string;
	/** 每个工具调用一项，按其在 assistant 消息 content 中的序号（toolIndex）对齐。 */
	calls: {
		toolIndex: number;
		toolCall: AgentToolCall;
		/** 对应的 tool_started record（尚未开始执行时缺省）。 */
		started?: ToolStartedRecord;
		/** 结果 entry 是否已落盘（含 tool_started 预置的结果与 assistant 之后直接出现的 toolResult）。 */
		resultExists: boolean;
		/** 该工具结果 entry 带 terminate: true，要求终止本轮运行。 */
		terminate?: boolean;
	}[];
	/** assistant 消息因上下文长度截断（stopReason === "length"）。 */
	truncated: boolean;
	/** 仍有结果未落盘的调用——恢复时需按 replay 策略补齐或重放。 */
	unresolved: boolean;
}

/**
 * 规约出的 lane 编排状态。空闲时 `operation` 为 null；否则完整描述该未完成操作
 * 的恢复上下文（进行中的 step / 工具批、待消费输入、推迟写入、deferred 句柄等）。
 */
export interface LaneState {
	/** lane 名。 */
	lane: string;
	/** lane 当前叶子 entry id（尚无任何 entry 时为 null）。 */
	leafId: string | null;
	/** 当前未完成的操作；null 表示 lane 空闲。 */
	operation: null | {
		/** 操作 id（即其 operation_started record 的 id，也是其余 record 的 runId）。 */
		id: string;
		/** 操作类别：run（对话运行）/ compaction（手动压缩）/ navigation（树导航）。 */
		kind: "run" | "compaction" | "navigation";
		/** 启动时持久化的操作 intent 快照（含 run 的初始消息等，克隆副本）。 */
		intent: OperationStartedRecord["intent"];
		/** 已收到 abort_requested，操作处于中止流程中（未消费的 steer/followUp 会被丢弃）。 */
		aborting: boolean;
		/**
		 * 进行中的步骤：最新 step_attempt 的结果 entry 尚未落盘。
		 * null 表示无进行中的步骤（步骤已收尾或尚未开始）。
		 */
		step: null | {
			kind: "assistant" | "compaction" | "branch_summary";
			/** 已尝试次数（含本次），供恢复方判断是否超出重试上限。 */
			attempts: number;
			/** 预期的结果 entry id（用于落盘时按 id 幂等补写）。 */
			resultEntryId: string;
			/** compaction 步骤的触发原因（仅 step 为 compaction 时存在）。 */
			compactionReason?: "manual" | "threshold" | "overflow";
		};
		/** 进行中的工具批（见 {@link ToolBatchState}）；无未完成工具调用语境时为 null。 */
		toolBatch: ToolBatchState | null;
		/** run intent 捕获的初始消息中尚未落盘的部分——恢复时需先按 id 补写。 */
		missingInitialMessages: ProvisionedEntry[];
		/** 已入队且尚未消费的 steer 输入（aborting 时清空）。 */
		pendingSteer: ProvisionedEntry[];
		/** 已入队且尚未消费的 followUp 输入（aborting 时清空）。 */
		pendingFollowUp: ProvisionedEntry[];
		/** write_deferred 声明但尚未落盘的推迟树写入——恢复时补写。 */
		pendingWrites: ProvisionedEntry[];
		/** 最新 assistant entry 停在 deferred 时的句柄（用于取回真实响应）；否则 null。 */
		deferred: DeferredHandle | null;
		/**
		 * overflow 恢复标记：本操作内发生过 overflow compaction 且其后没有更新的
		 * 会话输入被消费。用于防止恢复后对同一输入反复触发 overflow 恢复；
		 * 只有更新的 steer/followUp/初始输入落盘后才复位为 false。
		 */
		overflowRecoveryUsed: boolean;
		/** 本操作已写出的最新 entry 的摘要（不含存储分配字段）。 */
		newestOwn: null | {
			entryId: string;
			type: Entry["type"];
			role?: AgentMessage["role"];
			stopReason?: StopReason;
		};
		/** 结构目标的完成度：compaction 的 result / navigation 的 summary 是否已落盘。 */
		targets: { result?: boolean; summary?: boolean };
	};
	/** 排入下一轮 run 的输入（lane 级队列，不隶属于任何操作）。 */
	pendingNextRun: ProvisionedEntry[];
}

/** {@link reduceLaneState} 的输入：恢复切片外加叶子指针与配置推导所需的有界 entry。 */
export interface LaneReductionInput extends RecordLogSlice {
	/** lane 当前叶子 entry id。 */
	leafId: string | null;
	/** 未完成操作已写出的 entry，最旧在前；空闲时为空。 */
	ownEntries: readonly Entry[];
	/** 在操作锚点（或空闲叶子）处做的有界生效状态回溯 entry，最旧在前。 */
	configurationEntries: readonly Entry[];
	/** 无持久化配置时使用的 harness 选项兜底值。 */
	defaults: EffectiveLaneConfiguration;
}

/** {@link reduceLaneState} 的输出：lane 编排状态 + 生效配置 + 终态失败（无则 null）。 */
export interface LaneReductionResult {
	laneState: LaneState;
	effectiveConfiguration: EffectiveLaneConfiguration;
	terminalFailure: TerminalFailureState | null;
}

/** 同一 runId 当前步骤尝试系列的追踪游标（供 attempt 连续性校验）。 */
interface AttemptSeries {
	record: StepAttemptRecord;
}

/** 抛出 {@link RecordLogCorruption} 的唯一出口：以给定 reason 终止规约（never）。 */
function corrupt(reason: RecordLogCorruptionReason, message: string): never {
	throw new RecordLogCorruption(reason, message);
}

/** 类型收窄：record 是否携带 runId（即隶属于某个已启动的操作；operation_started 自身即操作起点，不带 runId）。 */
function hasRunId(record: LaneRecord): record is Exclude<LaneRecord, OperationStartedRecord> & { runId: string } {
	return "runId" in record && typeof record.runId === "string";
}

/** 已落盘 entry 与预置 intent 是否内容一致：剔除存储分配字段（parentId/seq/timestamp）后做深比较。 */
function matchesProvisionedEntry(entry: Entry, target: ProvisionedEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...payload } = entry;
	return Guard.IsDeepEqual(payload, target);
}

/**
 * 校验预置 entry 的内容一致性：目标 id 若已有 entry，必须与 intent 逐字段一致，
 * 否则判 provisioned_entry_mismatch（同 id 不同内容 = 改写历史，协议禁止）。
 */
function validateExactProvisionedEntry(entriesById: ReadonlyMap<string, Entry>, target: ProvisionedEntry): void {
	const entry = entriesById.get(target.id);
	if (entry && !matchesProvisionedEntry(entry, target)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned entry ${target.id} exists with content different from its intent`,
		);
	}
}

/**
 * 校验预期结果 entry 的形态：若结果 entry 已存在，必须满足 matches 描述的结构，
 * 否则判 provisioned_entry_mismatch；不存在不算损坏——那是「结果尚未落盘」的
 * 合法崩溃中间态，由规约归入 pending / 进行中集合。
 */
function validateResultEntry(
	entriesById: ReadonlyMap<string, Entry>,
	resultEntryId: string,
	matches: (entry: Entry) => boolean,
	description: string,
): void {
	const entry = entriesById.get(resultEntryId);
	if (entry && !matches(entry)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned ${description} entry ${resultEntryId} exists with different content`,
		);
	}
}

/**
 * 校验 step_attempt 的 compactionReason：compaction 尝试必须携带合法 reason
 * （manual / threshold / overflow），其他步骤不得携带——reason 决定恢复时
 * 是否继续同样的压缩工作，缺失或错放都无法正确重放。
 */
function validateAttemptReason(record: StepAttemptRecord): void {
	const reason = (record as { compactionReason?: unknown }).compactionReason;
	if (record.step === "compaction") {
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") {
			corrupt("invalid_compaction_reason", `Compaction attempt ${record.id} has no valid compaction reason`);
		}
	} else if (reason !== undefined) {
		corrupt("invalid_compaction_reason", `${record.step} attempt ${record.id} has a compaction reason`);
	}
}

/**
 * 校验 attempt 序号连续性：延续同一步骤系列（同 step，且前次结果尚未落盘，或
 * 前次结果 entry 的 seq 不早于本次 attempt record——即仍是同一份未收尾的工作）时
 * 必须恰好是前次 +1；开启新系列时必须为 1，否则判 non_consecutive_attempt。
 * 同一系列内后续尝试的 resultEntryId / compactionReason 必须与系列保持一致，
 * 否则判 inconsistent_step（同一份工作出现两个不同目标即矛盾）。
 */
function validateAttemptSequence(
	record: StepAttemptRecord,
	previous: AttemptSeries | undefined,
	entriesById: ReadonlyMap<string, Entry>,
): void {
	const previousRecord = previous?.record;
	const previousResult = previousRecord ? entriesById.get(previousRecord.resultEntryId) : undefined;
	const continuesSeries =
		previousRecord !== undefined &&
		previousRecord.step === record.step &&
		(previousResult === undefined || previousResult.seq >= record.seq);
	const expectedAttempt = continuesSeries ? previousRecord.attempt + 1 : 1;
	if (record.attempt !== expectedAttempt) {
		corrupt(
			"non_consecutive_attempt",
			`${record.step} attempt ${record.id} is ${record.attempt}; expected ${expectedAttempt}`,
		);
	}
	if (!continuesSeries || record.step === "assistant" || previousRecord === undefined) return;
	if (record.resultEntryId !== previousRecord.resultEntryId) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their result entry id`);
	}
	if (record.compactionReason !== previousRecord.compactionReason) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their compaction reason`);
	}
}

/** 按 step 类型校验结果 entry 的形态：assistant → assistant 消息；compaction → compaction entry；branch_summary → branch_summary entry（若已落盘）。 */
function validateAttemptResult(entriesById: ReadonlyMap<string, Entry>, record: StepAttemptRecord): void {
	switch (record.step) {
		case "assistant":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "message" && entry.message.role === "assistant",
				"assistant result",
			);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "compaction",
				"compaction result",
			);
			break;
		case "branch_summary":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "branch_summary",
				"branch-summary result",
			);
			break;
	}
}

/**
 * 校验 tool_started record：
 * - 同一 (assistantEntryId, toolIndex) 不得重复开始——判 duplicate_tool_invocation
 *   （崩溃重放时已开始的调用不得再记一条 started）；
 * - 必须指向一条 assistant entry，且 toolIndex / toolCallId / toolName 与该消息
 *   content 中的 toolCall 严格按序对齐——否则判 tool_call_mismatch；
 * - 预期结果 entry 若已落盘，必须是匹配该 toolCallId / toolName 的 toolResult 消息。
 * record 上持久化的 effectiveArgs 与 replay 策略（never = 有副作用不得重放，
 * safe = 可用持久化参数安全重放）由恢复方在补齐结果时使用。
 */
function validateToolStart(
	record: Extract<LaneRecord, { type: "tool_started" }>,
	entriesById: ReadonlyMap<string, Entry>,
	invocations: Set<string>,
): void {
	const invocation = `${record.assistantEntryId}\u0000${record.toolIndex}`;
	if (invocations.has(invocation)) {
		corrupt(
			"duplicate_tool_invocation",
			`Tool invocation ${record.assistantEntryId}:${record.toolIndex} is duplicated`,
		);
	}
	invocations.add(invocation);

	const assistantEntry = entriesById.get(record.assistantEntryId);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not reference an assistant entry`);
	}
	const toolCalls = assistantEntry.message.content.filter((content) => content.type === "toolCall");
	const toolCall = toolCalls[record.toolIndex];
	if (!toolCall || toolCall.id !== record.toolCallId || toolCall.name !== record.toolName) {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not match its assistant tool-call ordinal`);
	}

	validateResultEntry(
		entriesById,
		record.resultEntryId,
		(entry) =>
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.toolCallId === record.toolCallId &&
			entry.message.toolName === record.toolName,
		"tool result",
	);
}

/** 校验 deferred 句柄完整性：stopReason 为 deferred 的 assistant entry 必须携带 deferred 句柄，否则判 invalid_deferred_handle（没有句柄就无法取回真实响应）。 */
function validateDeferredHandles(entries: Iterable<Entry>): void {
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason === "deferred" &&
			!entry.message.deferred
		) {
			corrupt("invalid_deferred_handle", `Deferred assistant entry ${entry.id} does not carry a handle`);
		}
	}
}

/**
 * 按操作 intent 校验其结构目标（若已落盘则必须与 intent 匹配，否则判
 * provisioned_entry_mismatch）：run 逐条校验捕获的初始消息；compaction 校验
 * 预期的 compaction 结果 entry；navigation 校验预期的 branch_summary 摘要 entry。
 */
function validateOperationResult(entriesById: ReadonlyMap<string, Entry>, record: OperationStartedRecord): void {
	switch (record.intent.kind) {
		case "run":
			for (const target of record.intent.initialMessages) validateExactProvisionedEntry(entriesById, target);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.intent.resultEntryId,
				(entry) => entry.type === "compaction",
				"manual compaction",
			);
			break;
		case "navigation":
			if (record.intent.summaryEntryId) {
				validateResultEntry(
					entriesById,
					record.intent.summaryEntryId,
					(entry) => entry.type === "branch_summary",
					"navigation summary",
				);
			}
			break;
	}
}

/**
 * 校验一个 lane 的有界恢复切片：只依赖传入的切片，不读取也不改动会话状态。
 * 发现单写者协议不可能产生的矛盾时抛 {@link RecordLogCorruption}；
 * {@link reduceLaneState} 规约前必须先通过本校验。
 */
export function validateRecordLog(input: RecordLogSlice): void {
	// 单写者前置检查：一个 lane 至多一个未完成的操作，两个即损坏。
	if (input.openOperations.length > 1) {
		corrupt("multiple_open_operations", `Lane ${input.lane} has at least two open operations`);
	}

	// 校验过程中的单遍扫描状态：entry 按 id 建索引，其余按 runId 追踪各操作
	// 的启动 / 结束 / 中止位点、最新的步骤尝试、入队记录与已见工具调用。
	const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
	validateDeferredHandles(entriesById.values());
	const starts = new Map<string, OperationStartedRecord>();
	const finishedAt = new Map<string, number>();
	const abortedAt = new Map<string, number>();
	const queueEnqueues = new Map<string, Extract<LaneRecord, { type: "queue_enqueued" }>>();
	const latestAttempt = new Map<string, AttemptSeries>();
	const toolInvocations = new Set<string>();
	const records = [...input.records].sort((left, right) => left.seq - right.seq);

	// 按 seq 升序单遍扫描：operation_started 注册操作起点并校验其 intent；
	// 其余 record 必须隶属于一个已见、且尚未 finish 的操作（unknown_operation /
	// record_after_finish），再按类型做各自的语义校验。
	for (const record of records) {
		if (record.type === "operation_started") {
			starts.set(record.id, record);
			validateOperationResult(entriesById, record);
			continue;
		}

		if (hasRunId(record)) {
			if (!starts.has(record.runId)) {
				corrupt("unknown_operation", `Record ${record.id} references unknown operation ${record.runId}`);
			}
			const finishSeq = finishedAt.get(record.runId);
			if (finishSeq !== undefined && record.seq > finishSeq) {
				corrupt("record_after_finish", `Record ${record.id} follows the finish of operation ${record.runId}`);
			}
		}

		switch (record.type) {
			// ========== operation_finished：操作收尾 ==========
			// 语义：以 completed / aborted / failed / declined 结束 runId 指向的操作。
			// 状态迁移：记录 finish seq；此后该操作的任何 record 都判 record_after_finish
			//（正常日志——包括崩溃重放——不会越过终点，越界即矛盾）。
			case "operation_finished":
				finishedAt.set(record.runId, record.seq);
				break;
			// ========== abort_requested：请求中止 ==========
			// 语义：对运行中的操作发出中止信号。状态迁移：记录 abort seq；
			// 之后该操作再入队 steer/followUp 判 queue_after_abort。崩溃重放时
			// 规约据此置 aborting，未消费输入被丢弃，恢复方走中止收尾路径。
			case "abort_requested":
				abortedAt.set(record.runId, record.seq);
				break;
			// ========== step_attempt：步骤尝试 ==========
			// 语义：声明某步骤（assistant / compaction / branch_summary）的第 attempt
			// 次尝试及其预期结果 entry。状态迁移：登记为该操作的最新尝试；三个校验
			// 分别保证 reason 合法、attempt 序号连续、结果形态正确。崩溃重放时结果
			// entry 未落盘 ≠ 损坏——那是「请求进行中」的合法截断，恢复方可安全重发
			//（LLM 请求无副作用，结果按预置 id 幂等补写）。
			case "step_attempt":
				validateAttemptReason(record);
				validateAttemptSequence(record, latestAttempt.get(record.runId), entriesById);
				validateAttemptResult(entriesById, record);
				latestAttempt.set(record.runId, { record });
				break;
			// ========== tool_started：工具调用开始 ==========
			// 语义：声明 assistant 消息中第 toolIndex 个 toolCall 开始执行，持久化
			// effectiveArgs 与预期结果 entry。崩溃重放：结果未落盘时由恢复方按
			// record 上的 replay 策略处理——never（有副作用）不得重新执行，
			// safe 可用持久化参数安全重放；重复开始或与 assistant 的 toolCall
			// 不对齐都判损坏。
			case "tool_started":
				validateToolStart(record, entriesById, toolInvocations);
				break;
			// ========== queue_enqueued：输入入队 ==========
			// 语义：content-first 入队——steer / followUp 隶属于 runId 指向的操作，
			// nextRun 属于 lane 本身（无 runId）。abort 之后的 steer/followUp 入队
			// 判 queue_after_abort；目标 entry 若已落盘必须与入队 intent 逐字段一致。
			// 崩溃重放：target 尚未落盘即归入 pending 队列，由恢复方补写。
			case "queue_enqueued":
				if (
					record.queue !== "nextRun" &&
					abortedAt.get(record.runId) !== undefined &&
					record.seq > abortedAt.get(record.runId)!
				) {
					corrupt("queue_after_abort", `${record.queue} item ${record.target.id} was enqueued after abort`);
				}
				queueEnqueues.set(record.target.id, record);
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			// ========== queue_cancelled：取消排队 ==========
			// 语义：撤销一条仍在排队（尚未落盘为 entry）的输入。判损坏条件：找不到
			// 同操作（runId 一致）、更早的匹配 enqueue，或该条目其实已经落盘
			//（已消费的入队不可再取消）。
			case "queue_cancelled": {
				const enqueue = queueEnqueues.get(record.entryId);
				if (
					!enqueue ||
					enqueue.seq >= record.seq ||
					enqueue.runId !== record.runId ||
					entriesById.has(record.entryId)
				) {
					corrupt("invalid_queue_cancellation", `Queue cancellation ${record.id} has no pending matching enqueue`);
				}
				break;
			}
			// ========== write_deferred：推迟写入 ==========
			// 语义：声明一次推迟的树写入（崩溃 / 中止后由恢复方补写）。目标 entry
			// 若已存在必须与 intent 一致；未存在则规约为 pendingWrites。
			case "write_deferred":
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			// ========== usage：Usage 台账 ==========
			// 语义：追加 token / 成本记账（assistant / compaction / branch_summary /
			// deferred_fetch / tool / hook / adjustment 等来源），不参与操作状态机，
			// 校验无额外约束；规约时用于给终态失败做 deferred_fetch 来源归因。
			case "usage":
				break;
		}
	}
}

/** 深拷贝：保证规约输出不与输入共享任何可变引用。 */
function clone<T>(value: T): T {
	return structuredClone(value);
}

/** 按 seq 升序返回副本（不改原数组顺序）。 */
function bySequence<T extends { seq: number }>(values: readonly T[]): T[] {
	return [...values].sort((left, right) => left.seq - right.seq);
}

/**
 * 推导 lane 的生效配置：从 defaults 兜底出发，把配置回溯 entry 与操作自身 entry
 * 按 seq 顺序折叠——model_change / thinking_level_change / active_tools_change
 * 直接覆盖对应项，assistant 消息则以其内嵌的 provider/model 更新当前模型。
 * 恢复后的下一请求必须使用与崩溃前一致的模型与工具集。
 */
function deriveEffectiveConfiguration(input: LaneReductionInput): EffectiveLaneConfiguration {
	let configuration = clone(input.defaults);
	const entriesById = new Map<string, Entry>();
	for (const entry of [...input.configurationEntries, ...input.ownEntries]) entriesById.set(entry.id, entry);

	for (const entry of bySequence([...entriesById.values()])) {
		switch (entry.type) {
			case "model_change":
				configuration = { ...configuration, model: { provider: entry.provider, modelId: entry.modelId } };
				break;
			case "thinking_level_change":
				configuration = { ...configuration, thinkingLevel: entry.thinkingLevel as ThinkingLevel };
				break;
			case "active_tools_change":
				configuration = { ...configuration, activeToolNames: [...entry.activeToolNames] };
				break;
			case "message":
				if (entry.message.role === "assistant") {
					configuration = {
						...configuration,
						model: { provider: entry.message.provider, modelId: entry.message.model },
					};
				}
				break;
		}
	}
	return configuration;
}

/** 把最新自身 entry 压缩为 newestOwn 摘要：非消息只留 type；消息补 role；assistant 再补 stopReason。 */
function deriveNewestOwn(
	entry: Entry | undefined,
): NonNullable<NonNullable<LaneState["operation"]>["newestOwn"]> | null {
	if (!entry) return null;
	if (entry.type !== "message") return { entryId: entry.id, type: entry.type };
	if (entry.message.role !== "assistant") {
		return { entryId: entry.id, type: entry.type, role: entry.message.role };
	}
	return {
		entryId: entry.id,
		type: entry.type,
		role: entry.message.role,
		stopReason: entry.message.stopReason,
	};
}

/**
 * 重建进行中的工具批：取该操作最新一条含 toolCall 的 assistant entry，把每个
 * toolCall（按序号）与本操作的 tool_started record、已落盘结果对齐：
 * - 结果判定：tool_started 预置的结果 entry 优先；否则找 assistant 之后直接出现
 *   的匹配 toolResult（排除 write_deferred 推迟的写入——那要等恢复方补写）；
 * - truncated：assistant 消息因 length 截断；unresolved：仍有结果未落盘，
 *   恢复时按各 record 的 replay 策略（never 不得重放 / safe 可安全重放）补齐。
 * 找不到这样的 assistant entry 时返回 null（无进行中的工具批）。
 */
function deriveToolBatch(
	operationId: string,
	records: readonly LaneRecord[],
	ownEntries: readonly Entry[],
	entriesById: ReadonlyMap<string, Entry>,
	deferredWriteIds: ReadonlySet<string>,
): ToolBatchState | null {
	const assistantEntry = [...ownEntries]
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((content) => content.type === "toolCall"),
		);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") return null;

	const toolCalls = assistantEntry.message.content.filter(
		(content): content is AgentToolCall => content.type === "toolCall",
	);
	const starts = new Map<number, ToolStartedRecord>();
	for (const record of records) {
		if (
			record.type === "tool_started" &&
			record.runId === operationId &&
			record.assistantEntryId === assistantEntry.id
		) {
			starts.set(record.toolIndex, record);
		}
	}

	const calls = toolCalls.map((toolCall, toolIndex) => {
		const started = starts.get(toolIndex);
		const startedResult = started ? entriesById.get(started.resultEntryId) : undefined;
		const blockedResult = ownEntries.find(
			(entry) =>
				entry.seq > assistantEntry.seq &&
				!deferredWriteIds.has(entry.id) &&
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === toolCall.id,
		);
		const result = startedResult ?? blockedResult;
		return {
			toolIndex,
			toolCall: clone(toolCall),
			...(started ? { started: clone(started) } : {}),
			resultExists: result !== undefined,
			...(result?.type === "message" && result.terminate === true ? { terminate: true } : {}),
		};
	});

	return {
		assistantEntryId: assistantEntry.id,
		calls,
		truncated: assistantEntry.message.stopReason === "length",
		unresolved: calls.some((call) => !call.resultExists),
	};
}

/**
 * 从有界的恢复输入纯函数式地重建单个 lane 的编排状态。
 * 先经 {@link validateRecordLog} 校验，再规约出 {@link LaneState}、生效配置
 * {@link EffectiveLaneConfiguration} 与终态失败 {@link TerminalFailureState}；
 * 不修改、不别名引用任何输入（输出均为克隆副本）。
 */
export function reduceLaneState(input: LaneReductionInput): LaneReductionResult {
	// ========== 校验与规约准备 ==========
	// 先做损坏校验；record 与自身 entry 统一按 seq 升序并建立 id 索引，
	// 后续所有「intent 是否已落盘」的判断都通过该索引完成。
	validateRecordLog(input);

	const records = bySequence(input.records);
	const ownEntries = bySequence(input.ownEntries);
	const entriesById = new Map<string, Entry>();
	for (const entry of [...input.entries, ...ownEntries]) entriesById.set(entry.id, entry);
	// ========== 队列规约（queue_enqueued / queue_cancelled） ==========
	// 已取消的排队条目不再算 pending；入队目标尚未落盘且未取消的才是待处理队列。
	const cancelledQueueIds = new Set(
		records.filter((record) => record.type === "queue_cancelled").map((record) => record.entryId),
	);
	const pendingQueueRecords = records.filter(
		(record): record is QueueEnqueuedRecord =>
			record.type === "queue_enqueued" &&
			!entriesById.has(record.target.id) &&
			!cancelledQueueIds.has(record.target.id),
	);
	const started = input.openOperations[0];
	// 已被本操作 initialMessages 捕获的 nextRun 条目不算「下一轮」——它们就是本轮输入。
	const capturedInitialMessageIds = new Set(
		started?.intent.kind === "run" ? started.intent.initialMessages.map((target) => target.id) : [],
	);
	const pendingNextRun = pendingQueueRecords
		.filter((record) => record.queue === "nextRun" && !capturedInitialMessageIds.has(record.target.id))
		.map((record) => clone(record.target));
	const effectiveConfiguration = deriveEffectiveConfiguration(input);

	// ========== 空闲分支：无未完成操作 ==========
	// 没有未完成的 operation_started 即崩溃前 lane 已收尾：只剩 lane 级的
	// pendingNextRun 需要保留，无操作状态、无终态失败。
	if (!started) {
		return {
			laneState: { lane: input.lane, leafId: input.leafId, operation: null, pendingNextRun },
			effectiveConfiguration,
			terminalFailure: null,
		};
	}

	// ========== 操作输入队列（steer / followUp / 推迟写入 / 缺失初始消息） ==========
	// 只保留隶属于当前未完成操作的 record（其 runId == operation id）。
	const operationRecords = records.filter((record) =>
		record.type === "operation_started" ? record.id === started.id : "runId" in record && record.runId === started.id,
	);
	// abort 请求已发出：中止流程中不再消费 steer / followUp，二者直接丢弃。
	const aborting = operationRecords.some((record) => record.type === "abort_requested");
	const pendingSteer = aborting
		? []
		: pendingQueueRecords
				.filter((record) => record.queue === "steer" && record.runId === started.id)
				.map((record) => clone(record.target));
	const pendingFollowUp = aborting
		? []
		: pendingQueueRecords
				.filter((record) => record.queue === "followUp" && record.runId === started.id)
				.map((record) => clone(record.target));
	// write_deferred 声明过、但 entry 尚未写出的推迟树写入——恢复时按预置 id 补写。
	const pendingWrites = operationRecords
		.filter(
			(record): record is WriteDeferredRecord =>
				record.type === "write_deferred" && !entriesById.has(record.target.id),
		)
		.map((record) => clone(record.target));
	// run intent 捕获的初始消息中尚未落盘的部分——崩溃可能发生在「声明输入」与
	// 「写出输入」之间，恢复时先补写这些消息再继续。
	const missingInitialMessages =
		started.intent.kind === "run"
			? started.intent.initialMessages.filter((target) => !entriesById.has(target.id)).map(clone)
			: [];

	// ========== 进行中的步骤（step_attempt） ==========
	// 最新一次尝试的预期结果 entry 还没写出 ⇒ 该步骤仍在进行（LLM 请求进行中或
	// 待重试），保留 kind / 次数 / 结果 id（compaction 再留 reason）供恢复方重发。
	// 结果已落盘则步骤已收尾，step 为 null。
	const newestAttempt = operationRecords.filter((record) => record.type === "step_attempt").at(-1);
	const step =
		newestAttempt && !entriesById.has(newestAttempt.resultEntryId)
			? {
					kind: newestAttempt.step,
					attempts: newestAttempt.attempt,
					resultEntryId: newestAttempt.resultEntryId,
					...(newestAttempt.step === "compaction" ? { compactionReason: newestAttempt.compactionReason } : {}),
				}
			: null;

	// ========== overflow 恢复标记 ==========
	// 「已消费输入」= run 的初始消息 + 本操作内入队的 steer / followUp（nextRun 除外）。
	// 若 overflow compaction 发生在这些输入之后（即当前这批输入已经用过一次
	// overflow 恢复），置 true——恢复方不得对同一输入再次 overflow，只有更新的
	// 会话输入落盘后才复位，避免 overflow → 重试 → overflow 的死循环。
	const consumedInputIds = new Set<string>();
	if (started.intent.kind === "run") {
		for (const target of started.intent.initialMessages) consumedInputIds.add(target.id);
	}
	for (const record of operationRecords) {
		if (record.type === "queue_enqueued" && record.queue !== "nextRun") consumedInputIds.add(record.target.id);
	}
	let newestConsumedInputSequence = Number.NEGATIVE_INFINITY;
	for (const id of consumedInputIds) {
		const entry = entriesById.get(id);
		if (entry?.type === "message") newestConsumedInputSequence = Math.max(newestConsumedInputSequence, entry.seq);
	}
	const overflowRecoveryUsed = operationRecords.some(
		(record) =>
			record.type === "step_attempt" &&
			record.step === "compaction" &&
			record.compactionReason === "overflow" &&
			record.seq > newestConsumedInputSequence,
	);

	// ========== 最新自身 entry、deferred 句柄与结构目标 ==========
	const newestOwnEntry = ownEntries.at(-1);
	const newestOwn = deriveNewestOwn(newestOwnEntry);
	// 最新 assistant entry 停在 deferred：取回真实响应所需的句柄随消息持久化，
	// 恢复方凭它继续（或超时后判失败）。
	const deferred =
		newestOwnEntry?.type === "message" &&
		newestOwnEntry.message.role === "assistant" &&
		newestOwnEntry.message.stopReason === "deferred" &&
		newestOwnEntry.message.deferred
			? clone(newestOwnEntry.message.deferred)
			: null;
	// 结构目标完成度：compaction 看预期结果 entry、navigation 看预期摘要 entry
	// 是否已落盘（intent 声明了目标而 entry 未到 = 工作未完成，不是损坏）。
	const targets: { result?: boolean; summary?: boolean } = {};
	if (started.intent.kind === "compaction") {
		targets.result = entriesById.has(started.intent.resultEntryId);
	} else if (started.intent.kind === "navigation" && started.intent.summaryEntryId) {
		targets.summary = entriesById.has(started.intent.summaryEntryId);
	}

	// ========== 终态失败归因 ==========
	// 最新自身 entry 是 assistant error 且不是推迟写入的产物时，尝试归因：
	// ① 某次 step_attempt 的预期结果正是它 → 来源 step；
	// ② 有 deferred_fetch 的 usage 记账指向它，或前一条自身 entry 停在 deferred
	//   → 来源 deferred_fetch。二者都是「已结算的失败」：恢复时不重试，直接汇报。
	const deferredWriteIds = new Set(
		operationRecords.filter((record) => record.type === "write_deferred").map((record) => record.target.id),
	);
	let terminalFailure: TerminalFailureState | null = null;
	if (
		newestOwnEntry?.type === "message" &&
		newestOwnEntry.message.role === "assistant" &&
		newestOwnEntry.message.stopReason === "error" &&
		!deferredWriteIds.has(newestOwnEntry.id)
	) {
		const producedByStep = operationRecords.some(
			(record) => record.type === "step_attempt" && record.resultEntryId === newestOwnEntry.id,
		);
		const previousOwnEntry = ownEntries.at(-2);
		const producedByDeferredFetch =
			operationRecords.some(
				(record) =>
					record.type === "usage" && record.cause === "deferred_fetch" && record.entryId === newestOwnEntry.id,
			) ||
			(previousOwnEntry?.type === "message" &&
				previousOwnEntry.message.role === "assistant" &&
				previousOwnEntry.message.stopReason === "deferred");
		if (producedByStep || producedByDeferredFetch) {
			terminalFailure = {
				entryId: newestOwnEntry.id,
				source: producedByStep ? "step" : "deferred_fetch",
				message: clone(newestOwnEntry.message),
			};
		}
	}

	// ========== 组装 LaneState 并返回 ==========
	return {
		laneState: {
			lane: input.lane,
			leafId: input.leafId,
			operation: {
				id: started.id,
				kind: started.intent.kind,
				intent: clone(started.intent),
				aborting,
				step,
				toolBatch: deriveToolBatch(started.id, operationRecords, ownEntries, entriesById, deferredWriteIds),
				missingInitialMessages,
				pendingSteer,
				pendingFollowUp,
				pendingWrites,
				deferred,
				overflowRecoveryUsed,
				newestOwn,
				targets,
			},
			pendingNextRun,
		},
		effectiveConfiguration,
		terminalFailure,
	};
}
