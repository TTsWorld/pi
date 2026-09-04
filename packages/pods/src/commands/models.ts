/**
 * @file models.ts
 * @description models 子命令 —— vLLM 模型的远程启动/停止/列表/日志全生命周期管理
 * @module pi-pods
 *
 * 主要功能：
 * - startModel：在远程 pod 上启动 vLLM 模型服务（端口分配、GPU 选择、模板脚本上传、
 *   后台启动、日志跟踪直到 "Application startup complete"）
 * - stopModel / stopAllModels：停止单个/全部模型（pkill 终止进程树并清理配置）
 * - listModels：列出模型并逐一探测进程/健康检查，判定 running/starting/crashed/dead
 * - viewLogs：tail -f 实时查看模型日志
 * - showKnownModels：展示预置模型库及其硬件要求，按当前 pod 兼容性分组
 *
 * 依赖关系：
 * - ssh.ts：sshExec 在远程执行命令
 * - config.ts：loadConfig/saveConfig/getActivePod 读写 pods.json 配置
 * - model-configs.ts：getModelConfig/isKnownModel/getModelName 查询预置模型配置（models.json）
 * - scripts/model_run.sh：远程启动脚本模板，占位符在本模块内替换后上传
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
 * 获取要操作的目标 pod
 *
 * 优先级：显式传入的 podOverride 参数（--pod）> 配置中记录的 active pod。
 * 两者都取不到时打印错误并以退出码 1 终止进程。
 *
 * @param podOverride 可选的 pod 名称，用于覆盖 active pod
 * @returns pod 名称与 pod 配置对象的组合
 */
const getPod = (podOverride?: string): { name: string; pod: Pod } => {
	// 显式指定了 pod 名：直接从配置中查找，不存在则报错退出
	if (podOverride) {
		const config = loadConfig();
		const pod = config.pods[podOverride];
		if (!pod) {
			console.error(chalk.red(`Pod '${podOverride}' not found`));
			process.exit(1);
		}
		return { name: podOverride, pod };
	}

	// 未指定 pod 名：回落到配置中的 active pod
	const active = getActivePod();
	if (!active) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}
	return active;
};

/**
 * 从 8001 起始，找到当前未被任何模型占用的最小可用端口
 *
 * 端口占用情况只记录在 pods.json（pod.models[*].port）中：
 * 收集已占用端口后从 8001 开始线性递增探测，返回第一个空闲端口。
 * 注意：只检查本工具自己管理的模型，不探测远程机器上端口是否真的空闲。
 *
 * @param pod 目标 pod 配置
 * @returns 第一个可用端口号（8001、8002、8003 ...）
 */
const getNextPort = (pod: Pod): number => {
	// 收集该 pod 上所有已部署模型占用的端口
	const usedPorts = Object.values(pod.models).map((m) => m.port);
	let port = 8001; // 起始端口 8001（避开 vLLM 常用的默认端口 8000）
	while (usedPorts.includes(port)) {
		port++;
	}
	return port;
};

/**
 * 为模型部署挑选 count 个 GPU（最少使用优先策略）
 *
 * 统计 pods.json 中每个 GPU 已被多少个模型引用，把使用次数最少的排在前面，
 * 取前 count 个 —— 目的是让多个模型尽量分散到不同 GPU 上，避免显存扎堆。
 *
 * @param pod   目标 pod 配置（含 GPU 列表与已部署模型）
 * @param count 需要的 GPU 数量，默认 1
 * @returns 选中的 GPU id 数组
 */
const selectGPUs = (pod: Pod, count: number = 1): number[] => {
	// 恰好要用满全部 GPU：直接返回全部 id，无需再做负载均衡
	if (count === pod.gpus.length) {
		return pod.gpus.map((g) => g.id);
	}

	// 统计每个 GPU 被已部署模型引用的次数（先把所有 GPU 初始化为 0 次）
	const gpuUsage = new Map<number, number>();
	for (const gpu of pod.gpus) {
		gpuUsage.set(gpu.id, 0);
	}

	for (const model of Object.values(pod.models)) {
		for (const gpuId of model.gpu) {
			gpuUsage.set(gpuId, (gpuUsage.get(gpuId) || 0) + 1);
		}
	}

	// 按使用次数升序排序（最少使用的排最前）
	const sortedGPUs = Array.from(gpuUsage.entries())
		.sort((a, b) => a[1] - b[1])
		.map((entry) => entry[0]);

	// 取前 count 个即当前最少使用的 GPU
	return sortedGPUs.slice(0, count);
};

