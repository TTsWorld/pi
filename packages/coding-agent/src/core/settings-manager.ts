/**
 * @file settings-manager.ts —— 分层设置管理器（全局 + 项目双层 settings.json）
 *
 * @description
 * 本文件实现 CLI 的全部用户设置读写逻辑，核心是 `SettingsManager`：
 * - 两层设置来源：全局配置（agentDir 下的 settings.json，个人偏好）与
 *   项目配置（项目目录 .pi/settings.json，可提交进仓库与团队共享）；
 *   读取时项目层覆盖全局层，嵌套对象递归合并（deepMergeSettings）；
 * - 写入采用「字段级增量合并」：只把本次会话显式修改过的字段回填到磁盘文件，
 *   避免整份覆盖外部（用户手改文件或其他进程）产生的变更；嵌套对象字段
 *   还能精确到子键级别（modifiedNestedFields）；
 * - 并发安全：FileSettingsStorage 通过 proper-lockfile 对文件加锁后读-改-写，
 *   SettingsManager 内部再用 writeQueue 把所有落盘任务串行化；
 * - 项目信任（project trust）机制：未受信项目的设置不会被读取/写入，
 *   防止克隆的恶意仓库通过 .pi/settings.json 注入配置；
 * - 兼容性：migrateSettings 把历史版本的旧字段格式就地迁移为新格式；
 * - 另提供 InMemorySettingsStorage 内存实现，供测试与无 I/O 场景使用。
 *
 * 依赖关系：
 * - `../config.ts`：CONFIG_DIR_NAME（".pi"）与 getAgentDir()（全局配置目录）；
 * - `./http-dispatcher.ts`：HTTP 空闲超时的解析与默认值（parseHttpIdleTimeoutMs）；
 * - `proper-lockfile`：跨进程文件锁；
 * - `@earendil-works/pi-ai` / `pi-agent-core` / `pi-tui`：若干枚举与类型定义。
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Transport } from "@earendil-works/pi-ai";
import type { TuiMode as RendererTuiMode, ScrollViewScrollbar } from "@earendil-works/pi-tui";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";

/** 上下文压缩（compaction）设置：长对话自动摘要压缩时的保留策略 */
export interface CompactionSettings {
	enabled?: boolean; // 默认: true
	reserveTokens?: number; // 默认: 16384（压缩后为后续对话预留的 token 数）
	keepRecentTokens?: number; // 默认: 20000（压缩时保留最近消息的 token 数）
}

/** 分支摘要（tree 分支收尾总结）设置 */
export interface BranchSummarySettings {
	reserveTokens?: number; // 默认: 16384（为 prompt + LLM 回复预留的 token 数）
	skipPrompt?: boolean; // 默认: false —— 为 true 时跳过「生成分支摘要？」询问并默认不生成
}

/** SDK / 供应商层面的请求超时与重试设置（嵌于 RetrySettings.provider 中） */
export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/供应商请求超时（毫秒）
	maxRetries?: number; // SDK/供应商重试次数
	maxRetryDelayMs?: number; // 默认: 60000（服务端要求的最大等待延迟，超过即判失败）
}

/** 应用层自动重试设置（指数退避策略） */
export interface RetrySettings {
	enabled?: boolean; // 默认: true
	maxRetries?: number; // 默认: 3
	baseDelayMs?: number; // 默认: 2000（指数退避基数：2s、4s、8s…）
	provider?: ProviderRetrySettings;
}

/** TUI 渲染模式（直接复用 pi-tui 渲染器的同名类型） */
export type TuiMode = RendererTuiMode;
/** 退出全屏模式时的输出内容：完整会话记录 / 仅显示恢复提示 */
export type FullscreenExitOutput = "transcript" | "resume-hint";

/** 终端展示设置（内联图片、收缩清屏、OSC 进度指示等） */
export interface TerminalSettings {
	showImages?: boolean; // 默认: true（仅当终端支持图片显示时才有意义）
	imageWidthCells?: number; // 默认: 60（内联图片期望宽度，单位：终端列）
	clearOnShrink?: boolean; // 默认: false（内容收缩时清除空出来的行）
	showTerminalProgress?: boolean; // 默认: false（OSC 9;4 终端进度指示器）
}

