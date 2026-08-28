/**
 * @file rpc-client.ts —— RPC 模式客户端封装（以编程方式驱动编码 Agent）
 *
 * @description
 * 本文件实现 `RpcClient`：以子进程方式拉起 `pi --mode rpc`，并将其全部
 * RPC 命令封装为类型化的异步方法。它是「宿主程序 ↔ 编码 Agent」之间的
 * 通信桥梁，适用于测试脚本、IDE 集成等需要程序化操控 Agent 的场景。
 *
 * 主要功能点：
 * - 进程管理：start() 拉起子进程并挂接 stderr / exit / error / stdin 错误监听，
 *   stop() 先 SIGTERM 优雅退出、1s 后 SIGKILL 兜底；
 * - 事件订阅：stdout 上挂接严格 JSONL 行读取器，逐行解析后按
 *   「response 响应关联挂起请求 / 其余消息广播为事件」两条路径分流；
 * - 请求-响应关联：send() 为每条命令分配自增 id（req_N），配合 30s 超时
 *   与 pendingRequests 表完成 Promise 化的请求-响应匹配；
 * - 命令封装：prompt / steer / followUp / 模型与思考级别切换 / 会话管理
 *   （new / fork / clone / switch / compact）/ bash 执行等 30 余个类型化方法；
 * - 等待原语：waitForIdle / collectEvents / promptAndWait 基于
 *   agent_settled 事件实现「等待 Agent 空闲」的常用等待模式。
 *
 * 依赖关系：
 * - `node:child_process`：拉起并管理 Agent 子进程；
 * - `./jsonl.ts`：stdout 的 JSONL 行切分（attachJsonlLineReader）与命令序列化；
 * - `./rpc-types.ts`：RpcCommand / RpcResponse / RpcSessionState 等协议类型；
 * - `../json-event.ts`：Agent 会话事件（JsonAgentSessionEvent）类型。
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcCommand, RpcResponse, RpcSessionState, RpcSlashCommand } from "./rpc-types.ts";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 可分配（distributive）版 Omit：对联合类型的每个成员分别应用 Omit。
 *
 * 原生 `Omit` 会把联合类型摊平成单个键集合处理，导致结果丢失联合结构；
 * 这里利用条件类型在「裸类型参数」上自动分发的特性（`T extends unknown`），
 * 让 `Omit<T, K>` 逐成员求值后再重新组合为联合类型。
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * 去掉 id 字段的 RpcCommand：send() 内部组装命令体时使用，
 * id 由客户端统一分配后再合并（见 send()）。
 */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

/**
 * RpcClient 构造选项（全部可选）。
 */
export interface RpcClientOptions {
	/** CLI 入口文件路径（默认：dist/cli.js） */
	cliPath?: string;
	/** Agent 子进程的工作目录 */
	cwd?: string;
	/** 附加环境变量（在继承当前进程环境之上合并） */
	env?: Record<string, string>;
	/** 要使用的模型提供商 */
	provider?: string;
	/** 要使用的模型 ID */
	model?: string;
	/** 传给 CLI 的额外参数 */
	args?: string[];
}

/**
 * 模型元信息（getAvailableModels 返回列表中的单个条目）。
 */
export interface ModelInfo {
	/** 模型所属提供商 */
	provider: string;
	/** 模型 ID */
	id: string;
	/** 上下文窗口大小（token 数） */
	contextWindow: number;
	/** 是否支持推理（thinking）模式 */
	reasoning: boolean;
}

/**
 * Agent 事件监听器：stdout 上每条非响应的 JSONL 消息都会被解析为
 * JsonAgentSessionEvent，广播给所有已注册的监听器。
 */
export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

// ============================================================================
// RPC 客户端
// ============================================================================