/**
 * 在远程 pod 上启动一个 vLLM 模型服务（本模块的核心流程）
 *
 * 整体流程：
 * 1. 解析目标 pod（--pod 覆盖或 active pod），校验 modelsPath 已配置且模型名未占用
 * 2. 端口分配：getNextPort 从 8001 起线性探测第一个空闲端口
 * 3. GPU/vLLM 参数三级优先决策：
 *    a. --vllm 自定义参数最高优先，GPU 完全交给 vLLM 自己管理；
 *    b. 预置模型（models.json 中已知）：--gpus 指定卡数时校验并取对应配置，
 *       未指定时从 pod 总卡数向下枚举，优先采用能用满硬件的最大配置；
 *    c. 未知模型：默认单卡部署（--gpus 仅对预置模型可用）
 * 4. --memory/--context 覆盖预置参数中的 --gpu-memory-utilization/--max-model-len
 * 5. 读取 scripts/model_run.sh 模板，替换 {{MODEL_ID}}/{{NAME}}/{{PORT}}/{{VLLM_ARGS}}
 * 6. SSH 上传为 /tmp/model_run_<name>.sh，注入 env 后用 script 伪 TTY + setsid 后台启动
 * 7. 记录 wrapper 进程 PID 并写回 pods.json
 * 8. tail -f 远程日志直到出现 "Application startup complete"，随后打印连接信息
 *
 * @param modelId HuggingFace 模型 ID（也是 vLLM serve 的模型名）
 * @param name    本地给模型实例起的名字（用于 pods.json 记录、日志文件名、pi stop 等）
 * @param options 可选项：pod（目标 pod）、vllmArgs（自定义 vLLM 参数）、
 *                memory（显存占比%）、context（上下文长度档位）、gpus（GPU 卡数）
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

	// ========== 前置校验 ==========
	// 未配置模型存放路径（pod 未初始化完成）则拒绝启动
	if (!pod.modelsPath) {
		console.error(chalk.red("Pod does not have a models path configured"));
		process.exit(1);
	}
	// 同名模型已存在则拒绝，避免覆盖 pods.json 中已有记录
	if (pod.models[name]) {
		console.error(chalk.red(`Model '${name}' already exists on pod '${podName}'`));
		process.exit(1);
	}

	// ========== 端口分配 ==========
	const port = getNextPort(pod);

	// ========== GPU 与 vLLM 参数决策（三级优先） ==========
	let gpus: number[] = [];
	let vllmArgs: string[] = [];
	let modelConfig = null;

	// 优先级 1：--vllm 自定义参数，完全覆盖预置配置；此时用几张卡由 vLLM 参数
	// （如 tensor-parallel-size）自行决定，本地不做 GPU 分配
	if (options.vllmArgs?.length) {
		vllmArgs = options.vllmArgs;
		console.log(chalk.gray("Using custom vLLM args, GPU allocation managed by vLLM"));
	} else if (isKnownModel(modelId)) {
		// 优先级 2：预置模型（models.json 中有配置项）
		// 显式指定了 --gpus 卡数
		if (options.gpus) {
			// 请求卡数超过 pod 实际拥有的 GPU 数量，直接报错
			if (options.gpus > pod.gpus.length) {
				console.error(chalk.red(`Error: Requested ${options.gpus} GPUs but pod only has ${pod.gpus.length}`));
				process.exit(1);
			}

			// 按请求的卡数查找预置配置（getModelConfig 内部还会匹配 GPU 型号）
			modelConfig = getModelConfig(modelId, pod.gpus, options.gpus);
			if (modelConfig) {
				// 找到配置：本地选定 GPU 并复制预置的 vLLM 参数
				gpus = selectGPUs(pod, options.gpus);
				vllmArgs = [...(modelConfig.args || [])];
			} else {
				// 该卡数没有对应配置：报错并列出所有可用卡数，方便用户换参数重试
				console.error(
					chalk.red(`Model '${getModelName(modelId)}' does not have a configuration for ${options.gpus} GPU(s)`),
				);
				console.error(chalk.yellow("Available configurations:"));

				// 遍历 1..pod GPU 总数，逐个探测是否有可用配置并打印
				for (let gpuCount = 1; gpuCount <= pod.gpus.length; gpuCount++) {
					const config = getModelConfig(modelId, pod.gpus, gpuCount);
					if (config) {
						console.error(chalk.gray(`  - ${gpuCount} GPU(s)`));
					}
				}
				process.exit(1);
			}
		} else {
			// 未指定 --gpus：从 pod 总卡数向下枚举到 1，优先采用能用满硬件的最大配置
			for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
				modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
				if (modelConfig) {
					gpus = selectGPUs(pod, gpuCount);
					vllmArgs = [...(modelConfig.args || [])];
					break;
				}
			}
			// 所有卡数都找不到配置：说明该模型与当前 pod 的 GPU 型号/数量不兼容
			if (!modelConfig) {
				console.error(chalk.red(`Model '${getModelName(modelId)}' not compatible with this pod's GPUs`));
				process.exit(1);
			}
		}
	} else {
		// 优先级 3：未知模型 —— models.json 中没有配置项
		if (options.gpus) {
			// 未知模型没有多卡配置可查，--gpus 只对预置模型有意义
			console.error(chalk.red("Error: --gpus can only be used with predefined models"));
			console.error(chalk.yellow("For custom models, use --vllm with tensor-parallel-size or similar arguments"));
			process.exit(1);
		}
		// 默认按单卡部署（保守策略：不确定模型大小时只用一张卡）
		gpus = selectGPUs(pod, 1);
		console.log(chalk.gray("Unknown model, defaulting to single GPU"));
	}

	// ========== 显存/上下文长度覆盖 ==========
	// 仅在未使用 --vllm 自定义参数时生效：--vllm 模式下参数完全由用户掌控，不掺入覆盖
	if (!options.vllmArgs?.length) {
		// --memory "85%" -> 0.85，替换预置参数中的 --gpu-memory-utilization
		if (options.memory) {
			const fraction = parseFloat(options.memory.replace("%", "")) / 100;
			// 先过滤掉旧值再 push 新值，避免出现重复参数
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("gpu-memory-utilization"));
			vllmArgs.push("--gpu-memory-utilization", String(fraction));
		}
		// --context 支持档位简写（4k/8k/.../128k）或直接传 token 数字
		if (options.context) {
			const contextSizes: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			// 先查档位表，查不到再当作原始 token 数解析
			const maxTokens = contextSizes[options.context.toLowerCase()] || parseInt(options.context);
			vllmArgs = vllmArgs.filter((arg) => !arg.includes("max-model-len"));
			vllmArgs.push("--max-model-len", String(maxTokens));
		}
	}

	// ========== 启动信息展示 ==========
	console.log(chalk.green(`Starting model '${name}' on pod '${podName}'...`));
	console.log(`Model: ${modelId}`);
	console.log(`Port: ${port}`);
	// gpus 为空数组说明是 --vllm 自定义参数模式（卡数由 vLLM 自行管理）
	console.log(`GPU(s): ${gpus.length ? gpus.join(", ") : "Managed by vLLM"}`);
	if (modelConfig?.notes) console.log(chalk.yellow(`Note: ${modelConfig.notes}`));
	console.log("");

	// ========== 读取并定制模板脚本 ==========
	// 模板随 npm 包发布在编译产物目录的 ../../scripts/model_run.sh
	const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/model_run.sh");
	let scriptContent = readFileSync(scriptPath, "utf-8");

	// 替换模板占位符 —— 无需转义：上传时用的 heredoc 以带引号的 'EOF' 结尾，内容按字面量写入
	scriptContent = scriptContent
		.replace("{{MODEL_ID}}", modelId)
		.replace("{{NAME}}", name)
		.replace("{{PORT}}", String(port))
		.replace("{{VLLM_ARGS}}", vllmArgs.join(" "));

	// ========== 上传脚本到远程 ==========
	// 通过 SSH heredoc 把定制后的脚本写入远程 /tmp/model_run_<name>.sh 并赋予执行权限
	const result = await sshExec(
		pod.ssh,
		`cat > /tmp/model_run_${name}.sh << 'EOF'
${scriptContent}
EOF
chmod +x /tmp/model_run_${name}.sh`,
	);

	// ========== 准备环境变量 ==========
	const env = [
		`HF_TOKEN='${process.env.HF_TOKEN}'`,
		`PI_API_KEY='${process.env.PI_API_KEY}'`,
		`HF_HUB_ENABLE_HF_TRANSFER=1`,
		`VLLM_NO_USAGE_STATS=1`,
		`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`,
		`FORCE_COLOR=1`,
		`TERM=xterm-256color`,
		// 仅单卡部署时才设置 CUDA_VISIBLE_DEVICES 做物理卡隔离；
		// 多卡场景不设置，卡数切分交给 vLLM 的 tensor-parallel-size 参数
		...(gpus.length === 1 ? [`CUDA_VISIBLE_DEVICES=${gpus[0]}`] : []),
		// 预置模型配置中声明的额外 env（models.json 的 configs[].env）
		...Object.entries(modelConfig?.env || {}).map(([k, v]) => `${k}='${v}'`),
	]
		.map((e) => `export ${e}`)
		.join("\n");

	// ========== 后台启动模型运行器 ==========
	// 远程实际执行的是 wrapper 脚本（见下方 heredoc），其中：
	// - `script` 命令包一层伪 TTY：让 vLLM/HF CLI 认为自己接在终端上，
	//   从而保留彩色输出，同时把全部输出落到日志文件 ~/.vllm_logs/<name>.log
	// - wrapper 记录 script 的退出码并追加写进日志，便于事后诊断
	// - `setsid` 让 wrapper 新建独立 session、脱离当前 SSH 会话：
	//   SSH 断开时不会收到 SIGHUP，模型得以在远程后台常驻
	// - `echo $!` 输出后台任务 PID 供本地记录；exit 0 保证 sshExec 正常返回
	const startCmd = `
		${env}
		mkdir -p ~/.vllm_logs
		# Create a wrapper that monitors the script command
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

	const pidResult = await sshExec(pod.ssh, startCmd);
	// 解析远程回显的 wrapper 进程 PID；解析失败（NaN -> falsy）说明启动命令未正常执行
	const pid = parseInt(pidResult.stdout.trim());
	if (!pid) {
		console.error(chalk.red("Failed to start model runner"));
		process.exit(1);
	}

	// ========== PID 记录与配置写回 ==========
	// 把模型记录（模型 ID/端口/GPU/PID）写入 pods.json，
	// 后续的 stop/list/logs 全靠这份记录定位远程进程与 URL
	const config = loadConfig();
	config.pods[podName].models[name] = { model: modelId, port, gpu: gpus, pid };
	saveConfig(config);

	console.log(`Model runner started with PID: ${pid}`);
	console.log("Streaming logs... (waiting for startup)\n");

	// 短暂等待，确保远程日志文件已被 script 命令创建，避免 tail -f 立刻报文件不存在
	await new Promise((resolve) => setTimeout(resolve, 500));

	// ========== 健康等待：跟踪远程日志直到启动完成 ==========
	// 这里不走 sshExec，而是直接 spawn 一个 ssh tail -f，以便逐行拿到实时输出
	const sshParts = pod.ssh.split(" ");
	const sshCommand = sshParts[0]; // "ssh"
	const sshArgs = sshParts.slice(1); // ["root@86.38.238.55"]
	// 从 user@host 中截取 host 部分，用于拼接最终展示的连接 URL
	const host = sshArgs[0].split("@")[1] || "localhost";
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;

	// 拼出完整的 spawn 参数：[...ssh 参数, 远程命令]
	const fullArgs = [...sshArgs, tailCmd];

	const logProcess = spawn(sshCommand, fullArgs, {
		stdio: ["inherit", "pipe", "pipe"], // 捕获 stdout 和 stderr（stdin 直连即可）
		env: { ...process.env, FORCE_COLOR: "1" },
	});

	let interrupted = false; // 用户是否按了 Ctrl+C 主动退出日志跟踪
	let startupComplete = false; // 日志中是否已出现 vLLM 启动完成标志

	// 处理 Ctrl+C：只停止本地的日志跟踪，远程模型继续在后台部署
	const sigintHandler = () => {
		interrupted = true;
		logProcess.kill();
	};
	process.on("SIGINT", sigintHandler);

	// 逐行处理日志输出：回显到控制台，并探测启动完成标志
	const processOutput = (data: Buffer) => {
		const lines = data.toString().split("\n");
		for (const line of lines) {
			if (line) {
				console.log(line); // 原样回显该行日志

				// uvicorn/vLLM 就绪后打印的固定标志行：
				// 出现即认为服务已在该端口可用，结束日志跟踪
				if (line.includes("Application startup complete")) {
					startupComplete = true;
					logProcess.kill(); // 停止 tail，结束等待
				}
			}
		}
	};

	logProcess.stdout?.on("data", processOutput);
	logProcess.stderr?.on("data", processOutput);

	// 等 tail 进程退出（三种触发：启动完成 kill / Ctrl+C kill / SSH 连接断开）
	await new Promise<void>((resolve) => logProcess.on("exit", resolve));
	process.removeListener("SIGINT", sigintHandler);

	if (startupComplete) {
		// 场景一：启动成功 —— 打印连接信息（URL/API Key/环境变量导出/调用示例）
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
		// 场景二：用户 Ctrl+C 退出监控 —— 远程部署仍在后台继续
		console.log(chalk.yellow("\n\nStopped monitoring. Model deployment continues in background."));
		console.log(chalk.cyan(`Chat with model: pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: pi logs ${name}`));
		console.log(chalk.cyan(`Stop model: pi stop ${name}`));
	} else {
		// 场景三：日志流意外结束（如 SSH 断开）—— 无法确认状态，提示用户自行检查
		console.log(chalk.yellow("\n\nLog stream ended. Model may still be running."));
		console.log(chalk.cyan(`Chat with model: pi agent ${name} "Your message"`));
		console.log(chalk.cyan(`Check status: pi logs ${name}`));
		console.log(chalk.cyan(`Stop model: pi stop ${name}`));
	}
};

/**
 * 停止一个模型
 *
 * 通过 pkill -TERM -P 终止记录在 pods.json 中的 wrapper 进程（PID）及其全部
 * 子进程（script/vLLM 等），再从 pods.json 中删除该模型记录。
 *
 * @param name    模型实例名
 * @param options 可选 pod 覆盖
 */