/** 发送给模型的图片处理设置 */
export interface ImageSettings {
	autoResize?: boolean; // 默认: true（缩放到最大 2000x2000 以获得更好的模型兼容性）
	blockImages?: boolean; // 默认: false —— 为 true 时阻止任何图片发送给 LLM 供应商
}

/** 各思考级别（minimal/low/medium/high）的自定义 token 预算 */
export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

/** Mermaid 图渲染时机：关闭 / 仅对最终消息渲染 / 边流式边渲染 */
export type MermaidRenderingMode = "off" | "final" | "streaming";

/** Markdown 渲染设置 */
export interface MarkdownSettings {
	codeBlockIndent?: string; // 默认: "  "（代码块缩进字符串）
	mermaid?: MermaidRenderingMode; // 默认: "streaming"
}

/** 各类警告开关 */
export interface WarningSettings {
	anthropicExtraUsage?: boolean; // 默认: true
}

/** 打开新项目时的默认信任策略：每次询问 / 总是信任 / 从不信任 */
export type DefaultProjectTrust = "ask" | "always" | "never";

/** 传输层设置（复用 pi-ai 的 Transport 类型） */
export type TransportSetting = Transport;

/**
 * npm/git 包的资源来源声明。
 * - 字符串形式：加载包内全部资源；
 * - 对象形式：按 extensions/skills/prompts/themes 过滤要加载的资源；
 * - autoload=false：初始为空，仅应用显式给出的资源匹配模式。
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

/**
 * 设置文件的完整结构（全局与项目两个 settings.json 共用同一形状）。
 * 除标注「仅全局层」等特例之外，大多数字段两层均可配置；
 * 读取时项目值覆盖全局值，未设置时由各 getter 给出内置默认值。
 */
export interface Settings {
	lastChangelogVersion?: string; // 上次已向用户展示过 changelog 的版本号
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>; // 按 "provider/modelId" 为键的各模型默认思考级别覆盖
	transport?: TransportSetting; // 默认: "auto"
	steeringMode?: "all" | "one-at-a-time"; // 运行中注入 steering 消息的处理方式
	followUpMode?: "all" | "one-at-a-time"; // 停机前 follow-up 消息的处理方式
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	showCacheMissNotices?: boolean; // 默认: false —— 显示 prompt 缓存未命中与压缩成本提示
	externalEditor?: string; // Ctrl+G 外部编辑器命令；优先级高于 VISUAL/EDITOR 环境变量
	shellPath?: string; // 自定义 shell 路径（如供 Windows 上的 Cygwin 用户使用）；支持开头 ~ 展开
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // 默认: "ask"；仅全局层有效
	shellCommandPrefix?: string; // 前置到每条 bash 命令的前缀（如 "shopt -s expand_aliases" 以支持别名）
	npmCommand?: string[]; // npm 包查找/安装所用的命令，argv 形式（如 ["mise", "exec", "node@20", "--", "npm"]）
	collapseChangelog?: boolean; // 更新后显示精简版变更日志（完整内容用 /changelog 查看）
	enableInstallTelemetry?: boolean; // 默认: true —— 检测到更新后发送匿名的版本/更新 ping
	enableAnalytics?: boolean; // 默认: false —— 需用户主动开启的遥测数据共享
	trackingId?: string; // 遥测追踪标识，首次开启遥测时自动生成
	packages?: PackageSource[]; // npm/git 包来源数组（字符串形式或带过滤的对象形式）
	extensions?: string[]; // 本地扩展文件路径或目录数组
	skills?: string[]; // 本地 skill 文件路径或目录数组
	prompts?: string[]; // 本地 prompt 模板路径或目录数组
	themes?: string[]; // 本地主题文件路径或目录数组
	enableSkillCommands?: boolean; // 默认: true —— 将 skill 注册为 /skill:name 命令
	terminal?: TerminalSettings;
	images?: ImageSettings;
	enabledModels?: string[]; // 参与循环切换的模型匹配模式（格式同 --models CLI 参数）
	defaultTools?: string[]; // 初始内置工具选择
	doubleEscapeAction?: "fork" | "tree" | "none"; // 编辑器为空时连按两次 Esc 的动作（默认: "tree"）
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // 打开 /tree 时的默认过滤器
	thinkingBudgets?: ThinkingBudgetsSettings; // 各思考级别的自定义 token 预算
	editorPaddingX?: number; // 输入编辑器水平留白（默认: 0）
	outputPad?: 0 | 1; // 聊天消息输出的水平留白（默认: 1）
	autocompleteMaxVisible?: number; // 自动补全下拉最多可见项数（默认: 5）
	showHardwareCursor?: boolean; // 显示终端光标（同时仍为其定位以兼容输入法）
	markdown?: MarkdownSettings;
	warnings?: WarningSettings;
	sessionDir?: string; // 自定义会话存储目录（格式同 --session-dir CLI 参数）
	httpProxy?: string; // 代理 URL；会作为 Pi 管理的 HTTP 客户端的 HTTP_PROXY/HTTPS_PROXY
	httpIdleTimeoutMs?: number; // HTTP 头/体空闲超时（毫秒）；0 表示禁用
	websocketConnectTimeoutMs?: number; // WebSocket 连接/握手超时（毫秒）；0 表示禁用
	tuiMode?: TuiMode; // 默认: "regular"
	fullscreenExitOutput?: FullscreenExitOutput; // 默认: "transcript"；regular 模式下无效
	fullscreenScrollbar?: ScrollViewScrollbar; // 默认: "auto"；regular 模式下无效
}

