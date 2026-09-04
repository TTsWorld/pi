#!/usr/bin/env node
/**
 * @file cli.ts
 * @description pi-agent CLI 入口 —— 参数解析与三种运行模式（TUI 交互 / JSON 流 / 单次执行）
 * @module pi-agent
 *
 * 主要功能：
 * - 定义命令行参数（--base-url / --api-key / --model / --api / --system-prompt / --continue / --json 等），
 *   交给 args.ts 的类型化解析器 parseArgs 处理，并基于同一份定义生成帮助信息
 * - 根据是否传入位置参数（消息）与 --json 开关，选择三种运行模式之一：
 *   1. TUI 交互模式（runTuiInteractiveMode）：无位置参数且未开 --json，供人类用户在终端全屏交互
 *   2. JSON 流交互模式（runJsonInteractiveMode）：无位置参数且开启 --json，从 stdin 逐行读取 JSONL 命令驱动 agent
 *   3. 单次执行模式（runSingleShotMode）：带位置参数，逐条消息依次处理后退出，适合脚本化调用
 * - 通过 --continue/-c 恢复当前目录最近修改的会话：把历史事件灌回 agent 重建上下文（TUI 模式还会回放重绘）
 * - 文件尾通过 import.meta.url 判断本模块是"作为 bin 直接运行"还是"被其他包当库 import"，
 *   仅前者自动启动 CLI（main 同时导出供库调用，pods 包即以库方式复用）
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

// ========== 命令行参数定义 ==========
// 该定义同时服务于两处：parseArgs 据此做类型化解析，printHelp/printHelpArgs 据此生成帮助文本。
// 注意：description 等字符串会原样出现在 --help 输出中，故保持英文。
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

/** JSON 流交互模式下从 stdin 读到的命令格式（每行一个 JSON 对象） */
interface JsonCommand {
	/** 命令类型：message 发送一条用户消息；interrupt 中断当前正在处理的请求 */
	type: "message" | "interrupt";
	/** 消息正文，仅 type 为 message 时需要 */
	content?: string;
}

/**
 * 打印 CLI 帮助信息
 *
 * 组装 usage 与使用示例文本，再委托 args.ts 的 printHelpArgs 基于 argDefs 自动生成参数说明部分。
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
 * JSON 流交互模式（无位置参数且开启 --json）
 *
 * 适用场景：程序化驱动 agent（典型如作为子进程被其他程序调用）。
 * 协议：从 stdin 逐行读取 JSONL 命令（见 JsonCommand），agent 产生的事件经 JsonRenderer
 * 以 JSONL 形式写往 stdout；stdin 关闭（EOF）后本函数 resolve 返回。
 *
 * @param config agent 配置（API 地址/密钥/模型等）
 * @param sessionManager 会话管理器（负责会话持久化与恢复）
 */
