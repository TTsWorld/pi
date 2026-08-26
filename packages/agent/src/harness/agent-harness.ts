/**
 * @file agent-harness.ts —— AgentHarness：有状态 LLM Agent 的「耐久宿主」（durable host）。
 *
 * @description
 * 相对进程内的 {@link Agent} 类（单对话、状态在内存、随进程消亡），本文件定义的
 * {@link AgentHarness} 是一个可崩溃恢复的运行时：把对话组织为不可变 Entry 树
 * （`./session/`），在树上管理多个 lane（泳道，指向树的命名游标），并以操作状态机
 * （run / compaction / navigation 三类操作）驱动模型与工具执行。主要职责：
 * - 组装耐久会话：Entry 树 + 寄存器（facts / lane 状态 / 操作状态）+ Usage 台账，
 *   即 docs/harness.md 的「三存储」模型；
 * - 驱动操作状态机与崩溃恢复：每个操作以 `op.state` 寄存器作为「耐久程序计数器」，
 *   进程在任意两次原子提交之间崩溃都能恢复，且不重复已结算的外部效果；
 * - 维护 harness 级注册表：工具（含 replay 重放策略）、技能（Skill）、提示模板（PromptTemplate）；
 * - 暴露两个扩展面：hooks（before_run / before_tool 等 11 种可改写执行的拦截点）
 *   与 events（只读的被动事件）；
 * - 记录 Usage（token / 成本台账）并接入遥测（TelemetryContext）。
 *
 * 本文件还定义了 lane 的公共接口 {@link AgentLane}（harness 自身实现它，扮演保留的
 * "main" lane）、各操作的返回类型（RunResult / CompactionResult / NavigationResult 等）
 * 以及预期错误家族（TaggedError：LaneBusy / UnknownSkill / Closed 等）。
 *
 * ⚠️ 实现现状：当前版本是接口脚手架——执行类方法（prompt / compact / navigateTree /
 * resume / 队列 / watch / 多 lane 管理等）多数经 `unavailable()` 返回
 * {@link HarnessNotImplemented}；完整实现遵循 docs/harness.md 的
 * 「三存储 + 操作状态机」规范逐步落地。注释如实标注各方法的实现状态。
 */
import type {
	Api,
	AssistantMessage,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	Usage,
} from "@earendil-works/pi-ai";
import type { AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import type { CompactionSettings } from "./compaction/compaction.ts";
import { type Result as ResultValue, TaggedError } from "./result.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	Entry,
	JsonValue,
	ProvisionedEntry,
	Session,
	SessionTree,
} from "./session/index.ts";
import type { TelemetryContext } from "./telemetry.ts";
import type { AgentHarnessResources, PromptTemplate, Skill } from "./types.ts";

// ========== 预期错误（TaggedError 家族） ==========
// 预期中的「受理/业务拒绝」都用 TaggedError 表达，经 Result.err 返回给调用方；
// 与之相对，HarnessFault / HarnessClosed 这类非预期故障直接让 Promise reject。

/** lane 上已存在进行中的操作，新操作的受理被拒绝（一个 lane 至多一个操作）。 */
export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	/** 占用 lane 的那个操作的 id。 */
	operationId: string;
	/** 占用 lane 的那个操作的种类。 */
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
/** 受理前身份解析失败：模型/提供方或某个 active tool 名称无法解析为已注册身份。 */
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	/** 无法解析的工具名列表。 */
	tools: string[];
	/** 无法解析的模型/提供方身份列表。 */
	models: string[];
	message: string;
}> {}
/** lane 上没有进行中的 run（例如向 steer / followUp 队列入队时）。 */
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
/** lane 上没有任何进行中的操作（例如 abort 时）。 */
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
/** 没有挂起（suspended）的操作可供 resume。 */
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
/** 规范化后的消息为空或非法：本次受理将写入零个 entry，因此被拒绝。 */
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
/** 显式调用的技能名不在注册表中。 */
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
/** 显式调用的提示模板名不在注册表中。 */
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
/** 导航的目标 entryId 不存在。 */
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
/** 取消队列项时给定的 entryId 既不在待处理队列中，也未被物化。 */
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
/** createLane 的名称已被占用；lane 永不删除或改名，名称是永久的应用侧键。 */
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
/** lane 名称非法（格式或保留名冲突等），reason 说明原因。 */
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
/** lane 所在分支上没有可压缩的内容。 */
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
/** harness 已 close，所有后续调用被拒绝。 */
export class Closed extends TaggedError("Closed")<{ message: string }> {}

