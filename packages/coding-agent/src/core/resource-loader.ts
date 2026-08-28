/**
 * @file resource-loader.ts —— 资源加载器：统一发现并加载 CLI 运行所需的全部可插拔资源
 *
 * @description
 * 本文件定义 `ResourceLoader` 接口并提供默认实现 `DefaultResourceLoader`，负责：
 * - extensions 的解析与加载（TS 源文件经 jiti 即时编译，见 extensions/loader.ts）；
 * - skills、prompt templates、themes 的发现、去重与诊断收集；
 * - AGENTS.md / CLAUDE.md 项目上下文文件的逐级目录收集（含 worktree 遮蔽剔除）；
 * - 系统提示词（SYSTEM.md）与追加系统提示词（APPEND_SYSTEM.md）的发现与读取。
 *
 * 核心入口是 `reload()`：先经 DefaultPackageManager 解析各资源来源
 * （用户级 / 项目级 / pi packages / CLI 临时路径）及其启用状态，再按 no* 开关裁剪、
 * 应用 *Override 钩子，最终把结果缓存到实例字段，供各 getXxx() 同步读取；
 * `extendResources()` 则供 extension 运行时在加载完成后动态追加资源路径。
 *
 * 依赖关系：
 * - `./package-manager.ts`：解析 pi packages 与各资源目录，产出路径 + 元数据 + 启用状态；
 * - `./extensions/loader.ts`：extension 的缓存加载与运行时（ExtensionRuntime）；
 * - `./skills.ts` / `./prompt-templates.ts` / `../modes/interactive/theme/theme.ts`：各类资源的具体解析；
 * - `./settings-manager.ts`：项目信任（project trust）状态，决定项目级配置是否参与加载；
 * - `./source-info.ts`：为每个资源生成「来源 / 作用域」元数据（SourceInfo），用于 UI 展示与冲突提示。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import {
	clearExtensionCache,
	createExtensionRuntime,
	loadExtensionFromFactory,
	loadExtensionsCached,
} from "./extensions/loader.ts";
import type { Extension, ExtensionRuntime, InlineExtension, LoadExtensionsResult } from "./extensions/types.ts";
import { findGitPaths } from "./footer-data-provider.ts";
import { DefaultPackageManager, type PathMetadata, type ResolvedResource } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";
import { resetTimings } from "./timings.ts";

/**
 * `extendResources()` 的入参：运行期由 extension 动态注册进来的资源路径集合。
 * 每条路径都附带 PathMetadata，用于回填该资源的来源信息（SourceInfo）。
 */
export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

/**
 * `reload()` 的可选参数。
 *
 * resolveProjectTrust：项目信任仲裁钩子。提供时，reload 会先以「不信任项目」的
 * 引导态加载一次 extensions（见 loadProjectTrustExtensions），把结果传给该回调，
 * 由宿主（通常是交互式确认 UI）决定是否信任当前项目，再据此决定项目级资源是否参与加载。
 */
export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { extensionsResult: LoadExtensionsResult }) => Promise<boolean>;
}

/**
 * 资源加载器接口：向 Agent 核心暴露各类资源的只读视图。
 *
 * 实现方在内部完成发现、加载、去重与诊断收集；调用方只通过 getXxx() 读取结果。
 * 每类资源都伴随 ResourceDiagnostic 列表返回，用于在 UI 中提示
 * 加载失败、路径不存在、名称冲突等问题。reload() 可反复触发全量重载。
 */
export interface ResourceLoader {
	getExtensions(): LoadExtensionsResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): Array<{ path: string }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

/**
 * 解析「系统提示词类」输入：既可能是文件路径，也可能是字面文本。
 *
 * 优先按文件路径处理——文件存在则读取内容并剥掉 BOM；读取失败时打警告并
 * 降级为把输入当字面文本返回，保证调用方始终拿到一个可用的字符串。
 *
 * @param input - 用户提供的路径或字面文本；为空时直接返回 undefined
 * @param description - 仅用于警告文案的资源描述（如 "system prompt"）
 */
function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	// 不是文件：视为字面文本原样返回
	return input;
}

