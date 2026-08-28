/**
 * @file config.ts —— 包探测与路径体系
 *
 * @description
 * 本文件负责 coding-agent CLI 的「我是谁、我装在哪、我如何更新」三件事：
 * - 探测运行环境：是否为 Bun 编译出的单文件二进制（isBunBinary / isBunRuntime）；
 * - 探测安装方式（npm / pnpm / yarn / bun / bun-binary），并据此生成自更新
 *   （self-update）命令，或生成"无法自更新"时展示给用户的手动更新指引；
 * - 解析随包分发的资源路径（主题、HTML 导出模板、README、CHANGELOG 等）；
 * - 从 package.json 的 piConfig 段读取品牌化信息（APP_NAME / 配置目录名），
 *   派生出用户级配置路径体系（默认 ~/.pi/agent/*，支持环境变量覆盖）。
 *
 * fork / 品牌化支持：下游 fork 可在 package.json 中配置 piConfig.name 与
 * piConfig.configDir，使配置目录、环境变量前缀（如 TAU_CODING_AGENT_DIR）、
 * 自更新的"换名安装"目标自动跟随新品牌，而无需改动本文件。
 *
 * 依赖关系：
 * - node:fs / node:os / node:path / node:url：文件存在性检查与路径拼接；
 * - ./utils/child-process.ts：同步执行外部命令（如 `pnpm root -g`）；
 * - ./utils/paths.ts：路径规范化（含 ~ 展开）；
 * - ./utils/text.ts：去除 package.json 的 BOM 头。
 */
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve, sep, win32 } from "path";
import { fileURLToPath } from "url";
import { spawnProcessSync } from "./utils/child-process.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// 包探测
// =============================================================================

// ESM 下没有 CommonJS 的 __filename / __dirname，这里从 import.meta.url 手工还原，
// 供后续基于「当前模块所在目录」做包路径推断。
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 检测当前是否以 Bun 编译出的单文件二进制运行。
 * Bun 二进制中 import.meta.url 会包含 "$bunfs"、"~BUN" 或其 URL 编码形式
 * "%7EBUN"（Bun 的虚拟文件系统路径），以此区分于普通 Node/tsx 运行。
 */
export const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** 检测运行时是否为 Bun（包括编译二进制与 `bun run` 两种情况） */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// 安装方式检测
// =============================================================================

/** 安装方式的探测结果：决定用哪个包管理器命令执行自更新 */
export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

/** 自更新命令中的单条步骤：一个可执行命令 + 参数 + 用于展示给人的单行文本 */
interface SelfUpdateCommandStep {
	command: string;
	args: string[];
	display: string;
}

/**
 * 一条完整的自更新命令：顶层字段即首步（或唯一一步）的 command/args/display；
 * `steps` 在需要多步执行（如 fork 改名场景需先卸载旧包再装新包）时按序列出各步骤。
 */
export interface SelfUpdateCommand extends SelfUpdateCommandStep {
	steps?: SelfUpdateCommandStep[];
}

/**
 * 自更新的安装目标：字符串形式表示"卸载与安装都针对同一包"；
 * 对象形式可显式区分 packageName（要卸载的旧包名）与 installSpec（要安装的 spec），
 * 供 fork / 品牌化后的"换名安装"使用。
 */
export type SelfUpdatePackageTarget = string | { packageName: string; installSpec?: string };

/** 把安装目标统一为 { packageName, installSpec } 结构；字符串形式下二者同值 */
function normalizeSelfUpdatePackageTarget(target: SelfUpdatePackageTarget): {
	packageName: string;
	installSpec: string;
} {
	if (typeof target === "string") {
		return { packageName: target, installSpec: target };
	}
	// installSpec 未指定时退回包名，即安装该包的最新版本
	return { packageName: target.packageName, installSpec: target.installSpec ?? target.packageName };
}

/**
 * 组装一条完整的自更新命令；提供 uninstallStep 时（fork 改名场景），
 * 把「卸载旧包 + 安装新包」合并为多步命令，display 用 " && " 串联便于展示。
 */
function makeSelfUpdateCommand(
	installStep: SelfUpdateCommandStep,
	uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
	if (!uninstallStep) return installStep;
	return {
		...installStep,
		display: `${uninstallStep.display} && ${installStep.display}`,
		steps: [uninstallStep, installStep],
	};
}

/** 构造单条命令步骤；display 是可直接复制的单行文本（含空白的参数加引号） */
function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
	return {
		command,
		args,
		display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
	};
}

