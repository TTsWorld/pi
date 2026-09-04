/**
 * @file prompt.ts
 * @description prompt/agent 子命令 —— 组装参数并库级调用 pi-agent 的 main() 连接远程模型
 * @module pi-pods
 *
 * 主要功能：
 * - 读取 pods.json 中的 pod 与模型配置，校验 active pod 与目标模型是否存在
 * - 从 pod 的 ssh 连接串解析主机地址，拼出 OpenAI 兼容 API 的 base-url
 * - 构造面向「代码导航」场景的 system prompt（要求输出带行号的文件路径、回答简洁等）
 * - 组装 --base-url/--model/--api-key/--api/--system-prompt 等受控参数，并透传用户全部参数
 * - 直接以库调用方式执行 @mariozechner/pi-agent 导出的 main()，启动编码代理会话
 */

import { main as agentMain } from "@mariozechner/pi-agent";
import chalk from "chalk";
import { getActivePod, loadConfig } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────────
// 类型定义
// ────────────────────────────────────────────────────────────────────────────────

/** prompt/agent 子命令的可选项 */
interface PromptOptions {
	pod?: string; // 显式指定的 pod 名；缺省时使用 pods.json 中的 active pod
	apiKey?: string; // 显式指定的 API 密钥；缺省时回退到环境变量 PI_API_KEY
}

// ────────────────────────────────────────────────────────────────────────────────
// 主流程：promptModel（prompt/agent 子命令入口）
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 执行 `pi agent <name>` 子命令：连接指定 pod 上部署的模型并启动编码代理会话。
 *
 * 整体流程：
 * 1. 取配置：从 pods.json 读取 pod（优先 opts.pod，否则取 active pod）及目标模型配置；
 * 2. host 解析：从 pod 的 ssh 串（形如 "ssh user@host"）中提取主机名，默认 localhost；
 * 3. 构造 system prompt：生成代码导航专用提示词（要求输出带行号、回答简洁等）；
 * 4. 组装参数：写入 base-url/model/api-key/api/system-prompt 等受控参数，再透传用户参数；
 * 5. 调用 main：直接调用 pi-agent 导出的 main() 启动代理，出错时红字提示并退出。
 *
 * @param modelName 目标模型名（pod.models 的键，对应 `pi agent <name>` 中的 name）
 * @param userArgs  用户传入的其余命令行参数（提示消息、--continue、--json 等），原样透传给 agent main()
 * @param opts      可选项：pod（覆盖 active pod）与 apiKey（覆盖 API 密钥）
 */
export async function promptModel(modelName: string, userArgs: string[], opts: PromptOptions = {}) {
	// ── 阶段 1：取 pod 与模型配置 ──
	// 显式指定了 pod 名则直接按名读取；否则使用配置中的 active pod
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	// 查找目标模型在本 pod 上的部署配置（服务端口、真实模型 ID 等）
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`Model '${modelName}' not found on pod '${podName}'`));
		process.exit(1);
	}

	// ── 阶段 2：从 ssh 连接串解析主机地址 ──
	// ssh 串形如 "ssh user@host"：取第一个含 "@" 的片段，再按 "@" 切分取主机部分；
	// 解析不到（如本地部署）时回退为 "localhost"
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// ── 阶段 3：构造代码导航专用的 system prompt ──
	// 约束代理行为：专注代码理解与导航、不直接回显 read_file 读到的内容、
	// 不输出 markdown 表格、回答保持简洁，且输出文件路径时尽量附带行号
	// （如 "src/index.ts:10-20"），最后注入当前工作目录
	const systemPrompt = `You help the user understand and navigate the codebase in the current working directory.

You can read files, list directories, and execute shell commands via the respective tools.

Do not output file contents you read via the read_file tool directly, unless asked to.

Do not output markdown tables as part of your responses.

Keep your responses concise and relevant to the user's request.

File paths you output must include line numbers where possible, e.g. "src/index.ts:10-20" for lines 10 to 20 in src/index.ts.

Current working directory: ${process.cwd()}`;

	// ── 阶段 4：组装传给 agent main() 的命令行参数 ──
	const args: string[] = [];

	// 先写入由本命令控制的「基础配置」参数：
	// --base-url       pod 上模型的 OpenAI 兼容端点，固定为 http://<host>:<port>/v1
	// --model          pods.json 中记录的真实模型 ID（可能与命令行中的别名不同）
	// --api-key        取值优先级：opts.apiKey > 环境变量 PI_API_KEY > "dummy"
	//                  （自建端点通常不校验密钥，故用占位符兜底）
	// --api            按模型名是否含 "gpt-oss" 选择协议：gpt-oss 系列在推理服务端
	//                  以 OpenAI Responses API 形式提供服务（配套专用 vLLM 版本，
	//                  见 Pod.vllmVersion 的 "gpt-oss" 取值），其余模型走通用的
	//                  Chat Completions API
	// --system-prompt  注入阶段 3 构造的代码导航提示词
	args.push(
		"--base-url",
		`http://${host}:${modelConfig.port}/v1`,
		"--model",
		modelConfig.model,
		"--api-key",
		opts.apiKey || process.env.PI_API_KEY || "dummy",
		"--api",
		modelConfig.model.toLowerCase().includes("gpt-oss") ? "responses" : "completions",
		"--system-prompt",
		systemPrompt,
	);

	// 透传用户提供的全部参数（提示消息、--continue、--json 等），
	// 追加在受控参数之后，由 agent 的参数解析器统一处理
	args.push(...userArgs);

	// ── 阶段 5：直接调用 pi-agent 的 main() ──
	// Why 库级调用而非 spawn 子进程：pods 包不复制 agent 的实现，而是直接依赖
	// @mariozechner/pi-agent 并在同一进程内调用其导出的 main()——省去子进程启动、
	// CLI 查找与序列化开销，且异常能在本进程内直接捕获。这里也是 pods 与
	// agent 两个包的接合点
	try {
		await agentMain(args);
	} catch (err: any) {
		console.error(chalk.red(`Agent error: ${err.message}`));
		process.exit(1);
	}
}
