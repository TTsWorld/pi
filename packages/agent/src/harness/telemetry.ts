/**
 * @file Agent 遥测体系：定义 AI 请求与 Harness 执行两套 telemetry schema，以及类型安全的 span 启动工具。
 *
 * @description 整体链路：schema（本文件）→ 注册到 {@link TelemetryContext} 后获得类型化 span 能力 →
 * 通过 `startAiSpan` / `startHarnessSpan` 开启 span；schema 中的 description 会被
 * scripts/generate-telemetry-docs.ts 抓取，生成到 docs/telemetry-schema.md（该文档为生成物，勿手改）。
 *
 * 两套 schema 的分工：
 * - `AI_TELEMETRY_SCHEMA`：面向 AI provider 调用（`pi.ai.request`），记录请求参数与响应结果
 *   （模型、token 用量、成本、流式指标、错误类别等）。
 * - `HARNESS_TELEMETRY_SCHEMA`：面向 harness 执行层（run / compaction / navigation 三个入口，
 *   及其下的 checkpoint / turn / step / tool / hook / sleep / event_handler / session.write），
 *   刻画一次被准入（admitted）的操作从发起、执行到落盘的全过程。
 *
 * schema 通用约定：`startAttributes` 在 span 开始时提供（`required` 标记是否必填）；
 * `endAttributes` 全部可选，在 span 结束时作为完成信息补充（completion enrichment）；
 * `status.default` 为默认状态，`status.errorWhen` 描述何时记为 error；
 * `cardinality`（high/low）提示属性取值基数，供遥测后端做索引与采样参考。
 */
