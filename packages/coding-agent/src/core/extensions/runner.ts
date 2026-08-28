/**
 * @file runner.ts —— 扩展运行器：扩展事件分发与拦截器执行的核心实现
 *
 * @description
 * 本文件实现 `ExtensionRunner` 类，作为宿主（coding-agent CLI）与已加载扩展之间的
 * 调度中枢，职责包括：
 * - 事件分发：把约 35 种扩展事件（tool_call / tool_result / message_end / context /
 *   session_before_* / input / resources_discover 等）按「扩展加载顺序 → 同一扩展内
 *   handler 注册顺序」串行 await 逐个派发；
 * - 拦截器管线：before/after 类钩子（emitBeforeAgentStart、emitToolResult、emitContext
 *   等）支持链式改写——前一个 handler 的输出作为后一个的输入；
 * - 错误隔离：绝大多数 handler 异常被捕获并转为 ExtensionError 经 emitError 上报，
 *   不会中断其他扩展的事件分发（例外：emitToolCall 不捕获，异常直接向上抛出）；
 * - 资源聚合：汇总各扩展注册的工具、命令、快捷键、flag、渲染器等资源，
 *   并处理命名冲突（快捷键与内置键位冲突、命令重名加序号后缀等）；
 * - 上下文工厂：createContext / createCommandContext 生成带失效保护（stale 检查）
 *   的扩展上下文；会话替换或 /reload 后旧上下文自动失效。
 *
 * 依赖关系：
 * - `./types.ts`：扩展事件、Extension、各事件 Result 等类型定义；
 * - `../model-registry.ts` / `../model-resolver.ts`：模型注册表与作用域模型解析；
 * - `../session-manager.ts`：会话管理（供扩展上下文直接访问）；
 * - `../../modes/interactive/theme/theme.ts`：noOp UI 上下文中兜底返回的主题。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model, Provider, ProviderHeaders } from "@earendil-works/pi-ai";
import type { KeyId } from "@earendil-works/pi-tui";
import { type Theme, theme } from "../../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { SessionManager } from "../session-manager.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	EntryRenderer,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCommand,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

// 扩展快捷键与 keybindings.json 里的规范键位 id 存在竞争关系。
// 这里只保留（reserve）编辑器全局快捷键；选择器（picker）专属键位不参与保留。
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

/** 内置键位表：规范化后的按键（小写 KeyId）→ { 键位 id, 是否为保留键位 } 的映射 */
type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

/**
 * 把 keybindings.json 解析出的键位配置反转成「按键 → 键位 id」查找表。
 *
 * restrictOverride 标记该键位是否属于保留键位（见 RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS）：
 * 保留键位不允许扩展覆盖，非保留键位允许扩展快捷键抢占（冲突仲裁见 getShortcuts）。
 */
const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		// 该键位被禁用（显式置空）时跳过
		if (keys === undefined) continue;
		// 同一动作可绑定多个按键（数组形式），统一展开为列表处理
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			// 按键统一小写规范化，保证后续查找大小写不敏感
			const normalizedKey = key.toLowerCase() as KeyId;
			// 若多个动作绑定了同一按键：保留动作优先获胜。这样无论遍历顺序如何，
			// 扩展都会被保留键位挡住，结果保持稳定。
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/**
 * 所有 before_agent_start handler 处理完毕后的合并结果：
 * messages 为各 handler 依序追加的注入消息列表，systemPrompt 为链式改写后的最终系统提示词。
 */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

/**
 * 由通用 emit() 方法分发的事件类型。
 * 拥有专属 emitXxx() 方法的事件（工具调用、消息结束等需要特殊归并逻辑的事件）
 * 被排除在外，以获得更强的类型安全。
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
>;

/** 会话变更前事件（切换 / fork / 压缩 / 树导航）的联合类型 */
type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

/** 四种会话变更前事件各自返回结果的联合类型 */
type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

/**
 * emit() 的返回值类型：仅 session_before_* 四种事件可能返回非 undefined 的结果
 * （其 handler 可返回取消/改写指令）；其余事件一律返回 undefined。
 * 通过嵌套条件类型把 TEvent 精确映射到对应的 Result 类型。
 */
type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

