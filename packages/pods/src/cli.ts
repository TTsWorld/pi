#!/usr/bin/env node
/**
 * @file pi 命令入口（顶层 CLI 分发器）
 * @description pi monorepo pods 包的可执行入口：解析命令行参数 argv，
 *              将 `pi` 的各子命令分发到对应的处理模块。
 *
 * 子命令清单：
 *   Pod 管理：
 *     - pi pods                 列出所有已配置的 Pod（* 标记激活 Pod）
 *     - pi pods setup           新增 Pod 并完成初始化（挂载、vLLM 安装等）
 *     - pi pods active          切换当前激活的 Pod
 *     - pi pods remove          从本地配置中移除 Pod
 *   远程操作：
 *     - pi shell                在 Pod 上打开交互式 shell
 *     - pi ssh                  在 Pod 上通过 SSH 执行单条命令
 *   模型管理：
 *     - pi start                启动一个模型（vLLM 部署）
 *     - pi stop                 停止指定模型（不带名字则全部停止）
 *     - pi list                 列出运行中的模型
 *     - pi logs                 跟踪模型日志
 *     - pi agent                以 agent 模式与模型对话（支持工具调用）
 *
 * 依赖关系：
 *   - commands/models.js   模型操作：startModel / stopModel / listModels / viewLogs
 *   - commands/pods.js     Pod 操作：setupPod / switchActivePod / removePodCommand / listPods
 *   - commands/prompt.js   agent 对话入口：promptModel
 *   - config.js            本地配置（默认 ~/.pi）读写与激活 Pod 查询
 *   - ssh.js               SSH 命令流式执行：sshExecStream
 */
import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { listModels, startModel, stopModel, viewLogs } from "./commands/models.js";
import { listPods, removePodCommand, setupPod, switchActivePod } from "./commands/pods.js";
import { promptModel } from "./commands/prompt.js";
import { getActivePod, loadConfig } from "./config.js";
import { sshExecStream } from "./ssh.js";

// ESM 模块没有内置的 __filename/__dirname，需通过 import.meta.url 手动推导
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取 package.json 仅为获取版本号（帮助信息与 --version 输出使用）
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

/**
 * 打印 CLI 帮助信息。
 * 列出全部子命令用法、各选项说明及相关环境变量（HF_TOKEN / PI_API_KEY / PI_CONFIG_DIR）。
 */
function printHelp() {
	console.log(`pi v${packageJson.version} - Manage vLLM deployments on GPU pods

Pod Management:
  pi pods setup <name> "<ssh>" --mount "<mount>"    Setup pod with mount command
    Options:
      --vllm release    Install latest vLLM release >=0.10.0 (default)
      --vllm nightly    Install vLLM nightly build (latest features)
      --vllm gpt-oss    Install vLLM 0.10.1+gptoss with PyTorch nightly (GPT-OSS only)
  pi pods                                           List all pods (* = active)
  pi pods active <name>                             Switch active pod
  pi pods remove <name>                             Remove pod from local config
  pi shell [<name>]                                 Open shell on pod (active or specified)
  pi ssh [<name>] "<command>"                       Run SSH command on pod

Model Management:
  pi start <model> --name <name> [options]          Start a model
    --memory <percent>   GPU memory allocation (30%, 50%, 90%)
    --context <size>     Context window (4k, 8k, 16k, 32k, 64k, 128k)
    --gpus <count>       Number of GPUs to use (predefined models only)
    --vllm <args...>     Pass remaining args to vLLM (ignores other options)
  pi stop [<name>]                                  Stop model (or all if no name)
  pi list                                           List running models
  pi logs <name>                                    Stream model logs
  pi agent <name> ["<message>"...] [options]        Chat with model using agent & tools
  pi agent <name> [options]                         Interactive chat mode
    --continue, -c       Continue previous session
    --json              Output as JSONL
    (All pi-agent options are supported)

  All model commands support --pod <name> to override the active pod.

Environment:
  HF_TOKEN         HuggingFace token for model downloads
  PI_API_KEY     API key for vLLM endpoints
  PI_CONFIG_DIR    Config directory (default: ~/.pi)`);
}

// 解析命令行参数（slice(2) 跳过 node 可执行文件与脚本路径）
const args = process.argv.slice(2);

// ========== 无参数 / 帮助 / 版本请求的处理 ==========
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	printHelp();
	process.exit(0);
}