/** 判断值是否为可深合并的普通对象（排除 null 与数组：数组走整体覆盖语义） */
function isMergeableObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 递归深合并两个普通对象：overrides 中的键覆盖 base。
 * 双方值均为普通对象时递归合并，其余类型（含数组）直接以 overrides 的值整体替换；
 * overrides 中值为 undefined 的键会被跳过，不会清掉 base 中已有的值。
 */
function deepMergeObjects(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
	const result = { ...base };

	for (const key of Object.keys(overrides)) {
		const overrideValue = overrides[key];
		if (overrideValue === undefined) {
			continue; // 显式 undefined 视为「未设置」，不参与覆盖
		}

		const baseValue = base[key];
		result[key] =
			isMergeableObject(baseValue) && isMergeableObject(overrideValue)
				? deepMergeObjects(baseValue, overrideValue)
				: overrideValue;
	}

	return result;
}

/** 深合并设置：project/overrides 层优先，嵌套对象递归合并（分层设置的合并语义核心） */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
}

/**
 * 解析超时类设置项（毫秒）：合法值经 parseHttpIdleTimeoutMs 校验并归一化；
 * 值存在但非法时抛出带设置项名称的错误；值为 undefined 时返回 undefined
 * （表示未设置，由调用方决定默认值）。
 */
function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

/** 设置作用域：global（用户级）或 project（项目级，可随仓库共享给团队） */
export type SettingsScope = "global" | "project";

/** 创建 SettingsManager 的可选项 */
export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean; // 项目是否已受信；未受信时项目层设置既不加载也不可写
}

/**
 * 设置存储后端抽象：在作用域级别加互斥锁后执行「读取 → 计算新内容 → 写回」。
 * fn 收到当前文件内容（文件不存在时为 undefined），返回 undefined 表示不写入，
 * 返回字符串则为要落盘的新内容。
 */
export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

/** 设置读写失败的详细信息（含失败的作用域与可选的文件路径） */
export interface SettingsError {
	scope: SettingsScope;
	path?: string;
	error: Error;
}

/** 各作用域对应的设置文件路径（仅用于错误上报，可能缺失） */
type SettingsPaths = Partial<Record<SettingsScope, string>>;

/** 把任意抛出的值包装为 SettingsError：非 Error 值转为 Error，路径存在时附带 */
function toSettingsError(scope: SettingsScope, error: unknown, path?: string): SettingsError {
	return {
		scope,
		...(path ? { path } : {}),
		error: error instanceof Error ? error : new Error(String(error)),
	};
}

/**
 * 基于真实文件系统的设置存储实现。
 * - global：<agentDir>/settings.json；project：<cwd>/.pi/settings.json；
 * - 用 proper-lockfile 对目标文件加互斥锁后再读-改-写，防止多进程并发写坏文件；
 * - 目录懒创建：只有确实需要写入时才 mkdir，避免仅读取就产生 .pi 目录。
 */
