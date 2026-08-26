/**
 * @file pi-agent-core 的包入口（barrel 汇总导出）
 * @description 统一导出本包的公共 API，按逻辑分组：
 *   1. 核心 Agent 与 Agent 循环 (agent loop)：有状态、可执行工具调用的 LLM Agent 本体；
 *   2. 宿主层 (harness)：AgentHarness、多会话 (session) 持久化、上下文压缩 (compaction)、
 *      工具、技能 (skill)、系统提示词、遥测 (telemetry) 等运行时设施；
 *   3. 代理 (proxy) 与搜索等周边能力；
 *   4. 默认 streamFn 适配与通用类型。
 *   同时转售来自 @earendil-works/pi-ai 与 @earendil-works/pi-telemetry 的常用符号，
 *   宿主层（上层应用）只需依赖本包即可获得完整能力。
 */

// ========== 核心 Agent ==========
// Agent 本体及其直接依赖的基础符号。

// 转售 pi-ai 的 uuidv7（UUID v7 生成器），便于生成消息/会话等 ID，免去额外依赖
export { uuidv7 } from "@earendil-works/pi-ai";
// 转售 pi-telemetry 的遥测 (telemetry) 类型定义：span / 事件 / 属性 / schema 推导工具等，
// 供宿主层自定义或扩展遥测 schema 时引用
export type {
	AttributeValue,
	ExactTelemetryAttributes,
	InferEventAttributes,
	InferOptionalAttributes,
	InferRequiredAndOptionalAttributes,
	InferStartAttributes,
	RecordedTelemetryEvent,
	RecordedTelemetrySpan,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanAttributes as TelemetrySpanAttributes,
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
// 转售 pi-telemetry 的遥测实现：schema 定义工具、类型化 span 启动器，
// 以及内存实现与空实现 (NOOP) 两种遥测上下文
export {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
} from "@earendil-works/pi-telemetry";
// 核心 Agent 类：封装 LLM 会话状态与工具调用 (tool call) 的有状态执行单元
export * from "./agent.ts";
// ========== Agent 循环 (agent loop) ==========
// 底层循环函数：驱动「请求 LLM → 执行工具调用 → 回传结果」直至回合结束，
// 供需要绕过 Agent/Harness 自行组装循环的高级调用方使用
export * from "./agent-loop.ts";
// 宿主层 (harness) 主入口：AgentHarness 将 Agent、会话、工具、压缩、技能等组装成完整运行时
export * from "./harness/agent-harness.ts";
// 分支摘要 (branch summarization)：为分支/侧线会话收集条目并生成摘要
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type BranchSummaryResult,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type FileOperations,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
// 上下文压缩 (compaction)：估算 token、判断是否需要压缩、定位裁剪点并生成摘要
export {
	type CompactionPreparation,
	type CompactionSettings,
	type CompactResult,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
// 会话消息的构造与渲染辅助
export * from "./harness/messages.ts";
// 提示词模板 (prompt template)
export * from "./harness/prompt-templates.ts";
// ========== 宿主层 (harness) ==========
// 宿主层的其余组成模块：结果封装、多会话持久化、技能、系统提示词、遥测与内置工具。
// 结果封装（Result 风格的执行结果）
export * from "./harness/result.ts";
// 多会话 (session) 持久化：会话的存取、分支与序列化
export * from "./harness/session/index.ts";
// 技能 (skill) 的发现与加载
export * from "./harness/skills.ts";
// 系统提示词 (system prompt) 的生成
export * from "./harness/system-prompt.ts";
// 宿主层遥测 schema 的类型：AI 调用 span 与 harness span 的名称、属性与事件定义
export type {
	AiSpan,
	AiSpanAttributes,
	AiSpanEndAttributes,
	AiSpanEventAttributes,
	AiSpanEventName,
	AiSpanName,
	AiSpanStartAttributes,
	AiTelemetrySpan,
	HarnessSpan,
	HarnessSpanAttributes,
	HarnessSpanEndAttributes,
	HarnessSpanEventAttributes,
	HarnessSpanEventName,
	HarnessSpanName,
	HarnessSpanStartAttributes,
	HarnessTelemetrySpan,
} from "./harness/telemetry.ts";
// 宿主层遥测 schema 本体及对应的 span 启动函数
export {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	HARNESS_TELEMETRY_SCHEMA,
	startAiSpan,
	startHarnessSpan,
} from "./harness/telemetry.ts";
// 宿主层内置工具集 (tools)
export * from "./harness/tools/index.ts";
// 宿主层基础类型与工具函数：执行环境 (ExecutionEnv)、文件系统/Shell 抽象、
// Result 风格的 ok/err、技能类型，以及各模块共用的错误类型与错误码
export {
	type AgentHarnessResources,
	type AgentHarnessStreamOptions,
	type AgentHarnessStreamOptionsPatch,
	type AgentHarnessTool,
	type AgentHarnessToolContextSource,
	BranchSummaryError,
	type BranchSummaryErrorCode,
	CompactionError,
	type CompactionErrorCode,
	type ExecutionEnv,
	ExecutionError,
	type ExecutionErrorCode,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileSystem,
	getOrThrow,
	getOrUndefined,
	ok,
	type PromptTemplate,
	type Shell,
	type ShellExecOptions,
	type Skill,
	toError,
} from "./harness/types.ts";
// 宿主层通用工具函数：Shell 输出处理与文本截断
export * from "./harness/utils/shell-output.ts";
export * from "./harness/utils/truncate.ts";
// ========== 代理工具 ==========
// Agent 代理 (proxy) 机制与搜索 (search) 能力，用于委托与检索类场景
export * from "./proxy.ts";
export * from "./search/index.ts";
// ========== 默认 streamFn ==========
// 配置全局兜底的 LLM 流式函数，供调用方未显式传入 streamFn 时使用
export { setDefaultStreamFn } from "./stream-fn.ts";
// ========== 通用类型 ==========
// 本包的公共类型定义
export * from "./types.ts";