/**
 * harness 内部的非预期故障（存储错误、不变量被破坏等）。
 * 它不是上面 TaggedError 预期错误联合的成员：直接让 Promise reject，而非放进 Result.err。
 */
export class HarnessFault extends Error {
	/** 底层异常，用于诊断。 */
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

/** 操作已被受理、但尚未完成时 harness 被 close——close 对进行中的操作相当于一次「受控崩溃」。 */
export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

/**
 * 脚手架标记错误：该能力尚未按 docs/harness.md 的规范实现。
 * operation 记录未实现的方法/操作名（如 "prompt"、"create.restore"）。
 */
export class HarnessNotImplemented extends Error {
	/** 未实现的方法/操作名。 */
	readonly operation: string;

	constructor(operation: string) {
		super(`AgentHarness.${operation} is not implemented yet`);
		this.name = "HarnessNotImplemented";
		this.operation = operation;
	}
}

/** 操作失败终态里携带的错误负载：稳定的机器可读 code + 人类可读 message。 */
export interface OperationError {
	code: string;
	message: string;
}

/**
 * run 操作的终态（受理成功后 Result.ok 携带的结局，而非拒绝）：
 * - completed：模型自然停止（本轮无工具调用），最终 assistant 消息已落盘；
 * - aborted：被 abort() 中止；
 * - failed：操作内部失败（error 见 {@link OperationError}），最终消息可选存在；
 * - suspended：因 deferred（延迟/异步句柄，见 DeferredHandle）挂起，稍后可 resume()。
 */
export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle };

/**
 * compaction（上下文压缩）操作的终态：
 * - completed：摘要已生成并落盘为一条 CompactionEntry；
 * - declined：before_compaction hook 拒绝执行；
 * - aborted：被中止；
 * - failed：生成失败。
 */
export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError };

/**
 * navigateTree（分支导航）操作的终态：
 * - completed：leaf 已跳转到目标 entry（目标可为 null = 根），summarize 开启时
 *   可附带为被离开分支生成的 BranchSummaryEntry；
 * - declined / aborted：before_navigation hook 拒绝或被中止；
 * - failed：失败。
 */
export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError };

// ========== 各操作的「预期拒绝」联合 ==========
// 均为受理前（pre-acceptance）的拒绝原因；受理之后的成败结局（含 failed / aborted /
// suspended）一律通过 Result.ok 的 outcome 返回，见 docs/harness.md §5.1。
/** run 类入口（prompt / skill / promptFromTemplate）可能的受理拒绝。 */
export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
/** compact 可能的受理拒绝。 */
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
/** navigateTree 可能的受理拒绝。 */
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
/** resume 可能的受理拒绝。 */
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
/** steer / followUp 入队可能的拒绝（nextRun 不要求有活动 run）。 */
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
/** cancelQueued 可能的拒绝。 */
export type CancelQueuedRejected = UnknownQueueItem | Closed;
/** abort 可能的拒绝。 */
export type AbortRejected = NoActiveOperation | Closed;

// ========== 各操作的返回类型 ==========
// 说明：runId 即操作的耐久 operationId，沿用 runId 这个公共名是为了兼容。
/** run 的返回：成功值为 { runId } 与终态的组合（见 {@link RunOutcome}）。 */
export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
/** compaction 的返回（见 {@link CompactionOutcome}）。 */
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
/** navigation 的返回（见 {@link NavigationOutcome}）。 */
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
/** steer / followUp / nextRun 入队的返回：成功值为分配（预留）的 entryId——此刻消息内容仍在 pending 寄存器中，尚未成为树上的 entry。 */
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
/** cancelQueued 的返回：已取消 / 早已被消费 / 早已被清理（后两者幂等地视为成功）。 */
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
/** recordUsage 的返回：成功时无值。 */
export type RecordUsageResult = ResultValue<void, Closed>;
/** abort 的返回：操作 runId + 被排干（drain）出来的 steer / followUp 消息。 */
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

