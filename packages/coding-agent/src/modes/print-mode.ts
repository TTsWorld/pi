/**
 * @file print-mode.ts —— 单发（print）模式：发完即走，供脚本 / 管道使用
 *
 * @description
 * 单发模式入口：发送 prompt → 输出结果 → 进程退出，全程没有交互式 UI。
 * 对应两种调用形式：
 * - `pi -p "prompt"`：文本模式，仅输出最终回复文本；
 * - `pi --mode json "prompt"`：JSON 事件流模式，把会话事件逐行（NDJSON）
 *   写到 stdout，供外部程序实时消费。
 *
 * 主要流程（见 {@link runPrintMode}）：
 * 1. 注册 SIGTERM / SIGHUP 信号处理，收到信号先终止分离子进程、释放 runtime 再退出；
 * 2. rebindSession 绑定会话：向扩展声明运行模式并注入会话操作能力，
 *    订阅会话事件（json 模式下逐行写出事件流）；
 * 3. 依次发送 initialMessage（可带图片）与 messages 中的追加 prompt；
 * 4. text 模式下从最后一条助手消息提取文本块输出，请求出错 / 中止时退出码置 1；
 * 5. finally 中统一收尾：注销信号处理器、释放 runtime、flush 原始 stdout。
 *
 * 依赖关系：
 * - `../core/agent-session-runtime.ts`：会话 runtime 宿主（创建 / 切换 / fork 会话）；
 * - `../core/output-guard.ts`：绕过行缓冲的原始 stdout 写入、背压等待与 flush；
 * - `./json-event.ts`：json 模式下把内部事件瘦身为线上传输格式（toJsonEvent）；
 * - `../utils/shell.ts`：退出前终止已跟踪的分离（detached）子进程。
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, waitForRawStdoutBackpressure, writeRawStdout } from "../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";
import { toJsonEvent } from "./json-event.ts";

/**
 * 单发模式的可配置选项。
 */
export interface PrintModeOptions {
	/** 输出模式："text" 仅输出最终回复文本；"json" 输出全部事件的 JSON 事件流 */
	mode: "text" | "json";
	/** 在 initialMessage 之后依次发送的追加 prompt 列表 */
	messages?: string[];
	/** 发送的第一条消息（可包含 @file 引用展开后的文件内容） */
	initialMessage?: string;
	/** 随首条消息一起发送的图片 */
	initialImages?: ImageContent[];
}

/**
 * 以单发（print）模式运行一次完整会话。
 *
 * 依次向 agent 发送 prompt 并按 mode 输出结果，结束后返回进程退出码：
 * 正常完成返回 0；最后一条助手消息 stopReason 为 error / aborted，
 * 或流程抛出异常时返回 1。
 *
 * json 模式下事件流以 NDJSON（每行一个 JSON 对象）写入 stdout，
 * 存在会话头（session header）时首行先输出它；
 * text 模式下仅输出最后一条助手消息中的文本块，其余事件不落 stdout。
 *
 * @param runtimeHost - 会话 runtime 宿主，负责会话创建 / 切换 / fork 与释放
 * @param options - 单发模式选项（输出模式、首条消息、追加消息、附带图片）
 * @returns 进程退出码：0 表示成功，1 表示失败
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	// session 可能被 newSession / switchSession 替换，用 let 跟踪最新会话
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;
	let disposed = false;
	// 记录已注册的信号处理器卸载函数，finally 中统一注销
	const signalCleanupHandlers: Array<() => void> = [];

	// ===== 一次性 runtime 清理（disposed 标记保证幂等，可被多处安全调用）=====
	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		unsubscribeBackpressure?.();
		await runtimeHost.dispose();
	};

	// ===== 信号处理：SIGTERM 必注册；SIGHUP 仅非 Windows（win32 无此信号）=====
	// 退出码遵循 shell 惯例 128 + 信号编号：SIGHUP(1) → 129，SIGTERM(15) → 143
	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// 先终止 shell 工具跟踪的分离子进程，避免进程退出后它们变成孤儿
				killTrackedDetachedChildren();
				// 等清理完成后再退出，防止输出被截断
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	// 注册「会话重绑定」回调：扩展触发 newSession / switchSession 等操作后，
	// runtimeHost 会换上新会话并回调此处，重新绑定扩展与事件订阅
	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	// 绑定（或重绑定）当前会话：每次会话被替换后都要重新执行一遍
	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		// 向扩展声明当前运行模式（json 模式对扩展同样按 json 处理），
		// 并注入扩展可调用的会话操作能力
		await session.bindExtensions({
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		// 重新订阅前先退订旧回调，避免泄漏到已被替换的 session
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// 会话事件订阅：json 模式下逐行写出瘦身后的 NDJSON 事件
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(toJsonEvent(event))}\n`);
			}
		});
		// json 模式：agent 每发一个事件就等待 stdout 背压排空，
		// 防止管道消费端读取过慢导致 Node 写缓冲无限膨胀
		unsubscribeBackpressure =
			mode === "json"
				? session.agent.subscribe(async () => {
						await waitForRawStdoutBackpressure();
					})
				: undefined;
	};

	try {
		// json 模式：先输出会话头（会话 id / 时间戳等元信息），供消费者定位会话文件
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		// ===== 依次发送 prompt：先发首条消息（可带图片），再逐条发送追加消息 =====
		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		// ===== text 模式：只输出最后一条助手消息的文本内容 =====
		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			// 最后一条必须是助手消息才有输出；以其他角色结尾（如中途失败）时静默返回
			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				// 请求出错或被中止：错误信息走 stderr，退出码置 1
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					// 正常结束：逐个输出文本块（跳过 thinking / toolCall 等非文本内容）
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		// 顶层兜底：异常只写到 stderr 并以退出码 1 结束，保持 stdout 干净便于管道消费
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		// 无论成败都执行：注销信号处理器、释放 runtime，最后 flush 确保原始 stdout 全部写出
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
