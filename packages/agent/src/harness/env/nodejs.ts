/**
 * @file ExecutionEnv 能力接口（FileSystem + Shell）的 Node.js 实现
 * @description NodeExecutionEnv 基于 node:fs/promises 与 node:child_process，为 harness
 * 提供真实的本机文件系统能力与 shell 执行能力。设计动机与关键行为：
 * - 路径容错：所有路径统一经 resolvePath 规范化——展开 `~`/`~/`、把 file:// URL 转为本机
 *   路径、相对路径以 cwd 为基准解析，使工具层无需关心输入路径的形态；
 * - 错误归一：把底层 node 错误（ENOENT/EACCES/ABORT_ERR 等 errno）映射为后端无关的
 *   FileError/ExecutionError；所有操作绝不 throw，失败一律编码进 Result 返回；
 * - 超时与进程树管理：shell 命令在独立进程组中运行，超时或 abort 时 kill 整个进程树，
 *   cleanup 时统一回收仍在运行的子进程，避免遗留孤儿进程；
 * - 流式输出：stdout/stderr 以 chunk 为单位实时转发给 onStdout/onStderr 回调，
 *   命令结束后再返回全量文本与退出码。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	type ShellExecOptions,
	toError,
} from "../types.ts";

/** setTimeout 可接受的最大延时（毫秒，32 位有符号整数上限）。 */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** 换算成秒后的超时上限，用于校验 options.timeout 的合法范围。 */
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** 子进程 exit 之后等待残余 stdio 数据刷完的宽限期（毫秒），见 {@link waitForChildProcess}。 */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * 把以秒为单位的超时值校验并换算为毫秒。
 *
 * 校验规则：必须为有限的正数，且换算成毫秒后不得超过 setTimeout 的 32 位安全上限；
 * 非法输入返回 `timeout` 错误而不是抛出异常。
 *
 * @param timeout 以秒计的超时值；`undefined` 表示不设超时，原样透传
 * @returns 换算后的毫秒数（或不超时的 `undefined`）；非法时返回 {@link ExecutionError}
 */
function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

/**
 * 把输入路径规范化为绝对路径——本实现所有文件/shell 操作的统一寻址入口。
 *
 * 解析顺序（Why：模型与用户给出的路径形态不可控，须在进入 node:fs 之前统一容错）：
 * 1. `~` 展开为 home 目录；`~/` 前缀替换为 home 目录拼接（win32 额外兼容 `~\` 反斜杠写法）；
 * 2. `file://` 前缀经 fileURLToPath 转为本机路径；转换失败的畸形 URL 原样保留，
 *    交给后续文件操作当作普通路径处理并以 FileError 返回（维持「绝不 throw」的契约）；
 * 3. 绝对路径直接 resolve 规范化；相对路径以 cwd 为基准 resolve。
 *
 * @param cwd 相对路径的基准目录
 * @param path 任意形态的输入路径
 * @returns 规范化后的绝对路径（不要求存在、不解析符号链接）
 */
function resolvePath(cwd: string, path: string): string {
	let normalized = path;
	// ========== 前缀容错：~ 展开、file:// URL 转换（进入 node:path 之前统一处理） ==========
	if (normalized === "~") {
		normalized = homedir();
	} else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		normalized = join(homedir(), normalized.slice(2));
	} else if (normalized.startsWith("file://")) {
		try {
			normalized = fileURLToPath(normalized);
		} catch {
			// 畸形 URL 原样保留为普通路径，让后续文件操作以 FileError 返回而非抛异常（维持不抛错契约）。
		}
	}
	// ========== 收尾：绝对路径规范化 / 相对路径以 cwd 为基准 ==========
	return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

/**
 * 把 node stats 风格的对象映射为 {@link FileKind}。
 *
 * @param stats 提供 isFile/isDirectory/isSymbolicLink 判定的统计对象（lstat 结果）
 * @returns 对应的 FileKind；套接字、FIFO 等其余类型返回 `undefined`
 */
function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

/**
 * 由 stats 构造 {@link FileInfo} 元数据。
 *
 * @param path 已解析的绝对寻址路径（其 basename 作为其中的 name）
 * @param stats lstat 得到的统计对象（不跟随符号链接）
 * @returns 成功返回 FileInfo；类型不受支持（非 file/directory/symlink）时返回 `invalid` 错误
 */
function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: basename(path),
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

