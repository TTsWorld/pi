/**
 * @file shell.ts —— Shell 检测、执行配置与进程生命周期管理
 *
 * @description
 * 为 Bash 工具与 PowerShell 工具提供底层支撑：
 * - 探测可用的 bash（Windows 上优先 Git Bash，兼容 Cygwin/MSYS2/WSL）；
 * - 生成统一的 ShellConfig（可执行文件 + 参数 + 命令传递方式）；
 * - 构造子进程环境变量（把自有 bin 目录注入 PATH，保证能找到下载的 fd/rg）；
 * - 清洗二进制输出中会导致渲染库崩溃的字符；
 * - 追踪 detached 子进程并在退出时杀掉整棵进程树，避免孤儿进程残留。
 *
 * 依赖关系：
 * - `../config.ts`：获取自有 bin 目录；
 * - Node 内置模块：fs / path / child_process。
 */

import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

/**
 * Shell 调用配置：可执行文件、固定启动参数，
 * 以及命令文本的传递方式（拼进 argv 或写入 stdin）。
 */
export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

/**
 * 判断给定路径是否为旧版 WSL 的 bash.exe（位于 System32/Sysnative 下）。
 * 旧版 WSL bash 不支持 `bash -c`，只能以 `bash -s` 从 stdin 读命令，
 * 因此需要单独识别出来改变命令传递方式。
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/**
 * 为指定 bash 生成 ShellConfig：
 * 旧版 WSL bash 用 `-s` + stdin 传输；其余（Git Bash 等）用常规 `-c`。
 */
function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

/**
 * 在 PATH 中查找可执行文件的完整路径（跨平台）。
 * 找不到或查找命令本身失败时返回 null。
 */
