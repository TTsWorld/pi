/**
 * @file package-manager.ts —— Pi Packages（扩展资源包）管理器核心实现
 *
 * @description
 * 本文件实现 Pi 扩展资源包的完整生命周期管理：安装（npm / git / 本地路径三种来源）、
 * 卸载、更新检查与批量更新、配置持久化（写入 user / project 两级 settings），
 * 以及把所有已配置资源解析为最终的扩展 / 技能 / 提示词 / 主题路径列表
 * （对应 CLI 的 `pi install / remove / list / update` 子命令）。
 *
 * 主要功能点：
 * - 三种包来源：npm spec（含精确版本 pin 与语义化范围）、git URL（含 ref）、本地路径；
 * - 资源解析 `resolve()`：合并 project（优先）与 user 两级 settings 中的包、
 *   settings 中的显式资源条目、以及约定目录（.pi/、.agents/skills 等）自动发现的资源，
 *   按优先级排序并去重（同名冲突时先到者胜）；
 * - 包内过滤：settings 可对包内四类资源（extensions/skills/prompts/themes）配置
 *   glob 与 `!`/`+`/`-` 覆写模式，autoload=false 时按「增量（delta）」语义处理；
 * - npm 安装走托管安装根目录（agentDir/npm 或 .pi/npm），git 更新通过
 *   fetch + reset --hard + clean 保持克隆树纯净，并用标记文件保证更新中断后可恢复；
 * - 支持 PI_OFFLINE 离线模式（跳过一切网络操作）与进度回调（供 UI 展示进度）。
 *
 * 依赖关系：
 * - node:fs / node:child_process：文件系统操作与 npm/git 子进程执行；
 * - `ignore` / `minimatch` / `semver`：gitignore 规则、glob 匹配、语义化版本比较；
 * - `../config.ts`：项目配置目录名（CONFIG_DIR_NAME，即 .pi）；
 * - `./settings-manager.ts`：user / project 两级设置的读写；
 * - `./pi-manifest.ts`：包 manifest（package.json 中的 pi 扩展字段）解析；
 * - `../utils/git.ts`：git URL 解析；`./output-guard.ts`：stdout 占用检测。
 */

import type { ChildProcess, ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	globSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";

/**
 * 获取当前进程的环境变量。
 *
 * 为什么不直接用 process.env：Linux 上若 process.env 为空（进程以空环境启动的
 * 沙箱场景），把空 env 传给子进程会让 npm/git 丢失 PATH 等关键变量；
 * 此时从 /proc/self/environ 逐条（以 \0 分隔）重新解析出真实环境。
 * 非 Linux 平台或 env 正常时直接返回 process.env；读取失败也静默回退，本函数永不抛错。
 */
function getEnv(): NodeJS.ProcessEnv {
	if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
		return process.env;
	}
	try {
		const data = readFileSync("/proc/self/environ", "utf-8");
		const env: NodeJS.ProcessEnv = {};
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			if (idx > 0) {
				env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
		return env;
	} catch {
		return process.env;
	}
}

import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { gt, maxSatisfying, rcompare, satisfies, valid, validRange } from "semver";
import { CONFIG_DIR_NAME } from "../config.ts";
import { spawnProcess, spawnProcessSync } from "../utils/child-process.ts";
import { type GitSource, parseGitUrl } from "../utils/git.ts";
import { canonicalizePath, isLocalPath, markPathIgnoredByCloudSync, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { isStdoutTakenOver } from "./output-guard.ts";
import { type PiManifest, readPiManifest } from "./pi-manifest.ts";
import type { PackageSource, SettingsManager } from "./settings-manager.ts";

/** 网络类子进程（npm view / git ls-remote 等）的超时时间：10 秒 */
const NETWORK_TIMEOUT_MS = 10000;
/** npm 更新检查的并发数（同时最多 4 个包查询 registry） */
const UPDATE_CHECK_CONCURRENCY = 4;
/** git 更新的并发数（同时最多 4 个仓库执行 fetch/reset） */
const GIT_UPDATE_CONCURRENCY = 4;

/**
 * 是否处于离线模式：PI_OFFLINE 环境变量为 "1" / "true" / "yes"（大小写不敏感）时启用。
 * 离线模式下跳过所有网络操作（安装、更新检查、git fetch），只使用本地已缓存内容。
 */
function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * 判断版本串是否为精确的语义化版本（如 "1.2.3"）。
 * 精确版本视为「已 pin」：安装后不再参与更新检查。
 */
function isExactNpmVersion(version: string | undefined): boolean {
	return valid(version ?? "") !== null;
}

/**
 * 把版本串解析为语义化版本范围；不是合法 range（如 dist-tag "latest"）时返回 undefined。
 */
function getNpmVersionRange(version: string | undefined): string | undefined {
	return version ? (validRange(version) ?? undefined) : undefined;
}

/** 单个资源的来源元数据：记录该资源从何处被发现，用于排序去重与 UI 展示 */
export interface PathMetadata {
	/** 配置中的原始来源串（包名 / git URL / "local" / "auto"） */
	source: string;
	/** 作用域：user（全局）/ project（项目级）/ temporary（临时会话级） */
	scope: SourceScope;
	/** 来源层级：package（来自已安装的包）或 top-level（settings 直配 / 自动发现） */
	origin: "package" | "top-level";
	/** 资源的基准目录（包安装根目录或配置目录），供相对路径解析 */
	baseDir?: string;
}

/** 解析后的单个资源：绝对路径 + 是否启用 + 来源元数据 */
export interface ResolvedResource {
	/** 资源文件的绝对路径 */
	path: string;
	/** 是否启用（可被 settings 中的模式禁用） */
	enabled: boolean;
	metadata: PathMetadata;
}

/** `resolve()` 的返回值：四类资源各自的解析结果列表（已按优先级排序并去重） */
export interface ResolvedPaths {
	/** 扩展入口文件（.ts / .js） */
	extensions: ResolvedResource[];
	/** 技能文件（SKILL.md 或散装 .md） */
	skills: ResolvedResource[];
	/** 提示词文件（.md） */
	prompts: ResolvedResource[];
	/** 主题文件（.json） */
	themes: ResolvedResource[];
}

/**
 * 解析时发现包未安装的处理策略（由 resolve() 的 onMissing 回调返回）：
 * - "install"：自动安装后继续
 * - "skip"：跳过该包
 * - "error"：抛出错误
 */
export type MissingSourceAction = "install" | "skip" | "error";

/** 进度事件：install/remove/update 等操作的生命周期通知（供 UI 展示进度） */
export interface ProgressEvent {
	/** 事件阶段：开始 / 进行中 / 完成 / 出错 */
	type: "start" | "progress" | "complete" | "error";
	/** 触发本事件的操作类型 */
	action: "install" | "remove" | "update" | "clone" | "pull";
	/** 相关的包来源串 */
	source: string;
	/** 附加消息（开始时为描述、出错时为错误信息） */
	message?: string;
}

/** 进度回调函数类型：接收 ProgressEvent */
export type ProgressCallback = (event: ProgressEvent) => void;

/** 一个可用的更新（更新提示 / 检查结果的数据单元） */
export interface PackageUpdate {
	/** 配置中的包来源串 */
	source: string;
	/** 展示名（npm 包名或 host/path） */
	displayName: string;
	/** 包类型 */
	type: "npm" | "git";
	/** 所属作用域（temporary 作用域不参与更新检查） */
	scope: Exclude<SourceScope, "temporary">;
}

/** settings 中已配置的一个包（`pi list` 输出的数据源） */
export interface ConfiguredPackage {
	/** 配置中的包来源串 */
	source: string;
	/** 所属作用域 */
	scope: "user" | "project";
	/** 是否为对象形式（带资源过滤配置）而非纯字符串 */
	filtered: boolean;
	/** 已安装路径（若已安装且磁盘上存在） */
	installedPath?: string;
}

/**
 * 包管理器对外接口：安装 / 卸载 / 更新 / 解析 / 配置读写。
 * 各方法的 `options.local === true` 表示操作 project 作用域（项目 .pi/ 目录），
 * 否则操作 user 作用域（全局 agentDir）。
 */
export interface PackageManager {
	/**
	 * 解析所有已配置资源为最终路径列表。
	 * 可传入 onMissing 回调定制「包已配置但未安装」时的行为（默认自动安装）。
	 */
	resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
	/** 安装一个包（不写入 settings） */
	install(source: string, options?: { local?: boolean }): Promise<void>;
	/** 安装一个包并持久化到 settings */
	installAndPersist(source: string, options?: { local?: boolean }): Promise<void>;
	/** 卸载一个包（不改 settings） */
	remove(source: string, options?: { local?: boolean }): Promise<void>;
	/** 卸载一个包并从 settings 中移除；返回 settings 是否发生变化 */
	removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean>;
	/** 更新包：不传 source 时更新全部；传入时仅更新匹配的包 */
	update(source?: string): Promise<void>;
	/** 列出 settings 中已配置的包（含安装路径） */
	listConfiguredPackages(): ConfiguredPackage[];
	/**
	 * 仅解析给定来源列表（忽略 settings 配置）。
	 * temporary: true 时安装到临时目录（不持久化）；local: true 时按 project 作用域解析。
	 */
	resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths>;
	/** 把来源写入 settings（等价来源已存在时规范化其写法）；返回是否发生变化 */
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean;
	/** 从 settings 中移除来源；返回是否发生变化 */
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean;
	/** 设置进度回调（传 undefined 清除） */
	setProgressCallback(callback: ProgressCallback | undefined): void;
	/** 查询某来源在指定作用域下的安装路径（未安装返回 undefined） */
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined;
}

/** 构造 DefaultPackageManager 所需的参数 */
interface PackageManagerOptions {
	/** 当前工作目录（项目根） */
	cwd: string;
	/** 全局 agent 目录（如 ~/.pi/agent），user 作用域的安装根 */
	agentDir: string;
	/** 设置管理器（user / project 两级 settings） */
	settingsManager: SettingsManager;
}

/**
 * 来源作用域：
 * - user：全局（~/.pi/agent）
 * - project：项目级（.pi/ 目录，需项目受信任）
 * - temporary：仅当前会话的临时安装（agentDir/tmp 下，不持久化）
 */
type SourceScope = "user" | "project" | "temporary";

/** npm 来源解析结果 */
type NpmSource = {
	type: "npm";
	/** 完整安装 spec（name@version 形式） */
	spec: string;
	/** 包名（可含 scope，如 @org/pkg） */
	name: string;
	/** 版本串（精确版本 / 范围 / dist-tag，可能为空） */
	version?: string;
	/** 版本对应的合法 semver 范围（tag 等非 range 时为空） */
	range?: string;
	/** 是否为精确版本（已 pin，不参与更新） */
	pinned: boolean;
};

/** 本地路径来源 */
type LocalSource = {
	type: "local";
	path: string;
};

/** 解析后的来源：三种之一 */
type ParsedSource = NpmSource | GitSource | LocalSource;

/** 可持久化的安装作用域（不含 temporary） */
type InstalledSourceScope = Exclude<SourceScope, "temporary">;

/** settings 中待更新的一个来源 */
interface ConfiguredUpdateSource {
	source: string;
	scope: InstalledSourceScope;
}

/** 待更新的 npm 包（附解析结果） */
interface NpmUpdateTarget extends ConfiguredUpdateSource {
	parsed: NpmSource;
}

/** 待更新的 git 包（附解析结果） */
interface GitUpdateTarget extends ConfiguredUpdateSource {
	parsed: GitSource;
}

/**
 * 资源累积器：resolve() 过程中以 path 为键收集四类资源。
 * 用 Map 而非数组：addResource 依赖「首见即定」实现同名冲突时先到者胜。
 */
interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * 根据资源元数据计算数值化的优先级序号。
 * 序号越小优先级越高。用于对解析出的资源排序，使同名冲突的
 * 「先到者胜（first wins）」策略产生正确结果。
 *
 * 优先级从高到低：
 *   0  project + settings 显式条目（source: "local", scope: "project"）
 *   1  project + 自动发现（source: "auto", scope: "project"）
 *   2  user + settings 显式条目（source: "local", scope: "user"）
 *   3  user + 自动发现（source: "auto", scope: "user"）
 *   4  包内资源（origin: "package"）
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

/**
 * settings 中对单个包的资源配置（packages 数组的对象形式条目）。
 * 每类资源是一组模式串：普通 glob 为包含，`!` 前缀排除，`+`/`-` 前缀精确强制包含/排除。
 * autoload: false 表示该包默认不自动加载，只在需要时按模式增量启用部分资源。
 */
interface PackageFilter {
	autoload?: boolean;
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
}

/** 四类可管理资源的类型标识 */
type ResourceType = "extensions" | "skills" | "prompts" | "themes";

/** 全部资源类型（遍历用） */
const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

/** 各资源类型对应的文件名匹配正则（供目录递归收集使用） */
const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
	themes: /\.json$/,
};

/** 资源发现时尊重的 ignore 文件名（均为 gitignore 语法） */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** ignore 库匹配器的类型别名 */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 把平台路径分隔符统一替换为 "/"，得到 posix 风格路径（glob / ignore 匹配需要） */
function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/** 获取用户主目录：优先 HOME 环境变量，回退到 os.homedir() */
function getHomeDir(): string {
	return process.env.HOME || homedir();
}

/**
 * 获取（并按需创建）扩展专用临时目录：<agentDir>/tmp/extensions。
 * 权限固定为 0o700（仅属主可访问）——临时目录里可能存放第三方代码；
 * chmodSync 兜底是因为 mkdir 的 mode 不会修改已存在目录的权限。
 */
export function getExtensionTempFolder(agentDir: string): string {
	const tempFolder = join(agentDir, "tmp", "extensions");
	mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
	chmodSync(tempFolder, 0o700);
	return tempFolder;
}

/**
 * 给单条 gitignore 规则加上目录前缀，使其相对子目录生效。
 * ignore 库的规则总是相对根目录匹配，而子目录里的 .gitignore 规则只应作用于
 * 该子目录之下，因此把规则改写成 "子目录/规则" 形式。
 *
 * 处理细节：
 * - 空行与注释行（# 开头且未被 \# 转义）返回 null 表示跳过；
 * - `!` 取反标志剥离后记入 negated，最终重新拼回开头；
 * - `\!`（转义的字面感叹号）只去掉转义反斜杠；
 * - 去掉开头的 `/`：gitignore 中前导 / 表示「仅匹配根下该路径」，
 *   加前缀后这一含义由 prefix 自然表达。
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * 读取 dir 下的 ignore 文件（.gitignore / .ignore / .fdignore），
 * 把规则（已加上相对 rootDir 的路径前缀）合入匹配器。
 * 文件不存在或读取失败均静默忽略——ignore 规则只是资源发现的过滤项，
 * 不应让整个解析过程失败。
 */
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

/** 判断条目是否为「模式」：带 !/+/- 覆写前缀，或含 glob 通配符 */
function isPattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

/** 判断条目是否为覆写模式（! 排除 / + 强制包含 / - 强制排除） */
function isOverridePattern(s: string): boolean {
	return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

/** 判断条目是否含 glob 通配符（* 或 ?） */
function hasGlobPattern(s: string): boolean {
	return s.includes("*") || s.includes("?");
}

/**
 * 展开包 manifest 中的 glob 条目为具体文件列表。
 * glob 条目只能发现可见路径；精确（非 glob）条目则可指向点开头的隐藏路径或符号链接目录。
 * 这里额外过滤掉路径中任何以 "." 开头的段，并排序保证输出稳定（glob 默认不匹配隐藏文件）。
 */
function expandPackageGlob(pattern: string, root: string): string[] {
	return globSync(pattern, { cwd: root })
		.map((match) => resolve(root, match))
		.filter((path) =>
			relative(root, path)
				.split(sep)
				.every((segment) => segment === ".." || !segment.startsWith(".")),
		)
		.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 把条目列表拆为「精确条目」与「模式条目」两组，二者匹配语义不同 */
function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
	const plain: string[] = [];
	const patterns: string[] = [];
	for (const entry of entries) {
		if (isPattern(entry)) {
			patterns.push(entry);
		} else {
			plain.push(entry);
		}
	}
	return { plain, patterns };
}

/**
 * 递归收集目录下文件名匹配 filePattern 的文件（prompts / themes 等通用收集器）。
 *
 * 规则：
 * - 跳过点开头的隐藏条目与 node_modules；
 * - 符号链接用 statSync 跟踪真实目标判断类型（Dirent 对符号链接只报告 symlink 本身），
 *   stat 失败（悬空链接）则跳过；
 * - 目录级 ignore 规则逐层增量合入（规则相对 rootDir 计算前缀）；
 * - 目录以 "path/" 形式参与 ignore 匹配（目录被忽略时其下所有内容一并跳过）；
 * - 任何读取异常都吞掉并返回已收集部分——资源发现必须永不抛错。
 */
function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			// 隐藏文件与 node_modules 一律跳过
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			// 符号链接需 stat 跟踪真实目标；悬空链接直接跳过
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			// 目录以斜杠结尾参与匹配，兼容 "dir/" 形式的 ignore 规则
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// 忽略错误：目录不可读等情况直接返回已收集结果
	}

	return files;
}

