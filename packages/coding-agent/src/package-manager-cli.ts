/**
 * @file package-manager-cli.ts —— 包管理子命令 CLI 入口（Pi Packages 安装 / 卸载 / 更新 / 列表 / 配置）
 *
 * @description
 * 本文件实现 `pi install / remove / list / update / config` 等终端子命令的完整流程：
 * 参数解析（`parsePackageCommand`）→ 项目信任（trust）与设置加载（`createCommandSettingsManager`）
 * → 委托 `DefaultPackageManager` 执行安装/卸载/更新 → 结果输出与错误处理。
 *
 * 主要功能点：
 * - **包管理子命令**：install/remove（含 uninstall 别名）、list、config（打开资源配置 TUI）；
 * - **自更新（self-update）**：`pi update` 默认更新 pi 自身。支持两条路径：
 *   1. 常规 npm/pnpm 安装：查询最新版本（`getSelfUpdatePlan`）后生成并执行包管理器命令（`runSelfUpdate`）；
 *   2. 托管安装（managed install，由官方安装脚本管理的多版本布局）：下载 package.json /
 *      package-lock.json 到 staging 目录，`npm ci` 装好后做版本冒烟测试，再原子切换 current-version 指针
 *      （`runManagedSelfUpdate` / `activateManagedRelease`）；
 * - **模型目录刷新**：`pi update --models` 仅刷新模型 catalog（`refreshModelCatalogs`）；
 * - **项目信任机制**：读写项目级 settings 前必须通过信任检查，支持 --approve/--no-approve 覆盖。
 *
 * 依赖关系：
 * - `./core/package-manager.ts`：包安装/卸载/更新的核心实现（DefaultPackageManager）；
 * - `./core/settings-manager.ts` / `./core/project-trust.ts` / `./core/trust-manager.ts`：设置分层与项目信任；
 * - `./config.ts`：APP_NAME、安装方式探测、自更新命令构造等全局配置；
 * - `./utils/version-check.ts`：最新版本查询与比较；`proper-lockfile`：托管更新互斥锁。
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import chalk from "chalk";
import lockfile from "proper-lockfile";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	detectInstallMethod,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
	VERSION,
} from "./config.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "./utils/child-process.ts";
import { canonicalizePath, getCwdRelativePath } from "./utils/paths.ts";
import { getPiUserAgent } from "./utils/pi-user-agent.ts";
import { formatVersionCheckError, getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

/** 包管理子命令类型：install（安装）、remove（卸载）、update（更新）、list（列表）。uninstall 是 remove 的别名。 */
export type PackageCommand = "install" | "remove" | "update" | "list";

/**
 * `pi update` 的更新目标：
 * - `all`：更新 pi 自身 + 已安装扩展包；
 * - `self`：仅更新 pi 自身；
 * - `extensions`：仅更新扩展包，`source` 存在时只更新指定来源；
 * - `models`：仅刷新模型目录。
 */
type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string } | { type: "models" };

// 托管安装的 installer API 默认地址，可用环境变量 PI_INSTALLER_API_BASE 覆盖（便于测试/内网镜像）
const DEFAULT_INSTALLER_API_BASE = "https://pi.dev/api/installer/releases";
// 托管安装根目录下的标记文件名，用于校验当前确实处于受管理的多版本安装布局中
const MANAGED_INSTALL_MARKER = "managed-install.json";
// 合法 semver（可选 prerelease/build 后缀）——防止路径拼接时被 `..`、`/` 之类注入
const MANAGED_RELEASE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 探测当前进程是否运行在「托管安装」布局中，是则返回其根目录。
 *
 * 判定条件：环境变量 PI_MANAGED_INSTALL_ROOT 指向的根目录下存在合法的
 * managed-install.json 标记，且当前包目录确实位于该根目录的 releases/ 子树下。
 * 任意条件不满足返回 undefined（普通 npm 安装/源码运行），标记缺失或损坏则抛错
 * （说明 PI_MANAGED_INSTALL_ROOT 指向了坏目录，应当显式失败而非静默降级）。
 */
