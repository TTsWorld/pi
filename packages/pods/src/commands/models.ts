/**
 * @file models.ts
 * @description pod 包的模型部署编排核心模块：负责在远程 GPU pod 上部署和管理 vLLM 模型服务。
 *
 * 主要功能：
 * - startModel：模型部署主流程——按 GPU 数量/型号匹配最优配置选卡（最少使用优先）、
 *   从 8001 起分配端口、模板替换 model_run.sh、setsid 后台启动 vLLM、
 *   tail -f 日志监控直到就绪或 OOM、失败自动回滚（从配置中移除）
 * - stopModel / stopAllModels：停止单个/全部模型并清理配置
 * - listModels：列出已部署模型并逐一验证进程存活与 vLLM 健康状态
 * - viewLogs：实时流式查看模型日志（tail -f）
 * - showKnownModels：展示内置模型目录及其硬件需求，按当前 pod 兼容性分组
 *
 * 依赖关系：
 * - ../config.js：读写 pi 全局配置（pod 列表、已部署模型、活跃 pod）
 * - ../model-configs.js：内置模型配置查询（按 GPU 数量/型号匹配启动参数）
 * - ../ssh.js：通过 SSH 在远程 pod 上执行命令
 * - ../types.js：Pod / 模型记录等类型定义
 * - ../../scripts/model_run.sh：远程启动脚本模板（占位符替换）
 * - ../models.json：内置模型目录（showKnownModels 读取展示）
 */
import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { getActivePod, loadConfig, saveConfig } from "../config.js";
import { getModelConfig, getModelName, isKnownModel } from "../model-configs.js";
import { sshExec } from "../ssh.js";
import type { Pod } from "../types.js";

/**
 * 获取要使用的 pod（优先使用显式指定的名称，否则回退到活跃 pod）
 *
 * @param podOverride 可选的 pod 名称，用于覆盖当前活跃 pod
 * @returns pod 名称与对应配置的组合
 */
const getPod = (podOverride?: string): { name: string; pod: Pod } => {
	if (podOverride) {
		// ========== 显式指定 pod：从配置中查找 ==========
		const config = loadConfig();
		const pod = config.pods[podOverride];
		if (!pod) {
			console.error(chalk.red(`Pod '${podOverride}' not found`));
			process.exit(1);
		}
		return { name: podOverride, pod };
	}

	// ========== 未指定：回退到活跃 pod ==========
	const active = getActivePod();
	if (!active) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}
	return active;
};

/**
 * 从 8001 起查找下一个可用端口
 *
 * 端口分配规则：从 8001 开始逐个递增，跳过已被现有模型占用的端口，
 * 找到第一个空闲端口返回。
 *
 * @param pod 目标 pod 配置（从其已部署模型中收集占用端口）
 * @returns 第一个未占用的端口号
 */
const getNextPort = (pod: Pod): number => {
	const usedPorts = Object.values(pod.models).map((m) => m.port);
	let port = 8001;
	while (usedPorts.includes(port)) {
		port++;
	}
	return port;
};

/**
 * 为模型部署选择 GPU（最少使用优先策略）
 *
 * 选卡策略：
 * - 若请求数量恰好等于 pod 的 GPU 总数，直接使用全部 GPU；
 * - 否则统计每块 GPU 被现有模型引用的次数，按使用次数升序排序，
 *   返回使用最少的 count 块 GPU（尽量让负载在卡间均匀分布）。
 *
 * @param pod 目标 pod 配置（含 GPU 列表与已部署模型）
 * @param count 需要的 GPU 数量，默认 1
 * @returns 选中的 GPU 编号数组
 */
