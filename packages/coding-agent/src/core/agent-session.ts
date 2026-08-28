/**
 * @file agent-session.ts —— AgentSession：Agent 生命周期与会话管理的核心抽象（域层，无 I/O）
 *
 * @description
 * `AgentSession` 是三种运行模式（interactive 交互式 TUI / print 一次性打印 / rpc 服务模式）
 * 共享的会话核心。各模式在它之上叠加自己的 I/O 层（终端渲染、stdio、JSON-RPC 等），
 * 本类本身不直接做任何输入输出。
 *
 * 主要职责：
 * - Agent 状态的只读访问代理（模型、思考级别、消息列表、工具集、系统提示词）；
 * - 事件订阅与分发：把底层 AgentEvent 转发给监听器和扩展系统，
 *   并在 message_end 时自动完成会话持久化（写入 SessionManager）；
 * - 模型与思考级别管理：直接设定，以及循环切换（scoped 列表 / 全量可用列表）；
 * - Compaction（上下文压缩）：手动触发、阈值自动触发、上下文溢出恢复三种来源；
 * - Bash 执行的排队、abort 管理与消息化；
 * - 会话切换与分支（fork / 树导航）相关的分支摘要生成；
 * - steering / follow-up 消息队列：流式运行期间的用户输入排队与投递；
 * - 失败自动重试（auto-retry）与上下文溢出恢复的状态跟踪。
 *
 * 依赖关系：
 * - `@earendil-works/pi-agent-core`：Agent 循环本体及 AgentEvent / AgentMessage / AgentState 等类型；
 * - `@earendil-works/pi-ai`：模型、认证（AuthResult）、流式调用、思考级别与用量统计；
 * - `./session-manager.ts`：会话条目（SessionEntry）的持久化与分支树导航；
 * - `./compaction/index.ts`：压缩判定（shouldCompact）、准备与执行；
 * - `./extensions/*`：扩展运行器（ExtensionRunner）与工具注册包装；
 * - `./system-prompt.ts` + `./resource-loader.ts`：系统提示词构建与资源（技能/模板/主题）加载；
 * - `./model-runtime.ts`：模型与认证的统一运行时（本包内部规范入口）。
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	AuthResult,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@earendil-works/pi-ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	isRetryableAssistantError,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "./defaults.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
// 扩展系统的大量类型与运行器统一从 extensions/index.ts 汇出（barrel 模块）
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionCompactFailedEvent,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { BashExecutionMessage, CustomMessage } from "./messages.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { exportSessionToJsonl } from "./session-export.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { getLatestCompactionEntry } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

// ============================================================================
// Skill 块解析（/skill:name 命令展开后生成的消息格式）
// ============================================================================

/** 从用户消息文本中解析出的 skill 块（格式见 {@link parseSkillBlock}） */
export interface ParsedSkillBlock {
	/** 技能名称（对应 <skill name="..."> 属性） */
	name: string;
	/** 技能文件路径（对应 location 属性），技能内的相对引用以此目录为基准 */
	location: string;
	/** <skill> 标签内的完整正文（已剥离 frontmatter 的技能内容） */
	content: string;
	/** 紧跟在 </skill> 之后的用户补充输入；没有则为 undefined */
	userMessage: string | undefined;
}

/**
 * 从消息文本中解析出 skill 块。
 *
 * 期望格式（由 _expandSkillCommand 展开 /skill:name 命令时生成）：
 * `<skill name="..." location="...">\n内容\n</skill>`，其后可跟一段可选的用户补充输入。
 * 文本不符合该格式时返回 null（而非抛错），由调用方决定如何处理。
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		// 空串归一化为 undefined，避免下游把空输入当成有效补充消息
		userMessage: match[4]?.trim() || undefined,
	};
}

/**
 * 会话层事件：在核心 AgentEvent 之上扩展的会话专属事件联合类型。
 *
 * 相比 pi-agent-core 的 AgentEvent，主要新增：
 * - agent_end 携带 willRetry（失败后是否将自动重试，供 UI 显示「重试中」状态）；
 * - 队列变化（queue_update）、压缩（compaction_*）、自动重试（auto_retry_*）、
 *   摘要生成重试（summarization_retry_*）、bash 输出增量（bash_execution_update）等
 *   只有宿主会话层才知道的状态。
 */
export type AgentSessionEvent =
	// 透传核心事件，但排除原版 agent_end（见下方带 willRetry 的版本）
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			/** 本次运行因可重试错误结束、且未超出重试上限时为 true，随后会自动发起重试 */
			willRetry: boolean;
	  }
	/** 一次运行及其全部后续动作（重试、自动压缩、排队续跑）彻底结束，会话回到空闲 */
	| { type: "agent_settled" }
	/** steering / follow-up 待投递队列内容发生变化 */
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	/** 压缩开始；reason 区分手动触发 / 阈值触发 / 上下文溢出恢复 */
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	/** 会话文件追加了一条新条目（消息、模型切换、分支等） */
	| { type: "entry_appended"; entry: SessionEntry }
	/** 会话显示名称变化 */
	| { type: "session_info_changed"; name: string | undefined }
	/** 思考级别变化 */
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	/** 自动重试开始（第 attempt 次，共 maxAttempts 次，间隔 delayMs） */
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	/** 自动重试结束；success 为 false 时 finalError 携带最终错误信息 */
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	/** 分支摘要/压缩的摘要生成失败后，某次重试尝试开始 */
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	/** 摘要生成重试流程结束（无论成败） */
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	// NOTE: auto_retry_end 在上面已声明过一次（上游如此），此处保持原样
	/** bash 执行的增量输出（id 用于关联具体某次执行） */
	| { type: "bash_execution_update"; id?: string; delta: string };

/** AgentSessionEvent 事件监听器：各运行模式的 UI / RPC 层通过它接收会话事件 */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 过滤掉值为 null 的请求头。
 * ProviderHeaders 中值为 null 表示「该头已被用户显式删除」，不应发送给供应商；
 * 其余键值原样保留。传入 undefined 时直接返回 undefined。
 */
function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

/** AgentSession 构造配置 */
export interface AgentSessionConfig {
	/** 底层 Agent 实例（来自 pi-agent-core，持有循环状态与消息历史） */
	agent: Agent;
	/** 会话持久化管理器（负责会话文件读写与分支树） */
	sessionManager: SessionManager;
	/** 用户设置管理器（默认模型、重试、图片缩放等全局设置） */
	settingsManager: SettingsManager;
	/** 工作目录（用于系统提示词、bash 执行等） */
	cwd: string;
	/** 供 Ctrl+P 循环切换的模型列表（来自 --models 启动参数） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** 资源加载器：扩展、技能、提示词模板、主题、上下文文件与系统提示词均由它提供 */
	resourceLoader: ResourceLoader;
	/** SDK 侧注册的自定义工具（不走扩展系统） */
	customTools?: ToolDefinition[];
	/** coding-agent 内部使用的规范模型/认证运行时 */
	modelRuntime: ModelRuntime;
	/** 初始启用的内置工具名列表。默认：[read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** 可选的工具名允许列表。提供后仅暴露列表内的工具。 */
	allowedToolNames?: string[];
	/** 可选的工具名拒绝列表。提供后列表内的工具不会被暴露。 */
	excludedToolNames?: string[];
	/**
	 * 覆盖基础工具集（自定义运行时场景使用）。
	 *
	 * 这些 AgentTool 会在内部被合成为最小化的 ToolDefinition，
	 * 使得即使调用方传入的是裸 AgentTool 实例，
	 * AgentSession 依然能维持「以定义（definition）为先」的工具注册表。
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** 可变引用：Agent 通过它在运行时读到当前的 ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** 扩展绑定到本运行时时会话启动事件的元数据 */
	sessionStartEvent?: SessionStartEvent;
}

/** 扩展绑定：各运行模式把自己的 I/O 能力与回调挂到这里，注入扩展上下文 */
export interface ExtensionBindings {
	/** 扩展可用的 UI 上下文（渲染工具、选择器等）；print 等无 UI 模式下缺省 */
	uiContext?: ExtensionUIContext;
	/** 当前运行模式标识，扩展据此调整自身行为 */
	mode?: ExtensionMode;
	/** 扩展命令上下文可触发的动作（会话控制等入口） */
	commandContextActions?: ExtensionCommandContextActions;
	/** 中断当前 agent 运行的回调（供扩展主动触发 abort） */
	abortHandler?: () => void;
	/** 会话关闭时调用的清理回调 */
	shutdownHandler?: ShutdownHandler;
	/** 扩展错误监听器 */
	onError?: ExtensionErrorListener;
}

/** AgentSession.prompt() 的可选项 */
export interface PromptOptions {
	/** 是否分发扩展命令并展开技能命令与提示词模板（默认 true） */
	expandPromptTemplates?: boolean;
	/** 随消息附带的图片附件 */
	images?: ImageContent[];
	/** 流式运行期间如何排队该消息："steer"（尽快打断注入）或 "followUp"（等运行结束）。流式时必填。 */
	streamingBehavior?: "steer" | "followUp";
	/** 输入来源，供扩展 input 事件处理器区分。默认 "interactive"。 */
	source?: InputSource;
	/** 内部钩子：RPC 模式用它观察 prompt 预检（发送前校验）的接受/拒绝结果。 */
	preflightResult?: (success: boolean) => void;
}

/** 模型/思考级别变更的可选项 */
export interface ModelMutationOptions {
	/** 是否把新值持久化到全局默认设置。默认仅对当前会话生效。 */
	persist?: boolean;
}

/** cycleModel() 的返回结果 */
export interface ModelCycleResult {
	/** 切换后的新模型 */
	model: Model<any>;
	/** 切换后生效的思考级别（已按模型能力收敛） */
	thinkingLevel: ThinkingLevel;
	/** 是否在 scoped 模型列表（--models 参数）中循环；false 表示在全量可用模型中循环 */
	isScoped: boolean;
}

