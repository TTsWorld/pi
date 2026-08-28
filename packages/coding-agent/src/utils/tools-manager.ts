/**
 * @file tools-manager.ts —— 外部命令行工具（fd / ripgrep）的自动获取与管理
 *
 * @description
 * coding-agent 的文件搜索工具依赖 `fd` 与 `rg`（ripgrep）两个外部二进制。
 * 本文件负责：优先复用用户系统 PATH 中已有的安装；若不存在则从 GitHub
 * Releases 下载对应平台的压缩包，解压出二进制并安装到专属 bin 目录。
 *
 * 主要功能点：
 * - `getToolPath`：按「本地 bin 目录 → 系统 PATH（含备选命令名）」顺序查找工具；
 * - `ensureTool`：对外主入口，查找失败时按需下载，全程通过 `onStatus` 回调上报进度；
 * - 平台适配：根据 OS（darwin/linux/win32）与 CPU 架构拼出 GitHub 资产文件名；
 * - 解压兼容：tar.gz 用 tar，zip 在 Windows 用 bsdtar/PowerShell 兜底、类 Unix 用 unzip/tar 兜底；
 * - 边界处理：离线模式（PI_OFFLINE）跳过下载；Android/Termux 因 libc 不兼容只提示 pkg 安装。
 *
 * 依赖关系：
 * - `../config.ts`：获取 bin 目录位置与产品名；
 * - `./management-http.ts`：带重试与超时的 fetch 封装；
 * - Node 内置模块：child_process（探测/解压）、fs、os、path、stream。
 */