/**
 * resume 的结果：先指明恢复的是哪一类操作（run / compaction / navigation）及其
 * runId，再携带对应的终态。
 */
export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
/** resume 的返回类型。 */
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
/** createLane 的返回：成功值即新 lane 的 {@link AgentLane} 视图。 */
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

/** navigateTree 的选项。 */
export interface NavigateOptions {
	/** 是否为被离开的分支生成分支摘要（BranchSummaryEntry）。 */
	summarize?: boolean;
	/** 传给摘要生成的自定义指令。 */
	customInstructions?: string;
	/** 写在目标 entry 上的标签（fact.label）。 */
	label?: string;
}

/**
 * 挂起操作的描述符。{@link AgentHarness.create} 恢复已有会话时，每个仍有
 * 未完成操作的 lane 会返回一个；应用据此决定是否调用 resume()。
 */
export interface SuspendedOperation {
	/** 所属 lane 名。 */
	lane: string;
	/** 操作种类。 */
	kind: "run" | "compaction" | "navigation";
	/** 操作 id（对外即 runId）。 */
	id: string;
	/** 操作开始时间（Unix ms）。 */
	startedAt: number;
	/** 挂起原因：crash = 进程崩溃遗留；deferred = 等待延迟句柄。 */
	reason: "crash" | "deferred";
	/** run 操作挂起时的原始 prompt（恢复时供展示/核对）。 */
	prompt?: AgentMessage[];
	/** deferred 挂起时正在等待的延迟句柄。 */
	deferred?: DeferredHandle;
	/** 中止流程进行中：已被排干的 steer / followUp 消息。 */
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	/** 身份解析失败时缺失的工具与模型列表（对应 MissingIdentities）。 */
	missing: { tools: string[]; models: string[] };
}

/** lane 的概要信息（lanes() / 会话快照使用）。 */
export interface LaneInfo {
	/** lane 名；每个会话都有的保留 lane 叫 "main"。 */
	name: string;
	/** lane 当前 leaf 的 entry id；null 表示停在根上。 */
	leafId: string | null;
	/** 当前操作（一个 lane 至多一个）及其状态；null = 空闲。 */
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

/** 输入队列中的一项：入队时内容先存 pending 寄存器，被消费时才物化为树上的 entry。 */
export interface QueuedItem {
	/** 分配（预留）的 entry id。 */
	entryId: string;
	/** 队列消息内容。 */
	message: AgentMessage;
}

/** lane 级快照（watch() 订阅时的初始数据）。 */
export interface LaneSnapshot {
	/** lane 名。 */
	lane: string;
	/** 从 leaf 回溯到根（或最近一次 compaction）的转录。 */
	transcript: Entry[];
	/** 当前 leaf 的 entry id；null = 在根上。 */
	leafId: string | null;
	/** 当前操作信息，结构同 {@link LaneInfo.operation}。 */
	operation: LaneInfo["operation"];
	/** 三条输入队列：steer（转向当前轮）、followUp（追加到本轮之后）、nextRun（下个 run 才投入）。 */
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	/** 尚未落到树上的 pending 写入（provisioned entry，多为 deferred 场景预留）。 */
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	/** lane 是否已进入 faulted（故障）状态。 */
	faulted: boolean;
}

/** 会话级快照（watchSession() 订阅时的初始数据）：全部 lane + 会话故障标志。 */
export interface SessionSnapshot {
	/** 每个 lane 的概要；有挂起操作时附带 {@link SuspendedOperation}。 */
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	/** 会话是否已故障（faulted）。 */
	faulted: boolean;
}

/**
 * manual 驱动模式下解释器的「下一个动作」描述（peekAction 只读、executeAction 执行
 * 一步后返回）。kind 覆盖操作状态机的每一步副作用：追加 entry / 记录、移动 lane
 * leaf、写 fact、尝试结束 run、终结操作、提交 follow-up、消费队列项、应用 pending
 * 写入、流式生成 assistant 回复、执行工具、拉取/取消 deferred、执行 hook、sleep 等。
 * 用于测试以受控顺序驱动并发竞态。
 */
export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "append_record"; recordType: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "set_fact"; fact: "name" | "label" }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred" | "cancel_deferred"; provider: string; id: string }
	| { kind: "hook"; name: HookName }
	| { kind: "sleep"; delayMs: number };

