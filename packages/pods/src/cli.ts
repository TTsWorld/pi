#!/usr/bin/env node
/**
 * @file cli.ts
 * @description pi CLI 入口 —— GPU Pod 与 vLLM 模型的远程管理命令分发
 * @module pi-pods
 *
 * 主要功能：
 * - pods：Pod 生命周期管理（setup 初始化 / active 切换活跃 Pod / remove 移除 / 无子命令时列出全部）
 * - shell：在 Pod 上打开交互式 SSH Shell
 * - ssh：在 Pod 上远程执行单条 SSH 命令
 * - start：启动 vLLM 模型（支持 --memory/--context/--gpus/--vllm 选项，无参数时展示预置模型清单）
 * - stop：停止指定模型或全部模型
 * - list：列出正在运行的模型
 * - logs：流式查看模型日志
 * - agent：通过 pi-agent 与模型对话（支持交互模式与 --json 输出）
 * - 全局选项 --pod <name>：单次命令临时覆盖活跃 Pod，作用于所有模型相关命令
 *
 * 注意：本文件为顶层执行的 ESM 脚本（依赖 top-level await），没有 main() 函数
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

// ESM 模块没有 CommonJS 的 __filename/__dirname 全局变量，需通过 import.meta.url 手动推导
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 读取 package.json，仅用于获取版本号（--version 输出与帮助信息展示）
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

/**
 * 打印 CLI 帮助信息
 *
 * 输出为面向终端用户的英文使用说明（因此保持原文，不做翻译），涵盖：
 * - Pod 管理：pods setup/active/remove、shell、ssh
 * - 模型管理：start/stop/list/logs/agent 及各自选项
 * - 相关环境变量：HF_TOKEN（模型下载）、PI_API_KEY（vLLM 端点鉴权）、PI_CONFIG_DIR（配置目录）
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

// ========== 命令行参数解析与全局入口 ==========

// process.argv 前两项是 node 可执行文件与脚本路径，slice(2) 之后才是真正的用户参数
const args = process.argv.slice(2);

// 无参数或显式 --help/-h：打印帮助并以退出码 0 结束
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	printHelp();
	process.exit(0);
}

// --version/-v：仅输出版本号后退出
if (args[0] === "--version" || args[0] === "-v") {
	console.log(packageJson.version);
	process.exit(0);
}

// command 为主命令（如 pods/start/ssh），subcommand 为主命令的子命令（仅 pods 组使用，如 setup/active/remove）
const command = args[0];
const subcommand = args[1];

// ========== 主命令分发 ==========
// 手写 if/switch 分发各子命令；顶层 try/catch 统一兜底，任何子命令抛出的异常都在末尾打印并以退出码 1 退出
try {
	// ========== 子命令组：pods —— GPU Pod 生命周期管理 ==========
	if (command === "pods") {
		if (!subcommand) {
			// ========== pods（无子命令）—— 列出所有 Pod（* 标记当前活跃 Pod） ==========
			listPods();
		} else if (subcommand === "setup") {
			// ========== pods setup —— 初始化新 Pod ==========
			// 用法：pi pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]
			const name = args[2];
			const sshCmd = args[3];

			if (!name || !sshCmd) {
				console.error(
					'Usage: pi pods setup <name> "<ssh>" [--mount "<mount>"] [--models-path <path>] [--vllm release|nightly|gpt-oss]',
				);
				process.exit(1);
			}

			// 解析 setup 选项：--mount（挂载命令）、--models-path（模型目录）、--vllm（要安装的 vLLM 版本类型）
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

			// 若提供了 --mount 但未提供 --models-path，则尝试从挂载命令中推导模型路径：
			// 挂载命令的最后一个 token 通常是远端目标路径，直接复用可省去用户重复输入
			if (options.mount && !options.modelsPath) {
				// 取挂载命令按空格分隔后的最后一部分作为模型路径（仅当其以 / 开头时生效）
				const parts = options.mount.trim().split(" ");
				const lastPart = parts[parts.length - 1];
				if (lastPart?.startsWith("/")) {
					options.modelsPath = lastPart;
				}
			}

			await setupPod(name, sshCmd, options);
		} else if (subcommand === "active") {
			// ========== pods active —— 切换活跃 Pod（后续模型命令默认作用于此） ==========
			const name = args[2];
			if (!name) {
				console.error("Usage: pi pods active <name>");
				process.exit(1);
			}
			switchActivePod(name);
		} else if (subcommand === "remove") {
			// ========== pods remove —— 从本地配置中移除 Pod（不影响远端机器） ==========
			const name = args[2];
			if (!name) {
				console.error("Usage: pi pods remove <name>");
				process.exit(1);
			}
			removePodCommand(name);
		} else {
			// 未知的 pods 子命令
			console.error(`Unknown pods subcommand: ${subcommand}`);
			process.exit(1);
		}
	} else {
		// ========== 解析全局选项 --pod <name>：临时覆盖活跃 Pod ==========
		// Why：模型类命令默认作用于“活跃 Pod”（config 中的 active 字段），
		// --pod 允许单次命令定向到其他 Pod 而无需切换 active；
		// 解析后必须从 args 中移除（splice 两项），避免被后续选项解析（如 start 的 --name/--memory）误读
		let podOverride: string | undefined;
		const podIndex = args.indexOf("--pod");
		if (podIndex !== -1 && podIndex + 1 < args.length) {
			podOverride = args[podIndex + 1];
			// 从 args 中移除 --pod 及其值（共两项）
			args.splice(podIndex, 2);
		}

		// ========== 其余子命令分发：shell / ssh 与模型命令（start/stop/list/logs/agent） ==========
		// 说明：podOverride 透传给各命令，为空时由各命令内部的 getPod() 回退到活跃 Pod
		switch (command) {
			case "shell": {
				// ========== 子命令：shell —— 在 Pod 上打开交互式 SSH Shell ==========
				// 用法：pi shell [<name>]；指定名称则从配置查找该 Pod，省略则使用活跃 Pod
				const podName = args[1];
				let podInfo: { name: string; pod: import("./types.js").Pod } | null = null;

				// 按名称从本地配置查找 Pod；未指定名称则取活跃 Pod
				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				// 查不到目标 Pod（或尚未设置活跃 Pod）时报错退出
				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.green(`Connecting to pod '${podInfo.name}'...`));

				// 以交互模式执行 SSH：spawn ssh 子进程并继承 stdio，让用户获得完整的终端体验
				const sshArgs = podInfo.pod.ssh.split(" ").slice(1); // 去掉 ssh 命令开头的 'ssh' 前缀，只保留目标参数
				const sshProcess = spawn("ssh", sshArgs, {
					stdio: "inherit",
					env: process.env,
				});

				// SSH 进程退出后，CLI 以相同退出码结束（code 为 null 时按 0 处理）
				sshProcess.on("exit", (code) => {
					process.exit(code || 0);
				});
				break;
			}
			case "ssh": {
				// ========== 子命令：ssh —— 在 Pod 上远程执行单条命令 ==========
				let podName: string | undefined;
				let sshCommand: string;

				// 参数按位置约定解析：2 个参数 = 省略 Pod 名（用活跃 Pod）；3 个参数 = 指定 Pod 名 + 命令
				if (args.length === 2) {
					// pi ssh "<command>" —— 使用活跃 Pod
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

				// 按名称从本地配置查找 Pod；未指定名称则取活跃 Pod
				if (podName) {
					const config = loadConfig();
					const pod = config.pods[podName];
					if (pod) {
						podInfo = { name: podName, pod };
					}
				} else {
					podInfo = getActivePod();
				}

				// 查不到目标 Pod（或尚未设置活跃 Pod）时报错退出
				if (!podInfo) {
					if (podName) {
						console.error(chalk.red(`Pod '${podName}' not found`));
					} else {
						console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
					}
					process.exit(1);
				}

				console.log(chalk.gray(`Running on pod '${podInfo.name}': ${sshCommand}`));

				// 执行远端命令并流式转发输出，最终以远端命令的退出码退出
				const exitCode = await sshExecStream(podInfo.pod.ssh, sshCommand);
				process.exit(exitCode);
				break;
			}
			case "start": {
				// ========== 子命令：start —— 在 Pod 上启动 vLLM 模型 ==========
				// 用法：pi start <model> --name <name> [options]
				const modelId = args[1];
				if (!modelId) {
					// 未指定模型 ID：动态导入并展示预置模型清单（showKnownModels），帮助用户选择后以 0 退出
					const { showKnownModels } = await import("./commands/models.js");
					await showKnownModels();
					process.exit(0);
				}

				// 解析启动选项：--name（必填，模型服务名）、--memory（显存占比）、--context（上下文窗口）、
				// --gpus（GPU 数量，仅预置模型支持）、--vllm（其后参数原样透传给 vLLM）
				let name: string | undefined;
				let memory: string | undefined;
				let context: string | undefined;
				let gpus: number | undefined;
				const vllmArgs: string[] = [];
				let inVllmArgs = false;

				// 从第 3 个参数（索引 2）开始逐个解析；一旦遇到 --vllm，
				// 其后的所有参数不再走选项解析，全部原样收集为 vLLM 透传参数
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

				// 同时指定 --vllm 与 --memory/--context/--gpus 时给出警告：
				// Why：自定义 vLLM 参数优先生效，其余选项会被忽略，提前告知避免用户误以为已生效
				if (vllmArgs.length > 0 && (memory || context || gpus)) {
					console.log(
						chalk.yellow("⚠ Warning: --memory, --context, and --gpus are ignored when --vllm is specified"),
					);
					console.log(chalk.yellow("  Using only custom vLLM arguments"));
					console.log("");
				}

				// 启动模型；pod 传入 podOverride（可为空，为空时 startModel 内部回退到活跃 Pod）
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
				// ========== 子命令：stop —— 停止模型 ==========
				// 用法：pi stop [<name>]；指定名称则停止单个模型，省略则停止目标 Pod 上的全部模型
				const name = args[1];
				if (!name) {
					// 未指定名称：动态导入 stopAllModels，停止（被覆盖的）活跃 Pod 上的所有模型
					const { stopAllModels } = await import("./commands/models.js");
					await stopAllModels({ pod: podOverride });
				} else {
					await stopModel(name, { pod: podOverride });
				}
				break;
			}
			case "list":
				// ========== 子命令：list —— 列出目标 Pod 上正在运行的模型 ==========
				await listModels({ pod: podOverride });
				break;
			case "logs": {
				// ========== 子命令：logs —— 流式查看模型日志 ==========
				// 用法：pi logs <name>，name 为启动模型时通过 --name 指定的服务名
				const name = args[1];
				if (!name) {
					console.error("Usage: pi logs <name>");
					process.exit(1);
				}
				await viewLogs(name, { pod: podOverride });
				break;
			}
			case "agent": {
				// ========== 子命令：agent —— 通过 pi-agent 与模型对话（支持工具调用） ==========
				// 用法：pi agent <name> [messages...] [options]；不带消息时进入交互模式
				const name = args[1];
				if (!name) {
					console.error("Usage: pi agent <name> [messages...] [options]");
					process.exit(1);
				}

				// 从环境变量读取 API Key，用于访问 Pod 上的 vLLM 端点
				const apiKey = process.env.PI_API_KEY;

				// 模型名之后的所有参数原样透传给 pi-agent（如 --continue/--json 等，见帮助信息）
				const agentArgs = args.slice(2);

				// 未提供消息即为交互模式，由 promptModel 内部区分处理
				await promptModel(name, agentArgs, {
					pod: podOverride,
					apiKey,
				}).catch(() => {
					// 错误已在 promptModel 内部处理并输出，这里只需干净退出（退出码 0）
					process.exit(0);
				});
				break;
			}
			default:
				// 未知命令：报错并回退到帮助信息
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}
	}
} catch (error) {
	// 顶层异常兜底：统一打印错误并以退出码 1 结束
	console.error("Error:", error);
	process.exit(1);
}
