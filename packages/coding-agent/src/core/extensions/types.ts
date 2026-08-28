/**
 * @file types.ts —— Extension（扩展）系统 API 契约（类型定义）
 *
 * @description
 * 本文件是 extension 开发者面对的核心类型文件，定义了扩展系统的全部公共 API：
 *
 * - **事件钩子**：约 35 种生命周期事件（见 {@link ExtensionEvent} 联合类型），
 *   覆盖 session 生命周期（session_start / session_before_switch / session_before_fork /
 *   session_before_compact / session_compact / session_compact_failed / session_shutdown /
 *   session_before_tree / session_tree）、agent 循环（before_agent_start / agent_start /
 *   agent_end / agent_settled / turn_start / turn_end）、消息流式（message_start /
 *   message_update / message_end）、工具执行与拦截（tool_execution_* / tool_call /
 *   tool_result）、LLM 请求边界（context / before_provider_request / before_provider_headers /
 *   after_provider_response）、模型切换（model_select / thinking_level_select）、
 *   用户输入（input / user_bash）、启动资源发现（project_trust / resources_discover）等；
 * - **能力注册**：通过 {@link ExtensionAPI} 注册 LLM 可调用的工具（registerTool）、
 *   斜杠命令（registerCommand）、快捷键（registerShortcut）、CLI flag（registerFlag）、
 *   自定义渲染器、模型 provider（registerProvider）等；
 * - **UI 与上下文**：{@link ExtensionUIContext} 提供对话框/通知/编辑器/主题等 UI 原语，
 *   {@link ExtensionContext} / {@link ExtensionCommandContext} 提供会话、模型、上下文用量等运行时能力；
 * - **运行时内部类型**：loader / runner 之间共享的 {@link ExtensionRuntimeState}、
 *   {@link ExtensionActions}、{@link Extension} 等（扩展作者一般无需直接接触）。
 *
 * 依赖关系：
 * - `@earendil-works/pi-agent-core`：AgentMessage、工具结果与执行模式等 agent 核心类型；
 * - `@earendil-works/pi-ai`：模型、provider、流式事件、OAuth 等 LLM 统一抽象；
 * - `@earendil-works/pi-tui`：TUI 组件、编辑器、overlay 等终端 UI 原语；
 * - `../session-manager.ts`、`../model-registry.ts`、`../tools/*` 等核心模块的具体类型。
 *
 * Extension 是普通的 TypeScript 模块：导出一个工厂函数（{@link ExtensionFactory}），
 * 在工厂中通过 `pi.*` API 完成订阅与注册。
 */

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	ConstrainedSamplingConfig,
	Context,
	ImageContent,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	Provider,
	ProviderHeaders,
	RefreshModelsContext,
	SimpleStreamOptions,
	TextContent,
	ToolResultMessage,
	Usage,
} from "@earendil-works/pi-ai";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { CustomMessage } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionManager,
} from "../session-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	PowerShellToolDetails,
	PowerShellToolInput,
	ReadToolDetails,
	ReadToolInput,
	WriteToolInput,
} from "../tools/index.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI 上下文（UI Context）
// ============================================================================

/** 扩展 UI 对话框（select/confirm/input）的通用选项。 */
export interface ExtensionUIDialogOptions {
	/** AbortSignal：可通过程序方式（如 abort）主动关闭对话框。 */
	signal?: AbortSignal;
	/** 超时时间（毫秒）。到期后对话框自动关闭，并显示实时倒计时。 */
	timeout?: number;
}

/** 扩展 widget（小组件）的渲染位置：编辑器上方或下方。 */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** 扩展 widget 的配置选项。 */
export interface ExtensionWidgetOptions {
	/** widget 渲染位置，默认 "aboveEditor"（编辑器上方）。 */
	placement?: WidgetPlacement;
}

/** 原始终端输入监听器。返回 consume: true 可吞掉该输入，返回 data 可替换为其他输入；返回 undefined 表示不处理。 */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** 交互式流式加载器（working indicator）的配置。 */
export interface WorkingIndicatorOptions {
	/** 动画帧序列。传空数组可完全隐藏指示器；自定义帧会原样渲染（需自带颜色）。 */
	frames?: string[];
	/** 动画指示器的帧间隔（毫秒）。 */
	intervalMs?: number;
}

/** 自动补全 provider 工厂：在当前内置 provider 之上叠加额外行为后返回新 provider。 */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
/** 自定义编辑器工厂：接收 TUI 实例、编辑器主题与快捷键管理器，返回编辑器组件。 */
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * 扩展可用的 UI 上下文，用于请求交互式 UI（对话框、通知、widget、主题等）。
 * 每种运行模式（interactive/TUI、RPC、print）各自提供一份实现；
 * 无 UI 的模式下相关方法通常为 no-op 或抛错，可用 ctx.hasUI 预判。
 */
export interface ExtensionUIContext {
	/** 弹出选择列表，返回用户选中的选项；取消时返回 undefined。 */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 弹出确认对话框，返回用户是否确认。 */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** 弹出文本输入对话框，返回用户输入；取消时返回 undefined。 */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** 向用户展示一条通知（可指定 info/warning/error 级别）。 */
	notify(message: string, type?: "info" | "warning" | "error"): void;

	/** 监听原始终端输入（仅交互模式可用）。返回取消订阅函数。 */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/** 在底部状态栏设置一段状态文本（按 key 区分多段）。传 undefined 清除该 key 的文本。 */
	setStatus(key: string, text: string | undefined): void;

	/** 设置流式响应期间显示的 working/加载提示文案。无参调用恢复默认文案。 */
	setWorkingMessage(message?: string): void;

	/** 显示/隐藏内置的交互式 working 加载行（流式响应期间）。 */
	setWorkingVisible(visible: boolean): void;

	/**
	 * 配置流式响应期间显示的交互式 working 指示器。
	 *
	 * - 不传参数：恢复默认的动画 spinner；
	 * - `frames: ["●"]`：静态指示器；
	 * - `frames: []`：完全隐藏指示器；
	 * - 自定义帧按原样渲染，扩展需自行处理颜色。
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** 设置折叠的 thinking 块显示用的标签文案。无参调用恢复默认。 */
	setHiddenThinkingLabel(label?: string): void;

	/** 在编辑器上方或下方设置一个 widget。content 可为字符串数组或组件工厂。 */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** 设置自定义 footer 组件；传 undefined 恢复内置 footer。
	 *
	 * 工厂函数会收到一个 FooterDataProvider，用于访问 otherwise 无法拿到的数据：
	 * git 分支与 setStatus() 设置的扩展状态。上下文用量在
	 * ctx.getContextUsage()，token 统计在 ctx.sessionManager.getEntries()，模型信息在 ctx.model。
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** 设置自定义 header 组件（启动时显示在聊天区上方）；传 undefined 恢复内置 header。 */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** 设置终端窗口/标签页的标题。 */
	setTitle(title: string): void;

	/** 以键盘焦点方式展示一个自定义组件；Promise 在 done(result) 被调用后 resolve。 */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			/** 是否以 overlay（浮层）形式展示。 */
			overlay?: boolean;
			/** overlay 的定位/尺寸选项。可为静态值，或返回动态更新值的函数。 */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** overlay 显示后以其 handle 回调，可用于控制可见性。 */
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T>;

	/** 向编辑器粘贴文本，会触发粘贴处理逻辑（大内容自动折叠）。 */
	pasteToEditor(text: string): void;

	/** 设置核心输入编辑器中的文本。 */
	setEditorText(text: string): void;

	/** 获取核心输入编辑器中的当前文本。 */
	getEditorText(): string;