import { type SpawnSyncReturns, spawnSync } from "child_process";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { APP_NAME, getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";

/** 下载的二进制工具统一存放目录（由全局配置决定） */
const TOOLS_DIR = getBinDir();
/** GitHub API（查询最新版本号）的网络超时时间 */
const NETWORK_TIMEOUT_MS = 10_000;
/** 下载压缩包资产的网络超时时间（文件较大，给到 2 分钟） */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * 判断是否启用了离线模式（环境变量 PI_OFFLINE 为 1/true/yes 时视为启用）。
 * 离线模式下跳过所有下载行为，只使用本地已有工具。
 */
function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** 单个工具的下载配置描述 */
interface ToolConfig {
	name: string;
	repo: string; // GitHub 仓库名（如 "sharkdp/fd"）
	binaryName: string; // 压缩包内二进制文件的名称
	systemBinaryNames?: string[]; // 下载前依次尝试的系统命令备选名（如 fd 在 Debian 上叫 fdfind）
	tagPrefix: string; // release 标签前缀（如 "v" 对应 v1.0.0，"" 对应 1.0.0）
	/** 根据版本与平台返回对应的资产文件名；平台不受支持时返回 null */
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

/** 当前支持自动管理的工具集合（键为内部工具标识） */
const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

/**
 * 通过实际执行命令来探测其是否存在于 PATH 中。
 * 调用 `cmd --version` 只是为了触发查找：spawn 返回的 error（如 ENOENT）
 * 表明命令不存在，而不管退出码是多少。
 */
function commandExists(cmd: string): boolean {
	try {
		const result = spawnSync(cmd, ["--version"], { stdio: "pipe" });
		// 仅当 spawn 本身报错（典型是 ENOENT，即命令未找到）才视为不存在
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

/**
 * 获取工具的可执行路径：优先返回本地 bin 目录中已下载的版本，
 * 否则回退到系统 PATH 里已有的命令（此时直接返回命令名，
 * 交由后续 spawn 按 PATH 解析）。
 *
 * @param tool - 工具标识（"fd" 或 "rg"）
 * @returns 工具路径或命令名；完全找不到时返回 null
 */
export function getToolPath(tool: "fd" | "rg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// 优先检查我们自己的工具目录（保证使用受控版本）
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// 再检查系统 PATH——找到时直接返回命令名即可（命令本身就在 PATH 里）
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandExists(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

/**
 * 通过 GitHub API 查询仓库最新 release 的版本号。
 * 返回值已去掉开头的 "v" 前缀（如 "v10.1.0" → "10.1.0"），
 * 便于后续拼接不带前缀的资产文件名。
 */
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${repo}/releases/latest`,
		{
			headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		},
		{ timeoutMs: NETWORK_TIMEOUT_MS },
	);

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

/**
 * 从指定 URL 下载文件并流式写入目标路径。
 * 使用 stream pipeline 而非一次性读入内存，避免大文件占用过高。
 */
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	// 将 Web 流转换为 Node 可读流后直接管道写入文件
	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

/**
 * 在解压目录中迭代式（显式栈实现的 DFS）查找指定名称的二进制文件。
 * 兜底用途：当压缩包的内部目录结构不符合预期（既不在根目录也不在
 * 版本号子目录下）时，递归搜索任意深度找到目标文件。
 */
function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

/**
 * 把 spawn 失败的结果格式化为可读的错误信息字符串。
 * 按优先级依次尝试：spawn 错误信息 → stderr → stdout → 退出码。
 */
function formatSpawnFailure(result: SpawnSyncReturns<Buffer>): string {
	if (result.error?.message) {
		return result.error.message;
	}
	const stderr = result.stderr?.toString().trim();
	if (stderr) {
		return stderr;
	}
	const stdout = result.stdout?.toString().trim();
	if (stdout) {
		return stdout;
	}
	// 以上都为空时至少给出退出码（status 为 null 表示进程被信号杀死等异常终止）
	return `exit status ${result.status ?? "unknown"}`;
}

/**
 * 同步执行一条解压命令；成功返回 null，失败返回 "命令: 原因" 形式的错误描述。
 * 返回字符串而非抛异常，便于调用方收集多个备选命令的失败原因。
 */
function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe" });
	if (!result.error && result.status === 0) {
		return null;
	}
	return `${command}: ${formatSpawnFailure(result)}`;
}

/** 用系统 tar 解压 .tar.gz 压缩包到指定目录 */
function extractTarGzArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failure = runExtractionCommand("tar", ["xzf", archivePath, "-C", extractDir]);
	if (failure) {
		throw new Error(`Failed to extract ${assetName}: ${failure}`);
	}
}

/**
 * 定位 Windows 自带的 bsdtar（System32\tar.exe）完整路径。
 * 显式给出完整路径可避免 PATH 中 Git Bash 的 GNU tar 抢先命中——
 * GNU tar 不支持 zip 格式。
 */
function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) {
			return systemTar;
		}
	}
	// 兜底：环境变量缺失时退回让 PATH 自行解析
	return "tar.exe";
}

/**
 * 解压 zip 压缩包，按平台使用不同的工具链并逐级兜底：
 * - Windows：优先 System32 的 bsdtar，失败后改用 PowerShell 的 Expand-Archive；
 * - 类 Unix：优先 unzip，失败后改用 tar（bsdtar 同样支持 zip）。
 * 所有尝试都失败时才抛出携带全部失败原因的异常。
 */
function extractZipArchive(archivePath: string, extractDir: string, assetName: string): void {
	const failures: string[] = [];

	if (platform() === "win32") {
		// Windows 自带的 tar.exe 实为 bsdtar，支持 zip 格式。优先用 System32
		// 里的这个版本，而不是 Git Bash 的 GNU tar（后者不支持 zip 压缩包）。
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);

		// 第二级兜底：PowerShell 的 Expand-Archive，几乎任何 Win10+ 都可用
		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);

		// 兜底：部分精简系统没有 unzip，但通常装有支持 zip 的 bsdtar
		const tarFailure = runExtractionCommand("tar", ["xf", archivePath, "-C", extractDir]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}

	throw new Error(`Failed to extract ${assetName}: ${failures.join("; ")}`);
}

/**
 * 下载并安装一个工具：查询最新版本 → 下载平台对应压缩包 → 解压 →
 * 把二进制移动到 bin 目录并赋可执行权限。
 *
 * @param tool - 工具标识（"fd" 或 "rg"）
 * @returns 安装后的二进制文件绝对路径
 * @throws 平台不受支持、下载或解压失败、压缩包中找不到二进制时抛出
 */
async function downloadTool(tool: "fd" | "rg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// 查询最新版本号
	let version = await getLatestVersion(config.repo);
	// 特例：fd 在 Intel Mac 上固定使用 10.3.0（更新版本的 release 不再提供 x86_64 macOS 资产）
	if (tool === "fd" && plat === "darwin" && architecture === "x64") {
		version = "10.3.0";
	}

	// 拼出当前平台对应的资产文件名
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// 确保工具目录存在（首次下载时创建）
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// 下载压缩包
	await downloadFile(downloadUrl, archivePath);

	// 解压到唯一的临时目录。启动阶段 fd 与 rg 可能并发下载，
	// 共用固定目录名会互相覆盖产生竞态，故拼入 pid/时间戳/随机数。
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		// 按扩展名选择对应的解压方式
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// 在解压产物中定位二进制。有的压缩包把文件直接放在根目录，
		// 有的则嵌套在带版本号的子目录里，两种位置都尝试。
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		// 两个常规位置都没有时，退化为全目录递归搜索
		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			// 移动到 bin 目录下的最终位置（同分区 rename，开销极小）
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// 赋予可执行权限（仅 Unix 需要，Windows 无此概念）
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// 无论成败都清理压缩包与临时解压目录
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

/** Termux（Android）下各工具对应的 pkg 包名，用于生成安装提示 */
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

/** 工具获取过程的状态上报消息（info 为普通进度，warning 为需要用户注意的问题） */
export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}

/**
 * 确保工具可用，必要时自动下载安装。
 * 进度通过 `onStatus` 回调上报；不传回调则整个过程静默完成。
 *
 * 查找顺序与降级策略：
 * 1. 已存在（本地 bin 目录或系统 PATH）→ 直接返回路径；
 * 2. 离线模式 → 仅警告并返回 undefined，不发起网络请求；
 * 3. Android/Termux → 因 libc 不兼容无法复用 Linux 二进制，提示用 pkg 安装；
 * 4. 其余情况 → 从 GitHub 下载，失败仅警告不抛出（调用方可在无工具模式下继续运行）。
 *
 * @param tool - 工具标识（"fd" 或 "rg"）
 * @param onStatus - 可选的状态回调，接收进度或警告消息
 * @returns 工具路径；不可用时返回 undefined
 */
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		// 已经可用（本地下载过或系统已安装），无需任何动作
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	if (isOfflineModeEnabled()) {
		onStatus?.({ type: "warning", message: `${config.name} not found. Offline mode enabled, skipping download.` });
		return undefined;
	}

	// 在 Android/Termux 上，由于 Bionic libc 与 glibc 不兼容，下载的 Linux
	// 二进制无法运行，只能提示用户通过 pkg 自行安装。
	if (platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		onStatus?.({ type: "warning", message: `${config.name} not found. Install with: pkg install ${pkgName}` });
		return undefined;
	}

	// 找不到工具——开始下载
	onStatus?.({ type: "info", message: `${config.name} not found. Downloading...` });

	try {
		const path = await downloadTool(tool);
		onStatus?.({ type: "info", message: `${config.name} installed to ${path}` });
		return path;
	} catch (e) {
		onStatus?.({
			type: "warning",
			message: `Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`,
		});
		return undefined;
	}
}
