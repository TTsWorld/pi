/**
 * @file pi-agent CLI 主入口
 *
 * @description
 * pi monorepo agent 包的主流程编排文件。职责：定义命令行参数 → 解析参数 →
 * 根据参数将程序分派到以下三种运行模式之一：
 *
 * 1. 交互 TUI 模式（默认，无位置参数且未开 --json）：
 *    由 runTuiInteractiveMode 驱动，使用 TuiRenderer 渲染终端 UI，支持会话恢复。
 * 2. JSON 交互模式（--json 且无位置参数）：
 *    由 runJsonInteractiveMode 驱动，stdin 逐行读取 JSON 命令（message/interrupt），
 *    输出 JSONL 事件流，便于被其他程序（如 IDE 插件、上层 agent）嵌入调用。
 * 3. 单发模式（提供了位置参数消息）：
 *    由 runSingleShotMode 驱动，依次处理每条消息后退出，适合脚本化调用。
 *
 * 依赖关系：
 * - args.js：通用参数解析器（parseArgs / printHelp）
 * - agent.js：Agent 核心循环（Agent 类与 AgentConfig 类型）
 * - session-manager.js：会话持久化（SessionManager）
 * - renderers/*：三种渲染器（ConsoleRenderer / JsonRenderer / TuiRenderer）
 */
import chalk from "chalk";
import { createInterface } from "readline";
import type { AgentConfig } from "./agent.js";
import { Agent } from "./agent.js";
import { parseArgs, printHelp as printHelpArgs } from "./args.js";
import { ConsoleRenderer } from "./renderers/console-renderer.js";
import { JsonRenderer } from "./renderers/json-renderer.js";
import { TuiRenderer } from "./renderers/tui-renderer.js";
import { SessionManager } from "./session-manager.js";

// 定义命令行参数结构
const argDefs = {
	"base-url": {
		type: "string" as const,
		default: "https://api.openai.com/v1",
		description: "API base URL",
	},
	"api-key": {
		type: "string" as const,
		default: process.env.OPENAI_API_KEY || "",
		description: "API key",
		showDefault: "$OPENAI_API_KEY",
	},
	model: {
		type: "string" as const,
		default: "gpt-5-mini",
		description: "Model name",
	},
	api: {
		type: "string" as const,
		default: "completions",
		description: "API type",
		choices: [
			{ value: "completions", description: "OpenAI Chat Completions API (most models)" },
			{ value: "responses", description: "OpenAI Responses API (GPT-OSS models)" },
		],
	},
	"system-prompt": {
		type: "string" as const,
		default: "You are a helpful assistant.",
		description: "System prompt",
	},
	continue: {
		type: "flag" as const,
		alias: "c",
		description: "Continue previous session",
	},
	json: {
		type: "flag" as const,
		description: "Output as JSONL",
	},
	help: {
		type: "flag" as const,
		alias: "h",
		description: "Show this help message",
	},
};

/**
 * JSON 交互模式下 stdin 输入命令的结构。
 * - type 为 "message" 时必须携带 content 字符串（发给 agent 的用户消息）
 * - type 为 "interrupt" 时中断当前正在处理的请求
 */
interface JsonCommand {
	type: "message" | "interrupt";
	content?: string;
}

/**
 * 打印 CLI 帮助信息（用法说明 + 各参数说明）。
 */
function printHelp(): void {
	const usage = `Usage: pi-agent [options] [messages...]

Examples:
# Single message (default OpenAI, GPT-5 Mini, OPENAI_API_KEY env var)
pi-agent "What is 2+2?"

# Multiple messages processed sequentially
pi-agent "What is 2+2?" "What about 3+3?"

# Interactive chat mode (no messages = interactive)
pi-agent

# Continue most recently modified session in current directory
pi-agent --continue "Follow up question"

# GPT-OSS via Groq
pi-agent --base-url https://api.groq.com/openai/v1 --api-key $GROQ_API_KEY --model openai/gpt-oss-120b

# GLM 4.5 via OpenRouter
pi-agent --base-url https://openrouter.ai/api/v1 --api-key $OPENROUTER_API_KEY --model z-ai/glm-4.5

# Claude via Anthropic (no prompt caching support - see https://docs.anthropic.com/en/api/openai-sdk)
pi-agent --base-url https://api.anthropic.com/v1 --api-key $ANTHROPIC_API_KEY --model claude-opus-4-1-20250805`;
	printHelpArgs(argDefs, usage);
}