/**
 * 探测本 CLI 当前的安装方式（由哪个包管理器安装），用于决定自更新命令。
 *
 * 判定依据是路径"气味"：把模块目录与进程可执行文件路径拼接
 * （用 \0 分隔，避免两段路径交界处拼出误匹配的子串），统一转小写、
 * 反斜杠归一为正斜杠后，按各包管理器特有的目录特征逐一匹配。
 */
export function detectInstallMethod(): InstallMethod {
	// Bun 编译二进制自成一类：不走包管理器，更新方式为重新下载
	if (isBunBinary) {
		return "bun-binary";
	}

	const resolvedPath = `${__dirname}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

	// pnpm 的内容寻址存储目录（/.pnpm/）特征最独特，优先判定，
	// 否则会被后面更宽泛的 /node_modules/ 兜底规则抢先命中
	if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
		return "pnpm";
	}
	if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
		return "yarn";
	}
	if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
		return "bun";
	}
	// 普通项目内的 node_modules（如 nvm 的 /npm/ 版本目录）也视为 npm 管理
	if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
		return "npm";
	}

	return "unknown";
}

/**
 * 在无法执行 `npm root -g` 时，从当前包路径反推 npm 全局安装的 root 与 prefix。
 * 目标形态为 `<prefix>/lib/node_modules/<pkg>`（或带 @scope 的多一级目录）；
 * 推断成功返回 { root, prefix }，形态不符则返回 undefined。
 */
function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
	const packageDir = getPackageDir();
	// 路径解析器与实际路径风格保持一致：Windows 或含反斜杠时用 win32 版本
	const path = process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
	const parent = path.dirname(packageDir);
	let root: string | undefined;
	// 形态一：<root>/@scope/<pkg>——父目录名以 @ 开头，且再上一级是 node_modules
	if (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules") {
		root = path.dirname(parent);
	} else if (path.basename(parent) === "node_modules") {
		// 形态二：<root>/<pkg>
		root = parent;
	}
	if (!root) return undefined;
	// 只有 root 之上还有 lib 目录（Unix 全局布局 <prefix>/lib/node_modules）才认定是全局安装
	const rootParent = path.dirname(root);
	if (path.basename(rootParent) === "lib") return { root, prefix: path.dirname(rootParent) };
	// Windows 全局 npm 前缀形如 `<prefix>\node_modules`，仅凭路径形态无法与本地
	// 项目安装区分。没有 `npm root -g` 佐证时，不推断不受支持的 Windows 自定义前缀。
	return undefined;
}

/**
 * 按安装方式构造对应的自更新命令。
 * 生成的命令统一带 --ignore-scripts（避免 postinstall 等脚本干扰更新），并把
 * minimumReleaseAge 归零（绕过新版本的供应链冷却期，确保能装到最新版）。
 * 返回 undefined 表示该安装方式不支持命令行自更新（bun-binary / unknown）。
 */
function getSelfUpdateCommandForMethod(
	method: InstallMethod,
	installedPackageName: string,
	updatePackageTarget: SelfUpdatePackageTarget = installedPackageName,
	npmCommand?: string[],
): SelfUpdateCommand | undefined {
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	switch (method) {
		// 编译二进制没有包管理器可调，自更新交给发布页下载
		case "bun-binary":
			return undefined;
		case "pnpm": {
			// `pnpm root -g` 可查到全局根时无需推断；否则从 .pnpm 存储路径反推全局目录
			const match = readCommandOutput("pnpm", ["root", "-g"])
				? undefined
				: /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			// 显式指定全局 bin 目录，避免新版可执行文件装到别处导致 PATH 失效
			const binDirArgs = match
				? [`--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}`]
				: [];
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("pnpm", [
					"install",
					"-g",
					"--ignore-scripts",
					"--config.minimumReleaseAge=0",
					...binDirArgs,
					target.installSpec,
				]),
				// 安装目标与已装包名不同（fork 改名）时，先卸载旧包再装新包
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("pnpm", ["remove", "-g", ...binDirArgs, installedPackageName]),
			);
		}
		case "yarn":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", target.installSpec]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
			);
		case "bun":
			return makeSelfUpdateCommand(
				makeSelfUpdateCommandStep("bun", [
					"install",
					"-g",
					"--ignore-scripts",
					"--minimum-release-age=0",
					target.installSpec,
				]),
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
			);
		case "npm": {
			// npmCommand 允许宿主指定替代的 npm 兼容命令（如 bun）及其额外参数
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			// 未显式指定命令时才做路径推断；推断出的全局 prefix 通过 --prefix 传给 npm，
			// 保证更新落在当前安装位置而不是 npm 的默认前缀
			const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
			const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
			const installStep = makeSelfUpdateCommandStep(command, [
				...prefixArgs,
				"install",
				"-g",
				"--ignore-scripts",
				"--min-release-age=0",
				target.installSpec,
			]);
			const uninstallStep =
				target.packageName === installedPackageName
					? undefined
					: makeSelfUpdateCommandStep(command, [...prefixArgs, "uninstall", "-g", installedPackageName]);
			return makeSelfUpdateCommand(installStep, uninstallStep);
		}
		case "unknown":
			return undefined;
	}
}

/**
 * 同步执行外部命令并返回其 stdout（去首尾空白）。
 * 命令失败或输出为空时返回 undefined；requireSuccess 为 true 时失败直接抛错，
 * 用于「必须拿到结果才能继续」的调用点。
 */
function readCommandOutput(
	command: string,
	args: string[],
	options: { requireSuccess?: boolean } = {},
): string | undefined {
	const result = spawnProcessSync(command, args, {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status === 0) return result.stdout.trim() || undefined;
	if (options.requireSuccess) {
		const reason = result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
	}
	return undefined;
}

/**
 * 列出指定包管理器可能的全局安装根目录（可能有多处候选，逐一尝试），
 * 供后续判断「当前运行的包是否落在其中某个根之下」。
 */
function getGlobalPackageRoots(method: InstallMethod, _packageName: string, npmCommand?: string[]): string[] {
	switch (method) {
		case "npm": {
			const configured = !!npmCommand?.length;
			const [command = "npm", ...npmArgs] = npmCommand ?? [];
			// 宿主显式指定用 bun 的 npm 兼容层时：默认全局目录 +
			// 从 `pm bin -g` 推导出的目录都纳入候选
			if (configured && command === "bun") {
				const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
					requireSuccess: true,
				});
				const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
				if (bunBin) {
					roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
				}
				return roots;
			}
			const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
				requireSuccess: configured,
			});
			// 未显式配置命令时 `npm root -g` 可能拿不到结果，用路径推断的 root 兜底
			const inferred = configured ? undefined : getInferredNpmInstall();
			return [root, inferred?.root].filter((x): x is string => !!x);
		}
		case "pnpm": {
			const root = readCommandOutput("pnpm", ["root", "-g"]);
			// root 与其父目录都作为候选（pnpm 全局目录层级因版本而异）
			if (root) return [root, dirname(root)];
			// 查询失败时退回正则解析 .pnpm 存储路径得到全局目录
			const match = /^(.*[\\/]global[\\/][^\\/]+)[\\/]\.pnpm[\\/]/.exec(getPackageDir());
			return match ? [match[1]] : [];
		}
		case "yarn": {
			const dir = readCommandOutput("yarn", ["global", "dir"]);
			return dir ? [dir, join(dir, "node_modules")] : [];
		}
		case "bun": {
			const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
			const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
			if (bunBin) {
				roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
			}
			return roots;
		}
		case "bun-binary":
		case "unknown":
			return [];
	}
}

/**
 * 把路径规范化为可用于相等 / 前缀比较的形式。
 * 路径不存在时返回 undefined；可选解析符号链接（pnpm 等包管理器大量使用软链）；
 * Windows 下再统一转小写以消除大小写差异。
 */
function normalizeExistingPathForComparison(path: string, resolveSymlinks: boolean): string | undefined {
	const resolvedPath = resolve(path);
	if (!existsSync(resolvedPath)) {
		return undefined;
	}
	let normalizedPath = resolvedPath;
	if (resolveSymlinks) {
		try {
			normalizedPath = realpathSync(resolvedPath);
		} catch {
			// 符号链接解析失败（如链接环）视为不可比较
			return undefined;
		}
	}
	if (process.platform === "win32") {
		normalizedPath = normalizedPath.toLowerCase();
	}
	return normalizedPath;
}

/** 生成路径的两种比较候选（原始路径 / 解析符号链接后的真实路径），去重后返回 */
function getPathComparisonCandidates(path: string): string[] {
	return Array.from(
		new Set(
			[normalizeExistingPathForComparison(path, false), normalizeExistingPathForComparison(path, true)].filter(
				(candidate): candidate is string => !!candidate,
			),
		),
	);
}

/** 从入口脚本（process.argv[1]）逐级向上找最近的 package.json，定位入口所在的包目录 */
function getEntrypointPackageDir(): string | undefined {
	const entrypoint = process.argv[1];
	if (!entrypoint) return undefined;
	let dir = dirname(entrypoint);
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return undefined;
}

/**
 * 检查自更新目标路径是否可写：包目录本身与其父目录（卸载会改动父目录）
 * 都必须可写，任一不可写即返回 false。
 */
function isSelfUpdatePathWritable(): boolean {
	const packageDir = getPackageDir();
	try {
		accessSync(packageDir, constants.W_OK);
		accessSync(dirname(packageDir), constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 判断当前运行的包是否确实装在某个全局包管理器根目录之下。
 * 同时取「模块目录」与「入口脚本目录」两种位置（tsx 等场景二者可能不同），
 * 与所有全局根的候选路径做前缀匹配；前缀末尾补上路径分隔符，
 * 避免 /foo 误匹配 /foobar 这类同前缀目录。
 */
function isManagedByGlobalPackageManager(method: InstallMethod, packageName: string, npmCommand?: string[]): boolean {
	const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter((dir): dir is string => !!dir);
	const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
	return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
		return getPathComparisonCandidates(root).some((normalizedRoot) => {
			const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
			return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
		});
	});
}

/**
 * 获取当前安装的自更新命令。
 * 需同时满足三个条件才返回命令：该安装方式支持命令行更新、当前包确实装在
 * 对应包管理器的全局根之下、安装路径可写；否则返回 undefined，
 * 调用方应转而用 {@link getSelfUpdateUnavailableInstruction} 提示用户手动更新。
 */
export function getSelfUpdateCommand(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): SelfUpdateCommand | undefined {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageTarget, npmCommand);
	if (!command || !isManagedByGlobalPackageManager(method, packageName, npmCommand) || !isSelfUpdatePathWritable()) {
		return undefined;
	}
	return command;
}

/**
 * 生成「无法自更新」时展示给用户的手动更新指引文案。
 * 按失败原因区分：bun 二进制给出下载链接；确属全局管理但路径不可写时给出
 * 可复制的完整命令；非全局管理或未知方式时提示用提供它的包管理器 / 包装器更新。
 */
export function getSelfUpdateUnavailableInstruction(
	packageName: string,
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = packageName,
): string {
	const method = detectInstallMethod();
	const target = normalizeSelfUpdatePackageTarget(updatePackageTarget);
	if (method === "bun-binary") {
		return `Download from: https://github.com/earendil-works/pi-mono/releases/latest`;
	}
	const command = getSelfUpdateCommandForMethod(method, packageName, target, npmCommand);
	if (command) {
		if (isManagedByGlobalPackageManager(method, packageName, npmCommand) && !isSelfUpdatePathWritable()) {
			return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
		}
		return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
	}
	return `Update ${target.installSpec} using the package manager, wrapper, or source checkout that provides this installation.`;
}

