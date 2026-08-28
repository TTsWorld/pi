/**
 * @file loader.ts —— Extension 扩展加载器（发现 / 加载 / 校验 / 初始化）
 *
 * @description
 * 本文件是扩展（Extension）系统的加载器，负责把用户的 TypeScript/JavaScript
 * 扩展模块接入宿主：发现扩展文件（项目本地目录、全局目录、显式配置路径，
 * 即 Pi Packages 机制），经 jiti 加载 TS 源文件（无需预编译），校验其默认导出
 * 是否为合法的工厂函数，再通过注入的 ExtensionAPI 完成初始化
 * （注册工具/命令/快捷键/flag/事件处理器等）。
 *
 * 主要功能点：
 * - 三种运行形态下为 jiti 提供正确的模块解析策略：编译二进制
 *   （Bun / Node SEA / 捆绑 Node）用内嵌的 virtualModules；TS 源码运行形态
 *   复用宿主模块与 tsconfig 路径；未捆绑的 Node 构建走 dist 别名（getAliases）；
 * - createExtensionRuntime / createExtensionAPI 构建「加载期只允许注册、
 *   绑定后才能动作」的安全边界：动作方法在加载期是抛错占位，
 *   由 Runner.bindCore() 替换为真实实现；
 * - 工厂执行成功 commit（落地延迟变更）、失败 discard（回滚并退订事件），
 *   避免半初始化的扩展污染宿主状态；
 * - 按扩展路径缓存已编译的工厂函数（extensionCache），cwd 变化或手动清空时失效；
 * - discoverAndLoadExtensions 按优先级汇总发现路径并去重：
 *   项目本地 > 全局 > 显式配置。
 *
 * 依赖关系：
 * - jiti/static：在 Node 环境下加载 TypeScript 扩展源文件；
 * - ./types.ts：Extension / ExtensionAPI / ExtensionRuntime 等类型定义；
 * - ../pi-manifest.ts：解析 package.json 中的 "pi" 清单字段；
 * - ../event-bus.ts、../exec.ts、../source-info.ts、../timings.ts：
 *   事件总线、命令执行、来源信息与耗时统计等基础能力。
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as _bundledPiAgentCore from "@earendil-works/pi-agent-core";
import type { Provider } from "@earendil-works/pi-ai";
import * as _bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as _bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as _bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import type { KeyId } from "@earendil-works/pi-tui";
import * as _bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
// 下方这些包是扩展可能会用到的依赖，必须以静态 import 引入：
// 只有静态引入，Bun 才会把它们打进编译产物（二进制），
// 之后 jiti 的 virtualModules 选项才能把这些模块提供给扩展使用。
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBunBinary } from "../../config.ts";
// NOTE: 这个 import 之所以可行，是因为 loader.ts 的导出没有再从 index.ts 转出口，
// 从而避免了循环依赖；扩展因此可以直接 import @earendil-works/pi-coding-agent。
import * as _bundledPiCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { readPiManifest } from "../pi-manifest.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import { time } from "../timings.ts";
import type {
	EntryRenderer,
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	LoadExtensionsResult,
	MarkdownTransformer,
	MessageRenderer,
	ProviderConfig,
	RegisteredCommand,
	ToolDefinition,
} from "./types.ts";

/** 经 virtualModules 提供给扩展使用的内嵌模块表（仅编译二进制形态生效） */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@earendil-works/pi-agent-core": _bundledPiAgentCore,
	"@earendil-works/pi-tui": _bundledPiTui,
	// 扩展对 pi-ai 根包名的解析被定向到 compat 入口（核心入口的严格超集）：
	// 让仍在使用旧全局 API 的存量扩展在运行期继续可用，直到 compat 被移除。
	"@earendil-works/pi-ai": _bundledPiAiCompat,
	"@earendil-works/pi-ai/compat": _bundledPiAiCompat,
	"@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
	"@earendil-works/pi-ai/providers/all": _bundledPiAiProviders,
	"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
	// @mariozechner/* 是旧版包名，映射到同一批模块以保持向后兼容
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAiCompat,
	"@mariozechner/pi-ai/compat": _bundledPiAiCompat,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-ai/providers/all": _bundledPiAiProviders,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

// 在 ESM 环境中构造 CommonJS 的 require，供 getAliases() 内的 require.resolve 使用
const require = createRequire(import.meta.url);