function getActiveManagedInstallRoot(): string | undefined {
	const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();
	if (!configuredRoot) return undefined;

	const managedRoot = resolve(configuredRoot);
	const releasesDir = canonicalizePath(join(managedRoot, "releases"));
	// 启动器（launcher）的环境变量会被子进程继承。源码检出版本、或从托管 Pi 启动的
	// 另一套 Pi 安装，都不应被误判为托管安装——只有当前包目录真的位于
	// PI_MANAGED_INSTALL_ROOT 的 releases/ 目录之下才算数。
	if (getCwdRelativePath(canonicalizePath(getPackageDir()), releasesDir) === undefined) return undefined;

	const markerPath = join(managedRoot, MANAGED_INSTALL_MARKER);
	try {
		// 标记文件内容必须精确匹配预期的 kind / schemaVersion / layout，
		// 任一不符即视为损坏，走下方 catch 抛错
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
			kind?: unknown;
			layout?: unknown;
			schemaVersion?: unknown;
		};
		if (marker.kind !== "pi-managed-install" || marker.schemaVersion !== 1 || marker.layout !== "releases-v1") {
			throw new Error();
		}
	} catch {
		throw new Error(`Managed install marker is missing or invalid: ${markerPath}`);
	}

	return managedRoot;
}

/**
 * 从 installer API 下载单个文本工件（package.json / package-lock.json）并返回内容。
 *
 * @param url - 工件的完整下载地址
 * @param label - 工件的可读名称，仅用于报错信息
 * @throws HTTP 非 2xx 时抛错（附带状态码，方便定位是版本不存在还是服务问题）
 */
async function fetchInstallerArtifact(url: string, label: string): Promise<string> {
	const response = await fetch(url, { headers: { "User-Agent": getPiUserAgent(VERSION) } });
	if (!response.ok) {
		throw new Error(`Could not download managed installer ${label} from ${url}: HTTP ${response.status}`);
	}
	return await response.text();
}

/**
 * 在 staging 目录执行 `npm ci`，按 lockfile 精确还原生产依赖。
 *
 * 关键参数说明：
 * - `--ignore-scripts`：跳过依赖包的安装脚本，避免执行任意第三方代码（安全考虑）；
 * - `--min-release-age=0`：关闭 npm 的新包缓冲期检查，lockfile 中版本已固定，无需等待；
 * - `--omit=dev --include=optional`：只装生产依赖但保留 optional（原生平台二进制通常在 optional 里）。
 */
async function runManagedNpmCi(stageDir: string): Promise<void> {
	const args = [
		"ci",
		"--ignore-scripts",
		"--min-release-age=0",
		"--omit=dev",
		"--include=optional",
		"--no-fund",
		"--no-audit",
		"--loglevel=error",
		"--progress=false",
	];
	const code = await waitForChildProcess(spawnProcess("npm", args, { cwd: stageDir, stdio: "inherit" }));
	if (code !== 0) throw new Error(`npm ${args.join(" ")} exited with code ${code ?? "unknown"}`);
}

/**
 * 对刚装好的 release 做冒烟测试：调用其 CLI 的 `--version`，确认与期望版本一致。
 *
 * 用于两处：staging 目录装完后验证再转正；切换到已存在的本地 release 前验证其完整性。
 *
 * @throws 子进程启动失败、退出码非 0，或输出版本与期望不符时抛错
 */