/**
 * JSON 交互模式：从 stdin 逐行读取 JSON 命令，驱动 agent 并输出 JSONL 事件流。
 *
 * 之所以单独提供这种模式，是为了让本 CLI 能被宿主程序（而非人类终端）以管道方式嵌入：
 * 宿主逐行写入 `{"type":"message","content":"..."}` 或 `{"type":"interrupt"}`，
 * 并从 stdout 逐行读取 JSONL 事件。
 *
 * @param config         agent 配置（API 地址、密钥、模型等）
 * @param sessionManager 会话管理器，用于持久化与恢复会话
 */
async function runJsonInteractiveMode(config: AgentConfig, sessionManager: SessionManager): Promise<void> {
	// terminal: false —— 不解释控制字符，因为 stdin 是管道输入而非真实终端
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false, // Don't interpret control characters（不解释控制字符）
	});

	const renderer = new JsonRenderer();
	const agent = new Agent(config, renderer, sessionManager);
	// 串行化状态：同一时刻只允许一个 agent.ask 在跑
	let isProcessing = false;
	// 处理期间到达的新消息会暂存到这里，等当前请求结束后再继续处理
	let pendingMessage: string | null = null;

	/**
	 * 向 agent 发送一条消息；处理期间若有新消息到达则排队，当前请求结束后自动续跑。
	 * @param content 用户消息文本
	 */
	const processMessage = async (content: string): Promise<void> => {
		isProcessing = true;

		try {
			await agent.ask(content);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		} finally {
			isProcessing = false;

			// ========== 处理排队消息 ==========
			// Why：agent 同一时间只能处理一个请求；用 pendingMessage 单槽队列
			// 保证「处理中到达的消息」不丢失，且始终串行执行，避免并发交错导致事件流错乱。
			if (pendingMessage) {
				const msg = pendingMessage;
				pendingMessage = null;
				await processMessage(msg);
			}
		}
	};

	// 监听 stdin 的每一行输入
	rl.on("line", (line) => {
		try {
			const command = JSON.parse(line) as JsonCommand;

			switch (command.type) {
				case "interrupt":
					// 中断当前请求，并复位处理标记（被中断的请求不会再走完 finally 之外的逻辑）
					agent.interrupt();
					isProcessing = false;
					break;

				case "message":
					if (!command.content) {
						renderer.on({ type: "error", message: "Message content is required" });
						return;
					}

					if (isProcessing) {
						// agent 忙碌时先入队，等当前请求完成后再处理
						pendingMessage = command.content;
					} else {
						processMessage(command.content);
					}
					break;

				default:
					renderer.on({ type: "error", message: `Unknown command type: ${(command as any).type}` });
			}
		} catch (e) {
			renderer.on({ type: "error", message: `Invalid JSON: ${e}` });
		}
	});

	// 等待 stdin 关闭（宿主关闭管道）后再返回，模式即结束
	await new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}

/**
 * 交互 TUI 模式：面向人类用户的终端 UI 聊天循环。
 *
 * 流程：初始化 TuiRenderer → 恢复历史会话事件并重放 → 进入「读输入 → ask」无限循环。
 *
 * @param agentConfig    agent 配置（API 地址、密钥、模型等）
 * @param sessionManager 会话管理器，用于持久化与恢复会话
 */
async function runTuiInteractiveMode(agentConfig: AgentConfig, sessionManager: SessionManager): Promise<void> {
	// ========== 恢复会话并提示 ==========
	// 若有可恢复的会话（--continue），先告知用户将恢复多少条事件
	const sessionData = sessionManager.getSessionData();
	if (sessionData) {
		console.log(chalk.dim(`Resuming session with ${sessionData.events.length} events`));
	}
	const renderer = new TuiRenderer();

	// 必须在创建 Agent 之前初始化 TUI，以防止重复初始化
	await renderer.init();

	const agent = new Agent(agentConfig, renderer, sessionManager);
	// 注册中断回调：TUI 里用户按下中断键（如 Esc/Ctrl+C）时打断 agent
	renderer.setInterruptCallback(() => {
		agent.interrupt();
	});

	// ========== 重放历史事件 ==========
	// Why：恢复会话时不仅要恢复 agent 内部状态（setEvents 重建上下文），
	// 还要把历史事件重新渲染一遍，让 TUI 上“回放”出之前的对话内容。
	// assistant_start 事件只需画标签头，其余事件走正常渲染路径。
	if (sessionData) {
		agent.setEvents(sessionData ? sessionData.events.map((e) => e.event) : []);
		for (const sessionEvent of sessionData.events) {
			const event = sessionEvent.event;
			if (event.type === "assistant_start") {
				renderer.renderAssistantLabel();
			} else {
				await renderer.on(event);
			}
		}
	}

	// ========== 主循环 ==========
	// 读取用户输入 → 发给 agent；单条失败只报错不退出，会话可持续
	while (true) {
		const userInput = await renderer.getUserInput();
		try {
			await agent.ask(userInput);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		}
	}
}