/**
 * 获取面向用户的更新指引：可自更新时直接给出命令，
 * 否则退化到 {@link getSelfUpdateUnavailableInstruction} 的手动更新说明。
 */
export function getUpdateInstruction(packageName: string): string {
	const method = detectInstallMethod();
	const command = getSelfUpdateCommandForMethod(method, packageName);
	if (command) {
		return `Run: ${command.display}`;
	}
	return getSelfUpdateUnavailableInstruction(packageName);
}

// =============================================================================
// 包内资源路径（随可执行文件分发）
// =============================================================================

/**
 * 从 startDir 逐级向上查找最近的 package.json，返回解析包内资源
 * （主题、package.json、README.md、CHANGELOG.md 等）的基准目录。
 * - Bun 二进制：返回可执行文件所在目录；
 * - Node.js 与 tsx：返回包含 package.json 的包根目录；
 * - 当包根可用时，忽略被复制进 dist/ 的 Bun 二进制元数据。
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	// 逐级向上，直到文件系统根（dir === dirname(dir)）
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			// build:binary 会把 Bun 的元数据放进 dist/。Node 仍需要包根目录，
			// 否则 dist 相对的资源路径会变成 dist/dist/。
			if (basename(dir) === "dist" && existsSync(join(parent, "package.json"))) {
				return parent;
			}
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

/**
 * 获取当前包的根目录（所有随包分发资源的定位基准）。
 * 优先级：PI_PACKAGE_DIR 环境变量覆盖 → Bun 二进制取可执行文件所在目录 →
 * Node/tsx 从模块所在目录向上找 package.json。
 */