/**
 * 技能发现模式：
 * - "pi"：pi 约定目录（.pi/skills 等）——根目录中的散装 .md 也算技能
 * - "agents"：通用 .agents/skills 约定——只认子目录中的 SKILL.md
 */
type SkillDiscoveryMode = "pi" | "agents";

/**
 * 收集技能文件：每个技能是一个目录 + 其中的 SKILL.md。
 *
 * 对同一批目录项做两轮扫描：
 * 1. 先找当前目录自身的 SKILL.md——命中且未被 ignore 就立即返回，
 *    不再深入子目录（技能目录内不该再嵌套技能）；
 * 2. 再遍历子目录递归收集（两种模式的差异体现在散装 .md 的取舍上）。
 * 隐藏条目、node_modules、悬空符号链接与读取异常一律跳过。
 */
function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		// 第一轮：当前目录自身的 SKILL.md 优先，找到即终止整个收集
		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		// 第二轮：处理散装 .md 与子目录递归
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			// pi 模式：仅根目录收散装 .md；agents 模式：仅子目录收 SKILL.md
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// 忽略错误：目录不可读等情况直接返回已收集结果
	}

	return entries;
}

/** 自动发现场景下的技能收集薄封装（无外部 ignore 上下文时使用） */
function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

/**
 * 从 startDir 逐级向上查找 git 仓库根（含 .git 的最近祖先目录）。
 * 到达文件系统根（parent === dir）仍未找到则返回 null。
 */
function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/**
 * 收集 startDir 及其各级祖先目录下的 .agents/skills 目录（由近及远排序）。
 * 向上遍历以 git 仓库根为界——仓库外的 .agents 与本项目无关，不应被发现。
 */
function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		// 到达仓库根即停止向上遍历
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

/** 自动发现提示词：只收集 dir 顶层（非递归）的 .md 文件，尊重 ignore 文件 */
function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// 忽略错误：目录不可读等情况直接返回已收集结果
	}

	return entries;
}

/** 自动发现主题：只收集 dir 顶层（非递归）的 .json 文件，尊重 ignore 文件 */
function collectAutoThemeEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".json")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// 忽略错误：目录不可读等情况直接返回已收集结果
	}

	return entries;
}

/**
 * 解析一个目录的「显式扩展入口」：
 * 1. 优先读 package.json 的 pi manifest（extensions 字段），逐条解析为绝对路径，
 *    只保留磁盘上真实存在的条目；
 * 2. manifest 缺失或全部失效时，回退到约定的 index.ts / index.js 单入口。
 * 两者都不可用时返回 null（调用方据此判断该目录是否声明了扩展）。
 */
function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				// manifest 声明的路径可能不存在（打包缺失等），逐条过滤
				if (existsSync(resolvedExtPath)) {
					entries.push(resolvedExtPath);
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	// 回退：约定式单入口 index.ts / index.js
	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) {
		return [indexTs];
	}
	if (existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * 自动发现扩展入口：
 * 若 dir 自身就是扩展（有 package.json manifest 或 index 入口）则直接返回其入口；
 * 否则扫描目录内容——顶层的 .ts/.js 文件各算一个扩展，
 * 子目录则递归调用 resolveExtensionEntries 只取其显式声明的入口
 * （避免把包内部的工具脚本误认为扩展）。
 */
function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	// 先检查目录本身是否有显式扩展入口（package.json manifest 或 index 文件）
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// 否则从目录内容中发现扩展
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(fullPath);
			} else if (isDir) {
				// 子目录只认显式入口，不深入散扫 .ts/.js
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// 忽略错误：目录不可读等情况直接返回已收集结果
	}

	return entries;
}

/**
 * 按资源类型从目录收集资源文件。
 * 扩展使用智能发现（manifest / 子目录 index.ts 入口），
 * 技能用 SKILL.md 约定，prompts / themes 用递归文件名匹配。
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

/**
 * 判断文件是否匹配任一 glob 模式。
 * 同一模式会以三种形式尝试匹配：相对 baseDir 的路径、纯文件名、绝对 posix 路径，
 * 让用户无论写相对路径、文件名还是绝对路径都能命中。
 * 特例：SKILL.md 允许用其所在目录（相对路径 / 目录名 / 目录绝对路径）来匹配，
 * 因为技能习惯上按目录名引用（如 "skills/foo"）。
 */
function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

/** 规范化精确路径条目：去掉 ./ 或 .\ 前缀并统一为 posix 分隔符 */
function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

/**
 * 判断文件是否精确命中任一条目（不做 glob 解释）。
 * 与 matchesAnyPattern 同理：相对路径、绝对路径均可命中；
 * SKILL.md 同样允许用其所在目录命中。
 */
function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

/** 从条目列表中筛出覆写模式（! / + / - 开头） */
function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

/**
 * 用覆写模式判定自动发现资源是否启用（用于 settings 中对自动发现目录的微调）。
 * 判定按固定优先级依次叠加，后判定者覆盖先判定者：
 *   默认启用 → `!`（glob 排除）禁用 → `+`（精确强制包含）重新启用 → `-`（精确强制排除）最终禁用。
 * 注意 + / - 是精确匹配，故能精确盖掉 ! 的 glob 排除范围。
 */
function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/**
 * 对路径集合应用模式列表，返回启用路径的 Set。
 * 模式类型：
 * - 普通模式：包含匹配的路径（无普通模式时默认全部包含）
 * - `!pattern`：排除匹配的路径
 * - `+path`：精确强制包含（可推翻 ! 排除）
 * - `-path`：精确强制排除（优先级最高，可推翻 + 强制包含）
 */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
	const includes: string[] = [];
	const excludes: string[] = [];
	const forceIncludes: string[] = [];
	const forceExcludes: string[] = [];

	for (const p of patterns) {
		if (p.startsWith("+")) {
			forceIncludes.push(p.slice(1));
		} else if (p.startsWith("-")) {
			forceExcludes.push(p.slice(1));
		} else if (p.startsWith("!")) {
			excludes.push(p.slice(1));
		} else {
			includes.push(p);
		}
	}

	// 第 1 步：应用包含模式（无包含模式时保留全部）
	let result: string[];
	if (includes.length === 0) {
		result = [...allPaths];
	} else {
		result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
	}

	// 第 2 步：应用排除模式
	if (excludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
	}

	// 第 3 步：强制包含（从全量路径中加回，推翻排除）
	if (forceIncludes.length > 0) {
		for (const filePath of allPaths) {
			if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
				result.push(filePath);
			}
		}
	}

	// 第 4 步：强制排除（即使被包含或强制包含也移除）
	if (forceExcludes.length > 0) {
		result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
	}

	return new Set(result);
}

/**
 * autoload=false（delta 增量）模式下的模式匹配：
 * 只返回被模式显式命中的路径及其启用状态（普通模式 / + 为启用，- / ! 为禁用），
 * 未命中的路径不进入结果（保持包全局不加载的默认态）。
 * 后匹配的模式覆盖先匹配的（Map.set 语义）。
 */