const selectGPUs = (pod: Pod, count: number = 1): number[] => {
	if (count === pod.gpus.length) {
		// 使用全部 GPU
		return pod.gpus.map((g) => g.id);
	}

	// ========== 统计所有模型对各块 GPU 的占用次数 ==========
	// 先将每块 GPU 的初始使用计数置为 0（保证无模型时也能参与排序）
	const gpuUsage = new Map<number, number>();
	for (const gpu of pod.gpus) {
		gpuUsage.set(gpu.id, 0);
	}

	for (const model of Object.values(pod.models)) {
		for (const gpuId of model.gpu) {
			gpuUsage.set(gpuId, (gpuUsage.get(gpuId) || 0) + 1);
		}
	}

	// ========== 按使用次数升序排序（最少使用的排最前） ==========
	const sortedGPUs = Array.from(gpuUsage.entries())
		.sort((a, b) => a[1] - b[1])
		.map((entry) => entry[0]);

	// 返回使用最少的前 count 块 GPU
	return sortedGPUs.slice(0, count);
};

/**
 * 启动一个模型（完整的部署编排流程）
 *
 * 编排流程概览：
 * 1. 校验前置条件（modelsPath 已配置、模型名不重复）
 * 2. 分配端口（从 8001 起的下一个可用端口）
 * 3. 解析 GPU 分配与 vLLM 启动参数（自定义参数 / 内置模型按卡数匹配 / 未知模型默认单卡）
 * 4. 应用 --memory / --context 覆盖项
 * 5. 读取并替换 model_run.sh 模板占位符，通过 SSH 上传到远程
 * 6. 生成 wrapper 脚本，用 setsid 后台启动（SSH 断开后仍存活）
 * 7. 将模型信息写入配置
 * 8. tail -f 实时监控日志，直到启动完成 / 失败 / 用户 Ctrl+C
 * 9. 失败时自动从配置中移除该模型（回滚），成功时输出连接信息
 *
 * @param modelId 模型标识（HF 模型 ID 或内置模型短名）
 * @param name 本地起的实例名称（用于日志文件、配置键等）
 * @param options 可选项：pod 名称、自定义 vLLM 参数、显存占比、上下文长度、GPU 数量
 */
