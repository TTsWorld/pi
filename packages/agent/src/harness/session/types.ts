/**
 * @file session/types.ts —— 会话持久化的类型基石：Entry 树 + Record 操作日志 + 三层访问接口。
 *
 * @description
 * 会话数据由两条互补的持久化脉络构成：
 * - **Entry 树**（{@link Entry}）：会话内容的不可变事实——message /
 *   model_change / thinking_level_change / active_tools_change / compaction /
 *   branch_summary / custom 等 entry 经 parentId 链成一棵树；**lane（泳道）是
 *   Entry 树上的命名游标**（默认 "main"，可对应 Slack 线程、子代理等独立推进
 *   的对话线），向 lane 追加 entry 即把该 lane 的叶子沿树向前推进。
 * - **Record 操作日志**（{@link LaneRecord}）：harness「单写者协议」追加的操作
 *   轨迹（operation_started / step_attempt / tool_started / queue_enqueued /
 *   usage 等），与树内容分离、按全局 seq 有序，供崩溃恢复（见 ../reducer.ts）
 *   回放与用量统计。
 *
 * 三层访问接口自底向上：
 * 1. {@link SessionStorage}——最底层存储契约：追加 entry / record + 各类查询 +
 *    lane / 全局 facts 管理（JSONL 等后端实现它）；
 * 2. {@link SessionTree}——类型化门面，由 Session（./session.ts）实现：严格
 *    JSON 可序列化校验 + UUIDv7 entry id 分配，view(lane) 返回指定 lane 的
 *    SessionTree 视图；
 * 3. {@link SessionRepo}——会话仓库：create / open / list / delete / fork。
 */
import type { StopReason, Usage } from "@earendil-works/pi-ai";
import "../messages.ts";
import type { AgentMessage } from "../../types.ts";
import type { Session } from "./session.ts";

/** 可持久化的纯 JSON 值（递归定义）；扩展数据等附带字段必须可被安全序列化。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * 会话层消息停止原因：取 LLM 侧 {@link StopReason} 但排除 "pending"（流式中、
 * 尚未定论），并补充 "deferred"（异步延迟响应，需按句柄取回真实结果）。
 */
export type SessionStopReason = Exclude<StopReason, "pending"> | "deferred";

/** entry id 生成器抽象；Session 默认实现为 UUIDv7（时间有序，利于排序）。 */
export interface IdGenerator {
	next(): string;
}

/** 所有 entry 的公共字段。entry 一经落盘不可变，构成会话内容的事实来源。 */
export interface EntryBase {
	/** 类型判别字段，见各 entry 子类型。 */
	type: string;
	/** entry 唯一 id：由写入方（Session 的 {@link IdGenerator}）在提交前预置。 */
	id: string;
	seq: number; // 共享序列号（entry/record/lane/fact 同一序号空间）；读侧字段，由存储分配
	parentId: string | null; // 存储分配：父 entry，即追加时所在 lane 的当前叶子
	timestamp: number; // Unix 毫秒时间戳，由存储分配
}

/** 对话消息 entry：用户 / 助手 / 工具结果等 {@link AgentMessage} 的载体，是 Entry 树的主体。 */
export interface MessageEntry extends EntryBase {
	type: "message";
	message: AgentMessage;
	/** 工具结果要求终止本轮运行的标记（如用户叫停工具批）；崩溃恢复时由 reducer 读取。 */
	terminate?: true;
}

/** 模型切换 entry：从此 entry 起，该 lane 的 LLM 请求改用新模型（生效配置沿分支回溯得出）。 */
export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	/** 模型提供方标识（如 "anthropic"）。 */
	provider: string;
	/** 该提供方下的具体模型 id。 */
	modelId: string;
}

/** 思考级别切换 entry：调整该 lane 的推理强度（如 off / medium / high）。 */
export interface ThinkingLevelEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/** 启用工具集切换 entry：记录此后该 lane 可调用的工具名列表。 */
export interface ActiveToolsEntry extends EntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

/**
 * 压缩 entry：上下文过长时以摘要替换前段历史。后续构建上下文时，本 entry 之前
 * 的消息由 summary 概括代表，retainedTail 中的近期消息原样保留。
 */