function verifyManagedRelease(releaseDir: string, expectedVersion: string): void {
	const binPath = join(
		releaseDir,
		"node_modules",
		".bin",
		process.platform === "win32" ? `${APP_NAME}.cmd` : APP_NAME,
	);
	const result = spawnProcessSync(binPath, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.status !== 0) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Could not verify managed Pi ${expectedVersion}: ${reason}`);
	}
	const installedVersion = result.stdout.trim();
	if (installedVersion !== expectedVersion) {
		throw new Error(`Managed Pi smoke test returned version ${installedVersion}; expected ${expectedVersion}.`);
	}
}

/**
 * 将指定版本设为当前激活版本：更新根目录下的 current-version 指针文件。
 *
 * 采用「写临时文件 + rename」而非直接覆盖：rename 在同一文件系统上是原子操作，
 * 保证 launcher 任何时刻读到的指针要么是旧版本要么是新版本，不会读到半截内容。
 * 临时文件名带上 pid 和时间戳，避免并发更新时互相冲突。
 */
function activateManagedRelease(managedRoot: string, version: string): void {
	const currentPath = join(managedRoot, "current-version");
	const temporaryPath = join(managedRoot, `current-version.tmp.${process.pid}-${Date.now()}`);
	try {
		writeFileSync(temporaryPath, `${version}\n`);
		renameSync(temporaryPath, currentPath);
	} finally {
		// rename 成功后临时文件已不存在，force:true 使 rmSync 静默无副作用
		rmSync(temporaryPath, { force: true });
	}
}

/**
 * 清理 staging 目录下遗留的 update-* 临时目录（上次更新中途失败/被杀留下的残骸）。
 * 目录不存在或不可写时静默忽略——清理是尽力而为，不应阻塞主流程。
 */
function cleanupManagedStaging(managedRoot: string): void {
	const stagingRoot = join(managedRoot, "staging");
	try {
		for (const entry of readdirSync(stagingRoot)) {
			if (entry.startsWith("update-")) {
				rmSync(join(stagingRoot, entry), { force: true, recursive: true });
			}
		}
	} catch {
		// staging 目录尚不存在或不可写，忽略即可。
	}
}

/**
 * CLI 启动早期调用的对外清理入口：若当前运行在托管安装中，
 * 在持有更新锁的前提下清掉残留的 staging 目录。
 *
 * 任何失败都静默吞掉——本次清理抢不到锁说明有更新正在进行，不应报错干扰用户。
 */
export function cleanupManagedInstall(): void {
	let managedRoot: string | undefined;
	try {
		managedRoot = getActiveManagedInstallRoot();
	} catch {
		// 非托管安装（或标记损坏）：无东西可清理
		return;
	}
	if (!managedRoot) return;

	try {
		// 用锁保证不与正在进行的更新互相踩踏；lockSync 抢不到锁会抛错，由下方 catch 吞掉
		const releaseLock = lockfile.lockSync(join(managedRoot, "update"), { realpath: false });
		try {
			cleanupManagedStaging(managedRoot);
		} finally {
			releaseLock();
		}
	} catch {
		// 正有更新持有 staging 目录，或当前环境无法清理，均安全忽略。
	}
}

/**
 * 执行托管安装的 pi 自更新全流程。
 *
 * 步骤：校验版本号 → 获取 update 锁（全局互斥，防止两个更新并发）→ 清理残留 staging →
 * 若目标版本已存在于 releases/ 则验证后直接激活 → 否则下载两个 lockfile 工件到
 * 新建的 staging 目录、`npm ci` 安装、冒烟测试、rename 转正、激活指针。
 *
 * @throws 版本号非法、锁被占用（提示已有更新在跑）、下载/安装/验证任一失败时抛错
 */
async function runManagedSelfUpdate(managedRoot: string, version: string): Promise<void> {
	if (!MANAGED_RELEASE_VERSION_RE.test(version)) {
		throw new Error(`Invalid managed release version: ${version}`);
	}

	let releaseLock: () => Promise<void>;
	try {
		// 对 update 锁文件加锁，确保同一托管根目录上同时只有一个更新在跑
		releaseLock = await lockfile.lock(join(managedRoot, "update"), { realpath: false });
	} catch (error: unknown) {
		// ELOCKED = 锁已被持有：转换成更友好的提示后原样抛出
		if (error instanceof Error && "code" in error && error.code === "ELOCKED") {
			throw new Error("Another managed Pi update is already running.");
		}
		throw error;
	}

	let stageDir: string | undefined;
	try {
		cleanupManagedStaging(managedRoot);
		// 允许通过环境变量覆盖 installer API 地址；尾部斜杠统一去掉，方便下方拼接
		const installerApiBase = (process.env.PI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(
			/\/+$/,
			"",
		);
		const releaseUrl = `${installerApiBase}/${encodeURIComponent(version)}`;
		const stagingRoot = join(managedRoot, "staging");
		const releasesRoot = join(managedRoot, "releases");
		mkdirSync(releasesRoot, { recursive: true });
		const releaseDir = join(releasesRoot, version);
		if (existsSync(releaseDir)) {
			// 目标版本本地已存在（可能是之前下到一半中断后补全，或曾激活过又切走）：
			// 冒烟验证其仍完好，然后仅切换指针即可，避免重复下载
			verifyManagedRelease(releaseDir, version);
			activateManagedRelease(managedRoot, version);
			return;
		}

		mkdirSync(stagingRoot, { recursive: true });
		stageDir = mkdtempSync(join(stagingRoot, "update-"));
		// 并行拉取两个清单工件；lockfile 保证依赖版本与发布时完全一致
		const [packageJsonContent, packageLockContent] = await Promise.all([
			fetchInstallerArtifact(`${releaseUrl}/package.json`, "package.json"),
			fetchInstallerArtifact(`${releaseUrl}/package-lock.json`, "package-lock.json"),
		]);
		writeFileSync(join(stageDir, "package.json"), packageJsonContent);
		writeFileSync(join(stageDir, "package-lock.json"), packageLockContent);

		await runManagedNpmCi(stageDir);
		verifyManagedRelease(stageDir, version);
		// 验证通过后才把 staging 目录原子改名为正式 release 目录（对外瞬间可见）
		renameSync(stageDir, releaseDir);
		activateManagedRelease(managedRoot, version);
	} finally {
		// 无论成败：清掉 staging 残留（成功时 rename 后已不存在），并务必释放锁
		if (stageDir) rmSync(stageDir, { force: true, recursive: true });
		await releaseLock();
	}
}

// 自更新公告（release note）渲染所用的 TUI Markdown 主题：
// 标题加粗黄色、链接青色、正文装饰一律 dim，与终端里的提示信息风格一致
const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

/**
 * 包管理命令解析结果。
 *
 * 除命令本身与参数外，还携带解析期收集的各类错误（只记第一个，`invalidXxx ?? arg` 模式），
 * 由 handlePackageCommand 统一按优先级输出报错并退出，而不是解析时直接退出。
 */
interface PackageCommandOptions {
	command: PackageCommand;
	/** install/remove 的目标来源（npm:、git:、URL 或本地路径）；update 时可作位置参数目标 */
	source?: string;
	/** update 命令解析出的更新目标（self/all/extensions/models） */
	updateTarget?: UpdateTarget;
	/** update 未显式指定目标时的提示标记：告知用户默认只更新 pi 自身、扩展被跳过 */
	showExtensionsSkippedNote: boolean;
	/** -l：install/remove 写入项目级 settings 而非用户全局 */
	local: boolean;
	/** update --force：即使已是最新也重装 */
	force: boolean;
	/** --approve / --no-approve：显式覆盖项目信任判定（undefined 表示未指定） */
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

/** 输出设置加载过程中累积的非致命错误（警告形式，附堆栈便于排查）。 */
function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

/** 返回指定子命令的单行用法字符串（用于报错时的 Usage 提示）。 */
function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self|pi] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

// config 子命令的用法字符串（注意：这是 CLI 输出的英文帮助文案，保持原文）
const CONFIG_COMMAND_USAGE = `${APP_NAME} config [-l] [--approve|--no-approve]`;

/** 打印 `pi config` 的帮助文案：说明资源配置 TUI 的作用、-l 与信任相关选项。 */
function printConfigCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${CONFIG_COMMAND_USAGE}

Open the resource configuration TUI to enable or disable package resources.
Without -l, starts in global settings (~/${CONFIG_DIR_NAME}/agent/settings.json).
Press Tab in the TUI to switch between global and project-local modes.

Options:
  -l, --local       Edit project overrides (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command with -l
  -na, --no-approve Ignore project-local files for this command with -l
`);
}