// ===== 运行形态探测：决定 loadExtensionModule 中 jiti 的模块解析策略 =====
const isNodeSeaBinary =
	("sea" in process.features && process.features.sea === true) ||
	process.getBuiltinModule("node:sea")?.isSea() === true;
declare const PI_BUNDLED_NODE: boolean;
// 构建期由打包器注入的常量：捆绑 Node 发行版为 true（declare 仅为通过类型检查）
const isBundledNode = typeof PI_BUNDLED_NODE !== "undefined" && PI_BUNDLED_NODE;
// 非 Bun 二进制且本文件后缀仍是 .ts ⇒ 直接运行 TS 源码的开发形态（monorepo 仓库内）
const isTypeScriptSourceRuntime = !isBunBinary && path.extname(fileURLToPath(import.meta.url)) === ".ts";

/**
 * 构建供 jiti 使用的模块别名表（仅「未捆绑的 Node 构建产物」形态使用）。
 *
 * 该形态下扩展无法通过常规 node_modules 解析到 monorepo 内的工作区包，
 * 因此把相关包名显式映射到各自的 dist 入口文件；编译二进制形态则改用
 * virtualModules（见 loadExtensionModule），不走此路径。
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	// 别名解析开销不小，进程内只做一次并缓存
	if (_aliases) return _aliases;

	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	// dist 布局下本文件位于 dist/core/extensions/，向上两级即包根的入口 index.js
	const packageIndex = path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	// monorepo 根目录：开发仓库内优先用工作区里的产物；发布安装后（目录结构不同）
	// 回退到从本包自身依赖中解析——见下面的 resolveWorkspaceOrImport
	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (workspaceRelativePath: string, specifier: string): string => {
		const workspacePath = path.join(packagesRoot, workspaceRelativePath);
		if (fs.existsSync(workspacePath)) {
			return workspacePath;
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};

	const piCodingAgentEntry = packageIndex;
	const piAgentCoreEntry = resolveWorkspaceOrImport("agent/dist/index.js", "@earendil-works/pi-agent-core");
	const piTuiEntry = resolveWorkspaceOrImport("tui/dist/index.js", "@earendil-works/pi-tui");
	// 与 VIRTUAL_MODULES 同理：pi-ai 根包名定向到 compat 入口（核心入口的严格超集），
	// 兼容仍使用旧全局 API 的存量扩展
	const piAiCompatEntry = resolveWorkspaceOrImport("ai/dist/compat.js", "@earendil-works/pi-ai/compat");
	const piAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "@earendil-works/pi-ai/oauth");
	const piAiProvidersEntry = resolveWorkspaceOrImport(
		"ai/dist/providers/all.js",
		"@earendil-works/pi-ai/providers/all",
	);

	// 别名表：同时收录现用 @earendil-works/* 与旧版 @mariozechner/* 包名，二者指向同一入口
	_aliases = {
		"@earendil-works/pi-coding-agent": piCodingAgentEntry,
		"@earendil-works/pi-agent-core": piAgentCoreEntry,
		"@earendil-works/pi-tui": piTuiEntry,
		"@earendil-works/pi-ai/providers/all": piAiProvidersEntry,
		"@earendil-works/pi-ai/compat": piAiCompatEntry,
		"@earendil-works/pi-ai/oauth": piAiOauthEntry,
		"@earendil-works/pi-ai": piAiCompatEntry,
		"@mariozechner/pi-coding-agent": piCodingAgentEntry,
		"@mariozechner/pi-agent-core": piAgentCoreEntry,
		"@mariozechner/pi-tui": piTuiEntry,
		"@mariozechner/pi-ai/providers/all": piAiProvidersEntry,
		"@mariozechner/pi-ai/compat": piAiCompatEntry,
		"@mariozechner/pi-ai/oauth": piAiOauthEntry,
		"@mariozechner/pi-ai": piAiCompatEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

/** 扩展事件处理器的统一签名：参数任意，可同步或异步返回结果 */
type HandlerFn = (...args: unknown[]) => Promise<unknown>;

// ===== 扩展工厂缓存 =====
// 缓存「扩展路径 → jiti 编译出的工厂函数」，避免同一路径重复转译。
// 缓存以 (cwd, 代数) 为版本：cwd 变化整体清空；手动清空时代数自增，
// 让此前签发的旧令牌全部失效（见 isCurrentCacheToken）。
let extensionCacheCwd: string | undefined;
let extensionCacheGeneration = 0;
const extensionCache = new Map<string, ExtensionFactory>();