	/** 弹出多行编辑器供用户编辑文本；取消时返回 undefined。 */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** 在内置自动补全 provider 之上叠加一层额外的补全行为。 */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * 通过工厂函数设置自定义编辑器组件；传 undefined 恢复默认编辑器。
	 *
	 * 工厂函数接收：
	 * - `theme`：用于边框与自动补全样式的 EditorTheme
	 * - `keybindings`：应用级快捷键的 KeybindingsManager
	 *
	 * 若需要完整的应用快捷键支持（escape、ctrl+d、切换模型等），
	 * 请继承 `@earendil-works/pi-coding-agent` 的 `CustomEditor`，
	 * 并对自己不处理的按键调用 `super.handleInput(data)`。
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@earendil-works/pi-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** 获取当前配置的自定义编辑器工厂；使用默认编辑器时返回 undefined。 */
	getEditorComponent(): EditorFactory | undefined;

	/** 获取当前主题（用于自定义渲染时的配色）。 */
	readonly theme: Theme;

	/** 获取所有可用主题（名称与文件路径）。 */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** 按名称加载主题但不切换过去。找不到时返回 undefined。 */
	getTheme(name: string): Theme | undefined;

	/** 按名称或 Theme 对象切换当前主题。 */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** 获取当前工具输出的展开/折叠状态。 */
	getToolsExpanded(): boolean;

	/** 设置工具输出的展开/折叠状态。 */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// 扩展上下文（Extension Context）
// ============================================================================

/** 当前上下文（context window）用量信息，用于展示 token 消耗进度。 */
export interface ContextUsage {
	/** 估算的已用上下文 token 数；未知时为 null（如 compaction 刚完成、下一次 LLM 响应到来之前）。 */
	tokens: number | null;
	/** 当前模型的上下文窗口大小（token 数）。 */
	contextWindow: number;
	/** 上下文占用窗口的百分比；tokens 未知时为 null。 */
	percent: number | null;
}

/** 触发 compaction（上下文压缩）时的可选配置。 */
export interface CompactOptions {
	/** 附加到默认压缩提示词之后的自定义指令。 */
	customInstructions?: string;
	/** 压缩成功完成时的回调。 */
	onComplete?: (result: CompactionResult) => void;
	/** 压缩失败时的回调。 */
	onError?: (error: Error) => void;
}

/**
 * 传递给扩展事件处理器的上下文类型（原注释位置如此）。
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

/**
 * 扩展事件处理器收到的上下文（ctx）。
 * 提供会话、模型、UI、中断控制等只读运行时能力；
 * 更敏感的会话控制方法仅在 {@link ExtensionCommandContext}（命令处理器）中开放。
 */
export interface ExtensionContext {
	/** 用于与用户交互的 UI 方法集合 */
	ui: ExtensionUIContext;
	/** 当前运行模式。可用 "tui" 守卫仅在终端可用的 UI（如自定义组件）。 */
	mode: ExtensionMode;
	/** 是否具备对话框能力的 UI（TUI 与 RPC 模式下为 true） */
	hasUI: boolean;
	/** 当前工作目录 */
	cwd: string;
	/** 会话管理器（只读视图） */
	sessionManager: ReadonlySessionManager;
	/** 模型注册表（可用于解析 API key 等） */
	modelRegistry: ModelRegistry;
	/** 当前使用的模型（可能为 undefined） */
	model: Model<any> | undefined;
	/** 本会话作用域内的模型集合（由 `--models` / `enabledModels` 设置
	 *  对照可用目录解析而来）。与 `/scoped-models` 命令展示的集合一致。
	 *  未配置作用域时为空（表示所有可用模型均可使用）。只读快照。 */
	scopedModels: readonly ScopedModel[];
	/** 当前思考级别（thinking level）；会话运行时未提供时为 undefined。 */
	thinkingLevel?: ThinkingLevel;
	/** agent 是否空闲（未在流式响应中） */
	isIdle(): boolean;
	/** 当前目录的项目级信任（project trust）是否已激活。 */
	isProjectTrusted(): boolean;
	/** 当前的 abort 信号；agent 未在流式响应时为 undefined。 */
	signal: AbortSignal | undefined;
	/** 中止当前的 agent 操作 */
	abort(): void;
	/** 是否有排队等待发送的消息 */
	hasPendingMessages(): boolean;
	/** 优雅关闭 pi 并退出。所有上下文中均可用。 */
	shutdown(): void;
	/** 获取当前模型对应的上下文用量。 */
	getContextUsage(): ContextUsage | undefined;
	/** 触发 compaction，不等待完成（异步进行）。 */
	compact(options?: CompactOptions): void;
	/** 获取当前生效的系统提示词。 */
	getSystemPrompt(): string;
}

/**
 * 命令处理器使用的扩展上下文。
 * 额外包含仅在用户主动发起的命令中才安全的会话控制方法
 * （新建/分支/切换会话、树导航、reload 等）。
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/** 获取当前基础系统提示词的构建选项。 */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** 等待 agent 结束流式响应（回到空闲） */
	waitForIdle(): Promise<void>;

	/** 新建会话，可选地执行初始化回调。返回 cancelled 表示用户取消了选择。 */
	newSession(options?: {
		/** 新会话的父会话文件（用于记录派生关系）。 */
		parentSession?: string;
		/** 会话创建后、切换前，用可写 SessionManager 做初始化。 */
		setup?: (sessionManager: SessionManager) => Promise<void>;
		/** 切换完成后，用绑定到新会话的命令上下文执行回调。 */
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }>;

	/** 从指定条目 fork 出新会话文件。position 决定从该条目之前还是该条目处分叉。 */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 在会话树中导航到另一个节点（可触发分支摘要总结）。 */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** 切换到另一个会话文件。 */
	switchSession(
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean }>;

	/** 重新加载扩展、skills、prompts、主题与上下文文件。 */
	reload(): Promise<void>;
}

/**
 * 会话切换成功后，绑定到新会话的全新命令上下文。
 *
 * 该上下文会传给 `newSession()`、`fork()`、`switchSession()` 的 `withSession()` 回调，
 * 此时其中的 sendMessage / sendUserMessage 是异步版本。
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	/** 向新会话发送一条自定义消息（返回 Promise；扩展 API 上的同名方法为同步版本）。 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	/** 以用户身份向新会话发送消息（总是触发一个 turn）。 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void>;
}

// ============================================================================
// 工具类型（Tool Types）
// ============================================================================

/** 工具结果渲染选项 */
export interface ToolRenderResultOptions {
	/** 结果视图当前是否处于展开状态 */
	expanded: boolean;
	/** 是否为部分/流式结果（工具仍在执行中） */
	isPartial: boolean;
}

/** 传递给工具渲染器（renderCall/renderResult）的上下文。 */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** 当前工具调用的参数。同一工具调用的 call/result 渲染之间共享。 */
	args: TArgs;
	/** 本次工具执行的唯一 id。同一工具调用的 call/result 渲染之间保持稳定。 */
	toolCallId: string;
	/** 仅使该工具执行组件失效以触发重绘。 */
	invalidate: () => void;
	/** 此渲染槽位上一次返回的组件（如有），可用于增量更新。 */
	lastComponent: Component | undefined;
	/** 该工具行的共享渲染器状态。由 tool-execution.ts 初始化。 */
	state: TState;
	/** 本次工具执行的工作目录。 */
	cwd: string;
	/** 工具是否已开始执行。 */
	executionStarted: boolean;
	/** 工具调用参数是否已接收完整（流式参数解析完毕）。 */
	argsComplete: boolean;
	/** 工具结果是否为部分/流式。 */
	isPartial: boolean;
	/** 结果视图是否展开。 */
	expanded: boolean;
	/** TUI 当前是否显示内联图片。 */
	showImages: boolean;
	/** 当前结果是否为错误。 */
	isError: boolean;
}