async function runJsonInteractiveMode(config: AgentConfig, sessionManager: SessionManager): Promise<void> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false, // 不按终端处理输入、不解释控制字符（stdin 通常是管道/重定向，而非真实终端）
	});

	// JsonRenderer 把 agent 事件序列化为 JSONL 写往 stdout
	const renderer = new JsonRenderer();
	const agent = new Agent(config, renderer, sessionManager);
	// isProcessing：agent 是否正在处理一条消息；pendingMessage：处理期间到达的新消息（最多缓存一条）
	let isProcessing = false;
	let pendingMessage: string | null = null;

	/**
	 * 把一条消息交给 agent 处理并等待完成。
	 * 无论成功还是抛错，结束后若 pendingMessage 中存有排队消息，则取出并递归处理：
	 * 保证同一时刻只有一条消息在处理，后到的消息不会与进行中的请求并发，
	 * 从而维持会话事件的先后顺序——这正是 pendingMessage 队列存在的作用。
	 */
	const processMessage = async (content: string): Promise<void> => {
		isProcessing = true;

		try {
			await agent.ask(content);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		} finally {
			isProcessing = false;

			// 处理排队中的待发消息（若有的话）
			if (pendingMessage) {
				const msg = pendingMessage;
				pendingMessage = null;
				await processMessage(msg);
			}
		}
	};

	// 监听 stdin 的每一行输入，按 JSONL 协议解析并分发
	rl.on("line", (line) => {
		try {
			const command = JSON.parse(line) as JsonCommand;

			switch (command.type) {
				case "interrupt":
					// 中断当前正在处理的请求；同时复位 isProcessing，让下一条 message 立即处理而不排队
					agent.interrupt();
					isProcessing = false;
					break;

				case "message":
					if (!command.content) {
						renderer.on({ type: "error", message: "Message content is required" });
						return;
					}

					if (isProcessing) {
						// agent 正忙：把消息放入 pendingMessage 队列，待当前请求结束后再发送
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

	// 等待 stdin 关闭（EOF）后再返回，结束本模式
	await new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}

/**
 * TUI 交互模式（默认交互模式：无位置参数且未开启 --json）
 *
 * 适用场景：人类用户在终端中进行全屏交互聊天。
 * 流程：读取待恢复的会话（仅 --continue 时存在）→ 初始化 TUI 渲染器 → 创建 agent →
 * 回放历史事件 → 进入"读输入 → agent.ask()"的无限循环（直到进程被退出）。
 *
 * @param agentConfig agent 配置
 * @param sessionManager 会话管理器
 */
async function runTuiInteractiveMode(agentConfig: AgentConfig, sessionManager: SessionManager): Promise<void> {
	// 读取待恢复的会话数据（未指定 --continue 或无历史会话时为 null）
	const sessionData = sessionManager.getSessionData();
	if (sessionData) {
		console.log(chalk.dim(`Resuming session with ${sessionData.events.length} events`));
	}
	const renderer = new TuiRenderer();

	// 必须在创建 Agent 之前初始化 TUI，防止重复初始化
	await renderer.init();

	const agent = new Agent(agentConfig, renderer, sessionManager);
	// 注册中断回调：用户在 TUI 中触发中断时，转发给 agent.interrupt() 打断当前请求
	renderer.setInterruptCallback(() => {
		agent.interrupt();
	});

	if (sessionData) {
		// 会话回放分两步，且顺序不可颠倒：
		// 1) 先 setEvents() 把全部历史事件一次性灌回 agent，重建内部对话上下文（供后续 LLM 请求携带）
		agent.setEvents(sessionData ? sessionData.events.map((e) => e.event) : []);
		// 2) 再按事件的原始先后顺序逐条回放到渲染器，把历史对话重绘到屏幕上；
		//    其中 assistant_start 只渲染"助手标签行"，其余事件走 renderer.on() 常规重绘
		for (const sessionEvent of sessionData.events) {
			const event = sessionEvent.event;
			if (event.type === "assistant_start") {
				renderer.renderAssistantLabel();
			} else {
				await renderer.on(event);
			}
		}
	}

	// 主循环：不断读取用户输入并交给 agent 处理；单条消息报错不会退出循环，
	// 错误以 error 事件交给渲染器展示后继续等待下一次输入
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
 * 单次执行模式（命令行传入了位置参数消息）
 *
 * 适用场景：脚本化一次性调用，如 `pi-agent "What is 2+2?" "What about 3+3?"`。
 * 按传入顺序对每条消息调用 agent.ask() 串行处理（前一条的回复构成后一条的上下文），
 * 全部处理完后返回，进程随之退出。渲染器按 --json 二选一：JsonRenderer 输出 JSONL，
 * 否则 ConsoleRenderer 输出普通文本。
 *
 * 与交互模式不同：恢复会话时只把历史事件灌回 agent（提供上下文），不向渲染器回放重绘。
 *
 * @param agentConfig agent 配置
 * @param sessionManager 会话管理器
 * @param messages 位置参数消息列表（按顺序逐条处理）
 * @param jsonOutput 是否以 JSONL 输出（--json）
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
		if (!jsonOutput) {
			// JSON 输出时 stdout 必须保持纯 JSONL，恢复提示只在文本模式下打印
			console.log(chalk.dim(`Resuming session with ${sessionData.events.length} events`));
		}
		// 只把历史事件灌回 agent 重建上下文，不向渲染器回放（单次执行无需重绘历史）
		agent.setEvents(sessionData ? sessionData.events.map((e) => e.event) : []);
	}

	// 串行处理每条消息：单条报错不中断，错误交给渲染器输出后继续处理下一条
	for (const msg of messages) {
		try {
			await agent.ask(msg);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		}
	}
}

/**
 * CLI 主入口：解析参数、装配 agent 配置与会话，并分派到对应的运行模式。
 *
 * 该函数同时支持两种调用方式：作为 bin 直接运行（见文件尾 import.meta.url 判断处），
 * 或被其他包以库方式 import 后调用（如 monorepo 中的 pods 包），因此导出为公共 API。
 *
 * @param args 命令行参数数组（不含 node 与脚本路径，等价于 process.argv.slice(2)）
 */
export async function main(args: string[]): Promise<void> {
	// ========== 参数解析与帮助 ==========
	const parsed = parseArgs(argDefs, args);

	// 请求帮助时打印帮助信息并直接返回
	if (parsed.help) {
		printHelp();
		return;
	}

	// 从解析结果中提取配置项
	const baseURL = parsed["base-url"];
	const apiKey = parsed["api-key"];
	const model = parsed.model;
	const continueSession = parsed.continue;
	const api = parsed.api as "completions" | "responses";
	const systemPrompt = parsed["system-prompt"];
	const jsonOutput = parsed.json;
	const messages = parsed._; // 位置参数，即待发送的消息列表

	// API key 必填：来自 --api-key 参数或 OPENAI_API_KEY 环境变量
	if (!apiKey) {
		throw new Error("API key required (use --api-key or set OPENAI_API_KEY)");
	}

	// ========== 运行模式判定 ==========
	// 未提供任何位置参数则进入交互模式（TUI 或 JSON 流），否则单次执行
	const isInteractive = messages.length === 0;

	// 创建会话管理器：--continue 时定位当前目录最近修改的会话文件，否则新建会话
	const sessionManager = new SessionManager(continueSession);

	// ========== agent 配置装配 ==========
	// 默认使用本次命令行参数构造配置
	let agentConfig: AgentConfig = {
		apiKey,
		baseURL,
		model,
		api,
		systemPrompt,
	};

	// --continue 且存在历史会话时，改用旧会话保存的配置（沿用当时的模型、系统提示词等），
	// 但允许本次命令行的 --api-key 覆盖旧会话中保存的密钥
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
	// 交互模式：--json 走 JSON 流协议，否则走 TUI；带位置参数则进入单次执行模式
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

// ========== 双入口判断：作为 bin 直接运行 vs 被其他包当库 import ==========
// 原理：当本模块正是 node 直接执行的入口脚本时，import.meta.url（本模块文件的 URL）
// 恰好等于 `file://${process.argv[1]}`（node 实际运行的脚本路径），此时才自动启动 CLI；
// 若本模块只是被其他模块 import（例如 pods 包以库方式复用 main()），两个 URL 不相等，
// 这段代码不会执行——从而避免"一 import 本模块就跑起 CLI"的副作用，只导出 main 供调用方使用。
if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