/** 按子命令打印完整帮助（用法、选项说明与示例；文案随命令不同）。 */
function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local       Remove from project settings (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update pi, installed packages, or model catalogs.

Options:
  --self                  Update pi only (default when no target is given)
  --extensions            Update installed packages only
  --models                Refresh model catalogs only
  --all                   Update pi and installed packages
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command
  --force                 Reinstall pi even if the current version is latest

Short forms:
  ${APP_NAME} update                Update pi only
  ${APP_NAME} update --all          Update pi and all extensions
  ${APP_NAME} update --models       Refresh model catalogs only
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update pi             Update pi only (self works as alias to pi)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  -a, --approve      Trust project-local files for this command
  -na, --no-approve  Ignore project-local files for this command
`);
			return;
	}
}

/**
 * 解析包管理子命令的参数列表。
 *
 * 采用「先收集、后校验」策略：解析阶段只记录第一个非法项（不立即退出），
 * 命令级选项用错误（如 -l 只对 install/remove 合法）也只记不报；
 * update 的目标组合冲突（--all 与 --self 互斥等）在选项循环之后统一判定。
 *
 * @param args - 去掉顶层 `pi` 后的原始参数（首个元素应为子命令名）
 * @returns 解析结果；首参不是合法子命令时返回 undefined（交由上层判断是否其他命令）
 */
function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		// uninstall 是 remove 的用户友好别名
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let modelsFlag = false;
	let allFlag = false;
	let extensionFlagSource: string | undefined;

	// ===== 逐个扫描选项与位置参数 =====
	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--models") {
			if (command === "update") {
				modelsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--all") {
			if (command === "update") {
				allFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}

		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			// 带值选项：取下一个参数作值；缺失或看起来像另一个选项（以 - 开头）则记缺失
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				// 只允许出现一次，第二次记冲突
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++; // 消费掉选项值，避免被当作位置参数
			}
			continue;
		}

		if (arg.startsWith("-")) {
			// 未识别的 - 开头参数一律记为非法选项
			invalidOption = invalidOption ?? arg;
			continue;
		}

		// ===== 位置参数：第一个作为 source，多余的出现记错 =====
		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	// ===== 计算 update 命令的更新目标并校验组合冲突 =====
	let updateTarget: UpdateTarget | undefined;
	let showExtensionsSkippedNote = false;
	if (command === "update") {
		if (allFlag && (selfFlag || extensionsFlag || modelsFlag || extensionFlagSource)) {
			conflictingOptions =
				conflictingOptions ?? "--all cannot be combined with --self, --extensions, --models, or --extension";
		}
		if (allFlag && source) {
			conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
		}

		if (modelsFlag) {
			if (selfFlag || extensionsFlag || allFlag || extensionFlagSource) {
				conflictingOptions =
					conflictingOptions ?? "--models cannot be combined with --self, --extensions, --all, or --extension";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
			}
			updateTarget = { type: "models" };
		} else if (extensionFlagSource) {
			if (selfFlag || extensionsFlag || allFlag) {
				conflictingOptions =
					conflictingOptions ?? "--extension cannot be combined with --self, --extensions, or --all";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			// 位置参数目标：`self` / `pi` 指向 pi 自身（pi 是 self 的别名），
			// 此时若同时给了 --extensions 则合并为 all；其他来源一律视为单个扩展包
			const sourceIsSelf = source === "self" || source === "pi";
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag || allFlag) {
					conflictingOptions =
						conflictingOptions ??
						"positional update targets cannot be combined with --self, --extensions, or --all";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (allFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag && extensionsFlag) {
			// --self --extensions 同时给出等价于 --all
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			// 完全没给目标：默认只更新 pi 自身，并提示用户扩展被跳过
			updateTarget = { type: "self" };
			showExtensionsSkippedNote = true;
		}
	}

	return {
		command,
		source,
		updateTarget,
		showExtensionsSkippedNote,
		local,
		force,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

/** 更新目标是否包含 pi 自身（all 或 self）。 */
function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

/** 更新目标是否包含扩展包（all 或 extensions）。 */
function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

/**
 * 刷新模型目录（`pi update --models`）。
 *
 * 通过 AbortController 施加 15 秒整体超时（15_000 魔法数字即此），
 * 超时或任一 provider 刷新失败都抛错，由调用方以非零退出码提示用户。
 */
async function refreshModelCatalogs(agentDir: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		// 创建阶段禁网（allowModelNetwork: false）：只加载本地 auth/models，
		// 真正的网络请求集中在 refresh 中，统一受上面的超时控制
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) {
			throw new Error("Model catalog refresh timed out.");
		}
		if (result.errors.size > 0) {
			// 聚合各 provider 的错误为一条消息，一次性反馈而非逐个中断
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(`Could not refresh model catalogs: ${details}`);
		}
	} finally {
		clearTimeout(timeout);
	}
	console.log(chalk.green("Model catalogs refreshed"));
}

/**
 * 打印「当前安装方式无法自更新」的报错：附上官方指引与当前可执行文件位置，
 * 方便用户判断自己用的是哪种安装（如系统包管理器）并手动升级。
 */
function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = PACKAGE_NAME,
): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageTarget));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of ${APP_NAME} executable: ${entrypoint}`);
	}
}

