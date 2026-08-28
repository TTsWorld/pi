/**
 * @file index.ts —— coding-agent SDK 公共 API 导出入口（barrel 文件）
 *
 * @description
 * 本文件不包含任何实现代码，只负责把各模块的公共符号集中再导出：
 * 外部通过 `@earendil-works/coding-agent` 包名导入本模块，即可获得完整的
 * 程序化集成能力（创建并驱动 Agent 会话、编写扩展、复用内置工具与 UI 组件）；
 * 扩展作者也可以把本文件当作可用类型与事件的「清单」来查阅。
 *
 * 导出内容按功能分组，自上而下依次为：
 * 1. CLI 与配置：命令行参数解析、配置/文档/示例路径、版本号；
 * 2. 会话与上下文：AgentSession 会话门面、SessionManager 会话持久化、
 *    compaction 上下文压缩、事件总线、设置管理、Skills 加载、项目信任；
 * 3. 扩展系统：扩展可用的事件/上下文/UI 类型，扩展运行时与工具包装器；
 * 4. 模型层：模型注册表、CLI 模型解析、模型运行时与凭据同步；
 * 5. 内置工具：bash/read/edit/write/grep/find/ls/powershell 的定义、
 *    工厂与本地执行实现，以及 diff 生成等工具级辅助；
 * 6. 程序化 SDK：createAgentSession 等一站式工厂函数；
 * 7. 运行模式与 UI：interactive（TUI）/ print（单次输出）/ RPC 三种
 *    运行模式，供扩展复用的 UI 组件与主题工具；
 * 8. 通用工具：剪贴板、frontmatter 解析、图片处理、shell 配置等。
 *
 * 每个导出块上方的分组注释即本文件的「目录」，可据此快速定位所需 API。
 */

// 核心会话管理 —— CLI 参数解析：
// Args 为解析后的命令行参数类型，parseArgs 把进程 argv 解析为该结构，
// 供 main 入口与 RPC 等模式共用同一套参数定义。

export { type Args, parseArgs } from "./cli/args.ts";