if (args[0] === "--version" || args[0] === "-v") {
	console.log(packageJson.version);
	process.exit(0);
}

const command = args[0];
const subcommand = args[1];

// 主命令分发逻辑：顶层 try/catch 统一捕获各子命令处理中的异常
try {
	// ========== pods 子命令分发 ==========
	if (command === "pods") {
		if (!subcommand) {
			// pi pods —— 列出所有 Pod
			listPods();
		} else if (subcommand === "setup") {
			// pi pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]
			const name = args[2];
			const sshCmd = args[3];

			if (!name || !sshCmd) {
				console.error(
					'Usage: pi pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]',
				);
				process.exit(1);
			}

			// 解析 setup 选项：--mount / --models-path / --vllm 均为「选项名 + 值」形式
			const options: { mount?: string; modelsPath?: string; vllm?: "release" | "nightly" | "gpt-oss" } = {};
			for (let i = 4; i < args.length; i++) {
				if (args[i] === "--mount" && i + 1 < args.length) {
					options.mount = args[i + 1];
					i++;
				} else if (args[i] === "--models-path" && i + 1 < args.length) {
					options.modelsPath = args[i + 1];
					i++;
				} else if (args[i] === "--vllm" && i + 1 < args.length) {
					const vllmType = args[i + 1];
					if (vllmType === "release" || vllmType === "nightly" || vllmType === "gpt-oss") {
						options.vllm = vllmType;
					} else {
						console.error(chalk.red(`Invalid vLLM type: ${vllmType}`));
						console.error("Valid options: release, nightly, gpt-oss");
						process.exit(1);
					}
					i++;
				}
			}

			// 若只给了 --mount 而未指定 --models-path，则尝试从挂载命令中提取模型路径，
			// 免去用户重复输入（挂载命令的最后一个以 / 开头的词通常就是远端挂载点）
			if (options.mount && !options.modelsPath) {
				// 取挂载命令的最后一个词作为模型路径
				const parts = options.mount.trim().split(" ");
				const lastPart = parts[parts.length - 1];
				if (lastPart?.startsWith("/")) {
					options.modelsPath = lastPart;
				}
			}

			await setupPod(name, sshCmd, options);
		} else if (subcommand === "active") {
			// pi pods active <name> —— 切换激活 Pod
			const name = args[2];
			if (!name) {
				console.error("Usage: pi pods active <name>");
				process.exit(1);
			}
			switchActivePod(name);
		} else if (subcommand === "remove") {
			// pi pods remove <name> —— 从本地配置中移除 Pod
			const name = args[2];
			if (!name) {
				console.error("Usage: pi pods remove <name>");
				process.exit(1);
			}
			removePodCommand(name);
		} else {
			console.error(`Unknown pods subcommand: ${subcommand}`);
			process.exit(1);
		}
	} else {
		// ========== 解析模型命令的 --pod 覆盖 ==========
		// Why：所有模型命令都支持 --pod <name> 临时指定非激活 Pod，
		// 提前从 args 中摘除该选项，避免干扰后续各命令自己的参数解析
		let podOverride: string | undefined;
		const podIndex = args.indexOf("--pod");
		if (podIndex !== -1 && podIndex + 1 < args.length) {
			podOverride = args[podIndex + 1];
			// 从 args 中移除 --pod 及其值
			args.splice(podIndex, 2);
		}

		// ========== shell / ssh / 模型命令分发 ==========
		switch (command) {
			case "shell": {
				// pi shell [<name>] —— 打开交互式 shell（指定 Pod，否则用激活 Pod）
				const podName = args[1];
				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.green(`Connecting to pod '${podInfo.name}'...`));

				// 以交互模式执行 SSH：stdio 设为 inherit 让终端直接连到远端 shell
				const sshArgs = podInfo.pod.ssh.split(" ").slice(1); // 从命令串中剥掉开头的 'ssh'，剩余部分作为 ssh 参数
				const sshProcess = spawn("ssh", sshArgs, {
					stdio: "inherit",
					env: process.env,
				});

				sshProcess.on("exit", (code) => {
					process.exit(code || 0);
				});
				break;
			}
			case "ssh": {
				// pi ssh [<name>] "<command>" —— 通过 SSH 在 Pod 上执行单条命令
				let podName: string | undefined;
				let sshCommand: string;

				// 按参数个数区分两种形式：pi ssh "<command>"（用激活 Pod）或 pi ssh <name> "<command>"
				if (args.length === 2) {
					// pi ssh "<command>" —— 使用激活 Pod
					sshCommand = args[1];
				} else if (args.length === 3) {
					// pi ssh <name> "<command>" —— 使用指定 Pod
					podName = args[1];
					sshCommand = args[2];
				} else {
					console.error('Usage: pi ssh [<name>] "<command>"');
					process.exit(1);
				}

				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.gray(`Running on pod '${podInfo.name}': ${sshCommand}`));

				// 执行命令并流式输出结果，以远端退出码退出
				const exitCode = await sshExecStream(podInfo.pod.ssh, sshCommand);
				process.exit(exitCode);
				break;
			}
			case "start": {
				// pi start <model> --name <name> [options] —— 启动模型
				const modelId = args[1];
				if (!modelId) {
					// 未指定模型时，展示可用的内置模型列表后退出
					const { showKnownModels } = await import("./commands/models.js");
					await showKnownModels();
					process.exit(0);
				}

				// ========== 解析 start 选项 ==========
				// --vllm 之后的所有参数原样透传给 vLLM（进入 inVllmArgs 状态后不再识别其他选项）
				let name: string | undefined;
				let memory: string | undefined;
				let context: string | undefined;
				let gpus: number | undefined;
				const vllmArgs: string[] = [];
				let inVllmArgs = false;

				for (let i = 2; i < args.length; i++) {
					if (inVllmArgs) {
						vllmArgs.push(args[i]);
					} else if (args[i] === "--name" && i + 1 < args.length) {
						name = args[i + 1];
						i++;
					} else if (args[i] === "--memory" && i + 1 < args.length) {
						memory = args[i + 1];
						i++;
					} else if (args[i] === "--context" && i + 1 < args.length) {
						context = args[i + 1];
						i++;
					} else if (args[i] === "--gpus" && i + 1 < args.length) {
						gpus = parseInt(args[i + 1]);
						if (Number.isNaN(gpus) || gpus < 1) {
							console.error(chalk.red("--gpus must be a positive number"));
							process.exit(1);
						}
						i++;
					} else if (args[i] === "--vllm") {
						inVllmArgs = true;
					}
				}

				if (!name) {
					console.error("--name is required");
					process.exit(1);
				}

				// --vllm 与其他调参选项互斥：同时给出时后者会被忽略，此处显式警告用户
				if (vllmArgs.length > 0 && (memory || context || gpus)) {
					console.log(
						chalk.yellow("⚠ Warning: --memory, --context, and --gpus are ignored when --vllm is specified"),
					);
					console.log(chalk.yellow("  Using only custom vLLM arguments"));
					console.log("");
				}

				await startModel(modelId, name, {
					pod: podOverride,
					memory,
					context,
					gpus,
					vllmArgs: vllmArgs.length > 0 ? vllmArgs : undefined,
				});
				break;
			}
			case "stop": {
				// pi stop [name] —— 停止指定模型；不带名字则停止全部
				const name = args[1];
				if (!name) {
					// 停止（覆盖 Pod 或）激活 Pod 上的所有模型
					const { stopAllModels } = await import("./commands/models.js");
					await stopAllModels({ pod: podOverride });
				} else {
					await stopModel(name, { pod: podOverride });
				}
				break;
			}
			case "list":
				// pi list —— 列出运行中的模型
				await listModels({ pod: podOverride });
				break;
			case "logs": {
				// pi logs <name> —— 跟踪模型日志
				const name = args[1];
				if (!name) {
					console.error("Usage: pi logs <name>");
					process.exit(1);
				}
				await viewLogs(name, { pod: podOverride });
				break;
			}
			case "agent": {
				// pi agent <name> [messages...] [options] —— 与模型对话
				const name = args[1];
				if (!name) {
					console.error("Usage: pi agent <name> [messages...] [options]");
					process.exit(1);
				}

				const apiKey = process.env.PI_API_KEY;

				// 把模型名之后的全部参数原样透传给 promptModel
				const agentArgs = args.slice(2);

				// 未提供消息时即为交互模式（由 promptModel 内部处理）
				await promptModel(name, agentArgs, {
					pod: podOverride,
					apiKey,
				}).catch(() => {
					// 错误已在 promptModel 内部处理，这里只需干净退出
					process.exit(0);
				});
				break;
			}
			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}
	}
} catch (error) {
	console.error("Error:", error);
	process.exit(1);
}