function findExecutableOnPath(executable: string): string | null {
	if (process.platform === "win32") {
		// Windows：用 where 查找，并额外校验文件确实存在
		//（where 可能返回 WindowsApps 之类的“应用执行别名”，实际文件并不存在）
		try {
			const result = spawnSync("where", [executable], {
				encoding: "utf-8",
				timeout: 5000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				// 取第一行匹配结果即可
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// 忽略错误
		}
		return null;
	}

	// Unix：用 which 查找并直接信任其输出（可正确处理 Termux 与特殊文件系统）
	try {
		const result = spawnSync("which", [executable], { encoding: "utf-8", timeout: 5000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// 忽略错误
	}
	return null;
}

/**
 * 根据平台与可选的显式 shell 路径解析出 Shell 配置。
 * 解析顺序：
 * 1. 用户显式指定的 shellPath（不存在则直接报错，不静默降级）；
 * 2. Windows：先找已知位置的 Git Bash，再找 PATH 上的 bash；
 * 3. Unix：先 /bin/bash，再 PATH 上的 bash，最后兜底到 sh。
 *
 * @param customShellPath - 用户在设置中指定的 shell 路径（可选）
 * @returns Shell 配置；Windows 上找不到任何 bash 时抛出带安装指引的 Error
 */
export function getShellConfig(customShellPath?: string): ShellConfig {
	// 1. 检查用户显式指定的 shell 路径
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return getBashShellConfig(customShellPath);
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		// 2. 依次尝试已知位置上的 Git Bash
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return getBashShellConfig(path);
			}
		}

		// 3. 兜底：在 PATH 上搜索 bash.exe（覆盖 Cygwin、MSYS2、WSL 等场景）
		const bashOnPath = findExecutableOnPath("bash.exe");
		if (bashOnPath) {
			return getBashShellConfig(bashOnPath);
		}

		// 一个 bash 都没找到：抛错并附上可操作的安装指引
		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	// Unix：先试 /bin/bash，再试 PATH 上的 bash，最后兜底到 sh
	if (existsSync("/bin/bash")) {
		return getBashShellConfig("/bin/bash");
	}

	const bashOnPath = findExecutableOnPath("bash");
	if (bashOnPath) {
		return getBashShellConfig(bashOnPath);
	}

	// 极端精简的系统：至少还有 POSIX sh 可用
	return { shell: "sh", args: ["-c"] };
}

/** PowerShell 启动参数：跳过配置文件、非交互模式、放行执行策略、命令从 -Command 读取 */
export const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"] as const;

/**
 * 在 Windows 上解析 PowerShell 的 Shell 配置，优先使用 PowerShell 7（pwsh.exe），
 * 找不到时回退到 Windows 自带的 powershell.exe。
 * 非 Windows 平台调用则抛错（该工具仅限 Windows）。
 */
export function getPowerShellConfig(): ShellConfig {
	if (process.platform !== "win32") {
		throw new Error("The powershell tool is only available on Windows.");
	}

	const shell = findExecutableOnPath("pwsh.exe") ?? findExecutableOnPath("powershell.exe");
	if (!shell) {
		throw new Error("No PowerShell executable found. Install PowerShell or add powershell.exe/pwsh.exe to PATH.");
	}

	return { shell, args: [...POWERSHELL_ARGS] };
}

/**
 * 构造子进程使用的环境变量：在原有 env 基础上，把自有 bin 目录
 * （存放自动下载的 fd/rg 等工具）插入 PATH 最前面，确保 shell 命令
 * 优先找到受控版本的工具。
 * 注意 Windows 上 PATH 键的大小写不固定，因此按大小写不敏感方式
 * 定位原键名后再原样写回。
 */
export function getShellEnv(): NodeJS.ProcessEnv {
	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	return {
		...process.env,
		[pathKey]: updatedPath,
	};
}

/**
 * 清洗二进制输出，使其可安全地用于显示与存储。
 * 移除会导致 string-width 崩溃或造成显示异常的字符：
 * - 控制字符（保留 tab、换行、回车）
 * - 孤立代理项（lone surrogate）
 * - Unicode Format 字符（会因 string-width 的 bug 导致崩溃）
 * - 码点为 undefined 的异常字符
 */
export function sanitizeBinaryOutput(str: string): string {
	// 用 Array.from 按码点（而非 UTF-16 码元）迭代字符串，
	// 这样能正确处理代理对，也能覆盖 codePointAt() 可能返回
	// undefined 的边界情况
	return Array.from(str)
		.filter((char) => {
			// 过滤掉会让 string-width 崩溃的字符，包括：
			// - Unicode 格式字符
			// - 孤立代理项（已被 Array.from 过滤掉）
			// - 除 \t \n \r 外的控制字符
			// - 码点为 undefined 的字符

			const code = char.codePointAt(0);

			// 码点为 undefined 时直接丢弃（无效字符串的边界情况）
			if (code === undefined) return false;

			// 放行 tab（0x09）、换行（0x0a）、回车（0x0d）这三个常用控制字符
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;

			// 过滤其余控制字符（0x00-0x1F，0x09/0x0a/0x0d 已在上面放行）
			if (code <= 0x1f) return false;

			// 过滤 Unicode 格式字符（U+FFF9-U+FFFB，string-width 的已知崩溃源）
			if (code >= 0xfff9 && code <= 0xfffb) return false;

			return true;
		})
		.join("");
}

/**
 * 已追踪的 detached 子进程 PID 集合。
 * detached 子进程不会随父进程自动退出，必须显式记录下来，
 * 才能在父进程收到停机信号（SIGHUP/SIGTERM）时一并清理。
 */
const trackedDetachedChildPids = new Set<number>();

/** 把一个 detached 子进程加入追踪集合 */
export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

/** 把子进程移出追踪集合（正常退出时调用，避免误杀被系统复用的 PID） */
export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

/** 杀掉所有仍在追踪中的 detached 子进程并清空集合 */
export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * 杀掉一个进程及其全部子进程（跨平台）。
 * Windows 用 taskkill 的 /T 按进程树强制终止；
 * Unix 优先对整个进程组（负 PID）发 SIGKILL，
 * 失败时退化为只杀目标进程本身。
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Windows：用 taskkill 终止整个进程树
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// taskkill 失败时忽略错误
		}
	} else {
		// Unix/Linux/Mac：对负 PID（进程组）发 SIGKILL 一次杀掉全部子孙进程
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 进程组 kill 失败时，退化为只杀子进程本身
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// 进程已经退出
			}
		}
	}
}