/** 类型守卫：判断未知错误是否为携带 `code` 属性的 node 系统错误（NodeJS.ErrnoException）。 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

/**
 * 把任意底层错误规范化为 {@link FileError}（node 侧错误映射的中枢）。
 *
 * 映射规则（Why：接口承诺错误码与后端无关，调用方据此区分「不存在」与「无权限」等语义）：
 * - 已是 FileError → 原样返回，避免二次包装；
 * - 是 node 系统错误 → 按 errno 字符串查表映射到后端无关错误码（见下方 switch）；
 * - 其余错误（含非 Error 抛出值）→ 统一归入 `unknown`，message 取规范化后的 cause.message。
 * 关联路径优先取 node 错误自带的 path，缺失时退回 fallbackPath。
 *
 * @param error 底层操作抛出的任意值
 * @param fallbackPath 错误未携带路径时使用的兜底路径
 * @returns 归一化后的 FileError
 */
function toFileError(error: unknown, fallbackPath?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	const nodeError = isNodeError(error) ? error : undefined;
	const path = typeof nodeError?.path === "string" ? nodeError.path : fallbackPath;
	if (nodeError) {
		const message = nodeError.message;
		// ========== node errno → 后端无关 FileErrorCode 的映射表 ==========
		// ABORT_ERR：操作被 abort signal 取消
		// ENOENT：路径不存在
		// EACCES / EPERM：权限不足
		// ENOTDIR：路径中间某段不是目录
		// EISDIR：对目录执行了仅适用于文件的操作
		// EINVAL：非法参数/非法路径
		switch (nodeError.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	// 无法识别的错误一律归入 unknown，绝不向上抛出
	return new FileError("unknown", cause.message, path, cause);
}

/**
 * abort 快捷检查：若 signal 已中止，返回一个 `aborted` 的 {@link FileError} 结果，
 * 否则返回 `undefined` 表示继续。用于在各个 await 边界快速短路，保证取消后不再发起后续操作。
 *
 * @param signal 可选的 abort signal
 * @param path 关联到错误的路径
 * @returns 已中止时返回 aborted 结果，否则返回 `undefined`
 */
function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

/**
 * 尽力而为的存在性探测：任何错误（含权限失败）都按「不存在」处理。
 * 仅供 shell 探测等 best-effort 场景使用，不能替代 {@link NodeExecutionEnv.exists} 的语义。
 *
 * @param path 待探测的路径
 * @returns 路径可访问时为 true，否则为 false
 */
async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 以尽力而为（best-effort）方式运行一条外部命令并收集 stdout。
 *
 * 供 `which bash` / `where bash.exe` 等 shell 探测使用：spawn 失败、进程出错或超时
 * 都不抛异常，而是返回空 stdout 与 `null` 状态，由调用方按「未找到」处理；
 * 超时通过 killProcessTree 杀掉整个进程树，避免探测命令挂死。
 *
 * @param command 可执行文件路径
 * @param args 命令行参数
 * @param timeoutMs 超时时间（毫秒），到点后 kill 进程树
 * @returns 收集到的 stdout 与退出状态（spawn 失败/进程出错/超时时为 `""` 与 `null`）
 */
async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		// ========== 启动探测命令：同步抛错（如可执行文件不存在）按「命令失败」收尾 ==========
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		// 超时兜底：探测命令超时后杀掉整个进程树（进程退出时由 close 事件收尾并清除定时器）
		const timeout = setTimeout(() => {
			if (child.pid) killProcessTree(child.pid);
		}, timeoutMs);
		// 收集 stdout；进程出错（error 事件）按失败收尾，正常关闭（close 事件）返回累计输出与状态
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timeout);
			resolve({ stdout: "", status: null });
		});
		child.on("close", (status) => {
			clearTimeout(timeout);
			resolve({ stdout, status });
		});
	});
}

/**
 * 在 PATH 上查找 bash 可执行文件的位置。
 *
 * win32 用 `where bash.exe`，其他平台用 `which bash`；只取第一行匹配结果，
 * 且要求该路径真实存在（防止 PATH 上残留失效记录）。任何一步失败都返回 `null`。
 *
 * @returns bash 的可执行文件路径；未找到时为 `null`
 */
async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

/** shell 调用配置：可执行文件、固定参数以及命令的传递方式。 */
interface ShellConfig {
	/** shell 可执行文件路径。 */
	shell: string;
	/** 传给 shell 的固定参数（不含命令本身），如 `["-c"]` 或 `["-s"]`。 */
	args: string[];
	/** 命令传递方式：`argv` 追加为最后一个参数（`bash -c CMD`）；`stdin` 写入标准输入（`bash -s`）。 */
	commandTransport?: "argv" | "stdin";
}