import type {
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	TelemetryContext,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";

// 将 pi-telemetry 包的公共遥测类型统一 re-export，作为本包其余模块的类型出口。
export type {
	AttributeValue,
	ExactTelemetryAttributes,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryAttributeDefinition,
	TelemetryAttributeMetadata,
	TelemetryAttributeType,
	TelemetryContext,
	TelemetryEventAttributeDefinition,
	TelemetryEventDefinition,
	TelemetryParentDefinition,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
	TelemetrySpanDefinition,
	TelemetryStartAttributeDefinition,
	TypedSpanStarter,
} from "@earendil-works/pi-telemetry";

/**
 * AI 请求遥测 schema：仅包含 `pi.ai.request` 一个 span。
 *
 * `pi.ai.request` 记录对 AI provider 的一次逻辑请求：
 * - 何时发出：每次向 provider 发起操作时开启，操作终局（正常完成、出错或被中止）时结束；
 *   一次逻辑请求可能对应多次底层 HTTP 调用（如内部重试）。
 * - 记录什么：开始属性描述「请求了什么」（操作类型 / provider / 模型 / API / 是否流式 / 是否延迟执行），
 *   结束属性描述「实际得到了什么」（真实响应模型、停止原因、HTTP 状态码、token 用量与成本、
 *   流式首包耗时与 chunk 数、错误类别）。
 * - 父 span 不限（`kind: "any"`）：可作为根 span，也可挂在任意调用方（通常是 harness 的 turn/step）之下。
 */
export const AI_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		// 对 AI provider 的一次逻辑请求；状态：默认 ok，操作抛出异常或返回错误结果时记为 error
		"pi.ai.request": {
			description: "One logical request to an AI provider",
			// 父 span 约束：任意（可作为根 span，也可挂在任何调用方 span 之下）
			parents: { kind: "any" },
			startAttributes: {
				// 逻辑 provider 操作类型：stream=流式生成 / fetch_deferred=取回延迟执行结果 /
				// cancel_deferred=取消延迟执行 / generate_images=生成图像
				"pi.ai.operation": {
					type: "string",
					required: true,
					values: ["stream", "fetch_deferred", "cancel_deferred", "generate_images"],
					description: "Logical provider operation",
				},
				// 实际选中的 provider id
				"pi.ai.provider": {
					type: "string",
					required: true,
					description: "Selected provider id",
				},
				// 请求指定的模型 id（未经别名解析的原始 id）
				"pi.ai.model": {
					type: "string",
					required: true,
					description: "Requested model id",
				},
				// provider 的 API 形态 id（同一 provider 可暴露多种 API）
				"pi.ai.api": {
					type: "string",
					required: true,
					description: "Provider API id",
				},
				// 本次操作是否以流式（stream）方式返回
				"pi.ai.streaming": {
					type: "boolean",
					required: true,
					description: "Whether this operation returns a stream",
				},
				// 本次操作是否请求或参与延迟执行（deferred execution）
				"pi.ai.deferred": {
					type: "boolean",
					required: false,
					description: "Whether the operation requests or participates in deferred execution",
				},
			},
			// 以下结束属性全部可选，在请求终局时按实际情况补充
			endAttributes: {
				// 实际生成响应的模型 id（经别名/回退解析后，可能与请求模型不同）
				"pi.ai.response.model": { type: "string", description: "Concrete response model" },
				// provider 返回的响应 id（高基数）
				"pi.ai.response.id": {
					type: "string",
					cardinality: "high",
					description: "Provider response id",
				},
				// 归一化的终局停止原因：stop=正常结束 / length=达到长度上限 / tool_use=请求工具调用 /
				// error=出错 / aborted=被中止 / deferred=转入延迟执行
				"pi.ai.response.stop_reason": {
					type: "string",
					values: ["stop", "length", "tool_use", "error", "aborted", "deferred"],
					description: "Normalized terminal response reason",
				},
				// 最终的 HTTP 状态码
				"pi.ai.http.status_code": { type: "number", description: "Final HTTP status" },
				// provider 上报的输入 token 数
				"pi.ai.usage.input_tokens": { type: "number", description: "Reported input tokens" },
				// provider 上报的输出 token 数
				"pi.ai.usage.output_tokens": { type: "number", description: "Reported output tokens" },
				// provider 上报的缓存读取（cache read）token 数
				"pi.ai.usage.cache_read_tokens": { type: "number", description: "Reported cache-read tokens" },
				// provider 上报的缓存写入（cache write）token 数
				"pi.ai.usage.cache_write_tokens": {
					type: "number",
					description: "Reported cache-write tokens",
				},
				// provider 上报的推理（reasoning）token 数
				"pi.ai.usage.reasoning_tokens": { type: "number", description: "Reported reasoning tokens" },
				// provider 上报的总 token 数
				"pi.ai.usage.total_tokens": { type: "number", description: "Reported total tokens" },
				// provider 上报的总成本
				"pi.ai.usage.cost": { type: "number", description: "Reported total cost" },
				// 流式（stream）更新收到的 chunk 总数
				"pi.ai.stream.chunk_count": { type: "number", description: "Streamed update chunk count" },
				// 从发起到第一个更新 chunk 的耗时（毫秒），即首包延迟
				"pi.ai.stream.time_to_first_chunk_ms": {
					type: "number",
					description: "Elapsed milliseconds to first update chunk",
				},
				// provider 或传输层错误类别（低基数）
				"pi.ai.error.type": {
					type: "string",
					cardinality: "low",
					description: "Provider or transport error class",
				},
			},
			status: { default: "ok", errorWhen: "The operation throws or returns an error result" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

// ---- 由 AI_TELEMETRY_SCHEMA 静态推导的类型工具：用字面量类型锁定每个 span 的属性集 ----
/** AI schema 下所有 span 名的字面量联合类型。 */
export type AiSpanName = TelemetrySchemaSpanName<typeof AI_TELEMETRY_SCHEMA>;
/** 指定 span 的开始属性类型（按 schema 定义逐字段收窄）。 */
export type AiSpanStartAttributes<Name extends AiSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
/** 指定 span 的结束属性类型（全部可选的完成信息）。 */
export type AiSpanEndAttributes<Name extends AiSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof AI_TELEMETRY_SCHEMA,
	Name
>;
/** 指定 span 的开始 + 结束属性的合并类型。 */
export type AiSpanAttributes<Name extends AiSpanName> = AiSpanStartAttributes<Name> & AiSpanEndAttributes<Name>;
/** 指定 span 上可附加的事件名联合类型（当前 schema 未声明事件）。 */
export type AiSpanEventName<Name extends AiSpanName> = TelemetrySchemaSpanEventName<typeof AI_TELEMETRY_SCHEMA, Name>;
/** 指定 span 上某事件的属性类型。 */
export type AiSpanEventAttributes<
	Name extends AiSpanName,
	EventName extends AiSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof AI_TELEMETRY_SCHEMA, Name, EventName>;
/** 指定 span 的具体化 TelemetrySpan 类型（携带 schema 校验后的属性与方法）。 */
export type AiTelemetrySpan<Name extends AiSpanName> = SchemaTelemetrySpan<typeof AI_TELEMETRY_SCHEMA, Name>;
/** AI schema 下全部 span 的联合类型。 */
export type AiSpan = TelemetrySchemaSpanUnion<typeof AI_TELEMETRY_SCHEMA>;

/**
 * 以类型安全的方式启动一个 AI 请求 span（`pi.ai.request`）。
 *
 * 把泛型的 `telemetryContext.startSpan` 收窄为 schema 驱动的类型化封装：
 * 传入的 attributes 会被字面量类型精确校验（多写、少写或写错字段名都在编译期报错），
 * 回调拿到的是 {@link AiTelemetrySpan} 类型的 span；回调返回 Promise 时自动等待。
 *
 * @param telemetryContext 遥测上下文
 * @param name span 名（须属于 {@link AiSpanName}）
 * @param attributes 该 span 的开始属性，须精确满足 schema 定义
 * @param callback 在 span 生命周期内执行的回调，入参为类型化 span
 * @returns 回调返回的结果（Result）
 */
export function startAiSpan<Name extends AiSpanName, const Attributes extends AiSpanStartAttributes<Name>, Result>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<AiSpanStartAttributes<Name>, Attributes>,
	callback: (span: AiTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	// span 的实际形状由已注册的 schema 保证，这里只做静态类型断言
	return telemetryContext.startSpan({ name, attributes }, (span) => callback(span as AiTelemetrySpan<Name>));
}

/**
 * harness 支持的 hook 名单，作为 `pi.harness.hook` span 中 `pi.hook.name` 的合法取值。
 * 覆盖 run 生命周期（before_run / before_resume / before_run_end）、上下文变换
 * （transform_context）、AI 请求前后（before_request / before_payload / after_response）、
 * 工具前后（before_tool / after_tool）以及压缩 / 导航前（before_compaction / before_navigation）。
 */
const HOOK_NAMES = [
	"before_run",
	"before_resume",
	"before_run_end",
	"transform_context",
	"before_request",
	"before_payload",
	"after_response",
	"before_tool",
	"after_tool",
	"before_compaction",
	"before_navigation",
] as const;

/**
 * harness 对外投递的事件类型全集，作为 `pi.harness.event_handler` span 中
 * `pi.event.type` 的合法取值（低基数）。大致分组：
 * run 生命周期（run_start / run_resume / run_suspend / run_abort / run_end）、
 * 故障（fault / handler_error）、回合（turn_start / turn_end）、重试（retry_scheduled /
 * retry_start / retry_end）、消息流（message_start / message_update / message_end）、
 * 工具（tool_start / tool_update / tool_end）、会话写入与队列（entry_added / write_pending /
 * queue_update）、事实与配置（fact_update / config_update）、压缩（compaction_start /
 * compaction_end）、导航（navigation_start / navigation_end）、lane 创建（lane_created）、
 * 用量上报（usage）。
 */
const EVENT_TYPES = [
	"run_start",
	"run_resume",
	"run_suspend",
	"run_abort",
	"run_end",
	"fault",
	"handler_error",
	"turn_start",
	"turn_end",
	"retry_scheduled",
	"retry_start",
	"retry_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_start",
	"tool_update",
	"tool_end",
	"entry_added",
	"write_pending",
	"queue_update",
	"fact_update",
	"config_update",
	"compaction_start",
	"compaction_end",
	"navigation_start",
	"navigation_end",
	"lane_created",
	"usage",
] as const;

// 三个入口 span（run / compaction / navigation）共享的开始属性：
// 把遥测定位到具体的 session、lane 与持久化操作（durable operation）。
const operationStartAttributes = {
	// 会话 id（高基数）
	"pi.session.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Session id",
	},
	// lane 名（高基数）；lane 是 session 内的持久化并发/分支单元
	"pi.lane.name": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Lane name",
	},
	// 持久化操作 id（durable operation id，高基数），可用于跨进程恢复后关联同一操作
	"pi.operation.id": {
		type: "string",
		required: true,
		cardinality: "high",
		description: "Durable operation id",
	},
	// 本次调用是否为恢复既有持久化工作（如进程重启后 resume），而非全新操作
	"pi.operation.recovery": {
		type: "boolean",
		required: true,
		description: "Whether this invocation resumes durable work",
	},
} as const;

// 入口 span 共享的错误结束属性（可选，仅在操作失败时填充）
const operationErrorAttributes = {
	// 稳定的操作错误码（低基数）
	"pi.error.code": {
		type: "string",
		cardinality: "low",
		description: "Stable operation error code",
	},
	// 低基数的操作错误类别（低基数）
	"pi.error.type": {
		type: "string",
		cardinality: "low",
		description: "Low-cardinality operation error class",
	},
} as const;

/**
 * Harness 执行遥测 schema：定义 harness 层的一组 span，刻画一次被准入（admitted，
 * 即通过 harness 准入屏障）的操作从发起、执行到落盘的全过程。
 *
 * span 层级（由各 span 的 parents 约束）：
 * - 三个入口 span（run / compaction / navigation）：必须是根 span 或外部调用方提供的 span；
 * - run 之下挂 checkpoint（持久化检查点）与 turn（一次助手响应 + 工具批次）；
 * - step（一次可重试尝试）可挂在 turn / checkpoint / compaction / navigation 之下；
 * - tool（原始工具执行）挂在 turn / run 之下；sleep（重试等待）挂在 step / run 之下；
 * - hook / event_handler / session.write 的父 span 不限（kind: "any"）。
 *
 * schema 的 description 由 scripts/generate-telemetry-docs.ts 生成到 docs/telemetry-schema.md。
 */
export const HARNESS_TELEMETRY_SCHEMA = {
	version: 1,
	spans: {
		// 一次被准入的进程内 run 调用。何时发出：每次开始执行一个 run 操作
		// （含进程重启后的恢复调用）时开启，run 终局时结束。
		// 关键字段：outcome 记录终局（completed=完成 / aborted=被中止 / failed=失败 /
		// suspended=挂起，等待后续恢复）；失败时附带共享的 pi.error.* 错误属性。
		"pi.harness.run": {
			description: "One admitted in-process run invocation",
			// 父 span 约束：必须是根 span，或由外部调用方传入的 span
			parents: { kind: "root_or_external" },
			startAttributes: {
				// 展开共享的入口开始属性（session / lane / operation 定位与恢复标记）
				...operationStartAttributes,
				// 操作种类，此处恒为 "run"
				"pi.operation.kind": {
					type: "string",
					required: true,
					values: ["run"],
					description: "Run operation kind",
				},
			},
			endAttributes: {
				// 本次 run 调用的终局结果
				"pi.operation.outcome": {
					type: "string",
					values: ["completed", "aborted", "failed", "suspended"],
					description: "Run invocation outcome",
				},
				// 展开共享的错误结束属性（pi.error.code / pi.error.type）
				...operationErrorAttributes,
			},
			// 状态：默认 ok；run 失败或抛出异常时记为 error
			status: { default: "ok", errorWhen: "The run fails or throws" },
		},
		// 一次被准入的进程内手动压缩（compaction）调用。何时发出：用户或上层显式
		// 请求压缩会话历史时开启，压缩终局时结束。
		// 关键字段：outcome（completed=完成 / declined=被拒绝或无需压缩 / aborted=被中止 /
		// failed=失败）；失败时附带共享的 pi.error.* 错误属性。
		"pi.harness.compaction": {
			description: "One admitted in-process manual compaction invocation",
			// 父 span 约束：必须是根 span，或由外部调用方传入的 span
			parents: { kind: "root_or_external" },
			startAttributes: {
				// 展开共享的入口开始属性（session / lane / operation 定位与恢复标记）
				...operationStartAttributes,
				// 操作种类，此处恒为 "compaction"
				"pi.operation.kind": {
					type: "string",
					required: true,
					values: ["compaction"],
					description: "Compaction operation kind",
				},
			},
			endAttributes: {
				// 本次压缩调用的终局结果
				"pi.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Compaction invocation outcome",
				},
				// 展开共享的错误结束属性（pi.error.code / pi.error.type）
				...operationErrorAttributes,
			},
			// 状态：默认 ok；压缩失败或抛出异常时记为 error
			status: { default: "ok", errorWhen: "The compaction fails or throws" },
		},
		// 一次被准入的进程内导航（navigation，在 session 树中移动 lane）调用。
		// 何时发出：每次发起 lane 移动/导航请求时开启，导航终局时结束。
		// 关键字段：outcome（completed=完成 / declined=被拒绝 / aborted=被中止 / failed=失败）；
		// 失败时附带共享的 pi.error.* 错误属性。
		"pi.harness.navigation": {
			description: "One admitted in-process navigation invocation",
			// 父 span 约束：必须是根 span，或由外部调用方传入的 span
			parents: { kind: "root_or_external" },
			startAttributes: {
				// 展开共享的入口开始属性（session / lane / operation 定位与恢复标记）
				...operationStartAttributes,
				// 操作种类，此处恒为 "navigation"
				"pi.operation.kind": {
					type: "string",
					required: true,
					values: ["navigation"],
					description: "Navigation operation kind",
				},
			},
			endAttributes: {
				// 本次导航调用的终局结果
				"pi.operation.outcome": {
					type: "string",
					values: ["completed", "declined", "aborted", "failed"],
					description: "Navigation invocation outcome",
				},
				// 展开共享的错误结束属性（pi.error.code / pi.error.type）
				...operationErrorAttributes,
			},
			// 状态：默认 ok；导航失败或抛出异常时记为 error
			status: { default: "ok", errorWhen: "The navigation fails or throws" },
		},
		// 一次 run 内的检查点（checkpoint，把进度事务性地持久化到存储）。
		// 何时发出：run 执行到需要落盘的点时短暂开启，检查点工作完成后即结束。
		// 关键字段：kind 说明检查点用途（normal=常规进度落盘 / failure_drain=失败排水，
		// 即终局错误后把失败响应与收尾状态落盘 / abort_reconcile=中止对账，
		// 即 aborted 后的整理落盘）。无结束属性。
		"pi.harness.checkpoint": {
			description: "One run checkpoint",
			// 父 span 约束：只能挂在 pi.harness.run 之下
			parents: { kind: "spans", spans: ["pi.harness.run"] },
			startAttributes: {
				// lane 名（高基数）
				"pi.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				// 持久化操作 id（高基数）
				"pi.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				// 检查点用途：normal=常规 / failure_drain=失败排水 / abort_reconcile=中止对账
				"pi.checkpoint.kind": {
					type: "string",
					required: true,
					values: ["normal", "failure_drain", "abort_reconcile"],
					description: "Checkpoint purpose",
				},
			},
			// 检查点无结束属性
			endAttributes: {},
			// 状态：默认 ok；检查点工作抛出异常时记为 error
			status: { default: "ok", errorWhen: "Checkpoint work throws" },
		},
		// 一次回合（turn）：一条助手响应及其配套的工具批次（tool batch）。
		// 何时发出：run 内每一轮「模型响应 → 工具执行 → 结果回填」开始时开启，回合结束时结束。
		// 关键字段：pi.turn.id 是本次调用内局部（invocation-local）的 turn id。
		// 无结束属性。
		"pi.harness.turn": {
			description: "One assistant response and its tool batch",
			// 父 span 约束：只能挂在 pi.harness.run 之下
			parents: { kind: "spans", spans: ["pi.harness.run"] },
			startAttributes: {
				// lane 名（高基数）
				"pi.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				// 持久化操作 id（高基数）
				"pi.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				// 调用内局部的 turn id（高基数）
				"pi.turn.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Invocation-local turn id",
				},
			},
			// turn 无结束属性
			endAttributes: {},
			// 状态：默认 ok；turn 工作抛出异常时记为 error
			status: { default: "ok", errorWhen: "Turn work throws" },
		},
		// 一次可持久化重试的尝试（durable retry attempt）：step 是 harness 中可重试的最小工作单元。
		// 何时发出：每次执行（含重试）一个 step 时开启，本次尝试终局时结束。
		// 关键字段：step.kind（assistant=助手生成 / compaction=压缩生成 / branch_summary=分支摘要生成）、
		// step.attempt 从 1 计数的尝试序号、compaction.reason 仅压缩步骤携带
		// （manual=手动 / threshold=达到阈值 / overflow=上下文溢出触发）；
		// 结束属性 outcome 记录本次尝试结果（succeeded=成功 / retry=将重试 / failed=失败 /
		// aborted=被中止 / deferred=转入延迟执行 / overflow=上下文溢出）。
		"pi.harness.step": {
			description: "One durable retry attempt",
			// 父 span 约束：只能挂在 turn / checkpoint / compaction / navigation 四类 span 之下
			parents: {
				kind: "spans",
				spans: ["pi.harness.turn", "pi.harness.checkpoint", "pi.harness.compaction", "pi.harness.navigation"],
			},
			startAttributes: {
				// lane 名（高基数）
				"pi.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				// 持久化操作 id（高基数）
				"pi.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				// 可重试的步骤类型
				"pi.step.kind": {
					type: "string",
					required: true,
					values: ["assistant", "compaction", "branch_summary"],
					description: "Retryable step kind",
				},
				// 尝试序号（从 1 开始计数，跨进程恢复后继续累计）
				"pi.step.attempt": {
					type: "number",
					required: true,
					description: "One-based durable attempt number",
				},
				// 压缩触发原因（仅 step.kind 为 compaction 时携带）
				"pi.compaction.reason": {
					type: "string",
					required: false,
					values: ["manual", "threshold", "overflow"],
					description: "Compaction trigger",
				},
			},
			endAttributes: {
				// 本次尝试的终局结果
				"pi.step.outcome": {
					type: "string",
					values: ["succeeded", "retry", "failed", "aborted", "deferred", "overflow"],
					description: "Attempt outcome",
				},
			},
			// 状态：默认 ok；本次尝试将重试、失败或抛出异常时记为 error
			status: { default: "ok", errorWhen: "The attempt retries, fails, or throws" },
		},
		// 一次原始的 phase-2 工具执行：harness 把工具调用分派为「phase 1 规划、phase 2 实际执行」，
		// 此 span 只覆盖原始执行本身，不含 before_tool / after_tool 等 hook 的耗时。
		// 何时发出：每次实际执行一个工具调用时开启，执行返回时结束（恢复期重放的工具调用同样会记录）。
		// 关键字段：turn.id 仅在存在活跃 turn 时携带（恢复执行可能没有）；
		// replay 声明工具的重放策略（never=不可重放 / safe=可安全重放）；
		// recovery 标记本次是否为恢复（recovery）执行；结束属性 is_error 标记原始执行是否返回错误。
		"pi.harness.tool": {
			description: "One raw phase-2 tool execution",
			// 父 span 约束：只能挂在 pi.harness.turn 或 pi.harness.run 之下
			parents: { kind: "spans", spans: ["pi.harness.turn", "pi.harness.run"] },
			startAttributes: {
				// lane 名（高基数）
				"pi.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				// 持久化操作 id（高基数）
				"pi.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				// 调用内局部的活跃 turn id（高基数；可选，恢复执行时可能无活跃 turn）
				"pi.turn.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Invocation-local live turn id",
				},
				// 工具名
				"pi.tool.name": {
					type: "string",
					required: true,
					description: "Tool name",
				},
				// 工具调用 id（高基数），对应模型返回的 tool call 标识
				"pi.tool.call_id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Tool call id",
				},
				// 工具声明的重放（replay）策略：never=不可重放 / safe=可安全重放
				"pi.tool.replay": {
					type: "string",
					required: true,
					values: ["never", "safe"],
					description: "Declared replay policy",
				},
				// 是否为恢复（recovery）执行，即进程重启后重放该工具调用
				"pi.tool.recovery": {
					type: "boolean",
					required: true,
					description: "Whether this is recovery execution",
				},
			},
			endAttributes: {
				// 原始 phase-2 执行是否返回了错误
				"pi.tool.is_error": {
					type: "boolean",
					description: "Whether raw phase-2 execution returned an error",
				},
			},
			// 状态：默认 ok；原始 phase-2 执行返回错误时记为 error
			status: { default: "ok", errorWhen: "Raw phase-2 execution returns an error" },
		},
		// 一次已注册 hook 处理器的调用（hook 名单见上方 HOOK_NAMES）。
		// 何时发出：harness 在各扩展点触发 hook 时，对每个被调用的处理器分别开启一个 span。
		// 关键字段：hook.name 为 hook 名；registration_id 为稳定的注册 id（用于区分同一 hook 的
		// 多个注册方）；operation.id 仅当 hook 在被准入操作内触发时才存在；
		// 结束属性 outcome（completed=正常完成 / skipped=跳过 / blocked=拦截并阻断后续流程 /
		// failed=失败）。
		"pi.harness.hook": {
			description: "One registered hook handler invocation",
			// 父 span 约束：任意（可在任何上下文中触发）
			parents: { kind: "any" },
			startAttributes: {
				// lane 名（高基数）
				"pi.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				// 持久化操作 id（高基数；可选，仅当 hook 在被准入操作内触发时存在）
				"pi.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when accepted",
				},
				// hook 名，取值见 HOOK_NAMES
				"pi.hook.name": {
					type: "string",
					required: true,
					values: HOOK_NAMES,
					description: "Hook name",
				},
				// 稳定的 hook 注册 id（可选，区分同一 hook 的不同注册方）
				"pi.hook.registration_id": {
					type: "string",
					required: false,
					description: "Stable hook registration id",
				},
			},
			endAttributes: {
				// 处理器的执行结果
				"pi.hook.outcome": {
					type: "string",
					values: ["completed", "skipped", "blocked", "failed"],
					description: "Handler outcome",
				},
			},
			// 状态：默认 ok；处理器抛出异常时记为 error
			status: { default: "ok", errorWhen: "The handler throws" },
		},
		// 一次重试前的等待延迟（durable sleep）。何时发出：step 决定重试后、下一次尝试前
		// 开启，等待结束或被中止时结束。
		// 关键字段：delay_ms 为请求的延迟毫秒数；结束属性 outcome（elapsed=正常等待到时 /
		// aborted=被中止，如 run 被取消）。
		"pi.harness.sleep": {
			description: "One retry delay",
			// 父 span 约束：只能挂在 pi.harness.step 或 pi.harness.run 之下
			parents: { kind: "spans", spans: ["pi.harness.step", "pi.harness.run"] },
			startAttributes: {
				// 持久化操作 id（高基数）
				"pi.operation.id": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Durable operation id",
				},
				// 请求的延迟时长（毫秒）
				"pi.sleep.delay_ms": {
					type: "number",
					required: true,
					description: "Requested delay in milliseconds",
				},
			},
			endAttributes: {
				// 等待结果
				"pi.sleep.outcome": {
					type: "string",
					values: ["elapsed", "aborted"],
					description: "Delay outcome",
				},
			},
			// 状态：默认 ok；等待工作抛出异常时记为 error
			status: { default: "ok", errorWhen: "Sleep work throws" },
		},
		// 一次被动事件监听器（event listener）收到 harness 事件的调用。
		// 何时发出：harness 每投递一个事件（事件类型见上方 EVENT_TYPES），
		// 就对每个被触发的监听器分别开启一个 span。
		// 关键字段：event.type 为投递的事件类型（低基数）；lane.name 仅 lane 范围的事件携带。
		// 无结束属性。
		"pi.harness.event_handler": {
			description: "One passive event listener invocation",
			// 父 span 约束：任意（可在任何上下文中触发）
			parents: { kind: "any" },
			startAttributes: {
				// 投递的 harness 事件类型（低基数），取值见 EVENT_TYPES
				"pi.event.type": {
					type: "string",
					required: true,
					cardinality: "low",
					values: EVENT_TYPES,
					description: "Delivered harness event type",
				},
				// lane 名（高基数；可选，仅 lane 范围的事件携带）
				"pi.lane.name": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Lane name for lane-scoped events",
				},
			},
			// 事件监听无结束属性
			endAttributes: {},
			// 状态：默认 ok；监听器抛出异常时记为 error
			status: { default: "ok", errorWhen: "The listener throws" },
		},
		// 一次已提交（committed）的 session 变更。何时发出：每笔变更事务通过校验并
		// 提交到存储时开启，提交完成后结束。
		// 关键字段：mutation 为变更种类（entry=会话条目 / record=记录 / lane=lane 本身 /
		// fact=事实）；item_type 为对应条目的子类型；结束时如存储层暴露则记录 session 序列号。
		"pi.session.write": {
			description: "One committed session mutation",
			// 父 span 约束：任意（任何上下文都可能写 session）
			parents: { kind: "any" },
			startAttributes: {
				// lane 名（高基数）
				"pi.lane.name": {
					type: "string",
					required: true,
					cardinality: "high",
					description: "Lane name",
				},
				// 持久化操作 id（高基数；可选，仅当写入发生在被准入操作内时存在）
				"pi.operation.id": {
					type: "string",
					required: false,
					cardinality: "high",
					description: "Durable operation id when accepted",
				},
				// session 变更种类：entry=会话条目 / record=记录 / lane=lane 本身 / fact=事实
				"pi.session.mutation": {
					type: "string",
					required: true,
					values: ["entry", "record", "lane", "fact"],
					description: "Session mutation kind",
				},
				// 变更条目的子类型（entry / record / lane / fact 各自的细分类型，可选）
				"pi.session.item_type": {
					type: "string",
					required: false,
					description: "Entry, record, lane, or fact subtype",
				},
			},
			endAttributes: {
				// 提交后的 session 序列号（可选，仅当存储层暴露该信息时记录）
				"pi.session.seq": {
					type: "number",
					description: "Committed session sequence when exposed",
				},
			},
			// 状态：默认 ok；存储层拒绝该变更时记为 error
			status: { default: "ok", errorWhen: "Storage rejects the mutation" },
		},
	},
} as const satisfies TelemetrySchemaDefinition;

