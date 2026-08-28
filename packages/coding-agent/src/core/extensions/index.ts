/**
 * @file extensions/index.ts —— 扩展系统的统一导出入口（barrel）
 *
 * @description
 * 本目录实现 pi 的扩展（Extension）系统：生命周期事件钩子与自定义工具。
 * 本文件作为出口，把散落在 loader.ts / runner.ts / types.ts / wrapper.ts
 * 中的加载器、运行器、类型与包装函数集中再导出，供 SDK（sdk.ts）与
 * 交互式 UI 等上层以单一路径 `extensions/index.ts` 引用。
 * 新增导出时请沿用既有风格：类型列表保持字母序，并配单行分组标记。
 *
 * 导出内容按来源分为四类：
 * - 加载器：createExtensionRuntime / loadExtensions 等（来自 loader.ts）；
 * - 运行器：ExtensionRunner 及其会话级处理器类型（来自 runner.ts）；
 * - 类型与辅助函数：ExtensionAPI、各类事件类型、defineTool、类型守卫等
 *   （几乎全部来自 types.ts）；
 * - 工具包装：wrapRegisteredTool(s)（来自 wrapper.ts）。
 */

// 斜杠命令与来源信息类型定义在 core 层（非 extensions 目录），
// 在此一并转出口，方便上层只从 extensions/index.ts 统一引用
export type { SlashCommandInfo, SlashCommandSource } from "../slash-commands.ts";
export type { SourceInfo } from "../source-info.ts";
// 扩展加载器：从磁盘发现扩展文件、加载内联工厂，
// 构建共享的扩展运行时并汇总为 LoadExtensionsResult
// （包含扩展列表、加载错误与共享 runtime 三部分）
export {
	createExtensionRuntime,
	discoverAndLoadExtensions,
	loadExtensionFromFactory,
	loadExtensions,
} from "./loader.ts";
// ExtensionRunner 的会话级处理器类型：
// 错误监听、分叉/树导航/新建/切换会话、优雅停机等钩子签名
export type {
	ExtensionErrorListener,
	ForkHandler,
	NavigateTreeHandler,
	NewSessionHandler,
	ShutdownHandler,
	SwitchSessionHandler,
} from "./runner.ts";
export { ExtensionRunner } from "./runner.ts";
// ===== types.ts 类型大清单 =====
// 按字母序导出扩展系统的全部类型；穿插的单行注释是分组标记
// （事件、API、渲染、命令、工具等）。因列表整体按字母序排列，
// 同组类型并不连续相邻，注释仅作领域提示、并非严格分段。
export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	// 再导出
	AgentToolResult,
	AgentToolUpdateCallback,
	AppendEntryHandler,
	// 应用快捷键（供自定义编辑器使用）
	AppKeybinding,
	AutocompleteProviderFactory,
	// 事件 - 工具（ToolCallEvent 的各工具变体）
	BashToolCallEvent,
	BashToolResultEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	// 上下文
	CompactOptions,
	// 事件 - Agent
	ContextEvent,
	// 事件结果（处理器可返回的改写值）
	ContextEventResult,
	ContextUsage,
	CustomToolCallEvent,
	CustomToolResultEvent,
	EditorFactory,
	EditToolCallEvent,
	EditToolResultEvent,
	// 消息与条目渲染
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	// API（ExtensionAPI 是每个扩展工厂收到的入口对象，承载全部扩展能力）
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	// 错误
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionMode,
	// 运行时
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	FindToolResultEvent,
	GetActiveToolsHandler,
	GetAllToolsHandler,
	GetCommandsHandler,
	GetThinkingLevelHandler,
	GrepToolCallEvent,
	GrepToolResultEvent,
	// 内联扩展：不走磁盘加载、直接以工厂函数注册的扩展
	InlineExtension,
	// 事件 - 输入
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	// loadExtensions 的结果：扩展 + 错误 + 共享运行时
	LoadExtensionsResult,
	LsToolCallEvent,
	LsToolResultEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	// 事件 - 消息
	MessageEndEvent,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	ModelSelectEvent,
	ModelSelectSource,
	PowerShellToolCallEvent,
	PowerShellToolResultEvent,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	// 供应商注册（扩展可注入自定义模型供应商）
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	ReadToolResultEvent,
	// 命令
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	// 事件 - 资源
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SendMessageHandler,
	SendUserMessageHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionBeforeForkEvent,
	SessionBeforeForkResult,
	SessionBeforeSwitchEvent,
	SessionBeforeSwitchResult,
	SessionBeforeTreeEvent,
	SessionBeforeTreeResult,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	// 事件 - 会话
	SessionStartEvent,
	SessionTreeEvent,
	SetActiveToolsHandler,
	SetLabelHandler,
	SetModelHandler,
	SetThinkingLevelHandler,
	TerminalInputHandler,
	// 事件 - 工具
	ToolCallEvent,
	ToolCallEventResult,
	// 工具
	ToolDefinition,
	// 事件 - 工具执行
	ToolExecutionEndEvent,
	// 工具执行模式
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	ToolResultEventResult,
	TreePreparation,
	TurnEndEvent,
	TurnStartEvent,
	// 事件 - 用户 Bash（用户在输入框直接执行的 shell 命令）
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
	WriteToolResultEvent,
} from "./types.ts";
// 类型守卫（isXxxToolResult 等判别函数）
// 与 defineTool 工具定义辅助函数
// （defineTool 用于以类型安全的方式定义扩展工具）
export {
	defineTool,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isPowerShellToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
} from "./types.ts";
// 扩展注册工具的包装器：把 RegisteredTool 适配为 agent-core 可调度的 AgentTool，
// 并让扩展工具拿到统一的 runner 上下文
export { wrapRegisteredTool, wrapRegisteredTools } from "./wrapper.ts";
