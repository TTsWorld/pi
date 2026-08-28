/**
 * @file index.ts —— core 模块的对外出口（barrel 文件）
 *
 * @description
 * 汇总导出所有运行模式（交互 / print / JSON / RPC）共享的核心模块：
 * Agent 会话及其运行时/服务组装、Bash 执行器、上下文压缩、事件总线、
 * 实验开关、扩展系统与资源来源信息。
 * 外部统一从这里引用，避免耦合各子模块的内部路径；
 * 导出按来源模块名排序，各块内保持与源文件一致的顺序。
 * 本文件不含任何运行时逻辑，纯粹是 re-export；
 * 新增模块导出时在此追加对应的导出块与分组注释。
 */

// Agent 会话：生命周期管理、事件流监听、提示选项与会话统计
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
// Agent 会话运行时封装（各运行模式的统一载体）
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
// 会话服务的组装：services 工厂与依赖注入入口，
// 支持从外部注入定制实现
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
// Bash 命令执行器
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
// 上下文压缩：压缩结果类型
// （实现位于 ./compaction/ 子目录）
export type { CompactionResult } from "./compaction/index.ts";
// 事件总线
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
// 实验性功能开关
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// 扩展系统：事件类型、工具定义/注册、命令与快捷键、UI 上下文、
// 扩展工厂与加载器，是 core 中最大的子系统
export {
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type InlineExtension,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
// 资源来源信息（合成 source info 构造）
export { createSyntheticSourceInfo } from "./source-info.ts";