/**
 * registerTool() 使用的工具定义。
 * 一个工具 = 元信息（名称/描述/参数 schema）+ execute 实现 + 可选的 TUI 渲染定制。
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** 工具名（LLM 发起 tool call 时使用） */
	name: string;
	/** UI 展示用的人类可读标签 */
	label: string;
	/** 给 LLM 看的工具描述 */
	description: string;
	/** 可选的单行片段，进入默认系统提示词的 Available tools 小节。不提供时自定义工具不会出现在该小节。 */
	promptSnippet?: string;
	/** 可选的准则条目，在该工具激活时追加到默认系统提示词的 Guidelines 小节。 */
	promptGuidelines?: string[];
	/** 参数 schema（TypeBox） */
	parameters: TParams;
	/** 可选的 provider 侧 constrained sampling（受约束采样）配置。设为 false 显式禁用，等价于不设置。 */
	constrainedSampling?: false | ConstrainedSamplingConfig;
	/** 控制 ToolExecutionComponent 是否渲染标准彩色外壳："default" 渲染标准外壳，"self" 由工具自行绘制边框。 */
	renderShell?: "default" | "self";

	/** 可选的兼容性垫片：在 schema 校验之前预处理原始工具调用参数。必须返回符合 TParams 的对象。 */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * 单个工具级别的执行模式覆盖。
	 * - "sequential"：该工具必须与其他工具调用逐个串行执行；
	 * - "parallel"：该工具可与其他工具调用并发执行。
	 *
	 * 省略时使用默认执行模式。
	 */
	executionMode?: ToolExecutionMode;

	/** 执行工具。onUpdate 用于流式上报中间结果；signal 用于感知中断。 */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** 工具调用（参数流式阶段）的自定义渲染 */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** 工具结果的自定义渲染 */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;
}

/** 内部工具：参数泛型被擦除后的 ToolDefinition（用于交叉类型）。 */
type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * 为独立定义的工具保留参数类型推断。
 *
 * 当把工具赋值给变量、或经过 `customTools` 之类的数组传递时，
 * 上下文类型推断会把参数泛型拓宽为 `unknown`；用本函数包裹可避免。
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// 启动/资源事件（Startup/Resource Events）
// ============================================================================

/**
 * project_trust 事件：在不受信任的目录中启动时触发，询问扩展是否信任当前项目。
 * 事件处理器按注册顺序依次执行，直到某个处理器给出明确决定（yes/no）。
 */
export interface ProjectTrustEvent {
	type: "project_trust";
	/** 待判定的项目目录。 */
	cwd: string;
}

/** 信任判定结果："yes" 信任 / "no" 不信任 / "undecided" 未决定（交由后续处理器或默认流程）。 */
export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

/** project_trust 事件处理器的返回值。 */
export interface ProjectTrustEventResult {
	/** 信任判定。yes/no 为最终决定；undecided 表示本扩展不做决定。 */
	trusted: ProjectTrustEventDecision;
	/** 是否记住该决定（对同一目录后续启动不再询问）。 */
	remember?: boolean;
}

/** project_trust 事件处理器的专用上下文（完整 ExtensionContext 尚未就绪）。 */
export interface ProjectTrustContext {
	/** 项目目录。 */
	cwd: string;
	/** 当前运行模式。 */
	mode: ExtensionMode;
	/** 是否具备对话框 UI。 */
	hasUI: boolean;
	/** 精简版 UI：仅对话框与通知方法。 */
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

/** project_trust 事件处理器类型：可同步或异步返回判定结果。 */
export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** resources_discover 事件：在 session_start 之后触发，允许扩展补充额外的资源搜索路径。 */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	/** 当前工作目录。 */
	cwd: string;
	/** 触发原因：进程启动（startup）或 /reload（reload）。 */
	reason: "startup" | "reload";
}

/** resources_discover 事件处理器的返回值：要追加的各类资源目录。 */
export interface ResourcesDiscoverResult {
	/** 额外的 skill 搜索目录。 */
	skillPaths?: string[];
	/** 额外的 prompt 模板目录。 */
	promptPaths?: string[];
	/** 额外的主题目录。 */
	themePaths?: string[];
}

// ============================================================================
// 会话事件（Session Events）
// ============================================================================

/** session_start 事件：会话启动、加载或重新加载时触发。 */
export interface SessionStartEvent {
	type: "session_start";
	/** 本次会话启动的来由：进程启动 / 重载 / 新建 / 恢复 / 分叉。 */
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	/** 此前活跃的会话文件。仅在 "new"、"resume"、"fork" 时存在。 */
	previousSessionFile?: string;
}

/** session_info_changed 事件：当前会话的元数据（如名称）发生变化时触发。 */
export interface SessionInfoChangedEvent {
	type: "session_info_changed";
	/** 当前规范化后的会话名。名称被清除时为 undefined。 */
	name: string | undefined;
}

/** session_before_switch 事件：切换到另一会话之前触发（可被取消）。 */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	/** 切换原因：新建（new）或恢复已有会话（resume）。 */
	reason: "new" | "resume";
	/** 目标会话文件路径。 */
	targetSessionFile?: string;
}

/** session_before_fork 事件：fork 会话之前触发（可被取消）。 */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	/** fork 的目标条目 id。 */
	entryId: string;
	/** 分叉位置：该条目之前（before）或从该条目处（at）。 */
	position: "before" | "at";
}

/** session_before_compact 事件：上下文压缩（compaction）之前触发（可被取消或定制压缩内容）。 */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	/** 压缩准备数据：待压缩的分支、摘要条目等。 */
	preparation: CompactionPreparation;
	/** 即将被压缩（收进摘要）的会话条目。 */
	branchEntries: SessionEntry[];
	/** 附加到默认压缩提示词后的自定义指令。 */
	customInstructions?: string;
	/** 压缩触发方式：手动 /compact、上下文阈值、上下文溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 溢出恢复场景下，压缩完成后会重试被中断的 turn 时为 true */
	willRetry: boolean;
	/** 中断信号：压缩流程被 abort 时用于收尾。 */
	signal: AbortSignal;
}

/** session_compact 事件：上下文压缩成功完成后触发。 */
export interface SessionCompactEvent {
	type: "session_compact";
	/** 写入会话的压缩条目（含摘要与统计）。 */
	compactionEntry: CompactionEntry;
	/** 压缩内容是否来自扩展（session_before_compact 处理器提供）。 */
	fromExtension: boolean;
	/** 压缩触发方式：手动 /compact、上下文阈值、上下文溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 溢出恢复场景下，压缩完成后会重试被中断的 turn 时为 true */
	willRetry: boolean;
}

/** session_compact_failed 事件：上下文压缩失败或被中止后触发。 */
export interface SessionCompactFailedEvent {
	type: "session_compact_failed";
	/** 压缩触发方式：手动 /compact、上下文阈值、上下文溢出恢复 */
	reason: "manual" | "threshold" | "overflow";
	/** 非 abort 原因导致压缩失败时的错误文本。 */
	errorMessage?: string;
	/** 压缩被取消或中止时为 true。 */
	aborted: boolean;
	/** 溢出恢复场景下，若压缩成功本应重试被中断的 turn 时为 true */
	willRetry: boolean;
	/** 失败的压缩内容是否来自某个 session_before_compact 处理器。 */
	fromExtension: boolean;
}

/** session_shutdown 事件：扩展运行时因退出、重载或会话替换而被销毁之前触发。 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	/** 关闭原因：退出 / 重载 / 新建 / 恢复 / 分叉导致的会话替换。 */
	reason: "quit" | "reload" | "new" | "resume" | "fork";
	/** 因会话替换而关闭时，目标会话文件路径。 */
	targetSessionFile?: string;
}