/**
 * 在单个目录中查找项目上下文文件（AGENTS.md / CLAUDE.md 及其大小写变体）。
 *
 * 按候选名优先级逐个探测：override 文件最高，其次 AGENTS.md，最后 CLAUDE.md，
 * 命中第一个即返回（同一目录内不叠加多个）。候选路径不是常规文件（如目录）
 * 或读取失败时跳过继续探测下一个候选。
 *
 * @returns 找到的 { path, content }（content 已剥 BOM）；目录中没有候选文件时返回 null
 */
function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	// 优先级顺序：override 显式覆盖 > AGENTS.md > 大写变体 > CLAUDE.md > 大写变体
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

/**
 * 找出被嵌套软链 worktree 遮蔽的主仓上下文文件：主仓与嵌套 worktree 的上下文
 * 同属一个逻辑仓库作用域，两份都加载会导致同一份上下文被应用两次。
 * 没有遮蔽关系时返回 undefined，不影响正常的祖先目录继承。
 *
 * 返回值经过规范化（realpath）处理：`git worktree add` 写入 `.git` 文件的
 * `gitdir:` 目标是 realpath 形式，而 cwd 本身可能仍经过符号链接
 * （如 macOS 下 `/tmp` -> `/private/tmp`），两边必须统一成同一形式才能比较。
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// 普通仓库（worktree 根与主仓根是同一目录）与兄弟 worktree（`git worktree add ../feat`，
	// 主仓不在其祖先链上）两种情况都不存在嵌套遮蔽，直接返回。
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// common git dir 的 dirname 只有在该目录本身就是同一仓库的主 worktree 根时
	// 才是主仓根。bare 布局（`proj/.bare` + `proj/main`）下它只是容纳 `.bare` 的
	// 目录，不跟踪任何文件；子模块的 gitdir 没有 `commondir`，会落在 `.git/modules` 下。
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

/**
 * 加载项目上下文文件：全局（agentDir）一份 + 从 cwd 逐级向上的祖先目录各取一份。
 *
 * 返回顺序即注入顺序：全局文件在最前，祖先链按「根目录 → cwd」从浅到深排列，
 * 越靠近 cwd 的文件越靠后（优先级越高）。嵌套 worktree 遮蔽的主仓副本会被剔除，
 * seenPaths 去重保证同一路径（含全局文件与祖先链重合时）只保留最先收集的一份。
 */
export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	// 1) 全局上下文（agentDir 下的 AGENTS.md / CLAUDE.md），排在最前
	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	// 2) 从 cwd 逐级向上遍历祖先目录收集上下文；先找出被 worktree 遮蔽的主仓副本
	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		const isShadowed =
			shadowedContextFile !== undefined && canonicalizePath(contextFile?.path ?? "") === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			// unshift 到队首：遍历是从 cwd 向根进行的，最终顺序恰好为根目录 → cwd
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		const parentDir = dirname(currentDir);
		// dirname 到根后返回自身，以此作为遍历终止条件
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

/**
 * DefaultResourceLoader 的构造选项。
 *
 * cwd / agentDir 分别是项目目录与用户级 agent 配置目录（如 ~/.pi）；
 * additional*Paths 是 CLI 显式传入的「临时」资源路径，优先级高于常规来源；
 * no* 开关用于彻底关闭某类资源；*Override 系列是宿主自定义钩子，
 * 在默认结果算出后对其进行替换 / 过滤 / 增补（多用于测试与内嵌场景）。
 */