/** 缓存版本令牌：记录签发时的 cwd 与代数，用于之后判断缓存是否仍然有效 */
interface ExtensionCacheToken {
	cwd: string;
	generation: number;
}

/** 清空扩展工厂缓存，并自增代数使所有已签发的令牌失效 */
export function clearExtensionCache(): void {
	extensionCache.clear();
	extensionCacheCwd = undefined;
	extensionCacheGeneration++;
}

/**
 * 登记（必要时切换）缓存所属的 cwd，并签发一枚缓存令牌。
 * cwd 与上次不一致时先清空缓存——扩展的路径解析结果依赖工作目录。
 */
function useExtensionCacheCwd(cwd: string): ExtensionCacheToken {
	const resolvedCwd = resolvePath(cwd);
	if (extensionCacheCwd !== undefined && extensionCacheCwd !== resolvedCwd) {
		clearExtensionCache();
	}
	extensionCacheCwd = resolvedCwd;
	return { cwd: resolvedCwd, generation: extensionCacheGeneration };
}

/**
 * 创建一个扩展运行时（ExtensionRuntime），其中所有「动作方法」都是抛错占位。
 *
 * Why：扩展加载阶段宿主尚未完成初始化（模型注册表等还不存在），
 * 此时调用动作方法属于误用，立即抛错比静默失败更容易排查。
 * Runner.bindCore() 会用真实实现替换这些占位方法。
 */
export function createExtensionRuntime(): ExtensionRuntime {
	// 所有动作方法共用的「未初始化」抛错占位
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	// 一旦 invalidate() 写入 staleMessage，此后所有断言都失败：
	// 旧 ctx 已因会话替换 / 重载而失效，不允许继续使用
	const state: { staleMessage?: string } = {};
	const eventBusUnsubscribers = new Set<() => void>();
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() 在扩展加载期即合法；refreshTools 只在 bind 之后才需要真正刷新，
		// 故此处先给空实现
		refreshTools: () => {},
		getCommands: notInitialized,
		// setModel 的对外签名要求返回 Promise，因此用 rejected Promise 而非同步 throw 占位
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			// 幂等：只记录第一次的失效原因，并退订本 runtime 追踪的全部事件订阅
			if (state.staleMessage) return;
			state.staleMessage =
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
			for (const unsubscribe of eventBusUnsubscribers) unsubscribe();
			eventBusUnsubscribers.clear();
		},
		// 包装一层退订函数并集中登记到 eventBusUnsubscribers，
		// 使 invalidate() 能在 ctx 失效时统一退订；包装后多次调用只生效一次（幂等）
		trackEventBusSubscription: (unsubscribe) => {
			let active = true;
			const trackedUnsubscribe = () => {
				if (!active) return;
				active = false;
				eventBusUnsubscribers.delete(trackedUnsubscribe);
				unsubscribe();
			};
			eventBusUnsubscribers.add(trackedUnsubscribe);
			return trackedUnsubscribe;
		},
		// 绑定前：Provider 注册先进队列暂存，等 bindCore() 拿到模型注册表后再统一 flush；
		// bindCore() 会把下面两个方法替换为直接调用
		registerProvider: (name, config, extensionPath = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionPath });
		},
		registerNativeProvider: (provider, extensionPath = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, extensionPath });
		},
		unregisterProvider: (name) => {
			// 从两个待处理队列中同时移除同名注册（撤销尚未 flush 的注册）
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				(r) => r.provider.id !== name,
			);
		},
	};

	return runtime;
}