/** 扩展错误监听器：宿主经 onError 注册，扩展运行时错误统一通过此回调上报 */
export type ExtensionErrorListener = (error: ExtensionError) => void;

/**
 * 「新建会话」处理器：由宿主在 bindCommandContext 时注入。
 * cancelled 为 true 表示流程被取消（如用户在确认框中拒绝）。
 */
export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

/** 「fork 会话」处理器：在指定条目的前方/所在处分叉出新会话 */
export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

/** 「树导航」处理器：跳转到会话树中的目标节点，可附带摘要与自定义指令 */
export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

/** 「切换会话」处理器：按文件路径切换到另一个会话 */
export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

/** 「重载扩展」处理器：重新加载全部扩展代码 */
export type ReloadHandler = () => Promise<void>;

/** 「优雅停机」处理器：同步触发应用的退出流程 */
export type ShutdownHandler = () => void;

/**
 * 向所有扩展派发 session_shutdown 事件的辅助函数。
 * 返回 true 表示事件已派发（至少存在一个 handler）；false 表示没有任何 handler，未派发。
 * 调用方可据此决定是否需要等待扩展完成收尾工作。
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

/**
 * 派发 project_trust 事件（独立于 ExtensionRunner 实例的静态流程，用于扩展加载早期
 * 尚未创建 runner 时的项目信任决策）。
 *
 * 决策规则：第一个明确返回 yes/no 的 handler 胜出并立即返回；返回 undecided 则继续
 * 询问后续 handler。handler 抛出的异常被收集进 errors 返回，不中断询问流程。
 *
 * @returns result 为最终信任决策（undefined 表示无人做出决定）；errors 为收集到的扩展错误
 */
