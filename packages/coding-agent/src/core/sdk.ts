/**
 * @file sdk.ts —— pi coding-agent SDK 主工厂
 *
 * @description
 * 本文件是 packages/coding-agent 的 SDK 入口：核心导出 `createAgentSession()`，
 * 负责把各子系统组装成一个可用的 AgentSession。组装流程大致为：
 *
 * 1. 解析 cwd / agentDir，创建 ModelRuntime（模型与鉴权）、SettingsManager（设置）、
 *    SessionManager（会话持久化）三大基础管理器；
 * 2. 恢复或选定初始模型与思考级别（优先级：显式入参 > 会话存档 > 设置项 > 默认值）；
 * 3. 计算初始启用的内置工具集（受 tools / noTools / excludeTools 与设置共同影响）；
 * 4. 构建 pi-agent-core 的 Agent 实例：注入消息转换器（convertToLlm 包装）、
 *    流式调用函数（streamFn，带超时/重试/请求头处理与扩展钩子）等；
 * 5. 恢复历史消息（若有），最终连同扩展加载结果包装为 AgentSession 返回。
 *
 * 此外本文件还集中再导出（re-export）agent-session-runtime、扩展系统类型、
 * 工具工厂等常用 API，供上层（CLI / 交互式 UI / 嵌入式调用方）统一引用。
 *
 * 依赖关系：
 * - `@earendil-works/pi-agent-core`：Agent 循环与 AgentMessage 消息类型；
 * - `@earendil-works/pi-ai/compat`：Model 统一接口、streamSimple 流式实现、
 *   clampThinkingLevel 思考级别钳制；
 * - `./extensions`：扩展系统（ExtensionRunner、ToolDefinition 等）；
 * - `./tools`：内置工具工厂（read/bash/edit/write 等）与文件变更队列；
 * - `./model-runtime` / `./session-manager` / `./settings-manager` /
 *   `./resource-loader`：模型、会话、设置、资源等运行时子系统。
 */