export interface CompactionEntry extends EntryBase {
	type: "compaction";
	/** 压缩生成的摘要正文。 */
	summary: string;
	/** 压缩后原样保留的近期消息（直接存在 entry 上，作为摘要之后的「虚拟尾部」）。 */
	retainedTail: AgentMessage[];
	/** 压缩前上下文的 token 估算值。 */
	tokensBefore: number;
	/** 压缩实现自定义的附带信息。 */
	details?: unknown;
	/** 生成该摘要的 LLM 调用的 usage。 */
	usage?: Usage;
}

/**
 * 分支摘要 entry：树导航离开某条分支时，为被放弃的分支生成摘要，使回到主线后
 * 的上下文仍能引用「刚返回的那条分支讲了什么」。
 */
export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	/** 被摘要分支的叶子 entry id，标识该分支的结束位置。 */
	fromId: string;
	/** 分支摘要正文。 */
	summary: string;
	details?: unknown;
	usage?: Usage;
}

/** 自定义 entry：应用自带载荷的扩展点，按 customType 二次判别（查询可用 EntryQuery.customType）。 */
export interface CustomEntry extends EntryBase {
	type: "custom";
	/** 自定义类型名（type: "custom" 之下的二级判别字段）。 */
	customType: string;
	data?: unknown;
}

/** Entry 树节点类型的全集。 */
export type Entry =
	| MessageEntry
	| ModelChangeEntry
	| ThinkingLevelEntry
	| ActiveToolsEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry;

/**
 * 「已预置、未提交」的 entry：剔除存储分配字段（parentId / seq / timestamp）后的
 * 载荷。写入方构造它并预置 id；record 日志中声明的 intent / target 也用它表达，
 * 恢复时据此按 id 幂等补写。
 */
export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
	? Omit<TEntry, "parentId" | "seq" | "timestamp">
	: never;

/** 所有 record 的公共字段。record 是 lane 操作日志的条目：只追加、不构成树。 */
export interface RecordBase {
	/**
	 * record 唯一 id。operation_started 的 id 即整个操作的 runId；其余隶属操作
	 * 的 record 则把 runId 存为独立字段。
	 */
	id: string;
	/** 全局共享序列号（与 entry 同一序号空间），由存储分配。 */
	seq: number;
	/** 该 record 所属的 lane 名。 */
	lane: string;
	/** Unix 毫秒时间戳，由存储分配。 */
	timestamp: number;
}

/**
 * 操作启动 record：一个 lane 操作（run / compaction / navigation）的起点。其 id
 * 即操作 runId，后续隶属该操作的 record 都以 runId 字段关联它；崩溃恢复时依据
 * 它判定 lane 是否存在未完成操作及如何续起。
 */
export interface OperationStartedRecord extends RecordBase {
	type: "operation_started";
	/** 操作启动时所在 lane 的叶子 entry id（操作锚点；lane 为空时为 null）。 */
	sourceLeafId: string | null;
	/** 操作意图快照，按 kind 分三种。 */
	intent:
		| {
				kind: "run";
				/** before_run 之前的规范化调用方输入；为挂起 (suspended) 操作与 before_resume 保留。 */
				originalPrompt: AgentMessage[];
				/** 捕获的 nextRun 队列项，随后是 prompt，再随后是 before_run 注入内容。 */
				initialMessages: ProvisionedEntry[];
				/** 覆盖系统提示词（如有）。 */
				systemPromptOverride?: string;
				/** 各扩展在恢复 (resume) 时所需的数据，按扩展 id 存放。 */
				resumeData?: { [extensionId: string]: JsonValue };
		  }
		| {
				kind: "compaction";
				/** 压缩的自定义指令（如有）。 */
				customInstructions?: string;
				/** 预置的压缩结果 entry id（恢复时据此判定结果是否已落盘）。 */
				resultEntryId: string;
		  }
		| {
				kind: "navigation";
				/** 导航目标 entry id（移回根 / 清空时为 null）。 */
				targetId: string | null;
				/** 是否为被离开的分支生成分支摘要。 */
				summarize: boolean;
				/** 摘要生成的自定义指令（如有）。 */
				customInstructions?: string;
				/** 为目标位置设置的 lane 标签（如有）。 */
				label?: string;
				/** 预置的摘要结果 entry id（恢复时据此判定摘要是否已落盘）。 */
				summaryEntryId?: string;
		  };
}

