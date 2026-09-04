/**
 * @file ssh.ts
 * @description SSH 远程执行原语 —— 基于 spawn 系统 ssh/scp 二进制，无 SSH 库依赖
 * @module pi-pods
 *
 * 主要功能：
 * - sshExec()：执行远程命令，收集 stdout/stderr/exitCode 后一次性返回
 * - sshExecStream()：流式执行远程命令，输出直接透传到当前控制台，支持伪 TTY 保色
 * - scpFile()：从 SSH 命令串解析 host/port，调用 scp 上传本地文件到远程主机
 *
 * 设计说明（Why）：
 * - 直接 spawn 系统 ssh/scp 二进制而非引入 ssh2 等 SSH 库：零依赖、无需实现协议栈，
 *   且天然复用用户的 ~/.ssh/config、密钥与 ssh-agent 配置
 * - 长时连接通过 ServerAliveInterval=30 / ServerAliveCountMax=120 保活，
 *   防止 NAT/防火墙因空闲切断连接导致长命令中途失败
 */

import { type SpawnOptions, spawn } from "child_process";

/** SSH 命令执行结果 */
export interface SSHResult {
	/** 标准输出全文 */
	stdout: string;
	/** 标准错误全文 */
	stderr: string;
	/** 退出码：0 表示成功 */
	exitCode: number;
}