export const startModel = async (
	modelId: string,
	name: string,
	options: {
		pod?: string;
		vllmArgs?: string[];
		memory?: string;
		context?: string;
		gpus?: number;
	},
) => {
	const { name: podName, pod } = getPod(options.pod);

	// ========== 第一步：前置校验 ==========
	if (!pod.modelsPath) {
		console.error(chalk.red("Pod does not have a models path configured"));
		process.exit(1);
	}
	if (pod.models[name]) {
		console.error(chalk.red(`Model '${name}' already exists on pod '${podName}'`));
		process.exit(1);
	}

	// ========== 第二步：分配端口 ==========
	const port = getNextPort(pod);

	// ========== 第三步：解析 GPU 分配与 vLLM 启动参数 ==========
	let gpus: number[] = [];
	let vllmArgs: string[] = [];
	let modelConfig = null;

	if (options.vllmArgs?.length) {
		// 自定义参数优先级最高，完全覆盖内置配置；GPU 由 vLLM 自行管理
		vllmArgs = options.vllmArgs;
		console.log(chalk.gray("Using custom vLLM args, GPU allocation managed by vLLM"));
	} else if (isKnownModel(modelId)) {
		// 内置模型：处理 --gpus 参数
		if (options.gpus) {
			// ========== 校验请求的 GPU 数量不超过 pod 实际数量 ==========
			if (options.gpus > pod.gpus.length) {
				console.error(chalk.red(`Error: Requested ${options.gpus} GPUs but pod only has ${pod.gpus.length}`));
				process.exit(1);
			}

			// 查找与请求 GPU 数量匹配的内置配置
			modelConfig = getModelConfig(modelId, pod.gpus, options.gpus);
			if (modelConfig) {
				// 找到匹配配置：按该卡数选卡，并复制配置中的启动参数
				gpus = selectGPUs(pod, options.gpus);
				vllmArgs = [...(modelConfig.args || [])];
			} else {
				// 没有对应卡数的配置：报错并列出所有可用卡数配置
				console.error(
					chalk.red(`Model '${getModelName(modelId)}' does not have a configuration for ${options.gpus} GPU(s)`),
				);
				console.error(chalk.yellow("Available configurations:"));

				// 展示可用的配置选项
				for (let gpuCount = 1; gpuCount <= pod.gpus.length; gpuCount++) {
					const config = getModelConfig(modelId, pod.gpus, gpuCount);
					if (config) {
						console.error(chalk.gray(`  - ${gpuCount} GPU(s)`));
					}
				}
				process.exit(1);
			}
		} else {
			// ========== 未指定卡数：从最多卡数向下尝试，找到当前硬件能跑的最优配置 ==========
			// 优先使用更多 GPU（吞吐更高），找不到再降级到更少 GPU 的配置
			for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
				modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
				if (modelConfig) {
					gpus = selectGPUs(pod, gpuCount);
					vllmArgs = [...(modelConfig.args || [])];
					break;
				}
			}
			if (!modelConfig) {
				console.error(chalk.red(`Model '${getModelName(modelId)}' not compatible with this pod's GPUs`));
				process.exit(1);
			}
		}
	} else {
		// 未知模型：不支持 --gpus（无内置配置可依据）
		if (options.gpus) {
			console.error(chalk.red("Error: --gpus can only be used with predefined models"));
			console.error(chalk.yellow("For custom models, use --vllm with tensor-parallel-size or similar arguments"));
			process.exit(1);
		}
		// 默认单卡部署
		gpus = selectGPUs(pod, 1);
		console.log(chalk.gray("Unknown model, defaulting to single GPU"));
	}

	// ========== 第四步：应用 --memory / --context 覆盖项 ==========
	// 注意：使用自定义 vLLM 参数时跳过（用户参数完全自理）
	if (!options.vllmArgs?.length) {
		if (options.memory) {
			// 将 "80%" 这类百分比转为 vLLM 的 0~1 小数，并替换原有的 gpu-memory-utilization 参数
			const fraction = parseFloat(options.memory.replace("%", "")) / 100;
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("gpu-memory-utilization"));
			vllmArgs.push("--gpu-memory-utilization", String(fraction));
		}
		if (options.context) {
			// 支持别名（4k/8k/...）或直接传数字；替换原有的 max-model-len 参数
			const contextSizes: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			const maxTokens = contextSizes[options.context.toLowerCase()] || parseInt(options.context);
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("max-model-len"));
			vllmArgs.push("--max-model-len", String(maxTokens));
		}
	}

	// ========== 第五步：打印部署计划 ==========
	console.log(chalk.green(`Starting model '${name}' on pod '${podName}'...`));
	console.log(`Model: ${modelId}`);
	console.log(`Port: ${port}`);
	console.log(`GPU(s): ${gpus.length ? gpus.join(", ") : "Managed by vLLM"}`);
	if (modelConfig?.notes) console.log(chalk.yellow(`Note: ${modelConfig.notes}`));
	console.log("");

	// ========== 第六步：读取 model_run.sh 模板并替换占位符 ==========
	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/model_run.sh");
	let scriptContent = readFileSync(scriptPath, "utf-8");

	// 替换占位符——heredoc 使用 'EOF'（带引号）时内容为字面量，无需转义
	scriptContent = scriptContent
		.replace("{{MODEL_ID}}", modelId)
		.replace("{{NAME}}", name)
		.replace("{{PORT}}", String(port))
		.replace("{{VLLM_ARGS}}", vllmArgs.join(" "));

	// 通过 SSH 上传定制后的脚本到远程 /tmp
	const result = await sshExec(
		pod.ssh,
		`cat > /tmp/model_run_${name}.sh << 'EOF'
${scriptContent}
EOF
chmod +x /tmp/model_run_${name}.sh`,
	);

	// ========== 第七步：构造远程环境变量 ==========
	// 单卡时通过 CUDA_VISIBLE_DEVICES 锁定到选中的 GPU；多卡交给 vLLM 的张量并行
	const env = [
		`HF_TOKEN='${process.env.HF_TOKEN}'`,
		`PI_API_KEY='${process.env.PI_API_KEY}'`,
		`HF_HUB_ENABLE_HF_TRANSFER=1`,
		`VLLM_NO_USAGE_STATS=1`,
		`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`,
		`FORCE_COLOR=1`,
		`TERM=xterm-256color`,
		...(gpus.length === 1 ? [`CUDA_VISIBLE_DEVICES=${gpus[0]}`] : []),
		...Object.entries(modelConfig?.env || {}).map(([k, v]) => `${k}='${v}'`),
	]
		.map((e) => `export ${e}`)
		.join("\n");

	// ========== 第八步：生成 wrapper 并通过 setsid 后台启动 ==========
	// 使用 script 命令模拟伪 TTY 以保留彩色输出，同时把输出写入日志文件
	// Note: 我们用 script 保留颜色并生成日志文件
	// setsid 创建新会话，使进程在 SSH 断开后依然存活
	const startCmd = `
		${env}
		mkdir -p ~/.vllm_logs
		# 创建一个用于监控 script 命令的 wrapper
		cat > /tmp/model_wrapper_${name}.sh << 'WRAPPER'
#!/bin/bash
script -q -f -c "/tmp/model_run_${name}.sh" ~/.vllm_logs/${name}.log
exit_code=$?
echo "Script exited with code $exit_code" >> ~/.vllm_logs/${name}.log
exit $exit_code
WRAPPER
		chmod +x /tmp/model_wrapper_${name}.sh
		setsid /tmp/model_wrapper_${name}.sh </dev/null >/dev/null 2>&1 &
		echo $!
		exit 0
	`;

	// 启动远程 wrapper，解析返回的后台进程 PID
	const pidResult = await sshExec(pod.ssh, startCmd);
	const pid = parseInt(pidResult.stdout.trim());
	if (!pid) {
		console.error(chalk.red("Failed to start model runner"));
		process.exit(1);
	}

	// ========== 第九步：将模型记录写入配置 ==========
	const config = loadConfig();
	config.pods[podName].models[name] = { model: modelId, port, gpu: gpus, pid };
	saveConfig(config);

	console.log(`Model runner started with PID: ${pid}`);
	console.log("Streaming logs... (waiting for startup)\n");

	// 稍作延迟，确保远程日志文件已创建
	await new Promise((resolve) => setTimeout(resolve, 500));

	// ========== 第十步：tail -f 实时监控日志 ==========
	// 解析 SSH 命令字符串（形如 "ssh root@host"）以便本地 spawn tail -f
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	const host = sshArgs[0].split("@")[1] || "localhost";
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	// 组装 spawn 用的完整参数数组
	const fullArgs = [...sshArgs, tailCmd];

	const logProcess = spawn(sshCommand, fullArgs, {
		stdio: ["inherit", "pipe", "pipe"], // 捕获 stdout 和 stderr
		env: { ...process.env, FORCE_COLOR: "1" },
	});

	let interrupted = false;
	let startupComplete = false;
	let startupFailed = false;
	let failureReason = "";

	// 处理 Ctrl+C：仅停止本地日志监控，不影响远程部署
	const sigintHandler = () => {
		interrupted = true;
		logProcess.kill();
	};
	process.on("SIGINT", sigintHandler);

	// 逐行处理日志输出：回显到控制台，并据此判定启动是否完成/失败
	const processOutput = (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			if (line) {
				console.log(line); // 回显日志行到控制台

				// 就绪判定：uvicorn 打印 "Application startup complete" 即认为服务可用
				if (line.includes("Application startup complete")) {
					startupComplete = true;
					logProcess.kill(); // 停止日志跟踪
				}

				// ========== 失败判定：匹配多种错误特征 ==========
				if (line.includes("Model runner exiting with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "Model runner failed to start";
					logProcess.kill();
				}
				if (line.includes("Script exited with code") && !line.includes("code 0")) {
					startupFailed = true;
					failureReason = "Script failed to execute";
					logProcess.kill();
				}
				if (line.includes("torch.OutOfMemoryError") || line.includes("CUDA out of memory")) {
					startupFailed = true;
					failureReason = "Out of GPU memory (OOM)";
					// 不立即 kill——让更多错误上下文先输出
				}
				if (line.includes("RuntimeError: Engine core initialization failed")) {
					startupFailed = true;
					failureReason = "vLLM engine initialization failed";
					logProcess.kill();
				}
			}
		}
	};

	logProcess.stdout?.on("data", processOutput);
	logProcess.stderr?.on("data", processOutput);

	// 等待 tail 进程退出（被 kill 或 SSH 断开）
	await new Promise<void>((resolve) => logProcess.on("exit", resolve));
	process.removeListener("SIGINT", sigintHandler);

	// ========== 第十一步：按监控结果输出（失败回滚 / 成功信息 / 中断 / 流结束） ==========
	if (startupFailed) {
		// 模型启动失败——清理配置并报告错误
		console.log("\n" + chalk.red(`✗ Model failed to start: ${failureReason}`));

		// 回滚：将失败的模型从配置中移除，避免留下"幽灵"记录
		const config = loadConfig();
		delete config.pods[podName].models[name];
		saveConfig(config);

		console.log(chalk.yellow("\nModel has been removed from configuration."));

		// 针对失败原因给出修复建议（主要是 OOM/显存类问题）
		if (failureReason.includes("OOM") || failureReason.includes("memory")) {
			console.log("\n" + chalk.bold("Suggestions:"));
			console.log("  • Try reducing GPU memory utilization: --memory 50%");
			console.log("  • Use a smaller context window: --context 4k");
			console.log("  • Use a quantized version of the model (e.g., FP8)");
			console.log("  • Use more GPUs with tensor parallelism");
			console.log("  • Try a smaller model variant");
		}

		console.log("\n" + chalk.cyan('Check full logs: pi ssh "tail -100 ~/.vllm_logs/' + name + '.log"'));
		process.exit(1);
	} else if (startupComplete) {
		// 模型启动成功——输出连接信息与使用示例
		console.log("\n" + chalk.green("✓ Model started successfully!"));
		console.log("\n" + chalk.bold("Connection Details:"));
		console.log(chalk.cyan("─".repeat(50)));
		console.log(chalk.white("Base URL:    ") + chalk.yellow(`http://${host}:${port}/v1`));
		console.log(chalk.white("Model:       ") + chalk.yellow(modelId));
		console.log(chalk.white("API Key:     ") + chalk.yellow(process.env.PI_API_KEY || "(not set)"));
		console.log(chalk.cyan("─".repeat(50)));

		console.log("\n" + chalk.bold("Export for shell:"));
		console.log(chalk.gray(`export OPENAI_BASE_URL="http://${host}:${port}/v1"`));
		console.log(chalk.gray(`export OPENAI_API_KEY="${process.env.PI_API_KEY || "your-api-key"}"`));
		console.log(chalk.gray(`export OPENAI_MODEL="${modelId}"`));

		console.log("\n" + chalk.bold("Example usage:"));
		console.log(
			chalk.gray(`
  # Python
  from openai import OpenAI
  client = OpenAI()  # Uses env vars
  response = client.chat.completions.create(
      model="${modelId}",
      messages=[{"role": "user", "content": "Hello!"}]
  )

  # CLI
  curl $OPENAI_BASE_URL/chat/completions \\
    -H "Authorization: Bearer $OPENAI_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hi"}]}'`),
		);
		console.log("");
		console.log(chalk.cyan(`Chat with model:  pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Interactive mode: pi agent ${name} -i`));
		console.log(chalk.cyan(`Monitor logs:     pi logs ${name}`));
		console.log(chalk.cyan(`Stop model:       pi stop ${name}`));
	} else if (interrupted) {
		// 用户 Ctrl+C 中断监控：远程部署仍在后台继续
		console.log(chalk.yellow("\n\nStopped monitoring. Model deployment continues in background."));
		console.log(chalk.cyan(`Chat with model: pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: pi logs ${name}`));
		console.log(chalk.cyan(`Stop model: pi stop ${name}`));
	} else {
		// 日志流意外结束但未观察到就绪或失败标志
		console.log(chalk.yellow("\n\nLog stream ended. Model may still be running."));
		console.log(chalk.cyan(`Chat with model: pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: pi logs ${name}`));
		console.log(chalk.cyan(`Stop model: pi stop ${name}`));
	}
};