import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { AgentSession } from "./agent-session.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { convertToLlm } from "./messages.ts";
import { findInitialModel } from "./model-resolver.ts";
import { ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import { getDefaultSessionDir, SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

// 保留 0.81 版本之前的回退行为：有些扩展会自行构造 Agent 实例、
// 或直接调用底层 agent 循环且不传 streamFn，这里设置的全局默认流函数
// 保证它们仍能正常工作。agent-core 本身保持与具体供应商解耦、
// 不 import pi-ai/compat，因此默认值只能在 SDK 层注入。
setDefaultStreamFn(streamSimple);

/**
 * createAgentSession 的可选参数集合。
 * 所有字段均可省略：缺省时按「显式入参 > 会话存档 > 设置项 > 内置默认值」回退。
 */
export interface CreateAgentSessionOptions {
	/** 工作目录，用于项目级资源发现（设置文件、扩展等）。默认：process.cwd() */
	cwd?: string;
	/** 全局配置目录。默认：~/.pi/agent */
	agentDir?: string;

	/** 模型与鉴权的规范运行时。默认：使用 agentDir/auth.json 与 models.json 的运行时 */
	modelRuntime?: ModelRuntime;

	/** 使用的模型。默认：取设置项中的默认模型，否则取第一个可用模型 */
	model?: Model<any>;
	/** 思考级别。默认：取设置项，否则 'medium'（最终会按模型能力钳制） */
	thinkingLevel?: ThinkingLevel;
	/** 可供循环切换的模型列表（交互模式下按 Ctrl+P 切换） */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * 未显式提供工具白名单时的默认抑制模式。
	 *
	 * - "all"：启动时不启用任何工具
	 * - "builtin"：禁用默认内置工具（read、bash、edit、write），
	 *   但保留扩展/自定义工具可用
	 */
	noTools?: "all" | "builtin";
	/**
	 * 可选的工具名白名单。
	 *
	 * 省略时：若配置了 `defaultTools` 设置，则以其作为初始内置工具选择；
	 * 否则启用默认内置工具（read、bash、edit、write）。扩展/自定义工具
	 * 默认保持启用，除非 `noTools` 改变该默认。提供时：仅启用列出的工具名。
	 */
	tools?: string[];
	/** 可选的工具名黑名单。与 `tools` 同时提供时，在白名单之后应用 */
	excludeTools?: string[];
	/** 要注册的自定义工具（在内置工具之外追加） */
	customTools?: ToolDefinition[];

	/** 资源加载器（扫描设置/扩展/技能等项目资源）。省略时使用 DefaultResourceLoader */
	resourceLoader?: ResourceLoader;

	/** 会话管理器。默认：SessionManager.create(cwd) */
	sessionManager?: SessionManager;

	/** 设置管理器。默认：SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** 会话启动事件的元数据，用于扩展运行时启动 */
	sessionStartEvent?: SessionStartEvent;
}

/** createAgentSession 的返回结果 */
export interface CreateAgentSessionResult {
	/** 创建好的会话实例 */
	session: AgentSession;
	/** 扩展加载结果（交互模式下用于 UI 上下文初始化） */
	extensionsResult: LoadExtensionsResult;
	/** 警告信息：会话恢复时保存的模型不可用、已回退到其他模型时给出提示 */
	modelFallbackMessage?: string;
}

// ===== 再导出（Re-exports）=====
// SDK 作为统一门面（facade），把各子模块的公共 API 集中转发，
// 调用方只需从 sdk.ts import 即可拿到全部常用能力。

export * from "./agent-session-runtime.ts";
// 扩展系统类型：ExtensionAPI / 扩展工厂 / 上下文 / 斜杠命令 / 工具定义等
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";

export {
	withFileMutationQueue,
	// 工具工厂（可为自定义 cwd 单独创建工具实例）
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
	createPowerShellTool,
};

// ===== 辅助函数 =====

/** 获取全局配置目录（~/.pi/agent），作为 createAgentSession 内 agentDir 的默认值来源 */
function getDefaultAgentDir(): string {
	return getAgentDir();
}

/**
 * 按给定选项创建一个 AgentSession（SDK 主工厂）。
 *
 * 组装顺序：路径解析 → 基础管理器 → 模型/思考级别决策 → 工具启停计算 →
 * Agent 实例构建 → 历史消息恢复 → AgentSession 包装。
 * 绝大多数依赖（管理器、加载器）未显式传入时会自动创建默认实例，
 * 因此最小用法只需一行调用。
 *
 * @example
 * ```typescript
 * // 最简用法 —— 全部使用默认值
 * const { session } = await createAgentSession();
 *
 * // 显式指定模型
 * import { getModel } from '@earendil-works/pi-ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // 继续上一个会话
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   continueSession: true,
 * });
 *
 * // 完全控制
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   sessionManager: SessionManager.inMemory(),
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	// ===== 路径解析与基础管理器 =====
	// cwd 优先级：显式入参 > sessionManager 记录的目录 > 进程当前目录
	const cwd = resolvePath(options.cwd ?? options.sessionManager?.getCwd() ?? process.cwd());
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	let resourceLoader = options.resourceLoader;

	// 仅当调用方显式指定 agentDir 时才覆盖默认的鉴权/模型文件路径，
	// 否则传 undefined 让 ModelRuntime 使用自身默认位置
	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));

	// 资源加载器负责扫描设置/扩展/技能等项目级资源；未注入时用默认实现并立即加载
	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// ===== 模型与思考级别决策 =====
	// 检查会话目录中是否已有可恢复的历史数据
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	// 会话分支中是否记录过思考级别变更（决定恢复时取哪个来源）
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// 会话有历史数据时，优先从中恢复上次使用的模型
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		// 模型仍存在且该供应商已完成鉴权配置才可用；否则记入回退警告
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// 仍无模型时走 findInitialModel：先查设置中的默认模型，再查各供应商默认值
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			// 一个可用模型都没有：给出带配置指引的提示
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			// 恢复失败但找到了替代模型：在警告后附上实际使用的模型
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// 会话有历史数据时从中恢复思考级别：
	// 有显式记录用记录值，否则退回设置默认、再退内置默认
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// 新会话的回退链：先按模型粒度的覆盖值，再取全局默认
	if (thinkingLevel === undefined && model) {
		const perModel = settingsManager.getModelThinkingLevel(model.provider, model.id);
		if (perModel) {
			thinkingLevel = perModel;
		}
	}
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// 按模型能力把思考级别钳制到合法区间；连模型都没有时只能关闭
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	// ===== 工具集初始启停 =====
	// 内置默认启用集合（四件套），可被设置项 defaultTools 覆盖
	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const configuredDefaultToolNames = settingsManager.getDefaultTools();
	// 白名单三态：显式 tools 优先；noTools="all" 时为空列表（全禁用）；undefined 表示走默认集合
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	// 初始激活 =（显式白名单 ? 白名单 : noTools 抑制 ? 空表 : 设置默认 ? 设置值 : 内置默认）再剔除黑名单
	const initialActiveToolNames = (
		options.tools ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))
	).filter((name) => !excludedToolNameSet?.has(name));

	let agent: Agent;

	// ===== 构建 Agent 实例 =====
	// 包装 convertToLlm：启用 blockImages 设置时过滤图片（纵深防御——
	// 即便上游已拦截，发往 LLM 前仍在消息转换层再拦一道）
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// 每次调用动态读取设置，保证会话中途改设置也能立即生效
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// 从所有消息中滤除 ImageContent，替换为文本占位符
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// 去重：相邻的 "Image reading is disabled." 占位文本只保留一个，
									// 避免连续多图被替换后产生大段重复内容
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	// 扩展运行器引用：Agent 构造在先、扩展加载在后（由 AgentSession 内部完成），
	// 因此用可变 ref 延迟绑定，下方各钩子每次执行时再取 current
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: "",
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		// streamFn：每次 LLM 调用的实际执行入口，在此合并超时/重试设置并挂接扩展钩子
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// 各供应商 SDK 把 timeout=0 当作「0 毫秒立即超时」而非「不限时」，
			// 因此配置为 0 时改用 int32 最大值（2147483647ms ≈ 24.8 天）来近似关闭超时
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			// 超时优先级：单次调用入参 > 供应商重试设置 > 全局 HTTP 空闲超时
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				// 请求头改写：先合并供应商归因头（统计/标识用途），
				// 再交给扩展注册的 before_provider_headers 处理器（若有）
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		// 请求载荷发出前的最后一道改写钩子（对应扩展事件 before_provider_request）
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		// 收到供应商响应后的通知钩子（对应扩展事件 after_provider_response），只读不可改写
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		// 发送上下文给 LLM 前的变换钩子（扩展可在此压缩/改写消息历史）
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// ===== 会话恢复与收尾 =====
	// 会话有历史数据：把消息灌回 Agent 状态完成恢复
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
		// 历史中没记录过思考级别时补写一条，保证 resume 后会话分支完整
		if (!hasThinkingEntry) {
			sessionManager.appendThinkingLevelChange(thinkingLevel);
		}
	} else {
		// 新会话：立即落盘初始模型与思考级别，供后续 resume 时恢复
		if (model) {
			sessionManager.appendModelChange(model.provider, model.id);
		}
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
	});
	// 从资源加载器取扩展加载结果，随会话一并返回（交互模式用它初始化 UI 上下文）
	const extensionsResult = resourceLoader.getExtensions();

	return {
		session,
		extensionsResult,
		modelFallbackMessage,
	};
}