/** 请求中止 record：调用方请求中止某个进行中的操作；此后该操作的 steer / followUp 队列输入会被丢弃。 */
export interface AbortRequestedRecord extends RecordBase {
	type: "abort_requested";
	/** 被请求中止的操作 runId。 */
	runId: string;
}

/** 操作收尾 record：一个操作的终态；此后同一 runId 不应再出现任何隶属 record。 */
export interface OperationFinishedRecord extends RecordBase {
	type: "operation_finished";
	/** 收尾的操作 runId。 */
	runId: string;
	/** 终态：完成 / 被中止 / 失败 / 被拒绝。 */
	outcome: "completed" | "aborted" | "failed" | "declined";
	/** 失败时的机器可读错误码与信息。 */
	error?: { code: string; message: string };
}

/** 压缩触发原因：manual（手动）/ threshold（达到阈值）/ overflow（上下文溢出恢复）。 */
export type CompactionReason = "manual" | "threshold" | "overflow";

/**
 * 步骤尝试 record：声明一次 LLM 生成步骤（assistant / compaction / branch_summary）
 * 开始及其预置的结果 entry。同一系列的 attempt 序号必须连续 +1；若崩溃时结果
 * entry 尚未落盘，恢复方据此重试该步骤。
 */
export type StepAttemptRecord = RecordBase &
	(
		| {
				type: "step_attempt";
				runId: string;
				/** 步骤类别：助手回复或分支摘要生成。 */
				step: "assistant" | "branch_summary";
				/** 尝试序号（本系列内从 1 起连续递增），供恢复方判断重试上限。 */
				attempt: number;
				/** 预置的结果 entry id，结果落盘时按它幂等对齐。 */
				resultEntryId: string;
				compactionReason?: never;
		  }
		| {
				type: "step_attempt";
				runId: string;
				/** 步骤类别：压缩摘要生成（必须携带触发原因）。 */
				step: "compaction";
				attempt: number;
				resultEntryId: string;
				/** 持久化压缩摘要生成的触发原因，使恢复时续做同一件事。 */
				compactionReason: CompactionReason;
		  }
	);

/**
 * 工具调用开始 record：声明某个 toolCall 开始执行，并预置其结果 entry 与重放
 * 策略。崩溃时若结果未落盘，恢复方按 replay 决定补齐还是安全重放。
 */
export interface ToolStartedRecord extends RecordBase {
	type: "tool_started";
	runId: string;
	/** 承载这批 toolCall 的 assistant entry id。 */
	assistantEntryId: string;
	/** 该 toolCall 在 assistant 消息 content 中的序号。 */
	toolIndex: number;
	/** 工具调用 id（与 assistant 消息中 toolCall 的 id 对应）。 */
	toolCallId: string;
	/** 工具名。 */
	toolName: string;
	/** 解析（展开）后实际生效的调用参数，作为持久化副本。 */
	effectiveArgs: { [key: string]: unknown };
	/** 预置的工具结果 entry id。 */
	resultEntryId: string;
	/** 重放策略：never = 有副作用不得重放；safe = 可用持久化参数安全重放。 */
	replay: "never" | "safe";
}

/**
 * 输入入队 record：把一条输入消息登记进队列。steer / followUp 隶属活动操作
 * （带 runId）；nextRun 是 lane 级队列（下个 run 才投入），不隶属任何操作。
 */
export type QueueEnqueuedRecord = RecordBase &
	(
		| {
				type: "queue_enqueued";
				/** 队列类别：steer（转向当前轮）/ followUp（追加到本轮之后）。 */
				queue: "steer" | "followUp";
				/** 所属活动操作的 runId。 */
				runId: string;
				/** 入队的输入（已预置 id，尚未成为树上的 entry）。 */
				target: ProvisionedEntry;
		  }
		| {
				type: "queue_enqueued";
				/** 队列类别：nextRun（下个 run 才投入，不隶属任何操作）。 */
				queue: "nextRun";
				runId?: never;
				target: ProvisionedEntry;
		  }
	);

/** 队列取消 record：撤销一条尚未消费的入队输入。 */
export interface QueueCancelledRecord extends RecordBase {
	type: "queue_cancelled";
	/** 被取消输入原属操作的 runId（nextRun 队列不隶属操作，可省略）。 */
	runId?: string;
	/** 被取消的入队目标 entry id。 */
	entryId: string;
}