/** 全部 11 种 hook（可改写执行的拦截点）名称；各 hook 的时机与载荷见 docs/harness.md §5.6。 */
export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

/**
 * hook 注册接口：按名注册一个处理器，返回取消注册的函数。
 * hook 能拦截并改写执行，区别于只读的 {@link Events}。
 */
export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

/** 被动事件订阅接口：只报告活动与耐久变更，不能改写执行。 */
export interface Events {
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
}

/**
 * hooks / events 的占位注册表：真正的注册表尚未实现，任何 on() 调用都会抛错——
 * harness 已 close 时抛 {@link HarnessClosed}，否则抛 {@link HarnessNotImplemented}。
 */
class UnavailableRegistry implements Hooks, Events {
	/** 用于构造 HarnessNotImplemented 的操作名（如 "hooks.on"）。 */
	private readonly operation: string;
	/** 关闭判定回调，与 harness 的 closed 标志共享。 */
	private readonly isClosed: () => boolean;

	constructor(operation: string, isClosed: () => boolean) {
		this.operation = operation;
		this.isClosed = isClosed;
	}

	/** 注册即抛错（见类注释）：close 优先于未实现。 */
	on(
		_name: HookName | string,
		_handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		throw this.isClosed() ? new HarnessClosed() : new HarnessNotImplemented(this.operation);
	}
}

/** harness 工具：在 AgentTool 之上附加崩溃重放策略——never = 不得重放（有副作用的工具），safe = 可用持久化参数安全重放。 */
export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
/** harness 资源注册表：技能（Skill）+ 提示模板（PromptTemplate）。 */
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
/** 提供方请求的流式选项（透传 pi-ai 的 SimpleStreamOptions）。 */
export type StreamOptions = SimpleStreamOptions;
/** 流式选项的部分更新补丁。 */
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
/** entry 投影器：把自定义 entry 映射为进入模型上下文的 AgentMessage；未投影的自定义 entry 永不进入上下文。 */
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

/** {@link AgentHarness} 的构造选项。 */
export interface AgentHarnessOptions {
	/** 耐久会话：三存储（entry 树 + 寄存器 + usage 台账）的载体。 */
	session: Session;
	/** 可用模型注册表（受理前的身份解析要用）。 */
	models: Models;
	/** 初始模型。 */
	model: Model<Api>;
	/** 初始思考级别；缺省 "off"。 */
	thinkingLevel?: ThinkingLevel;
	/** 初始启用的工具名子集；缺省时启用全部 tools。 */
	activeToolNames?: string[];
	/** 工具集（含可选的 replay 策略）。 */
	tools?: HarnessTool[];
	/** 工具执行上下文：对象，或延迟求值的工厂函数。 */
	toolContext?: object | (() => object | Promise<object>);
	/** 系统提示：字符串，或延迟求值的工厂函数。 */
	systemPrompt?: string | (() => string | Promise<string>);
	/** 技能与提示模板注册表。 */
	resources?: Resources;
	/** 流式请求选项。 */
	streamOptions?: StreamOptions;
	/** 请求重试策略；缺省不重试。 */
	retry?: RetryPolicy;
	/** compaction 设置；缺省启用（预留 16384 token、保留最近 20000 token）。 */
	compaction?: CompactionSettings;
	/** steer 队列消费模式；缺省 "one-at-a-time"。 */
	steeringMode?: QueueMode;
	/** followUp 队列消费模式；缺省 "one-at-a-time"。 */
	followUpMode?: QueueMode;
	/** 工具执行方式：顺序或并行。 */
	toolExecution?: "sequential" | "parallel";
	/** 驱动方式：automatic（自动执行到底）或 manual（单步驱动，供测试）。 */
	drive?: "automatic" | "manual";
	/** AgentMessage → 提供方消息的最终转换（在 transform_context hook 之后执行）。 */
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** 自定义 entry 类型 → 投影器 的映射表。 */
	entryProjectors?: Record<string, EntryProjector>;
	/** 遥测上下文。 */
	context?: TelemetryContext;
}