export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string; // 全局设置文件绝对路径
	private projectSettingsPath: string; // 项目设置文件绝对路径

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
	}

	/**
	 * 同步获取文件锁，被其他进程持锁（ELOCKED）时短暂自旋重试。
	 * 为什么用同步锁 + 忙等：withLock 是同步签名，改成异步会波及所有调用方。
	 *
	 * @returns 释放锁的回调
	 */
	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10; // 最多尝试 10 次
		const delayMs = 20; // 每次重试前忙等的时长（毫秒），总计约 200ms 后放弃
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				// realpath: false —— 锁文件路径按字面处理，避免对可能不存在的路径做 realpath 解析
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				// 只对「已被占用」重试；其余错误（权限不足等）重试无意义，直接抛出
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// 同步忙等睡眠，避免把调用方都改成异步。
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	/**
	 * 在文件锁保护下读取、计算并写回设置内容。
	 * 加锁时机：文件已存在则先加锁再读（读改写全程持锁）；
	 * 文件不存在时先不加锁，仅当 fn 决定写入（返回非 undefined）时才创建目录、补加锁再写入。
	 */
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// 只有文件已存在或确实需要写入时才加锁/建目录
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// 只有确实需要写入时才创建目录
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				// 读取阶段没加锁（文件当时不存在），写入前必须补上，防止与并发创建者竞争
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				writeFileSync(path, next, "utf-8");
			}
		} finally {
			// 无论写入成功与否都要释放锁，避免死锁到进程退出
			if (release) {
				release();
			}
		}
	}
}

/** 内存版设置存储：用两个字符串字段模拟全局/项目文件，供测试与无 I/O 场景使用 */
export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	// 内存实现无并发问题，直接读改写即可
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}
}

/**
 * 分层设置管理器：对外暴露类型安全的 get/set 接口，
 * 内部维护「全局层 + 项目层」两份原始设置及它们的合并视图（settings）。
 *
 * 工作原理：
 * - 读取：get* 一律读合并视图（项目层覆盖全局层，未设置时给出内置默认值）；
 * - 写入：set* 只修改对应层的内存副本，同时记录被改字段（modifiedFields /
 *   modifiedNestedFields，项目层另有一组独立记录），再经 save/saveProjectSettings
 *   入队异步落盘；
 * - 落盘为「锁内重读文件 → 只回填本次会话改过的字段 → 写回」，
 *   因此外部对文件的并发改动不会被整份覆盖；嵌套对象字段可细到子键回填；
 * - 所有写任务追加进 writeQueue 串行执行，flush() 可等待全部完成；
 * - 读写失败不向调用方抛出，而是累积在 errors 中，由 drainErrors() 取走展示。
 */