function applyAutoloadDisabledPatterns(allPaths: string[], patterns: string[], baseDir: string): Map<string, boolean> {
	const result = new Map<string, boolean>();
	for (const pattern of patterns) {
		const target = pattern.slice(
			pattern.startsWith("+") || pattern.startsWith("-") || pattern.startsWith("!") ? 1 : 0,
		);
		const enabled = !pattern.startsWith("-") && !pattern.startsWith("!");
		// + / - 为精确匹配语义，普通模式与 ! 为 glob 匹配语义
		const exact = pattern.startsWith("+") || pattern.startsWith("-");
		for (const filePath of allPaths) {
			if (
				exact ? matchesAnyExactPattern(filePath, [target], baseDir) : matchesAnyPattern(filePath, [target], baseDir)
			) {
				result.set(filePath, enabled);
			}
		}
	}
	return result;
}

/**
 * PackageManager 的默认实现。
 *
 * 目录布局（安装根）：
 * - user 作用域：npm 包装到 <agentDir>/npm，git 克隆到 <agentDir>/git；
 * - project 作用域：npm 包装到 <cwd>/.pi/npm，git 克隆到 <cwd>/.pi/git；
 * - temporary 作用域：统一装到 <agentDir>/tmp/extensions 下的临时目录。
 *
 * 解析流程（resolve）：project 与 user 两级 settings 中的 packages 先去重合并
 * （project 优先），逐个安装/定位后收集包内资源；再叠加 settings 中的显式
 * 资源条目与各约定目录的自动发现资源；最后按优先级排序、按规范化路径去重。
 */
export class DefaultPackageManager implements PackageManager {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	/** 全局 npm root 的缓存（配合 commandKey 失效） */
	private globalNpmRoot: string | undefined;
	/** 生成 globalNpmRoot 时所用 npm 命令的键，命令变化时缓存失效 */
	private globalNpmRootCommandKey: string | undefined;
	private progressCallback: ProgressCallback | undefined;

	constructor(options: PackageManagerOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager;
	}

	/** 设置进度回调（传 undefined 清除） */
	setProgressCallback(callback: ProgressCallback | undefined): void {
		this.progressCallback = callback;
	}

	/**
	 * 把包来源写入 settings（user 或 project 级）。
	 *
	 * 匹配规则：与现有条目按「包身份」（npm: 包名 / git: host+path / local: 解析后路径）
	 * 比较，而非字符串精确比较——这样 `pkg@1.0.0` 与 `pkg@2.0.0` 视为同一个包。
	 * 命中已有条目时：若规范化写法一致则无事可做（返回 false），
	 * 否则原地替换为新写法（local 路径会被规范化为相对作用域基准目录的形式）。
	 * 未命中则追加新条目。
	 */
	addSourceToSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const normalizedSource = this.normalizePackageSourceForSettings(source, scope);
		const matchIndex = currentPackages.findIndex((existing) => this.packageSourcesMatch(existing, source, scope));
		if (matchIndex !== -1) {
			const existing = currentPackages[matchIndex];
			if (this.getPackageSourceString(existing) === normalizedSource) {
				return false;
			}
			const nextPackages = [...currentPackages];
			nextPackages[matchIndex] =
				typeof existing === "string" ? normalizedSource : { ...existing, source: normalizedSource };
			if (scope === "project") {
				this.settingsManager.setProjectPackages(nextPackages);
			} else {
				this.settingsManager.setPackages(nextPackages);
			}
			return true;
		}
		const nextPackages = [...currentPackages, normalizedSource];
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	/**
	 * 从 settings 中移除与 source 同身份的所有条目。
	 * 返回是否确实发生了移除（没有任何匹配条目时返回 false）。
	 */
	removeSourceFromSettings(source: string, options?: { local?: boolean }): boolean {
		const scope: SourceScope = options?.local ? "project" : "user";
		const currentSettings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();
		const currentPackages = currentSettings.packages ?? [];
		const nextPackages = currentPackages.filter((existing) => !this.packageSourcesMatch(existing, source, scope));
		const changed = nextPackages.length !== currentPackages.length;
		if (!changed) {
			return false;
		}
		if (scope === "project") {
			this.settingsManager.setProjectPackages(nextPackages);
		} else {
			this.settingsManager.setPackages(nextPackages);
		}
		return true;
	}