/**
 * 停止一个模型
 *
 * 先通过 SSH 杀掉远程的 wrapper 进程及其全部子进程（vLLM），
 * 再从本地配置中移除该模型记录。
 *
 * @param name 模型实例名称
 * @param options 可选项：pod 名称
 */
export const stopModel = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.yellow(`Stopping model '${name}' on pod '${podName}'...`));

	// 杀掉 script 进程及其所有子进程
	// 使用 pkill 先杀子进程，再 kill 父进程，确保 vLLM 一并退出
	const killCmd = `
		# 杀掉 script 进程及其所有子进程
		pkill -TERM -P ${model.pid} 2>/dev/null || true
		kill ${model.pid} 2>/dev/null || true
	`;
	await sshExec(pod.ssh, killCmd);

	// 从配置中移除
	const config = loadConfig();
	delete config.pods[podName].models[name];
	saveConfig(config);

	console.log(chalk.green(`✓ Model '${name}' stopped`));
};

/**
 * 停止一个 pod 上的全部模型
 *
 * 一次性杀掉所有模型的 wrapper 进程及其子进程，然后清空该 pod 的模型配置。
 *
 * @param options 可选项：pod 名称
 */
export const stopAllModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	console.log(chalk.yellow(`Stopping ${modelNames.length} model(s) on pod '${podName}'...`));

	// 在远程用一个 for 循环批量杀掉所有 wrapper 进程及其子进程
	const pids = Object.values(pod.models).map((m) => m.pid);
	const killCmd = `
		for PID in ${pids.join(" ")}; do
			pkill -TERM -P $PID 2>/dev/null || true
			kill $PID 2>/dev/null || true
		done
	`;
	await sshExec(pod.ssh, killCmd);

	// 清空配置中的所有模型
	const config = loadConfig();
	config.pods[podName].models = {};
	saveConfig(config);

	console.log(chalk.green(`✓ Stopped all models: ${modelNames.join(", ")}`));
};