export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings; // 全局层内存副本（写入目标）
	private projectSettings: Settings; // 项目层内存副本（写入目标）
	private settings: Settings; // 合并视图：deepMerge(全局层, 项目层)，所有 get* 的数据源
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // 记录会话期间被修改的全局字段
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // 记录会话期间被修改的全局嵌套字段（field -> 子键集合）
	private modifiedProjectFields = new Set<keyof Settings>(); // 记录会话期间被修改的项目字段
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // 记录会话期间被修改的项目嵌套字段（field -> 子键集合）
	private globalSettingsLoadError: Error | null = null; // 标记全局设置文件加载时是否发生解析错误
	private projectSettingsLoadError: Error | null = null; // 标记项目设置文件加载时是否发生解析错误
	private writeQueue: Promise<void> = Promise.resolve(); // 写任务队列：所有落盘操作按入队顺序串行执行
	private errors: SettingsError[]; // 累积的读写错误，等待 drainErrors() 取走
	private settingsPaths: SettingsPaths; // 各作用域设置文件路径，仅用于错误上报

	/** 私有构造：请通过 create / fromStorage / inMemory 等静态工厂创建 */
	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
		settingsPaths: SettingsPaths = {},
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settingsPaths = settingsPaths;
		// 构造合并视图：项目层覆盖全局层，后续所有读取都走 this.settings
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** 创建从真实文件（全局 + 项目两个 settings.json）加载设置的 SettingsManager */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		const storage = new FileSettingsStorage(resolvedCwd, resolvedAgentDir);
		return SettingsManager.fromStorageWithPaths(storage, options, {
			global: join(resolvedAgentDir, "settings.json"),
			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
		});
	}

	/** 从任意存储后端创建 SettingsManager（便于测试注入自定义存储） */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		return SettingsManager.fromStorageWithPaths(storage, options);
	}

	/** 创建 manager，同时保留可选的文件路径设置，用于错误上报时附带位置信息。 */
	private static fromStorageWithPaths(
		storage: SettingsStorage,
		options: SettingsManagerCreateOptions,
		settingsPaths: SettingsPaths = {},
	): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push(toSettingsError("global", globalLoad.error, settingsPaths.global));
		}
		if (projectLoad.error) {
			initialErrors.push(toSettingsError("project", projectLoad.error, settingsPaths.project));
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
			settingsPaths,
		);
	}

	/** 创建纯内存的 SettingsManager（不做任何文件 I/O；初始设置会先经过迁移处理） */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		// structuredClone 防止调用方继续改动传入对象影响内部状态
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		// 借用 withLock 把初始设置序列化后写入内存「文件」，统一走加载路径
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	/**
	 * 从存储读取并解析指定作用域的设置。
	 * 项目未受信时直接返回空对象（安全考虑：不读取不可信仓库的配置）。
	 */
	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		// withLock 的 fn 返回 undefined 即「只读不写」，借此在锁内安全取到文件内容
		let content: string | undefined;
		storage.withLock(scope, (current) => {
			content = current;
			return undefined;
		});

		if (!content) {
			return {}; // 文件不存在或为空串：视为空设置
		}
		// 文件可能带 BOM，先剥掉再 JSON.parse，否则解析会直接失败
		const settings = JSON.parse(stripBom(content));
		return SettingsManager.migrateSettings(settings);
	}

	/** loadFromStorage 的安全包装：加载失败时不抛出，返回空设置与错误对象 */
	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** 把旧版设置格式就地迁移为新格式（直接修改并返回同一对象） */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// 迁移 queueMode -> steeringMode（字段改名）
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// 迁移旧的 websockets 布尔值 -> transport 枚举
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// 迁移旧的 skills 对象格式 -> 新的数组格式
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		// 迁移 retry.maxDelayMs -> retry.provider.maxRetryDelayMs（挪进 provider 子对象）
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	/** 获取全局层设置的深拷贝（防止外部拿到引用后直接改内存状态） */
	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	/** 获取项目层设置的深拷贝（防止外部拿到引用后直接改内存状态） */
	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	/** 当前项目是否受信（未受信则项目层设置完全不生效） */
	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	/**
	 * 切换项目信任状态。
	 * - 改为不受信：清空项目层内存副本与修改记录，合并视图退化为纯全局层；
	 * - 改为受信：从磁盘重新加载项目设置（加载失败同样记入 errors），再重建合并视图。
	 */
	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			// 撤销信任：丢弃项目层的一切（内存副本、错误状态、修改记录），立即退回纯全局层
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		// 授予信任：重新从磁盘加载项目层设置
		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/**
	 * 从磁盘重新加载两层设置，并清空全部修改记录。
	 * 先等 writeQueue 排空，确保在途写任务都已落盘，避免读到旧文件。
	 * 单层加载失败时保留旧的内存副本（只更新错误状态），不让坏文件清空设置。
	 */
	async reload(): Promise<void> {
		await this.writeQueue; // 等待在途写任务全部完成
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		// 重新加载后以磁盘为准，此前的「已修改字段」记录全部作废
		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** 在当前合并视图之上叠加额外覆盖（仅影响本次会话的读取结果；不落盘、不记修改字段） */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** 标记一个全局字段在本次会话中被修改；嵌套字段可带 nestedKey 精确到子键 */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** 标记一个项目字段在本次会话中被修改；嵌套字段可带 nestedKey 精确到子键 */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** 项目未受信时拒绝写入项目设置（防止向不可信仓库写入 .pi/settings.json） */
	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	/** 记录一条设置读写错误（自动附带该作用域的设置文件路径） */
	private recordError(scope: SettingsScope, error: unknown): void {
		this.errors.push(toSettingsError(scope, error, this.settingsPaths[scope]));
	}

	/** 清空指定作用域的修改记录（写入成功后调用，避免下次落盘重复回填旧字段） */
	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	/**
	 * 把一个同步写任务追加到写队列末尾串行执行。
	 * 任务执行时先做项目信任校验（只针对 project 作用域），成功后清空该作用域
	 * 的修改记录；任何异常都被捕获并记入 errors，而不是打断后续排队任务。
	 */
	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	/** 深拷贝嵌套字段修改记录（Map + 内层 Set）：写任务是异步的，快照可隔离后续改动 */
	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	/**
	 * 在锁内把「本次会话修改过的字段」回填到磁盘现有内容上并写回（增量落盘核心）。
	 * - 先重新读取文件内容并跑一遍迁移，得到 currentFileSettings
	 *   （其他进程/用户可能在我们内存副本之后改过文件）；
	 * - 普通字段：直接以内存快照的值覆盖；
	 * - 嵌套对象字段：只回填记录过的子键，磁盘上的其余子键原样保留——
	 *   这是避免覆盖外部变更的关键；
	 * - 结果以 2 空格缩进序列化为 JSON。
	 */
	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(stripBom(current)) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	/**
	 * 保存全局层：先刷新合并视图，再把当前全局设置与修改记录做快照入队写。
	 * 做快照的原因：写任务是异步的，入队后用户可能继续改内存值，
	 * 落盘内容必须与同时快照的修改记录一一对应。
	 * 全局文件此前加载失败（可能已损坏）时直接返回不写，避免整份覆盖坏文件。
	 */
	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return; // 文件解析失败时放弃写入，防止把（可能手改修复中的）文件整体覆盖
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	/**
	 * 保存项目层：整体替换项目层内存副本后按修改记录增量落盘，
	 * 逻辑同 save（快照 + 加载失败时跳过写入），但写前需通过项目信任校验。
	 */
	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return; // 项目文件解析失败时同样不写，理由同 save
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	/** 以「克隆项目层 → 施加修改 → 标记字段 → 保存」三步更新项目层单个字段 */
	private updateProjectSettings(field: keyof Settings, update: (settings: Settings) => void): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field);
		this.saveProjectSettings(projectSettings);
	}

	/** 等待写队列中所有在途落盘任务完成（进程退出前应调用，防丢写入） */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	/** 取走并清空累积的错误列表（供 UI 周期性展示） */
	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	// ============ 类型安全的字段级 getter/setter（文件剩余部分） ============
	// 统一约定：getter 读合并视图并兜底默认值；setter 修改全局层内存副本
	// （setProject* 系列除外，它们写入项目层），随后经 markModified + save 异步落盘。

	// ===== changelog 版本标记与会话目录 =====

	/** 上次已向用户展示过 changelog 的版本（用于判断升级后是否需要再次展示） */
	getLastChangelogVersion(): string | undefined {
		return this.settings.lastChangelogVersion;
	}

	setLastChangelogVersion(version: string): void {
		this.globalSettings.lastChangelogVersion = version;
		this.markModified("lastChangelogVersion");
		this.save();
	}

	/** 自定义会话存储目录；经 normalizePath 归一化（支持 ~ 展开），未设置返回 undefined */
	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	// ===== 默认供应商与模型 =====

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	// ===== steering / follow-up 消息处理模式 =====

	/** steering 模式；默认 "one-at-a-time"（一次只消费一条运行中注入的消息） */
	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	/** follow-up 模式；默认 "one-at-a-time" */
	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	// ===== 主题 =====

	/** 读取原始 theme 设置值；非字符串（含未设置）一律返回 undefined */
	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	/** 作为主题名使用；值中含 "/" 说明是主题文件路径而非主题名，返回 undefined */
	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	// ===== 思考级别（默认值与按模型覆盖） =====

	getDefaultThinkingLevel(): ThinkingLevel | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingLevel): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	/** 读取指定模型的思考级别覆盖（键为 `${provider}/${modelId}`） */
	getModelThinkingLevel(provider: string, modelId: string): ThinkingLevel | undefined {
		return this.settings.modelThinkingLevels?.[`${provider}/${modelId}`];
	}

	/** 返回全部按模型的思考级别覆盖（浅拷贝，防止外部改动内部状态） */
	getAllModelThinkingLevels(): Record<string, ThinkingLevel> {
		return { ...(this.settings.modelThinkingLevels ?? {}) };
	}

	setModelThinkingLevel(provider: string, modelId: string, level: ThinkingLevel): void {
		if (!this.globalSettings.modelThinkingLevels) {
			this.globalSettings.modelThinkingLevels = {};
		}
		this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`] = level;
		this.markModified("modelThinkingLevels");
		this.save();
	}

	/** 删除指定模型的思考级别覆盖；删空后顺带移除整个键，避免文件里留下空对象 */
	removeModelThinkingLevel(provider: string, modelId: string): void {
		if (!this.globalSettings.modelThinkingLevels) return;
		delete this.globalSettings.modelThinkingLevels[`${provider}/${modelId}`];
		if (Object.keys(this.globalSettings.modelThinkingLevels).length === 0) {
			delete this.globalSettings.modelThinkingLevels;
		}
		this.markModified("modelThinkingLevels");
		this.save();
	}

	// ===== 传输方式 =====

	/** LLM API 传输方式；默认 "auto" */
	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	// ===== 上下文压缩 =====

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	/** 压缩设置的聚合视图（各项已兜底默认值，调用方可一次取全） */
	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	// ===== 分支摘要 =====

	/** 分支摘要设置的聚合视图（各项已兜底默认值） */
	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	// ===== 重试与超时 =====

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	/** 应用层重试的聚合视图（默认：启用、最多 3 次、2s 退避基数） */
	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	/** HTTP 空闲超时；未设置用 DEFAULT_HTTP_IDLE_TIMEOUT_MS，设置值非法时抛错 */
	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	/** 写入 HTTP 空闲超时；拒绝非有限数与负数，落盘前向下取整为整数毫秒 */
	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	/** 供应商层重试参数；maxRetryDelayMs 默认 60s，其余未设置时交由 SDK 自行决定 */
	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	/** WebSocket 握手超时；未设置返回 undefined（用底层默认值），设置值非法时抛错 */
	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	// ===== 显示开关与外部编辑器 =====

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	/**
	 * 解析外部编辑器命令，优先级：
	 * settings.externalEditor > VISUAL/EDITOR 环境变量 > 平台默认（win32 用 notepad，其余用 nano）。
	 */
	getExternalEditorCommand(): string {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	// ===== shell 相关 =====

	/** 自定义 shell 路径；经 normalizePath 归一化（支持 ~ 展开） */
	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	// ===== 项目信任默认值 =====

	/** 新项目的默认信任策略；只认 "always"/"never"，其余（含未设置）一律回退 "ask" */
	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	/** npm 命令（拷贝返回，防止外部改动内部状态） */
	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	// ===== changelog 显示与遥测 =====

	getCollapseChangelog(): boolean {
		return this.settings.collapseChangelog ?? false;
	}

	setCollapseChangelog(collapse: boolean): void {
		this.globalSettings.collapseChangelog = collapse;
		this.markModified("collapseChangelog");
		this.save();
	}

	getEnableInstallTelemetry(): boolean {
		return this.settings.enableInstallTelemetry ?? true;
	}

	setEnableInstallTelemetry(enabled: boolean): void {
		this.globalSettings.enableInstallTelemetry = enabled;
		this.markModified("enableInstallTelemetry");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** 设置遥测共享开关；首次开启时自动生成追踪标识 trackingId */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	// ===== 资源来源与路径（packages / extensions / skills / prompts / themes，均提供项目层版本） =====

	/** 包来源列表（拷贝返回，防止外部改动内部状态） */
	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	/** 项目层版本：写入可随仓库共享的 .pi/settings.json（其余 setProject* 同理） */
	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	// ===== skill 命令与思考预算 =====

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	// ===== 终端设置 =====

	getShowImages(): boolean {
		return this.settings.terminal?.showImages ?? true;
	}

	setShowImages(show: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showImages = show;
		this.markModified("terminal", "showImages");
		this.save();
	}

	/** 内联图片宽度（终端列数）；非法或未设置回退默认 60，结果向下取整且至少为 1 */
	getImageWidthCells(): number {
		const width = this.settings.terminal?.imageWidthCells;
		if (typeof width !== "number" || !Number.isFinite(width)) {
			return 60;
		}
		return Math.max(1, Math.floor(width));
	}

	setImageWidthCells(width: number): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.imageWidthCells = Math.max(1, Math.floor(width));
		this.markModified("terminal", "imageWidthCells");
		this.save();
	}

	/** 内容收缩时是否清除空行；优先级：设置 > 环境变量 > 默认 false */
	getClearOnShrink(): boolean {
		// 优先级：设置 > PI_CLEAR_ON_SHRINK 环境变量 > 默认 false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return process.env.PI_CLEAR_ON_SHRINK === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	// ===== TUI 模式与全屏设置 =====

	/** TUI 模式；只特判 "fullscreen"，其余（含未设置/非法值）一律 "regular" */
	getTuiMode(): TuiMode {
		return this.settings.tuiMode === "fullscreen" ? "fullscreen" : "regular";
	}

	setTuiMode(mode: TuiMode): void {
		this.globalSettings.tuiMode = mode;
		this.markModified("tuiMode");
		this.save();
	}

	/** 全屏退出时的输出；只特判 "resume-hint"，其余回退 "transcript" */
	getFullscreenExitOutput(): FullscreenExitOutput {
		return this.settings.fullscreenExitOutput === "resume-hint" ? "resume-hint" : "transcript";
	}

	setFullscreenExitOutput(output: FullscreenExitOutput): void {
		this.globalSettings.fullscreenExitOutput = output;
		this.markModified("fullscreenExitOutput");
		this.save();
	}

	/** 全屏滚动条；仅接受 "always"/"hidden"，其余回退 "auto" */
	getFullscreenScrollbar(): ScrollViewScrollbar {
		const mode = this.settings.fullscreenScrollbar;
		return mode === "always" || mode === "hidden" ? mode : "auto";
	}

	setFullscreenScrollbar(mode: ScrollViewScrollbar): void {
		this.globalSettings.fullscreenScrollbar = mode;
		this.markModified("fullscreenScrollbar");
		this.save();
	}

	// ===== 图片处理 =====

	getImageAutoResize(): boolean {
		return this.settings.images?.autoResize ?? true;
	}

	setImageAutoResize(enabled: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.autoResize = enabled;
		this.markModified("images", "autoResize");
		this.save();
	}

	getBlockImages(): boolean {
		return this.settings.images?.blockImages ?? false;
	}

	setBlockImages(blocked: boolean): void {
		if (!this.globalSettings.images) {
			this.globalSettings.images = {};
		}
		this.globalSettings.images.blockImages = blocked;
		this.markModified("images", "blockImages");
		this.save();
	}

	// ===== 模型选择与编辑器交互 =====

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	/** 初始内置工具选择（拷贝返回） */
	getDefaultTools(): string[] | undefined {
		const tools = this.settings.defaultTools;
		return tools ? [...tools] : undefined;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	/** 编辑器为空时连按两次 Esc 的动作；默认 "tree"（打开会话树） */
	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	/** /tree 打开时的默认过滤器；白名单校验，非法值回退 "default" */
	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	/** 是否显示硬件光标；未设置时回退看 PI_HARDWARE_CURSOR 环境变量（"1" 开启） */
	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	/** 输入编辑器水平留白；归一化为 [0, 3] 的整数 */
	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	/** 聊天输出水平留白；仅 0/1 两档，非 0 值一律按 1 处理 */
	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	/** 自动补全下拉可见项数；归一化为 [3, 20] 的整数 */
	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	// ===== Markdown 渲染与警告 =====

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}

	/** Mermaid 渲染模式；白名单校验，其余（含未设置）回退 "streaming" */
	getMermaidRenderingMode(): MermaidRenderingMode {
		const mode = this.settings.markdown?.mermaid;
		return mode === "off" || mode === "final" ? mode : "streaming";
	}

	setMermaidRenderingMode(mode: MermaidRenderingMode): void {
		this.globalSettings.markdown ??= {};
		this.globalSettings.markdown.mermaid = mode;
		this.markModified("markdown", "mermaid");
		this.save();
	}

	/** 警告设置（浅拷贝返回） */
	getWarnings(): WarningSettings {
		return { ...(this.settings.warnings ?? {}) };
	}

	setWarnings(warnings: WarningSettings): void {
		this.globalSettings.warnings = { ...warnings };
		this.markModified("warnings");
		this.save();
	}
}