/** 打印兜底提示：自更新反复失败时，建议用户手动执行等价的更新命令。 */
function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

/**
 * pnpm 自更新失败时提示其 registry 元数据缓存可能过期，
 * 给出 `pnpm store prune` 后重试的补救步骤。
 */
function printPnpmSelfUpdateMetadataHint(): void {
	console.error(chalk.yellow("If pnpm reports missing package versions, its cached registry metadata may be stale."));
	console.error(chalk.yellow(`Run \`pnpm store prune\` and retry \`${APP_NAME} update --self\`.`));
}

/**
 * 以 Markdown 渲染打印自更新公告（release note）。
 *
 * 渲染失败时降级为原样输出纯文本，保证公告内容不会因渲染异常而丢失；
 * 宽度取终端列数（非 TTY 时兜底 80，下限 20 防止极窄终端下排版崩溃）。
 */
function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		// Markdown 渲染异常：直接输出原文，内容优先于排版
		console.log(trimmedNote);
	}
	console.log();
}

/** 自更新计划：要装哪个包、装到哪个版本，以及是否真的需要执行更新。 */
interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	/** false 表示已是最新（或无需动作），调用方应跳过更新命令 */
	shouldRun: boolean;
	/** 随 release 附带的公告，更新前展示给用户 */
	note?: string;
}