/**
 * RPC 模式客户端：封装与 `pi --mode rpc` 子进程通信的完整生命周期。
 *
 * 典型用法：
 * ```ts
 * const client = new RpcClient({ cwd: projectDir });
 * await client.start();
 * client.onEvent((e) => handle(e));  // 订阅流式事件
 * await client.promptAndWait("hi");  // 发送 prompt 并等待完成
 * await client.stop();
 * ```
 *
 * 通信协议：命令经 stdin 以 JSONL 写入；响应与事件经 stdout 以 JSONL 返回，
 * 其中 `type === "response"` 且 id 匹配的消息用于兑现对应请求的 Promise，
 * 其余消息作为会话事件广播给监听器。
 */
export class RpcClient {
	/** Agent 子进程；null 表示尚未 start 或已 stop */
	private process: ChildProcess | null = null;
	/** 停止 stdout 行读取的清理函数（由 attachJsonlLineReader 返回） */
	private stopReadingStdout: (() => void) | null = null;
	/** 已注册的事件监听器列表 */
	private eventListeners: RpcEventListener[] = [];
	/** 挂起中的请求表：id → resolve/reject 回调，用于响应与请求的关联 */
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	/** 自增请求计数器，用于生成形如 req_1 / req_2 的请求 id */
	private requestId = 0;
	/** 子进程 stderr 的累积输出，拼入各类错误信息便于排查 */
	private stderr = "";
	/** 子进程异常退出/出错时记录的错误；后续 send() 会直接复用它抛出 */
	private exitError: Error | null = null;
	/** 构造时传入的选项 */
	private options: RpcClientOptions;

