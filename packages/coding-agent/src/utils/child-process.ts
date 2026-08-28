/**
 * @file child-process.ts —— 子进程辅助（跨平台 spawn 封装 + 退出等待）
 *
 * @description
 * - spawnProcess / spawnProcessSync：跨平台启动子进程。Windows 上交给
 *   cross-spawn（正确解析 .cmd/.bat、PATHEXT 等），其余平台直接用 node 内置实现；
 * - waitForChildProcess：等待子进程终止并拿到退出码，同时保证不丢尾部输出、
 *   也不被继承 stdio 句柄的后代进程挂住。
 *
 * 依赖关系：
 * - `node:child_process` / `node:stream`：内置 spawn 与流类型；
 * - `cross-spawn`：仅 Windows 路径下的兼容层。
 */
import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

// 进程 exit 之后等待 stdio 管道空闲的宽限期（毫秒）
const EXIT_STDIO_GRACE_MS = 100;

/**
 * 跨平台 spawn：Windows 上用 cross-spawn（处理 .cmd/.bat 与 PATH 扩展名解析），
 * 其余平台等价于 node:child_process 的 spawn。带 stdio 元组类型的重载
 * 让调用方拿到正确类型的 stdout/stderr 流。
 */
export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

/** 跨平台同步 spawn：Windows 走 cross-spawn.sync，其余平台等价于 spawnSync */
export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * 等待子进程终止，同时避免被继承的 stdio 句柄挂住。
 *
 * 短命子进程可能已经 `exit`，但它分离的后代仍握着 stdout/stderr 管道。
 * 不能在 `exit` 后按固定期限 resolve 并销毁流，否则超过期限仍在写入的
 * 输出会被静默丢弃（earendil-works/pi#5303）。改为在 `exit` 之后等待管道
 * 进入空闲：每收到一个数据块就重置宽限计时器——仍在积极写入的后代会让
 * 我们持续读取，而安静的继承句柄（例如 Windows 上守护进程化的后代，
 * 永远不触发 `close`）也会在宽限期结束后放行。
 *
 * @param child - 待等待的子进程（stdout/stderr 需为管道）
 * @returns 进程退出码；spawn 本身失败时 reject
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		// 状态：是否已 settle（resolve/reject 完成）、是否已 exit、退出码、
		// exit 后的宽限计时器、两条输出流是否已结束（无管道的流一开始就算结束）
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		/** 清掉计时器并摘除全部监听器（stdout/stderr 可能为 null，用可选链） */
		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		/** 唯一成功出口：销毁输出流并 resolve 退出码 */
		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		/** 已 exit 且两条流都已 end 时才能收尾（理想路径：close 之前的正常收束） */
		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		/** （重新）武装空闲计时器：到期仍无新数据就按退出码收尾 */
		const armIdleTimer = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
		};

		const onData = () => {
			// exit 之后仍有输出到达：推迟收尾，避免在写入中途
			// 销毁流而截断尾部输出。
			if (exited && !settled) armIdleTimer();
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		/** spawn 失败（找不到命令等）：直接 reject */
		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			// 流可能先于/晚于 exit 结束，两条都已结束则立即收尾
			maybeFinalizeAfterExit();
			if (!settled) {
				// 还有流未结束：武装宽限计时器等待其空闲或 close
				armIdleTimer();
			}
		};

		const onClose = (code: number | null) => {
			// close = exit 且 stdio 全部关闭，是最可靠的完成信号
			finalize(code);
		};

		// 最后统一挂载监听：流事件与进程事件都就位后 Promise 才开始等待
		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