/**
 * 查询最新发布版本并制定自更新计划。
 *
 * 需要执行更新（shouldRun: true）的三种情况：
 * --force 强制重装；发布包名与默认包名不同（如迁移到新包）；或远端版本更新。
 * 已是最新且未强制时打印提示并返回 shouldRun: false。
 *
 * @throws 版本检查失败（网络等）时抛错，由调用方输出后以非零退出码结束
 */
async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	try {
		latestRelease = await getLatestPiRelease(VERSION, { retry: true });
	} catch (error: unknown) {
		throw new Error(`Could not determine latest ${APP_NAME} version: ${formatVersionCheckError(error)}`, {
			cause: error,
		});
	}
	if (!latestRelease) {
		throw new Error(`Could not determine latest ${APP_NAME} version.`);
	}

	const packageName = latestRelease.packageName ?? PACKAGE_NAME;
	const installSpec = `${packageName}@${latestRelease.version}`;
	// 包名变化（迁移到新包）时无条件执行安装，即使版本号相同也要切换过去
	if (force || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
		return {
			packageName,
			installSpec,
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			shouldRun: true,
		};
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

/**
 * 依次执行自更新命令（可能由多个步骤组成，如 pnpm 需要先卸载再安装）。
 * 用手动监听 error/close 的方式包装 spawn，把非零退出码与信号终止都转为明确的 Error。
 *
 * @throws 任一步骤失败时抛错（错误信息中带该步骤的展示名）
 */
async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		// 无 steps 时退化为单步命令自身
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

/**
 * Windows 下 npm 安装的自更新预处理：
 * 先清掉上次留下的隔离区，再把正在使用的原生依赖（.node 等）移入隔离区，
 * 否则 Windows 不允许覆盖被本进程占用的文件，npm 安装会失败。
 * 非 Windows 平台直接跳过。
 */
function prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}