/**
 * 为单个扩展构建其专属的 ExtensionAPI 对象。
 *
 * 注册类方法直接写入 extension 对象的各集合；动作类方法委托给共享的 runtime。
 * 返回的 commit / discard 用于工厂函数执行完后的一次性收尾：
 * commit 落地加载期暂存的变更，discard 回滚全部副作用。
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): { api: ExtensionAPI; commit: () => void; discard: () => void } {
	// ===== 加载期暂存区：commit 之前所有副作用先挂起 =====
	// 分别暂存 flag 默认值、延迟执行的动作、事件订阅的退订函数，
	// 待工厂执行结束后由 commit 统一落地或由 discard 统一回滚
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	const loadingUnsubscribers: Array<() => void> = [];
	// 简单状态机：loading（工厂执行中）→ active（commit）或 failed（discard）
	let state: "loading" | "active" | "failed" = "loading";
	const assertActive = () => {
		if (state === "failed") {
			throw new Error(`Extension "${extension.path}" failed to load and its API is no longer active.`);
		}
		runtime.assertActive();
	};
	// 加载期对共享状态的修改只入队不执行，激活后则立即执行
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
		loadingUnsubscribers.length = 0;
	};

	const api = {
		// ===== 注册类方法：写入 extension 自身的集合 =====
		on(event: string, handler: HandlerFn): void {
			assertActive();
			const list = extension.handlers.get(event) ?? [];
			list.push(handler);
			extension.handlers.set(event, list);
		},

		// 注册一个 Agent 工具（以 tool.name 为键，同名后注册者覆盖先注册者）
		registerTool(tool: ToolDefinition): void {
			assertActive();
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
			});
			runtime.refreshTools();
		},

		// 注册一个斜杠命令；sourceInfo 由加载器统一补上，扩展无需（也不能）提供
		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertActive();
			extension.commands.set(name, {
				name,
				sourceInfo: extension.sourceInfo,
				...options,
			});
		},

		// 注册一个全局键盘快捷键（同一快捷键后注册者覆盖先注册者）
		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: import("./types.ts").ExtensionContext) => Promise<void> | void;
			},
		): void {
			assertActive();
			extension.shortcuts.set(shortcut, { shortcut, extensionPath: extension.path, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertActive();
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			extension.flags.set(name, { name, extensionPath: extension.path, ...options });
			// 默认值仅在用户尚未设置该 flag 时生效；加载期先进暂存表（且不覆盖先注册的值），
			// 由 commit 统一落地——避免加载失败的扩展在共享 runtime 上留下脏默认值
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		// 注册自定义消息类型的渲染器（按 customType 分发）
		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertActive();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		// 注册 Markdown 渲染变换器：每个扩展只保留最后一个
		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			assertActive();
			extension.markdownTransformer = transformer;
		},

		// 注册自定义条目（会话日志 entry）的渲染器，按需惰性创建集合
		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			assertActive();
			extension.entryRenderers ??= new Map();
			extension.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		// Flag 读取：仅当本扩展注册过该 flag 才可见；值优先取运行时（用户已设置），
		// 否则回落到加载期的暂存默认值
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// ===== 动作类方法：委托共享 runtime（bind 之前为抛错占位） =====
		sendMessage(message, options): void {
			assertActive();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertActive();
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			assertActive();
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			assertActive();
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			assertActive();
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertActive();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			assertActive();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertActive();
			runtime.setThinkingLevel(level);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			assertActive();
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, extension.path));
				return;
			}
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, extension.path));
		},

		unregisterProvider(name: string) {
			assertActive();
			applyRuntimeChange(() => runtime.unregisterProvider(name, extension.path));
		},

		// 事件总线的 emit/on 命名空间（与 on() 注册的扩展生命周期事件相互独立）
		events: {
			emit(channel, data) {
				assertActive();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertActive();
				const unsubscribe = runtime.trackEventBusSubscription(eventBus.on(channel, handler));
				// 加载期建立的订阅记录退订函数，discard 时统一回滚
				if (state === "loading") loadingUnsubscribers.push(unsubscribe);
				return unsubscribe;
			},
		},
	} as ExtensionAPI;

	return {
		api,
		// 工厂执行成功：把暂存的 flag 默认值与延迟变更一次性落到共享 runtime
		// （仍不覆盖运行时已有的值，用户设置优先）
		commit: () => {
			if (state !== "loading") return;
			runtime.assertActive();
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		// 工厂执行失败：标记 failed（此后该扩展的 API 一律抛错）、
		// 退订加载期建立的事件订阅、清空全部暂存
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			for (const unsubscribe of loadingUnsubscribers) unsubscribe();
			clearPending();
		},
	};
}

/** 类型守卫：令牌的 cwd 与代数都和当前缓存一致，才说明缓存条目仍然有效 */
function isCurrentCacheToken(cacheToken: ExtensionCacheToken | undefined): cacheToken is ExtensionCacheToken {
	return (
		cacheToken !== undefined &&
		extensionCacheCwd === cacheToken.cwd &&
		extensionCacheGeneration === cacheToken.generation
	);
}