/** 推迟写入 record：声明一个树写入已排定但尚未落盘；崩溃后恢复方按 target 补写。 */
export interface WriteDeferredRecord extends RecordBase {
	type: "write_deferred";
	runId: string;
	/** 待补写的预置 entry。 */
	target: ProvisionedEntry;
}

/**
 * 用量记账 record：按成因归集一次 LLM usage。它是 {@link SessionStats}（token /
 * 费用统计）的唯一数据来源，重放这些 record 即可重建统计。
 */
export type UsageRecord = RecordBase & { type: "usage"; usage: Usage } & (
		| {
				/** 成因：某次步骤尝试的产出（助手回复 / 压缩 / 分支摘要 / 延迟响应取回）。 */
				cause: "assistant" | "compaction" | "branch_summary" | "deferred_fetch";
				runId: string;
				/** 产出该用量的 entry id。 */
				entryId: string;
				/** 产出该结果的尝试序号（与 step_attempt 的 attempt 对齐）。 */
				attempt: number;
				/** 该次生成的停止原因。 */
				stopReason: SessionStopReason;
		  }
		/** 成因：工具调用自身的 LLM 消耗（按 toolCallId 关联）。 */
		| { cause: "tool"; runId: string; entryId: string; toolCallId: string }
		/** 成因：hook 的 LLM 消耗。 */
		| { cause: "hook"; runId: string; entryId: string }
		/** 成因：事后修正（调账），runId / entryId 可选。 */
		| { cause: "adjustment"; runId?: string; entryId?: string; details?: JsonValue }
	);

/** lane 操作日志类型的全集：单写者协议下所有可能的 record。 */
export type LaneRecord =
	| OperationStartedRecord
	| AbortRequestedRecord
	| OperationFinishedRecord
	| StepAttemptRecord
	| ToolStartedRecord
	| QueueEnqueuedRecord
	| QueueCancelledRecord
	| WriteDeferredRecord
	| UsageRecord;
/** 「待提交」的 record：剔除存储分配字段（seq / timestamp）后的载荷，由 appendRecord 落盘时补全。 */
export type NewRecord<TRecord extends LaneRecord = LaneRecord> = TRecord extends LaneRecord
	? Omit<TRecord, "seq" | "timestamp">
	: never;

/** 查询返回顺序：最新在前 / 最旧在前。 */
export type EntryOrder = "newestFirst" | "oldestFirst";

/** 分页游标：与 order 配合，只返回位于该 seq 「之后」一侧（更新或更旧）的结果。 */
export interface EntryCursor {
	afterSeq: number;
}

/** entry 查询条件；全部字段可选，缺省匹配所有 entry。 */
export interface EntryQuery {
	/** 按 entry 类型过滤。 */
	type?: Entry["type"];
	customType?: string; // 配合 type: "custom" 按 customType 过滤
	order?: EntryOrder; // 默认 newestFirst
	/** 最多返回的条数（正整数）。 */
	limit?: number;
	cursor?: EntryCursor;
}

/** 分支扫描的边界。默认：从叶子到根的整条路径。 */
export interface BranchBounds {
	start?: string; // 默认：当前视图 lane 的叶子
	stopAtType?: Entry["type"]; // 扫描在首个匹配项之后结束（含该项）
	/** 扫描终止的 entry id（含该项）。 */
	stopAtId?: string;
}

/** record 查询条件；全部字段可选，缺省匹配所有 record。 */
export interface RecordQuery {
	/** 精确匹配 lane。省略则查询所有 lane。 */
	lane?: string;
	/** 精确匹配 record 的类型判别字段。省略则查询所有 record 类型。 */
	type?: LaneRecord["type"];
	/**
	 * 操作标识。匹配 OperationStartedRecord 的 id 以及操作隶属 record 的
	 * runId 字段。不携带操作标识的 record 不会匹配。
	 */
	runId?: string;
	/** 精确匹配操作意图类别。仅在 type 为 "operation_started" 时有效。 */
	operationKind?: OperationStartedRecord["intent"]["kind"];
	/** 排他式时间下界：seq > afterSeq，与 order 无关。 */
	afterSeq?: number;
	/** 按序列返回的顺序。默认："newestFirst"。 */
	order?: EntryOrder;
	/** 匹配 record 的最大条数（正数）。 */
	limit?: number;
}