	/**
	 * @param options - 构造选项；只做保存，实际拉起子进程推迟到 start()
	 */
	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/**
	 * 拉起 RPC 模式的 Agent 子进程。
	 *
	 * 组装 `node <cliPath> --mode rpc [...]` 命令行并 spawn，
	 * 随后依次挂接 stderr 收集、进程退出/出错兜底与 stdout 的 JSONL 解析，
	 * 最后短暂等待初始化并检查进程是否「启动即崩溃」。
	 *
	 * @throws 重复启动，或进程在启动后立即退出（错误信息附带 stderr）
	 */
	async start(): Promise<void> {
		// 防止重复启动造成句柄泄漏
		if (this.process) {
			throw new Error("Client already started");
		}

		// 清除上一次生命周期残留的退出错误，允许 stop() 后重新 start()
		this.exitError = null;

		// 组装命令行：默认入口 dist/cli.js，强制以 RPC 模式运行
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		// 三个 stdio 均走管道：stdin 写命令、stdout 读 JSONL、stderr 收集诊断信息；
		// 环境变量在继承当前进程的基础上合并用户自定义项
		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;

		// 持续收集 stderr 便于调试：既累积到 this.stderr（拼入错误信息），也透传给本地 stderr
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		// 进程退出：记录错误并唤醒所有挂起请求，避免调用方 Promise 永久悬挂
		childProcess.once("exit", (code, signal) => {
			// 已被 stop() 清理的旧进程触发的事件，直接忽略
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		// spawn 本身失败（如找不到 node 可执行文件）
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		// stdin 写入出错（如管道破裂）；若已有更早的退出错误则沿用，避免覆盖真正的根因
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// 在 stdout 上挂接严格模式的 JSONL 行读取器，每读到一行就交给 handleLine 分流
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// 固定等待 100ms 让进程完成初始化：若启动即崩溃（如 CLI 路径错误），
		// 这点时间足以让 exit 事件先到达，从而在下方抛出带 stderr 的诊断信息
		await new Promise((resolve) => setTimeout(resolve, 100));

		// 启动即退出：优先复用 exit 处理器记录的 exitError（含 stderr），否则现场构造一个
		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	/**
	 * 停止 RPC Agent 子进程：先发 SIGTERM 优雅退出，1s 后仍未退出则 SIGKILL 强杀。
	 * 未启动时（process 为 null）静默返回；挂起请求由 exit 处理器统一 reject。
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		// 先停掉 stdout 行读取，避免 kill 过程中继续解析新消息
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// 等待进程退出（最长 1s）
		await new Promise<void>((resolve) => {
			// 超时兜底：优雅关闭失败就强杀，保证 stop() 不会永久挂起
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		// 释放引用；正常情况下挂起请求已被 exit 处理器清空，这里再兜底清一次
		this.process = null;
		this.pendingRequests.clear();
	}

	/**
	 * 订阅 Agent 事件流（stdout 上所有非响应类的 JSONL 消息）。
	 *
	 * @returns 取消订阅函数；内部用 indexOf 定位后移除，重复调用安全
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * 获取子进程 stderr 的累积输出（排查 Agent 进程问题时很有用）。
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// 命令方法
	// =========================================================================

	/**
	 * 向 Agent 发送一条用户 prompt。
	 *
	 * 发送后立即返回、不等待生成完成；流式事件通过 onEvent() 接收，
	 * 需要等待完成时配合 waitForIdle() 或直接使用 promptAndWait()。
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * 排队一条 steering 消息：在 Agent 运行中途插入，用于改变当前任务方向。
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * 排队一条 follow-up 消息：待 Agent 完成当前运行后再处理。
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * 中止当前正在进行的操作。
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * 开始新会话，可选父会话用于谱系（lineage）跟踪。
	 * @param parentSession - 可选的父会话路径，用于谱系跟踪
	 * @returns 若扩展（extension）取消了新会话，则返回 `{ cancelled: true }`
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * 获取当前会话状态。
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * 按提供商与模型 ID 设置当前模型。
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * 切换到模型列表中的下一个模型。
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * 获取可用模型列表。
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * 设置思考（thinking）级别。
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * 切换（循环）到下一个思考级别。
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * 获取当前模型支持的思考级别列表。
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * 设置 steering 消息的处理模式："all" 全部生效 / "one-at-a-time" 每轮仅取一条。
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * 设置 follow-up 消息的处理模式："all" 全部生效 / "one-at-a-time" 每轮仅取一条。
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * 压缩（compact）会话上下文。
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * 启用/禁用自动上下文压缩。
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * 启用/禁用自动重试。
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * 中止进行中的重试。
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * 在 Agent 侧执行一条 bash 命令。
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * 中止正在运行的 bash 命令。
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * 获取会话统计信息。
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * 将会话导出为 HTML 文件。
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * 切换到另一个会话文件。
	 * @returns 若扩展取消了切换，则返回 `{ cancelled: true }`
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * 从指定消息处分叉（fork）出新会话分支。
	 * @returns 包含 `text`（该消息文本）与 `cancelled`（扩展是否取消了操作）的对象
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * 把当前活跃分支克隆为一个新会话。
	 * @returns 若扩展取消了克隆，则返回 `{ cancelled: true }`
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * 获取可用于 fork 的消息列表。
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * 按追加顺序获取会话条目；提供 `since` 时只返回该条目 id 之后的部分。
	 */
	async getEntries(since?: string): Promise<{ entries: SessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: SessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * 获取会话条目树（包含分叉形成的分支结构）。
	 */
	async getTree(): Promise<{ tree: SessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: SessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * 获取最后一条助手消息的文本；无助手消息时返回 null。
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * 设置会话的显示名称。
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * 获取会话中的全部消息。
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * 获取可用命令列表（含扩展命令、prompt 模板、skills）。
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// 辅助方法
	// =========================================================================

	/**
	 * 等待 Agent 进入空闲状态（不再流式输出）。
	 *
	 * 收到 agent_settled 事件时 resolve；超时（默认 60s）则携带
	 * stderr 信息 reject，便于定位 Agent 进程侧的问题。
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			// 超时兜底：先退订再 reject，避免监听器泄漏
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				// agent_settled 是 Agent 完成当前运行、进入空闲的标志事件
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * 收集事件直到 Agent 空闲：订阅期间把事件逐个累积到数组，
	 * 收到 agent_settled 后一次性 resolve 整个数组（默认 60s 超时）。
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const events: JsonAgentSessionEvent[] = [];
			// 超时兜底：先退订再 reject，避免监听器泄漏
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				// 逐事件累积，直到 agent_settled 收尾
				events.push(event);
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * 发送 prompt 并等待本次运行完成，返回期间收集到的全部事件。
	 *
	 * 是 prompt() + collectEvents() + waitForIdle() 的组合便捷方法
	 * （默认 60s 超时）。
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		// 关键顺序：先订阅事件收集、再发送 prompt，确保不漏掉任何早期事件
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// 内部实现
	// =========================================================================

	/**
	 * stdout 单行消息的分流入口：JSON 解析后，
	 * 要么作为某个挂起请求的响应兑现其 Promise，要么作为事件广播。
	 */
	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			// 是某个挂起请求的响应：按 id 关联到对应的 Promise
			if (data.type === "response" && data.id && this.pendingRequests.has(data.id)) {
				const pending = this.pendingRequests.get(data.id)!;
				// 先删除表项再 resolve，确保同一 id 不会被匹配两次
				this.pendingRequests.delete(data.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// 其余消息一律视为会话事件，广播给所有已注册的监听器
			for (const listener of this.eventListeners) {
				listener(data as JsonAgentSessionEvent);
			}
		} catch {
			// 解析失败说明不是合法 JSON（如子进程意外打印的日志行），直接忽略
		}
	}

	/**
	 * 构造进程退出错误：附带退出码、结束信号与累积的 stderr
	 * （stderr 往往包含崩溃的真正原因）。
	 */
	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	/**
	 * 用统一错误 reject 所有挂起请求并清空表。
	 * 进程退出/崩溃时调用，唤醒所有还在等待响应的调用方，避免其 Promise 永久悬挂。
	 */
	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	/**
	 * 发送一条 RPC 命令并等待其响应（请求-响应关联的核心）。
	 *
	 * 发送前依次做四重前置检查：未启动 / 已记录退出错误 / 进程已退出 /
	 * stdin 不可写，任一失败立即抛错；随后分配自增 id、把命令序列化后写入
	 * stdin，并登记到 pendingRequests，由 handleLine 按 id 兑现（30s 超时）。
	 */
	private async send(command: RpcCommandBody): Promise<RpcResponse> {
		const childProcess = this.process;
		const stdin = childProcess?.stdin;
		// 检查一：尚未 start（或已 stop），无进程可发
		if (!childProcess || !stdin) {
			throw new Error("Client not started");
		}
		// 检查二：进程此前已出错/退出，直接复用记录的错误
		if (this.exitError) {
			throw this.exitError;
		}
		// 检查三：exit 事件还没来得及触发的竞态窗口，现场构造退出错误
		if (childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		// 检查四：stdin 已销毁或不可写（管道半关闭）
		if (stdin.destroyed || !stdin.writable) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		// 分配唯一且单调递增的请求 id（req_1、req_2、…），并合并进命令体
		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			// 30s 无响应则丢弃挂起表项并 reject，避免 Promise 永久悬挂
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			// 先登记挂起表项再写 stdin，确保响应到达时一定能找到对应的 Promise
			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			try {
				stdin.write(serializeJsonLine(fullCommand));
			} catch (error: unknown) {
				// 写入同步抛错（如 EPIPE）：手动 reject 挂起表项，防止 Promise 悬挂
				const writeError = error instanceof Error ? error : new Error(String(error));
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError);
			}
		});
	}

	/**
	 * 从 RpcResponse 中提取 data 负载：失败响应转抛 Error，成功响应断言为 T。
	 */
	private getData<T>(response: RpcResponse): T {
		// 失败响应：把服务端返回的错误文本转为本地异常抛出
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// 类型断言：信任 response.data 与所发命令对应的 T 相匹配。
		// 这是安全的，因为每个公有方法都为自己的命令指定了正确的 T。
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