export const stopModel = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.yellow(`Stopping model '${name}' on pod '${podName}'...`));

	// 终止 wrapper 进程及其全部子进程：
	// pkill -P 杀掉该 PID 的所有子进程（真正干活的 vLLM 在这里被终止），
	// 再 kill 掉 wrapper 本身；2>/dev/null || true 保证进程已不存在时不报错
	const killCmd = `
		# Kill the script process and all its children
		pkill -TERM -P ${model.pid} 2>/dev/null || true
		kill ${model.pid} 2>/dev/null || true
	`;
	await sshExec(pod.ssh, killCmd);

	// 从 pods.json 中移除该模型记录
	const config = loadConfig();
	delete config.pods[podName].models[name];
	saveConfig(config);

	console.log(chalk.green(`✓ Model '${name}' stopped`));
};

/**
 * 停止 pod 上的全部模型
 *
 * 收集 pods.json 中记录的所有 PID，在远程一次性循环终止（同 stopModel 的
 * pkill -TERM -P + kill 组合），然后清空该 pod 的模型记录。
 *
 * @param options 可选 pod 覆盖
 */
export const stopAllModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	console.log(chalk.yellow(`Stopping ${modelNames.length} model(s) on pod '${podName}'...`));

	// 收集全部 PID，在远程用 for 循环逐个终止 wrapper 及其子进程
	const pids = Object.values(pod.models).map((m) => m.pid);
	const killCmd = `
		for PID in ${pids.join(" ")}; do
			pkill -TERM -P $PID 2>/dev/null || true
			kill $PID 2>/dev/null || true
		done
	`;
	await sshExec(pod.ssh, killCmd);

	// 清空 pods.json 中该 pod 的所有模型记录
	const config = loadConfig();
	config.pods[podName].models = {};
	saveConfig(config);

	console.log(chalk.green(`✓ Stopped all models: ${modelNames.join(", ")}`));
};