/** watch()/watchSession() 返回的订阅句柄：snapshot 为订阅时刻的快照，start 之后再接收增量事件。 */
export interface WatchHandle<TSnapshot> {
	/** 订阅时的初始快照。 */
	snapshot: TSnapshot;
	/** 开始接收后续事件。 */
	start(listener: (event: unknown) => void): void;
	/** 停止监听。 */
	unsubscribe(): void;
}

/**
 * lane（泳道）公共接口：进入 Entry 树的一个命名游标及其全部操作入口。
 * 每个 lane 独立持有自己的 leaf、模型配置、三条输入队列（steer / followUp /
 * nextRun）和至多一个操作；多个 lane 可共享同一棵历史树并行工作。
 * {@link AgentHarness} 自身实现该接口，扮演保留的 "main" lane。
 */
export interface AgentLane {
	/** lane 名。 */
	readonly name: string;
	/** 当前 leaf 的 entry id；null = 停在根上。 */
	getLeafId(): Promise<string | null>;
	/** 以文本（可带图片）发起一次 run。 */
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	/** 以一条或多条已构造的消息发起一次 run。 */
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	/** 按名调用技能（展开为 prompt，可附加补充指令）发起 run。 */
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	/** 按名调用提示模板（用 args 填充占位符）发起 run。 */
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	/** 触发 compaction：把当前分支的上下文压缩为一条摘要 entry。 */
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	/** 把 leaf 导航到目标 entry（null = 根），可选生成分支摘要。 */
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	/** 恢复挂起的操作（崩溃或 deferred 之后）。 */
	resume(): Promise<ResumeResult>;
	/** 中止当前操作，返回被排干（drain）的 steer / followUp 消息。 */
	abort(): Promise<AbortResult>;
	/** 向进行中的 run 注入「转向」消息（力争影响当前轮）。 */
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	/** 向进行中的 run 追加消息（在当前轮工具结果之后、下一轮之前生效）。 */
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	/** 排队一条消息，待 lane 空闲后的下一个 run 开始时投入。 */
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	/** 取消一条已入队的消息。 */
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	/** 向 Usage 台账追加一条记录（应用侧补偿/校准成本时使用）。 */
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	/** 等待 lane 空闲（无进行中的操作、无未决的 lane 任务）。 */
	waitForIdle(): Promise<void>;
	/** 等待空闲后持有 lane 准入保留地执行回调（回调内不得再调用本 lane 的变更方法，否则自锁）。 */
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	/** （manual 驱动模式）窥探解释器的下一个动作，但不执行。 */
	peekAction(): Promise<ActionInfo | undefined>;
	/** （manual 驱动模式）执行一个动作并返回其描述。 */
	executeAction(): Promise<ActionInfo | undefined>;
	/** （manual 驱动模式）连续执行动作直到操作结束。 */
	runToCompletion(): Promise<void>;
	/** 当前模型。 */
	getModel(): Promise<Model<Api>>;
	/** 替换当前模型。 */
	setModel(model: Model<Api>): Promise<void>;
	/** 当前思考级别。 */
	getThinkingLevel(): Promise<ThinkingLevel>;
	/** 设置思考级别。 */
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	/** 当前启用的工具名列表。 */
	getActiveTools(): Promise<string[]>;
	/** 设置启用的工具名列表。 */
	setActiveTools(names: string[]): Promise<void>;
	/** 该 lane 的树视图：读写 entry 与 facts（append 词汇保留给树写入）。 */
	readonly session: SessionTree;
	/** 订阅该 lane 的快照与增量事件。 */
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}

/**
 * 耐久 Agent 宿主（harness）：组装耐久会话与 lane，实现 {@link AgentLane}，
 * 自身即扮演每个会话都保留的 "main" lane。
 *
 * 与进程内单对话的 {@link Agent} 不同，harness 面向崩溃恢复：操作（run /
 * compaction / navigation）由操作状态机驱动，每步之后的完整状态都会写入耐久
 * 寄存器（op.state），进程在任意两次原子提交之间崩溃都能恢复，且不重复已
 * 结算的外部效果（详见 docs/harness.md）。
 *
 * ⚠️ 实现现状：本类目前是接口脚手架——配置类 getter/setter、getLeafId 与
 * close 已可用（仅内存态，尚未落盘），但执行类方法（prompt / compact /
 * navigateTree / resume / 队列 / watch / 多 lane 管理等）统一经
 * {@link AgentHarness.unavailable} 返回 {@link HarnessNotImplemented}。
 */