/**
 * 执行 SSH 命令并收集完整结果（等待命令结束后一次性返回）
 *
 * 与 sshExecStream 的差异：本函数通过管道捕获 stdout/stderr 到字符串，
 * 不向控制台透传，适合需要程序化处理输出的场景
 *
 * @param sshCmd SSH 命令串（如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"），按空格拆分后作为 spawn 目标
 * @param command 要在远程主机上执行的命令，追加为最后一个参数
 * @param options.keepAlive 传入时追加 ServerAlive 保活参数（面向长时命令）
 * @returns Promise<SSHResult>：exitCode 为 0 表示成功；spawn 自身出错（如找不到 ssh 二进制）时 exitCode 为 1 且 stderr 为错误信息
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean },
): Promise<SSHResult> => {
	return new Promise((resolve) => {
		// 解析 SSH 命令串（如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"）：
		// 首段是 ssh 二进制名，其余是已有参数（用户@主机、端口等）
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];
		let sshArgs = [...sshParts.slice(1)];

		// 为长时命令追加 SSH 保活参数（前插，不覆盖用户已有参数）
		if (options?.keepAlive) {
			// ServerAliveInterval=30：每 30 秒向服务端发送一次 keepalive 探测
			// ServerAliveCountMax=120：允许最多 120 次探测失败（合计 60 分钟）后才判定断线
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		// 远程命令作为最后一个参数追加，其余均为 ssh 自身参数
		sshArgs.push(command);

		// stdin 忽略，stdout/stderr 走管道以便收集（与流式模式的 stdio: "inherit" 相反）
		const proc = spawn(sshBinary, sshArgs, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		// 持续累积子进程输出，直到进程结束
		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		// 进程结束：以结果对象 resolve（code 为 null，如被信号终止时，按 0 处理）
		proc.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code || 0,
			});
		});

		// spawn 自身失败（如 ssh 二进制不存在）：不 reject，统一以 exitCode=1 表达失败
		proc.on("error", (err) => {
			resolve({
				stdout,
				stderr: err.message,
				exitCode: 1,
			});
		});
	});
};

/**
 * 执行 SSH 命令并以流式方式将输出透传到当前进程控制台
 *
 * 与 sshExec 的差异：不捕获输出内容，子进程 stdio 直接继承当前进程
 * （stdio: "inherit"），适合交互式命令或需要实时展示的场景
 *
 * @param sshCmd SSH 命令串（如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"）
 * @param command 要在远程主机上执行的命令，追加为最后一个参数
 * @param options.silent 静默模式：丢弃所有输出（stdio 全部 ignore）
 * @param options.forceTTY 强制分配伪 TTY（-t），让远程程序以为连接的是真实终端，从而保留彩色输出
 * @param options.keepAlive 传入时追加 ServerAlive 保活参数（面向长时命令）
 * @returns Promise<number> 退出码：0 表示成功；spawn 自身出错时固定返回 1
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	return new Promise((resolve) => {
		// 解析 SSH 命令串：首段为 ssh 二进制名，其余为已有参数
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];

		// 在已有参数基础上组装 SSH 参数
		let sshArgs = [...sshParts.slice(1)];

		// 请求伪 TTY 时前插 -t（若命令串中已带 -t 则不重复添加）；
		// 远程程序检测到 TTY 后才会启用彩色/交互式输出
		if (options?.forceTTY && !sshParts.includes("-t")) {
			sshArgs = ["-t", ...sshArgs];
		}

		// 为长时命令追加 SSH 保活参数（前插，不覆盖用户已有参数）
		if (options?.keepAlive) {
			// ServerAliveInterval=30：每 30 秒向服务端发送一次 keepalive 探测
			// ServerAliveCountMax=120：允许最多 120 次探测失败（合计 60 分钟）后才判定断线
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		// 远程命令作为最后一个参数追加
		sshArgs.push(command);

		// 输出模式二选一：silent 时全部丢弃；否则 stdio 继承当前进程，
		// 子进程输出（含 ANSI 颜色）实时透传到用户终端
		const spawnOptions: SpawnOptions = options?.silent
			? { stdio: ["ignore", "ignore", "ignore"] }
			: { stdio: "inherit" };

		const proc = spawn(sshBinary, sshArgs, spawnOptions);

		// 进程结束：返回退出码（code 为 null 时按 0 处理）
		proc.on("close", (code) => {
			resolve(code || 0);
		});

		// spawn 自身失败：统一返回退出码 1
		proc.on("error", () => {
			resolve(1);
		});
	});
};

/**
 * 通过 SCP 将本地文件复制到远程主机
 *
 * 由于 scp 与 ssh 的端口参数大小写不同（ssh 用小写 -p，scp 用大写 -P），
 * 需要先从 SSH 命令串解析出 host 和 port，再单独拼接 scp 命令
 *
 * @param sshCmd SSH 命令串（如 "ssh -p 2222 root@1.2.3.4"），从中解析 host 与端口
 * @param localPath 本地文件路径
 * @param remotePath 远程目标路径
 * @returns Promise<boolean> 是否成功（host 解析成功且 scp 退出码为 0）
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	// 从 SSH 命令串解析 host 与 port
	const sshParts = sshCmd.split(" ").filter((p) => p);
	let host = "";
	let port = "22";
	let i = 1; // 跳过首段 'ssh'，从其参数开始扫描

	// 扫描参数段：-p 后跟端口号；首个非 "-" 开头的参数即目标主机（如 user@host）
	while (i < sshParts.length) {
		if (sshParts[i] === "-p" && i + 1 < sshParts.length) {
			port = sshParts[i + 1];
			i += 2;
		} else if (!sshParts[i].startsWith("-")) {
			host = sshParts[i];
			break;
		} else {
			i++;
		}
	}

	// 解析不到主机（如命令串只有选项没有 destination）则直接失败
	if (!host) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	// 组装 scp 命令：注意 scp 的端口是大写 -P（ssh 为小写 -p），目标格式为 host:remotePath
	const scpArgs = ["-P", port, localPath, `${host}:${remotePath}`];

	// spawn 系统 scp，传输进度等输出直接透传到控制台
	return new Promise((resolve) => {
		const proc = spawn("scp", scpArgs, { stdio: "inherit" });

		// 退出码 0 视为成功
		proc.on("close", (code) => {
			resolve(code === 0);
		});

		// spawn 自身失败（如 scp 不存在）：返回 false
		proc.on("error", () => {
			resolve(false);
		});
	});
};