/** 会话树导航（navigateTree）的准备数据。 */
export interface TreePreparation {
	/** 导航目标条目 id。 */
	targetId: string;
	/** 导航前的当前叶子条目 id（无则为 null）。 */
	oldLeafId: string | null;
	/** 新旧叶子在树中的最近公共祖先 id（无则为 null）。 */
	commonAncestorId: string | null;
	/** 将被收进分支摘要的条目。 */
	entriesToSummarize: SessionEntry[];
	/** 用户是否请求生成分支摘要。 */
	userWantsSummary: boolean;
	/** 摘要生成的自定义指令 */
	customInstructions?: string;
	/** 为 true 时 customInstructions 替换默认提示词，而非追加 */
	replaceInstructions?: boolean;
	/** 附加到分支摘要条目上的标签 */
	label?: string;
}

/** session_before_tree 事件：在会话树中导航之前触发（可被取消）。 */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	/** 树导航准备数据（可就地修改以定制摘要）。 */
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** session_tree 事件：在会话树中导航完成之后触发。 */
export interface SessionTreeEvent {
	type: "session_tree";
	/** 导航后的新叶子条目 id（无则为 null）。 */
	newLeafId: string | null;
	/** 导航前的旧叶子条目 id（无则为 null）。 */
	oldLeafId: string | null;
	/** 导航生成的分支摘要条目（如有）。 */
	summaryEntry?: BranchSummaryEntry;
	/** 本次导航是否由扩展 API（ctx.navigateTree）发起。 */
	fromExtension?: boolean;
}

/** 所有会话相关事件的联合类型。 */
export type SessionEvent =
	| SessionStartEvent
	| SessionInfoChangedEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionCompactFailedEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent 事件（Agent Events）—— agent 循环 / 消息 / 工具执行过程
// ============================================================================

/** context 事件：每次 LLM 调用之前触发。处理器可通过返回 ContextEventResult 改写消息列表。 */
export interface ContextEvent {
	type: "context";
	/** 即将发送给 LLM 的完整消息列表（可返回替换版本）。 */
	messages: AgentMessage[];
}

/** before_provider_request 事件：provider 请求发出之前触发。处理器返回的值会替换原始请求 payload。 */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	/** 原始请求 payload（结构因 provider/API 类型而异）。 */
	payload: unknown;
}

/**
 * before_provider_headers 事件：请求头组装完成之后、发起 provider HTTP 调用之前触发。
 * 处理器就地修改 `headers`（如注入 tracing / 会话头）；返回值被忽略。
 * 将某个头的值设为 `null` 表示删除该头。
 */
export interface BeforeProviderHeadersEvent {
	type: "before_provider_headers";
	/** 组装完成的请求头映射，可就地增删改。 */
	headers: ProviderHeaders;
}

/** after_provider_response 事件：收到 provider 响应之后、响应流被消费之前触发。 */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	/** HTTP 响应状态码。 */
	status: number;
	/** HTTP 响应头。 */
	headers: Record<string, string>;
}

/** before_agent_start 事件：用户提交 prompt 之后、agent 循环启动之前触发。 */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** 原始用户 prompt 文本（模板展开之后）。 */
	prompt: string;
	/** 用户 prompt 附带的图片（如有）。 */
	images?: ImageContent[];
	/** 完整组装后的系统提示词字符串。 */
	systemPrompt: string;
	/** 构建系统提示词所用的结构化选项。扩展可直接检视 Pi 加载了哪些资源，无需重新发现。 */
	systemPromptOptions: BuildSystemPromptOptions;
}

/** agent_start 事件：一个 agent 循环启动时触发。 */
export interface AgentStartEvent {
	type: "agent_start";
}

/** agent_end 事件：一个 agent 循环结束时触发。 */
export interface AgentEndEvent {
	type: "agent_end";
	/** 本次循环产生的全部消息。 */
	messages: AgentMessage[];
}

/** agent_settled 事件：一次 agent 运行完全落定后触发——不会再有自动重试、compaction 或排队续跑。 */
export interface AgentSettledEvent {
	type: "agent_settled";
}

/** turn_start 事件：每个 turn 开始时触发。 */
export interface TurnStartEvent {
	type: "turn_start";
	/** 当前 turn 在本次 agent 循环中的序号（从 0 开始）。 */
	turnIndex: number;
	/** turn 开始的时间戳（毫秒）。 */
	timestamp: number;
}

/** turn_end 事件：每个 turn 结束时触发。 */
export interface TurnEndEvent {
	type: "turn_end";
	/** 当前 turn 的序号。 */
	turnIndex: number;
	/** 本 turn 结束时的消息（通常是 assistant 消息）。 */
	message: AgentMessage;
	/** 本 turn 执行工具产生的结果消息。 */
	toolResults: ToolResultMessage[];
}

/** message_start 事件：一条消息开始时触发（user、assistant 或 toolResult）。 */
export interface MessageStartEvent {
	type: "message_start";
	/** 开始的消息。 */
	message: AgentMessage;
}

/** message_update 事件：assistant 消息流式输出期间逐 token 触发。 */
export interface MessageUpdateEvent {
	type: "message_update";
	/** 当前累积状态的 assistant 消息。 */
	message: AgentMessage;
	/** 本次增量对应的底层流式事件（文本块增量、thinking 增量等）。 */
	assistantMessageEvent: AssistantMessageEvent;
}

/** message_end 事件：一条消息完成时触发。 */
export interface MessageEndEvent {
	type: "message_end";
	/** 完成的消息。 */
	message: AgentMessage;
}

/** tool_execution_start 事件：工具开始执行时触发。 */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	/** 工具调用 id。 */
	toolCallId: string;
	/** 工具名。 */
	toolName: string;
	/** 工具调用参数。 */
	args: any;
}

/** tool_execution_update 事件：工具执行期间流式上报中间输出时触发。 */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	/** 工具调用 id。 */
	toolCallId: string;
	/** 工具名。 */
	toolName: string;
	/** 工具调用参数。 */
	args: any;
	/** 当前的部分结果（onUpdate 上报的内容）。 */
	partialResult: any;
}

/** tool_execution_end 事件：工具执行完成时触发。 */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	/** 工具调用 id。 */
	toolCallId: string;
	/** 工具名。 */
	toolName: string;
	/** 最终工具结果。 */
	result: any;
	/** 结果是否为错误。 */
	isError: boolean;
}

// ============================================================================
// 模型事件（Model Events）
// ============================================================================

/** 模型切换的来源：set 显式设置 / cycle 循环切换 / restore 恢复。 */
export type ModelSelectSource = "set" | "cycle" | "restore";

/** model_select 事件：新模型被选中时触发。 */
export interface ModelSelectEvent {
	type: "model_select";
	/** 新选中的模型。 */
	model: Model<any>;
	/** 切换前的模型（无则为 undefined）。 */
	previousModel: Model<any> | undefined;
	/** 切换来源。 */
	source: ModelSelectSource;
}

/** thinking_level_select 事件：新的思考级别被选中时触发。 */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	/** 新选中的思考级别。 */
	level: ThinkingLevel;
	/** 切换前的思考级别。 */
	previousLevel: ThinkingLevel;
}

// ============================================================================
// 用户 Bash 事件（User Bash Events）
// ============================================================================

/** user_bash 事件：用户通过 ! 或 !! 前缀直接执行 bash 命令时触发（不走 LLM）。 */
export interface UserBashEvent {
	type: "user_bash";
	/** 要执行的命令 */
	command: string;
	/** 是否使用了 !! 前缀（此时命令不进入 LLM 上下文） */
	excludeFromContext: boolean;
	/** 当前工作目录 */
	cwd: string;
}

// ============================================================================
// 输入事件（Input Events）
// ============================================================================

/** 用户输入的来源：交互式终端 / RPC / 扩展注入。 */
export type InputSource = "interactive" | "rpc" | "extension";