	/**
	 * 计算来源在指定作用域下的安装路径（不触发安装）。
	 * npm 与 git 分别按各自目录规则推导；local 来源相对作用域基准目录解析。
	 * 路径在磁盘上不存在时返回 undefined。
	 */
	getInstalledPath(source: string, scope: "user" | "project"): string | undefined {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			const path = this.getNpmInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "git") {
			const path = this.getGitInstallPath(parsed, scope);
			return existsSync(path) ? path : undefined;
		}
		if (parsed.type === "local") {
			const baseDir = this.getBaseDirForScope(scope);
			const path = this.resolvePathFromBase(parsed.path, baseDir);
			return existsSync(path) ? path : undefined;
		}
		return undefined;
	}

	/** 发出进度事件（未设置回调时为空操作） */
	private emitProgress(event: ProgressEvent): void {
		this.progressCallback?.(event);
	}

	/**
	 * 以进度事件包裹一个异步操作：开始时发 start、成功发 complete、失败发 error（带错误消息）。
	 * error 事件发出后原样重抛，不吞异常。
	 */
	private async withProgress(
		action: ProgressEvent["action"],
		source: string,
		message: string,
		operation: () => Promise<void>,
	): Promise<void> {
		this.emitProgress({ type: "start", action, source, message });
		try {
			await operation();
			this.emitProgress({ type: "complete", action, source });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.emitProgress({ type: "error", action, source, message: errorMessage });
			throw error;
		}
	}

	/**
	 * 解析所有已配置资源为最终路径列表（核心入口）。
	 *
	 * 三个阶段：
	 * 1. 收集并解析包：合并 project + user 两级 settings 中的 packages（project 在前），
	 *    去重后逐个安装/定位并收集包内资源；
	 * 2. settings 显式条目：settings 中 extensions/skills/prompts/themes 数组里的
	 *    路径条目（相对各自作用域基准目录解析，支持 glob 与覆写模式）；
	 * 3. 自动发现：各约定目录（.pi/、.pi/agent、.agents/skills 等）下的资源。
	 *
	 * @param onMissing 「包已配置但未安装」时的回调；不传则默认自动安装
	 */
	async resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();

		// 收集全部包并标注作用域（project 在前，使项目资源在同名冲突中获胜）
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		// 去重：同一包身份同时出现在两级 settings 时 project 胜出
		const packageSources = this.dedupePackages(allPackages);
		await this.resolvePackageSources(packageSources, accumulator, onMissing);

		const globalBaseDir = this.agentDir;
		const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

		// 处理 settings 中四类资源的显式路径条目（project 先于 user 注入）
		for (const resourceType of RESOURCE_TYPES) {
			const target = this.getTargetMap(accumulator, resourceType);
			const globalEntries = (globalSettings[resourceType] ?? []) as string[];
			const projectEntries = (projectSettings[resourceType] ?? []) as string[];
			this.resolveLocalEntries(
				projectEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "project",
					origin: "top-level",
				},
				projectBaseDir,
			);
			this.resolveLocalEntries(
				globalEntries,
				resourceType,
				target,
				{
					source: "local",
					scope: "user",
					origin: "top-level",
				},
				globalBaseDir,
			);
		}

		// 最后叠加各约定目录自动发现的资源
		this.addAutoDiscoveredResources(accumulator, globalSettings, projectSettings, globalBaseDir, projectBaseDir);

		return this.toResolvedPaths(accumulator);
	}

	/**
	 * 仅解析给定来源列表（忽略 settings 配置）。
	 * temporary: true 时按 temporary 作用域处理（git 源会先尝试刷新缓存），
	 * local: true 时按 project 作用域解析，否则按 user 作用域。
	 */
	async resolveExtensionSources(
		sources: string[],
		options?: { local?: boolean; temporary?: boolean },
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		const scope: SourceScope = options?.temporary ? "temporary" : options?.local ? "project" : "user";
		const packageSources = sources.map((source) => ({ pkg: source as PackageSource, scope }));
		await this.resolvePackageSources(packageSources, accumulator);
		return this.toResolvedPaths(accumulator);
	}

	/** 列出两级 settings 中已配置的包：user 在前、project 在后，附带安装路径探测 */
	listConfiguredPackages(): ConfiguredPackage[] {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const configuredPackages: ConfiguredPackage[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "user",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "user"),
			});
		}

		for (const pkg of projectSettings.packages ?? []) {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			configuredPackages.push({
				source,
				scope: "project",
				filtered: typeof pkg === "object",
				installedPath: this.getInstalledPath(source, "project"),
			});
		}

		return configuredPackages;
	}

	/**
	 * 安装一个包（不写入 settings）。
	 * 按来源类型分发：npm 走托管目录安装、git 走克隆、本地路径只校验存在性
	 * （本地包无需安装，磁盘上就是本体）。全程包裹进度事件。
	 */
	async install(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		this.assertProjectTrustedForScope(scope);
		await this.withProgress("install", source, `Installing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.installNpm(parsed, scope, false);
				return;
			}
			if (parsed.type === "git") {
				await this.installGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				const resolved = this.resolvePath(parsed.path);
				if (!existsSync(resolved)) {
					throw new Error(`Path does not exist: ${resolved}`);
				}
				return;
			}
			throw new Error(`Unsupported install source: ${source}`);
		});
	}

	/** 安装一个包并写入 settings（install + addSourceToSettings 的组合） */
	async installAndPersist(source: string, options?: { local?: boolean }): Promise<void> {
		await this.install(source, options);
		this.addSourceToSettings(source, options);
	}

	/**
	 * 卸载一个包（不改 settings）。
	 * npm 走包管理器 uninstall、git 删除克隆目录、本地路径无操作（不拥有磁盘内容）。
	 */
	async remove(source: string, options?: { local?: boolean }): Promise<void> {
		const parsed = this.parseSource(source);
		const scope: SourceScope = options?.local ? "project" : "user";
		this.assertProjectTrustedForScope(scope);
		await this.withProgress("remove", source, `Removing ${source}...`, async () => {
			if (parsed.type === "npm") {
				await this.uninstallNpm(parsed, scope);
				return;
			}
			if (parsed.type === "git") {
				await this.removeGit(parsed, scope);
				return;
			}
			if (parsed.type === "local") {
				return;
			}
			throw new Error(`Unsupported remove source: ${source}`);
		});
	}

	/** 卸载一个包并从 settings 中移除（remove + removeSourceFromSettings 的组合） */
	async removeAndPersist(source: string, options?: { local?: boolean }): Promise<boolean> {
		await this.remove(source, options);
		return this.removeSourceFromSettings(source, options);
	}

	/**
	 * 更新包。不传 source 时更新 settings 中的全部包；
	 * 传入 source 时按包身份匹配（可匹配 user 与 project 两处），
	 * 无任何匹配则抛出带相似候选建议的错误。
	 */
	async update(source?: string): Promise<void> {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const identity = source ? this.getPackageIdentity(source) : undefined;
		let matched = false;
		const updateSources: ConfiguredUpdateSource[] = [];

		for (const pkg of globalSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "user") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "user" });
		}
		for (const pkg of projectSettings.packages ?? []) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			if (identity && this.getPackageIdentity(sourceStr, "project") !== identity) continue;
			matched = true;
			updateSources.push({ source: sourceStr, scope: "project" });
		}

		if (source && !matched) {
			throw new Error(
				this.buildNoMatchingPackageMessage(source, [
					...(globalSettings.packages ?? []),
					...(projectSettings.packages ?? []),
				]),
			);
		}

		await this.updateConfiguredSources(updateSources);
	}

	/**
	 * 批量更新配置的包来源。
	 *
	 * 流程：
	 * 1. 离线模式或列表为空时直接返回；
	 * 2. 按类型分桶：npm 中未 pin 版本的进入更新检查，git 全部进入更新
	 *    （见下方关于 pin 的注释）；
	 * 3. npm 先并发（4 路）查询 registry 判断是否真有新版本，避免无谓安装；
	 *    需更新的再按作用域合并为一次批量 install（同作用域共享一次 npm 调用）；
	 * 4. git 并发（4 路）执行 fetch + reset 更新；
	 * 5. 两类任务最终并行执行（Promise.all）。
	 */
	private async updateConfiguredSources(sources: ConfiguredUpdateSource[]): Promise<void> {
		if (isOfflineModeEnabled() || sources.length === 0) {
			return;
		}

		const npmCandidates: NpmUpdateTarget[] = [];
		const gitCandidates: GitUpdateTarget[] = [];

		for (const entry of sources) {
			const parsed = this.parseSource(entry.source);
			// npm 的 pin 版本是固定的，永不更新；而 git 的「pin」（固定 ref）是配置的
			// checkout 目标，仍需参与更新——当配置的 ref 变化时要能校正已有克隆。
			if (parsed.type === "npm") {
				if (!parsed.pinned) {
					npmCandidates.push({ ...entry, parsed });
				}
			} else if (parsed.type === "git") {
				gitCandidates.push({ ...entry, parsed });
			}
		}

		// 并发检查 npm 是否有新版本，只保留确实需要更新的
		const npmCheckTasks = npmCandidates.map((entry) => async () => ({
			entry,
			shouldUpdate: await this.shouldUpdateNpmSource(entry.parsed, entry.scope),
		}));
		const npmCheckResults = await this.runWithConcurrency(npmCheckTasks, UPDATE_CHECK_CONCURRENCY);
		const userNpmUpdates: NpmUpdateTarget[] = [];
		const projectNpmUpdates: NpmUpdateTarget[] = [];
		for (const result of npmCheckResults) {
			if (!result.shouldUpdate) {
				continue;
			}
			if (result.entry.scope === "user") {
				userNpmUpdates.push(result.entry);
			} else {
				projectNpmUpdates.push(result.entry);
			}
		}

		// npm 按作用域各合并为一次批量安装；git 逐个并发更新
		const tasks: Promise<void>[] = [];
		if (userNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(userNpmUpdates, "user"));
		}
		if (projectNpmUpdates.length > 0) {
			tasks.push(this.updateNpmBatch(projectNpmUpdates, "project"));
		}
		if (gitCandidates.length > 0) {
			const gitTasks = gitCandidates.map(
				(entry) => async () =>
					this.withProgress("update", entry.source, `Updating ${entry.source}...`, async () => {
						await this.updateGit(entry.parsed, entry.scope);
					}),
			);
			tasks.push(this.runWithConcurrency(gitTasks, GIT_UPDATE_CONCURRENCY).then(() => {}));
		}

		await Promise.all(tasks);
	}

	/**
	 * 判断 npm 包是否需要更新。
	 * 未安装或读不到已装版本时按需要更新处理；
	 * 查询 registry 失败时也返回 true——沿用既有行为：查不到就重装一次以自我修复。
	 */
	private async shouldUpdateNpmSource(source: NpmSource, scope: InstalledSourceScope): Promise<boolean> {
		const installedPath = this.getManagedNpmInstallPath(source, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledNpmVersion(installedPath) : undefined;
		if (!installedVersion) {
			return true;
		}

		try {
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			return gt(targetVersion, installedVersion);
		} catch {
			// 版本查询失败时保持「需要更新」的既有行为
			return true;
		}
	}

	/**
	 * 批量更新同作用域的 npm 包：合并为一次 npm install（进度事件也合并展示）。
	 * spec 取原始写法（带版本时）或 name@latest（无版本时始终追最新）。
	 */
	private async updateNpmBatch(sources: NpmUpdateTarget[], scope: InstalledSourceScope): Promise<void> {
		if (sources.length === 0) {
			return;
		}

		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => (entry.parsed.version ? entry.parsed.spec : `${entry.parsed.name}@latest`));

		await this.withProgress("update", sourceLabel, message, async () => {
			await this.installNpmBatch(specs, scope);
		});
	}

	/** 在指定作用域的托管安装根下批量安装一组 npm spec */
	private async installNpmBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}

	/**
	 * 检查所有已配置包是否有可用更新（只读，不执行更新）。
	 * npm 比对 registry 最新版本与本地版本；git 比对远端 HEAD 与本地 HEAD。
	 * 本地来源与 pin 版本不参与检查；检查并发 4 路。
	 */
	async checkForAvailableUpdates(): Promise<PackageUpdate[]> {
		if (isOfflineModeEnabled()) {
			return [];
		}

		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		for (const pkg of projectSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "project" });
		}
		for (const pkg of globalSettings.packages ?? []) {
			allPackages.push({ pkg, scope: "user" });
		}

		const packageSources = this.dedupePackages(allPackages);
		const checks = packageSources
			.filter(
				(entry): entry is { pkg: PackageSource; scope: Exclude<SourceScope, "temporary"> } =>
					entry.scope !== "temporary",
			)
			.map((entry) => async (): Promise<PackageUpdate | undefined> => {
				const source = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
				const parsed = this.parseSource(source);
				// 本地来源与 pin 死的 npm 版本永远没有「可用更新」
				if (parsed.type === "local" || parsed.pinned) {
					return undefined;
				}

				if (parsed.type === "npm") {
					// 未安装的包不报告更新（交由 resolve 阶段的安装逻辑处理）
					const installedPath = this.getNpmInstallPath(parsed, entry.scope);
					if (!existsSync(installedPath)) {
						return undefined;
					}
					const hasUpdate = await this.npmHasAvailableUpdate(parsed, installedPath);
					if (!hasUpdate) {
						return undefined;
					}
					return {
						source,
						displayName: parsed.name,
						type: "npm",
						scope: entry.scope,
					};
				}

				// git 来源：比对本地 HEAD 与远端 HEAD
				const installedPath = this.getGitInstallPath(parsed, entry.scope);
				if (!existsSync(installedPath)) {
					return undefined;
				}
				const hasUpdate = await this.gitHasAvailableUpdate(installedPath);
				if (!hasUpdate) {
					return undefined;
				}
				return {
					source,
					displayName: `${parsed.host}/${parsed.path}`,
					type: "git",
					scope: entry.scope,
				};
			});

		const results = await this.runWithConcurrency(checks, UPDATE_CHECK_CONCURRENCY);
		return results.filter((result): result is PackageUpdate => result !== undefined);
	}

	/**
	 * 逐个解析包来源：定位（必要时安装）包，然后收集其中的四类资源。
	 *
	 * 关键行为：
	 * - 对象形式的条目携带 filter（资源过滤配置）；
	 * - project 作用域且 autoload=false 的条目是 user 作用域同名包的「增量」，
	 *   实际内容从 user 安装中读取（findAutoloadDeltaBase）；
	 * - npm 包除「未安装」外，「已装版本不满足配置的范围」也触发重装；
	 * - 未安装时的处置由 onMissing 决定（默认静默安装；离线模式直接跳过）；
	 * - temporary 作用域的未 pin git 源每次 resolve 都尝试刷新缓存。
	 */
	private async resolvePackageSources(
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
		accumulator: ResourceAccumulator,
		onMissing?: (source: string) => Promise<MissingSourceAction>,
	): Promise<void> {
		for (const { pkg, scope } of sources) {
			const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
			const filter = typeof pkg === "object" ? pkg : undefined;
			// project + autoload=false 时改从 user 作用域的同名包读取内容
			const deltaBase = this.findAutoloadDeltaBase(pkg, scope, sources);
			const resolvedSource = deltaBase?.source ?? sourceStr;
			const resolvedScope = deltaBase?.scope ?? scope;
			const parsed = this.parseSource(resolvedSource);
			const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

			if (parsed.type === "local") {
				const baseDir = this.getBaseDirForScope(resolvedScope);
				this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
				continue;
			}

			// 统一的「缺失即安装」闭包：返回是否完成了安装（skip / 离线时为 false）
			const installMissing = async (): Promise<boolean> => {
				if (isOfflineModeEnabled()) return false;
				if (!onMissing) {
					await this.installParsedSource(parsed, resolvedScope);
					return true;
				}
				const action = await onMissing(resolvedSource);
				if (action === "skip") return false;
				if (action === "error") throw new Error(`Missing source: ${resolvedSource}`);
				await this.installParsedSource(parsed, resolvedScope);
				return true;
			};

			if (parsed.type === "npm") {
				let installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				// 未安装、或已装版本不再满足配置的版本范围时需要（重）装
				const needsInstall =
					!existsSync(installedPath) || !(await this.installedNpmMatchesConfiguredVersion(parsed, installedPath));
				if (needsInstall) {
					const installed = await installMissing();
					if (!installed) continue;
					installedPath = this.getNpmInstallPath(parsed, resolvedScope);
				}
				metadata.baseDir = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
				continue;
			}

			if (parsed.type === "git") {
				const installedPath = this.getGitInstallPath(parsed, resolvedScope);
				if (!existsSync(installedPath)) {
					const installed = await installMissing();
					if (!installed) continue;
				} else if (resolvedScope === "temporary" && !parsed.pinned && !isOfflineModeEnabled()) {
					// 临时 git 源每次解析都尝试拉最新，保证会话内用到的缓存不过期
					await this.refreshTemporaryGitSource(parsed, resolvedSource);
				}
				metadata.baseDir = installedPath;
				this.collectPackageResources(installedPath, accumulator, filter, metadata);
			}
		}
	}

	/**
	 * 为「project 作用域 + autoload=false」的条目找到其增量基准：
	 * 即 user 作用域中同身份的那个包条目。
	 * 返回 user 条目的来源与作用域供后续按其内容解析；无匹配基准则返回 undefined。
	 */
	private findAutoloadDeltaBase(
		pkg: PackageSource,
		scope: SourceScope,
		sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): { source: string; scope: SourceScope } | undefined {
		if (scope !== "project" || typeof pkg !== "object" || pkg.autoload !== false) return undefined;
		const identity = this.getPackageIdentity(pkg.source, scope);
		const userEntry = sources.find(
			(entry) =>
				entry.scope === "user" &&
				this.getPackageIdentity(this.getPackageSourceString(entry.pkg), "user") === identity,
		);
		return userEntry ? { source: this.getPackageSourceString(userEntry.pkg), scope: "user" } : undefined;
	}

	/**
	 * 解析 local 来源的包：路径相对作用域基准目录解析。
	 * 指向单个文件时直接作为扩展入口；指向目录时按包规则收集资源，
	 * 目录里没有任何可识别资源时退而把目录本身当作扩展入口。
	 * 路径不存在或 stat 失败则静默跳过。
	 */
	private resolveLocalExtensionSource(
		source: LocalSource,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		const resolved = this.resolvePathFromBase(source.path, baseDir);
		if (!existsSync(resolved)) {
			return;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isFile()) {
				// 单文件：直接作为扩展入口，基准目录取其所在目录
				metadata.baseDir = dirname(resolved);
				this.addResource(accumulator.extensions, resolved, metadata, true);
				return;
			}
			if (stats.isDirectory()) {
				metadata.baseDir = resolved;
				const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
				// 目录无任何资源声明时，把目录本身当扩展（交给上层尝试加载 index）
				if (!resources) {
					this.addResource(accumulator.extensions, resolved, metadata, true);
				}
			}
		} catch {
			return;
		}
	}

	/** 按类型分发安装已解析的来源（local 无需安装故不处理） */
	private async installParsedSource(parsed: ParsedSource, scope: SourceScope): Promise<void> {
		if (parsed.type === "npm") {
			await this.installNpm(parsed, scope, scope === "temporary");
			return;
		}
		if (parsed.type === "git") {
			await this.installGit(parsed, scope);
			return;
		}
	}

/** 取 PackageSource 条目（string 或对象）中的来源串 */
	/** 取 PackageSource 条目（string 或对象）中的来源串 */
	private getPackageSourceString(pkg: PackageSource): string {
		return typeof pkg === "string" ? pkg : pkg.source;
	}

	/**
	 * 计算用户输入来源的匹配键（忽略版本 / ref）。
	 * local 路径相对 cwd 解析——用户输入的路径以当前目录为基准。
	 */
	private getSourceMatchKeyForInput(source: string): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	/**
	 * 计算 settings 中条目的匹配键。
	 * 与 getSourceMatchKeyForInput 的差别仅在 local：settings 里的相对路径
	 * 相对该条目作用域的基准目录解析，而非 cwd。
	 */
	private getSourceMatchKeyForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			return `git:${parsed.host}/${parsed.path}`;
		}
		const baseDir = this.getBaseDirForScope(scope);
		return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
	}

	/** 构造「无匹配包」的错误消息，若能猜出用户想输入的已配置来源则附上 "Did you mean" 建议 */
	private buildNoMatchingPackageMessage(source: string, configuredPackages: PackageSource[]): string {
		const suggestion = this.findSuggestedConfiguredSource(source, configuredPackages);
		if (!suggestion) {
			return `No matching package found for ${source}`;
		}
		return `No matching package found for ${source}. Did you mean ${suggestion}?`;
	}

	/**
	 * 从已配置包中找出与输入最可能对应的那个（用于拼 "Did you mean" 提示）。
	 * npm：输入等于包名或完整 spec 时命中；git：输入等于 host/path 简写
	 * （可带 @ref）时命中。取第一个命中者。
	 */
	private findSuggestedConfiguredSource(source: string, configuredPackages: PackageSource[]): string | undefined {
		const trimmedSource = source.trim();
		const suggestions = new Set<string>();

		for (const pkg of configuredPackages) {
			const sourceStr = this.getPackageSourceString(pkg);
			const parsed = this.parseSource(sourceStr);
			if (parsed.type === "npm") {
				if (trimmedSource === parsed.name || trimmedSource === parsed.spec) {
					suggestions.add(sourceStr);
				}
				continue;
			}
			if (parsed.type === "git") {
				const shorthand = `${parsed.host}/${parsed.path}`;
				const shorthandWithRef = parsed.ref ? `${shorthand}@${parsed.ref}` : undefined;
				if (trimmedSource === shorthand || (shorthandWithRef && trimmedSource === shorthandWithRef)) {
					suggestions.add(sourceStr);
				}
			}
		}

		return suggestions.values().next().value;
	}

	/**
	 * 判断 settings 中的已有条目与用户输入是否指向同一个包。
	 * 双方各自算匹配键后比较（settings 侧按作用域基准、输入侧按 cwd 解析 local 路径）。
	 */
	private packageSourcesMatch(existing: PackageSource, inputSource: string, scope: SourceScope): boolean {
		const left = this.getSourceMatchKeyForSettings(this.getPackageSourceString(existing), scope);
		const right = this.getSourceMatchKeyForInput(inputSource);
		return left === right;
	}

	/**
	 * 规范化写入 settings 的来源串：npm / git 原样返回；
	 * local 路径解析为绝对路径后转为相对作用域基准目录的写法
	 * （settings 里存相对路径，仓库/配置目录移动后依然有效；恰在基准目录时存 "."）。
	 */
	private normalizePackageSourceForSettings(source: string, scope: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type !== "local") {
			return source;
		}
		const baseDir = this.getBaseDirForScope(scope);
		const resolved = this.resolvePath(parsed.path);
		const rel = relative(baseDir, resolved);
		return rel || ".";
	}

	/**
	 * 解析来源串为三种类型之一（判定顺序即优先级）：
	 * 1. `npm:` 前缀 → npm 来源（spec 内再拆包名与版本）；
	 * 2. 形如本地路径（./x、../x、/x、~、纯目录名等）→ local 来源；
	 * 3. 尝试按 git URL 解析（https/ssh/简写 host/path 等形式）；
	 * 4. 兜底视为 local 路径。
	 */
	private parseSource(source: string): ParsedSource {
		if (source.startsWith("npm:")) {
			const spec = source.slice("npm:".length).trim();
			const { name, version } = this.parseNpmSpec(spec);
			return {
				type: "npm",
				spec,
				name,
				version,
				range: getNpmVersionRange(version),
				pinned: isExactNpmVersion(version),
			};
		}

		if (isLocalPath(source)) {
			return { type: "local", path: source };
		}

		// 尝试按 git URL 解析
		const gitParsed = parseGitUrl(source);
		if (gitParsed) {
			return gitParsed;
		}

		return { type: "local", path: source };
	}

	/**
	 * 已安装的 npm 包版本是否仍满足配置的版本范围。
	 * 无范围（无版本 / dist-tag）时视为始终满足；读不到已装版本视为不满足。
	 */
	private async installedNpmMatchesConfiguredVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}
		return source.range ? satisfies(installedVersion, source.range) : true;
	}

	/**
	 * npm 包是否有可用更新（只读检查）。
	 * 与 shouldUpdateNpmSource 相反：任何不确定（离线、读不到版本、registry 查询失败）
	 * 都返回 false，避免在没有把握时打扰用户。
	 */
	private async npmHasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		const installedVersion = this.getInstalledNpmVersion(installedPath);
		if (!installedVersion) {
			return false;
		}

		try {
			const targetVersion = await this.getLatestNpmVersion(source.version ? source.spec : source.name, source.range);
			return gt(targetVersion, installedVersion);
		} catch {
			return false;
		}
	}

	/** 读取已安装包 package.json 中的 version 字段；读取/解析失败返回 undefined */
	private getInstalledNpmVersion(installedPath: string): string | undefined {
		const packageJsonPath = join(installedPath, "package.json");
		if (!existsSync(packageJsonPath)) return undefined;
		try {
			const content = readFileSync(packageJsonPath, "utf-8");
			const pkg = JSON.parse(stripBom(content)) as { version?: string };
			return pkg.version;
		} catch {
			return undefined;
		}
	}

	/**
	 * 查询 npm registry 上 spec 的最新版本。
	 * `npm view <spec> version --json` 的返回可能是单串（精确 spec）或数组（范围 / tag）；
	 * 数组时按 range 取最大满足者，无 range 则取排序后的第一个（即最高版本）。
	 * 空响应或意外结构都抛错，由调用方决定如何处理。
	 */
	private async getLatestNpmVersion(packageSpec: string, range?: string): Promise<string> {
		const npmCommand = this.getNpmCommand();
		const stdout = await this.runCommandCapture(
			npmCommand.command,
			[...npmCommand.args, "view", packageSpec, "version", "--json"],
			{ cwd: this.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const raw = stdout.trim();
		if (!raw) throw new Error("Empty response from npm view");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed === "string") {
			return parsed;
		}
		if (Array.isArray(parsed)) {
			const versions = parsed.filter((value): value is string => typeof value === "string" && value.length > 0);
			const latest = range ? maxSatisfying(versions, range) : [...versions].sort(rcompare)[0];
			if (latest) return latest;
		}
		throw new Error("Unexpected response from npm view");
	}

	/**
	 * git 克隆是否有可用更新：比较本地 HEAD 与远端 HEAD。
	 * 任何失败（离线、git 报错）都返回 false，不做打扰式报告。
	 */
	private async gitHasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		try {
			const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteGitHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	/**
	 * 获取远端 HEAD 提交号：
	 * 优先取上游分支（@{upstream} 对应的 origin 分支）的 ls-remote 结果；
	 * 没有上游时回退到 origin/HEAD（默认分支）。
	 */
	private async getRemoteGitHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getGitUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) {
				return match[1];
			}
		}

		const remoteHead = await this.runGitRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) {
			throw new Error("Failed to determine remote HEAD");
		}
		return match[1];
	}

	/**
	 * 确定本地克隆的更新目标：要 reset 到哪个 ref、其当前 HEAD、以及最小化 fetch 参数。
	 *
	 * 首选路径：当前分支有 origin 上游时，只 fetch 该分支的 refspec（ref 用 @{upstream}）。
	 * 回退路径（无上游 / 上游不是 origin）：先 `remote set-head -a` 探测远端默认分支，
	 * 成功则 fetch 该默认分支；再不行就 fetch 整个 HEAD（ref 用 origin/HEAD）。
	 * fetch 参数统一带 --prune --no-tags，避免拉取无关引用与标签。
	 */
	private async getLocalGitUpdateTarget(
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) {
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) {
				throw new Error("Missing upstream branch name");
			}
			const head = await this.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			// 无上游可用：探测远端默认分支，回退到 origin/HEAD
			await this.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath }).catch(() => {});
			const head = await this.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			// 解析 origin/HEAD 实际指向的分支名；拿不到（探测失败）则 fetch 整个 HEAD
			const originHeadRef = await this.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			}).catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			if (branch) {
				return {
					ref: "origin/HEAD",
					head,
					fetchArgs: [
						"fetch",
						"--prune",
						"--no-tags",
						"origin",
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	/**
	 * 获取上游分支的完整 ref（refs/heads/<branch>），供 ls-remote 精确查询。
	 * 无上游、上游不是 origin、或查询失败时返回 undefined。
	 */
	private async getGitUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) {
				return undefined;
			}
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	/** 执行访问远端的 git 命令：禁用终端交互（GIT_TERMINAL_PROMPT=0），避免卡在凭据提示上 */
	private runGitRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: {
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	/**
	 * 以固定并发度执行一批异步任务，结果按原任务顺序返回（与完成顺序无关）。
	 * 实现：启动 min(limit, 任务数) 个 worker，共享一个递增的任务下标做工作窃取式领取；
	 * worker 数不超过任务数，避免空转的 Promise。
	 */
	private async runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
		if (tasks.length === 0) {
			return [];
		}

		const results: T[] = new Array(tasks.length);
		let nextIndex = 0;
		const workerCount = Math.max(1, Math.min(limit, tasks.length));

		const worker = async () => {
			while (true) {
				const index = nextIndex;
				nextIndex += 1;
				if (index >= tasks.length) {
					return;
				}
				results[index] = await tasks[index]();
			}
		};

		await Promise.all(Array.from({ length: workerCount }, () => worker()));
		return results;
	}

	/**
	 * 计算包的唯一身份键（忽略版本 / ref）。
	 * 用于识别「同一个包同时出现在 global 与 project settings」的场景。
	 * git 包用 host/path 作为身份，保证同一仓库的 SSH 与 HTTPS URL
	 * 被视为同一个包。
	 */
	private getPackageIdentity(source: string, scope?: SourceScope): string {
		const parsed = this.parseSource(source);
		if (parsed.type === "npm") {
			return `npm:${parsed.name}`;
		}
		if (parsed.type === "git") {
			// 用 host/path 做身份，归一化 SSH 与 HTTPS 两种写法
			return `git:${parsed.host}/${parsed.path}`;
		}
		if (scope) {
			const baseDir = this.getBaseDirForScope(scope);
			return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
		}
		return `local:${this.resolvePath(parsed.path)}`;
	}

	/**
	 * 包去重：同一身份同时出现在 global 与 project 时只保留 project 条目
	 * （project 优先）。但 project 条目若声明 autoload=false，它是对 global
	 * 条目的「增量」而非替代——此时两条都保留（增量在前）。
	 */
	private dedupePackages(
		packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
	): Array<{ pkg: PackageSource; scope: SourceScope }> {
		const result: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
		const seen = new Map<string, number>();
		for (const entry of packages) {
			const identity = this.getPackageIdentity(this.getPackageSourceString(entry.pkg), entry.scope);
			const index = seen.get(identity);
			if (index === undefined) {
				// 首次出现：记录身份到下标的映射
				seen.set(identity, result.length);
				result.push(entry);
				continue;
			}
			const existing = result[index];
			if (existing?.scope === "project" && entry.scope === "user") {
				// 已有 project 条目 + 新来 user 条目：仅当 project 条目是 autoload=false
				// 增量时保留 user 条目（作为增量的基准内容）
				if (typeof existing.pkg === "object" && existing.pkg.autoload === false) result.push(entry);
			} else if (entry.scope === "project") {
				// 新来的 project 条目覆盖同身份的 user 条目
				result[index] = entry;
			}
		}
		return result;
	}

	/**
	 * 拆分 npm spec 为包名与版本：支持 @org/pkg@1.2.3 形式
	 * （正则先匹配可选 @scope，再匹配末尾的 @version）。
	 * 无法匹配时把整个 spec 当作包名。
	 */
	private parseNpmSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) {
			return { name: spec };
		}
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}

	/**
	 * 安全闸门：project 作用域的任何读写都必须先确认项目已受信任。
	 * 未受信任就操作 .pi/ 等于让任意仓库往用户环境里注入代码，故直接拒绝。
	 */
	private assertProjectTrustedForScope(scope: SourceScope): void {
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			throw new Error("Project is not trusted; refusing to access project package storage");
		}
	}

	/**
	 * 解析 settings 中配置的 npm 命令（支持 wrapper 形式，如 ["bun","--","pnpm"]）。
	 * 未配置时默认 "npm"。返回可执行命令与前置参数，后续实际参数拼在其后。
	 */
	private getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	/**
	 * 推断实际使用的包管理器名称（npm / bun / pnpm 等）。
	 * 取 npm 命令串中最后一个 "--" 之后的部分（wrapper 约定），
	 * 否则取命令本身；去掉 .cmd / .exe 后缀（Windows）。
	 */
	private getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const commandParts = [npmCommand.command, ...npmCommand.args];
		const separatorIndex = commandParts.lastIndexOf("--");
		const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
		return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
	}

	/** 用配置的 npm 命令执行子进程（忽略输出，只关心退出码） */
	private async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const npmCommand = this.getNpmCommand();
		await this.runCommand(npmCommand.command, [...npmCommand.args, ...args], options);
	}

	/**
	 * git 克隆目录内安装依赖的 npm 参数：
	 * 使用自定义 npm 命令（wrapper）时不加 --omit=dev（交由 wrapper 自己决定），
	 * 默认 npm 则省略 devDependencies——扩展运行时不需要开发依赖。
	 */
	private getGitDependencyInstallArgs(): string[] {
		const configuredCommand = this.settingsManager.getNpmCommand();
		if (configuredCommand && configuredCommand.length > 0) {
			return ["install"];
		}
		return ["install", "--omit=dev"];
	}

	/** 同步执行 npm 命令并捕获 stdout（仅用于 root -g 等少量同步探测场景） */
	/** 同步执行 npm 命令并捕获 stdout（仅用于 root -g 等少量同步探测场景） */
	private runNpmCommandSync(args: string[]): string {
		const npmCommand = this.getNpmCommand();
		return this.runCommandSync(npmCommand.command, [...npmCommand.args, ...args]);
	}

	/**
	 * 构造「安装一批 spec 到托管根目录」的包管理器参数（按包管理器适配）。
	 *
	 * 扩展包运行在 pi 宿主内，pi API（@earendil-works/pi-*）由宿主通过 loader 别名 /
	 * 虚拟模块提供，因此要禁用 peer dependency 解析（npm 的 --legacy-peer-deps，
	 * bun/pnpm 的等价配置），防止包管理器自行安装或求解宿主提供的 pi peer——
	 * 过期的自动安装 pi peer 反而会阻塞更新。安装目录参数也按管理器方言选择
	 * （npm/pnpm 用 --prefix，bun 用 --cwd）。
	 */
	private getNpmInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.getPackageManagerName();
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps"];
	}

	/** 在指定作用域（temporary 时装到临时目录）的托管根下安装单个 npm 包 */
	private async installNpm(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, temporary);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	/**
	 * 卸载 npm 包：按包管理器方言构造 uninstall 参数（bun 用 --cwd，
	 * npm 加 --legacy-peer-deps 与安装侧保持一致，pnpm 无需该旗标）。
	 * 安装根不存在时无需操作。
	 */
	private async uninstallNpm(source: NpmSource, scope: SourceScope): Promise<void> {
		const installRoot = this.getNpmInstallRoot(scope, false);
		if (!existsSync(installRoot)) {
			return;
		}
		const packageManagerName = this.getPackageManagerName();
		if (packageManagerName === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		const args = ["uninstall", source.name, "--prefix", installRoot];
		if (packageManagerName !== "pnpm") {
			args.push("--legacy-peer-deps");
		}
		await this.runNpmCommand(args);
	}

	/**
	 * 安装 git 包：
	 * - 已有克隆：转为「校正到目标 ref」（pin 了 ref 就 fetch 该 ref，否则走常规更新目标）；
	 * - 全新克隆：准备父目录与 .gitignore、清掉可能残留的更新标记，然后 clone
	 *   （pin 了 ref 再 checkout）、有 package.json 时安装依赖；
	 * - 任何一步失败都删除半成品目录并清理空的父目录后重抛，不留损坏状态。
	 */
	private async installGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (existsSync(targetDir)) {
			if (source.ref) {
				await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
				return;
			}
			const target = await this.getLocalGitUpdateTarget(targetDir);
			await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
			return;
		}
		const gitRoot = this.getGitInstallRoot(scope);
		if (gitRoot) {
			this.ensureGitIgnore(gitRoot);
		}
		mkdirSync(dirname(targetDir), { recursive: true });
		// 全新克隆前清掉旧克隆遗留的「更新未完成」标记
		rmSync(this.getGitUpdateMarkerPath(targetDir), { force: true });

		try {
			await this.runCommand("git", ["clone", source.repo, targetDir]);
			if (source.ref) {
				await this.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
			}
			const packageJsonPath = join(targetDir, "package.json");
			if (existsSync(packageJsonPath)) {
				await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
			}
		} catch (error) {
			// 失败清理：删除半成品、回收空父目录，再抛出原始错误
			rmSync(targetDir, { recursive: true, force: true });
			this.pruneEmptyGitParents(targetDir, gitRoot);
			throw error;
		}
	}

	/**
	 * 更新 git 包：未安装时转为全新安装；pin 了 ref 时 fetch 并校正到该 ref；
	 * 否则按本地更新目标（上游分支 / origin HEAD）fetch + reset。
	 */
	private async updateGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		if (!existsSync(targetDir)) {
			await this.installGit(source, scope);
			return;
		}

		if (source.ref) {
			await this.ensureGitRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}

		const target = await this.getLocalGitUpdateTarget(targetDir);
		await this.ensureGitRef(targetDir, target.fetchArgs, target.ref);
	}

	/**
	 * 检测克隆目录是否缺少 node_modules 依赖（git clean -fdx 会连依赖一起删掉）。
	 * 只看 dependencies（运行时必需）；每个依赖路径都校验未逃出 node_modules
	 * （防 manifest 里有 `file:../` 之类的越界路径）。解析失败按不缺失处理。
	 */
	private hasMissingGitDependencies(targetDir: string): boolean {
		const packageJsonPath = join(targetDir, "package.json");
		if (!existsSync(packageJsonPath)) return false;

		try {
			const manifest = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as { dependencies?: unknown };
			if (
				!manifest.dependencies ||
				typeof manifest.dependencies !== "object" ||
				Array.isArray(manifest.dependencies)
			) {
				return false;
			}

			const nodeModulesDir = resolve(targetDir, "node_modules");
			return Object.keys(manifest.dependencies).some((name) => {
				const dependencyPath = resolve(nodeModulesDir, name);
				// 依赖路径必须仍位于 node_modules 内，排除 file: 等越界引用
				if (!dependencyPath.startsWith(`${nodeModulesDir}${sep}`)) return false;
				return !existsSync(dependencyPath);
			});
		} catch {
			return false;
		}
	}

	/** 补装缺失的依赖（仅在检测到缺失时执行 npm install） */
	private async repairMissingGitDependencies(targetDir: string): Promise<void> {
		if (!this.hasMissingGitDependencies(targetDir)) return;
		await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
	}

	/**
	 * 「更新未完成」标记文件的路径：与克隆目录同级、以点开头
	 * （.\<repo>.pi-update-incomplete）。存在即表示上次 reset/clean 中断，
	 * 下次必须重做依赖安装。
	 */
	private getGitUpdateMarkerPath(targetDir: string): string {
		return join(dirname(targetDir), `.${basename(targetDir)}.pi-update-incomplete`);
	}

	/**
	 * 清理未跟踪文件并重装依赖，最后删除「更新未完成」标记。
	 * 扩展目录必须保持纯净（不应有本地改动），所以 reset 后还要 clean -fdx；
	 * 若 clean 失败（可能已删掉依赖），先尝试补装依赖让现有扩展仍能加载，再抛错。
	 */
	private async cleanAndInstallGitDependencies(targetDir: string, markerPath: string): Promise<void> {
		try {
			await this.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });
		} catch (error) {
			// clean 失败时尽力补装依赖，保证已装扩展还能用，然后原样抛错
			await this.repairMissingGitDependencies(targetDir).catch(() => {});
			throw error;
		}

		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.runNpmCommand(this.getGitDependencyInstallArgs(), { cwd: targetDir });
		}
		rmSync(markerPath, { force: true });
	}

	/**
	 * 把克隆目录校正到指定 ref（fetch → 比较 → reset --hard → clean + 重装依赖）。
	 *
	 * 断点恢复设计：reset 之前先写「更新未完成」标记，全部收尾（clean、依赖安装）
	 * 完成才删除标记。若中途崩溃，下次进来即使 HEAD 已是目标提交，
	 * 也会因为标记存在而重做 clean + 依赖安装；标记不存在时只做轻量的依赖缺失补装。
	 */
	private async ensureGitRef(targetDir: string, fetchArgs: string[], ref: string): Promise<void> {
		// 只 fetch 将要 reset 的那个 ref，避免拉取无关分支/标签的噪音
		await this.runCommand("git", fetchArgs, { cwd: targetDir });

		const localHead = await this.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const commitRef = `${ref}^{commit}`;
		const targetHead = await this.runCommandCapture("git", ["rev-parse", commitRef], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const markerPath = this.getGitUpdateMarkerPath(targetDir);
		if (localHead.trim() === targetHead.trim()) {
			// 已在目标提交上：有未完成标记则做完整收尾，否则只补缺失依赖
			if (existsSync(markerPath)) {
				await this.cleanAndInstallGitDependencies(targetDir, markerPath);
			} else {
				await this.repairMissingGitDependencies(targetDir);
			}
			return;
		}

		// 先落标记再 reset：中途失败时下次能识别并重做收尾
		writeFileSync(markerPath, "", "utf-8");
		await this.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });
		await this.cleanAndInstallGitDependencies(targetDir, markerPath);
	}

	/**
	 * 刷新 temporary 作用域的 git 缓存（带 pull 进度事件）。
	 * 刷新失败静默忽略——继续使用已有的临时缓存，不让会话解析失败。
	 */
	private async refreshTemporaryGitSource(source: GitSource, sourceStr: string): Promise<void> {
		if (isOfflineModeEnabled()) {
			return;
		}
		try {
			await this.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				await this.updateGit(source, "temporary");
			});
		} catch {
			// 刷新失败时保留已缓存的临时克隆
		}
	}

	/** 删除 git 克隆：连同更新标记一起删，并回收因此变空的父目录 */
	private async removeGit(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getGitInstallPath(source, scope);
		rmSync(targetDir, { recursive: true, force: true });
		rmSync(this.getGitUpdateMarkerPath(targetDir), { force: true });
		this.pruneEmptyGitParents(targetDir, this.getGitInstallRoot(scope));
	}

	/**
	 * 自下而上回收克隆目录路径上变空的父目录（host/path 两级结构可能因删除而留空壳）。
	 * 遇到非空目录即停；单级删除失败也停止，避免误删。
	 */
	private pruneEmptyGitParents(targetDir: string, installRoot: string | undefined): void {
		if (!installRoot) return;
		const resolvedRoot = resolve(installRoot);
		let current = dirname(targetDir);
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			const entries = readdirSync(current);
			if (entries.length > 0) {
				break;
			}
			try {
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}

	/**
	 * 确保托管 npm 安装根目录可用：创建目录、标记为云同步忽略
	 * （Dropbox/iCloud 同步 node_modules 必损坏）、写入防 git 追踪的 .gitignore，
	 * 并生成最小 package.json（npm install --prefix 需要一个包上下文）。
	 */
	private ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		markPathIgnoredByCloudSync(installRoot);
		this.ensureGitIgnore(installRoot);
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			// private: true 防止该目录被意外当作可发布包
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	/**
	 * 确保目录存在且有 .gitignore（内容为「忽略一切、仅保留 .gitignore 自身」），
	 * 防止托管安装内容被用户的项目 git 误提交。
	 */
	private ensureGitIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	/**
	 * npm 托管安装根目录：
	 * temporary → 临时目录；project → <cwd>/.pi/npm（需项目受信任）；
	 * user → <agentDir>/npm。
	 */
	private getNpmInstallRoot(scope: SourceScope, temporary: boolean): string {
		if (temporary) {
			return this.getTemporaryDir("npm");
		}
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.agentDir, "npm");
	}

	/**
	 * 获取包管理器的全局 node_modules 根（同步子进程探测，结果缓存）。
	 * 缓存键为当前 npm 命令串——settings 改了 npmCommand 就会重新探测。
	 * bun 的全局根布局特殊，需从 `pm bin -g` 推导。
	 */
	private getGlobalNpmRoot(): string {
		const npmCommand = this.getNpmCommand();
		const commandKey = [npmCommand.command, ...npmCommand.args].join("\0");
		if (this.globalNpmRoot && this.globalNpmRootCommandKey === commandKey) {
			return this.globalNpmRoot;
		}
		if (this.getPackageManagerName() === "bun") {
			const binDir = this.runNpmCommandSync(["pm", "bin", "-g"]).trim();
			this.globalNpmRoot = join(dirname(binDir), "install", "global", "node_modules");
		} else {
			this.globalNpmRoot = this.runNpmCommandSync(["root", "-g"]).trim();
		}
		this.globalNpmRootCommandKey = commandKey;
		return this.globalNpmRoot;
	}

	/**
	 * pnpm 专用：通过 `pnpm list -g --json` 查找全局包的真实安装路径。
	 * pnpm 全局包放在内容寻址的虚拟store里，不能像 npm 那样直接拼 root/name。
	 * 非 pnpm 时返回 undefined。
	 */
	private getPnpmGlobalPackagePath(packageName: string): string | undefined {
		if (this.getPackageManagerName() !== "pnpm") {
			return undefined;
		}

		const output = this.runNpmCommandSync(["list", "-g", "--depth", "0", "--json"]);
		const entries = JSON.parse(output) as Array<{ dependencies?: Record<string, { path?: string }> }>;
		for (const entry of entries) {
			const path = entry.dependencies?.[packageName]?.path;
			if (path) return path;
		}
		return undefined;
	}

	/**
	 * 托管安装方式下包的落地路径：<安装根>/node_modules/<name>。
	 */
	private getManagedNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return join(this.getTemporaryDir("npm"), "node_modules", source.name);
		}
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		return join(this.agentDir, "npm", "node_modules", source.name);
	}

	/**
	 * 旧版（非托管）安装方式的包路径：包管理器全局根下的 <name>
	 * （pnpm 走 list -g 查询）。探测失败返回 undefined。
	 */
	private getLegacyGlobalNpmInstallPath(source: NpmSource): string | undefined {
		try {
			return this.getPnpmGlobalPackagePath(source.name) ?? join(this.getGlobalNpmRoot(), source.name);
		} catch {
			return undefined;
		}
	}

	/**
	 * npm 包的安装路径（兼容新旧两种安装方式）：
	 * 优先返回托管路径；仅 user 作用域且托管路径不存在时，
	 * 回退检查旧版全局安装位置（历史上允许 npm i -g 安装 pi 包）。
	 */
	private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
		const managedPath = this.getManagedNpmInstallPath(source, scope);
		if (scope !== "user" || existsSync(managedPath)) {
			return managedPath;
		}
		const legacyPath = this.getLegacyGlobalNpmInstallPath(source);
		return legacyPath && existsSync(legacyPath) ? legacyPath : managedPath;
	}

	/**
	 * git 克隆的落地路径：temporary → 临时目录；否则 <git 安装根>/<host>/<path>
	 * （path 可含多级，形成 host/org/repo 的层级结构）。
	 */
	private getGitInstallPath(source: GitSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return this.getTemporaryDir(`git-${source.host}`, source.path);
		}
		const installRoot = this.getGitInstallRoot(scope);
		if (!installRoot) {
			throw new Error("Missing git install root");
		}
		return this.resolveManagedPath(installRoot, source.host, source.path);
	}

	/**
	 * git 安装根目录：temporary 无根（散在临时区）；project → <cwd>/.pi/git；
	 * user → <agentDir>/git。
	 */
	private getGitInstallRoot(scope: SourceScope): string | undefined {
		if (scope === "temporary") {
			return undefined;
		}
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.agentDir, "git");
	}

	/**
	 * 生成稳定确定性的临时目录路径：<扩展临时区>/<prefix>/<hash>/<suffix>，
	 * 其中 hash 取自 "prefix-suffix" 的 sha256 前 8 位——同一来源的临时安装
	 * 跨会话落到同一目录，可复用缓存。
	 */
	private getTemporaryDir(prefix: string, suffix?: string): string {
		const root = this.resolveManagedPath(getExtensionTempFolder(this.agentDir), prefix);
		const hash = createHash("sha256")
			.update(`${prefix}-${suffix ?? ""}`)
			.digest("hex")
			.slice(0, 8);
		return this.resolveManagedPath(root, hash, suffix ?? "");
	}

	/**
	 * 在安装根之下拼接路径，并校验结果仍位于根内。
	 * 包名 / git host/path 来自用户配置，可能含 `..` 等路径穿越片段；
	 * 越界路径直接拒绝（抛错），防止写到安装根之外。
	 */
	private resolveManagedPath(root: string, ...parts: string[]): string {
		const resolvedRoot = resolve(root);
		const resolvedPath = resolve(resolvedRoot, ...parts);
		if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${sep}`)) {
			throw new Error(`Refusing to use path outside package install root: ${resolvedPath}`);
		}
		return resolvedPath;
	}

	/**
	 * 各作用域的基准目录：project → <cwd>/.pi（需受信任）、user → agentDir、
	 * temporary → cwd（临时条目按会话目录解析相对路径）。
	 */
	private getBaseDirForScope(scope: SourceScope): string {
		if (scope === "project") {
			this.assertProjectTrustedForScope(scope);
			return join(this.cwd, CONFIG_DIR_NAME);
		}
		if (scope === "user") {
			return this.agentDir;
		}
		return this.cwd;
	}

	/** 相对 cwd 解析路径（支持 ~ 与首尾空白修剪） */
	private resolvePath(input: string): string {
		return resolvePath(input, this.cwd, { homeDir: getHomeDir(), trim: true });
	}

	/** 相对指定基准目录解析路径（支持 ~ 与首尾空白修剪） */
	private resolvePathFromBase(input: string, baseDir: string): string {
		return resolvePath(input, baseDir, { homeDir: getHomeDir(), trim: true });
	}

	/**
	 * 收集一个包内的资源，返回该包是否声明了任何资源。
	 * 三种路径（按优先级）：
	 * 1. 带 filter（settings 对象条目）：按 autoload 与各类型模式应用过滤/增量语义；
	 * 2. 有 pi manifest：按 package.json 中声明的四类条目收集；
	 * 3. 约定目录兜底：包根下的 extensions/ skills/ prompts/ themes/ 目录；
	 *    一个目录都没有时返回 false（调用方可把目录本身当扩展入口）。
	 */
	private collectPackageResources(
		packageRoot: string,
		accumulator: ResourceAccumulator,
		filter: PackageFilter | undefined,
		metadata: PathMetadata,
	): boolean {
		if (filter) {
			for (const resourceType of RESOURCE_TYPES) {
				const patterns = filter[resourceType];
				const target = this.getTargetMap(accumulator, resourceType);
				if (filter.autoload === false) {
					// 包默认不加载：只按模式增量启用部分资源
					this.applyPackageDeltaFilter(packageRoot, patterns ?? [], resourceType, target, metadata);
				} else if (patterns !== undefined) {
					// 包默认加载：按模式筛选启停
					this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
				} else {
					this.collectDefaultResources(packageRoot, resourceType, target, metadata);
				}
			}
			return true;
		}

		const manifest = readPiManifest(join(packageRoot, "package.json"));
		if (manifest) {
			for (const resourceType of RESOURCE_TYPES) {
				const entries = manifest[resourceType as keyof PiManifest];
				this.addManifestEntries(
					entries,
					packageRoot,
					resourceType,
					this.getTargetMap(accumulator, resourceType),
					metadata,
				);
			}
			return true;
		}

		// 约定目录兜底：无 manifest 时看包根下的标准子目录
		let hasAnyDir = false;
		for (const resourceType of RESOURCE_TYPES) {
			const dir = join(packageRoot, resourceType);
			if (existsSync(dir)) {
				// 收集目录下全部文件（默认全部启用）
				const files = collectResourceFiles(dir, resourceType);
				for (const f of files) {
					this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
				}
				hasAnyDir = true;
			}
		}
		return hasAnyDir;
	}

	/**
	 * 收集某类型的默认资源（filter 存在但该类型未配置模式时使用）：
	 * 优先 manifest 声明，回退约定目录，全部默认启用。
	 */
	private collectDefaultResources(
		packageRoot: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries) {
			this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
			return;
		}
		const dir = join(packageRoot, resourceType);
		if (existsSync(dir)) {
			// 收集目录下全部文件（默认全部启用）
			const files = collectResourceFiles(dir, resourceType);
			for (const f of files) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	/**
	 * 包默认加载（autoload 未关）时的用户模式过滤：
	 * 先按 manifest / 约定目录取全量文件，再用用户模式逐个标注启停。
	 * 用户给了空数组表示显式禁用该类型的所有资源。
	 */
	private applyPackageFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

		if (userPatterns.length === 0) {
			// 空数组显式禁用该类型的全部资源
			for (const f of allFiles) {
				this.addResource(target, f, metadata, false);
			}
			return;
		}

		// 应用用户模式
		const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

		for (const f of allFiles) {
			const enabled = enabledByUser.has(f);
			this.addResource(target, f, metadata, enabled);
		}
	}

	/**
	 * autoload=false（增量）模式：用户模式只声明「临时启用哪些资源」，
	 * 未被模式命中的资源完全不进入结果（保持不加载）。
	 * 空模式列表同样不加载任何资源。
	 */
	private applyPackageDeltaFilter(
		packageRoot: string,
		userPatterns: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (userPatterns.length === 0) {
			return;
		}

		const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);
		const enabledByUser = applyAutoloadDisabledPatterns(allFiles, userPatterns, packageRoot);
		for (const [filePath, enabled] of enabledByUser) {
			this.addResource(target, filePath, metadata, enabled);
		}
	}

	/**
	 * 收集包内某资源类型的全量文件，并应用 manifest 自身的模式。
	 * 返回 { allFiles, enabledByManifest }，其中 enabledByManifest 是
	 * 通过 manifest 自身覆写模式（! / + / -）的文件集合；
	 * manifest 无模式时全量启用。无 manifest 时回退约定目录。
	 */
	private collectManifestFiles(
		packageRoot: string,
		resourceType: ResourceType,
	): { allFiles: string[]; enabledByManifest: Set<string> } {
		const manifest = readPiManifest(join(packageRoot, "package.json"));
		const entries = manifest?.[resourceType as keyof PiManifest];
		if (entries && entries.length > 0) {
			const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
			const manifestPatterns = entries.filter(isOverridePattern);
			const enabledByManifest =
				manifestPatterns.length > 0 ? applyPatterns(allFiles, manifestPatterns, packageRoot) : new Set(allFiles);
			return { allFiles: Array.from(enabledByManifest), enabledByManifest };
		}

		const conventionDir = join(packageRoot, resourceType);
		if (!existsSync(conventionDir)) {
			return { allFiles: [], enabledByManifest: new Set() };
		}
		const allFiles = collectResourceFiles(conventionDir, resourceType);
		return { allFiles, enabledByManifest: new Set(allFiles) };
	}

	/**
	 * 按 manifest 声明收集资源：先展开所有来源条目（精确路径或 glob）为文件列表，
	 * 再应用 manifest 中的覆写模式，只把启用的文件加入结果。
	 */
	private addManifestEntries(
		entries: string[] | undefined,
		root: string,
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
	): void {
		if (!entries) return;

		const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
		const patterns = entries.filter(isOverridePattern);
		const enabledPaths = applyPatterns(allFiles, patterns, root);

		for (const f of allFiles) {
			if (enabledPaths.has(f)) {
				this.addResource(target, f, metadata, true);
			}
		}
	}

	/**
	 * 把 manifest 条目展开为文件列表：跳过覆写模式条目（由 applyPatterns 另行处理），
	 * 精确条目直接 resolve（可指向隐藏路径 / 符号链接），glob 条目展开后排序，
	 * 最后把每个路径解析为文件（目录则递归收集）。
	 */
	private collectFilesFromManifestEntries(entries: string[], root: string, resourceType: ResourceType): string[] {
		const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
		const resolved = sourceEntries.flatMap((entry) => {
			if (!hasGlobPattern(entry)) {
				return [resolve(root, entry)];
			}

			return expandPackageGlob(entry, root);
		});
		return this.collectFilesFromPaths(resolved, resourceType);
	}

	/**
	 * 解析 settings 中某资源类型的显式路径条目（extensions/skills/... 数组）。
	 * 精确条目（非模式）相对 baseDir 解析并展开为文件；模式条目只用于
	 * 标注这些文件的启停（! 排除 / + 强制包含 / - 强制排除）。
	 */
	private resolveLocalEntries(
		entries: string[],
		resourceType: ResourceType,
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		metadata: PathMetadata,
		baseDir: string,
	): void {
		if (entries.length === 0) return;

		// 先收集精确条目（非模式条目）对应的文件
		const { plain, patterns } = splitPatterns(entries);
		const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
		const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

		// 再按模式条目决定各文件的启用状态
		const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

		// 全部加入结果并带上各自的启停状态
		for (const f of allFiles) {
			this.addResource(target, f, metadata, enabledPaths.has(f));
		}
	}

	/**
	 * 叠加各约定目录自动发现的资源（优先级低于 settings 显式条目）：
	 * - project（需受信任）：<cwd>/.pi/ 下的 extensions/skills/prompts/themes，
	 *   以及从 cwd 到 git 仓库根各级的 .agents/skills；
	 * - user：~/.pi/agent/ 下四类目录 + ~/.agents/skills
	 *   （已作为 project 祖先出现时跳过，避免重复）。
	 * 各目录的启停受 settings 对应数组中覆写模式的微调。
	 */
	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalBaseDir: string,
		projectBaseDir: string,
	): void {
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: globalBaseDir,
		};
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBaseDir,
		};

		const userOverrides = {
			extensions: (globalSettings.extensions ?? []) as string[],
			skills: (globalSettings.skills ?? []) as string[],
			prompts: (globalSettings.prompts ?? []) as string[],
			themes: (globalSettings.themes ?? []) as string[],
		};
		const projectOverrides = {
			extensions: (projectSettings.extensions ?? []) as string[],
			skills: (projectSettings.skills ?? []) as string[],
			prompts: (projectSettings.prompts ?? []) as string[],
			themes: (projectSettings.themes ?? []) as string[],
		};

		const userDirs = {
			extensions: join(globalBaseDir, "extensions"),
			skills: join(globalBaseDir, "skills"),
			prompts: join(globalBaseDir, "prompts"),
			themes: join(globalBaseDir, "themes"),
		};
		const projectDirs = {
			extensions: join(projectBaseDir, "extensions"),
			skills: join(projectBaseDir, "skills"),
			prompts: join(projectBaseDir, "prompts"),
			themes: join(projectBaseDir, "themes"),
		};
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const projectTrusted = this.settingsManager.isProjectTrusted();
		const projectAgentsSkillDirs = projectTrusted
			? collectAncestorAgentsSkillDirs(this.cwd).filter((dir) => resolve(dir) !== resolve(userAgentsSkillsDir))
			: [];

		const addResources = (
			resourceType: ResourceType,
			paths: string[],
			metadata: PathMetadata,
			overrides: string[],
			baseDir: string,
		) => {
			const target = this.getTargetMap(accumulator, resourceType);
			for (const path of paths) {
				const enabled = isEnabledByOverrides(path, overrides, baseDir);
				this.addResource(target, path, metadata, enabled);
			}
		};

		if (projectTrusted) {
			// 项目扩展：来自 .pi/
			addResources(
				"extensions",
				collectAutoExtensionEntries(projectDirs.extensions),
				projectMetadata,
				projectOverrides.extensions,
				projectBaseDir,
			);

			// 项目技能：来自 .pi/
			addResources(
				"skills",
				collectAutoSkillEntries(projectDirs.skills, "pi"),
				projectMetadata,
				projectOverrides.skills,
				projectBaseDir,
			);
		}

		// 项目技能：来自各级祖先目录的 .agents/（每个目录有各自的 baseDir）
		for (const agentsSkillsDir of projectAgentsSkillDirs) {
			const agentsBaseDir = dirname(agentsSkillsDir); // 即 .agents 目录本身
			const agentsMetadata: PathMetadata = {
				...projectMetadata,
				baseDir: agentsBaseDir,
			};
			addResources(
				"skills",
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				agentsMetadata,
				projectOverrides.skills,
				agentsBaseDir,
			);
		}

		if (projectTrusted) {
			addResources(
				"prompts",
				collectAutoPromptEntries(projectDirs.prompts),
				projectMetadata,
				projectOverrides.prompts,
				projectBaseDir,
			);
			addResources(
				"themes",
				collectAutoThemeEntries(projectDirs.themes),
				projectMetadata,
				projectOverrides.themes,
				projectBaseDir,
			);
		}

		// 用户扩展：来自 ~/.pi/agent/
		addResources(
			"extensions",
			collectAutoExtensionEntries(userDirs.extensions),
			userMetadata,
			userOverrides.extensions,
			globalBaseDir,
		);

		// 用户技能：来自 ~/.pi/agent/
		addResources(
			"skills",
			collectAutoSkillEntries(userDirs.skills, "pi"),
			userMetadata,
			userOverrides.skills,
			globalBaseDir,
		);

		// 用户技能：来自 ~/.agents/（有独立的 baseDir）
		const userAgentsBaseDir = dirname(userAgentsSkillsDir);
		const userAgentsMetadata: PathMetadata = {
			...userMetadata,
			baseDir: userAgentsBaseDir,
		};
		addResources(
			"skills",
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			userOverrides.skills,
			userAgentsBaseDir,
		);

		addResources(
			"prompts",
			collectAutoPromptEntries(userDirs.prompts),
			userMetadata,
			userOverrides.prompts,
			globalBaseDir,
		);
		addResources(
			"themes",
			collectAutoThemeEntries(userDirs.themes),
			userMetadata,
			userOverrides.themes,
			globalBaseDir,
		);
	}

	/**
	 * 把一组路径解析为文件列表：文件直接保留，目录按资源类型递归收集。
	 * 路径不存在或 stat 失败跳过（配置里可能留着失效条目）。
	 */
	private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
		const files: string[] = [];
		for (const p of paths) {
			if (!existsSync(p)) continue;

			try {
				const stats = statSync(p);
				if (stats.isFile()) {
					files.push(p);
				} else if (stats.isDirectory()) {
					files.push(...collectResourceFiles(p, resourceType));
				}
			} catch {
				// 忽略错误：单条路径失效不影响其余条目
			}
		}
		return files;
	}

	/** 取累积器中某资源类型对应的 Map（未知类型抛错，防御性编程） */
	private getTargetMap(
		accumulator: ResourceAccumulator,
		resourceType: ResourceType,
	): Map<string, { metadata: PathMetadata; enabled: boolean }> {
		switch (resourceType) {
			case "extensions":
				return accumulator.extensions;
			case "skills":
				return accumulator.skills;
			case "prompts":
				return accumulator.prompts;
			case "themes":
				return accumulator.themes;
			default:
				throw new Error(`Unknown resource type: ${resourceType}`);
		}
	}

	/**
	 * 向目标 Map 添加资源：首见即定（已有同路径时不覆盖）。
	 * 这就是同名冲突的「先到者胜」实现——调用顺序即优先级顺序。
	 */
	private addResource(
		map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled: boolean,
	): void {
		if (!path) return;
		if (!map.has(path)) {
			map.set(path, { metadata, enabled });
		}
	}

	/** 新建一个四类 Map 全空的资源累积器 */
	private createAccumulator(): ResourceAccumulator {
		return {
			extensions: new Map(),
			skills: new Map(),
			prompts: new Map(),
			themes: new Map(),
		};
	}

	/**
	 * 把累积器转换为最终结果：每类 Map 先按优先级序号升序排序
	 * （project 显式 > project 自动 > user 显式 > user 自动 > 包内），
	 * 再按规范化路径（解析符号链接等）去重——同一路径经不同来源
	 * 收集多次时保留排序后靠前（优先级更高）的那个。
	 */
	private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
		const mapToResolved = (
			entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		): ResolvedResource[] => {
			const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
				path,
				enabled,
				metadata,
			}));
			resolved.sort((a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata));

			const seen = new Set<string>();
			return resolved.filter((entry) => {
				const canonicalPath = canonicalizePath(entry.path);
				if (seen.has(canonicalPath)) return false;
				seen.add(canonicalPath);
				return true;
			});
		};

		return {
			extensions: mapToResolved(accumulator.extensions),
			skills: mapToResolved(accumulator.skills),
			prompts: mapToResolved(accumulator.prompts),
			themes: mapToResolved(accumulator.themes),
		};
	}

	/**
	 * 启动子进程并直接继承终端 stdio（npm install 等需要展示交互输出的场景）。
	 * 若 stdout 已被 TUI 接管，则改为把 stdout/stderr 重定向到 fd 2（stderr），
	 * 避免子进程输出污染 TUI 画面（fd 2 的 ["ignore", 2, 2] 即此意图）。
	 */
	private spawnCommand(command: string, args: string[], options?: { cwd?: string }): ChildProcess {
		const env = getEnv();
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: isStdoutTakenOver() ? ["ignore", 2, 2] : "inherit",
			env,
		});
	}

	/** 启动输出被捕获（pipe）的子进程，stdin 关闭；附加环境变量合入基础 env */
	private spawnCaptureCommand(
		command: string,
		args: string[],
		options?: { cwd?: string; env?: Record<string, string> },
	): ChildProcessByStdio<null, Readable, Readable> {
		const baseEnv = getEnv();
		const env = options?.env ? { ...baseEnv, ...options.env } : baseEnv;
		return spawnProcess(command, args, {
			cwd: options?.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});
	}

	/**
	 * 执行命令并捕获 stdout（git rev-parse / npm view 等探测类命令）。
	 * 支持 timeoutMs：超时 kill 子进程并以超时错误 reject；
	 * 非零退出时把 stderr（回退 stdout）并入错误消息便于排查。
	 */
	private runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCaptureCommand(command, args, options);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout =
				typeof options?.timeoutMs === "number"
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, options.timeoutMs)
					: undefined;

			child.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			child.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			child.once("error", (error) => {
				if (timeout) clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (code, signal) => {
				if (timeout) clearTimeout(timeout);
				if (timedOut) {
					reject(new Error(`${command} ${args.join(" ")} timed out after ${options?.timeoutMs}ms`));
					return;
				}
				if (code === 0) {
					resolvePromise(stdout.trim());
					return;
				}
				// code === null 表示进程被信号杀死，此时报告信号名
				const exitStatus = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`;
				reject(new Error(`${command} ${args.join(" ")} failed with ${exitStatus}: ${stderr || stdout}`));
			});
		});
	}

	/** 执行命令（输出直连终端），仅在退出码非 0 时抛错 */
	private runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void> {
		return new Promise((resolvePromise, reject) => {
			const child = this.spawnCommand(command, args, options);
			child.on("error", reject);
			child.on("exit", (code) => {
				if (code === 0) {
					resolvePromise();
				} else {
					reject(new Error(`${command} ${args.join(" ")} failed with code ${code}`));
				}
			});
		});
	}

	/** 同步执行命令并返回捕获的输出；启动失败或非零退出抛出带 stderr 的错误 */
	private runCommandSync(command: string, args: string[]): string {
		const env = getEnv();
		const result = spawnProcessSync(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf-8",
			env,
		});
		if (result.error || result.status !== 0) {
			throw new Error(
				`Failed to run ${command} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`,
			);
		}
		return (result.stdout || result.stderr || "").trim();
	}
}