/** 会话元数据：仓库层（create/open/list/delete/fork）定位会话所需的最小信息；后端可扩展字段。 */
export interface SessionMetadata {
	/** 会话 id。 */
	id: string;
	/** 创建时间（Unix 毫秒）。 */
	createdAt: number;
	/** 若本会话由 fork 派生，记录其源会话 id。 */
	parentSessionId?: string;
}

/** 会话累计统计：由 usage record 回放累加得出（见 getStats）。 */
export interface SessionStats {
	/** message entry 总数。 */
	messageCount: number;
	/** 缓存命中的 token 总量。 */
	cachedTokens: number;
	/** 非缓存（新输入 + 缓存写入）的 token 总量。 */
	uncachedTokens: number;
	/** token 总量。 */
	totalTokens: number;
	/** 累计费用。 */
	costTotal: number;
}

/** lane 指针：泳道名与其当前叶子 entry id（lane 尚无任何 entry 时为 null）。 */
export interface LanePointer {
	lane: string;
	leafId: string | null;
}

/**
 * 统一日志项（getLog 的返回）：把会话全部持久化事件按全局 seq 混编成一个流——
 * entry 追加、record 追加、lane 指针迁移、全局 facts 变更（name / label）。
 */
export type LogItem =
	| { kind: "entry"; seq: number; entry: Entry }
	| { kind: "record"; seq: number; record: LaneRecord }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name: string | undefined }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label: string | undefined };

/** getLog 的翻页选项。 */
export interface LogOptions {
	/** 只返回 seq 大于该值的日志项。 */
	afterSeq?: number;
	/** 最多返回的条数（正整数）。 */
	limit?: number;
}

/**
 * 最底层存储契约：追加 entry / record + 各类查询 + lane / 全局 facts 管理，由
 * 具体后端（如 ./jsonl 的 JSONL 存储）实现，上层一律经 {@link Session} 门面访问。
 * 实现负责分配存储侧字段（seq / parentId / timestamp）并保证追加的耐久性。
 */
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	/** 读取本会话的元数据。 */
	getMetadata(): Promise<TMetadata>;

	// lane 管理
	/** 列出全部 lane 指针。 */
	getLanes(): Promise<{ lane: string; leafId: string | null }[]>;
	/** 在指定 entry（null = 根）处创建新 lane。 */
	createLane(lane: string, at: string | null): Promise<void>;
	/** 把 lane 指针移动到指定 entry（树导航；null = 移回根）。 */
	moveLane(lane: string, to: string | null): Promise<void>;

	// entry 与 record 追加
	/** 向指定 lane 追加 entry：存储分配 parentId / seq / timestamp 后返回完整 entry。 */
	appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry>;
	/** 追加 record：存储分配 seq / timestamp 后返回完整 record。 */
	appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord>;

	// 查询
	/** 按 id 取单个 entry；不存在时返回 undefined。 */
	getEntry(id: string): Promise<Entry | undefined>;
	/** 全会话（所有分支）按条件查询 entry。 */
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	/**
	 * 分支扫描查询。此处 start 为必填（区别于 SessionTree 的 findEntriesOnBranch——
	 * 那里缺省取 lane 叶子只是视图层的语法糖）。
	 */
	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]>;
	/** 按条件查询 record；带 type 的重载会把返回类型收窄到该 record 类型。 */
	findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	/**
	 * 返回未收尾的操作起点，最新在前。恢复方使用 `limit: 2`：0 条表示 lane 空闲，
	 * 1 条表示操作挂起，2 条表示至少两个操作未收尾——即损坏；更多结果不提供
	 * 额外的恢复状态。
	 */
	findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]>;
	/** 读取统一日志流（entry / record / lane / fact 混编，按 seq 升序）。 */
	getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]>;

	// 全局 facts
	/** 读取会话名。 */
	getName(): Promise<string | undefined>;
	/** 设置/清除会话名（传 undefined 清除）。 */
	setName(name: string | undefined): Promise<void>;
	/** 读取 entry 标签。 */
	getLabel(id: string): Promise<string | undefined>;
	/** 设置/清除 entry 标签（传 undefined 清除）。 */
	setLabel(id: string, label: string | undefined): Promise<void>;
	/** 读取会话累计统计（由 usage record 累加得出）。 */
	getStats(): Promise<SessionStats>;
}