/**
 * 判断路径是否为「旧版 WSL bash」，即 System32/SysNative 目录下的 bash.exe。
 * 该 bash 是进入 WSL 发行版的登录 shell 包装器，`-c` 传参行为异常（命令会被再次转义），
 * 必须改用 `bash -s` 并把命令从 stdin 写入。
 */
function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

/**
 * 根据给定 bash 路径生成调用配置：旧版 WSL bash 用 `-s` + stdin 传命令，
 * 其余 bash 一律用 `-c` + argv 传命令。
 *
 * @param shell bash 可执行文件路径
 * @returns 对应的 ShellConfig
 */
function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

/**
 * 解析实际使用的 shell 配置（每次 exec 都会重新探测，结果不做缓存）。
 *
 * 选择顺序：
 * 1. 显式指定的 customShellPath：存在则直接使用，不存在返回 `shell_unavailable`；
 * 2. win32：依次探测 Git Bash 常见安装位置（ProgramFiles、ProgramFiles(x86)）→
 *    PATH 上的 bash.exe；全部落空时返回带安装指引的 `shell_unavailable` 错误；
 * 3. 类 Unix：/bin/bash → PATH 上的 bash → 最后兜底退回 `sh -c`（几乎所有系统都有）。
 *
 * @param customShellPath 显式指定的 shell 路径（对应构造选项 shellPath）
 * @returns 解析出的 ShellConfig；无法找到可用 shell 时返回 `shell_unavailable` 错误
 */
async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	// ========== 1) 显式指定的 shell：直接使用，但要求路径确实存在 ==========
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	// ========== 2) Windows：Git Bash 常见安装位置 → PATH 上的 bash.exe ==========
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(
			new ExecutionError(
				"shell_unavailable",
				`No bash shell found. Options:\n` +
					`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
					`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
					"  3. Configure an explicit shellPath\n\n" +
					`Searched Git Bash in:\n${candidates.map((path) => `  ${path}`).join("\n")}`,
			),
		);
	}

	// ========== 3) 类 Unix：/bin/bash → PATH 上的 bash → 兜底 sh ==========
	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	// 找不到 bash 时退回 sh——在极简容器等环境里比直接报错更可用
	return ok({ shell: "sh", args: ["-c"] });
}

/**
 * 合成子进程的环境变量。
 *
 * 合成规则：
 * - `inheritEnv` 为 false：只含 extraEnv，完全隔离宿主环境；
 * - `inheritEnv` 为 true（默认）：按 宿主 process.env → baseEnv（构造期 shellEnv）→
 *   extraEnv（单次调用）的顺序合并，后者优先级更高，可覆盖继承到的同名变量。
 *
 * @param baseEnv 构造 NodeExecutionEnv 时传入的基础环境变量
 * @param extraEnv 本次 exec 额外指定的环境变量
 * @param inheritEnv 是否继承宿主进程的环境变量，默认 true
 * @returns 合成后的环境变量对象
 */
function getShellEnv(
	baseEnv?: NodeJS.ProcessEnv,
	extraEnv?: Record<string, string>,
	inheritEnv = true,
): NodeJS.ProcessEnv {
	if (!inheritEnv) return { ...extraEnv };
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

/**
 * 终止一个进程及其整个子进程树（超时、abort 与 cleanup 共用的 kill 策略）。
 *
 * Why 杀进程树而非单个进程：shell 命令可能派生后台子进程，只杀 shell 本身会留下
 * 孤儿进程继续运行、占用资源甚至继续写 stdout。
 * - win32：以 detached 方式 fire-and-forget 执行 `taskkill /F /T /PID`
 *   （/F 强制终止，/T 连子孙进程一起终止）；
 * - 类 Unix：子进程以 detached（独立进程组）启动，故优先对进程组 `-pid` 发 SIGKILL
 *   一次性杀掉全组；失败（进程组已不存在）时退回杀单个 pid；再失败则视为进程已退出。
 *
 * @param pid 目标进程 id
 */
function killProcessTree(pid: number): void {
	// Windows：taskkill /T 终止整个进程树；本函数尽力而为，不关心其成败
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// 忽略 taskkill 自身的失败。
		}
		return;
	}

	// 类 Unix：优先向进程组（负 pid）发 SIGKILL，一次性杀掉整组
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// 进程组不存在时退回杀单个进程
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// 进程已死亡（可能恰好先退出了），忽略
		}
	}
}