export function getPackageDir(): string {
	// 允许通过环境变量覆盖（对 Nix/Guix 尤其有用：store 路径会被切分成
	// 难以向上遍历的碎片结构）
	const envDir = process.env.PI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	if (isBunBinary) {
		// Bun 二进制：process.execPath 指向编译产物本身
		return dirname(process.execPath);
	}
	return findNodePackageDir(__dirname);
}

/**
 * 获取内置主题目录（随包分发）。
 * - Bun 二进制：可执行文件旁的 theme/；
 * - Node.js（dist/ 构建产物）：dist/modes/interactive/theme/；
 * - tsx（源码运行）：src/modes/interactive/theme/。
 */
export function getThemesDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "theme");
	}
	// 主题位于 src/ 或 dist/ 下的 modes/interactive/theme/，按是否存在 src/ 自动区分
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "theme");
}

/**
 * 获取 HTML 导出模板目录（随包分发）。
 * - Bun 二进制：可执行文件旁的 export-html/；
 * - Node.js（dist/）：dist/core/export-html/；
 * - tsx（src/）：src/core/export-html/。
 */
export function getExportTemplateDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "export-html");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** 获取 package.json 路径 */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** 获取 README.md 路径 */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** 获取 docs 文档目录路径 */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** 获取 examples 示例目录路径 */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** 获取 CHANGELOG.md 路径 */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * 获取内置交互模式资源目录。
 * - Bun 二进制：可执行文件旁的 assets/；
 * - Node.js（dist/）：dist/modes/interactive/assets/；
 * - tsx（src/）：src/modes/interactive/assets/。
 */