/**
 * 单个 lane 视图的读写门面：由 Session（./session.ts）实现——Session 自身即
 * "main" lane 视图，view(lane) 派生其他 lane 的视图。分支查询默认以该视图
 * lane 的叶子为起点。
 */
export interface SessionTree {
	/** 当前视图 lane 的叶子 entry id（尚无任何 entry 时为 null）。 */
	getLeafId(): Promise<string | null>;
	/** 按 id 取单个 entry；不存在时返回 undefined。 */
	getEntry(id: string): Promise<Entry | undefined>;
	/** 读取会话累计统计。 */
	getStats(): Promise<SessionStats>;

	// 全局 facts。最新值生效；不按分支隔离。用 "set" 而非 "append"：
	// "append" 词汇保留给树写入。
	getName(): Promise<string | undefined>;
	setName(name: string | undefined): Promise<void>;
	getLabel(targetId: string): Promise<string | undefined>;
	setLabel(targetId: string, label: string | undefined): Promise<void>;

	/** 全会话查询：覆盖所有分支，按序列顺序。 */
	findEntries(query?: EntryQuery): Promise<Entry[]>;
	/** 同 findEntries，但只取首条匹配。 */
	findEntry(query?: EntryQuery): Promise<Entry | undefined>;

	/** 分支范围查询：从 start（默认 lane 叶子）向根的路径。 */
	findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]>;
	/** 同 findEntriesOnBranch，但只取首条匹配。 */
	findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined>;

	// 写入。在耐久接受时 resolve；返回值是 entry 的 id（写入推迟时为预置 id）。
	/** 向当前 lane 追加消息 entry，返回 entry id。 */
	appendMessage(message: AgentMessage): Promise<string>;
	/** 向当前 lane 追加自定义 entry，返回 entry id。 */
	appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}

/** 创建会话的选项；具体后端可扩展（见 SessionRepo 的 TCreateOptions 泛型参数）。 */
export interface SessionCreateOptions {
	/** 指定新会话 id（缺省由仓库 / 后端生成）。 */
	id?: string;
	/** 记录派生来源会话的 id（fork 时使用）。 */
	parentSessionId?: string;
}

/**
 * fork（派生新会话）的范围：branch——只复制从目标 entry 到根的一条分支
 * （entryId 缺省取 main 叶子；position 决定含不含该 entry 本身）；tree——复制
 * 整棵 entry 树与所有 lane。
 */
export type ForkOptions = { scope?: "branch"; entryId?: string; position?: "before" | "at" } | { scope: "tree" };

/**
 * 会话仓库：管理会话生命周期的最上层接口——create / open / list / delete /
 * fork。泛型允许后端特化元数据、创建选项与列表过滤选项。
 */
export interface SessionRepo<
	TMetadata extends SessionMetadata = SessionMetadata,
	TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
	TListOptions = void,
> {
	/** 新建会话并返回可写的 {@link Session}。 */
	create(options: TCreateOptions): Promise<Session<TMetadata>>;
	/** 打开会话以供写入，并获取后端的写者声明（writer claim）。 */
	open(metadata: TMetadata): Promise<Session<TMetadata>>;
	/** 列出会话元数据；不打开会话、不获取写者声明。 */
	list(options?: TListOptions): Promise<TMetadata[]>;
	/** 删除会话。 */
	delete(metadata: TMetadata): Promise<void>;
	/** 从源会话派生新会话（复制范围见 {@link ForkOptions}）。 */
	fork(source: TMetadata, options: ForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}

/** 会话层错误的机器可读分类。 */
export type SessionErrorCode =
	| "not_found" // 目标不存在（entry / lane / 会话等）
	| "already_exists" // id / lane / 会话已存在（重复创建）
	| "invalid_entry" // entry 违反树规约（seq 断档、父链断裂、重复 id 等）
	| "invalid_payload" // 载荷非严格 JSON 可序列化（循环引用、非纯对象等）
	| "invalid_lane" // lane 不存在或非法
	| "invalid_query" // 查询参数非法（limit / cursor / 字段组合约束等）
	| "invalid_fork_target" // fork 目标非法（如不是 message entry）
	| "storage"; // 底层存储错误（原始错误经 cause 透传）

/** 会话层统一错误：code 供程序分支判断，message 供人阅读，可携带底层 cause。 */
export class SessionError extends Error {
	readonly code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}