export class AgentHarness implements AgentLane {
	/** 本 harness 扮演的 lane 名：每个会话都有的保留 "main"。 */
	readonly name = "main";
	/** 暴露给调用方的树视图（与 durableSession 是同一对象）。 */
	readonly session: SessionTree;
	/** hook 注册面（当前为占位实现，见 UnavailableRegistry）。 */
	readonly hooks: Hooks;
	/** 被动事件订阅面（当前为占位实现）。 */
	readonly events: Events;
	/** 底层耐久会话。 */
	private readonly durableSession: Session;
	// ===== harness 级配置的可变内存副本 =====
	// 按规范这些配置最终应写入 lane.config 等耐久寄存器；当前仅保存在内存中。
	/** 当前模型。 */
	private model: Model<Api>;
	/** 当前思考级别。 */
	private thinkingLevel: ThinkingLevel;
	/** 当前启用的工具名子集。 */
	private activeToolNames: string[];
	/** 已注册的全部工具。 */
	private tools: HarnessTool[];
	/** 技能与提示模板注册表。 */
	private resources: Resources;
	/** 流式请求选项。 */
	private streamOptions: StreamOptions;
	/** 请求重试策略。 */
	private retryPolicy: RetryPolicy;
	/** compaction 设置。 */
	private compactionSettings: CompactionSettings;
	/** steer 队列消费模式。 */
	private steeringMode: QueueMode;
	/** followUp 队列消费模式。 */
	private followUpMode: QueueMode;
	/** close 之后所有调用以 HarnessClosed 拒绝。 */
	private closed = false;

	/**
	 * 私有构造：请使用 {@link AgentHarness.create}（它还负责已有会话的恢复检查）。
	 * 这里只做选项的防御性拷贝与默认值填充，不产生任何外部效果。
	 */
	private constructor(options: AgentHarnessOptions) {
		// ========== 耐久会话与扩展面 ==========
		// hooks / events 先挂占位注册表：真正的注册表机制尚未实现。
		this.durableSession = options.session;
		this.session = options.session;
		this.hooks = new UnavailableRegistry("hooks.on", () => this.closed);
		this.events = new UnavailableRegistry("events.on", () => this.closed);
		// ========== 模型 / 思考级别 / 工具 ==========
		// 未显式指定 activeToolNames 时，默认启用全部工具。
		this.model = options.model;
		this.thinkingLevel = options.thinkingLevel ?? "off";
		this.activeToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		// ========== 资源注册表（技能 / 模板） ==========
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		// ========== 运行时配置及默认值 ==========
		// 重试默认关闭；compaction 默认启用（预留 16384 / 保留最近 20000 token）；
		// 两条输入队列默认一次消费一条。
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
	}

