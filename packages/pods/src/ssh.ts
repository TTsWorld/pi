/**
 * @file pods 包的 SSH 命令行封装
 *
 * @description 对系统 ssh/scp 二进制的轻量 spawn 封装，提供三个能力：
 * - `sshExec`：执行远程命令并收集 stdout/stderr/退出码
 * - `sshExecStream`：执行远程命令并将输出直接流式透传到当前进程控制台（支持强制 TTY、保活）
 * - `scpFile`：通过 scp 把本地文件拷贝到远程主机
 *
 * 为什么不用 SSH 库（如 ssh2）而是 spawn 系统 ssh/scp：
 * - 零依赖：直接复用系统自带的 OpenSSH 客户端，避免引入庞大的原生/纯 JS SSH 协议实现
 * - 免配置：自动继承用户的 ~/.ssh/config（跳板机、别名、密钥、Agent 转发等），
 *   与用户在终端里的 ssh 行为完全一致，无需在代码里重复维护这些配置
 * - 认证天然打通：交互式输密码、密钥 passphrase、ssh-agent 等场景都由系统 ssh 处理，
 *   尤其在 stdio: "inherit" 模式下用户可以直接与远端交互
 */
import { type SpawnOptions, spawn } from "child_process";

/** sshExec 的执行结果 */
export interface SSHResult {
	/** 远程命令的标准输出 */
	stdout: string;
	/** 远程命令的标准错误输出 */
	stderr: string;
	/** 进程退出码（spawn 失败时为 1） */
	exitCode: number;
}

/**
 * 执行一条 SSH 远程命令，等待结束后收集全部输出并返回结果
 *
 * @param sshCmd SSH 命令前缀字符串，如 `"ssh root@1.2.3.4"` 或 `"ssh -p 22 root@1.2.3.4"`，
 *   会按空格拆分后作为 spawn 的命令与参数
 * @param command 要在远程主机上执行的实际命令
 * @param options.keepAlive 为长耗时命令追加 SSH keepalive 选项，防止连接被中间设备掐断
 * @returns Promise，resolve 为包含 stdout/stderr/exitCode 的 {@link SSHResult}；
 *   注意本函数不 reject，spawn 出错（如找不到 ssh 二进制）也会 resolve（exitCode 为 1，stderr 为错误信息）
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean },
): Promise<SSHResult> => {
	return new Promise((resolve) => {
		// 解析 SSH 命令（例如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"），
		// 拆出二进制名和已有参数，再在后面拼上真正要执行的命令
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];
		let sshArgs = [...sshParts.slice(1)];

		// 为长耗时命令追加 SSH keepalive 选项
		if (options?.keepAlive) {
			// ServerAliveInterval=30 每 30 秒发送一次 keepalive
			// ServerAliveCountMax=120 最多容忍 120 次失败（合计 60 分钟）
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		const proc = spawn(sshBinary, sshArgs, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		// 收集标准输出与标准错误的全部内容
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data) => {
			stdout += data.toString();
		});

		proc.stderr.on("data", (data) => {
			stderr += data.toString();
		});

		// 进程正常退出：返回收集到的输出与退出码（null 归一化为 0）
		proc.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code || 0,
			});
		});

		// spawn 层面出错（如二进制不存在）：不 reject，统一以 exitCode=1 的结果返回
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
 * 执行一条 SSH 远程命令，输出直接流式透传到当前进程（不做收集）
 *
 * 与 {@link sshExec} 不同，本函数默认 `stdio: "inherit"`，远程输出实时打到当前控制台，
 * 适合交互式命令（如 top、vim）或需要实时观察日志的长任务。
 *
 * @param sshCmd SSH 命令前缀字符串，如 `"ssh root@1.2.3.4"` 或 `"ssh -p 22 root@1.2.3.4"`
 * @param command 要在远程主机上执行的实际命令
 * @param options.silent 静默模式：忽略全部 stdio（stdin/stdout/stderr 均不透传）
 * @param options.forceTTY 强制分配 TTY（追加 `-t` 参数），远端程序会认为自己跑在终端里，
 *   从而支持交互并输出彩色/全屏内容；若命令串中已带 `-t` 则不重复添加
 * @param options.keepAlive 为长耗时命令追加 SSH keepalive 选项
 * @returns Promise，resolve 为进程退出码（spawn 出错时为 1）；本函数不 reject
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	return new Promise((resolve) => {
		const sshParts = sshCmd.split(" ").filter((p) => p);
		const sshBinary = sshParts[0];

		// 组装 SSH 参数
		let sshArgs = [...sshParts.slice(1)];

		// 需要强制 TTY 且原命令未包含 -t 时，在参数最前面追加 -t
		if (options?.forceTTY && !sshParts.includes("-t")) {
			sshArgs = ["-t", ...sshArgs];
		}

		// 为长耗时命令追加 SSH keepalive 选项
		if (options?.keepAlive) {
			// ServerAliveInterval=30 每 30 秒发送一次 keepalive
			// ServerAliveCountMax=120 最多容忍 120 次失败（合计 60 分钟）
			sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
		}

		sshArgs.push(command);

		// 静默模式：三个标准流全部忽略；默认：继承当前进程的标准流（实时透传、可交互）
		const spawnOptions: SpawnOptions = options?.silent
			? { stdio: ["ignore", "ignore", "ignore"] }
			: { stdio: "inherit" };

		const proc = spawn(sshBinary, sshArgs, spawnOptions);

		// 正常退出：返回退出码（null 归一化为 0）
		proc.on("close", (code) => {
			resolve(code || 0);
		});

		// spawn 层面出错：统一 resolve 为 1，不 reject
		proc.on("error", () => {
			resolve(1);
		});
	});
};

/**
 * 通过 scp 把本地文件复制到远程主机
 *
 * 由于 scp 不支持直接传 ssh 命令串，需要从 SSH 命令前缀中解析出主机名与端口
 * （scp 的端口参数是大写 `-P`，ssh 是小写 `-p`），再拼装 scp 命令。
 *
 * @param sshCmd SSH 命令前缀字符串，如 `"ssh root@1.2.3.4"` 或 `"ssh -p 2222 root@1.2.3.4"`
 * @param localPath 本地文件路径
 * @param remotePath 远程目标路径
 * @returns Promise，resolve 为是否成功（退出码为 0 且未发生 spawn 错误）；本函数不 reject
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	// 从 SSH 命令串中解析主机与端口
	const sshParts = sshCmd.split(" ").filter((p) => p);
	let host = "";
	let port = "22";
	let i = 1; // 跳过 'ssh' 本身

	// 遍历参数：识别 -p <port> 取端口，跳过其他 - 开头的选项，遇到第一个非选项参数即为主机
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

	// 解析不出主机时直接判定失败
	if (!host) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	// 组装 scp 命令（注意端口用大写 -P）
	const scpArgs = ["-P", port, localPath, `${host}:${remotePath}`];

	return new Promise((resolve) => {
		// 继承标准流，scp 的进度条等信息直接显示在当前终端
		const proc = spawn("scp", scpArgs, { stdio: "inherit" });

		proc.on("close", (code) => {
			resolve(code === 0);
		});

		proc.on("error", () => {
			resolve(false);
		});
	});
};