export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	extensionFactories?: InlineExtension[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

/**
 * ResourceLoader 的默认实现。
 *
 * 生命周期：构造（只保存选项并初始化为空状态）→ reload()（真正执行发现与加载，
 * 可多次调用，每次全量重建内部状态）→ getXxx() 同步读取缓存结果；
 * extendResources() 可在加载完成后由 extension 运行时增量追加资源路径。
 */
export class DefaultResourceLoader implements ResourceLoader {
	// ===== 构造时固定下来的选项与配置（reload() 不会改动） =====
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private packageManager: DefaultPackageManager;
	private additionalExtensionPaths: string[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private extensionFactories: InlineExtension[];
	private noExtensions: boolean;
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	// ===== 加载结果缓存：reload() 全量重建，getXxx() 直接同步读取 =====
	private extensionsResult: LoadExtensionsResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private systemPromptSourcePath?: string;
	private appendSystemPrompt: string[];
	private appendSystemPromptSourcePaths: string[];
	// 最近一次生效的资源路径列表，extendResources() 增量追加时以此为基础合并去重
	private lastSkillPaths: string[];
	// extension 运行时登记的资源路径 → SourceInfo，供增量更新时回填来源
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private resourceMetadataByPath: Map<string, PathMetadata>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];
	private loaded: boolean;

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.packageManager = new DefaultPackageManager({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settingsManager,
		});
		this.additionalExtensionPaths = options.additionalExtensionPaths ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.extensionFactories = options.extensionFactories ?? [];
		this.noExtensions = options.noExtensions ?? false;
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.extensionsOverride = options.extensionsOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { extensions: [], errors: [], runtime: createExtensionRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.appendSystemPromptSourcePaths = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.resourceMetadataByPath = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
		this.loaded = false;
	}

	// ===== 只读访问器：直接返回 reload() 缓存的结果 =====

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getSystemPromptSource(): { path: string } | undefined {
		return this.systemPromptSourcePath ? { path: this.systemPromptSourcePath } : undefined;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return this.appendSystemPromptSourcePaths.map((path) => ({ path }));
	}

	/**
	 * 运行期由 extension 动态追加 skills / prompts / themes 路径（增量操作）。
	 *
	 * 不重新加载 extensions：新路径与最近一次生效的路径列表合并去重后，
	 * 只重新加载对应类型的资源；同时把每条路径的 SourceInfo 登记到实例 Map，
	 * 供后续更新时回填资源来源。对应字段缺省或为空数组时，该类资源不做任何事。
	 */
	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths, this.resourceMetadataByPath);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths, this.resourceMetadataByPath);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths, this.resourceMetadataByPath);
		}
	}

	/**
	 * 引导（bootstrap）阶段加载 extensions：强制按「不信任项目」处理。
	 *
	 * 项目级 extensions / packages 在此阶段被排除在外，只加载用户级（全局）
	 * 与 CLI 临时传入的 extensions，并附带执行内联 factory；
	 * 结果交给宿主的 resolveProjectTrust 回调做项目信任判定。
	 */
	async loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {
		// 引导阶段强制按不信任项目处理：排除项目级 extensions/packages，
		// 只加载用户级（全局）与 CLI 临时传入的部分。
		this.settingsManager.setProjectTrusted(false);
		await this.settingsManager.reload();
		return this.loadCurrentExtensionSet({ includeInlineFactories: true });
	}

	/**
	 * 全量（重新）加载所有资源：extensions、skills、prompts、themes、项目上下文与系统提示词。
	 *
	 * 可多次调用；非首次调用会先清空 extension 加载缓存，保证 TS 源文件重新编译。
	 * 流程：
	 * 1.（可选）先做一次「不信任项目」的引导加载，交 resolveProjectTrust 决定信任状态；
	 * 2. 重载设置，经 packageManager 解析各资源来源并过滤出已启用的路径；
	 * 3. 依次加载四类资源、应用对应 Override 钩子并收集诊断；
	 * 4. 收集项目上下文文件，发现并读取系统提示词 / 追加系统提示词。
	 */
	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		// 重置 extension 加载的耗时统计
		resetTimings("extensions");

		// 已加载过一次则清空 extension 缓存，强制 TS 源文件重新编译
		if (this.loaded) {
			clearExtensionCache();
		}

		let preTrustExtensions: LoadExtensionsResult | undefined;
		if (options?.resolveProjectTrust) {
			preTrustExtensions = await this.loadProjectTrustExtensions();
			const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });
			this.settingsManager.setProjectTrusted(projectTrusted);
		}

		// reload() 保留 SettingsManager 中已有的 projectTrusted 状态，并按该信任状态重载设置
		await this.settingsManager.reload();
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		// 挂在实例上：reload 之后的增量流程（extendResources）仍需用它解析包元数据
		this.resourceMetadataByPath = new Map();
		const metadataByPath = this.resourceMetadataByPath;

		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		// 辅助函数：过滤出已启用的资源，同时把「路径 → 元数据」登记进 metadataByPath
		const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
			for (const r of resources) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
			getEnabledResources(resources).map((r) => r.path);
		const enabledExtensions = getEnabledPaths(resolvedPaths.extensions);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);

		const enabledSkills = enabledSkillResources.map((resource) => this.mapSkillPath(resource, metadataByPath));

		// 补充 CLI 临时路径的元数据（统一标记为 cli / temporary / top-level）
		for (const r of cliExtensionPaths.extensions) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}
		for (const r of cliExtensionPaths.skills) {
			if (!metadataByPath.has(r.path)) {
				metadataByPath.set(r.path, { source: "cli", scope: "temporary", origin: "top-level" });
			}
		}

		const cliEnabledExtensions = getEnabledPaths(cliExtensionPaths.extensions);
		const cliEnabledSkills = getEnabledPaths(cliExtensionPaths.skills);
		const cliEnabledPrompts = getEnabledPaths(cliExtensionPaths.prompts);
		const cliEnabledThemes = getEnabledPaths(cliExtensionPaths.themes);

		// ===== extensions =====
		// noExtensions 时只保留 CLI 临时路径；否则 CLI 路径优先、常规来源其次
		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);

		const extensionsResult = await this.loadFinalExtensionSet(extensionPaths, preTrustExtensions);
		// CLI 显式传入的本地扩展路径若不存在，直接记为加载错误
		for (const p of this.additionalExtensionPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved)) {
					extensionsResult.errors.push({ path: resolved, error: `Extension path does not exist: ${resolved}` });
				}
			}
		}
		this.extensionsResult = this.extensionsOverride ? this.extensionsOverride(extensionsResult) : extensionsResult;
		this.applyExtensionSourceInfo(this.extensionsResult.extensions, metadataByPath);

		// ===== skills =====
		const skillPaths = this.noSkills
			? this.mergePaths(cliEnabledSkills, this.additionalSkillPaths)
			: this.mergePaths([...cliEnabledSkills, ...enabledSkills], this.additionalSkillPaths);

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		// CLI 传入的本地 skill 路径若不存在则报 error；some(...) 去重避免与加载诊断重复报告
		for (const p of this.additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		// ===== prompt templates =====
		const promptPaths = this.noPromptTemplates
			? this.mergePaths(cliEnabledPrompts, this.additionalPromptTemplatePaths)
			: this.mergePaths([...cliEnabledPrompts, ...enabledPrompts], this.additionalPromptTemplatePaths);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		// CLI 传入的本地 prompt 路径若不存在则报 error（同样做诊断去重）
		for (const p of this.additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		// ===== themes =====
		const themePaths = this.noThemes
			? this.mergePaths(cliEnabledThemes, this.additionalThemePaths)
			: this.mergePaths([...cliEnabledThemes, ...enabledThemes], this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		// theme 的 CLI 路径不区分本地与否，一律做存在性检查
		for (const p of this.additionalThemePaths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		// ===== 项目上下文与系统提示词 =====
		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
					}),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		// 系统提示词：显式指定的来源优先，否则按「项目级（需项目受信任）→ 全局」探测
		const systemPromptSource = this.systemPromptSource ?? this.discoverSystemPromptFile();
		const baseSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;
		// 只有来源真的是文件时才记录其绝对路径（字面文本没有来源路径）
		this.systemPromptSourcePath =
			systemPromptSource && existsSync(systemPromptSource) ? resolvePath(systemPromptSource) : undefined;

		// 追加系统提示词：未显式指定时才探测默认的 APPEND_SYSTEM.md
		let appendSources = this.appendSystemPromptSource;
		if (!appendSources) {
			const discoveredAppendSystemPromptFile = this.discoverAppendSystemPromptFile();
			appendSources = discoveredAppendSystemPromptFile ? [discoveredAppendSystemPromptFile] : [];
		}
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		this.appendSystemPromptSourcePaths = appendSources
			.filter((source) => existsSync(source))
			.map((source) => resolvePath(source));
		this.loaded = true;
	}

	/**
	 * 以当前设置加载一组 extensions（不涉及 skills / prompts / themes，也不做冲突诊断）。
	 *
	 * includeInlineFactories 控制是否额外执行内联 factory（extensionFactories 选项）：
	 * 引导信任阶段需要内联 extension 参与判定，故传 true；其余场景保持 false。
	 */
	private async loadCurrentExtensionSet(options: { includeInlineFactories: boolean }): Promise<LoadExtensionsResult> {
		const resolvedPaths = await this.packageManager.resolve();
		const cliExtensionPaths = await this.packageManager.resolveExtensionSources(this.additionalExtensionPaths, {
			temporary: true,
		});
		const enabledExtensions = resolvedPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		const cliEnabledExtensions = cliExtensionPaths.extensions.filter((r) => r.enabled).map((r) => r.path);
		const extensionPaths = this.noExtensions
			? cliEnabledExtensions
			: this.mergePaths(cliEnabledExtensions, enabledExtensions);
		const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
		if (!options.includeInlineFactories) {
			return extensionsResult;
		}

		const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
		extensionsResult.extensions.push(...inlineExtensions.extensions);
		extensionsResult.errors.push(...inlineExtensions.errors);
		return extensionsResult;
	}

	/**
	 * 解析 extension 加载路径：基于 cwd，并把路径中的 Unicode 空白
	 * （如不间断空格）规范化为普通空格，保证两次解析结果可比较。
	 */
	private resolveExtensionLoadPath(path: string): string {
		return resolvePath(path, this.cwd, { normalizeUnicodeSpaces: true });
	}

	/**
	 * 加载最终生效的 extension 集合，兼容「引导阶段已预加载」的情形。
	 *
	 * 无预加载结果（preTrustExtensions 为空，即 reload 未走信任仲裁）时：
	 * 直接全量加载并附加内联 factory，随后做冲突诊断。
	 * 有预加载结果时：跳过引导阶段已成功 / 已失败的路径，只补加载剩余路径
	 * （复用引导阶段的 runtime），再按 extensionPaths 的原始顺序重排
	 * （保持加载顺序即优先级顺序），最后把内联 extension 追加到末尾，
	 * 并合并两个阶段的错误列表。
	 */
	private async loadFinalExtensionSet(
		extensionPaths: string[],
		preTrustExtensions: LoadExtensionsResult | undefined,
	): Promise<LoadExtensionsResult> {
		if (!preTrustExtensions) {
			const extensionsResult = await loadExtensionsCached(extensionPaths, this.cwd, this.eventBus);
			const inlineExtensions = await this.loadExtensionFactories(extensionsResult.runtime);
			extensionsResult.extensions.push(...inlineExtensions.extensions);
			extensionsResult.errors.push(...inlineExtensions.errors);
			this.addExtensionConflictDiagnostics(extensionsResult);
			return extensionsResult;
		}

		// 引导阶段已成功加载的扩展（内联的 <inline:...> 除外），按 resolvedPath 建索引
		const preloadedByPath = new Map(
			preTrustExtensions.extensions
				.filter((extension) => !extension.path.startsWith("<inline:"))
				.map((extension) => [extension.resolvedPath, extension]),
		);
		const failedPreloadPaths = new Set(
			preTrustExtensions.errors.map((error) => this.resolveExtensionLoadPath(error.path)),
		);
		// 待补加载：排除已成功和已失败的路径，避免重复执行 factory / 重复报错
		const remainingPaths = extensionPaths.filter((path) => {
			const resolvedPath = this.resolveExtensionLoadPath(path);
			return !preloadedByPath.has(resolvedPath) && !failedPreloadPaths.has(resolvedPath);
		});
		const remainingExtensions = await loadExtensionsCached(
			remainingPaths,
			this.cwd,
			this.eventBus,
			preTrustExtensions.runtime,
		);
		const loadedByPath = new Map(preloadedByPath);
		for (const extension of remainingExtensions.extensions) {
			loadedByPath.set(extension.resolvedPath, extension);
		}

		const inlineExtensions = preTrustExtensions.extensions.filter((extension) =>
			extension.path.startsWith("<inline:"),
		);
		// 按调用方传入的路径顺序重排合并结果，保证加载顺序（即优先级顺序）稳定
		const orderedExtensions = extensionPaths
			.map((path) => loadedByPath.get(this.resolveExtensionLoadPath(path)))
			.filter((extension): extension is Extension => extension !== undefined);
		orderedExtensions.push(...inlineExtensions);

		const extensionsResult: LoadExtensionsResult = {
			extensions: orderedExtensions,
			errors: [...preTrustExtensions.errors, ...remainingExtensions.errors],
			runtime: preTrustExtensions.runtime,
		};
		this.addExtensionConflictDiagnostics(extensionsResult);
		return extensionsResult;
	}

	/**
	 * 检测 extension 之间的命名冲突并把结果追加到 errors 列表。
	 */
	private addExtensionConflictDiagnostics(extensionsResult: LoadExtensionsResult): void {
		// 检测 extension 冲突（不同 extension 注册了同名的 tools / commands / flags）。
		// 所有 extension 都保持加载：冲突仅作为诊断上报，优先级由加载顺序决定。
		const conflicts = this.detectExtensionConflicts(extensionsResult.extensions);
		for (const conflict of conflicts) {
			extensionsResult.errors.push({ path: conflict.path, error: conflict.message });
		}
	}

	/**
	 * 把「自动发现 / 来自 package」的 skill 目录路径映射到其中的 SKILL.md 文件。
	 *
	 * 其余来源（用户手动配置的路径等）原样返回；仅当路径确为目录且其中存在
	 * SKILL.md 时才改指到该文件，并把目录的元数据同步登记给该文件路径，
	 * 保证后续生成 SourceInfo 时来源信息不丢失。
	 */
	private mapSkillPath(resource: ResolvedResource, metadataByPath: Map<string, PathMetadata>): string {
		if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
			return resource.path;
		}
		try {
			const stats = statSync(resource.path);
			if (!stats.isDirectory()) {
				return resource.path;
			}
		} catch {
			return resource.path;
		}
		const skillFile = join(resource.path, "SKILL.md");
		if (existsSync(skillFile)) {
			if (!metadataByPath.has(skillFile)) {
				metadataByPath.set(skillFile, resource.metadata);
			}
			return skillFile;
		}
		return resource.path;
	}

	/**
	 * 规范化 extendResources() 传入的路径：path 与 metadata.baseDir
	 * 都解析为基于 cwd 的绝对路径，便于后续与已加载路径比较、合并。
	 */
	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	/**
	 * 按路径列表重建 skills 并应用 skillsOverride 钩子。
	 *
	 * includeDefaults 为 false——默认目录的收集已由 packageManager 完成，
	 * 这里只加载显式传入的路径；noSkills 且无 CLI 追加路径时直接得到空结果。
	 * 加载后为每个 skill 回填 SourceInfo，优先级：
	 * extension 登记信息 > 资源自带 sourceInfo > 按路径推断的默认值。
	 */
	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	/**
	 * 按路径列表重建 prompt templates：加载 → 按名称去重 → 应用 promptsOverride，
	 * SourceInfo 回填逻辑与 updateSkillsFromPaths 一致。
	 */
	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const allPrompts = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			promptsResult = this.dedupePrompts(allPrompts);
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	/**
	 * 按路径列表重建 themes：加载（不含默认目录）→ 按名称去重 → 应用 themesOverride。
	 * SourceInfo 回填以 theme.sourcePath 为键（主题对象可能没有对应文件路径）。
	 */
	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			const loaded = this.loadThemes(themePaths, false);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	/**
	 * 为 extension 及其 commands / tools 统一回填 SourceInfo：
	 * extension 内的所有命令与工具都继承 extension 自身的来源信息。
	 */
	private applyExtensionSourceInfo(extensions: Extension[], metadataByPath: Map<string, PathMetadata>): void {
		for (const extension of extensions) {
			extension.sourceInfo =
				this.findSourceInfoForPath(extension.path, undefined, metadataByPath) ??
				this.getDefaultSourceInfoForPath(extension.path);
			for (const command of extension.commands.values()) {
				command.sourceInfo = extension.sourceInfo;
			}
			for (const tool of extension.tools.values()) {
				tool.sourceInfo = extension.sourceInfo;
			}
		}
	}

	/**
	 * 查找资源路径对应的 SourceInfo（来源展示信息）。
	 *
	 * 查找顺序：
	 * 1. `<xxx:...>` 形式的合成路径（如内联 extension）→ 走默认推断；
	 * 2. extraSourceInfos（extendResources 登记的路径）→ 支持目录前缀匹配，
	 *    资源位于某登记目录之下也算命中；
	 * 3. metadataByPath（packageManager 解析出的路径元数据）→ 同样先精确后前缀。
	 * 都未命中时返回 undefined，由调用方决定回退策略。
	 */
	private findSourceInfoForPath(
		resourcePath: string,
		extraSourceInfos?: Map<string, SourceInfo>,
		metadataByPath?: Map<string, PathMetadata>,
	): SourceInfo | undefined {
		if (!resourcePath) {
			return undefined;
		}

		if (resourcePath.startsWith("<")) {
			// 合成路径（<inline:...> 等）无法映射到文件系统，直接走默认推断
			return this.getDefaultSourceInfoForPath(resourcePath);
		}

		const normalizedResourcePath = resolve(resourcePath);
		// 先查 extendResources 登记的路径：命中目录本身或其子路径均可
		if (extraSourceInfos) {
			for (const [sourcePath, sourceInfo] of extraSourceInfos.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return { ...sourceInfo, path: resourcePath };
				}
			}
		}

		if (metadataByPath) {
			// 再查包管理器登记的元数据：先精确匹配，再做目录前缀匹配
			const exact = metadataByPath.get(normalizedResourcePath) ?? metadataByPath.get(resourcePath);
			if (exact) {
				return createSourceInfo(resourcePath, exact);
			}

			for (const [sourcePath, metadata] of metadataByPath.entries()) {
				const normalizedSourcePath = resolve(sourcePath);
				if (
					normalizedResourcePath === normalizedSourcePath ||
					normalizedResourcePath.startsWith(`${normalizedSourcePath}${sep}`)
				) {
					return createSourceInfo(resourcePath, metadata);
				}
			}
		}

		return undefined;
	}

	/**
	 * 登记信息查不到时，按路径位置推断默认 SourceInfo。
	 *
	 * `<xxx:...>` 合成路径从尖括号中拆出 source 名；位于 agentDir 下的
	 * skills / prompts / themes / extensions 视为用户级（scope: "user"）；
	 * 位于项目配置目录下视为项目级；其余一律按临时资源处理，
	 * baseDir 取路径本身（目录）或其父目录（文件）。
	 */
	private getDefaultSourceInfoForPath(filePath: string): SourceInfo {
		if (filePath.startsWith("<") && filePath.endsWith(">")) {
			// 合成路径：<inline:xxx> → source 取 "inline"；拆不出名字时兜底为 "temporary"
			return {
				path: filePath,
				source: filePath.slice(1, -1).split(":")[0] || "temporary",
				scope: "temporary",
				origin: "top-level",
			};
		}

		const normalizedPath = resolve(filePath);
		// agentDir（用户级）与项目配置目录下的四个资源根
		const agentRoots = [
			join(this.agentDir, "skills"),
			join(this.agentDir, "prompts"),
			join(this.agentDir, "themes"),
			join(this.agentDir, "extensions"),
		];
		const projectRoots = [
			join(this.cwd, CONFIG_DIR_NAME, "skills"),
			join(this.cwd, CONFIG_DIR_NAME, "prompts"),
			join(this.cwd, CONFIG_DIR_NAME, "themes"),
			join(this.cwd, CONFIG_DIR_NAME, "extensions"),
		];

		for (const root of agentRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "user", origin: "top-level", baseDir: root };
			}
		}

		for (const root of projectRoots) {
			if (this.isUnderPath(normalizedPath, root)) {
				return { path: filePath, source: "local", scope: "project", origin: "top-level", baseDir: root };
			}
		}

		// 兜底：其余路径一律按临时资源处理
		return {
			path: filePath,
			source: "local",
			scope: "temporary",
			origin: "top-level",
			baseDir: statSync(normalizedPath).isDirectory() ? normalizedPath : resolve(normalizedPath, ".."),
		};
	}

	/**
	 * 合并两组资源路径：primary 在前、additional 在后，并按规范化（realpath）
	 * 结果去重——同一物理路径只保留首次出现的那份，即优先级更高来源的路径。
	 */
	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			// 用 realpath 而非解析后的路径去重：符号链接会指向同一物理位置
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	/** 把资源路径解析为基于 cwd 的绝对路径（顺带去除首尾空白）。 */
	private resolveResourcePath(p: string): string {
		return resolvePath(p, this.cwd, { trim: true });
	}

	/**
	 * 从多个路径加载 themes：路径为目录则扫描其中所有 .json 文件，
	 * 为文件则要求 .json 后缀。任何失败都不抛出，统一降级为 warning 诊断，
	 * 保证其余主题仍能加载。
	 */
	private loadThemes(
		paths: string[],
		includeDefaults: boolean = true,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		// 默认目录（用户级 + 项目级）；reload 主流程传入 false，默认目录已由 packageManager 覆盖
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics);
			}
		}

		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	/**
	 * 扫描目录加载其中全部 .json 主题文件。
	 *
	 * 符号链接需要 stat 实际目标来判断是否为文件——readdir 的 dirent
	 * 只反映链接本身；断链（目标不存在）的符号链接直接跳过。
	 */
	private loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	/** 加载单个主题文件；失败记为 warning 诊断而不是中断整体加载。 */
	private loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
		try {
			themes.push(loadThemeFromPath(filePath));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	/**
	 * 执行内联 extension factory（构造选项 extensionFactories）。
	 *
	 * 支持两种形态：直接的 factory 函数，或 { name, factory, hidden? } 包装对象；
	 * 合成路径取 `<inline:名字>`（未命名时用序号），用于错误上报与 sourceInfo 推断；
	 * hidden 标记仅命名形态支持。单个 factory 失败只记错误，不影响其余 factory。
	 */
	private async loadExtensionFactories(runtime: ExtensionRuntime): Promise<{
		extensions: Extension[];
		errors: Array<{ path: string; error: string }>;
	}> {
		const extensions: Extension[] = [];
		const errors: Array<{ path: string; error: string }> = [];

		for (const [index, input] of this.extensionFactories.entries()) {
			// typeof 区分两种形态：非函数即 { name, factory, hidden? } 包装对象
			const isNamed = typeof input !== "function";
			const factory = isNamed ? input.factory : input;
			// 未命名时用 1 起始的序号作为合成路径标识
			const extensionPath = `<inline:${isNamed ? input.name : index + 1}>`;
			try {
				const extension = await loadExtensionFromFactory(factory, this.cwd, this.eventBus, runtime, extensionPath);
				extension.hidden = isNamed && input.hidden;
				extensions.push(extension);
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to load extension";
				errors.push({ path: extensionPath, error: message });
			}
		}

		return { extensions, errors };
	}

	/**
	 * 按 name 对 prompt templates 去重：先到先得，后出现的同名模板被丢弃
	 * 并记一条 collision 诊断（winnerPath / loserPath 标明保留者与被丢弃者）。
	 */
	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	/**
	 * 按 name 对 themes 去重：先到先得（无名主题统一归入 "unnamed" 组），
	 * 冲突记 collision 诊断；来源路径缺失时以 "<builtin>" 兜底展示。
	 */
	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	/**
	 * 探测系统提示词文件：项目级 `.pi/SYSTEM.md`（须项目已受信任）优先于
	 * 全局 `~/.pi/SYSTEM.md`，都不存在时返回 undefined。
	 */
	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	/**
	 * 探测追加系统提示词文件：项目级 `.pi/APPEND_SYSTEM.md`（须项目已受信任）
	 * 优先于全局 `~/.pi/APPEND_SYSTEM.md`，都不存在时返回 undefined。
	 */
	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	/**
	 * 判断 target 是否等于 root 或位于 root 之下。
	 * 前缀比较前必须补上路径分隔符，避免 `/a/bc` 误命中 `/a/b` 这类目录名前缀。
	 */
	private isUnderPath(target: string, root: string): boolean {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		// Windows 根目录自带结尾分隔符，其余情况手动补一个 sep
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	}

	/**
	 * 检测 extension 之间的命名冲突：同名 tool 或 flag 注册到不同 extension 时报告冲突；
	 * 同一 extension 内部的重复注册不报告（existingOwner === ext.path 的分支）。
	 */
	private detectExtensionConflicts(extensions: Extension[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// 记录每个 tool / flag 名首次注册它的 extension 路径，用于发现跨 extension 重名
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const ext of extensions) {
			// 检查工具名冲突
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.path);
				}
			}

			// 检查 flag 名冲突
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.path) {
					conflicts.push({
						path: ext.path,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.path);
				}
			}
		}

		return conflicts;
	}
}