/**
 * 经 jiti 导入扩展模块，取出其默认导出的工厂函数。
 *
 * 令牌仍有效且路径已缓存时直接返回，避免重复转译。jiti 配置按运行形态三分支：
 * 编译产物（Bun 二进制 / Node SEA / 捆绑 Node）没有 node_modules，改用内嵌的
 * VIRTUAL_MODULES 并禁用原生加载（tryNative: false）；TS 源码形态复用宿主模块
 * 并启用 tsconfig 路径；其余未捆绑的 Node 构建走 dist 别名（getAliases）。
 * 默认导出不是函数时返回 undefined，由调用方生成「非有效工厂」的错误。
 */
async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	const jiti = createJiti(import.meta.url, {
		// 关闭 jiti 自身的模块缓存：每次 import 都重新执行模块，保证扩展改动可被重新加载
		moduleCache: false,
		// 编译二进制与捆绑 Node 发行版使用内嵌模块；TS 源码形态复用宿主模块
		// 与根 tsconfig 路径；未捆绑的 Node 构建使用 dist 别名。
		...(isBunBinary || isNodeSeaBinary || isBundledNode
			? { virtualModules: VIRTUAL_MODULES, tryNative: false }
			: isTypeScriptSourceRuntime
				? { virtualModules: VIRTUAL_MODULES, tsconfigPaths: true }
				: { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	// 写缓存前再次校验令牌：导入耗时期间缓存可能已被清空 / 失效，此时不写入
	if (isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}

/**
 * 创建一个各集合均为空、待填充的 Extension 骨架对象。
 */
function createExtension(extensionPath: string, resolvedPath: string): Extension {
	// 路径形如 "<inline>" / "<npm:xxx>" 的尖括号写法表示非文件系统的虚拟来源：
	// 取尖括号内冒号前的段作为来源名（为空则记 "temporary"）；真实文件一律记 "local"
	const source =
		extensionPath.startsWith("<") && extensionPath.endsWith(">")
			? extensionPath.slice(1, -1).split(":")[0] || "temporary"
			: "local";
	// 虚拟路径没有真实目录，baseDir 留空
	const baseDir = extensionPath.startsWith("<") ? undefined : path.dirname(resolvedPath);

	return {
		path: extensionPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(extensionPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/**
 * 执行扩展工厂函数，完成扩展初始化。
 *
 * 工厂成功返回则 commit 落地其全部注册项；抛错则 discard 回滚暂存副作用后
 * 把异常继续上抛，保证失败的扩展不会在宿主留下残余状态。
 */
async function initializeExtension(
	factory: ExtensionFactory,
	extensionPath: string,
	resolvedPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
): Promise<Extension> {
	const extension = createExtension(extensionPath, resolvedPath);
	const load = createExtensionAPI(extension, runtime, cwd, eventBus);
	try {
		await factory(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	// 记录工厂执行耗时，供扩展加载性能分析
	time(`${extensionPath} factory`, "extensions");
	return extension;
}

/**
 * 加载单个扩展：解析路径 → jiti 导入模块 → 执行工厂初始化。
 *
 * 任何一步失败都不抛异常，而是以 { extension: null, error } 的形式返回错误文案，
 * 便于批量加载时逐个聚合报告而不中断其他扩展。
 */
async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	// 归一化路径中的 Unicode 空格变体（如不间断空格），避免复制粘贴的路径因
	// 不可见字符而找不到文件
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = await initializeExtension(factory, extensionPath, resolvedPath, cwd, eventBus, runtime);

		return { extension, error: null };
	} catch (err) {
		// 把异常压平成错误文案返回（非 Error 的抛出值转成字符串）
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}

/**
 * 从内联的工厂函数直接创建 Extension（不经文件系统与 jiti）。
 *
 * 用于宿主内置扩展或测试：让现成的工厂函数走一遍与文件扩展相同的
 * 初始化与 commit 流程；extensionPath 默认为 "<inline>" 虚拟路径。
 */
export async function loadExtensionFromFactory(
	factory: ExtensionFactory,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	extensionPath = "<inline>",
): Promise<Extension> {
	const resolvedCwd = resolvePath(cwd);
	return initializeExtension(factory, extensionPath, extensionPath, resolvedCwd, eventBus, runtime);
}

/**
 * 按路径列表逐个加载扩展的内部实现（loadExtensions / loadExtensionsCached 的公共底座）。
 *
 * 单个扩展失败只记入 errors 数组，不影响其余扩展继续加载。
 */
async function loadExtensionsInternal(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	useCache = false,
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	// useCache 时先登记 cwd 并签发缓存令牌，供 loadExtensionModule 判断缓存有效性
	const cacheToken = useCache ? useExtensionCacheCwd(cwd) : undefined;
	const resolvedCwd = cacheToken?.cwd ?? resolvePath(cwd);
	// 调用方未提供时，用独立的事件总线与「占位动作」运行时（后者需随后 bindCore）
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	// 串行逐个加载：保证扩展注册顺序与传入路径顺序一致
	for (const extPath of paths) {
		const { extension, error } = await loadExtension(
			extPath,
			resolvedCwd,
			resolvedEventBus,
			resolvedRuntime,
			cacheToken,
		);

		if (error) {
			// 失败只记录，不中断：其余扩展照常加载
			errors.push({ path: extPath, error });
			continue;
		}

		if (extension) {
			extensions.push(extension);
		}
	}

	return {
		extensions,
		errors,
		runtime: resolvedRuntime,
	};
}

/**
 * 从给定路径列表加载扩展（不使用工厂缓存）。
 *
 * 每次调用都经 jiti 重新导入模块，适合需要即时反映文件改动的场景。
 */
export async function loadExtensions(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime);
}

/**
 * 从给定路径列表加载扩展（启用工厂缓存）。
 *
 * 同一 cwd 下重复加载同一扩展时复用已编译的工厂函数；
 * cwd 变化或调用 clearExtensionCache() 后缓存自动失效。
 */
export async function loadExtensionsCached(
	paths: string[],
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
): Promise<LoadExtensionsResult> {
	return loadExtensionsInternal(paths, cwd, eventBus, runtime, true);
}

/** 判断文件名是否为可加载的扩展源文件（仅认 .ts / .js） */
function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * 解析一个目录下的扩展入口文件。
 *
 * 依次检查：
 * 1. package.json 带 "pi" 清单且声明了 extensions 字段 → 返回其声明的各入口路径
 * 2. 目录下存在 index.ts 或 index.js → 返回该 index 文件
 *
 * 找不到任何入口时返回 null（由调用方决定后续动作）。
 */
function resolveExtensionEntries(dir: string): string[] | null {
	// 优先看 package.json 的 "pi" 清单：复杂 Pi Package 必须用它显式声明入口
	const packageJsonPath = path.join(dir, "package.json");
	if (fs.existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = path.resolve(dir, extPath);
				// 清单里声明但磁盘上不存在的入口直接跳过
				if (fs.existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// 回落：约定俗成的 index.ts / index.js 作为入口
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * 在一个目录内自动发现扩展。
 *
 * 发现规则：
 * 1. 直接文件：`extensions/*.ts` / `*.js` → 加载
 * 2. 子目录带 index：`extensions/<子目录>/index.ts` 或 `index.js` → 加载
 * 3. 子目录带 package.json（含 "pi" 清单）→ 加载其声明的入口
 *
 * 只下探一层、不递归；复杂 Pi Package 必须用 package.json 清单声明入口。
 */
function discoverExtensionsInDir(dir: string): string[] {
	// 目录不存在视作「没有扩展」，而非错误
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. 直接文件：*.ts 或 *.js（符号链接指向文件也算）
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. 子目录：按「package.json 清单 → index 文件」的顺序解析入口
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		// 读目录失败（如权限问题）：按未发现任何扩展处理，不让单个目录拖垮整体加载
		return [];
	}

	return discovered;
}

/**
 * 从标准位置自动发现并加载全部扩展。
 *
 * 汇总顺序（先加入者优先，重复路径去重）：
 * 1. 项目本地扩展：`cwd/${CONFIG_DIR_NAME}/extensions/`
 * 2. 全局扩展：`agentDir/extensions/`
 * 3. 显式配置的路径：目录则解析 / 发现其入口，文件则直接加载
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const allPaths: string[] = [];
	const seen = new Set<string>();

	// 统一入口：按绝对路径去重后按原顺序追加，三个来源发现的同一扩展只加载一次
	const addPaths = (paths: string[]) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				allPaths.push(p);
			}
		}
	};

	// 1. 项目本地扩展：cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir));

	// 2. 全局扩展：agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir));

	// 3. 显式配置的路径
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// 是目录：先看 package.json 的 pi 清单或 index 文件
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries);
				continue;
			}
			// 没有显式入口：退化为发现目录内的单个扩展文件
			addPaths(discoverExtensionsInDir(resolved));
			continue;
		}

		// 非目录（或不存在）：按单个文件路径交给加载器，由其加载或报「找不到」
		addPaths([resolved]);
	}

	return loadExtensions(allPaths, resolvedCwd, eventBus);
}
