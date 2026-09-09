/**
 * @file prompt.ts
 * @description pi monorepo 中 pods 包与 agent（pi-agent）之间的桥梁。
 *
 * 职责：
 * - 根据指定（或当前激活）的 pod 配置，推导出模型的 http://host:port/v1 形式 base URL
 * - 注入用于"代码导航"场景的 system prompt
 * - 针对名称包含 gpt-oss 的模型自动选择 `--api responses`（其余用 completions）
 * - 组装参数后直接调用 agentMain，从而完整复用 pi-agent 的所有能力（消息、--continue、--json 等）
 */
import { main as agentMain } from "@mariozechner/pi-agent";
import chalk from "chalk";
import { getActivePod, loadConfig } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────────
// Types（类型定义）
// ────────────────────────────────────────────────────────────────────────────────

/** prompt 命令的选项 */
interface PromptOptions {
	/** 指定 pod 名称；缺省时使用当前激活的 pod */
	pod?: string;
	/** 覆盖 API key；缺省时依次回退到环境变量 PI_API_KEY 或 "dummy" */
	apiKey?: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Main prompt function（主入口函数）
// ────────────────────────────────────────────────────────────────────────────────

/**
 * 用指定 pod 上的指定模型启动一次 agent 交互。
 *
 * 流程：解析 pod 与模型配置 → 从 SSH 连接串中提取 host → 构造代码导航用的
 * system prompt → 组装 CLI 参数（base URL、模型、API key、API 类型等）→
 * 透传用户参数 → 调用 agentMain 复用 pi-agent 的完整能力。
 *
 * @param modelName 要使用的模型名（必须在 pod 配置的 models 中存在）
 * @param userArgs 用户透传给 agent 的参数（消息、--continue、--json 等）
 * @param opts 可选配置：指定 pod 名称 / 覆盖 API key
 */
export async function promptModel(modelName: string, userArgs: string[], opts: PromptOptions = {}) {
	// 获取 pod 与模型配置：显式指定 opts.pod 时从配置文件加载，否则取当前激活的 pod
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`Model '${modelName}' not found on pod '${podName}'`));
		process.exit(1);
	}

	// 从 SSH 连接串（形如 "ssh user@host"）中提取 host 部分，取不到则回退为 localhost
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// 构造用于代码导航场景的 system prompt：
	// 约束模型只读文件/列目录/执行命令，回答精简，且输出路径时尽量带行号（如 "src/index.ts:10-20"）
	const systemPrompt = `You help the user understand and navigate the codebase in the current working directory.

You can read files, list directories, and execute shell commands via the respective tools.

Do not output file contents you read via the read_file tool directly, unless asked to.

Do not output markdown tables as part of your responses.

Keep your responses concise and relevant to the user's request.

File paths you output must include line numbers where possible, e.g. "src/index.ts:10-20" for lines 10 to 20 in src/index.ts.

Current working directory: ${process.cwd()}`;

	// 为 agent 主函数组装命令行参数
	const args: string[] = [];

	// 添加由本命令控制的固定配置：
	// base URL 由「从 SSH 串提取的 host + 模型配置的 port」拼成 /v1 端点；
	// API key 优先级为 opts.apiKey > 环境变量 PI_API_KEY > "dummy"（pod 本地服务通常不校验）；
	// 模型名包含 gpt-oss 时使用 responses API，否则使用 completions API
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

	// 透传所有用户提供的参数
	// 包括消息、--continue、--json 等
	args.push(...userArgs);

	// 直接调用 agent 主函数，复用 pi-agent 的完整能力
	try {
		await agentMain(args);
	} catch (err: any) {
		console.error(chalk.red(`Agent error: ${err.message}`));
		process.exit(1);
	}
}
