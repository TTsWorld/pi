/**
 * @file agent-session-services.ts —— 按会话 cwd 组装运行时服务
 *
 * @description
 * 「服务」指与某个具体工作目录（cwd）绑定的基础设施：ModelRuntime（模型/
 * 认证注册表）、SettingsManager（设置读取）与 ResourceLoader（项目资源加载）。
 * 本文件提供两个入口：
 * - {@link createAgentSessionServices}：为指定 cwd 创建一套彼此一致的服务；
 * - {@link createAgentSessionFromServices}：基于已创建的服务再创建 AgentSession。
 *
 * 服务创建与 Session 创建被刻意拆开：模型、思考级别、工具列表等会话级
 * 选项需要先在目标 cwd 的服务上下文中解析，才能用于构造 Session。
 *
 * 依赖关系：
 * - `./model-runtime.ts` / `./settings-manager.ts` / `./resource-loader.ts`：
 *   三类被组装的核心服务；
 * - `./sdk.ts`：createAgentSession（最终 Session 构造）；
 * - `./extensions/index.ts`：扩展的 SessionStartEvent / ToolDefinition 类型。
 */
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import { ModelRuntime } from "./model-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "./resource-loader.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "./sdk.ts";
import type { SessionManager } from "./session-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

/**
 * 创建服务或会话过程中收集的非致命问题。
 *
 * 运行时创建把诊断信息返回给调用方，而不是直接打印或退出进程；
 * 由应用层决定警告是否展示、错误是否中断启动。
 */
export interface AgentSessionRuntimeDiagnostic {
	/** 问题级别：info（提示）/ warning（警告）/ error（错误）。 */
	type: "info" | "warning" | "error";
	/** 人类可读的问题描述。 */
	message: string;
}

/**
 * 创建绑定 cwd 的运行时服务的输入项。
 *
 * 这些服务在会话的有效 cwd 变化时会被整体重建。
 * CLI 传入的资源路径应在到达此函数之前先解析为绝对路径，
 * 这样后续切换 cwd 时不会重新解释这些路径。
 */
export interface CreateAgentSessionServicesOptions {
	/** 会话的有效工作目录，所有服务绑定到该目录。 */
	cwd: string;
	/** 覆盖默认 agentDir（默认取 getAgentDir()）。 */
	agentDir?: string;
	/** 复用已有的 SettingsManager，省略则新建。 */
	settingsManager?: SettingsManager;
	/** 复用已有的 ModelRuntime，省略则新建（需要读取 auth.json/models.json）。 */
	modelRuntime?: ModelRuntime;
	/** 传递给新建 ModelRuntime 的中断信号（用于取消其初始化）。 */
	modelRuntimeSignal?: AbortSignal;
	/** CLI 传入的扩展旗标值（--flag / --flag=value），用于校验并注入扩展运行时。 */
	extensionFlagValues?: Map<string, boolean | string>;
	/** 透传给 DefaultResourceLoader 的其余选项（cwd/agentDir/settingsManager 由本函数注入）。 */
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	/** 透传给 resourceLoader.reload() 的选项。 */
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
}

/**
 * 基于「已创建的服务」再创建 AgentSession 的输入项。
 *
 * 适用于服务已存在、且所有绑定 cwd 的模型/工具/会话选项
 * 已经针对这些服务解析完毕之后的场景。
 */
export interface CreateAgentSessionFromServicesOptions {
	/** 此前由 createAgentSessionServices 创建的服务集合。 */
	services: AgentSessionServices;
	/** 负责会话持久化的管理器。 */
	sessionManager: SessionManager;
	/** 会话启动事件（扩展通过它感知会话开始）。 */
	sessionStartEvent?: SessionStartEvent;
	/** 主模型；省略时由 createAgentSession 按设置解析默认模型。 */
	model?: Model<any>;
	/** 主模型的思考级别。 */
	thinkingLevel?: ThinkingLevel;
	/** 作用域模型列表（如不同 agent 作用域各自的模型覆盖）。 */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** 要启用的工具名列表；省略表示默认工具集。 */
	tools?: string[];
	/** 要排除的工具。 */
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	/** 完全禁用工具。 */
	noTools?: CreateAgentSessionOptions["noTools"];
	/** 扩展注册的自定义工具定义。 */
	customTools?: ToolDefinition[];
}

/**
 * 绑定到同一个有效会话 cwd、彼此一致的一组运行时服务。
 *
 * 这里只包含基础设施；AgentSession 本身另行创建，
 * 以便会话选项能先在这些服务上完成解析。
 */
export interface AgentSessionServices {
	/** 服务绑定的有效工作目录。 */
	cwd: string;
	/** 全局 agent 目录（auth.json / models.json 等所在处）。 */
	agentDir: string;
	/** 模型与认证注册表。 */
	modelRuntime: ModelRuntime;
	/** 设置管理器（项目/用户两级设置）。 */
	settingsManager: SettingsManager;
	/** 已完成一次 reload 的项目资源加载器。 */
	resourceLoader: ResourceLoader;
	/** 创建过程中收集的非致命诊断（含扩展 provider 注册失败等）。 */
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * 校验并注入 CLI 传入的扩展旗标值（--flag / --flag=value）。
 * 逐个核对旗标是否由某个已加载扩展注册、类型是否匹配，
 * 未注册的旗标与「字符串旗标缺少值」都记为 error 诊断返回，
 * 由应用层决定如何呈现（不在此处直接退出）。
 */
function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	// 先汇总所有扩展注册的旗标名 → 类型，作为后续校验的白名单
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			// 未被任何扩展注册：收集起来统一报错（而不是逐个报错刷屏）
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		// string 型旗标但 CLI 没给值（传了 boolean）
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	// 未注册旗标一次性汇总成一条 error 诊断（单复数文案自适应）
	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * 创建绑定 cwd 的运行时服务。
 *
 * 返回服务集合与诊断信息；**不会**创建 AgentSession。
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	// 复用外部传入的 ModelRuntime（例如 cwd 切换时保留已初始化的实例），否则新建
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	// 立即加载一轮资源（AGENTS.md、skills、扩展等），让后续 getExtensions 拿到完整状态
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	// ===== 注册扩展声明的自定义 provider =====
	// 扩展加载阶段只把注册请求挂到 pending 队列（那时 ModelRuntime 可能还不存在），
	// 这里统一消费队列；单个扩展注册失败仅记录诊断，不阻断其余服务创建。
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	// ===== 注册扩展提供的原生 provider 对象（同上，失败降级为诊断） =====
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingNativeProviderRegistrations = [];
	// 刷新模型目录但禁止联网（allowNetwork: false）——启动阶段保持离线、快速
	await modelRuntime.refresh({ allowNetwork: false });
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		diagnostics,
	};
}

/**
 * 基于此前创建的服务创建 AgentSession。
 *
 * 把会话创建与服务创建分离，使调用方可以在构造会话之前，
 * 先在目标 cwd 的服务上下文中解析模型、思考级别、工具等会话输入。
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