/**
 * 等待子进程结束并返回其退出码。
 *
 * Why 不只用 `close` 事件：`close` 要等 stdio 流全部关闭才触发，而子进程若把 stdout
 * 继承给自己派生的长命孙进程，这些流可能永远不关，导致 Promise 永不落定。因此这里以
 * `exit` 事件为主信号：进程退出后再等两条 stdio 流 end；若退出后仍有数据到达（说明数据
 * 还在刷），则以 EXIT_STDIO_GRACE_MS 为间隔顺延，宽限期内无新数据即强制销毁流并落定。
 *
 * @param child 已启动的子进程
 * @returns 退出码（进程被信号杀死时为 `null`）；进程启动失败（error 事件）时 reject
 */
function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolvePromise, reject) => {
		// ========== 状态标记 ==========
		// settled：Promise 是否已落定；exited：是否已收到 exit 事件；
		// stdoutEnded/stderrEnded：两条 stdio 流是否已 end（流为 null 时视为已结束）。
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		// ========== 监听清理：统一移除全部事件监听，避免落定后仍持有子进程引用 ==========
		const cleanup = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};
		// ========== 落定 Promise：幂等（settled 防重入），落定时销毁残余 stdio 流 ==========
		const finalize = (code: number | null): void => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolvePromise(code);
		};
		// 进程已退出且两条 stdio 流都已 end → 正常收尾
		const maybeFinalizeAfterExit = (): void => {
			if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		// （重新）武装宽限定时器：EXIT_STDIO_GRACE_MS 内无新事件即强制落定
		const armIdleTimer = (): void => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};
		// 进程退出后每到达一个数据 chunk 就顺延一次宽限期（说明还有数据在刷，需继续等）
		const onData = (): void => {
			if (exited && !settled) armIdleTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};
		// 进程级错误（如可执行文件不存在）：reject，由调用方映射为 spawn_error
		const onError = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		// exit：记录退出码；stdio 已全部 end 则立即落定，否则武装宽限定时器
		const onExit = (code: number | null): void => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) armIdleTimer();
		};
		// close：stdio 已全部关闭的理想路径，直接落定（同时也兜住了宽限期外的情况）
		const onClose = (code: number | null): void => finalize(code);

		// ========== 注册监听 ==========
		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

/**
 * {@link ExecutionEnv} 的 Node.js 实现：以真实文件系统与真实 shell 子进程提供
 * FileSystem + Shell 能力，是本机开发/生产环境的默认执行环境。
 *
 * 关键行为：
 * - 所有文件与执行操作绝不 throw，失败一律编码进 {@link Result}（接口契约）；
 * - shell 命令在独立进程组中运行，超时/abort 时 kill 整个进程树；
 * - 用 activeChildPids 跟踪活跃子进程，{@link cleanup} 时统一回收；
 * - 元数据类操作（fileInfo/listDir）用 lstat，不跟随符号链接；
 *   仅 canonicalPath 用 realpath 解析符号链接。
 */
export class NodeExecutionEnv implements ExecutionEnv {
	/** 相对路径的基准工作目录。 */
	cwd: string;
	/** 显式指定的 shell 可执行文件路径；未指定时按平台规则自动探测。 */
	private shellPath?: string;
	/** 注入每次 shell 命令的基础环境变量（优先级介于宿主 env 与单次 options.env 之间）。 */
	private shellEnv?: NodeJS.ProcessEnv;
	/** 仍在运行的子进程 pid 集合，cleanup 时用于统一 kill。 */
	private activeChildPids = new Set<number>();