/** /session 命令展示的会话统计信息 */
export interface SessionStats {
	/** 会话文件路径；会话持久化被禁用时为 undefined */
	sessionFile: string | undefined;
	/** 会话 ID */
	sessionId: string;
	/** 用户消息数 */
	userMessages: number;
	/** 助手消息数 */
	assistantMessages: number;
	/** 工具调用数 */
	toolCalls: number;
	/** 工具结果数 */
	toolResults: number;
	/** 消息总数 */
	totalMessages: number;
	/** token 用量明细 */
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	/** 累计成本（美元） */
	cost: number;
	/** 当前上下文占用情况（估算值） */
	contextUsage?: ContextUsage;
}

/** 工具注册表条目：工具定义 + 来源元信息（用于 UI 展示该工具来自哪里） */
interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

/** 粗略估算一组消息的总 token 数（逐条累加 estimateTokens） */
function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// 常量
// ============================================================================

// ============================================================================
// AgentSession 类
// ============================================================================

/**
 * Agent 会话核心：包装底层 Agent，向上层（TUI / RPC / print 三种模式）提供统一的会话 API。
 *
 * 定位是纯域层——只做状态管理与编排，不做任何终端输出或网络 I/O 之外的展示。
 * 核心机制：
 * - 构造时订阅 agent 事件（_handleAgentEvent），在这里统一完成
 *   「扩展分发 → 会话持久化 → 自动压缩判定 → 重试判定」的管道处理；
 * - 每次 prompt 走 _runAgentPrompt：跑完主循环后不断检查
 *   「是否需要重试 / 是否需要压缩 / 是否还有排队消息」，需要则自动 continue 续跑；
 * - 工具注册表以 ToolDefinition 为先（definition-first），agent.state.tools 只是它的投影；
 * - 扩展钩子（beforeToolCall / afterToolCall / prepareNextTurnWithContext）只安装一次，
 *   回调在执行期读取 this._extensionRunner，因此扩展热重载无需重装钩子。
 */