/** 包管理命令的运行时注入选项：宿主可传入内联扩展工厂供信任探测使用。 */
export interface PackageCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

/** createCommandSettingsManager 的返回值：设置管理器 + 信任流程中收集的警告。 */
interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

/**
 * 判定当前命令的交互模式：stdin/stdout 均为 TTY 才算 interactive，
 * 否则（管道、CI 等）按 print 模式处理——影响信任提示的呈现方式。
 */
function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

/** 将项目信任流程产生的警告逐条以黄色输出到 stderr（不改变退出码）。 */
function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

/**
 * 为包管理/config 命令构建 SettingsManager 并完成项目信任判定。
 *
 * 两种模式：
 * - `useSavedProjectTrustOnly`（update 命令用）：只读已保存的信任记录与命令行覆盖，
 *   绝不弹交互提示——更新不应打断在脚本/管道中的用户；
 * - 默认模式：若项目里存在需要信任的资源（未显式覆盖时），先加载项目扩展以收集
 *   潜在风险，再经 resolveProjectTrusted 综合信任库、默认设置与用户选择做判定。
 *
 * 信任相关的加载失败不致命，记入 warnings 由调用方打印。
 */
async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: InlineExtension[];
}): Promise<CommandSettingsResult> {
	// 先以“项目不受信任”创建：保证信任判定完成前不会意外读取项目级设置
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const projectTrustWarnings: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		// 非交互模式：命令行覆盖优先，其次已保存的信任记录，无则视为不受信任
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		return { settingsManager, projectTrustWarnings };
	}

	const appMode = getCommandAppMode();
	// 仅当用户未显式指定 --approve/--no-approve 且项目确有需信任的资源时，
	// 才加载项目扩展——加载既为了展示“将执行什么”，也为信任确认提供依据
	const extensionsResult =
		options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

/**
 * 处理 `pi config` 子命令：打开资源配置 TUI，启用/禁用各包提供的资源。
 *
 * 返回 false 表示首参不是 config（交由上层继续分派）；
 * 参数解析失败时设置 process.exitCode = 1 并返回 true（已消费该命令）。
 * 注意：成功路径最终 process.exit(0)，因为 selectConfig 的写盘必须在退出前完成。
 */
