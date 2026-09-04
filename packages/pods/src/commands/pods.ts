/**
 * @file pods.ts
 * @description pods 子命令 —— GPU Pod 的初始化配置、切换与删除管理
 * @module pi-pods
 *
 * 主要功能：
 * - setupPod：远程初始化新 Pod（校验环境变量、上传并执行 pod_setup.sh、解析 GPU 清单），并将结果写入本地配置
 * - listPods：列出本地配置中的所有 Pod 及其 GPU / vLLM 版本信息
 * - switchActivePod：切换当前活跃的 Pod
 * - removePodCommand：从本地配置中删除指定 Pod（不影响远端机器）
 */
import chalk from "chalk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addPod, loadConfig, removePod, setActivePod } from "../config.js";
import { scpFile, sshExec, sshExecStream } from "../ssh.js";
import type { GPU, Pod } from "../types.js";

// ESM 环境下没有 CommonJS 的 __filename/__dirname，
// 这里基于 import.meta.url 手工模拟，用于定位仓库内的 scripts/pod_setup.sh
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 列出本地配置中的所有 Pod
 *
 * 读取 ~/.pi/pods.json，逐行展示每个 Pod 的：
 * - 是否为当前活跃 Pod（绿色 * 标记）
 * - GPU 数量与型号、vLLM 版本、SSH 连接命令
 * - 模型存储路径（已配置时额外显示）
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
		const isActive = config.active === name;
		// 活跃 Pod 前显示绿色 *，非活跃显示空格以保持对齐
		const marker = isActive ? chalk.green("*") : " ";
		const gpuCount = pod.gpus?.length || 0;
		const gpuInfo = gpuCount > 0 ? `${gpuCount}x ${pod.gpus[0].name}` : "no GPUs detected";
		const vllmInfo = pod.vllmVersion ? ` (vLLM: ${pod.vllmVersion})` : "";
		console.log(`${marker} ${chalk.bold(name)} - ${gpuInfo}${vllmInfo} - ${pod.ssh}`);
		if (pod.modelsPath) {
			console.log(`    Models: ${pod.modelsPath}`);
		}
		// GPT-OSS 专用构建只能运行 GPT-OSS 系列模型，需要显式提醒用户
		if (pod.vllmVersion === "gpt-oss") {
			console.log(chalk.yellow(`    ⚠️  GPT-OSS build - only for GPT-OSS models`));
		}
	}
};

/**
 * 初始化一个新的 GPU Pod
 *
 * 整体流程：
 * 1. 校验环境变量：HF_TOKEN（HuggingFace 下载凭证）与 PI_API_KEY（vLLM API 密钥）
 * 2. 解析模型存储路径 modelsPath（可显式指定，或从 --mount 命令末尾提取）
 * 3. 测试 SSH 连接是否可用
 * 4. 通过 scp 上传 scripts/pod_setup.sh 到远端 /tmp
 * 5. 远程执行安装脚本：挂载存储、创建 venv、按 --vllm 选项安装对应版本 vLLM
 * 6. 通过 nvidia-smi 解析远端 GPU 清单
 * 7. 组装 Pod 配置并调用 addPod() 写入本地配置文件
 *
 * @param name Pod 名称（本地配置中的唯一标识）
 * @param sshCmd SSH 连接命令，如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4"
 * @param options 可选参数：mount（远端挂载命令）、modelsPath（模型存储路径）、vllm（vLLM 版本）
 */