export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const ext of extensionsResult.extensions) {
		// 单个扩展可能为同一事件注册多个 handler。
		// 第一个返回 yes/no 的 project_trust handler 胜出；undecided 则继续向后传递。
		const handlers = ext.handlers.get("project_trust");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionPath: ext.path,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

/**
 * 全部方法均为空实现的 UI 上下文兜底对象。
 * 用于无 UI 场景（print 模式）或宿主尚未调用 setUIContext 时：
 * 保证扩展调用 UI API 不会崩溃，而是得到安全的默认值（confirm 返回 false、
 * getEditorText 返回空串等）。主题 getter 返回全局 theme 作为兜底。
 */
const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

/**
 * 扩展运行器：管理已加载扩展的调度与生命周期。
 *
 * 核心职责：
 * 1. 事件分发（emit* 系列方法）：按扩展加载顺序遍历，把事件交给各扩展注册的 handler；
 * 2. 资源聚合与冲突仲裁：工具/命令/快捷键/flag/渲染器的汇总查询，重名命令加 `:序号`
 *    后缀、快捷键与内置键位冲突处理等；
 * 3. 上下文工厂：createContext / createCommandContext 生成带 stale 失效校验的扩展
 *    上下文，会话被替换或扩展被 /reload 后旧上下文自动失效并抛错；
 * 4. 宿主能力注入：bindCore（消息、工具、模型等核心 action）、
 *    bindCommandContext（会话操作）、setUIContext（交互 UI）。
 *
 * 错误隔离策略：handler 异常被捕获并转为 ExtensionError 分发给 errorListeners，
 * 单个扩展出错不影响其他扩展继续接收事件。
 */
export class ExtensionRunner {
	/** 已加载的扩展列表（保持加载顺序，事件按此顺序派发） */
	private extensions: Extension[];
	/** 所有扩展共享的运行时对象（扩展 API 直接引用它，bindCore 时填充核心 action） */
	private runtime: ExtensionRuntime;
	private uiContext: ExtensionUIContext;
	private mode: ExtensionMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	/** 扩展错误监听器集合；emitError 时逐个通知 */
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	// ===== 宿主能力回调（bindCore / bindCommandContext 注入；以下默认值均为安全的
	// 空实现，保证宿主完成绑定之前调用这些能力不会崩溃）=====
	private getModel: () => Model<any> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	/** 失效提示信息；会话替换或 /reload 后由 invalidate() 设置，此后旧上下文的访问都会抛错 */
	private staleMessage: string | undefined;

	// 构造时只做基础注入；核心 action 与命令上下文需随后经 bindCore / bindCommandContext 绑定
	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.extensions = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
	}

	/**
	 * 绑定核心宿主能力。
	 *
	 * actions 会被拷贝进共享的 runtime 对象（扩展侧 API 直接引用该对象）；
	 * contextActions 提供模型查询、中断、上下文用量等只读/控制能力；
	 * providerActions 可选，提供供应商注册的宿主实现（缺省时回退到 modelRegistry）。
	 */
	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			registerNativeProvider?: (provider: Provider) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// 把 action 拷贝进共享 runtime（所有扩展 API 都引用这个对象）
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// 上下文 action（必选）
		this.getModel = contextActions.getModel;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));

		// 冲刷扩展加载阶段排队的供应商注册请求（此刻宿主 action 才刚可用）
		for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];
		for (const { provider, extensionPath } of this.runtime.pendingNativeProviderRegistrations) {
			try {
				if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(provider);
				} else {
					this.modelRegistry.registerProvider(provider);
				}
			} catch (err) {
				this.emitError({
					extensionPath,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingNativeProviderRegistrations = [];

		// 从这里开始，供应商的注册/注销立即生效，不再需要 /reload。
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	/**
	 * 绑定命令上下文能力（新建会话 / fork / 切换、树导航、reload、waitForIdle）。
	 * 未传入 actions 时重置为空实现——命令仍可调用，但只得到「未取消」的空结果。
	 */
	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
		this.reloadHandler = async () => {};
	}

	/** 设置 UI 上下文；未提供时回退到 noOpUIContext。mode 记录当前运行模式（interactive / print 等） */
	setUIContext(uiContext?: ExtensionUIContext, mode: ExtensionMode = "print"): void {
		this.uiContext = uiContext ?? noOpUIContext;
		this.mode = mode;
	}

	/** 获取当前 UI 上下文（可能是 noOp 兜底对象） */
	getUIContext(): ExtensionUIContext {
		return this.uiContext;
	}

	/** 是否存在真实 UI；为 false 时扩展应避免调用交互式 UI API */
	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	/** 所有已加载扩展的文件路径列表 */
	getExtensionPaths(): string[] {
		return this.extensions.map((e) => e.path);
	}

	/** 汇总所有扩展注册的工具；同名工具先注册者胜出（按扩展加载顺序） */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** 按名称查找工具定义；找不到时返回 undefined */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	/** 汇总所有扩展注册的 flag；同名 flag 先注册者胜出 */
	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	/** 写入 flag 当前值（存于共享 runtime，扩展侧可读取） */
	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	/** 读取全部 flag 当前值的拷贝（避免调用方直接修改 runtime 状态） */
	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	/**
	 * 解析所有扩展注册的快捷键，产出「按键 → 扩展快捷键」映射。
	 *
	 * 冲突仲裁规则（同时记录警告诊断，可经 getShortcutDiagnostics 获取）：
	 * - 与保留的内置键位冲突：直接跳过，扩展快捷键失效；
	 * - 与非保留内置键位冲突：扩展快捷键覆盖内置键位；
	 * - 多个扩展注册同一按键：后遍历到的扩展胜出。
	 */
	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, extensionPath: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
			// 无 UI 时诊断无处展示，退化为 console.warn 输出，避免警告被静默吞掉
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				// 保留键位（中断/退出等核心操作）不可被扩展覆盖：跳过并记录诊断
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
						shortcut.extensionPath,
					);
					continue;
				}

				// 非保留键位：允许扩展覆盖内置键位，但仍记录诊断提示用户
				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}

				// 扩展之间冲突：后注册者胜出（Map.set 直接覆盖），并记录诊断
				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
						shortcut.extensionPath,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	/** 最近一次 getShortcuts() 产生的冲突诊断列表 */
	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	/**
	 * 标记当前 runner 失效（会话替换或 /reload 后调用）。
	 * 幂等：只有第一次调用会传播到 runtime.invalidate，后续调用直接忽略，
	 * 避免覆盖最早（通常也最具体）的失效提示信息。
	 */
	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	/** 失效守卫：runner 已被 invalidate 时抛出 staleMessage，阻止旧上下文继续被使用 */
	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	/** 注册扩展错误监听器；返回用于取消注册的函数 */
	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** 把扩展错误广播给所有监听器（通常是宿主的错误提示 UI） */
	emitError(error: ExtensionError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	/** 是否有任一扩展注册了指定类型的事件 handler（宿主可借此跳过无意义的派发） */
	hasHandlers(eventType: string): boolean {
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	/** 按自定义消息类型查找首个注册的消息渲染器 */
	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/** 收集所有扩展注册的 markdown 转换器（每个扩展最多注册一个） */
	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.extensions.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	/** 按自定义类型查找首个注册的会话条目渲染器 */
	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/**
	 * 解析所有扩展注册的命令，为重名命令生成唯一的调用名（invocationName）：
	 * 同名命令出现多次时，依次追加 `:1`、`:2` 序号；若序号名仍被占用则继续递增避让
	 * （例如某扩展恰好注册了字面量名为 "foo:2" 的命令）。
	 */
	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		// 第一遍：收集全部命令并统计每个名字出现的次数
		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		// 第二遍：按出现序号为重名命令分配唯一的调用名
		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			// 名字唯一时直接使用原名；重名则加 `:出现序号` 后缀
			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			// 极端情形：生成的序号名恰好撞上已占用的名字，继续递增直到不冲突
			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	/** 获取共享的模型注册表 */
	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	/** 重新解析全部注册命令（顺带清空命令诊断缓存） */
	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	/** 最近一次 getRegisteredCommands() 产生的命令诊断列表 */
	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	/** 按调用名（含重名序号后缀）查找命令 */
	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * 请求优雅停机。由扩展工具和事件 handler 调用。
	 * 实际的停机行为由各运行模式（interactive/print 等）在 bindCore 时注入。
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	/** 获取当前激活的工具名列表（含 stale 校验） */
	getActiveTools(): string[] {
		this.assertActive();
		return this.runtime.getActiveTools();
	}

	/**
	 * 创建供事件 handler 与工具执行使用的 ExtensionContext。
	 * 上下文的值在访问时才解析（getter 惰性求值），因此 bindCore / setUIContext 之后
	 * 的变化也能被已发出的上下文感知到；每个 getter / 方法都先经过 assertActive 失效守卫。
	 */
	createContext(): ExtensionContext {
		const runner = this;
		const getModel = this.getModel;
		const getScopedModels = this.getScopedModels;
		// 所有 getter 与方法都先做 stale 校验：会话替换或 reload 后误用旧上下文会立刻抛错
		return {
			get ui() {
				runner.assertActive();
				return runner.uiContext;
			},
			get mode() {
				runner.assertActive();
				return runner.mode;
			},
			get hasUI() {
				runner.assertActive();
				return runner.hasUI();
			},
			get cwd() {
				runner.assertActive();
				return runner.cwd;
			},
			get sessionManager() {
				runner.assertActive();
				return runner.sessionManager;
			},
			get modelRegistry() {
				runner.assertActive();
				return runner.modelRegistry;
			},
			get model() {
				runner.assertActive();
				return getModel();
			},
			get scopedModels() {
				runner.assertActive();
				return getScopedModels();
			},
			get thinkingLevel() {
				runner.assertActive();
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				runner.assertActive();
				return runner.isIdleFn();
			},
			isProjectTrusted: () => {
				runner.assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				runner.assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				runner.assertActive();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				runner.assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				runner.assertActive();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				runner.assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.assertActive();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				runner.assertActive();
				return runner.getSystemPromptFn();
			},
		};
	}

	/**
	 * 创建命令上下文：在 createContext() 的基础上追加命令专属能力
	 * （waitForIdle / newSession / fork / navigateTree / switchSession / reload /
	 * getSystemPromptOptions），全部带 stale 校验。
	 */
	createCommandContext(): ExtensionCommandContext {
		// 使用属性描述符而非对象展开，以保留 createContext() 中带守卫 getter 的惰性。
		// 展开会立即读取一次 getter 并把旧值固化到返回对象里，从而绕过失效（stale）检查。
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionCommandContext;
		context.getSystemPromptOptions = () => {
			this.assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			this.assertActive();
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			this.assertActive();
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			this.assertActive();
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			this.assertActive();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			this.assertActive();
			return this.switchSessionHandler(sessionPath, options);
		};
		context.reload = () => {
			this.assertActive();
			return this.reloadHandler();
		};
		return context;
	}

	/** 类型守卫：判断事件是否属于四种 session_before_* 之一 */
	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	/**
	 * 通用事件派发入口：按「扩展加载顺序 → 扩展内 handler 注册顺序」串行 await 逐个调用。
	 *
	 * 返回值语义：只有 session_before_* 事件会收集 handler 结果——后一个 handler 的
	 * 结果覆盖前一个；一旦某个结果带 cancel: true 立即短路返回（不再通知后续扩展）。
	 * 其他事件的 handler 返回值一律被忽略。
	 *
	 * 错误隔离：单个 handler 抛错被捕获并经 emitError 上报（附带扩展路径与事件名），
	 * 分发继续进行，不影响其余扩展。
	 */
	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			// 该扩展未注册此事件的 handler，跳过
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					// session_before_* 事件：记录最新结果；cancel 则短路，阻止后续 handler 执行
					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					// 错误隔离：转为 ExtensionError 上报，不中断后续 handler
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	/**
	 * 派发 message_end 事件：允许 handler 链式改写刚生成完毕的助手消息。
	 *
	 * 管线语义：前一个 handler 的输出消息作为后一个 handler 的输入（每步重建事件快照）。
	 * 约束：handler 只能返回同角色（role）的消息——试图改变角色会被记为错误，
	 * 该次改写被丢弃但分发继续。所有 handler 均未修改时返回 undefined
	 * （宿主据此保留原消息对象）。
	 */
	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("message_end");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					// 每次用「当前最新消息」重建事件快照，实现链式改写
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					// 角色校验：只允许改内容不允许换角色，违规改写被丢弃并上报错误
					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	/**
	 * 派发 tool_result 事件：允许 handler 逐字段改写工具执行结果。
	 *
	 * 管线语义：改写在同一个事件快照上累积——handler 返回对象中「显式定义」
	 * （!== undefined）的字段（content / details / isError / usage）覆盖快照对应字段，
	 * 未提及的字段保持原值；快照继续作为后续 handler 的输入。
	 * 全部 handler 处理后若无任何字段被修改则返回 undefined（宿主按未改写处理）。
	 */
	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
					if (!handlerResult) continue;

					// 仅覆盖显式返回（!== undefined）的字段，未提及的字段保持原值
					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		// 无任何修改时返回 undefined，宿主按「结果未被改写」处理
		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	/**
	 * 派发 tool_call 事件（工具执行前的拦截点）。
	 *
	 * 语义：后一个 handler 的结果覆盖前一个；一旦结果带 block（拦截该次调用）
	 * 立即短路返回。与多数 emitXxx 不同，这里没有 try/catch——handler 异常会
	 * 直接向上抛出，由调用方（Agent 循环）决定如何处置（如转为工具错误）。
	 */
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				// 注意：此事件无错误隔离，handler 异常直接向上传播
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					// 首个 block 结果立即短路，后续扩展不再收到该事件
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	/**
	 * 派发 user_bash 事件（用户即将执行 bash 命令前的拦截点）。
	 * 首个返回结果的 handler 胜出并立即短路返回；无人处理时返回 undefined（放行命令）。
	 * handler 异常被隔离上报，不影响命令执行。
	 */
	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("user_bash");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);
					// 首个非空结果胜出（如 block 拦截该命令），立即短路
					if (handlerResult) {
						return handlerResult as UserBashEventResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "user_bash",
						error: message,
						stack,
					});
				}
			}
		}

		return undefined;
	}

	/**
	 * 派发 context 事件：消息发送给 LLM 之前，允许 handler 链式改写上下文消息列表。
	 *
	 * 输入先做 structuredClone 深拷贝——扩展改写的是副本，原始会话消息不会被污染；
	 * 每个 handler 收到「上一个 handler 输出」的消息列表，返回新的列表则继续向下传递。
	 * handler 异常被隔离上报，链式改写继续。
	 */
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					// 返回了新消息列表则替换当前列表，供下一个 handler 与最终返回使用
					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		return currentMessages;
	}

	/**
	 * 派发 before_provider_request 事件：LLM 请求体发出前的最后一个改写点。
	 *
	 * 管线语义：handler 返回非 undefined 的值即替换 currentPayload，并作为下一个
	 * handler 的输入；返回 undefined 表示保持不变。payload 是 provider 原生的
	 * 请求对象（结构因 provider 而异，故类型为 unknown）。
	 */
	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await handler(event, ctx);
					// 非 undefined 才替换：允许 handler 只观察不修改
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	/**
	 * 派发 before_provider_headers 事件：LLM 请求头发送前的改写点。
	 * 与其他事件不同，handler 直接原地（in place）修改传入的 headers 对象，
	 * 返回值被忽略；最终返回同一个 headers 引用。
	 */
	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const ctx = this.createContext();

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_headers");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					// handler 原地修改 `headers`；返回值被忽略。
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
					};
					await handler(event, ctx);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	/**
	 * 派发 before_agent_start 事件：Agent 循环启动前的注入点。
	 *
	 * handler 可做两类事：
	 * 1. 返回 message —— 向上下文追加额外消息（所有 handler 的追加按执行顺序累积）；
	 * 2. 返回 systemPrompt —— 链式改写系统提示词（后者覆盖前者）。
	 * ctx.getSystemPrompt 被覆写为动态读取 currentSystemPrompt，让后续 handler
	 * 始终看到链式改写过程中的最新提示词。两者都未发生时返回 undefined。
	 */
	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		let currentSystemPrompt = systemPrompt;
		// 与 createCommandContext 相同：用属性描述符复制以保持 getter 惰性
		const ctx = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ExtensionContext;
		// 覆盖 getSystemPrompt：让扩展读到「链式改写过程中」的最新系统提示词
		ctx.getSystemPrompt = () => {
			this.assertActive();
			return currentSystemPrompt;
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						systemPrompt: currentSystemPrompt,
						systemPromptOptions,
					};
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						// 追加的消息按 handler 执行顺序累积
						if (result.message) {
							messages.push(result.message);
						}
						// 系统提示词最终为「最后一个非 undefined」的返回值
						if (result.systemPrompt !== undefined) {
							currentSystemPrompt = result.systemPrompt;
							systemPromptModified = true;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		// 无任何注入/改写时返回 undefined，宿主按原样启动循环
		if (messages.length > 0 || systemPromptModified) {
			return {
				messages: messages.length > 0 ? messages : undefined,
				systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
			};
		}

		return undefined;
	}

	/**
	 * 派发 resources_discover 事件：让扩展按需暴露其携带的资源
	 * （skill / prompt / theme 的文件路径），并标注来源扩展路径。
	 * 各 handler 返回的路径被合并（而非覆盖）进三个聚合列表；
	 * reason 说明触发场景（如启动、reload），扩展可据此决定是否返回。
	 */
	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: Array<{ path: string; extensionPath: string }>;
		promptPaths: Array<{ path: string; extensionPath: string }>;
		themePaths: Array<{ path: string; extensionPath: string }>;
	}> {
		const ctx = this.createContext();
		const skillPaths: Array<{ path: string; extensionPath: string }> = [];
		const promptPaths: Array<{ path: string; extensionPath: string }> = [];
		const themePaths: Array<{ path: string; extensionPath: string }> = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await handler(event, ctx);
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					// 合并语义：给路径打上来源扩展标签后追加，不覆盖其他扩展的结果
					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map((path) => ({ path, extensionPath: ext.path })));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/**
	 * 派发 input 事件：用户输入提交前的拦截点。
	 * 两种 action：transform —— 改写文本/图片后继续传递给后续 handler（链式）；
	 * handled —— 输入已被扩展完全处理，立即短路返回（宿主不再提交该输入）。
	 * 全部 handler 走完且内容有变化时返回 transform，否则返回 continue。
	 */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			for (const handler of ext.handlers.get("input") ?? []) {
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					// handled：输入已被扩展消化，立即短路返回
					if (result?.action === "handled") return result;
					// transform：用改写后的内容继续走后续 handler（images 未提供则保持原值）
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						extensionPath: ext.path,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		// 通过引用比较判断输入是否被改写过；未改写则告知宿主按原样继续提交
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