/**
 * 列出 pod 上的所有模型，并逐个验证运行状态
 *
 * 先展示每个模型的端口/GPU/PID/URL，再通过 SSH 检查：
 * wrapper 进程是否存在、vLLM /health 是否响应、日志中是否有崩溃特征。
 *
 * @param options 可选项：pod 名称
 */
export const listModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	// 从 SSH 命令中提取主机名，用于拼出访问 URL
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";

	console.log(`Models on pod '${chalk.bold(podName)}':`);
	for (const name of modelNames) {
		const model = pod.models[name];
		// GPU 显示：多卡显示列表，单卡显示编号，空则未知（如 vLLM 自管卡）
		const gpuStr =
			model.gpu.length > 1
				? `GPUs ${model.gpu.join(",")}`
				: model.gpu.length === 1
					? `GPU ${model.gpu[0]}`
					: "GPU unknown";
		console.log(`  ${chalk.green(name)} - Port ${model.port} - ${gpuStr} - PID ${model.pid}`);
		console.log(`    Model: ${chalk.gray(model.model)}`);
		console.log(`    URL: ${chalk.cyan(`http://${host}:${model.port}/v1`)}`);
	}

	// 可选：逐个验证远程进程是否仍在运行
	console.log("");
	console.log("Verifying processes...");
	let anyDead = false;
	for (const name of modelNames) {
		const model = pod.models[name];
		// 同时检查 wrapper 进程是否存在，以及 vLLM 是否正常响应
		// 状态判定顺序：进程不存在 → dead；/health 通过 → running；
		// 日志含错误特征 → crashed；否则 → starting（仍在启动中）
		const checkCmd = `
			# 检查 wrapper 进程是否存在
			if ps -p ${model.pid} > /dev/null 2>&1; then
				# 进程存在，再检查 vLLM 是否响应健康检查
				if curl -s -f http://localhost:${model.port}/health > /dev/null 2>&1; then
					echo "running"
				else
					# 检查是否仍在启动中
					if tail -n 20 ~/.vllm_logs/${name}.log 2>/dev/null | grep -q "ERROR\\|Failed\\|Cuda error\\|died"; then
						echo "crashed"
					else
						echo "starting"
					fi
				fi
			else
				echo "dead"
			fi
		`;
		const result = await sshExec(pod.ssh, checkCmd);
		const status = result.stdout.trim();
		if (status === "dead") {
			console.log(chalk.red(`  ${name}: Process ${model.pid} is not running`));
			anyDead = true;
		} else if (status === "crashed") {
			console.log(chalk.red(`  ${name}: vLLM crashed (check logs with 'pi logs ${name}')`));
			anyDead = true;
		} else if (status === "starting") {
			console.log(chalk.yellow(`  ${name}: Still starting up...`));
		}
	}

	if (anyDead) {
		console.log("");
		console.log(chalk.yellow("Some models are not running. Clean up with:"));
		console.log(chalk.cyan("  pi stop <name>"));
	} else {
		console.log(chalk.green("✓ All processes verified"));
	}
};