	/**
	 * @param options.cwd 相对路径的基准工作目录
	 * @param options.shellPath 显式指定的 shell 路径；缺省时自动探测（Git Bash / PATH / bash / sh）
	 * @param options.shellEnv 注入到子进程的基础环境变量
	 */
	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	/** 解析为绝对寻址路径：经 {@link resolvePath} 做 `~`/file:// 容错；不要求路径存在、不解析符号链接。 */
	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	/** 在文件系统命名空间中用 node:path.join 拼接路径片段；不要求结果存在。 */
	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	/**
	 * 在 shell 子进程中执行命令（{@link Shell.exec} 的实现）。
	 *
	 * 整体流程：abort 预检 → 超时校验（秒→毫秒）→ shell 探测 → 工作目录存在性检查 →
	 * spawn（独立进程组）→ 流式转发 stdout/stderr → 等待进程退出 → 按优先级归结为
	 * callback_error / timeout / aborted / 成功。
	 *
	 * @param command 要执行的 shell 命令字符串
	 * @param options 执行选项，见 {@link ShellExecOptions}
	 * @returns 成功时返回 stdout/stderr 全量文本与退出码（被信号杀死时按 0 处理）；
	 * 失败时返回 {@link ExecutionError}（aborted/timeout/shell_unavailable/spawn_error/callback_error）
	 */
	async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		// ========== 前置校验：abort 预检与超时换算 ==========
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		// ========== 工作目录与 shell 探测 ==========
		// options.cwd 相对路径以 this.cwd 为基准解析；缺省直接用 this.cwd。
		// 工作目录不存在时提前失败——spawn 也会失败，但这里能给出更明确的错误信息。
		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;
		try {
			await access(cwd, constants.F_OK);
		} catch (error) {
			const cause = toError(error);
			return err(
				new ExecutionError(
					"spawn_error",
					`Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
					cause,
				),
			);
		}

		return await new Promise((resolvePromise) => {
			// ========== 本次执行的可变状态 ==========
			// timedOut：是否已触发超时 kill；callbackError：用户流式回调抛出的错误（最优先上报）。
			let stdout = "";
			let stderr = "";
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			// abort 处理：只负责杀进程树，进程退出后由 waitForChildProcess 统一收尾
			const onAbort = () => {
				if (child?.pid) {
					killProcessTree(child.pid);
				}
			};

			// 幂等落定：清理超时定时器与 abort 监听、注销 pid 追踪，只 resolve 一次
			const settle = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => {
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.abortSignal) options.abortSignal.removeEventListener("abort", onAbort);
				if (child?.pid) this.activeChildPids.delete(child.pid);
				if (settled) return;
				settled = true;
				resolvePromise(result);
			};

			try {
				// ========== 启动子进程 ==========
				// 旧版 WSL bash 用 stdin 传命令（bash -s），其余通过 argv 追加（bash -c CMD）。
				// 类 Unix 下 detached 启动让 shell 自成进程组，便于 killProcessTree 整组终止。
				const commandFromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env, options?.inheritEnv),
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				// 记入活跃 pid 集合，供 cleanup 兜底回收
				if (child.pid) this.activeChildPids.add(child.pid);
				if (commandFromStdin) {
					// stdin 传命令：吞掉写端错误（shell 可能已退出），写入命令后即关闭写端
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			} catch (error) {
				// spawn 同步抛错（如 shell 路径非法）映射为 spawn_error
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			// ========== 超时定时器：到点标记 timedOut 并杀进程树 ==========
			// timeout 错误并不在这里直接返回，而是等进程退出后由下方 then 分支统一落定。
			timeoutId =
				timeoutMs !== undefined
					? setTimeout(() => {
							timedOut = true;
							if (child?.pid) {
								killProcessTree(child.pid);
							}
						}, timeoutMs)
					: undefined;

			// ========== 注册 abort 监听 ==========
			// 覆盖 spawn 期间 signal 才中止的竞态：注册前若发现已 aborted，立即补杀一次。
			if (options?.abortSignal) {
				if (options.abortSignal.aborted) {
					onAbort();
				} else {
					options.abortSignal.addEventListener("abort", onAbort, { once: true });
				}
			}

			// ========== 流式转发 stdout/stderr ==========
			// 每个 chunk 一边累积到全量文本（供结果返回），一边实时转发给用户回调；
			// 回调抛异常时记下 callbackError 并立刻杀掉命令（最终以 callback_error 落定）。
			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				stdout += chunk;
				try {
					options?.onStdout?.(chunk);
				} catch (error) {
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
			});
			child.stderr?.on("data", (chunk: string) => {
				stderr += chunk;
				try {
					options?.onStderr?.(chunk);
				} catch (error) {
					const cause = toError(error);
					callbackError = new ExecutionError("callback_error", cause.message, cause);
					onAbort();
				}
			});

			// ========== 等待退出并按优先级归结结果 ==========
			// 优先级：callback_error（用户回调失败）> timeout > aborted > 成功。
			// exitCode 为 null（进程被信号杀死，即超时/abort 路径）时按 0 处理——
			// 这些路径已由前面的错误分支覆盖，不会把「被杀」伪装成成功。
			void waitForChildProcess(child).then(
				(code) => {
					if (callbackError) {
						settle(err(callbackError));
						return;
					}
					if (timedOut) {
						settle(err(new ExecutionError("timeout", `timeout:${options?.timeout}`)));
						return;
					}
					if (options?.abortSignal?.aborted) {
						settle(err(new ExecutionError("aborted", "aborted")));
						return;
					}
					settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
				},
				(error: Error) => settle(err(new ExecutionError("spawn_error", error.message, error))),
			);
		});
	}

	/** 读取 UTF-8 文本文件：路径经 resolvePath 容错；abort 预检之外再由 readFile 原生 signal 兜底取消。 */
	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 按 UTF-8 逐行读取文本文件，读满 `maxLines` 行即停止（不会把整个文件读进内存）。
	 *
	 * 实现要点：createReadStream + readline 逐行消费；读取前、每行之间、读取后都检查
	 * abort；finally 中关闭 lineReader 并销毁流，保证提前退出（行数上限/abort/异常）
	 * 时及时释放文件句柄。
	 *
	 * @param path 目标文件路径
	 * @param options.maxLines 最多读取的行数；`<= 0` 时直接返回空数组
	 * @param options.abortSignal 取消信号
	 * @returns 读取到的行数组（不含行尾符）
	 */
	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string[]>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			// ========== 流式逐行读取：达到行数上限即 break，不再消费剩余数据 ==========
			stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
			// crlfDelay: Infinity 让 \r\n 被当作单个换行符，正确处理 CRLF 结尾的文件
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				const loopAbort = abortResult<string[]>(options?.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			const afterReadAbort = abortResult<string[]>(options?.abortSignal, resolved);
			if (afterReadAbort) return afterReadAbort;
			return ok(lines);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			// 无论正常结束、提前 break 还是抛错，都释放底层流与文件句柄
			lineReader?.close();
			stream?.destroy();
		}
	}

	/** 读取二进制文件，返回原始字节（Uint8Array）。 */
	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<Uint8Array>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 创建或覆盖文件（接受字符串或字节内容）。
	 * 写入前先递归创建父目录（Why：调用方常直接写深层路径，要求父目录已存在会引入大量样板代码）；
	 * mkdir 之后、写入之前再次检查 abort，避免取消后仍执行写入。
	 */
	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal: abortSignal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 创建文件或向已有文件追加内容；与 writeFile 一样先递归创建父目录。 */
	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			await appendFile(resolved, content);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 原子重命名（目标存在时被替换）：源与目标分别经 resolvePath 解析后交给 node:rename。 */
	async renameFile(
		sourcePath: string,
		destinationPath: string,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const source = resolvePath(this.cwd, sourcePath);
		const destination = resolvePath(this.cwd, destinationPath);
		const aborted = abortResult<void>(abortSignal, destination);
		if (aborted) return aborted;
		try {
			await rename(source, destination);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, source));
		}
	}

	/** 返回路径元数据；用 lstat 而非 stat，因此不跟随符号链接（symlink 本身会被报告为 symlink）。 */
	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 列出目录的直接子项。
	 * 先 readdir(withFileTypes) 拿到条目名，再逐条 lstat 补全 kind/size/mtime；
	 * 循环中逐项检查 abort；任一条目 lstat 失败（如并发删除的竞态）则整体失败。
	 */
	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo[]>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			// ========== 逐条目补全元数据（lstat，不跟随符号链接） ==========
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 返回已存在路径的规范路径：用 realpath 解析符号链接；路径不存在时返回 not_found。 */
	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/**
	 * 判断路径是否存在：复用 fileInfo，把 not_found 归一为 false，
	 * 其余错误（如权限失败）原样返回——与接口「不存在才算 false、其他失败须显式报错」的语义一致。
	 */
	async exists(path: string): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	/** 创建目录；`recursive` 缺省为 true（与接口默认值一致）。 */
	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 删除文件或目录；`recursive` 与 `force` 缺省均为 false（与接口默认值一致）。 */
	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	/** 在系统临时目录（os.tmpdir()）下创建唯一命名的临时目录，返回其绝对路径。 */
	async createTempDir(prefix: string = "tmp-"): Promise<Result<string, FileError>> {
		try {
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	/**
	 * 创建临时文件并返回绝对路径：先建一个临时目录，
	 * 再在其中以 `prefix + randomUUID + suffix` 命名创建空文件。
	 */
	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-");
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	/**
	 * 释放资源：kill 所有仍在运行的子进程树并清空追踪集合。
	 * 尽力而为，绝不抛异常（接口契约）。
	 */
	async cleanup(): Promise<void> {
		for (const pid of this.activeChildPids) killProcessTree(pid);
		this.activeChildPids.clear();
	}
}