/** input 事件：收到用户输入之后、进入 agent 处理之前触发。可转换或拦截该输入。 */
export interface InputEvent {
	type: "input";
	/** 输入文本 */
	text: string;
	/** 附带的图片（如有） */
	images?: ImageContent[];
	/** 输入来源 */
	source: InputSource;
	/** 流式响应期间该输入将以何种方式投递（steer 中途转向 / followUp 排队下一轮）；空闲时为 undefined */
	streamingBehavior?: "steer" | "followUp";
}

/**
 * input 事件处理器的返回值：
 * - "continue"：放行，继续正常处理；
 * - "transform"：用给定的 text（及可选 images）替换原输入后继续；
 * - "handled"：输入已被扩展完全处理，agent 不再处理。
 */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// 工具事件（Tool Events）—— tool_call / tool_result 拦截
// ============================================================================

/** tool_call 事件的公共基础字段。 */
interface ToolCallEventBase {
	type: "tool_call";
	/** 本次工具调用的唯一 id。 */
	toolCallId: string;
}

/** bash 工具的 tool_call 事件。 */
export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

/** powershell 工具的 tool_call 事件。 */
export interface PowerShellToolCallEvent extends ToolCallEventBase {
	toolName: "powershell";
	input: PowerShellToolInput;
}

/** read 工具的 tool_call 事件。 */
export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

/** edit 工具的 tool_call 事件。 */
export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

/** write 工具的 tool_call 事件。 */
export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

/** grep 工具的 tool_call 事件。 */
export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

/** find 工具的 tool_call 事件。 */
export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

/** ls 工具的 tool_call 事件。 */
export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

/** 自定义（扩展注册）工具的 tool_call 事件，input 为原始参数对象。 */
export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: Record<string, unknown>;
}

/**
 * tool_call 事件：工具执行之前触发。可阻止执行（见 ToolCallEventResult.block）。
 *
 * `event.input` 可变。就地修改它即可在执行前打补丁修正工具参数；
 * 后注册的 `tool_call` 处理器能看到先注册处理器的修改。
 * 修改后不会重新做 schema 校验。
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| PowerShellToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

/** tool_result 事件的公共基础字段。 */
interface ToolResultEventBase {
	type: "tool_result";
	/** 本次工具调用的唯一 id。 */
	toolCallId: string;
	/** 本次工具调用的参数（只读参考）。 */
	input: Record<string, unknown>;
	/** 工具产出的内容块（文本/图片）。 */
	content: (TextContent | ImageContent)[];
	/** 结果是否为错误。 */
	isError: boolean;
	/** 工具执行自身的 token 用量（如可用）。 */
	usage?: Usage;
}

/** bash 工具的 tool_result 事件，details 携带命令、退出码等执行明细。 */
export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details: BashToolDetails | undefined;
}

/** powershell 工具的 tool_result 事件。 */
export interface PowerShellToolResultEvent extends ToolResultEventBase {
	toolName: "powershell";
	details: PowerShellToolDetails | undefined;
}

/** read 工具的 tool_result 事件。 */
export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details: ReadToolDetails | undefined;
}

/** edit 工具的 tool_result 事件。 */
export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details: EditToolDetails | undefined;
}

/** write 工具的 tool_result 事件（无 details）。 */
export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details: undefined;
}

/** grep 工具的 tool_result 事件。 */
export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details: GrepToolDetails | undefined;
}

/** find 工具的 tool_result 事件。 */
export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details: FindToolDetails | undefined;
}

/** ls 工具的 tool_result 事件。 */
export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details: LsToolDetails | undefined;
}

/** 自定义（扩展注册）工具的 tool_result 事件。 */
export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details: unknown;
}

/** tool_result 事件：工具执行之后触发。处理器可通过返回 ToolResultEventResult 改写结果。 */
export type ToolResultEvent =
	| BashToolResultEvent
	| PowerShellToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// ToolResultEvent 的类型守卫（type guards）
/** 判定 tool_result 事件是否来自 bash 工具。 */
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
/** 判定 tool_result 事件是否来自 powershell 工具。 */
export function isPowerShellToolResult(e: ToolResultEvent): e is PowerShellToolResultEvent {
	return e.toolName === "powershell";
}
/** 判定 tool_result 事件是否来自 read 工具。 */
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
/** 判定 tool_result 事件是否来自 edit 工具。 */
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
/** 判定 tool_result 事件是否来自 write 工具。 */
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
/** 判定 tool_result 事件是否来自 grep 工具。 */
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
/** 判定 tool_result 事件是否来自 find 工具。 */
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
/** 判定 tool_result 事件是否来自 ls 工具。 */
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * 按工具名收窄 ToolCallEvent 的类型守卫。
 *
 * 内置工具自动收窄（无需类型参数）：
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * 自定义工具需要显式类型参数：
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * 注意：直接用 `event.toolName === "bash"` 收窄是行不通的，
 * 因为 CustomToolCallEvent.toolName 是 `string`，与所有字面量类型重叠。
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "powershell", event: ToolCallEvent): event is PowerShellToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

/** 所有扩展事件的联合类型：扩展可订阅的全部生命周期事件（约 35 种）。 */
export type ExtensionEvent =
	| ProjectTrustEvent
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| AgentSettledEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent;

// ============================================================================
// 事件结果（Event Results）—— 各事件处理器的返回值类型
// ============================================================================

/** context 事件处理器的返回值：提供 messages 时将替换本次 LLM 调用的消息列表。 */
export interface ContextEventResult {
	/** 替换后的消息列表（可选）。 */
	messages?: AgentMessage[];
}

/** before_provider_request 事件处理器的返回值：非 undefined 时替换请求 payload。 */
export type BeforeProviderRequestEventResult = unknown;

/** tool_call 事件处理器的返回值：可阻止工具执行或提示提前终止。 */
export interface ToolCallEventResult {
	/** 阻止本次工具执行。若只想修改参数，应改为就地修改 `event.input`。 */
	block?: boolean;
	/** 阻止执行时向 LLM 说明的原因。 */
	reason?: string;
	/**
	 * 提示 agent 在当前工具批次结束后停止（仅当本次调用被阻止时生效）。
	 * 只有批次内每个最终确定的工具结果都将其置为 true，才会真正提前终止。
	 */
	terminate?: boolean;
}

/** user_bash 事件处理器的返回值：可自定义执行方式或完全接管执行结果。 */
export interface UserBashEventResult {
	/** 执行命令时使用的自定义 BashOperations（如拦截特定命令） */
	operations?: BashOperations;
	/** 完全替换：扩展已自行处理执行，直接采用该结果 */
	result?: BashResult;
}

/** tool_result 事件处理器的返回值：提供的字段会覆盖原结果中的对应部分。 */
export interface ToolResultEventResult {
	/** 替换后的结果内容块。 */
	content?: (TextContent | ImageContent)[];
	/** 替换后的 details（UI 渲染用的结构化明细）。 */
	details?: unknown;
	/** 覆盖结果是否为错误。 */
	isError?: boolean;
	/** 覆盖工具执行用量。 */
	usage?: Usage;
}

/** message_end 事件处理器的返回值：可替换最终落盘的消息。 */
export interface MessageEndEventResult {
	/** 替换已完成的消息。替换消息必须保持原消息的角色（role）不变。 */
	message?: AgentMessage;
}

/** before_agent_start 事件处理器的返回值：可注入自定义消息或替换本轮系统提示词。 */
export interface BeforeAgentStartEventResult {
	/** 在本轮开始前注入会话的自定义消息。 */
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** 替换本轮使用的系统提示词。多个扩展都返回该字段时会链式叠加（依次替换）。 */
	systemPrompt?: string;
}

/** session_before_switch 事件处理器的返回值：cancel 为 true 时取消本次会话切换。 */
export interface SessionBeforeSwitchResult {
	/** 取消切换。 */
	cancel?: boolean;
}