/**
 * 实时查看模型日志
 *
 * 通过 SSH 在远程执行 tail -f，以直通 stdio 的方式流式展示日志，
 * 保留颜色输出；Ctrl+C 结束查看。
 *
 * @param name 模型实例名称
 * @param options 可选项：pod 名称
 */
export const viewLogs = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.green(`Streaming logs for '${name}' on pod '${podName}'...`));
	console.log(chalk.gray("Press Ctrl+C to stop"));
	console.log("");

	// 流式输出日志并保留颜色
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	const logProcess = spawn(sshCommand, [...sshArgs, tailCmd], {
		stdio: "inherit",
		env: {
			...process.env,
			FORCE_COLOR: "1",
		},
	});

	// 等待进程退出
	await new Promise<void>((resolve) => {
		logProcess.on("exit", () => resolve());
	});
};

/**
 * 展示内置模型目录及其硬件需求
 *
 * 读取 models.json，若存在活跃 pod 则按其 GPU 数量/型号判断兼容性，
 * 将模型分为"兼容"（含匹配的配置）与"不兼容"（含最低硬件需求）两组，
 * 按模型家族分组展示。
 */
export const showKnownModels = async () => {
	const __filename = fileURLToPath(import.meta.url);
	const __dirname = dirname(__filename);
	const modelsJsonPath = join(__dirname, "..", "models.json");
	const modelsJson = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));
	const models = modelsJson.models;

	// 获取活跃 pod 信息（若已设置），用于过滤兼容模型
	const activePod = getActivePod();
	let podGpuCount = 0;
	let podGpuType = "";

	if (activePod) {
		podGpuCount = activePod.pod.gpus.length;
		// 从 GPU 名称中提取型号（例如 "NVIDIA H200" -> "H200"）
		podGpuType = activePod.pod.gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

		console.log(chalk.bold(`Known Models for ${activePod.name} (${podGpuCount}x ${podGpuType || "GPU"}):\n`));
	} else {
		console.log(chalk.bold("Known Models:\n"));
		console.log(chalk.yellow("No active pod. Use 'pi pods active <name>' to filter compatible models.\n"));
	}

	console.log("Usage: pi start <model> --name <name> [options]\n");

	// 按兼容性和模型家族分组
	const compatible: Record<string, Array<{ id: string; name: string; config: string; notes?: string }>> = {};
	const incompatible: Record<string, Array<{ id: string; name: string; minGpu: string; notes?: string }>> = {};

	for (const [modelId, info] of Object.entries(models)) {
		const modelInfo = info as any;
		// 家族取模型名的第一段（如 "qwen3-32b" -> "qwen3"），用于分组展示
		const family = modelInfo.name.split("-")[0] || "Other";

		let isCompatible = false;
		let compatibleConfig = "";
		let minGpu = "Unknown";
		let minNotes: string | undefined;

		if (modelInfo.configs && modelInfo.configs.length > 0) {
			// 按卡数升序排列配置，便于找到最低硬件需求
			const sortedConfigs = [...modelInfo.configs].sort((a: any, b: any) => (a.gpuCount || 1) - (b.gpuCount || 1));

			// 取卡数最少的配置作为最低硬件需求
			const minConfig = sortedConfigs[0];
			const minGpuCount = minConfig.gpuCount || 1;
			const gpuTypes = minConfig.gpuTypes?.join("/") || "H100/H200";

			if (minGpuCount === 1) {
				minGpu = `1x ${gpuTypes}`;
			} else {
				minGpu = `${minGpuCount}x ${gpuTypes}`;
			}

			minNotes = minConfig.notes || modelInfo.notes;

			// 检查与活跃 pod 的兼容性
			if (activePod && podGpuCount > 0) {
				// 在排序后的配置中找到当前 pod 能满足的最优匹配
				for (const config of sortedConfigs) {
					const configGpuCount = config.gpuCount || 1;
					const configGpuTypes = config.gpuTypes || [];

					// 先检查 GPU 数量是否足够
					if (configGpuCount <= podGpuCount) {
						// 再检查 GPU 型号是否匹配（配置未指定型号则视为匹配）
						if (
							configGpuTypes.length === 0 ||
							configGpuTypes.some((type: string) => podGpuType.includes(type) || type.includes(podGpuType))
						) {
							isCompatible = true;
							if (configGpuCount === 1) {
								compatibleConfig = `1x ${podGpuType}`;
							} else {
								compatibleConfig = `${configGpuCount}x ${podGpuType}`;
							}
							minNotes = config.notes || modelInfo.notes;
							break;
						}
					}
				}
			}
		}

		const modelEntry = {
			id: modelId,
			name: modelInfo.name,
			notes: minNotes,
		};

		// 有活跃 pod 且兼容 → 兼容组；否则归入不兼容组（附最低硬件需求）
		if (activePod && isCompatible) {
			if (!compatible[family]) {
				compatible[family] = [];
			}
			compatible[family].push({ ...modelEntry, config: compatibleConfig });
		} else {
			if (!incompatible[family]) {
				incompatible[family] = [];
			}
			incompatible[family].push({ ...modelEntry, minGpu });
		}
	}

	// 优先展示兼容模型
	if (activePod && Object.keys(compatible).length > 0) {
		console.log(chalk.green.bold("✓ Compatible Models:\n"));

		const sortedFamilies = Object.keys(compatible).sort();
		for (const family of sortedFamilies) {
			console.log(chalk.cyan(`${family} Models:`));

			const modelList = compatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				console.log(`  ${chalk.green(model.id)}`);
				console.log(`    Name: ${model.name}`);
				console.log(`    Config: ${model.config}`);
				if (model.notes) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				console.log("");
			}
		}
	}

	// 展示不兼容模型
	if (Object.keys(incompatible).length > 0) {
		if (activePod && Object.keys(compatible).length > 0) {
			console.log(chalk.red.bold("✗ Incompatible Models (need more/different GPUs):\n"));
		}

		const sortedFamilies = Object.keys(incompatible).sort();
		for (const family of sortedFamilies) {
			// 无活跃 pod 时以高亮展示（此时全部模型等同可见）；
			// 有活跃 pod 时以灰色弱化不兼容项
			if (!activePod) {
				console.log(chalk.cyan(`${family} Models:`));
			} else {
				console.log(chalk.gray(`${family} Models:`));
			}

			const modelList = incompatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				const color = activePod ? chalk.gray : chalk.green;
				console.log(`  ${color(model.id)}`);
				console.log(chalk.gray(`    Name: ${model.name}`));
				console.log(chalk.gray(`    Min Hardware: ${model.minGpu}`));
				if (model.notes && !activePod) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				if (activePod) {
					console.log(""); // 有过滤时对不兼容模型展示更简洁
				} else {
					console.log("");
				}
			}
		}
	}

	console.log(chalk.gray("\nFor unknown models, defaults to single GPU deployment."));
	console.log(chalk.gray("Use --vllm to pass custom arguments to vLLM."));
};