/**
 * 列出 pod 上记录的全部模型，并逐一探测真实运行状态
 *
 * 先根据 pods.json 打印每个模型的端口/GPU/PID/URL，再通过 SSH 逐个探测。
 * 状态四分类（running / starting / crashed / dead）的判定依据：
 * - running：wrapper 进程存活 且 vLLM 的 /health 接口返回成功
 * - crashed：进程存活但 /health 不通，且最近日志中出现 ERROR/Failed/Cuda error/died
 * - starting：进程存活、/health 不通、日志中也没有错误（仍在加载模型权重）
 * - dead：wrapper 进程（PID）已不存在
 *
 * @param options 可选 pod 覆盖
 */
export const listModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	// 从 SSH 命令里解析 host，用于展示各模型的访问 URL
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";

	console.log(`Models on pod '${chalk.bold(podName)}':`);
	for (const name of modelNames) {
		const model = pod.models[name];
		// 依据记录的 GPU 数组展示："GPUs 0,1"（多卡）/ "GPU 0"（单卡）/ "GPU unknown"（--vllm 模式未记录）
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

	// ===== 逐个探测进程真实状态（区分 running/starting/crashed/dead，见函数注释） =====
	console.log("");
	console.log("Verifying processes...");
	let anyDead = false; // 是否有模型处于 dead/crashed 状态（用于结尾的清理提示）
	for (const name of modelNames) {
		const model = pod.models[name];
		// 同时检查 wrapper 进程是否存活与 vLLM /health 是否响应
		const checkCmd = `
			# Check if wrapper process exists
			if ps -p ${model.pid} > /dev/null 2>&1; then
				# Process exists, now check if vLLM is responding
				if curl -s -f http://localhost:${model.port}/health > /dev/null 2>&1; then
					echo "running"
				else
					# Check if it's still starting up
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
		// 远程脚本 echo 出的状态字符串即为判定结果
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

	// 有 dead/crashed 的模型时，提示用 pi stop 清理 pods.json 中的残留记录
	if (anyDead) {
		console.log("");
		console.log(chalk.yellow("Some models are not running. Clean up with:"));
		console.log(chalk.cyan("  pi stop <name>"));
	} else {
		console.log(chalk.green("✓ All processes verified"));
	}
};

/**
 * 实时查看模型日志（tail -f）
 *
 * 直接 spawn `ssh ... tail -f ~/.vllm_logs/<name>.log`，stdio 全部 inherit
 * （终端直连，Ctrl+C 直接作用于本地 ssh/tail 进程），
 * FORCE_COLOR=1 保证远程日志中的 ANSI 颜色不被剥离。
 *
 * @param name    模型实例名
 * @param options 可选 pod 覆盖
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

	// 实时跟踪远程日志并保留颜色
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

	// 挂起等待日志进程退出（通常由用户 Ctrl+C 触发）
	await new Promise<void>((resolve) => {
		logProcess.on("exit", () => resolve());
	});
};

/**
 * 展示预置模型库（models.json）及各模型的硬件要求
 *
 * 如果设置了 active pod，会依据其 GPU 数量与型号把模型分为两组展示：
 * - Compatible（绿色高亮）：当前 pod 可跑，附命中的具体配置（如 "4x H200"）
 * - Incompatible（灰色弱化）：跑不了，附最低硬件要求（如 "2x H100/H200"）
 * 两组内部再按模型家族（取显示名首段，如 "Qwen2.5"）分组、按名称排序；
 * 没有 active pod 时全部模型用同一风格列出，仅展示最低硬件要求。
 */
export const showKnownModels = async () => {
	// 动态导入 JSON，拿到预置模型清单
	const modelsJson = await import("../models.json", { assert: { type: "json" } });
	const models = modelsJson.default.models;

	// 读取 active pod 信息（可能未设置）
	const activePod = getActivePod();
	let podGpuCount = 0;
	let podGpuType = "";

	if (activePod) {
		podGpuCount = activePod.pod.gpus.length;
		// 从 GPU 名称截取型号，如 "NVIDIA H200" -> "H200"
		podGpuType = activePod.pod.gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

		console.log(chalk.bold(`Known Models for ${activePod.name} (${podGpuCount}x ${podGpuType || "GPU"}):\n`));
	} else {
		console.log(chalk.bold("Known Models:\n"));
		console.log(chalk.yellow("No active pod. Use 'pi pods active <name>' to filter compatible models.\n"));
	}

	console.log("Usage: pi start <model> --name <name> [options]\n");

	// 按兼容性与模型家族分组存放结果：
	// compatible —— 当前 pod 可跑，记录命中的配置描述；incompatible —— 记录最低硬件要求
	const compatible: Record<string, Array<{ id: string; name: string; config: string; notes?: string }>> = {};
	const incompatible: Record<string, Array<{ id: string; name: string; minGpu: string; notes?: string }>> = {};

	// 遍历每个预置模型：计算其最低硬件要求，并判定与 active pod 的兼容性
	for (const [modelId, info] of Object.entries(models)) {
		const modelInfo = info as any;
		// 家族取模型显示名的首段（如 "Qwen2.5-72B-Instruct" -> "Qwen2.5"），用于分组展示
		const family = modelInfo.name.split("-")[0] || "Other";

		let isCompatible = false;
		let compatibleConfig = "";
		let minGpu = "Unknown";
		let minNotes: string | undefined;

		if (modelInfo.configs && modelInfo.configs.length > 0) {
			// 按卡数升序排序：第一个即最低要求，也便于后续按序探测能跑的配置
			const sortedConfigs = [...modelInfo.configs].sort((a: any, b: any) => (a.gpuCount || 1) - (b.gpuCount || 1));

			// 最低硬件要求 = 卡数最少的那个配置
			const minConfig = sortedConfigs[0];
			const minGpuCount = minConfig.gpuCount || 1;
			const gpuTypes = minConfig.gpuTypes?.join("/") || "H100/H200";

			if (minGpuCount === 1) {
				minGpu = `1x ${gpuTypes}`;
			} else {
				minGpu = `${minGpuCount}x ${gpuTypes}`;
			}

			minNotes = minConfig.notes || modelInfo.notes;

			// 与 active pod 做兼容性判定
			if (activePod && podGpuCount > 0) {
				// 从卡数最少的配置开始逐个探测，找到当前 pod 能跑的配置即算兼容
				for (const config of sortedConfigs) {
					const configGpuCount = config.gpuCount || 1;
					const configGpuTypes = config.gpuTypes || [];

					// 卡数够用
					if (configGpuCount <= podGpuCount) {
						// 型号匹配（配置未声明型号时视为任意型号均可）
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

		// 有 active pod 且兼容 -> compatible 组；其余（不兼容或未设置 pod）-> incompatible 组
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

	// 先展示兼容模型（绿色高亮），家族名与家族内模型名分别排序
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

	// 再展示不兼容模型（过滤模式下灰色弱化；未设置 active pod 时全部模型都在此组，用正常色）
	if (Object.keys(incompatible).length > 0) {
		if (activePod && Object.keys(compatible).length > 0) {
			console.log(chalk.red.bold("✗ Incompatible Models (need more/different GPUs):\n"));
		}

		const sortedFamilies = Object.keys(incompatible).sort();
		for (const family of sortedFamilies) {
			if (!activePod) {
				console.log(chalk.cyan(`${family} Models:`));
			} else {
				console.log(chalk.gray(`${family} Models:`));
			}

			const modelList = incompatible[family].sort((a, b) => a.name.localeCompare(b.name));

			for (const model of modelList) {
				// 有 active pod 时灰色弱化（跑不了的模型）；无 pod 时绿色一视同仁
				const color = activePod ? chalk.gray : chalk.green;
				console.log(`  ${color(model.id)}`);
				console.log(chalk.gray(`    Name: ${model.name}`));
				console.log(chalk.gray(`    Min Hardware: ${model.minGpu}`));
				// 过滤模式下省略 Note，让输出更紧凑
				if (model.notes && !activePod) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				if (activePod) {
					console.log("");
				} else {
					console.log("");
				}
			}
		}
	}

	// 尾部提示：未知模型默认单卡部署；--vllm 可传自定义 vLLM 参数
	console.log(chalk.gray("\nFor unknown models, defaults to single GPU deployment."));
	console.log(chalk.gray("Use --vllm to pass custom arguments to vLLM."));
};