/** session_before_fork 事件处理器的返回值。 */
export interface SessionBeforeForkResult {
	/** 取消本次 fork。 */
	cancel?: boolean;
	/** fork 时跳过会话对话历史的恢复（仅保留会话结构）。 */
	skipConversationRestore?: boolean;
}

/** session_before_compact 事件处理器的返回值：可取消压缩，或直接提供压缩结果跳过内置压缩流程。 */
export interface SessionBeforeCompactResult {
	/** 取消本次压缩。 */
	cancel?: boolean;
	/** 扩展自行生成的压缩结果；提供后 Pi 不再执行内置压缩。 */
	compaction?: CompactionResult;
}

/** session_before_tree 事件处理器的返回值：可取消导航，或定制分支摘要。 */
export interface SessionBeforeTreeResult {
	/** 取消本次树导航。 */
	cancel?: boolean;
	/** 扩展自行生成的摘要；提供后 Pi 不再调用 LLM 生成摘要。 */
	summary?: {
		summary: string;
		details?: unknown;
		usage?: Usage;
	};
	/** 覆盖摘要生成的自定义指令 */
	customInstructions?: string;
	/** 覆盖 customInstructions 是否替换（而非追加）默认提示词 */
	replaceInstructions?: boolean;
	/** 覆盖附加到分支摘要条目上的标签 */
	label?: string;
}

// ============================================================================
// 消息与条目渲染（Message and Entry Rendering）
// ============================================================================

/** 自定义消息渲染器的选项。 */
export interface MessageRenderOptions {
	/** 视图当前是否展开。 */
	expanded: boolean;
	/** 由 outputPad 设置配置的水平内边距。 */
	outputPad: number;
}

/** Markdown 转换器（registerMarkdownTransformer）收到的上下文。 */
export interface MarkdownTransformContext {
	/** 消息类型：用户消息 / 助手消息 / 助手 thinking 块。 */
	messageType: "user" | "assistant" | "assistant-thinking";
	/** 是否处于流式输出中。 */
	isStreaming: boolean;
	/** 可用渲染宽度（字符数），便于扩展做折行等处理。 */
	availableWidth: number;
}

/** Markdown 转换器：在 Pi 渲染前改写用户/助手的 Markdown 文本。 */
export type MarkdownTransformer = (markdown: string, context: MarkdownTransformContext) => string;

/** 自定义条目渲染器的选项。 */
export interface EntryRenderOptions {
	/** 视图当前是否展开。 */
	expanded: boolean;
}

/** 自定义消息渲染器：把 CustomMessage 渲染为 TUI 组件；返回 undefined 表示不渲染。 */
export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

/** 自定义条目渲染器：把 CustomEntry 渲染为 TUI 组件；返回 undefined 表示不渲染。 */
export type EntryRenderer<T = unknown> = (
	entry: CustomEntry<T>,
	options: EntryRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// 命令注册（Command Registration）
// ============================================================================

/** 已注册的斜杠命令。 */
export interface RegisteredCommand {
	/** 命令名（不含斜杠）。 */
	name: string;
	/** 来源信息（来自哪个扩展/文件）。 */
	sourceInfo: SourceInfo;
	/** 命令描述（自动补全列表中展示）。 */
	description?: string;
	/** 命令参数的自动补全：根据参数前缀返回候选项，无补全返回 null。 */
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	/** 命令处理器：args 为命令后的原始参数字符串。 */
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/** 解析后待执行的命令：invocationName 为用户实际输入的调用名（可能是别名）。 */
export interface ResolvedCommand extends RegisteredCommand {
	/** 用户实际输入的调用名。 */
	invocationName: string;
}

// ============================================================================
// 扩展 API（Extension API）—— 传给扩展工厂函数的 `pi` 对象
// ============================================================================

/** 事件处理器函数类型：可同步/异步，可返回结果对象或 bare return（不返回）。 */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * 传给扩展工厂函数（ExtensionFactory）的 API 对象（惯用名 `pi`）。
 * 扩展在工厂函数中通过它订阅事件、注册工具/命令/快捷键/flag/provider 等。
 */
export interface ExtensionAPI {
	// =========================================================================
	// 事件订阅（Event Subscription）
	//
	// on() 的每个重载对应一种事件；带结果类型（第二个泛型参数 R）的事件
	// 可通过返回值影响主流程（拦截/改写/取消），其余事件仅作通知。
	// =========================================================================

	/** 订阅 project_trust：项目信任判定（首个给出 yes/no 的处理器生效）。 */
	on(event: "project_trust", handler: ProjectTrustHandler): void;
	/** 订阅 resources_discover：补充 skill/prompt/theme 搜索路径（返回 ResourcesDiscoverResult）。 */
	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	/** 订阅 session_start：会话启动/加载/重载完成。 */
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	/** 订阅 session_info_changed：会话元数据（名称等）变化。 */
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
	/** 订阅 session_before_switch：切换会话前触发，返回 cancel 可取消切换。 */
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	/** 订阅 session_before_fork：fork 会话前触发，返回 cancel 可取消。 */
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	/** 订阅 session_before_compact：压缩前触发，可取消或提供自定义压缩结果。 */
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	/** 订阅 session_compact：压缩成功完成。 */
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	/** 订阅 session_compact_failed：压缩失败或被中止。 */
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): void;
	/** 订阅 session_shutdown：扩展运行时即将被销毁（退出/重载/会话替换）。 */
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	/** 订阅 session_before_tree：会话树导航前触发，可取消或定制分支摘要。 */
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	/** 订阅 session_tree：会话树导航完成。 */
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	/** 订阅 context：每次 LLM 调用前触发，返回 messages 可替换消息列表。 */
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	/** 订阅 before_provider_request：provider 请求发出前触发，返回值替换请求 payload。 */
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	/** 订阅 before_provider_headers：HTTP 请求头组装后触发，就地修改 headers。 */
	on(event: "before_provider_headers", handler: ExtensionHandler<BeforeProviderHeadersEvent>): void;
	/** 订阅 after_provider_response：收到 provider HTTP 响应、消费流之前触发。 */
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	/** 订阅 before_agent_start：用户提交 prompt 后、agent 循环启动前，可替换系统提示词。 */
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	/** 订阅 agent_start：agent 循环启动。 */
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	/** 订阅 agent_end：agent 循环结束。 */
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	/** 订阅 agent_settled：agent 运行完全落定（无自动重试/压缩/续跑）。 */
	on(event: "agent_settled", handler: ExtensionHandler<AgentSettledEvent>): void;
	/** 订阅 turn_start：每个 turn 开始。 */
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	/** 订阅 turn_end：每个 turn 结束。 */
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	/** 订阅 message_start：消息开始（user/assistant/toolResult）。 */
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	/** 订阅 message_update：assistant 消息流式增量。 */
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	/** 订阅 message_end：消息结束，返回 message 可替换最终消息。 */
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	/** 订阅 tool_execution_start：工具开始执行（含内置与自定义工具）。 */
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	/** 订阅 tool_execution_update：工具执行中的流式中间输出。 */
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	/** 订阅 tool_execution_end：工具执行完成。 */
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	/** 订阅 model_select：模型切换。 */
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	/** 订阅 thinking_level_select：思考级别切换。 */
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
	/** 订阅 tool_call：工具执行前，可就地改参数、返回 block 阻止执行。 */
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	/** 订阅 tool_result：工具执行后，返回值可改写结果内容/错误标记。 */
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	/** 订阅 user_bash：用户 !/!! 直执 bash，可自定义 operations 或接管结果。 */
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	/** 订阅 input：用户输入进入 agent 处理前，可放行/转换/拦截。 */
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

	// =========================================================================
	// 工具注册（Tool Registration）
	// =========================================================================

	/** 注册一个 LLM 可调用的工具。 */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// =========================================================================
	// 命令、快捷键、flag 注册（Command, Shortcut, Flag Registration）
	// =========================================================================

	/** 注册一个自定义斜杠命令。 */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/** 注册一个键盘快捷键。 */
	registerShortcut(
		shortcut: KeyId,
		options: {
			description?: string;
			handler: (ctx: ExtensionContext) => Promise<void> | void;
		},
	): void;

	/** 注册一个 CLI flag（boolean 或 string 类型）。 */
	registerFlag(
		name: string,
		options:
			| {
					description?: string;
					type: "boolean";
					default?: boolean;
			  }
			| {
					description?: string;
					type: "string";
					default?: string;
			  },
	): void;

	/** 获取已注册 CLI flag 的当前值（CLI 传入值或默认值）。 */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// 消息渲染（Message Rendering）
	// =========================================================================

	/** 为 CustomMessageEntry（自定义消息条目）注册渲染器。 */
	registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

	/** 注册 Markdown 转换器：在 Pi 于交互式会话记录中渲染用户/助手 Markdown 之前进行改写。 */
	registerMarkdownTransformer(transformer: MarkdownTransformer): void;

	/** 为 CustomEntry（自定义条目）注册渲染器。自定义条目不进入 LLM 上下文。 */
	registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

	// =========================================================================
	// 动作（Actions）—— 向会话注入消息 / 持久化状态 / 工具与命令查询
	// =========================================================================

	/** 向会话发送一条自定义消息（不触发 turn，除非 triggerTurn 为 true）。 */
	sendMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * 以用户身份向 agent 发送消息，总是触发一个 turn。
	 * agent 正在流式响应时，用 deliverAs 指定消息排队方式（steer 中途转向 / followUp 下一轮）。
	 * 设置 expandPromptTemplates 可分发扩展命令并展开 skill 命令与 prompt 模板。
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): void;

	/** 向会话追加一个自定义条目用于状态持久化（不会发给 LLM）。 */
	appendEntry<T = unknown>(customType: string, data?: T): void;

	// =========================================================================
	// 会话元数据（Session Metadata）
	// =========================================================================

	/** 设置会话显示名（会话选择器中展示）。 */
	setSessionName(name: string): void;

	/** 获取当前会话名（未设置时为 undefined）。 */
	getSessionName(): string | undefined;

	/** 设置或清除某个条目上的标签。标签是用户自定义的标记，用于收藏/导航。 */
	setLabel(entryId: string, label: string | undefined): void;

	/** 执行一条 shell 命令。 */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** 获取当前激活的工具名列表。 */
	getActiveTools(): string[];

	/** 获取全部已配置工具：含参数 schema、提示词准则与来源元数据。 */
	getAllTools(): ToolInfo[];

	/** 按名称设置当前激活的工具集合。 */
	setActiveTools(toolNames: string[]): void;

	/** 获取当前会话可用的斜杠命令。 */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// 模型与思考级别（Model and Thinking Level）
	// =========================================================================

	/** 设置当前模型。无可用 API key 时返回 false。 */
	setModel(model: Model<any>): Promise<boolean>;

	/** 获取当前思考级别。 */
	getThinkingLevel(): ThinkingLevel;

	/** 设置思考级别（会被限制在模型能力范围内）。 */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider 注册（Provider Registration）
	// =========================================================================

	/**
	 * 注册或覆盖一个模型 provider。
	 *
	 * 提供 `models` 时：替换该 provider 名下的全部现有模型；
	 * 只提供 `baseUrl` 时：覆盖现有模型的请求 URL；
	 * 提供 `oauth` 时：注册 OAuth provider 以支持 /login；
	 * 提供 `streamSimple` 时：注册自定义 API 流式处理器。
	 *
	 * 初始扩展加载阶段调用会被排队，待 runner 绑定上下文后统一生效；
	 * 之后的调用立即生效，因此可安全地在命令处理器或事件回调中调用，
	 * 无需 `/reload`。
	 *
	 * @example
	 * // Register a new provider with custom models
	 * pi.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * pi.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // Register provider with OAuth support
	 * pi.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * 注销先前注册的 provider。
	 *
	 * 移除该 provider 名下的全部模型，并恢复被其覆盖的内置模型。
	 * provider 当前未注册时无任何效果。
	 *
	 * 与 `registerProvider` 一样，初始加载阶段之后调用会立即生效。
	 *
	 * @example
	 * pi.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	/** 扩展间通信的共享事件总线。 */
	events: EventBus;
}