// 配置路径：返回随包分发的安装目录、文档、示例、README 等资源路径，
// 以及配置目录名（CONFIG_DIR_NAME）与版本号（VERSION）；
// 供 SDK 使用者定位静态资源或判断当前运行环境使用。
export {
	CONFIG_DIR_NAME,
	getAgentDir,
	getDocsPath,
	getExamplesPath,
	getPackageDir,
	getReadmePath,
	VERSION,
} from "./config.ts";
// Agent 会话门面：AgentSession 是 SDK 的核心交互回路，
// 内部串联模型调用、工具执行、扩展事件与 UI 渲染，
// 是程序化使用时最常用的入口类；
// 同时导出会话事件监听、prompt 选项、会话统计与技能块解析等配套类型。
// 其中 AgentSessionConfig 为会话构造配置，SessionStats 汇总会话用量，
// ModelCycleResult 表示循环切换模型的结果。
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type ParsedSkillBlock,
	type PromptOptions,
	parseSkillBlock,
	type SessionStats,
} from "./core/agent-session.ts";
// 凭据存储：读取本地持久化的模型供应商凭据，
// 用于 print / RPC 等无交互场景下的静默认证。
export { readStoredCredential } from "./core/auth-storage.ts";
// 上下文压缩（compaction）：
// 当对话接近上下文窗口上限时，把早期历史折叠为摘要以释放 token 预算；
// 这里导出压缩判定、切点查找、摘要生成、分支预处理等全部算法与类型，
// 供需要自定义压缩策略的宿主复用。
// estimateTokens / calculateContextTokens 估算 token 用量，shouldCompact 据此判定；
// DEFAULT_COMPACTION_SETTINGS 为默认压缩阈值配置。
export {
	type BranchPreparation,
	type BranchSummaryResult,
	type CollectEntriesResult,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type FileOperations,
	findCutPoint,
	findTurnStartIndex,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareBranchEntries,
	serializeConversation,
	shouldCompact,
} from "./core/compaction/index.ts";
// 事件总线：会话内事件的发布/订阅中枢，
// 供 UI 层与扩展在不直接耦合的前提下订阅并响应会话事件。
// EventBusController 提供总线的生命周期控制。
export { createEventBus, type EventBus, type EventBusController } from "./core/event-bus.ts";
// 扩展系统（类型部分）：
// 扩展可实现的全部钩子事件——会话生命周期、工具调用前后、消息渲染、
// provider 请求拦截、项目信任、输入拦截等——
// 以及编写扩展所需的 API / 上下文 / 命令 / 快捷键 / 组件等类型定义，
// 是扩展作者最主要的类型入口。
// 事件类型以 *Event 结尾、可写回结果以 *Result 结尾（如 ToolCallEventResult）；
// MarkdownTransformer / EntryRenderer / MessageRenderer 用于自定义渲染管线；
// ExtensionFactory / InlineExtension 分别对应文件式与内联式扩展。
export type {
	AgentEndEvent,
	AgentSettledEvent,
	AgentStartEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	AppKeybinding,
	AutocompleteProviderFactory,
	BashToolCallEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BeforeProviderRequestEventResult,
	BuildSystemPromptOptions,
	CompactOptions,
	ContextEvent,
	ContextUsage,
	CustomToolCallEvent,
	EditToolCallEvent,
	EntryRenderer,
	EntryRenderOptions,
	ExecOptions,
	ExecResult,
	Extension,
	ExtensionActions,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFactory,
	ExtensionFlag,
	ExtensionHandler,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	FindToolCallEvent,
	GrepToolCallEvent,
	InlineExtension,
	InputEvent,
	InputEventResult,
	InputSource,
	KeybindingsManager,
	LoadExtensionsResult,
	LsToolCallEvent,
	MarkdownTransformContext,
	MarkdownTransformer,
	MessageEndEvent,
	MessageRenderer,
	MessageRenderOptions,
	MessageStartEvent,
	MessageUpdateEvent,
	PowerShellToolCallEvent,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventDecision,
	ProjectTrustEventResult,
	ProjectTrustHandler,
	ProviderConfig,
	ProviderModelConfig,
	ReadToolCallEvent,
	RegisteredCommand,
	RegisteredTool,
	ResolvedCommand,
	SessionBeforeCompactEvent,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionInfoChangedEvent,
	SessionShutdownEvent,
	SessionStartEvent,
	SessionTreeEvent,
	SlashCommandInfo,
	SlashCommandSource,
	SourceInfo,
	TerminalInputHandler,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionMode,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolInfo,
	ToolRenderResultOptions,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	UserBashEvent,
	UserBashEventResult,
	WidgetPlacement,
	WorkingIndicatorOptions,
	WriteToolCallEvent,
} from "./core/extensions/index.ts";
// 扩展系统（值部分）：扩展运行时的创建与发现加载、
// 工具定义辅助（defineTool、wrapRegisteredTool 等）、
// 以及判断事件是否属于某个内置工具调用的类型守卫。
// discoverAndLoadExtensions 从配置目录发现并加载扩展，ExtensionRunner 驱动其执行。
export {
	createExtensionRuntime,
	defineTool,
	discoverAndLoadExtensions,
	ExtensionRunner,
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isLsToolResult,
	isPowerShellToolResult,
	isReadToolResult,
	isToolCallEventType,
	isWriteToolResult,
	wrapRegisteredTool,
	wrapRegisteredTools,
} from "./core/extensions/index.ts";
// 底栏数据提供者：暴露 git 分支与扩展运行状态等底栏数据——
// 这些数据不会经由其他 API 提供给扩展。
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
// 消息转换：把内部会话消息转换为 pi-ai 的 LLM 消息格式，
// 是自定义 AgentLoop 或替换消息表示时的关键适配点。
export { convertToLlm } from "./core/messages.ts";
// 模型注册表：维护内置与自定义模型目录、别名解析与模型元信息，
// 是所有模型查找/注册操作的统一数据源。
// ModelRegistry 实例可查询可用模型及其元信息。
export { ModelRegistry } from "./core/model-registry.ts";
// 模型解析：把 CLI 传入的模型字符串解析为具体模型，
// 并对 scoped model（按任务作用域指定模型）配置给出诊断信息。
// resolveCliModel 供 CLI 侧解析 --model 参数。
export {
	type ModelScopeDiagnostic,
	type ResolveCliModelResult,
	type ResolveModelScopeResult,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	type ScopedModel,
} from "./core/model-resolver.ts";
// 模型运行时：封装模型调用所需的认证状态、凭据同步与请求上下文，
// 供会话层以统一方式驱动不同供应商的模型。
// CredentialSynchronizationError 表示凭据同步失败。
export {
	type CreateModelRuntimeOptions,
	CredentialSynchronizationError,
	type CredentialSynchronizationOperation,
	ModelRuntime,
	type ModelRuntimeAuthOverrides,
} from "./core/model-runtime.ts";
// 包管理器：负责发现、下载与解析外部资源包（扩展/技能等），
// 这里导出接口（PackageManager）、默认实现（DefaultPackageManager）
// 以及进度回调、路径解析等配套类型，供需要自定义资源分发的嵌入方使用。
// ResolvedPaths / ResolvedResource 描述资源解析后的路径与内容。
export type {
	PackageManager,
	PathMetadata,
	ProgressCallback,
	ProgressEvent,
	ResolvedPaths,
	ResolvedResource,
} from "./core/package-manager.ts";
export { DefaultPackageManager } from "./core/package-manager.ts";
// 资源加载器：加载项目级上下文文件（如 AGENTS.md）与已安装资源，
// 并报告资源冲突等诊断信息。
// loadProjectContextFiles 加载项目上下文文件，DefaultResourceLoader 为默认实现。
export type { ResourceCollision, ResourceDiagnostic, ResourceLoader } from "./core/resource-loader.ts";
export { DefaultResourceLoader, loadProjectContextFiles } from "./core/resource-loader.ts";
// 程序化 SDK 入口：
// 供宿主程序以最少代码创建并驱动一个完整的 Agent 会话——
// 既有一站式工厂（createAgentSession 系列），
// 也提供可指定自定义 cwd 等参数的内置工具工厂（createCodingTools 等）。
// createReadOnlyTools 只生成只读工具集，PromptTemplate 用于以模板构造 prompt。
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	// —— 工厂函数：一站式创建会话 / 运行时 / 服务 ——
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createBashTool,
	// —— 工具工厂：便于以自定义 cwd 等参数重建内置工具集 ——
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type PromptTemplate,
} from "./core/sdk.ts";
// 会话管理器：负责会话文件的持久化、条目解析与跨版本迁移，
// 并把会话条目还原为上下文消息；同时提供会话树（分支/fork）模型，
// 是会话恢复与分支切换功能的基础。
// SessionHeader / SessionInfo 描述会话文件头与会话元信息，
// CURRENT_SESSION_VERSION 为当前会话格式版本。
export {
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	type CompactionEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	getLatestCompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	SessionManager,
	type SessionMessageEntry,
	type SessionTreeNode,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
} from "./core/session-manager.ts";
// 设置管理器：读写用户/项目两级设置
// （模型、压缩、重试、图片、TUI 模式、项目信任默认值等），
// 并导出各设置项的类型定义。
// SettingsManagerCreateOptions 为管理器构造选项，TuiMode 为 TUI 显示模式类型。
export {
	type CompactionSettings,
	type DefaultProjectTrust,
	type FullscreenExitOutput,
	type ImageSettings,
	type PackageSource,
	type RetrySettings,
	SettingsManager,
	type SettingsManagerCreateOptions,
	type TuiMode,
} from "./core/settings-manager.ts";
// Skills（技能）加载：从内置目录与项目目录发现并解析 SKILL.md，
// 输出可注入系统提示词的格式化文本；
// 扩展可基于这些接口实现自定义的技能分发。
// Skill / SkillFrontmatter 描述单个技能及其 frontmatter 元数据。
export {
	formatSkillsForPrompt,
	type LoadSkillsFromDirOptions,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	type Skill,
	type SkillFrontmatter,
} from "./core/skills.ts";
// 来源信息：为程序化生成的条目构造 SourceInfo，
// 使合成条目与真实来源保持一致的溯源结构。
export { createSyntheticSourceInfo } from "./core/source-info.ts";
// 编辑差异：生成 edit 工具使用的 diff 字符串与 unified patch，
// 供自定义编辑工具复用同一套差异产出。
export { type EditDiffResult, generateDiffString, generateUnifiedPatch } from "./core/tools/edit-diff.ts";
// 内置工具集：
// - createXxxToolDefinition：bash/read/edit/write/grep/find/ls/powershell
//   各工具的定义工厂；
// - Operations 接口 + createLocalBashOperations 等：可替换的本地执行实现，
//   便于在沙箱或远程环境中替换工具的执行行为；
// - truncateHead/Tail/Line、withFileMutationQueue 等：
//   读取截断与文件写入串行化等公共辅助。
// 扩展包装或替换内置工具时可整体复用这一层。
// 各 XxxToolInput / XxxToolDetails / XxxToolOptions 为对应工具的输入、详情与构造选项类型；
// formatSize 与 DEFAULT_MAX_BYTES / DEFAULT_MAX_LINES 用于读取内容的尺寸控制。
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLocalPowerShellOperations,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
	formatSize,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
	type ReadOperations,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
	type ToolsOptions,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
	withFileMutationQueue,
} from "./core/tools/index.ts";
// 项目信任管理：记录用户对项目资源（如包含可执行内容的技能）的信任决定，
// 在执行敏感操作前用于门禁判断。
// ProjectTrustStore 持久化这些决定，hasTrustRequiringProjectResources 判断资源是否需要先获信任。
export {
	hasTrustRequiringProjectResources,
	type ProjectTrustDecision,
	ProjectTrustStore,
	type ProjectTrustStoreEntry,
	type ProjectTrustUpdate,
} from "./core/trust-manager.ts";
// CLI 主入口：初始化配置、加载扩展并分发到对应运行模式
// （interactive / print / RPC），程序化嵌入时通常无需直接调用。
export { type MainOptions, main } from "./main.ts";
// 运行模式（程序化使用）：
// - runPrintMode：单次执行 prompt 并输出结果，适合脚本化调用；
// - runRpcMode / RpcClient：以 JSON-RPC 驱动的无 UI 嵌入方式；
// - InteractiveMode：默认的终端交互模式，可被宿主程序复用。
// InteractiveModeOptions 定制交互模式行为，RpcCommand / RpcEventListener
// 供扩展自定义 RPC 命令与事件监听。
export {
	InteractiveMode,
	type InteractiveModeOptions,
	type JsonAgentSessionEvent,
	type ModelInfo,
	type PrintModeOptions,
	RpcClient,
	type RpcClientOptions,
	type RpcCommand,
	type RpcEventListener,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type RpcResponse,
	type RpcSessionState,
	runPrintMode,
	runRpcMode,
} from "./modes/index.ts";
// UI 组件（供扩展使用）：
// 消息与工具执行的渲染组件、各类选择器/对话框
// （模型、会话、设置、主题、OAuth 等）、diff 渲染与按键提示工具；
// 扩展可用它们构建与内置界面风格一致的自定义 UI。
// CustomEditor / CustomMessageComponent 支持扩展完全自定义内容渲染，
// keyHint / keyText / rawKeyHint 生成带样式的按键提示。
export {
	ArminComponent,
	AssistantMessageComponent,
	BashExecutionComponent,
	BorderedLoader,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	CustomEditor,
	CustomMessageComponent,
	DynamicBorder,
	ExtensionEditorComponent,
	ExtensionInputComponent,
	ExtensionSelectorComponent,
	FooterComponent,
	keyHint,
	keyText,
	LoginDialogComponent,
	ModelSelectorComponent,
	OAuthSelectorComponent,
	type RenderDiffOptions,
	rawKeyHint,
	renderDiff,
	SessionSelectorComponent,
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
	ShowImagesSelectorComponent,
	SkillInvocationMessageComponent,
	ThemeSelectorComponent,
	ThinkingSelectorComponent,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	TreeSelectorComponent,
	truncateToVisualLines,
	UserMessageComponent,
	UserMessageSelectorComponent,
	type VisualTruncateResult,
} from "./modes/interactive/components/index.ts";
// 主题工具（供自定义工具与扩展使用）：
// 初始化主题、读取配色、代码高亮与 Markdown 渲染主题，
// 保证自定义 UI 与整体视觉风格一致。
// Theme / ThemeColor 为配色相关类型。
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	highlightCode,
	initTheme,
	Theme,
	type ThemeColor,
} from "./modes/interactive/theme/theme.ts";
// 剪贴板工具：把文本写入系统剪贴板（跨平台），
// 供复制命令与扩展的复制类操作复用。
export { copyToClipboard } from "./utils/clipboard.ts";
// Frontmatter 解析：解析并剥离 Markdown 头部的 YAML 元数据，
// 技能与文档加载时用于分离元数据与正文。
export { parseFrontmatter, stripFrontmatter } from "./utils/frontmatter.ts";
// 图片转换：把常见图片格式转换为 PNG，以适配模型输入要求，
// 常与图片缩放配合预处理待发送给模型的图片。
export { convertToPng } from "./utils/image-convert.ts";
// 图片缩放：按尺寸上限缩放图片，并生成对应的尺寸说明文本。
export { formatDimensionNote, type ResizedImage, resizeImage } from "./utils/image-resize.ts";
// MIME 探测：判断文件内容是否为模型可接受的图片类型。
export { detectSupportedImageMimeTypeFromFile } from "./utils/mime.ts";
// Shell 工具：识别当前平台的 shell 及其配置（含 PowerShell 专用配置），
// 供 bash 类工具选择解释器与启动参数。
export { getPowerShellConfig, getShellConfig } from "./utils/shell.ts";