	/**
	 * 创建 harness 并接上既有会话。
	 *
	 * 按规范：应初始化未配置的 main、恢复每个 lane，但不启动任何提供方 / 工具 /
	 * hook / 定时器效果；每个仍有未完成操作的 lane 返回一个挂起描述符，由应用
	 * 决定是否 resume。
	 *
	 * 当前实现：只探测会话中是否已有任何记录——全新会话直接构造 harness、无挂起
	 * 操作；已有记录的恢复路径尚未实现。
	 *
	 * @returns harness 实例 + 各 lane 的挂起操作描述符（当前恒为空数组）
	 * @throws 会话已有记录时抛 {@link HarnessNotImplemented}（"create.restore"）
	 */
	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		// 已有任何记录即视为「既有会话」：恢复路径未实现，宁可明确失败也不静默重建。
		const [record] = await options.session.findRecords({ limit: 1 });
		if (record !== undefined) throw new HarnessNotImplemented("create.restore");
		// 全新会话：没有任何挂起操作。
		return { harness: new AgentHarness(options), suspended: [] };
	}

	/**
	 * 脚手架统一拒绝器：所有未实现的执行方法经由此返回 rejected Promise——
	 * harness 已 close 时抛 {@link HarnessClosed}，否则抛 {@link HarnessNotImplemented}。
	 */
	private unavailable<T>(operation: string): Promise<T> {
		return Promise.reject(this.closed ? new HarnessClosed() : new HarnessNotImplemented(operation));
	}

	/** 当前 leaf 的 entry id；null = 在根上。已实现：直接委托耐久会话。 */
	async getLeafId(): Promise<string | null> {
		return this.durableSession.getLeafId();
	}

	/** 以文本（可带图片）发起一次 run。脚手架：返回 {@link HarnessNotImplemented}。 */
	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	/** 以一条或多条已构造消息发起一次 run。脚手架：返回 {@link HarnessNotImplemented}。 */
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(_input: string | AgentMessage | AgentMessage[], _images?: ImageContent[]): Promise<RunResult> {
		return this.unavailable("prompt");
	}
	/** 按名调用技能发起 run。脚手架：返回 {@link HarnessNotImplemented}。 */
	async skill(_name: string, _additionalInstructions?: string): Promise<RunResult> {
		return this.unavailable("skill");
	}
	/** 按名调用提示模板发起 run。脚手架：返回 {@link HarnessNotImplemented}。 */
	async promptFromTemplate(_name: string, _args?: string[]): Promise<RunResult> {
		return this.unavailable("promptFromTemplate");
	}
	/** 触发 compaction。脚手架：返回 {@link HarnessNotImplemented}。 */
	async compact(_options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.unavailable("compact");
	}
	/** 把 leaf 导航到目标 entry。脚手架：返回 {@link HarnessNotImplemented}。 */
	async navigateTree(_targetId: string | null, _options?: NavigateOptions): Promise<NavigationResult> {
		return this.unavailable("navigateTree");
	}
	/** 恢复挂起的操作。脚手架：返回 {@link HarnessNotImplemented}。 */
	async resume(): Promise<ResumeResult> {
		return this.unavailable("resume");
	}
	/** 中止当前操作。脚手架：返回 {@link HarnessNotImplemented}。 */
	async abort(): Promise<AbortResult> {
		return this.unavailable("abort");
	}
	/** 以文本（可带图片）向进行中的 run 注入转向消息。脚手架：返回 {@link HarnessNotImplemented}。 */
	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	/** 以已构造消息向进行中的 run 注入转向消息。脚手架：返回 {@link HarnessNotImplemented}。 */
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("steer");
	}
	/** 以文本（可带图片）追加消息。脚手架：返回 {@link HarnessNotImplemented}。 */
	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	/** 以已构造消息追加消息。脚手架：返回 {@link HarnessNotImplemented}。 */
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("followUp");
	}
	/** 排队一条消息到下一个 run。脚手架：返回 {@link HarnessNotImplemented}。 */
	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	/** 以已构造消息排队到下一个 run。脚手架：返回 {@link HarnessNotImplemented}。 */
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(_input: string | AgentMessage, _images?: ImageContent[]): Promise<QueueResult> {
		return this.unavailable("nextRun");
	}
	/** 取消一条已入队消息。脚手架：返回 {@link HarnessNotImplemented}。 */
	async cancelQueued(_entryId: string): Promise<CancelQueuedResult> {
		return this.unavailable("cancelQueued");
	}
	/** 追加一条 Usage 台账记录。脚手架：返回 {@link HarnessNotImplemented}。 */
	async recordUsage(_usage: Usage, _options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.unavailable("recordUsage");
	}
	/** 等待 lane 空闲。脚手架：返回 {@link HarnessNotImplemented}。 */
	async waitForIdle(): Promise<void> {
		return this.unavailable("waitForIdle");
	}
	/** 空闲时执行回调。脚手架：返回 {@link HarnessNotImplemented}。 */
	async runWhenIdle(_callback: () => void | Promise<void>): Promise<void> {
		return this.unavailable("runWhenIdle");
	}
	/** （manual 模式）窥探下一个动作。脚手架：返回 {@link HarnessNotImplemented}。 */
	async peekAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("peekAction");
	}
	/** （manual 模式）执行一个动作。脚手架：返回 {@link HarnessNotImplemented}。 */
	async executeAction(): Promise<ActionInfo | undefined> {
		return this.unavailable("executeAction");
	}
	/** （manual 模式）执行到操作结束。脚手架：返回 {@link HarnessNotImplemented}。 */
	async runToCompletion(): Promise<void> {
		return this.unavailable("runToCompletion");
	}
	/** 当前模型。已实现：读取内存副本。 */
	async getModel(): Promise<Model<Api>> {
		return this.model;
	}
	/** 替换当前模型。已实现：仅更新内存副本（未落盘到 lane.config 寄存器）。 */
	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
	}
	/** 当前思考级别。已实现：读取内存副本。 */
	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.thinkingLevel;
	}
	/** 设置思考级别。已实现：仅更新内存副本。 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		this.thinkingLevel = level;
	}
	/** 当前启用的工具名列表。已实现：返回副本。 */
	async getActiveTools(): Promise<string[]> {
		return [...this.activeToolNames];
	}
	/** 设置启用的工具名列表。已实现：仅更新内存副本。 */
	async setActiveTools(names: string[]): Promise<void> {
		this.activeToolNames = [...names];
	}
	/** 订阅 lane 快照与增量事件。脚手架：返回 {@link HarnessNotImplemented}。 */
	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.unavailable("watch");
	}

	/** 按名查找 lane（只查找，从不创建）。脚手架：返回 {@link HarnessNotImplemented}。 */
	async lane(_name: string): Promise<AgentLane | undefined> {
		return this.unavailable("lane");
	}
	/** 在指定 entry（null = 根）上创建新 lane。脚手架：返回 {@link HarnessNotImplemented}。 */
	async createLane(_name: string, _at: string | null): Promise<CreateLaneResult> {
		return this.unavailable("createLane");
	}
	/** 列出全部 lane（总是包含 "main"）。脚手架：返回 {@link HarnessNotImplemented}。 */
	async lanes(): Promise<LaneInfo[]> {
		return this.unavailable("lanes");
	}
	/** 已注册的全部工具。已实现：返回副本。 */
	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}
	/**
	 * 替换工具集。已实现：仅更新内存副本。
	 * 未显式给 activeNames 时，默认启用全部新工具。
	 */
	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.tools = [...tools];
		this.activeToolNames = [...(activeNames ?? tools.map((tool) => tool.name))];
	}
	/** 技能 / 模板注册表。已实现：返回逐层拷贝。 */
	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}
	/** 替换资源注册表。已实现：仅更新内存副本。 */
	async setResources(resources: Resources): Promise<void> {
		this.resources = {
			skills: resources.skills ? [...resources.skills] : undefined,
			promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
		};
	}
	/** 流式请求选项。已实现：返回副本。 */
	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}
	/** 替换流式请求选项。已实现：仅更新内存副本。 */
	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.streamOptions = { ...options };
	}
	/** 重试策略。已实现：返回副本。 */
	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}
	/** 替换重试策略。已实现：仅更新内存副本。 */
	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.retryPolicy = { ...policy };
	}
	/** compaction 设置。已实现：返回副本。 */
	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}
	/** 替换 compaction 设置。已实现：仅更新内存副本。 */
	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.compactionSettings = { ...settings };
	}
	/** steer 队列消费模式。已实现：读取内存副本。 */
	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}
	/** 设置 steer 队列消费模式。已实现：仅更新内存副本。 */
	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.steeringMode = mode;
	}
	/** followUp 队列消费模式。已实现：读取内存副本。 */
	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}
	/** 设置 followUp 队列消费模式。已实现：仅更新内存副本。 */
	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.followUpMode = mode;
	}
	/** 订阅会话级快照（全部 lane）。脚手架：返回 {@link HarnessNotImplemented}。 */
	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		return this.unavailable("watchSession");
	}
	/**
	 * 关闭 harness：此后所有调用以 {@link HarnessClosed} 拒绝。
	 * 按规范 close 相当于一次「受控崩溃」——进行中的操作应按崩溃位置策略收场；
	 * 该部分尚未实现，当前仅设置关闭标志。
	 */
	async close(): Promise<void> {
		this.closed = true;
	}
}