export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	let local = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "-a" || arg === "--approve") {
			projectTrustOverride = true;
		} else if (arg === "-na" || arg === "--no-approve") {
			projectTrustOverride = false;
		} else if (arg.startsWith("-")) {
			console.error(chalk.red(`Unknown option ${arg} for "config".`));
			console.error(chalk.dim(`Use "${APP_NAME} --help" or "${CONFIG_COMMAND_USAGE}".`));
			process.exitCode = 1;
			return true;
		} else {
			console.error(chalk.red(`Unexpected argument ${arg}.`));
			console.error(chalk.dim(`Usage: ${CONFIG_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	// -l 要写项目级配置，而项目未受信任时拒绝继续——防止在不可信仓库里被写入恶意配置
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local resource config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "config command");
	// TUI 需要同时展示全局与项目两级已解析的资源路径：
	// 全局一份（projectTrusted: false 的独立管理器），项目一份（仅在受信任时解析，否则复用全局结果）
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const globalResolvedPaths = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
	}).resolve();
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve()
		: globalResolvedPaths;

	await selectConfig({
		resolvedPaths: { global: globalResolvedPaths, project: projectResolvedPaths },
		settingsManager,
		cwd,
		agentDir,
		writeScope: local ? "project" : "global",
		projectModeAvailable: settingsManager.isProjectTrusted(),
	});

	process.exit(0);
}

/**
 * 处理包管理子命令（install / remove / update / list）的统一入口。
 *
 * 流程：解析参数 → 按「非法选项 > 缺失选项值 > 多余参数 > 选项冲突 > 缺 source」
 * 的顺序输出首个解析错误 → update --models 单独走模型刷新短路 →
 * 构建设置与信任上下文 → 分派到 DefaultPackageManager 执行。
 * 返回 false 表示首参不是包管理命令；所有错误均以 process.exitCode = 1 标记而非直接抛出。
 */
export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	// update --models 是纯模型目录刷新：无需项目信任与包管理器，直接短路执行
	if (options.command === "update" && options.updateTarget?.type === "models") {
		try {
			await refreshModelCatalogs(getAgentDir());
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Unknown model catalog refresh error";
			console.error(chalk.red(`Error: ${message}`));
			process.exitCode = 1;
		}
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// install/remove -l 会写项目级 settings，须先通过信任检查
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		useSavedProjectTrustOnly: options.command === "update",
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");
	// 用户在全局设置里指定的 npm 客户端命令（如固定用 pnpm），自更新时优先采用
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	// 仅把“步骤开始”信息打到 stdout（dim 样式）；完成/失败由各分支自己汇报
	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		// ===== 分派到具体子命令 =====
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				// 按作用域分组展示：user（全局安装）与 project（项目本地安装）
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				// 单个包的展示：来源 + 可选的 (filtered) 标记（被设置过滤掉的包）+ 安装路径
				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "self" };
				if (options.showExtensionsSkippedNote) {
					console.log(
						chalk.dim(`Extensions are skipped. Run ${APP_NAME} update --extensions to update extensions.`),
					);
				}
				// ===== 第一段：更新扩展包（all 或 extensions 目标）=====
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				// ===== 第二段：更新 pi 自身（all 或 self 目标）=====
				if (updateTargetIncludesSelf(target)) {
					const managedInstallRoot = getActiveManagedInstallRoot();
					// 托管安装的版本由 installer API 的 lockfile 决定，“强制重装”语义不适用
					if (managedInstallRoot && options.force) {
						console.error(
							chalk.red(
								`Managed ${APP_NAME} installations do not support --force; rerun the installer to repair this installation.`,
							),
						);
						process.exitCode = 1;
						return true;
					}
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						return true;
					}
					if (managedInstallRoot) {
						// 托管安装走独立的下载+staging 流程，不依赖本地 npm 环境
						if (selfUpdatePlan.note) {
							printSelfUpdateNote(selfUpdatePlan.note);
						}
						try {
							console.log(chalk.dim(`Updating managed ${APP_NAME} installation...`));
							await runManagedSelfUpdate(managedInstallRoot, selfUpdatePlan.version);
						} catch (error: unknown) {
							const message = error instanceof Error ? error.message : "Unknown managed update error";
							console.error(chalk.red(`Error: ${message}`));
							process.exitCode = 1;
							return true;
						}
						console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
						return true;
					}

					// ===== 常规安装的自更新：基于本地包管理器 =====
					const installMethod = detectInstallMethod();
					// Windows 上文件占用问题多，只对 npm/pnpm 两种安装方式提供自更新
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						console.error(
							chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`),
						);
						console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
						process.exitCode = 1;
						return true;
					}
					const selfUpdateTarget = {
						packageName: selfUpdatePlan.packageName,
						installSpec: selfUpdatePlan.installSpec,
					};
					const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, selfUpdateNpmCommand, selfUpdateTarget);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdateTarget);
						process.exitCode = 1;
						return true;
					}
					if (selfUpdatePlan.note) {
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					try {
						// Windows + npm：先把被占用的原生依赖移入隔离区，才能覆盖安装
						if (installMethod === "npm") {
							prepareWindowsNpmSelfUpdate();
						}
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown package command error";
						console.error(chalk.red(`Error: ${message}`));
						// pnpm 常见坑：缓存元数据过期导致找不到版本，给出专门提示
						if (installMethod === "pnpm") {
							printPnpmSelfUpdateMetadataHint();
						}
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					console.log(chalk.green(`Updated ${APP_NAME} from ${VERSION} to ${selfUpdatePlan.version}`));
				}
				return true;
			}
		}
	} catch (error: unknown) {
		// install/remove/list/update 扩展包阶段的兜底：错误转成一行红色提示并置非零退出码
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