export const setupPod = async (
	name: string,
	sshCmd: string,
	options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" },
) => {
	// ========== 环境变量校验 ==========
	// HF_TOKEN：HuggingFace 访问凭证，远端下载模型权重时必需，缺失会导致后续模型部署失败
	const hfToken = process.env.HF_TOKEN;
	// PI_API_KEY：vLLM 服务使用的 API 密钥，稍后会随安装脚本写入远端 .bashrc 供模型服务鉴权
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

	// 确定模型存储路径
	let modelsPath = options.modelsPath;
	if (!modelsPath && options.mount) {
		// 未显式指定 modelsPath 时，从 mount 命令中提取挂载点路径
		// 例如 "mount -t nfs ... /mnt/sfs" -> "/mnt/sfs"（取最后一个空格后的参数）
		const parts = options.mount.split(" ");
		modelsPath = parts[parts.length - 1];
	}

	if (!modelsPath) {
		console.error(chalk.red("ERROR: --models-path is required (or must be extractable from --mount)"));
		process.exit(1);
	}

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

	// ========== SSH 连接测试 ==========
	// 先远程执行一次简单的 echo 命令验证连通性，尽早暴露 SSH 配置错误
	console.log("Testing SSH connection...");
	const testResult = await sshExec(sshCmd, "echo 'SSH OK'");
	if (testResult.exitCode !== 0) {
		console.error(chalk.red("Failed to connect via SSH"));
		console.error(testResult.stderr);
		process.exit(1);
	}
	console.log(chalk.green("✓ SSH connection successful"));

	// ========== 上传安装脚本 ==========
	// 通过 scp 将仓库内置的 pod_setup.sh 上传到远端 /tmp 目录
	console.log("Copying setup script...");
	const scriptPath = join(__dirname, "../../scripts/pod_setup.sh");
	const success = await scpFile(sshCmd, scriptPath, "/tmp/pod_setup.sh");
	if (!success) {
		console.error(chalk.red("Failed to copy setup script"));
		process.exit(1);
	}
	console.log(chalk.green("✓ Setup script copied"));

	// ========== 远程安装 ==========
	// 拼接远程安装命令：把 modelsPath、HF_TOKEN、PI_API_KEY 等作为参数传给 pod_setup.sh
	let setupCmd = `bash /tmp/pod_setup.sh --models-path '${modelsPath}' --hf-token '${hfToken}' --vllm-api-key '${vllmApiKey}'`;
	if (options.mount) {
		setupCmd += ` --mount '${options.mount}'`;
	}
	// 追加 vLLM 版本参数：release（默认）/ nightly / gpt-oss（GPT-OSS 专用特殊构建）
	const vllmVersion = options.vllm || "release";
	setupCmd += ` --vllm '${vllmVersion}'`;

	// 远程执行安装脚本：安装系统依赖与 CUDA、创建 venv、按版本安装 vLLM、挂载存储等，约需 2-5 分钟
	console.log("");
	console.log(chalk.yellow("Running setup (this will take 2-5 minutes)..."));
	console.log("");

	// 使用 forceTTY 为远程命令分配伪终端，保留 apt、pip 等工具输出的彩色与进度条
	const exitCode = await sshExecStream(sshCmd, setupCmd, { forceTTY: true });
	if (exitCode !== 0) {
		console.error(chalk.red("\nSetup failed. Check the output above for errors."));
		process.exit(1);
	}

	// ========== GPU 信息解析 ==========
	// 直接在远端执行 nvidia-smi，以无表头的 CSV 格式逐行查询每块 GPU 的序号、型号和总显存
	console.log("");
	console.log("Detecting GPU configuration...");
	const gpuResult = await sshExec(sshCmd, "nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader");

	const gpus: GPU[] = [];
	if (gpuResult.exitCode === 0 && gpuResult.stdout) {
		const lines = gpuResult.stdout.trim().split("\n");
		for (const line of lines) {
			// 每行形如 "0, NVIDIA A100, 81920 MiB"，按逗号拆分并去除多余空白
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

	// ========== 保存配置 ==========
	// 组装 Pod 配置并写入本地 pods.json；addPod 在当前没有活跃 Pod 时会自动将其设为活跃
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
 * 切换当前活跃的 Pod
 *
 * 活跃 Pod 是后续命令（如 pi start）的默认操作对象。
 * 若指定名称不存在，则先列出所有可用 Pod 再退出。
 *
 * @param name 目标 Pod 名称
 */
export const switchActivePod = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
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
 * 从本地配置中删除指定 Pod
 *
 * 仅删除本地 pods.json 中的配置项，远端 Pod 机器本身不受影响。
 *
 * @param name 要删除的 Pod 名称
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
