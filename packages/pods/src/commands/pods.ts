/**
 * @file pods.ts
 * @description pi pods 子命令的核心实现，负责 pod（远程 GPU 机器）的初始化与管理。
 *
 * 主要功能：
 * - listPods：列出本地配置中的所有 pod（含 GPU、vLLM 版本信息）
 * - setupPod：初始化新 pod，完整流程为：测试 SSH 连接 → scp 上传 pod_setup.sh →
 *   远程执行脚本安装 vLLM → 解析 nvidia-smi 输出获取 GPU 信息 → 写入本地配置
 * - switchActivePod：切换当前活跃的 pod
 * - removePodCommand：从本地配置中移除一个 pod
 *
 * 依赖关系：
 * - ../config.js：读写 pod 配置（loadConfig / addPod / removePod / setActivePod）
 * - ../ssh.js：SSH 远程执行与 scp 上传（sshExec / sshExecStream / scpFile）
 * - ../types.js：GPU、Pod 类型定义
 * - ../../scripts/pod_setup.sh：随包分发、由 setupPod 上传到远端执行的安装脚本
 */
import chalk from "chalk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addPod, loadConfig, removePod, setActivePod } from "../config.js";
import { scpFile, sshExec, sshExecStream } from "../ssh.js";
import type { GPU, Pod } from "../types.js";

// ESM 环境下没有 CommonJS 的 __dirname，这里通过 import.meta.url 手动模拟，
// 用于定位随包分发（相对于编译产物目录）的 scripts/pod_setup.sh
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 列出所有已配置的 pod
 *
 * 从本地配置读取 pod 列表并打印摘要：活跃 pod 用绿色 * 标记，
 * 同时展示 GPU 数量/型号、vLLM 版本与 SSH 连接信息。
 */
export const listPods = () => {
	const config = loadConfig();
	const podNames = Object.keys(config.pods);

	if (podNames.length === 0) {
		console.log("No pods configured. Use 'pi pods setup' to add a pod.");
		return;
	}

	console.log("Configured pods:");
	for (const name of podNames) {
		const pod = config.pods[name];
		// 活跃 pod 前面显示绿色 *，其余用空格占位保持对齐
		const isActive = config.active === name;
		const marker = isActive ? chalk.green("*") : " ";
		const gpuCount = pod.gpus?.length || 0;
		const gpuInfo = gpuCount > 0 ? `${gpuCount}x ${pod.gpus[0].name}` : "no GPUs detected";
		const vllmInfo = pod.vllmVersion ? ` (vLLM: ${pod.vllmVersion})` : "";
		console.log(`${marker} ${chalk.bold(name)} - ${gpuInfo}${vllmInfo} - ${pod.ssh}`);
		if (pod.modelsPath) {
			console.log(`    Models: ${pod.modelsPath}`);
		}
		if (pod.vllmVersion === "gpt-oss") {
			console.log(chalk.yellow(`    ⚠️  GPT-OSS build - only for GPT-OSS models`));
		}
	}
};

/**
 * 初始化（设置）一个新 pod
 *
 * 完整流程：校验环境变量 → 确定模型目录 → 测试 SSH 连接 → scp 上传安装脚本 →
 * 远程执行脚本安装 vLLM → 解析 nvidia-smi 输出识别 GPU → 保存 pod 配置并设为活跃。
 *
 * @param name - pod 名称（本地配置中的唯一标识）
 * @param sshCmd - SSH 连接命令（如 "ssh user@host"）
 * @param options - 可选项：mount（远端挂载命令）、modelsPath（模型目录路径）、
 *                  vllm（vLLM 版本：release / nightly / gpt-oss，默认 release）
 */