/**
 * agent 自有的 AI 请求与 harness 遥测的组合 schema：
 * 把两套 schema 一起注册到 TelemetryContext，即可获得本文件全部 span 的类型化词汇表。
 */
export const AGENT_TELEMETRY_SCHEMAS = [AI_TELEMETRY_SCHEMA, HARNESS_TELEMETRY_SCHEMA] as const;

// ---- 由 HARNESS_TELEMETRY_SCHEMA 静态推导的类型工具：与上方 AI 系列一一对应 ----
/** Harness schema 下所有 span 名的字面量联合类型。 */
export type HarnessSpanName = TelemetrySchemaSpanName<typeof HARNESS_TELEMETRY_SCHEMA>;
/** 指定 span 的开始属性类型（按 schema 定义逐字段收窄）。 */
export type HarnessSpanStartAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanStartAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
/** 指定 span 的结束属性类型（全部可选的完成信息）。 */
export type HarnessSpanEndAttributes<Name extends HarnessSpanName> = TelemetrySchemaSpanEndAttributes<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
/** 指定 span 的开始 + 结束属性的合并类型。 */
export type HarnessSpanAttributes<Name extends HarnessSpanName> = HarnessSpanStartAttributes<Name> &
	HarnessSpanEndAttributes<Name>;
/** 指定 span 上可附加的事件名联合类型（当前 schema 未声明事件）。 */
export type HarnessSpanEventName<Name extends HarnessSpanName> = TelemetrySchemaSpanEventName<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
/** 指定 span 上某事件的属性类型。 */
export type HarnessSpanEventAttributes<
	Name extends HarnessSpanName,
	EventName extends HarnessSpanEventName<Name>,