export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	/** Ctrl+P 循环切换用的 scoped 模型列表（--models 参数） */
	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// 事件订阅状态
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	/** 是否有 agent 运行（或其后续动作：重试/自动压缩/续跑）正在进行 */
	private _isAgentRunActive = false;
	/** waitForIdle() 等待的 Promise：运行结束时 resolve，实现「等待空闲」 */
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** 排队中的 steering 消息（供 UI 显示）。投递后移除。 */
	private _steeringMessages: string[] = [];
	/** 排队中的 follow-up 消息（供 UI 显示）。投递后移除。 */
	private _followUpMessages: string[] = [];
	/** 排队待随下一条用户 prompt 一并注入上下文的自定义消息（"旁白"） */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	/** 运行期间排队的纯上下文自定义消息；当前轮工具结果落盘后统一冲刷 */
	private _pendingCustomMessages: CustomMessage[] = [];

	// 压缩（compaction）状态
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	/** 本次溢出恢复是否已尝试过，防止同一故障反复触发恢复 */
	private _overflowRecoveryAttempted = false;

	// 分支摘要生成状态
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// 自动重试状态
	private _retryAbortController: AbortController | undefined = undefined;
	/** 当前重试次数（从 0 开始；收到成功响应即归零） */
	private _retryAttempt = 0;

	// Bash 执行状态
	private readonly _bashAbortControllers = new Set<AbortController>();
	/** 待写入会话/状态的 bash 执行消息，在下个安全时机统一冲刷 */
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// 扩展系统
	private _extensionRunner!: ExtensionRunner;
	/** 当前 agent 运行内的轮次序号（turn_start/turn_end 事件使用） */
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;

	// 工具注册表（供扩展 getTools/setTools 使用）。
	// 双 Map 设计：_toolRegistry 存可执行 AgentTool（启用工具时取实例），
	// _toolDefinitions 存定义与来源元信息（列表/查询用），二者键一致
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	/** 每个工具注入系统提示词的说明片段 */
	private _toolPromptSnippets: Map<string, string> = new Map();
	/** 每个工具附带的使用准则（多行） */
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// 基础系统提示词（不含扩展追加段）——每轮据此重新应用扩展追加，避免叠加污染
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	/** 扩展在本次运行内对系统提示词的临时覆盖；运行结束自动清除 */
	private _systemPromptOverride?: string;

	/**
	 * 构造函数：保存配置、订阅 agent 事件、安装工具/回合钩子，并完成首次运行时构建。
	 * 运行时构建（_buildRuntime）会装配扩展运行器、工具注册表与初始系统提示词。
	 */
	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };

		// 始终订阅 agent 事件以便内部处理
		//（会话持久化、扩展分发、自动压缩、重试逻辑都在 _handleAgentEvent 中进行）
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentNextTurnRefresh();

		// 首次构建运行时：按初始启用名单装配工具，并纳入扩展注册的全部工具
		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	/** 访问构造时注入的模型/认证运行时（模式层用它做模型列表、认证等查询） */
	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	/**
	 * 解析模型发起 LLM 请求所必需的认证信息（严格版）。
	 *
	 * 工作流程：向 modelRuntime 查询认证 → 组装 apiKey / headers / env /（可选的）baseUrl 覆盖。
	 * 拿不到可用凭据时抛出可操作的错误：
	 * - 底层因 authHeader 缺 API key 抛错 → 转换为「未找到 API key」的引导信息；
	 * - OAuth 供应商凭据失效 → 提示运行 /login 重新认证；
	 * - 其余情况 → 通用「未找到 API key」信息。
	 */
	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				// 把底层晦涩的报错翻译成带操作指引的用户提示
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			// 认证结果可能带 baseUrl 覆盖（如自定义网关），合并进请求模型
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		// OAuth 供应商与静态 API key 的失败提示不同：前者引导重新登录
		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * 解析摘要生成（compaction / 分支摘要）用的认证信息（宽松版）。
	 *
	 * 摘要属于辅助功能：认证失败时不应阻断主流程，因此任何异常都降级为
	 * 「不带凭据直接返回原模型」，交给后续调用自行失败或由自定义流函数处理。
	 * 例外：使用 streamSimple（无自定义鉴权层）时必须走严格版，因为请求必然需要凭据。
	 */
	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this.agent.streamFunction === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			// 认证解析失败不阻断摘要流程：返回裸模型，让调用方容错
			return { model };
		}
	}

	/**
	 * 在 Agent 实例上一次性安装工具钩子（beforeToolCall / afterToolCall）。
	 *
	 * 回调在执行期读取 `this._extensionRunner`，因此扩展重载只需换入新的 runner，
	 * 无需重新安装钩子。扩展专属的工具包装器仍用于把注册工具的执行适配到扩展上下文；
	 * 工具调用与工具结果的拦截现在发生在这里，而不是在包装器里。
	 */
	private _installAgentToolHooks(): void {
		// 工具执行前钩子：分发给扩展的 tool_call 处理器；处理器抛错则阻断该次执行
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			// 没有注册处理器时直接放行（返回 undefined 表示不干预）
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				// 非 Error 抛出物统一包装成 Error，保证上层能正常传播
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		// 工具执行后钩子：分发 tool_result 处理器（可改写结果），随后统一归一化图片
		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// 放在扩展钩子之后执行，这样扩展注入或替换的图片也会被归一化（按设置自动缩放）。
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});

			// 既无钩子改写、图片也没变化时返回 undefined，避免产生新的结果对象
			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	/**
	 * 安装「每回合刷新」钩子：包装 agent 现有的 prepareNextTurn（WithContext），
	 * 在每轮 LLM 调用前用会话层最新状态覆盖快照中的系统提示词、工具、模型与思考级别。
	 *
	 * Why：agent 循环可能持有旧快照（如上一轮构建的上下文），而会话层的
	 * 系统提示词（_baseSystemPrompt / _systemPromptOverride）和模型可能在
	 * 循环进行中被扩展或用户改变，必须在每轮真正发起调用前刷新。
	 * 兼容旧式 prepareNextTurn 签名：先适配成 WithContext 版本再链式调用。
	 */
	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			// 先链式调用先前安装的钩子，拿到它的快照（可能已含别的宿主层的修改）
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			// 在先前快照之上，用会话层最新状态覆盖关键四项；
			// systemPrompt 优先取本运行的扩展覆盖，其次取基础提示词
			return {
				...previousSnapshot,
				context: {
					...previousContext,
					systemPrompt: this._systemPromptOverride ?? this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	// =========================================================================
	// 事件订阅
	// =========================================================================

	/** 把一个会话事件分发给所有已注册的监听器（同步、按注册顺序） */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	/** 广播当前 steering / follow-up 队列快照（复制数组，防止外部篡改内部状态） */
	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	/** 向扩展分发压缩失败事件（仅在有处理器时） */
	private async _emitSessionCompactFailed(event: Omit<SessionCompactFailedEvent, "type">): Promise<void> {
		if (this._extensionRunner.hasHandlers("session_compact_failed")) {
			await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
		}
	}

	/**
	 * 获取（或惰性创建）「等待空闲」Promise。
	 * 多次调用 waitForIdle() 会共享同一个 Promise；运行结束时由
	 * _resolveIdleWaitIfIdle 统一 resolve 并清空，下次等待再重新创建。
	 */
	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	/** 若当前已无运行中的 agent 任务则 resolve 空闲等待（仍忙碌或无人等待时不动作） */
	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		// 先清空再 resolve，保证 resolve 过程中若有新的 waitForIdle 调用会创建新 Promise
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	/**
	 * 标记运行结束并发出 agent_settled 事件（先扩展后监听器）。
	 * finally 中统一 resolve 空闲等待，即使扩展处理器抛错也不会让 waitForIdle 永久挂起。
	 */
	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
	}

	// 记录最近一条助手消息，供 agent_end 后的自动压缩判定使用
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/**
	 * agent 事件的内部统一处理器（构造时订阅，重连后也复用）。
	 *
	 * 处理管道依次为：
	 * 1. user 消息开始时：若它来自 steering / follow-up 队列，先从队列移除再广播
	 *    （保证 UI 第一时间看到更新后的队列）；
	 * 2. 分发给扩展系统（_emitExtensionEvent）；
	 * 3. 广播给普通监听器（agent_end 附加 willRetry 字段）；
	 * 4. message_end 时按消息类型做会话持久化；
	 * 5. turn_end 时冲刷运行期间排队的上下文自定义消息。
	 */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// 用户消息开始时：检查它是否来自某个队列，若是则在广播前移除，
		// 这样 UI 看到的队列状态是已更新的
		if (event.type === "message_start" && event.message.role === "user") {
			// 新的用户输入意味着溢出恢复窗口重置
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// 先查 steering 队列（优先级更高）
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// 再查 follow-up 队列
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// 先分发给扩展系统
		await this._emitExtensionEvent(event);

		// 再通知所有普通监听器；agent_end 需附加「是否将自动重试」信息
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// 会话持久化
		if (event.type === "message_end") {
			// 扩展产生的自定义消息
			if (event.message.role === "custom") {
				// 持久化为 CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// 常规 LLM 消息 - 持久化为 SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// 其他消息类型（bashExecution、compactionSummary、branchSummary）在别处持久化

			// 记录助手消息，供自动压缩判定（在 agent_end 时检查）
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// 收到成功的助手响应时立即重置重试计数
				//（防止一个 turn 内多次 LLM 调用导致计数跨调用累积）
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}

		// 一个 turn 在其助手消息和所有工具结果都落盘后才结束，因此这里是本次运行中
		// 第一个可以安全插入「纯上下文自定义消息」的时机——不会落进某个工具调用
		// 与其结果之间。放在上面扩展与监听器分发之后执行，还能顺带收集
		// turn_end 处理器刚刚排队的消息。
		if (event.type === "turn_end") {
			this._flushPendingCustomMessages();
		}
	};

	/**
	 * 判断 agent_end 之后是否会自动重试：
	 * 重试开关打开、未达重试上限、且最后一条助手消息的错误属于可重试类型。
	 */
	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		// 从后往前找最后一条助手消息（agent_end 只应在其后发生）
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** 在 agent 状态中从后往前找最后一条助手消息（含被中断的） */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	/**
	 * 原地替换消息对象：清空 target 自身全部属性后把 replacement 的属性复制进去。
	 *
	 * Why 必须原地改而不是换引用：agent-core 在发出 message_end 之前就把定稿的
	 * 消息对象存进了自己的 state，而 SessionManager 的持久化发生在之后的
	 * _handleAgentEvent() 里（用的是 event.message 这个引用）。原地修改能同时保住
	 * agent 状态、后续 turn/agent 事件、监听器，以及最终 appendMessage(event.message)
	 * 持久化所引用的同一个对象，使各处视图保持一致。
	 */
	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// 同一对象则无事可做
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		// 先删后拷：确保 replacement 中不存在的旧属性不会残留
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/**
	 * 把 agent 事件适配并分发给扩展系统。
	 *
	 * 各事件类型几乎一一对应；额外做的事：
	 * - turn_start/turn_end 附带会话层维护的 _turnIndex 与时间戳；
	 * - message_end 走 emitMessageEnd，允许扩展返回替换消息——
	 *   替换结果经归一化（content 为 null 时补空数组）后原地写回，
	 *   防止未类型化的扩展把脏消息塞进 agent 状态或会话历史。
	 */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			// 新的 agent 运行开始，轮次序号归零
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			// turn 结束后才递增轮次序号，保证 turn_start 与 turn_end 拿到同一个索引
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			// 流式增量更新：原样透传消息与底层 assistantMessageEvent（增量片段）
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// 未类型化的扩展处理器可能返回 content 为 null/缺失的消息；
				// 先归一化，绝不让它进入 agent 状态或会话历史。
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * 订阅 agent 事件。
	 * 会话持久化在内部自动完成（message_end 时保存消息）。
	 * 可以添加多个监听器；返回针对该监听器的取消订阅函数。
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// 返回只移除该监听器自身的取消订阅函数
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** 释放时断开与 agent 事件的连接。 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * 移除所有监听器并断开与 agent 的连接。
	 * 会话彻底用完（被替换或退出）时调用。
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// 即使某个 abort 钩子抛错，dispose 也必须成功完成。
		}

		// 把扩展上下文标记为失效：会话被替换/重载后，扩展若仍持有旧 ctx
		//（如 ctx.newSession()/fork()/switchSession()/reload() 之前捕获的），
		// 再使用就会得到这条指引性报错
		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	// =========================================================================
	// 只读状态访问
	// =========================================================================

	/** 完整 agent 状态（消息、模型、工具、系统提示词等） */
	get state(): AgentState {
		return this.agent.state;
	}

	/** 当前模型（尚未选择时为 undefined） */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** 当前思考级别 */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** 会话是否正在处理 agent 运行或运行后的续动作（重试/压缩等）。 */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** 会话是否空闲（无运行中的 agent 任务、重试、自动压缩或排队续跑）。 */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** 当前生效的系统提示词（含本回合扩展施加的修改） */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** 当前重试次数（未在重试时为 0） */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * 获取当前启用（active）的工具名列表。
	 * 返回当前实际设置在 agent 上的工具名。
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * 获取全部已注册工具（含未启用的），带名称、描述、参数 schema、提示准则与来源元信息。
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	/** 按名称查工具定义；不存在时返回 undefined */
	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * 按名称设置启用工具。
	 * 只有注册表中存在的工具才能启用，未知名将被忽略。
	 * 同时重建系统提示词以反映新工具集。
	 * 变更在下个 agent 回合生效。
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// 用新工具集重建基础系统提示词
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** 压缩或分支摘要是否正在运行（以三个 abort 控制器是否存在为判据） */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** 全部消息（含 BashExecutionMessage 等自定义类型） */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** 当前 steering 投递模式 */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** 当前 follow-up 投递模式 */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** 当前会话文件路径；会话持久化被禁用时为 undefined */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** 当前会话 ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** 当前会话显示名（如已设置） */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** 供循环切换的 scoped 模型列表（来自 --models 参数） */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** 更新供循环切换的 scoped 模型列表 */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** 基于文件的提示词模板 */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	/**
	 * 归一化工具提示片段：压成单行（换行与连续空白合并为单个空格），
	 * 空结果返回 undefined，避免系统提示词里出现空片段。
	 */
	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	/** 归一化工具提示准则：去首尾空白、丢弃空条目、去重（保序） */
	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	/**
	 * 重建基础系统提示词。
	 *
	 * 汇总四路输入：工具集（片段 + 准则）、资源加载器提供的自定义/追加提示词、
	 * 已加载技能与 AGENTS 类上下文文件，最后交给 buildSystemPrompt 组装。
	 * 结果存入 _baseSystemPromptOptions，供扩展在 before_agent_start 时读取并修改。
	 */
	private _rebuildSystemPrompt(toolNames: string[]): string {
		// 防御性过滤：只保留注册表中真实存在的工具名
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		// 汇总每个启用工具的提示词片段与使用准则
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this._resourceLoader.getSkills().skills;
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// 发送提示（prompt / steer / followUp）
	// =========================================================================

	/**
	 * 运行一次完整的 agent 交互：发起 prompt 后循环处理「运行后动作」。
	 *
	 * 每轮 agent.prompt / agent.continue 结束后调用 _handlePostAgentRun，
	 * 它可能要求继续（重试 / 自动压缩后重建上下文 / 还有排队消息），
	 * 为 true 时用 agent.continue() 续跑，直到返回 false。
	 * finally 块保证无论成功、失败还是中断，都清掉运行期状态
	 *（系统提示词覆盖、待写消息）并发出 agent_settled。
	 */
	private async _runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
		this._isAgentRunActive = true;
		try {
			await this.agent.prompt(messages);
			while (await this._handlePostAgentRun()) {
				await this.agent.continue();
			}
		} finally {
			this._systemPromptOverride = undefined;
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();
			await this._emitAgentSettled();
		}
	}

	/**
	 * 处理一次 agent 运行结束后的后续动作，返回是否需要 agent.continue() 续跑。
	 *
	 * 依次检查（命中即返回）：
	 * 1. 最后一条助手消息是可重试错误且重试已排程 → 续跑（重试）；
	 * 2. 重试后仍失败 → 广播 auto_retry_end 失败事件并重置计数；
	 * 3. 需要压缩（阈值/溢出）→ 压缩后续跑（用新上下文重建）；
	 * 4. 扩展在 agent_end 之后又排了消息 → 续跑投递。
	 */
	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		// 重试已启动但本次仍然失败：宣告重试终止，不再继续
		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// agent 循环在发出 agent_end 前会清空两个队列；这里还能见到的消息
		// 一定是 agent_end 扩展处理器排队的，需要一次续跑来投递。
		return this.agent.hasQueuedMessages();
	}

	/**
	 * 向 agent 发送一条 prompt。
	 * - 扩展命令（经 pi.registerCommand 注册的）立即执行，即使正在流式运行中
	 * - 默认展开基于文件的提示词模板
	 * - 流式运行期间按 streamingBehavior 选项走 steer() 或 followUp() 排队
	 * - 发送前（非流式时）校验模型与 API key
	 * @throws 流式运行中且未指定 streamingBehavior 时抛出 Error
	 * @throws 未选择模型或无可用 API key 时（非流式）抛出 Error
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;

		try {
			// 优先处理扩展命令（即使正在流式运行也立即执行）
			// 扩展命令自己通过 pi.sendMessage() 管理 LLM 交互
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// 扩展命令已执行，无需再发送 prompt
					preflightResult?.(true);
					return;
				}
			}

			// 手动压缩进行中不接受新 prompt，避免压缩与输入交错产生不一致状态
			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// 发出 input 事件供扩展拦截/改写（在技能/模板展开之前）
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// 展开技能命令（/skill:name args）与提示词模板（/template args）
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// 流式运行中：按选项经 steer() 或 followUp() 排队后返回
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// 新 prompt 之前先冲刷待写的 bash 与自定义消息，保证消息顺序
			this._flushPendingBashMessages();
			this._flushPendingCustomMessages();

			// 校验模型
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			// 校验认证：先查已配置的静态凭据，再尝试动态检查（OAuth 等）
			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// 发送前检查是否需要压缩（可捕获到上次被中断的响应）。
			// 用户的新 prompt 在下方发送，因此这里不调用 agent.continue()。
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// 组装消息数组（用户消息 + 排队消息）
			messages = [];

			// 用户消息
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// 把排队的「下一轮注入」消息作为上下文随用户消息一并注入
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// 发出 before_agent_start 扩展事件
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			// 追加扩展产生的全部自定义消息
			if (result?.messages) {
				for (const msg of result.messages) {
					messages.push({
						role: "custom",
						customType: msg.customType,
						// 未类型化的扩展可能传 null/缺失的 content；入口处归一化。
						content: msg.content ?? [],
						display: msg.display,
						details: msg.details,
						timestamp: Date.now(),
					});
				}
			}
			// 应用扩展修改过的系统提示词，否则回落到基础提示词
			if (result?.systemPrompt !== undefined) {
				this._systemPromptOverride = result.systemPrompt;
				this.agent.state.systemPrompt = result.systemPrompt;
			} else {
				// 确保使用基础提示词（防止沿用上一轮的修改）
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		} catch (error) {
			// 预检失败也要通知 RPC 层（它需要知道这条输入最终没有被发送）
			preflightResult?.(false);
			throw error;
		}

		// 走到这里 messages 仍为 undefined 说明输入被扩展「handled」消费掉了（正常路径）
		if (!messages) {
			return;
		}

		preflightResult?.(true);
		await this._runAgentPrompt(messages);
	}

	/**
	 * 尝试把输入作为扩展命令执行。找到并执行了命令时返回 true。
	 * 命令处理器抛错不会向上传播：错误经扩展运行器广播后仍返回 true
	 *（输入已被消费，不应再当作普通 prompt 发送）。
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// 解析命令名与参数（以第一个空格分隔）
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// 从扩展运行器获取命令上下文（含会话控制方法）
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// 经扩展运行器广播错误（与扩展事件统一走一条错误通道）
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * 把技能命令（/skill:name args）展开为完整技能内容。
	 * 非技能命令、技能不存在或读取失败时返回原文（后者同时经扩展运行器广播错误）。
	 *
	 * 展开结果是一个 <skill> 块：内含名称、文件路径、相对引用基准目录说明
	 * 与剥离 frontmatter 后的技能正文；用户参数拼接在其后。
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		// "/skill:" 固定占 7 个字符
		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // 未知技能，原样透传

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// 与扩展命令一样经扩展运行器广播错误
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // 出错时返回原文
		}
	}

	/**
	 * agent 运行期间排队一条 steering 消息。
	 * 在当前助手轮次执行完工具调用之后、下一次 LLM 调用之前投递。
	 * 会展开技能命令与提示词模板；输入是扩展命令时报错。
	 * @param images 随消息附带的可选图片
	 * @throws 输入为扩展命令时抛出 Error
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// 扩展命令不能排队（需要立即执行、可能有自己的 LLM 交互）
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// 展开技能命令与提示词模板
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * 排队一条 follow-up 消息，agent 完成后处理。
	 * 仅当 agent 不再有任何工具调用或 steering 消息时才投递。
	 * 会展开技能命令与提示词模板；输入是扩展命令时报错。
	 * @param images 随消息附带的可选图片
	 * @throws 输入为扩展命令时抛出 Error
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// 扩展命令不能排队（需要立即执行、可能有自己的 LLM 交互）
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// 展开技能命令与提示词模板
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * 内部：排队一条 steering 消息（已完成展开、不再检查扩展命令）。
	 * 同时维护 UI 镜像队列（_steeringMessages）与 agent 侧队列。
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 内部：排队一条 follow-up 消息（已完成展开、不再检查扩展命令）。
	 * 同时维护 UI 镜像队列（_followUpMessages）与 agent 侧队列。
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * 若输入是扩展命令则抛错。
	 * steering / follow-up 队列不支持命令，调用方应改用 prompt()。
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * 向会话发送一条自定义消息（生成 CustomMessageEntry）。
	 *
	 * 处理四种情形：
	 * - 流式运行中：经 steer / followUp 队列投递，由循环自行拉取；
	 * - 流式运行中且 triggerTurn 为 false：推迟到当前轮结束后写入状态与会话；
	 * - 非流式且 triggerTurn：写入状态与会话并立刻触发新的 LLM 轮次；
	 * - 非流式且不触发：只写入状态与会话，不产生轮次。
	 *
	 * @param message 自定义消息（customType / content / display / details）
	 * @param options.triggerTurn 为 true 且非流式时触发新的 LLM 轮次
	 * @param options.deliverAs 投递方式："steer"、"followUp" 或 "nextTurn"（随下一条用户 prompt 注入）
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// 未类型化的扩展可能传 null/缺失的 content；入口处归一化。
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			// "旁白"：不参与本轮，等下一条用户 prompt 时一并注入
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming && options?.triggerTurn !== false) {
			// 流式中默认走队列投递，避免打断消息顺序
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			// 显式要求触发新轮次
			await this._runAgentPrompt(appMessage);
		} else if (this.isStreaming) {
			// 现在直接 append 会把消息插到助手工具调用与其结果之间，
			// 校验消息顺序的供应商在回放时会拒绝。推迟到本轮结束再写入。
			// 此刻也不发出任何事件：事件不能描述会话树中尚不存在的消息。
			this._pendingCustomMessages.push(appMessage);
		} else {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * 把自定义消息同时写入 agent 状态与会话文件，并同步发出
	 * message_start / message_end 事件对（自定义消息是原子写入，无流式过程）。
	 */
	private _appendCustomMessage(appMessage: CustomMessage): void {
		this.agent.state.messages.push(appMessage);
		this.sessionManager.appendCustomMessageEntry(
			appMessage.customType,
			appMessage.content,
			appMessage.display,
			appMessage.details,
		);
		this._emit({ type: "message_start", message: appMessage });
		this._emit({ type: "message_end", message: appMessage });
	}

	/**
	 * 冲刷 agent 运行期间排队的自定义消息。
	 * 在当前轮的工具结果已进入 agent 状态与会话历史后调用，
	 * 保证不会插进工具调用与结果之间。
	 */
	private _flushPendingCustomMessages(): void {
		if (this._pendingCustomMessages.length === 0) return;

		// 先换出再逐条写入：写入过程中新排队的消息留给下一轮冲刷
		const pending = this._pendingCustomMessages;
		this._pendingCustomMessages = [];
		for (const appMessage of pending) {
			this._appendCustomMessage(appMessage);
		}
	}

	/**
	 * 向 agent 发送用户消息。总是触发一个轮次。
	 * agent 流式运行中时，用 deliverAs 指定排队方式。
	 *
	 * @param content 用户消息内容（字符串或内容数组）
	 * @param options.deliverAs 流式时的投递方式："steer" 或 "followUp"
	 * @param options.expandPromptTemplates 是否分发扩展命令并展开技能命令与提示词模板。默认 false。
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
	): Promise<void> {
		// 把内容归一化为「文本字符串 + 可选图片」
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			// 内容数组：文本部分拼接、图片部分收集
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this.prompt(text, {
			expandPromptTemplates: options?.expandPromptTemplates ?? false,
			streamingBehavior: options?.deliverAs,
			images,
			// 扩展经 sendUserMessage 发送的消息，input 事件来源标记为 extension
			source: "extension",
		});
	}

	/**
	 * 清空全部排队消息并返回它们。
	 * 典型用途：用户中断时把消息还原回编辑器。
	 * @returns 含 steering 与 followUp 两个数组的对象
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** 待投递消息数（含 steering 与 follow-up 两类） */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** 获取待投递的 steering 消息（只读） */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** 获取待投递的 follow-up 消息（只读） */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	/** 资源加载器（技能/模板/主题/上下文文件等） */
	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * 中断当前操作并等待 agent 完全空闲。
	 * 依次中断重试与 agent 本体，再等空闲 Promise resolve，
	 * 确保调用返回后没有残留的后台任务。
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	/** 等待会话回到空闲状态；已空闲则立即返回 */
	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// 模型管理
	// =========================================================================

	/**
	 * 向扩展广播模型切换事件。
	 * 前后模型相同（同 provider 同 id）时视为无变化，不广播。
	 */
	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * 直接设定模型。
	 * 校验该模型已有可用认证，并把切换写入会话记录。
	 * 仅当 options.persist 为 true 时才持久化到全局默认设置。
	 * @throws 模型没有配置认证时抛出 Error
	 */
	async setModel(model: Model<any>, options: ModelMutationOptions = {}): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch(model);
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		}

		// 为新模型应用思考级别。
		// 按模型的思考级别覆盖优先于全局默认值。
		// 持久化模型不会隐式改写全局思考级别默认值。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * 循环切换到下一个/上一个模型。
	 * 配置了 scoped 模型列表（--models 参数）时在列表内循环，否则在全部可用模型中循环。
	 * @param direction - "forward"（默认，向前）或 "backward"（向后）
	 * @returns 新模型信息；只有一个可用模型、无事可切时返回 undefined
	 */
	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelMutationOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	/**
	 * 在 scoped 模型列表内循环切换。
	 *
	 * 先用当前可用模型快照过滤 scoped 列表（凭据被移除的模型会被剔除），
	 * 再按取模索引环形前进/后退。当前模型不在列表内时从第 0 个开始。
	 * 可切模型不足 2 个时返回 undefined。
	 */
	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		// 用 "provider\0id" 拼接键做集合匹配（\0 不会出现在正常名称里，避免歧义碰撞）
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		// 环形索引：向后时先 +len 再取模，避免出现负数
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.model, next.thinkingLevel);

		// 应用模型
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);
		}

		// 为新模型应用思考级别。
		// - scoped 模型上显式声明的思考级别优先于各级默认值
		// - 按模型的思考级别覆盖优先于全局默认值
		// setThinkingLevel 会按模型能力收敛（clamp）。
		// 持久化模型不会隐式改写全局思考级别默认值。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	/**
	 * 在全部可用模型中循环切换（未配置 scoped 列表时的默认行为）。
	 * 逻辑与 _cycleScopedModel 相同，只是候选集换成运行时的可用模型快照，
	 * 且不带 scoped 模型的显式思考级别。
	 */
	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelMutationOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		// 环形索引：向后时先 +len 再取模，避免出现负数
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch(nextModel);
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		if (options.persist) {
			this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);
		}

		// 为新模型应用思考级别。
		// 持久化模型不会隐式改写全局思考级别默认值。
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management（思考级别管理）
	// 级别存于 agent.state（当前生效值），用户显式选择另存 settings（默认值）。
	// =========================================================================

	/**
	 * 设置思考（reasoning）级别。
	 *
	 * 工作流程：
	 * - 先按当前模型支持的级别列表对请求值做收敛（clamp）；
	 * - 只有收敛后的级别**确实变化**时，才写入会话转录并广播变更事件，
	 *   避免重复 append 无意义的历史条目；
	 * - 仅当 options.persist 为 true 时，才把**请求值**（注意不是收敛值）持久化到
	 *   全局默认——这样用户在受限模型上被降级后，切回支持更高档位的模型仍能恢复原选择。
	 */
	setThinkingLevel(level: ThinkingLevel, options: ModelMutationOptions = {}): void {
		const availableLevels = this.getAvailableThinkingLevels();
		// 请求级别在支持列表内直接采用，否则按模型能力收敛
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// 仅在确实发生变化时才记录转录与广播事件（下方的持久化不受该条件限制）
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		// 生效值是收敛后的级别
		this.agent.state.thinkingLevel = effectiveLevel;

		if (options.persist) {
			// 持久化记录的是原始请求值而非收敛值，保留用户意图
			this.settingsManager.setDefaultThinkingLevel(level);
		}

		if (isChanging) {
			// 写入会话转录，并通知 TUI / 扩展
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			// 扩展事件不阻塞主流程
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * 循环切换到下一个思考级别（对应 TUI 的 tab-think 等快捷操作）。
	 * @returns 新级别；当前模型不支持思考时返回 undefined，调用方据此提示用户
	 */
	cycleThinkingLevel(options: ModelMutationOptions = {}): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		// 在当前模型支持的级别列表中环形前进一位
		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel, options);
		return nextLevel;
	}

	/**
	 * 获取当前模型可用的思考级别列表。
	 * 具体档位由 provider 按模型能力在内部收敛；未选模型时返回全量选项。
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		// 未选模型时返回副本，防止调用方意外修改全局选项常量
		if (!this.model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * 判断当前模型是否支持思考/推理能力（由模型元数据的 reasoning 字段声明）。
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	/**
	 * 计算切换到目标模型时应采用的思考级别（模型切换路径专用）。
	 * 优先级：显式指定（scoped 模型上声明的）> 按模型默认 > 全局默认 > 当前值 > 兜底常量。
	 */
	private _getThinkingLevelForModelSwitch(targetModel?: Model<any>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		// 目标模型配置了按模型的默认级别时优先采用
		if (targetModel) {
			const perModel = this.settingsManager.getModelThinkingLevel(targetModel.provider, targetModel.id);
			if (perModel !== undefined) {
				return perModel;
			}
		}
		// 逐级兜底：全局默认 → 当前值（未配置默认时的合理起点）→ 内置常量
		return this.settingsManager.getDefaultThinkingLevel() ?? this.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
	}

	/**
	 * 把请求级别按模型能力收敛（clamp）到模型实际支持的档位。
	 * 尚未选中模型时一律返回 "off"——没有模型就没有可思考的对象。
	 */
	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management（消息队列模式管理）
	// steering：agent 运行中插入的转向消息；follow-up：停机前排队的后续消息。
	// 两者都支持 all（一次性全部投递）/ one-at-a-time（逐条等待确认）两种模式。
	// =========================================================================

	/** 从持久化设置同步队列模式到 agent 状态（初始化与 reload 时调用）。 */
	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * 设置 steering（转向）消息的投递模式，并持久化到设置。
	 * 模式对下一次转向消息投递生效。
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * 设置 follow-up（后续）消息的投递模式，并持久化到设置。
	 * 模式对下一次停机后的消息投递生效。
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction（上下文压缩）
	// 三条入口：手动 compact()、阈值触发与溢出恢复（_checkCompaction → _runAutoCompaction）。
	// 共同落点：扩展钩子 session_before_compact 可取消或接管，否则调用底层 compact()。
	// =========================================================================

	/**
	 * 用 Pi 内置摘要器生成压缩总结，手动与自动压缩共用。
	 * 透传当前会话的思考级别、流式函数、重试设置与重试回调。
	 * 返回的 CompactionResult 尚未落盘，何时写入会话由调用方决定。
	 */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		requestModel: Model<any>,
		apiKey: string | undefined,
		headers: Record<string, string> | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
		env: Record<string, string> | undefined,
		reason: "manual" | "threshold" | "overflow",
	): Promise<CompactionResult> {
		// 逐项透传给底层 compact()；reason 仅用于重试事件上下文
		return compact(
			preparation,
			requestModel,
			apiKey,
			headers,
			customInstructions,
			signal,
			this.thinkingLevel,
			this.agent.streamFunction,
			env,
			this.settingsManager.getRetrySettings(),
			this._summarizationRetryCallbacks({ source: "compaction", reason }),
			undefined, // sessionId：内置摘要调用不绑定会话
		);
	}

	/**
	 * 手动压缩会话上下文（`/compact` 命令、RPC 与扩展的入口）。
	 *
	 * 与自动压缩（阈值/溢出，经 `_checkCompaction()` → `_runAutoCompaction()`）相互独立；
	 * 两条路径在完成准备并经过 `session_before_compact` 扩展钩子后，都会调用从
	 * `./compaction/index.ts` 导入的底层 `compact()`——除非钩子取消了压缩或直接给出了
	 * 自定义压缩结果。
	 *
	 * 执行前会先中止当前的 agent 操作。手动压缩**不会**重试或继续被打断的 agent 轮次。
	 *
	 * @param customInstructions 可选的压缩总结附加指令
	 *
	 * 失败时抛出原始错误；事件负载中的 errorMessage 已格式化供 UI 展示。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		// 手动压缩前先中止进行中的 agent 操作，避免与摘要请求并发执行
		await this.abort();
		// 独立的压缩中断控制器：abortCompaction() 的作用对象
		this._compactionAbortController = new AbortController();
		// 先广播开始事件，UI 据此展示「压缩中」
		this._emit({ type: "compaction_start", reason: "manual" });
		// 标记压缩结果是否来自扩展（落盘与会话事件都要携带该信息）
		let fromExtension = false;

		try {
			// 整体流程：校验模型 → 解析鉴权 → 准备压缩 → 扩展钩子 →
			// 生成摘要（扩展提供或内置生成）→ 落盘重建 → 广播结果
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			// 解析摘要请求的鉴权（可能落到 scoped 模型 / 自定义 provider 上）
			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			// pathEntries：当前分支路径上的全部条目，是压缩的输入
			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			// prepareCompaction：挑选保留范围并统计压缩前 token，无法压缩时返回 null
			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// 准备失败：区分「刚压缩过，没有新内容」与「会话太小，无东西可压缩」两种错误
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;

			// session_before_compact 钩子：扩展可取消压缩，或直接提供压缩结果接管内置摘要
			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			// ===== 生成摘要（扩展提供或内置生成） =====
			// 压缩结果统一放在这组变量里：来源可能是扩展，也可能是内置摘要器
			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// 扩展提供的压缩内容，直接采用
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// 共用的内置摘要生成器，自动压缩同样走这里
				const result = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					env,
					"manual",
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
			}

			// 摘要生成期间被用户取消：同样按「Compaction cancelled」路径收场
			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			// ===== 落盘并重建上下文 =====
			// 把 compaction 条目追加进会话树，再按新的分支路径重建 agent 消息，
			// 使 agent.state.messages 立刻反映压缩后的上下文。
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// 取出刚保存的 compaction 条目，供 session_compact 扩展事件使用
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			// 通知扩展压缩已完成（携带落盘后的完整条目）
			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			// 组装对外的压缩结果（含压缩后估算 token 数）
			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end 的监听方可能立刻提交排队的 prompt，
			// 因此先清掉 abort controller 暴露出「空闲」状态，再广播事件。
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			// 区分「用户取消」与「真实失败」：取消不算错误，不带 errorMessage
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const errorMessage = aborted ? undefined : `Compaction failed: ${message}`;
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage,
			});
			// 同步通知扩展压缩失败（事件名 session_compact_failed）
			await this._emitSessionCompactFailed({
				reason: "manual",
				errorMessage,
				aborted,
				willRetry: false,
				fromExtension,
			});
			throw error;
		} finally {
			// 无论成功失败都复位控制器，保证会话回到「空闲可压缩」状态
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * 取消进行中的压缩（手动与自动两个 controller 一并 abort）。
	 * 对应「压缩中按 Esc」的交互。
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * 取消进行中的分支总结（branch summary）。
	 * 导航树（navigateTree）时按 Esc 中断摘要生成会走到这里。
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * 在 `agent_end` 之后或提交 prompt 之前，判断并派发自动压缩。
	 * 手动压缩不走这里（入口是 `compact()`）。
	 *
	 * 自动压缩的三种情形：
	 * 1. 溢出 + 重试：上下文溢出错误或可恢复的 length 截断；
	 *    移除失败的 assistant 消息后压缩，并重试该轮（仅一次）。
	 * 2. 溢出 + 不重试：响应成功完成但已越过配置的上下文窗口；
	 *    压缩但保留已完成的响应。
	 * 3. 阈值 + 不重试：真实或估算的上下文用量越过配置阈值；
	 *    压缩但不重试已完成的响应。
	 *
	 * 三种情形最终都调用 `_runAutoCompaction()`；该方法在完成准备并经过
	 * `session_before_compact` 钩子后，调用 `./compaction/index.ts` 导入的底层
	 * `compact()`——除非钩子取消或给出自定义结果。
	 *
	 * @param assistantMessage 待检查的 assistant 消息
	 * @param skipAbortedCheck 为 false 时把 aborted 消息也纳入检查（用于 prompt 提交前的预检）。默认 true
	 * @returns 是否应让运行后循环调用 `agent.continue()`（用于溢出恢复或投递排队消息）
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		// 判定顺序：总开关 → aborted 跳过 → 同模型校验 → 压缩边界校验 →
		// 溢出检查（情形 1/2）→ 阈值检查（情形 3），任一命中即派发压缩
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// 用户主动取消（aborted）的消息不触发压缩——除非调用方显式关闭该跳过逻辑
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		// ↑ 未知窗口大小（0）时溢出判定自然不成立，只剩阈值路径

		// 消息来自其他模型时跳过溢出检查：
		// 处理用户从小上下文模型（如 opus）切到大上下文模型（如 codex）的场景——
		// 旧模型产生的溢出错误不应触发新模型的压缩。
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// assistant 消息早于最近一次压缩边界时跳过检查：
		// 防止压缩前遗留的过期 usage/错误在压缩后的第一个 prompt 上再次触发压缩。
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// 情形 1 和 2：上下文溢出。
		// length 截断是否「可恢复」取决于输出是否在模型原始期望上限内结束，
		// 与配置的上下文大小或 provider 侧被裁剪的请求上限无关。
		const contextOverflow = sameModel && isContextOverflow(assistantMessage, contextWindow);
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (contextOverflow || recoverableLength) {
			// stopReason 为 stop 说明响应已成功完成，无法也无需重试
			const willRetry = assistantMessage.stopReason !== "stop";

			// 情形 2：响应已成功完成。只压缩、不重试——
			// agent.continue() 无法从一条已完成的 assistant 响应继续。
			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			// 溢出恢复每轮只允许一次，避免「压缩→重试→再溢出」死循环
			// 已尝试过则直接报告失败，让用户手动处理上下文
			if (this._overflowRecoveryAttempted) {
				const errorMessage = contextOverflow
					? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
					: "Truncated response recovery failed after one compact-and-retry attempt.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				await this._emitSessionCompactFailed({
					reason: "overflow",
					errorMessage,
					aborted: false,
					willRetry: false,
					fromExtension: false,
				});
				return false;
			}

			// 情形 1：把失败/被截断的消息从 agent 状态移除、压缩并重试一次。
			// 消息仍保留在会话历史里，但重试上下文不再包含它。
			// 置位标记：本次溢出恢复机会已被使用。
			this._overflowRecoveryAttempted = true;
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// ===== 情形 3：阈值检查 =====
		// 情形 3：阈值压缩，不重试。
		// 错误消息或 usage 全零的消息改用消息体量来估算上下文：
		// 保证持续 API 错误（如 529）或畸形零 usage 响应的会话仍能触发压缩，
		// 上下文计量不会因此被重置。
		let contextTokens: number;
		// 优先用 provider 返回的真实 usage 计算上下文 token
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			// 没有 provider usage 时，estimate.tokens 是纯消息体量估算；
			// 只有基于 usage 的估算才需要做下面的「过期 usage」检查。
			if (estimate.lastUsageIndex !== null) {
				// 校验 usage 来源是否在压缩边界之后：被保留的压缩前消息携带的是
				// 旧（更大）上下文的过期 usage，会让刚完成的压缩立刻被误触发。
				const usageMsg = messages[estimate.lastUsageIndex];
				if (
					compactionEntry &&
					usageMsg.role === "assistant" &&
					(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
				) {
					return false;
				}
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		// 阈值判定交给 shouldCompact：按设置的阈值比例与窗口大小计算
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * 执行阈值或溢出压缩。手动压缩改走 `AgentSession.compact()`。
	 * 两条路径在完成准备与扩展拦截后，都调用 `./compaction/index.ts`
	 * 导入的底层 `compact()`。
	 *
	 * @param reason 自动触发类型，由 `_checkCompaction()` 选定
	 * @param willRetry 溢出压缩完成后是否继续被打断的轮次
	 * @returns 是否应让运行后循环调用 `agent.continue()`
	 *（true = 重试或投递排队消息；false = 保持空闲）
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		// started：compaction_start 是否已发出。catch 里只有已开始才播报失败，
		// 准备阶段（无可压缩内容等）的静默退出不算失败。
		let started = false;
		let fromExtension = false;

		try {
			if (!this.model) {
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			// 与手动压缩相同：以当前分支路径为压缩输入
			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// 无可压缩内容：静默跳过，不当作错误
				return false;
			}

			// 整体流程与手动压缩一致：鉴权 → 准备 → 扩展钩子 → 摘要 → 落盘重建 →
			// 广播结果；区别在于自动压缩可能带 willRetry 继续被打断的轮次。
			// 准备成功后才对外宣布压缩开始
			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;

			// session_before_compact 钩子：扩展可取消（视为中止）或提供压缩结果接管
			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					await this._emitSessionCompactFailed({
						reason,
						aborted: true,
						willRetry: false,
						fromExtension: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			// ===== 生成摘要（扩展提供或内置生成） =====
			// 压缩结果统一放在这组变量里：来源可能是扩展，也可能是内置摘要器
			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// 扩展提供的压缩内容，直接采用
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// 共用的内置摘要生成器，手动压缩同样走这里
				const compactResult = await this._runDefaultCompaction(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					env,
					reason,
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}

			// 摘要生成期间被取消：按中止收场（不算失败，不带 errorMessage）
			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				await this._emitSessionCompactFailed({
					reason,
					aborted: true,
					willRetry: false,
					fromExtension,
				});
				return false;
			}

			// ===== 落盘并重建上下文（与手动压缩一致） =====
			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// 取出刚保存的 compaction 条目，供 session_compact 扩展事件使用
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			// 通知扩展压缩已完成（携带落盘后的完整条目与是否重试）
			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			// 组装对外的压缩结果（含压缩后估算 token 数）
			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// 溢出响应在 message_end 时已持久化，早于 _checkCompaction() 把它从
				// agent 状态移除的时机；而按新压缩结果重建状态又可能把那条被保留的
				// 条目恢复回来，使最后一条又是 assistant——agent.continue() 会拒绝这种
				// 状态。因此在继续被打断的轮次之前，再次移除可重试的错误或被截断的响应。
				if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// 自动压缩完成时可能有 follow-up/steering/自定义消息在排队等待，
			// 返回 true 让循环再继续一次，把排队消息投递出去。
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			// 只有 compaction_start 已发出才播报失败；准备阶段的静默退出不报错
			if (started) {
				// 按触发类型区分错误文案，便于用户理解失败上下文
				const formattedErrorMessage =
					reason === "overflow"
						? `Context overflow recovery failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`;
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage: formattedErrorMessage,
				});
				await this._emitSessionCompactFailed({
					reason,
					errorMessage: formattedErrorMessage,
					aborted: false,
					willRetry: false,
					fromExtension,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * 开关自动压缩设置。
	 * 关闭后阈值/溢出压缩不再触发，手动压缩不受影响。
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** 自动压缩是否启用 */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	/**
	 * 绑定宿主（TUI/RPC）提供的扩展运行时依赖，并启动扩展会话。
	 * 各字段只有显式传入（非 undefined）才覆盖现有值；随后把绑定应用到底层
	 * ExtensionRunner，发出 session_start 事件，并让扩展补充资源（技能/模板/主题）。
	 * 由宿主在会话就绪后调用一次（重载后需再次调用）。
	 */
	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		// 扩展渲染 UI 所需的上下文（如渲染函数）
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		// 运行模式（tui / rpc 等），影响扩展可用的能力
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		// 命令上下文动作（宿主提供的命令执行辅助）
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		// 自定义中断处理器（优先于默认的 this.abort()）
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		// 关闭处理器（扩展调用 shutdown API 时触发）
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		// 扩展错误监听器
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		// 发出 session_start（首次为 startup，重载后为 reload）
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	/**
	 * 通过 resources_discover 事件让扩展补充技能 / 提示模板 / 主题路径。
	 * 只有扩展确实返回了新路径时才扩展资源并重建系统提示词，避免无谓的全量刷新。
	 */
	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		// 扩展没有上报任何资源时直接返回，不动现有资源
		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		// 三类路径统一转换成资源加载器的格式
		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		// 扩展资源进入加载器后重建系统提示词，让新技能/模板立即对 agent 生效
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/**
	 * 把扩展上报的 {path, extensionPath} 转换成资源加载器需要的带 metadata 路径项：
	 * source 标为 extension:<名>，scope 固定为 temporary（仅本会话内存活，不落盘），
	 * origin 为 top-level；内置占位路径（尖括号包裹）没有真实的 baseDir。
	 */
	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	/**
	 * 生成扩展来源标签：内置占位路径（尖括号包裹，如 <runtime>）去掉尖括号；
	 * 真实文件路径则取 basename 并去掉 .ts/.js 后缀。
	 */
	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	/**
	 * 把宿主绑定的 UI 上下文 / 命令上下文 / 错误监听应用到底层 runner。
	 * 旧的错误监听先退订，防止重复注册。
	 */
	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		// 重建 runner 后需重新挂错误监听；先退订旧监听防止泄漏
		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	/**
	 * 从模型注册表刷新当前模型实例（provider 注册/注销后元数据可能更新）。
	 * 注册表中找不到或对象未变化时直接返回，避免无意义的 state 写入。
	 */
	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		// 同 provider/id 替换为新实例，模型标识不变、元数据更新
		this.agent.state.model = refreshedModel;
	}

	/**
	 * 把 AgentSession 的核心能力以 API 对象形式绑定给扩展运行时（bindCore）。
	 * 三组参数分别是：
	 * 1. 可写核心 API——发消息、追加会话条目、工具/模型/思考级别管理；
	 * 2. 只读状态查询与生命周期动作——abort、shutdown、compact 等；
	 * 3. provider 注册表操作——每次变更后同步刷新当前模型。
	 */
	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			// 汇总三个来源的斜杠命令：扩展注册的命令、提示模板、技能（skill: 前缀）
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			// 提示模板命令（来自 prompts 目录 / 扩展上报）
			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			// 技能命令（skill: 前缀与普通命令区分）
			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				// —— 可写核心 API：消息与会话操作、工具/模型/思考级别管理 ——
				sendMessage: (message, options) => {
					// 发送即触发（fire-and-forget）；失败走扩展错误通道而非抛给调用方
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					// 同上：错误进扩展错误通道
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					// 追加自定义条目到会话树，并广播 entry_appended 让 UI 刷新
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				// 工具管理：查询/设置激活集，手动触发注册表重建
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					// provider 未配置鉴权时直接失败，避免切到不可用的模型
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				// —— 只读状态查询与生命周期动作 ——
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					// 宿主注册了自定义中断处理器时优先走它（TUI 需要做额外清理）
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					// 异步触发、结果经回调返回：保持 core API 同步语义的同时不吞错误
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				// —— provider 注册表操作：每次变更后刷新当前模型以拾取新元数据 ——
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	/**
	 * 重建工具注册表：合并「内置基础工具 + 扩展注册工具 + SDK 自定义工具」，
	 * 全程应用允许/排除名单，并把每个工具包装上扩展 runner 的拦截层。
	 * 随后重算激活工具集，规则见下方三个分支注释。
	 * 扩展注册/注销工具、SDK 增删自定义工具后都会调用。
	 */
	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// 记录重建前的注册表与激活集，供后面判断「哪些工具是新出现的」
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const excludedToolNames = this._excludedToolNames;
		// 允许名单为空表示不限制；排除名单始终生效
		const isAllowedTool = (name: string): boolean =>
			(!allowedToolNames || allowedToolNames.has(name)) && !excludedToolNames?.has(name);

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		// SDK 自定义工具合成 <sdk:名> 形式的来源信息，便于 UI 区分来源
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => isAllowedTool(tool.definition.name));
		// 定义注册表：先放内置定义（合成 <builtin:名> 来源），再用自定义/扩展工具覆盖同名项
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		// 从工具定义抽取提示词片段（promptSnippet）与使用准则（promptGuidelines），
		// 供系统提示词构建时拼入
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		// wrapRegisteredTools 给每个工具包上扩展事件拦截层：
		// 扩展可以观察/改写工具调用（beforeToolCall / afterToolCall 钩子）
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
		// 内置工具也过一遍同一包装，保证所有工具走统一的扩展拦截层
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		);

		// 运行时注册表：内置工具打底，扩展/自定义工具覆盖同名内置工具
		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		// ===== 计算激活工具集 =====
		// 新激活集 = 显式指定的激活集（缺省沿用旧激活集），并再次过滤名单
		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			// 配置了允许名单：名单内的所有已注册工具一律加入激活集
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			// 显式要求包含全部扩展工具（如 reload 时保留扩展工具的激活状态）
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			// 未显式指定激活集时，本次新注册（上次不在注册表里）的工具默认激活
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		// Set 去重后应用新的激活集
		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	/**
	 * 构建/重建运行时：基础工具定义、ExtensionRunner、工具注册表。
	 * 从设置读取图片自动缩放与 shell 前缀/路径来实例化内置工具；
	 * 存在 _baseToolsOverride 时（SDK 用法）则完全替换基础工具集。
	 */
	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		// 基础工具定义：优先用 SDK 传入的覆盖集，否则按设置创建全部内置工具
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		// 下面创建 ExtensionRunner：扩展运行时挂载当前 cwd、会话管理器与模型注册表
		const extensionsResult = this._resourceLoader.getExtensions();
		// 命令行 flag 值合并进扩展运行时（如 reload 时保留旧值）
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		// 通过 ref 把新 runner 暴露给外部持有者（如 SDK 宿主）
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		// 绑定核心 API 与宿主依赖后，runner 才完整可用
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		// 默认激活的内置工具：SDK 覆盖集就是覆盖工具名，否则是 read/bash/edit/write 四件套
		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
	}

	/**
	 * 热重载：设置、资源（技能/模板/主题/扩展）与运行时全部重建，
	 * 同时保留当前激活工具集与扩展 flag 值。宿主绑定过扩展依赖时，
	 * 重发 session_start（reason: "reload"）并让扩展重新补充资源。
	 */
	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		// 先向旧 runner 广播 shutdown 再使其失效，保证扩展能收到关闭通知
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		// 失效后旧 runner 上的任何调用都会被拒绝，防止扩展继续用旧实例
		oldRunner.invalidate();
		// 设置重读后，队列模式等派生状态需要同步
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		// API provider 注册表可能受设置变化影响，整体重置
		resetApiProviders();
		await this._resourceLoader.reload();
		// 重建运行时：沿用旧激活工具集与 flag 值，并保留全部扩展工具
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		// 仅当宿主绑定过扩展依赖（UI 上下文等）时才重发 session_start；
		// beforeSessionStart 回调让宿主在事件发出前完成自己的准备动作
		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry（自动重试）
	// 处理瞬时错误（限流/过载/断流）：指数退避后自动继续被打断的轮次；
	// 与压缩恢复（溢出类错误）互斥——溢出不可重试。
	// =========================================================================

	/**
	 * 判断错误是否可重试（过载、限流、服务端错误等）。
	 * 上下文溢出错误**不可**重试——那由压缩流程负责处理。
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// 上下文溢出走压缩恢复，不进入重试
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		return isRetryableAssistantError(message);
	}

	/**
	 * 压缩与分支总结共用的摘要调用重试策略与回调。
	 * 与 agent 轮次重试共用同一份 `settings.retry` 预算/退避参数，
	 * 这样一次瞬时的流中断不会导致整个操作失败。
	 * `source` 携带 TUI 渲染重试提示、重建底层指示器所需的上下文。
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			// 重试已排定：告知 UI 第几次尝试、总次数与退避时长
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			// 单次尝试开始：source 标明是分支总结还是压缩（何种触发）
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			// 重试流程结束（无论成败）：UI 清理指示器
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * 把一条可重试的错误消息准备好以便继续，并按指数退避等待。
	 * @returns true 表示调用方应继续 agent（发起重试）；false 表示放弃重试
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// 回退这次自增，保留「已完成的尝试次数」，
			// 供运行后处理播报最终失败时使用
			this._retryAttempt--;
			return false;
		}

		// 指数退避：base * 2^(n-1)，第 1 次等 base，之后每次翻倍
		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		// 先广播重试开始，让 UI 展示倒计时与错误原因
		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// 把错误消息从 agent 状态移除（会话历史中保留）：
		// 否则重试请求会以 assistant 错误消息结尾，被 provider 拒绝
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// 可中断的指数退避等待
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// 等待期间被取消：复位计数并发出结束事件，让 UI 清理重试指示器
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			// 等待结束（无论成败）即退出「重试中」状态
			this._retryAbortController = undefined;
		}

		// true：错误消息已移除、退避已等待，调用方可发起继续
		return true;
	}

	/**
	 * 取消进行中的重试（中断退避等待）。
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** 自动重试是否正在进行（处于退避等待期） */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** 自动重试是否启用 */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * 开关自动重试设置。
	 * 对 agent 轮次重试与摘要调用重试同时生效。
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution（Bash 执行）
	// 用户直敲 `!cmd` 的执行路径：与 agent 工具调用无关，结果以
	// bashExecution 消息记录；agent 流式响应期间先排队再落盘。
	// =========================================================================

	/**
	 * 执行一条 bash 命令（用户在 TUI 直接输入 `!cmd` 的路径）。
	 * 结果会写入 agent 上下文与会话历史。
	 * @param command 要执行的 bash 命令
	 * @param onChunk 可选的输出流式回调
	 * @param options.excludeFromContext 为 true 时命令输出不发给 LLM（对应 !! 前缀）
	 * @param options.id 可选标识，随 bash_execution_update 事件携带
	 * @param options.operations 自定义 BashOperations（用于远程执行等场景）
	 *
	 * 执行本身不走 agent 循环，但结果会进入其上下文供下一轮引用。
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; id?: string; operations?: BashOperations },
	): Promise<BashResult> {
		// 每条命令一个独立控制器，支持单独取消
		const abortController = new AbortController();
		// 登记到集合：abortBash() 可一次取消所有在跑的命令；结束时在 finally 移除
		this._bashAbortControllers.add(abortController);

		// 配置了命令前缀时拼接（例如 "shopt -s expand_aliases" 以支持 alias）
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			// 在会话 cwd 下执行；未提供自定义 operations 时用本地 shell
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						// 输出增量同时喂给调用方回调与 bash_execution_update 事件（供 UI 渲染）
						onChunk?.(delta);
						this._emit({ type: "bash_execution_update", id: options?.id, delta });
					},
					signal: abortController.signal,
				},
			);

			// 记录到会话与 agent 上下文（注意：记录的是原始 command，不含前缀）
			this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
		}
	}

	/**
	 * 把 bash 执行结果记录到会话历史。
	 * executeBash 与自行处理 bash 执行的扩展都会调用它。
	 * agent 正在流式响应时也可安全调用（内部会排队等待落盘）。
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		// 构造 bashExecution 角色的消息；输出过长被截断时 fullOutputPath 指向完整输出文件
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// agent 正在流式响应时不能立即插入消息，否则会破坏
		// tool_use/tool_result 的配对顺序；改为排队，等 agent_end 后
		// 由 _flushPendingBashMessages 统一落盘
		if (this.isStreaming) {
			this._pendingBashMessages.push(bashMessage);
		} else {
			// 空闲时立即写入 agent 状态
			this.agent.state.messages.push(bashMessage);

			// 并保存到会话
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * 取消所有正在运行的 bash 命令。
	 * 对应 TUI 中断用户直敲命令的操作。
	 */
	abortBash(): void {
		// 复制一份再遍历：abort 的回调可能同步修改集合
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** 是否有 bash 命令正在运行（以在册控制器数量判断） */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** 是否有等待落盘的排队 bash 消息（agent 流式响应期间产生） */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * 把排队的 bash 消息刷入 agent 状态与会话。
	 * 在 agent 轮次结束后调用，保证消息顺序正确（tool_use/tool_result 配对完整）。
	 * 保持原排队顺序逐条落盘。
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		// 依落盘顺序逐条写入
		for (const bashMessage of this._pendingBashMessages) {
			// 写入 agent 状态
			this.agent.state.messages.push(bashMessage);

			// 保存到会话
			this.sessionManager.appendMessage(bashMessage);
		}

		// 全部落盘后清空队列
		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management（会话管理）
	// =========================================================================

	/**
	 * 为当前会话设置展示名（写入会话条目并广播 session_info_changed）。
	 * 展示名只影响会话列表展示，不改变会话文件。
	 */
	setSessionName(name: string): void {
		// 会话名作为条目写入（保留改名历史），读取时取最近一条
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation（会话树导航）
	// 会话以树形存储（entry 有 parentId），导航 = 移动叶子到历史节点并从那里
	// 重新生长；被放弃的分支可选生成摘要后挂到新位置。
	// =========================================================================

	/**
	 * 导航到会话树的其他节点（回溯/切分支）。
	 * 与 fork() 不同：不创建新会话文件，始终留在同一文件内。
	 *
	 * @param targetId 要导航到的条目 ID
	 * @param options.summarize 用户是否希望对被放弃的分支生成总结
	 * @param options.customInstructions 给摘要器的自定义指令
	 * @param options.replaceInstructions 为 true 时 customInstructions 完全替换默认提示词
	 * @param options.label 附加到分支总结条目上的标签
	 * @returns 含 editorText（目标是用户消息时回填编辑器）与取消状态的结果
	 *
	 * agent 流式响应进行中调用会直接抛错，需等待当前响应结束。
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		// 记录导航前的叶子，供摘要收集与 session_tree 事件对比新旧位置
		const oldLeafId = this.sessionManager.getLeafId();

		// 已在目标节点上：无需操作
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// 生成分支摘要必须有可用模型
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		// 目标必须存在于会话树中（UI 只会给出有效 ID，这里是防御）
		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// 收集需要总结的条目（旧叶子到公共祖先之间将被放弃的分支）
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// 事件数据：声明为可变变量，扩展可以通过 session_before_tree 覆盖指令与标签
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		// 打包事件数据：包含目标、旧叶子、公共祖先与待总结条目，
		// session_before_tree 钩子的扩展可基于此决定是否拦截
		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// 为摘要生成建立可中断控制器（abortBranchSummary 的作用对象）
		this._branchSummaryAbortController = new AbortController();

		try {
			// 整体流程：session_before_tree 钩子 → 生成摘要（扩展或内置）→
			// 计算新叶子位置 → 切换分支（可选挂摘要）→ 重建 agent 状态 → session_tree 事件
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// 发出 session_before_tree 事件：扩展可取消导航、提供摘要，或改写指令/标签
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// 允许扩展覆盖指令与标签
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// 需要总结且扩展未提供摘要时，运行内置分支摘要器
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				// 前面已校验过 summarize 时必有模型，此处非空断言安全
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				// reserveTokens 为摘要输出预留空间，避免长分支被截断
				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.agent.streamFunction,
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				// 用户取消与真实错误分开处理：取消不算失败
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				// 摘要附带分支里读/写过的文件清单，便于回看时定位上下文
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				// 直接采用扩展提供的摘要
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// ===== 计算新叶子位置并切换分支 =====
			// 按目标条目类型决定新的叶子位置
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// 用户消息：叶子移到其父节点（父为根则 null），文本回填编辑器等待修改重发
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// 自定义消息：同样回退到父节点，文本进编辑器
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// 非用户消息：叶子就是被选中的节点本身
				newLeafId = targetId;
			}

			// 切换叶子（带或不带摘要）
			// 摘要挂在导航目标位置（newLeafId）之后，而不是挂在被放弃的旧分支上
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// 在目标位置创建摘要条目（newLeafId 为 null 表示从根开新分支）
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// 给摘要条目附加标签
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// 无摘要且导航到根：重置叶子
				this.sessionManager.resetLeaf();
			} else {
				// 无摘要且导航到非根节点：从该点开新分支
				this.sessionManager.branch(newLeafId);
			}

			// 不做摘要时把标签挂到目标条目上（没有摘要条目可挂）
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// 从新的分支路径重建 agent 消息
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// 发出 session_tree 事件通知扩展
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// 发送给自定义工具

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			// 无论成败都复位摘要控制器，使会话回到可导航状态
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * 取出会话中的全部用户消息，供 fork 选择器展示。
	 * 空文本的消息会被跳过。
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		// 遍历全部条目，只保留有文本内容的 user 消息
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * 获取会话统计信息。统计范围是**全部**会话条目（含已被压缩掉的历史），
	 * 因此 token/费用总额反映整个会话的真实账单。
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		// usage 累计器（token 四项 + 费用），逐条累加
		const usageTotals = createUsageTotals();

		// 单次遍历全部条目完成所有统计
		for (const entry of this.sessionManager.getEntries()) {
			// 分支摘要与压缩调用自身的 usage 也计入总账
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			// 按角色分类计数；assistant 的 usage 同时累计进总账
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				// 部分工具（如子 agent）自带 usage，同样累计
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				// 统计 content 里的 toolCall 块数量
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			// token 四项（输入/输出/缓存读写）相加得到 total
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost,
			// 附带当前分支的上下文占用（区别于全会话累计）
			contextUsage: this.getContextUsage(),
		};
	}

	/**
	 * 获取当前上下文用量（token 数、窗口大小、百分比）。
	 *
	 * 压缩后最近一条 assistant usage 反映的是压缩**前**的上下文规模，
	 * 只有压缩边界之后响应的 assistant usage 才可信；若尚无这样的 usage，
	 * token 数与百分比返回 null（下一次 LLM 响应后才有值）。
	 * 模型缺失或 contextWindow 未知时整个返回 undefined。
	 */
	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		// 窗口大小未知的模型无法计算百分比
		if (contextWindow <= 0) return undefined;

		// 压缩后最近一条 assistant usage 反映的是压缩前的上下文规模；
		// 只有在最近一次压缩之后响应的 assistant usage 才可信。
		// 若不存在这样的响应，在下一次 LLM 响应之前上下文 token 数未知。
		// 只看当前分支（不含被放弃的兄弟分支）
		// 只看当前分支（不含被放弃的兄弟分支）
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		// 存在压缩边界时，必须先校验 usage 的新鲜度
		if (latestCompaction) {
			// 倒序检查压缩边界之后是否存在有效的 assistant usage
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					// aborted/error 的响应没有可信 usage
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				// 压缩后还没有可信 usage：token 数未知，UI 只能显示窗口大小
				return { tokens: null, contextWindow, percent: null };
			}
		}

		// 无压缩边界（或已有压缩后的可信 usage）时，用估算器算当前上下文 token 数
		const estimate = estimateContextTokens(this.messages);
		// 百分比 = 当前估算 token / 窗口大小
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * 把会话导出为 HTML。
	 * 工具调用块按注册的 HTML 渲染器渲染，扩展工具也有对应展示。
	 * @param outputPath 可选输出路径（默认为会话所在目录）
	 * @param options 可选的导出展示设置（如主题名）
	 * @returns 导出文件的路径
	 */
	async exportToHtml(outputPath?: string, options: { themeName?: string } = {}): Promise<string> {
		// 主题取值：调用方指定的主题 > 用户当前设置的主题（不存在的主题名会被跳过）
		const themeName = [options.themeName, this.settingsManager.getTheme()].find(
			(candidate) => candidate !== undefined && getThemeByName(candidate) !== undefined,
		);

		// 创建工具渲染器（扩展注册的自定义工具也能渲染出 HTML）
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		// state 携带当前模型/思考级别等展示信息，交给导出器渲染头部
		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * 把当前会话分支导出为 JSONL 文件。
	 * 先写会话头，再依序写入当前分支路径上的全部条目；
	 * 被放弃的兄弟分支不会包含在内。
	 * @param outputPath 目标文件路径；缺省时在 cwd 下生成带时间戳的文件
	 * @returns 解析后的输出文件路径
	 */
	exportToJsonl(outputPath?: string): string {
		// 纯委托：具体的头部/条目序列化逻辑在导出工具内实现
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities（工具方法）
	// =========================================================================

	/**
	 * 获取最近一条 assistant 消息的纯文本内容（/copy 命令使用）。
	 * @returns 文本内容；没有可用消息时返回 undefined
	 */
	getLastAssistantText(): string | undefined {
		// 从后往前找最近一条有效 assistant 消息
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// 跳过被中止且没有内容的消息
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		// 只拼接 text 块，忽略 toolCall 等其他内容
		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		// 全空白视为无内容
		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System（扩展系统）
	// 对外暴露扩展运行器的查询入口；具体的能力绑定见上方 _bindExtensionCore。
	// =========================================================================

	/**
	 * 创建「替换会话」上下文：以扩展命令上下文为原型复制属性，
	 * 但把消息发送函数换成绑定到**新会话**（替换后的 session）的实现。
	 * 用于 /new 等命令切换会话后，扩展仍能向新会话发消息。
	 */
	createReplacedSessionContext(): ReplacedSessionContext {
		// 以当前命令上下文为原型浅拷贝属性（保留读取类方法），
		// 再覆盖两个发送函数为指向本会话的实现
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * 判断扩展是否注册了某事件类型的处理器。
	 * 宿主可据此决定是否展示相关 UI（如压缩拦截提示）。
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * 获取扩展运行器（用于设置 UI 上下文与错误处理器）。
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}