export function getInteractiveAssetsDir(): string {
	if (isBunBinary) {
		return join(getPackageDir(), "assets");
	}
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "modes", "interactive", "assets");
}

/** 获取某个内置交互资源的完整路径 */
export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

// =============================================================================
// 应用配置（来自 package.json 的 piConfig 段）
// =============================================================================

/** 只声明本模块用到的 package.json 字段（含 fork 品牌化的 piConfig 配置段） */
interface PackageJson {
	name?: string;
	version?: string;
	piConfig?: {
		name?: string;
		configDir?: string;
	};
}

// 模块加载时读取并解析 package.json。文件不存在（ENOENT）时容忍并使用默认值；
// 其他错误（如 JSON 语法损坏）直接抛出。
let pkg: PackageJson = {};
try {
	pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf-8"))) as PackageJson;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

// fork 在 piConfig.name 中配置的品牌短名（未配置则为 undefined）
const piConfigName: string | undefined = pkg.piConfig?.name;
/** npm 包名（fork 改名后随之变化） */
export const PACKAGE_NAME: string = pkg.name || "@earendil-works/pi-coding-agent";
/** 应用短名：决定环境变量前缀、日志文件名等；fork 可通过 piConfig.name 覆盖 */
export const APP_NAME: string = piConfigName || "pi";
/** 展示用标题：有品牌名时直接用品牌名，否则用默认的 "π" */
export const APP_TITLE: string = piConfigName ? APP_NAME : "π";
/** 用户配置目录名（位于家目录下），fork 可通过 piConfig.configDir 覆盖 */
export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
/** 从 package.json 读到的版本号，缺失时兜底为 "0.0.0" */
export const VERSION: string = pkg.version || "0.0.0";

// 环境变量名按 APP_NAME 动态生成，例如 PI_CODING_AGENT_DIR 或 TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

/** 展开路径中的 ~ 前缀并规范化（目前直接委托 normalizePath） */
export function expandTildePath(path: string): string {
	return normalizePath(path);
}

// 会话分享查看器的默认地址，可被 PI_SHARE_VIEWER_URL 环境变量覆盖
const DEFAULT_SHARE_VIEWER_URL = "https://pi.dev/session/";

/** 根据 gist ID 生成会话分享查看器的完整 URL（以 # 片段形式附带 gist ID） */
export function getShareViewerUrl(gistId: string): string {
	const baseUrl = process.env.PI_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
	return `${baseUrl}#${gistId}`;
}

// =============================================================================
// 用户配置路径（~/.pi/agent/*）
// =============================================================================

/**
 * 获取 agent 的用户配置根目录（默认 ~/.pi/agent/）。
 * 可用环境变量（如 PI_CODING_AGENT_DIR）覆盖，覆盖值支持 ~ 展开。
 */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** 获取用户自定义主题目录 */
export function getCustomThemesDir(): string {
	return join(getAgentDir(), "themes");
}

/** 获取 models.json（自定义模型列表）路径 */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** 获取 auth.json（凭据存储）路径 */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** 获取 settings.json（用户设置）路径 */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** 获取自定义 tools 目录 */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** 获取托管二进制目录（fd、rg 等由 agent 下载管理的工具） */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** 获取自定义 prompt 模板目录 */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** 获取会话记录目录 */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** 获取调试日志文件路径（文件名含 APP_NAME，fork 后互不冲突） */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