export const setupPod = async (
	name: string,
	sshCmd: string,
	options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" },
) => {
	// ========== 第一步：校验环境变量 ==========
	// HF_TOKEN 供远端从 HuggingFace 拉取模型，PI_API_KEY 是 vLLM 服务的 API 鉴权密钥；
	// 二者缺失时后续安装必然失败，因此尽早退出并给出获取方式
	const hfToken = process.env.HF_TOKEN;
	const vllmApiKey = process.env.PI_API_KEY;

	if (!hfToken) {
		console.error(chalk.red("ERROR: HF_TOKEN environment variable is required"));
		console.error("Get a token from: https://huggingface.co/settings/tokens");
		console.error("Then run: export HF_TOKEN=your_token_here");
		process.exit(1);
	}

	if (!vllmApiKey) {
		console.error(chalk.red("ERROR: PI_API_KEY environment variable is required"));
		console.error("Set an API key: export PI_API_KEY=your_api_key_here");
		process.exit(1);
	}

	// ========== 第二步：确定模型目录 ==========
	let modelsPath = options.modelsPath;
	if (!modelsPath && options.mount) {
		// 若未显式指定 modelsPath，则从 mount 命令中提取路径
		// 例如 "mount -t nfs ... /mnt/sfs" -> "/mnt/sfs"（取最后一个空格后的部分）
		const parts = options.mount.split(" ");
		modelsPath = parts[parts.length - 1];
	}

	if (!modelsPath) {
		console.error(chalk.red("ERROR: --models-path is required (or must be extractable from --mount)"));
		process.exit(1);
	}

	// 打印配置摘要，让用户在耗时安装开始前确认参数是否正确
	console.log(chalk.green(`Setting up pod '${name}'...`));
	console.log(`SSH: ${sshCmd}`);
	console.log(`Models path: ${modelsPath}`);
	console.log(
		`vLLM version: ${options.vllm || "release"} ${options.vllm === "gpt-oss" ? chalk.yellow("(GPT-OSS special build)") : ""}`,
	);
	if (options.mount) {
		console.log(`Mount command: ${options.mount}`);
	}
	console.log("");

	// ========== 第三步：测试 SSH 连接 ==========
	// 先用一条最简单的 echo 命令验证连通性，避免上传/安装等长耗时操作到一半才发现连不上
	console.log("Testing SSH connection...");
	const testResult = await sshExec(sshCmd, "echo 'SSH OK'");
	if (testResult.exitCode !== 0) {
		console.error(chalk.red("Failed to connect via SSH"));
		console.error(testResult.stderr);
		process.exit(1);
	}
	console.log(chalk.green("✓ SSH connection successful"));

	// ========== 第四步：上传安装脚本 ==========
	// pod_setup.sh 随 npm 包分发，位于编译产物目录的上级 scripts/ 目录，
	// 通过 scp 拷贝到远端 /tmp 供下一步执行
	console.log("Copying setup script...");
	const scriptPath = join(__dirname, "../../scripts/pod_setup.sh");
	const success = await scpFile(sshCmd, scriptPath, "/tmp/pod_setup.sh");
	if (!success) {
		console.error(chalk.red("Failed to copy setup script"));
		process.exit(1);
	}
	console.log(chalk.green("✓ Setup script copied"));

	// ========== 第五步：拼装远端安装命令 ==========
	// 将模型目录、HF_TOKEN、API key 等以命令行参数形式传给脚本；
	// 敏感信息只经 SSH 加密通道传输，不会出现在本地日志中
	let setupCmd = `bash /tmp/pod_setup.sh --models-path '${modelsPath}' --hf-token '${hfToken}' --vllm-api-key '${vllmApiKey}'`;
	if (options.mount) {
		setupCmd += ` --mount '${options.mount}'`;
	}
	// 追加 vLLM 版本参数（release / nightly / gpt-oss），未指定时默认 release
	const vllmVersion = options.vllm || "release";
	setupCmd += ` --vllm '${vllmVersion}'`;

	// ========== 第六步：远程执行安装脚本 ==========
	// 安装耗时约 2-5 分钟，使用流式输出（sshExecStream）让用户实时看到安装进度
	console.log("");
	console.log(chalk.yellow("Running setup (this will take 2-5 minutes)..."));
	console.log("");

	// forceTTY：强制分配伪终端，以保留 apt、pip 等工具的彩色输出
	const exitCode = await sshExecStream(sshCmd, setupCmd, { forceTTY: true });
	if (exitCode !== 0) {
		console.error(chalk.red("\nSetup failed. Check the output above for errors."));
		process.exit(1);
	}

	// ========== 第七步：解析 GPU 信息 ==========
	// 通过 nvidia-smi 的 CSV 格式输出逐行解析出每块 GPU 的序号、型号与显存，
	// 解析结果会存入配置，供后续部署模型时选择 GPU 使用
	console.log("");
	console.log("Detecting GPU configuration...");
	const gpuResult = await sshExec(sshCmd, "nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader");

	const gpus: GPU[] = [];
	if (gpuResult.exitCode === 0 && gpuResult.stdout) {
		const lines = gpuResult.stdout.trim().split("\n");
		for (const line of lines) {
			// 每行形如 "0, NVIDIA A100, 40960 MiB"，按逗号切分并去掉首尾空白
			const [id, name, memory] = line.split(",").map((s) => s.trim());
			if (id !== undefined) {
				gpus.push({
					id: parseInt(id),
					name: name || "Unknown",
					memory: memory || "Unknown",
				});
			}
		}
	}

	console.log(chalk.green(`✓ Detected ${gpus.length} GPU(s)`));
	for (const gpu of gpus) {
		console.log(`  GPU ${gpu.id}: ${gpu.name} (${gpu.memory})`);
	}

	// ========== 第八步：保存 pod 配置 ==========
	// addPod 内部会同时把该 pod 设为活跃 pod，因此下方提示 "set as active pod"
	const pod: Pod = {
		ssh: sshCmd,
		gpus,
		models: {},
		modelsPath,
		vllmVersion: options.vllm || "release",
	};

	addPod(name, pod);
	console.log("");
	console.log(chalk.green(`✓ Pod '${name}' setup complete and set as active pod`));
	console.log("");
	console.log("You can now deploy models with:");
	console.log(chalk.cyan(`  pi start <model> --name <name>`));
};

/**
 * 切换活跃 pod
 *
 * @param name - 目标 pod 名称；不存在时列出所有可用 pod 并退出
 */
export const switchActivePod = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
		// 打印所有可用 pod 名，帮助用户纠正拼写错误
		console.log("\nAvailable pods:");
		for (const podName of Object.keys(config.pods)) {
			console.log(`  ${podName}`);
		}
		process.exit(1);
	}

	setActivePod(name);
	console.log(chalk.green(`✓ Switched active pod to '${name}'`));
};

/**
 * 从本地配置中移除一个 pod
 *
 * @param name - 要移除的 pod 名称
 * NOTE: 仅删除本地配置记录，远端机器上已安装的环境不受影响
 */
export const removePodCommand = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
		process.exit(1);
	}

	removePod(name);
	console.log(chalk.green(`✓ Removed pod '${name}' from configuration`));
	console.log(chalk.yellow("Note: This only removes the local configuration. The remote pod is not affected."));
};