> = TelemetrySchemaSpanEventAttributes<typeof HARNESS_TELEMETRY_SCHEMA, Name, EventName>;
/** 指定 span 的具体化 TelemetrySpan 类型（携带 schema 校验后的属性与方法）。 */
export type HarnessTelemetrySpan<Name extends HarnessSpanName> = SchemaTelemetrySpan<
	typeof HARNESS_TELEMETRY_SCHEMA,
	Name
>;
/** Harness schema 下全部 span 的联合类型。 */
export type HarnessSpan = TelemetrySchemaSpanUnion<typeof HARNESS_TELEMETRY_SCHEMA>;

/**
 * 以类型安全的方式启动一个 harness 执行层 span（如 `pi.harness.run`、`pi.harness.turn` 等）。
 *
 * 作用与 {@link startAiSpan} 相同：把泛型的 `telemetryContext.startSpan` 收窄为
 * `HARNESS_TELEMETRY_SCHEMA` 驱动的类型化封装，attributes 按字面量类型精确校验，
 * 回调拿到 {@link HarnessTelemetrySpan} 类型的 span；回调返回 Promise 时自动等待。
 *
 * @param telemetryContext 遥测上下文
 * @param name span 名（须属于 {@link HarnessSpanName}）
 * @param attributes 该 span 的开始属性，须精确满足 schema 定义
 * @param callback 在 span 生命周期内执行的回调，入参为类型化 span
 * @returns 回调返回的结果（Result）
 */
export function startHarnessSpan<
	Name extends HarnessSpanName,
	const Attributes extends HarnessSpanStartAttributes<Name>,
	Result,
>(
	telemetryContext: TelemetryContext,
	name: Name,
	attributes: ExactTelemetryAttributes<HarnessSpanStartAttributes<Name>, Attributes>,
	callback: (span: HarnessTelemetrySpan<Name>) => Result | Promise<Result>,
): Promise<Result> {
	// span 的实际形状由已注册的 schema 保证，这里只做静态类型断言
	return telemetryContext.startSpan({ name, attributes }, (span: TelemetrySpan) =>
		callback(span as HarnessTelemetrySpan<Name>),
	);
}
