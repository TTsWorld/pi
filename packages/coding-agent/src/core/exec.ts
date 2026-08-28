/**
 * @file exec.ts —— 子进程命令执行封装
 *
 * @description
 * 供扩展与自定义工具使用的通用命令执行工具：基于 spawn 拉起子进程，
 * 收集 stdout/stderr/退出码，支持 AbortSignal 取消与超时强制终止。
 * 依赖 ../utils/child-process.ts 的 waitForChildProcess 等待进程退出。
 */

import { spawn } from "node:child_process";
import { waitForChildProcess } from "../utils/child-process.ts";

/**
 * 执行 shell 命令的可选项。
 */
export interface ExecOptions {
	/** 用于取消命令的 AbortSignal */
	signal?: AbortSignal;
	/** 超时时间（毫秒） */
	timeout?: number;
	/** 工作目录 */
	cwd?: string;
}

/**
 * shell 命令的执行结果。
 * 无论正常退出还是被终止，都会给出可用的 code。
 */
export interface ExecResult {
	/** 标准输出内容 */
	stdout: string;
	/** 标准错误内容 */
	stderr: string;
	/** 子进程退出码（异常收场时为 1） */
	code: number;
	/** 是否被 abort / 超时触发的终止流程杀掉 */
	killed: boolean;
}

/**
 * 执行一个 shell 命令并返回 stdout/stderr/退出码。
 *
 * 内部以非 shell 模式 spawn 子进程（参数不经 shell 解释），
 * 支持 abort signal 与超时取消：先 SIGTERM，5 秒未退出再 SIGKILL。
 * 无论成败都以 resolve 收场（不会 reject），失败信息体现在 code 上。
 * NOTE: 输出会整体缓存在内存中，不适合超大输出的命令。
 *
 * @param command - 要执行的可执行文件路径或命令名
 * @param args - 命令行参数列表
 * @param cwd - 子进程工作目录
 * @param options - 可选的 signal / timeout / cwd
 * @returns 命令执行结果（stdout、stderr、退出码、是否被杀）
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	// 整体包装成 Promise：结果总以 resolve 返回，错误体现在 code 字段上
	return new Promise((resolve) => {
		// 以非 shell 模式拉起子进程，stdin 不接入，stdout/stderr 用管道收集
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// 收集输出与终止状态
		let stdout = "";
		let stderr = "";
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;

		// 终止子进程：先发 SIGTERM，超时未退出再强制 SIGKILL
		const killProcess = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// 若 SIGTERM 5 秒内未生效则强制击杀
				setTimeout(() => {
					if (!proc.killed) {
						proc.kill("SIGKILL");
					}
				}, 5000);
			}
		};

		// 处理 abort signal：已 abort 则立即杀，否则注册一次性监听
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// 处理超时：到点触发 killProcess
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		// 持续收集子进程输出
		proc.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		// 等待进程终止；不直接监听 exit，避免被分离的后代进程
		// 持有的继承式 stdio 句柄拖住导致挂起。
		waitForChildProcess(proc)
			.then((code) => {
				// 正常收场：清理定时器与 abort 监听后返回结果
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				// code 为 null（如被信号杀死）时归一为 0
				resolve({ stdout, stderr, code: code ?? 0, killed });
			})
			.catch((_err) => {
				// 等待失败（如 spawn 出错）：同样清理，并以 code=1 收场
				if (timeoutId) clearTimeout(timeoutId);
				if (options?.signal) {
					options.signal.removeEventListener("abort", killProcess);
				}
				resolve({ stdout, stderr, code: 1, killed });
			});
	});
}