/**
 * 单发模式：顺序处理完所有位置参数消息后退出，适合脚本化一次性调用。
 *
 * @param agentConfig    agent 配置（API 地址、密钥、模型等）
 * @param sessionManager 会话管理器，用于持久化与恢复会话
 * @param messages       命令行位置参数中的消息列表，按顺序逐条处理
 * @param jsonOutput     是否以 JSONL 输出（决定用 JsonRenderer 还是 ConsoleRenderer）
 */
async function runSingleShotMode(
	agentConfig: AgentConfig,
	sessionManager: SessionManager,
	messages: string[],
	jsonOutput: boolean,
): Promise<void> {
	const sessionData = sessionManager.getSessionData();
	const renderer = jsonOutput ? new JsonRenderer() : new ConsoleRenderer();
	const agent = new Agent(agentConfig, renderer, sessionManager);
	if (sessionData) {
		// 恢复提示只打印给人类看；JSON 输出模式混入杂音会破坏下游解析
		if (!jsonOutput) {
			console.log(chalk.dim(`Resuming session with ${sessionData.events.length} events`));
		}
		agent.setEvents(sessionData ? sessionData.events.map((e) => e.event) : []);
	}

	// ========== 顺序处理消息 ==========
	// Why：消息之间存在依赖（后一条可能引用前一条的回答），必须串行；
	// 单条失败只输出错误事件并继续，保证批量消息尽量全部执行完。
	for (const msg of messages) {
		try {
			await agent.ask(msg);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		}
	}
}

/**
 * 主函数：将 Agent 作为独立 CLI 使用时的完整入口。
 *
 * 编排流程：解析参数 → 校验 → 决定运行模式 → 分派到对应的模式函数。
 *
 * @param args 命令行参数数组（不含 node 与脚本路径）
 */
export async function main(args: string[]): Promise<void> {
	// 解析参数
	const parsed = parseArgs(argDefs, args);

	// 若请求了帮助信息（-h/--help）则打印并退出
	if (parsed.help) {
		printHelp();
		return;
	}

	// ========== 提取配置 ==========
	// 从解析结果中取出各配置项
	const baseURL = parsed["base-url"];
	const apiKey = parsed["api-key"];
	const model = parsed.model;
	const continueSession = parsed.continue;
	const api = parsed.api as "completions" | "responses";
	const systemPrompt = parsed["system-prompt"];
	const jsonOutput = parsed.json;
	const messages = parsed._; // 位置参数（即要发送的消息列表）

	if (!apiKey) {
		throw new Error("API key required (use --api-key or set OPENAI_API_KEY)");
	}

	// 决定模式：未提供消息则进入交互模式
	const isInteractive = messages.length === 0;

	// 创建会话管理器
	const sessionManager = new SessionManager(continueSession);

	// 创建或恢复 agent 配置
	let agentConfig: AgentConfig = {
		apiKey,
		baseURL,
		model,
		api,
		systemPrompt,
	};

	// ========== 恢复会话配置 ==========
	// Why：--continue 时优先沿用上次会话保存的配置（模型、base-url 等），
	// 保证"接着聊"的行为与之前一致；只放行 apiKey 覆盖，方便换凭证续跑。
	if (continueSession) {
		const sessionData = sessionManager.getSessionData();
		if (sessionData) {
			agentConfig = {
				...sessionData.config,
				apiKey, // 允许覆盖 API key
			};
		}
	}

	// ========== 分派运行模式 ==========
	// 交互（TUI / JSON 交互）或单发，见文件头说明
	if (isInteractive) {
		if (jsonOutput) {
			await runJsonInteractiveMode(agentConfig, sessionManager);
		} else {
			await runTuiInteractiveMode(agentConfig, sessionManager);
		}
	} else {
		await runSingleShotMode(agentConfig, sessionManager, messages, jsonOutput);
	}
}