// ============================================================================
// Provider 注册类型（Provider Registration Types）
// ============================================================================

/** 通过 pi.registerProvider() 注册 provider 时的配置。 */
export interface ProviderConfig {
	/** provider 在 UI 中的显示名。 */
	name?: string;
	/** API 端点的 base URL。定义模型时必填。 */
	baseUrl?: string;
	/** API key：字面量、环境变量插值（$ENV_VAR 或 ${ENV_VAR}）或以 ! 开头的命令。定义模型时必填（提供 oauth 时除外）。 */
	apiKey?: string;
	/** API 类型。定义模型时必须在 provider 或 model 级别指定。 */
	api?: Api;
	/**
	 * 可选的 streamSimple 处理器，用于自定义 API。
	 * 实现必须在发送 provider 请求之前调用 `options.onPayload` 并使用其返回的替换 payload；
	 * 必须在收到响应之后、消费响应体之前调用 `options.onResponse`，与内置 provider 保持一致。
	 */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** 请求中附带的自定义请求头。 */
	headers?: Record<string, string>;
	/** 为 true 时，附加 Authorization: Bearer 头（使用解析出的 API key）。 */
	authHeader?: boolean;
	/** 要注册的模型列表。提供时替换该 provider 名下全部现有模型。 */
	models?: ProviderModelConfig[];
	/**
	 * 刷新该 provider 的模型列表。返回的列表会替换扩展提供的模型。
	 * 需要跨会话持久化目录时，使用 context.publish({ persist: entry })。
	 */
	refreshModels?(context: RefreshModelsContext): Promise<ProviderModelConfig[]>;
	/** 用于 /login 支持的 OAuth provider。`id` 会从 provider 名自动生成。 */
	oauth?: {
		/** 登录 UI 中显示的名称。 */
		name: string;
		/** 该认证方式是否依托 provider 订阅（订阅制而非 API 计费）。 */
		isSubscription?: boolean;
		/** @deprecated 仅为源码兼容保留；规范认证流程会忽略它。 */
		usesCallbackServer?: boolean;
		/** 执行登录流程，返回待持久化的凭据。 */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** 刷新过期凭据，返回更新后的凭据用于持久化。 */
		refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
		/** 把凭据转换为该 provider 使用的 API key 字符串。 */
		getApiKey(credentials: OAuthCredentials): string;
		/** 旧版的同步模型投影：根据凭据调整模型列表。 */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** provider 内单个模型的配置。 */
export interface ProviderModelConfig {
	/** 模型 ID（如 "claude-sonnet-4-20250514"）。 */
	id: string;
	/** 显示名（如 "Claude 4 Sonnet"）。 */
	name: string;
	/** 该模型的 API 类型覆盖。 */
	api?: Api;
	/** 该模型的 API 端点 URL 覆盖。 */
	baseUrl?: string;
	/** 是否支持扩展思考（extended thinking）。 */
	reasoning: boolean;
	/** 把 pi 的思考级别映射为 provider/模型特定的值；null 表示该级别不受支持。 */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** 支持的输入类型。 */
	input: ("text" | "image")[];
	/** 每百万 token 的费率，以及可选的请求级输入定价分层。 */
	cost: Model<Api>["cost"];
	/** 最大上下文窗口（token 数）。 */
	contextWindow: number;
	/** 最大输出 token 数。 */
	maxTokens: number;
	/** 该模型的自定义请求头。 */
	headers?: Record<string, string>;
	/** OpenAI 兼容性设置。 */
	compat?: Model<Api>["compat"];
}

/** 扩展工厂函数类型：接收 ExtensionAPI（pi）完成订阅与注册。支持同步或异步初始化。 */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

/** 内联扩展：直接是工厂函数，或带元信息（名称/是否隐藏）的工厂包装对象。 */
export type InlineExtension =
	| ExtensionFactory
	| {
			/** 显示名，在启动时的 Extensions 列表中展示为 `<inline:name>`。 */
			name: string;
			factory: ExtensionFactory;
			/** 在启动时的 Extensions 列表中隐藏该扩展。 */
			hidden?: boolean;
	  };

// ============================================================================
// 已加载扩展的内部类型（Loaded Extension Types）—— loader/runner 使用
// ============================================================================

/** 已注册的工具：工具定义 + 来源信息。 */
export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/** 扩展注册的 CLI flag。 */
export interface ExtensionFlag {
	/** flag 名。 */
	name: string;
	/** flag 描述（--help 中展示）。 */
	description?: string;
	/** 值类型。 */
	type: "boolean" | "string";
	/** 默认值。 */
	default?: boolean | string;
	/** 注册该 flag 的扩展路径。 */
	extensionPath: string;
}

/** 扩展注册的键盘快捷键。 */
export interface ExtensionShortcut {
	/** 快捷键。 */
	shortcut: KeyId;
	/** 描述。 */
	description?: string;
	/** 按键处理器。 */
	handler: (ctx: ExtensionContext) => Promise<void> | void;
	/** 注册该快捷键的扩展路径。 */
	extensionPath: string;
}

/** 内部事件处理器签名（loader 侧统一存放，参数已擦除为 unknown）。 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

/** pi.sendMessage 的实现方签名（与 ExtensionAPI.sendMessage 对应）。 */
export type SendMessageHandler = <T = unknown>(
	message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

/** pi.sendUserMessage 的实现方签名。 */
export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
) => void;

/** pi.appendEntry 的实现方签名。 */
export type AppendEntryHandler = <T = unknown>(customType: string, data?: T) => void;

/** pi.setSessionName 的实现方签名。 */
export type SetSessionNameHandler = (name: string) => void;

/** pi.getSessionName 的实现方签名。 */
export type GetSessionNameHandler = () => string | undefined;

/** pi.getActiveTools 的实现方签名。 */
export type GetActiveToolsHandler = () => string[];

/** 工具信息：名称、描述、参数 schema、提示词准则与来源元数据。 */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
	sourceInfo: SourceInfo;
};

/** pi.getAllTools 的实现方签名。 */
export type GetAllToolsHandler = () => ToolInfo[];

/** pi.getCommands 的实现方签名。 */
export type GetCommandsHandler = () => SlashCommandInfo[];

/** pi.setActiveTools 的实现方签名。 */
export type SetActiveToolsHandler = (toolNames: string[]) => void;

/** pi.refreshTools 的实现方签名。 */
export type RefreshToolsHandler = () => void;

/** pi.setModel 的实现方签名。 */
export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

/** pi.getThinkingLevel 的实现方签名。 */
export type GetThinkingLevelHandler = () => ThinkingLevel;

/** pi.setThinkingLevel 的实现方签名。 */
export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

/** pi.setLabel 的实现方签名。 */
export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * loader 创建、在注册阶段与运行期共享的状态。
 * 包含 flag 值（注册阶段写默认值，之后写入 CLI 实际值）与排队中的 provider 注册等。
 */
export interface ExtensionRuntimeState {
	/** flag 名到当前值（CLI 值或默认值）的映射。 */
	flagValues: Map<string, boolean | string>;
	/** 扩展加载期间排队的旧式 provider-config 注册，runner 绑定时统一处理。 */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionPath: string }>;
	/** 扩展加载期间排队的原生 pi-ai provider 注册，runner 绑定时统一处理。 */
	pendingNativeProviderRegistrations: Array<{ provider: Provider; extensionPath: string }>;
	/** 运行时被替换后本扩展实例已过期时抛出异常（防止过期实例继续操作）。 */
	assertActive: () => void;
	/** 运行时替换或 reload 之后，将本扩展实例标记为过期。 */
	invalidate: (message?: string) => void;
	/** 登记一个事件总线订阅，使其随本运行时失效而自动退订；返回退订函数。 */
	trackEventBusSubscription: (unsubscribe: () => void) => () => void;
	/**
	 * 注册或注销 provider。
	 *
	 * bindCore() 之前：加入/移出待处理队列；
	 * bindCore() 之后：直接调用 ModelRegistry，立即生效。
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
	registerNativeProvider: (provider: Provider, extensionPath?: string) => void;
	unregisterProvider: (name: string, extensionPath?: string) => void;
}

/**
 * pi.* API 方法对应的动作实现集合。
 * 由宿主提供给 runner.initialize()，随后拷贝进共享运行时。
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * ExtensionContext（事件处理器中的 ctx.*）对应的动作实现集合。
 * 所有运行模式（tui/rpc/json/print）都必须提供。
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	getScopedModels: () => readonly ScopedModel[];
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
}

/**
 * ExtensionCommandContext（命令处理器中的 ctx.*）对应的动作实现集合。
 * 仅交互模式需要（只有该模式下扩展命令可被调用）。
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<{ cancelled: boolean }>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionPath: string,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
	reload: () => Promise<void>;
}

/**
 * 完整运行时 = 状态 + 动作。
 * 由 loader 先用「调用即抛错」的占位动作创建，runner.initialize() 再补齐真实实现。
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** 已加载的扩展：路径、来源及其注册的全部条目（处理器/工具/渲染器/命令/flag/快捷键）。 */
export interface Extension {
	/** 扩展模块的原始路径（loader 输入）。 */
	path: string;
	/** 解析后的绝对路径。 */
	resolvedPath: string;
	/** 是否在启动 Extensions 列表中隐藏。 */
	hidden?: boolean;
	/** 来源信息（文件/内联等）。 */
	sourceInfo: SourceInfo;
	/** 事件名到处理器列表的映射（保持注册顺序）。 */
	handlers: Map<string, HandlerFn[]>;
	/** 工具名到已注册工具的映射。 */
	tools: Map<string, RegisteredTool>;
	/** customType 到消息渲染器的映射。 */
	messageRenderers: Map<string, MessageRenderer>;
	/** Markdown 转换器（如有）。 */
	markdownTransformer?: MarkdownTransformer;
	/** customType 到条目渲染器的映射（如有）。 */
	entryRenderers?: Map<string, EntryRenderer>;
	/** 命令名到已注册命令的映射。 */
	commands: Map<string, RegisteredCommand>;
	/** flag 名到已注册 flag 的映射。 */
	flags: Map<string, ExtensionFlag>;
	/** 快捷键到已注册快捷键的映射。 */
	shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** 扩展加载结果：成功加载的扩展与加载失败的错误列表。 */
export interface LoadExtensionsResult {
	/** 成功加载的扩展。 */
	extensions: Extension[];
	/** 加载失败的扩展（路径 + 错误信息）。 */
	errors: Array<{ path: string; error: string }>;
	/** 共享运行时——在 runner.initialize() 之前，其动作均为抛错占位 */
	runtime: ExtensionRuntime;
}

// ============================================================================
// 扩展错误（Extension Error）
// ============================================================================

/** 扩展事件处理器抛出的错误记录。 */
export interface ExtensionError {
	/** 抛错的扩展路径。 */
	extensionPath: string;
	/** 触发错误的事件名。 */
	event: string;
	/** 错误信息。 */
	error: string;
	/** 错误堆栈（如有）。 */
	stack?: string;
}
