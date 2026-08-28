/**
 * @file rpc-mode.ts —— 无头 RPC 模式：stdin 收 JSONL 命令、stdout 发 JSONL 事件与响应
 *
 * @description
 * 供 IDE、Web UI 等外部进程以子进程方式嵌入编码代理：
 * 在 stdin 上逐行读取 JSON 命令，把响应与事件以 JSONL 写到 stdout。
 *
 * 协议要点：
 * - 命令：带 `type` 字段的 JSON 对象，可选 `id` 用于请求-响应关联；
 * - 响应：`type: "response"`，含 `command`、`success`，成功可带 `data`、失败带 `error`；
 * - 事件：AgentSessionEvent 经 toJsonEvent 转换后随发生随输出；
 * - 扩展 UI：扩展的弹窗等交互转为 extension_ui_request 发给客户端，
 *   客户端以 extension_ui_response 应答（见 createExtensionUIContext）。
 *
 * 依赖关系：
 * - AgentSessionRuntime：会话运行时宿主（新建/切换/fork 会话后需 rebind 重新绑定）；
 * - output-guard：独占 stdout 后的裸写、冲刷与背压等待；
 * - jsonl.ts：stdin/stdout 的 JSONL 分帧；
 * - rpc-types.ts：全部协议类型定义。
 */

import * as crypto from "node:crypto";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent } from "../json-event.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.ts";

// 再导出协议类型，消费方无需感知 rpc-types.ts 的具体路径
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc-types.ts";

/**
 * 以 RPC 模式运行：在 stdin 上监听 JSON 命令，在 stdout 上输出事件与响应。
 *
 * 本函数永不正常返回——结尾返回一个不 resolve 的 Promise 让进程常驻，
 * 退出只能经由 shutdown()：stdin 关闭、收到 SIGTERM/SIGHUP，
 * 或扩展请求退出且 agent 空闲时触发。
 *
 * @param runtimeHost - 会话运行时宿主，持有当前 session 并管理其生命周期
 */
export async function runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	// 独占 stdout：接管后所有输出必须经 writeRawStdout，
	// 防止任何库直接 console.log 污染 JSONL 协议流
	takeOverStdout();
	// session 可能被 runtimeHost 整体替换（新建/切换/fork），用 let 持有，
	// rebindSession 时更新为最新引用
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeBackpressure: (() => void) | undefined;

	// 统一出口：把响应/请求序列化为一行 JSONL 直接写裸 stdout
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeRawStdout(serializeJsonLine(obj));
	};

	// 构造成功响应；data 为 undefined 时省略 data 字段，
	// 显式传 null 则保留（如 cycle_model 无下一个模型时返回 null）
	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	// 构造失败响应：command 回显出错命令的类型，message 为人类可读的错误信息
	const error = (id: string | undefined, command: string, message: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message };
	};

	// 已发出、仍在等待客户端应答的扩展 UI 请求表：请求 id → Promise 控制器
	const pendingExtensionRequests = new Map<
		string,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();

	// 扩展请求退出时仅置位、不立即退出；待 agent_settled（agent 空闲）后
	// 再真正关机，避免打断进行中的回合
	let shutdownRequested = false;
	// 关机互斥标记：stdin end 与信号可能并发触发，防止重复清理
	let shuttingDown = false;
	// 信号处理器的注销函数列表，shutdown 时统一摘除
	const signalCleanupHandlers: Array<() => void> = [];

	/**
	 * 通用对话框 Promise 构造器：select / confirm / input 等弹窗方法共用，
	 * 统一处理 signal 中止与 timeout 超时。
	 *
	 * 发出 extension_ui_request 后挂起等待客户端应答；中止/超时一律按
	 * defaultValue resolve（视为取消，不 reject），只有底层 Promise 被
	 * reject 时才走异常路径。
	 */
	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: Record<string, unknown>,
		parseResponse: (response: RpcExtensionUIResponse) => T,
	): Promise<T> {
		// 进入时已中止：直接给默认值，不再发出请求
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

		const id = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;

			// 统一收尾：清掉定时器、摘除 abort 监听、从等待表中移除
			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				pendingExtensionRequests.delete(id);
			};

			// 外部中止：按默认值收场
			const onAbort = () => {
				cleanup();
				resolve(defaultValue);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			// 超时：同样按默认值收场
			if (opts?.timeout) {
				timeoutId = setTimeout(() => {
					cleanup();
					resolve(defaultValue);
				}, opts.timeout);
			}

			// 登记等待表并发出请求；应答回来时先收尾，再解析成目标值
			pendingExtensionRequests.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parseResponse(response));
				},
				reject,
			});
			output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
		});
	}

	/**
	 * 构造一个走 RPC 协议的扩展 UI 上下文。
	 *
	 * 把扩展的 TUI 交互映射为 extension_ui_request / extension_ui_response
	 * 消息；无法桥接的能力（自定义组件、主题切换、加载动画等）降级为空实现。
	 */
	const createExtensionUIContext = (): ExtensionUIContext => ({
		select: (title, options, opts) =>
			createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		confirm: (title, message, opts) =>
			createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
			),

		input: (title, placeholder, opts) =>
			createDialogPromise(opts, undefined, { method: "input", title, placeholder, timeout: opts?.timeout }, (r) =>
				"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
			),

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// 即发即弃：不需要客户端应答
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		},

		onTerminalInput(): () => void {
			// RPC 模式不支持裸终端输入：stdin 已被 JSONL 命令流占用
			return () => {};
		},

		setStatus(key: string, text: string | undefined): void {
			// 即发即弃：由宿主自行渲染状态栏片段
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		},

		// 以下四个 set* 都与 TUI 加载动画/消息渲染相关，RPC 模式没有 TUI，只能空实现
		setWorkingMessage(_message?: string): void {
			// RPC 模式不支持工作消息——需要 TUI loader 访问权限
		},

		setWorkingVisible(_visible: boolean): void {
			// RPC 模式不支持工作动画显隐——需要 TUI loader 访问权限
		},

		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
			// RPC 模式不支持自定义工作动画——需要 TUI loader 访问权限
		},

		setHiddenThinkingLabel(_label?: string): void {
			// RPC 模式不支持隐藏思考的标签——需要 TUI 消息渲染权限
		},

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// RPC 模式只支持字符串数组形式的小部件内容
			if (content === undefined || Array.isArray(content)) {
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// 组件工厂在 RPC 模式下不可用——渲染需要 TUI 访问权限，只能忽略
		},

		setFooter(_factory: unknown): void {
			// RPC 模式不支持自定义页脚——需要 TUI 访问权限
		},

		setHeader(_factory: unknown): void {
			// RPC 模式不支持自定义页眉——需要 TUI 访问权限
		},

		setTitle(title: string): void {
			// 即发即弃——宿主可据此实现终端标题控制
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		},

		async custom() {
			// RPC 模式不支持自定义 UI：宿主侧没有可复用的 TUI 组件体系
			return undefined as never;
		},

		pasteToEditor(text: string): void {
			// RPC 模式没有「粘贴」语义——退化为整体替换编辑器文本
			this.setEditorText(text);
		},

		setEditorText(text: string): void {
			// 即发即弃——宿主可据此实现编辑器控制
			output({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		},

		getEditorText(): string {
			// 同步方法无法等待 RPC 往返应答，只能返回空串；
			// 宿主如需编辑器内容，应在本地自行维护状态
			return "";
		},

		// editor 对话框：与 createDialogPromise 不同，此处不支持 signal/timeout，
		// 客户端取消或回发非 value 形态时一律 resolve(undefined)
		async editor(title: string, prefill?: string): Promise<string | undefined> {
			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						if ("cancelled" in response && response.cancelled) {
							resolve(undefined);
						} else if ("value" in response) {
							resolve(response.value);
						} else {
							resolve(undefined);
						}
					},
					reject,
				});
				output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
			});
		},

		addAutocompleteProvider(): void {
			// RPC 模式不支持组合自动补全 provider：补全 UI 属于宿主
		},

		setEditorComponent(): void {
			// RPC 模式不支持自定义编辑器组件
		},

		getEditorComponent() {
			// RPC 模式不支持自定义编辑器组件
			return undefined;
		},

		// 主题：RPC 客户端通常有自己的配色体系，这里只暴露默认 theme，
		// 不提供主题枚举与切换
		get theme() {
			return theme;
		},

		getAllThemes() {
			return [];
		},

		getTheme(_name: string) {
			return undefined;
		},

		setTheme(_theme: string | Theme) {
			// RPC 模式不支持主题切换
			return { success: false, error: "Theme switching not supported in RPC mode" };
		},

		getToolsExpanded() {
			// RPC 模式无 TUI，不存在工具消息的展开/收起状态
			return false;
		},

		setToolsExpanded(_expanded: boolean) {
			// RPC 模式无 TUI，工具展开状态无处生效
		},
	});

	// 注册会话重绑钩子：runtimeHost 在 newSession/switchSession/fork 之后回调它，
	// 让 RPC 层把扩展绑定与事件订阅切到新的 session 对象上
	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	/**
	 * 把扩展绑定与事件订阅切换到当前 session。
	 *
	 * session 对象在新建/切换/fork 后会被整体替换（引用变化），
	 * 因此必须先退订旧 session 的订阅，再对新 session 重挂。
	 */
	const rebindSession = async (): Promise<void> => {
		// 每次重绑都取宿主当前持有的最新 session
		session = runtimeHost.session;
		// 以 RPC 协议重新绑定扩展：UI 上下文、命令可触发的会话级操作、
		// 关机与错误上报回调都接到当前 session/runtimeHost 上
		await session.bindExtensions({
			uiContext: createExtensionUIContext(),
			mode: "rpc",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await session.reload();
				},
			},
			shutdownHandler: () => {
				// 扩展请求退出：只置标记，等 agent 空闲再真正关机
				shutdownRequested = true;
			},
			onError: (err) => {
				// 扩展内部异常以 extension_error 事件告知客户端，不影响主流程
				output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
			},
		});

		// 先退订旧 session，避免继续向已被替换的会话订阅
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// 会话事件 → JSONL 输出；agent_settled（回合落定）时顺带检查待关机请求
		unsubscribe = session.subscribe((event) => {
			output(toJsonEvent(event));
			if (event.type === "agent_settled") {
				void checkShutdownRequested();
			}
		});
		// agent 的每个回合之间等待 stdout 排空再继续，
		// 防止事件洪峰写满管道导致下游读取端阻塞
		unsubscribeBackpressure = session.agent.subscribe(async () => {
			await waitForRawStdoutBackpressure();
		});
	};

	// 注册 SIGTERM / SIGHUP 处理器：先杀掉跟踪的分离子进程，再走统一关机流程
	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		// Windows 平台没有 SIGHUP
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				// 退出码遵循 shell 约定 128+信号编号：SIGHUP(1)→129、SIGTERM(15)→143
				void shutdown(signal === "SIGHUP" ? 129 : 143, signal);
			};
			// 处理器同时登记注销函数，关机时统一摘除，避免退出过程中再次响应信号
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	await rebindSession();
	registerSignalHandlers();

	/**
	 * 处理单条命令，返回应回发的响应。
	 *
	 * 返回 undefined 表示该命令自行负责发响应（目前只有 prompt：
	 * 响应时机取决于 preflight 结果），调用方不再补发。
	 */
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse | undefined> => {
		// 命令自带的关联 id，原样带回响应供客户端配对
		const id = command.id;

		switch (command.type) {
			// =================================================================
			// 提示与输入
			// =================================================================

			case "prompt": {
				// 立即启动 prompt 处理，但权威响应要等 preflight 成功后才发：
				// 消息被排队、或当轮立即处理的 prompt 同样算成功；
				// 若 preflight 之前就抛错（如校验失败），则改为回发错误响应
				let preflightSucceeded = false;
				void session
					.prompt(command.message, {
						images: command.images,
						streamingBehavior: command.streamingBehavior,
						source: "rpc",
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								preflightSucceeded = true;
								output(success(id, "prompt"));
							}
						},
					})
					.catch((e) => {
						if (!preflightSucceeded) {
							output(error(id, "prompt", e.message));
						}
					});
				return undefined;
			}

			// steer：向进行中的回合注入转向消息
			case "steer": {
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			// follow_up：把消息排队到当前回合结束后再投放
			case "follow_up": {
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			// abort：中断当前回合（进行中的 LLM 调用与工具执行）
			case "abort": {
				await session.abort();
				return success(id, "abort");
			}

			case "new_session": {
				const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
				const result = await runtimeHost.newSession(options);
				// 未被取消说明 session 已被替换，需要重绑订阅与扩展
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "new_session", result);
			}

			// =================================================================
			// 状态
			// =================================================================

			case "get_state": {
				// 现场采集一份会话状态快照（字段含义见 RpcSessionState）
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					pendingMessageCount: session.pendingMessageCount,
				};
				return success(id, "get_state", state);
			}

			// =================================================================
			// 模型
			// =================================================================

			case "set_model": {
				// 先在当前可用模型快照中按 provider/modelId 精确匹配，
				// 找不到直接报错，不触碰当前模型
				const models = session.modelRuntime.getAvailableSnapshot();
				const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
				if (!model) {
					return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				// null 表示没有可切换的下一个模型（如会话固定了模型），同样算成功
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "get_available_models": {
				const models = session.modelRuntime.getAvailableSnapshot();
				return success(id, "get_available_models", { models });
			}

			// =================================================================
			// 思考级别
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				// 当前模型不支持思考级别时返回 null，同样视为成功
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				const levels = session.getAvailableThinkingLevels();
				return success(id, "get_available_thinking_levels", { levels });
			}

			// =================================================================
			// 排队模式
			// =================================================================

			// 排队模式决定多条 steer/followUp 消息是全部投放还是每回合只投一条
			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			// 语义同上，作用于 followUp 队列
			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			// =================================================================
			// 上下文压缩
			// =================================================================

			case "compact": {
				// 手动压缩上下文；customInstructions 可附加到压缩摘要指令中
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			// 开关「上下文接近上限时自动压缩」
			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// 自动重试
			// =================================================================

			// 开关 LLM 调用失败后的自动重试
			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			// 放弃当前的自动重试等待
			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash 执行
			// =================================================================

			case "bash": {
				// 先广播 user_bash 事件，给扩展拦截/改写/直接代执行的机会
				const eventResult = await session.extensionRunner.emitUserBash({
					type: "user_bash",
					command: command.command,
					excludeFromContext: command.excludeFromContext ?? false,
					cwd: session.sessionManager.getCwd(),
				});

				// 扩展已直接给出结果：跳过本地执行，仅把结果记入会话上下文
				if (eventResult?.result) {
					session.recordBashResult(command.command, eventResult.result, {
						excludeFromContext: command.excludeFromContext,
					});
					return success(id, "bash", eventResult.result);
				}

				// 正常路径：交给 session 执行 bash；带上命令 id 供 abort_bash 定位取消
				const result = await session.executeBash(command.command, undefined, {
					excludeFromContext: command.excludeFromContext,
					id,
					operations: eventResult?.operations,
				});
				return success(id, "bash", result);
			}

			// 取消正在执行的 bash（对应带 id 的 bash 命令）
			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			// =================================================================
			// 会话管理
			// =================================================================

			// 会话用量统计（token、轮次等）
			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			// 导出会话为 HTML；未指定路径时由 session 选择默认位置
			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "switch_session": {
				const result = await runtimeHost.switchSession(command.sessionPath);
				// 切换成功后 session 引用已变，重绑订阅与扩展
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "switch_session", result);
			}

			case "fork": {
				// 从指定条目处分叉出新会话分支；text 为选中的分支文本（供 UI 回显）
				const result = await runtimeHost.fork(command.entryId);
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
			}

			case "clone": {
				// clone 等价于在当前叶子条目处「原地」fork；空会话没有叶子可选，直接报错
				const leafId = session.sessionManager.getLeafId();
				if (!leafId) {
					return error(id, "clone", "Cannot clone session: no current entry selected");
				}
				const result = await runtimeHost.fork(leafId, { position: "at" });
				if (!result.cancelled) {
					await rebindSession();
				}
				return success(id, "clone", { cancelled: result.cancelled });
			}

			case "get_fork_messages": {
				// 列出可作分叉点的历史用户消息（entryId + 文本），供客户端挑选
				const messages = session.getUserMessagesForForking();
				return success(id, "get_fork_messages", { messages });
			}

			case "get_entries": {
				const sessionManager = session.sessionManager;
				let entries = sessionManager.getEntries();
				// since 是排他游标：只返回该条目之后的新条目，实现增量拉取
				if (command.since !== undefined) {
					const sinceIndex = entries.findIndex((e) => e.id === command.since);
					if (sinceIndex === -1) {
						return error(id, "get_entries", `Entry not found: ${command.since}`);
					}
					entries = entries.slice(sinceIndex + 1);
				}
				return success(id, "get_entries", { entries, leafId: sessionManager.getLeafId() });
			}

			case "get_tree": {
				// 返回会话树（含分支结构）与当前所在叶子，供客户端渲染树形导航
				const sessionManager = session.sessionManager;
				return success(id, "get_tree", { tree: sessionManager.getTree(), leafId: sessionManager.getLeafId() });
			}

			case "get_last_assistant_text": {
				// 取最后一条助手消息的纯文本；尚无助手回复时为 null
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				// 去除首尾空白后不允许空名
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				session.setSessionName(name);
				return success(id, "set_session_name");
			}

			// =================================================================
			// 消息读取
			// =================================================================

			// 返回当前上下文的全部消息（AgentMessage 原样）
			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			// =================================================================
			// 斜杠命令（可通过 prompt 调用）
			// =================================================================

			case "get_commands": {
				// 汇总三类可通过 prompt 调用的命令：扩展命令、prompt 模板、skill
				const commands: RpcSlashCommand[] = [];

				// 1) 扩展注册的命令
				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push({
						name: command.invocationName,
						description: command.description,
						source: "extension",
						sourceInfo: command.sourceInfo,
					});
				}

				// 2) prompt 模板
				for (const template of session.promptTemplates) {
					commands.push({
						name: template.name,
						description: template.description,
						source: "prompt",
						sourceInfo: template.sourceInfo,
					});
				}

				// 3) skill（命令名带 skill: 前缀）
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push({
						name: `skill:${skill.name}`,
						description: skill.description,
						source: "skill",
						sourceInfo: skill.sourceInfo,
					});
				}

				return success(id, "get_commands", { commands });
			}

			default: {
				// 类型穷尽后仍落到这里，说明客户端发来了未知命令；原样回显其 type
				const unknownCommand = command as { type: string };
				return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	};

	/**
	 * 若扩展已请求关机则执行关机。
	 *
	 * 在每条命令处理完、以及 agent_settled 事件之后调用，
	 * 保证不打断进行中的回合。
	 */
	// 汇总输入侧监听的卸载函数，shutdown 时调用；先声明以便 shutdown 引用
	let detachInput = () => {};

	/**
	 * 统一关机：摘信号处理器、退订事件、释放 runtimeHost、停输入后退出进程。
	 *
	 * SIGTERM 路径不 flush stdout——SIGTERM 的默认语义就是尽快终止；
	 * 其余路径先把缓冲中的 JSONL 冲干净再退，避免客户端丢失尾部事件。
	 * 已在关机中时再次调用会立即按给定退出码退出（首个调用仍在清理）。
	 */
	async function shutdown(exitCode = 0, signal?: NodeJS.Signals): Promise<never> {
		// 重入：清理流程只跑一次，后续调用直接退出
		if (shuttingDown) {
			process.exit(exitCode);
		}
		shuttingDown = true;
		// 摘除信号处理器，避免清理途中再次响应信号
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		// 退订旧订阅，之后不再产生新的 JSONL 输出
		unsubscribe?.();
		unsubscribeBackpressure?.();
		// 释放扩展、MCP 等运行时资源
		await runtimeHost.dispose();
		// 先停输入再冲刷输出，保证关机途中不再产生新的输出
		detachInput();
		process.stdin.pause();
		if (signal !== "SIGTERM") {
			await flushRawStdout();
		}
		process.exit(exitCode);
	}

	async function checkShutdownRequested(): Promise<void> {
		if (!shutdownRequested) return;
		await shutdown();
	}

	// 处理一行输入：JSON 解析 → 路由（扩展 UI 响应或命令）→ 回发响应
	const handleInputLine = async (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (parseError: unknown) {
			// 解析失败：以 command="parse" 回错（此时尚无 id 可关联），不中断读行循环
			output(
				error(
					undefined,
					"parse",
					`Failed to parse command: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}

		// 扩展 UI 响应：按 id 找到挂起的 Promise 并唤醒；找不到（已超时/中止）则忽略
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"type" in parsed &&
			parsed.type === "extension_ui_response"
		) {
			const response = parsed as RpcExtensionUIResponse;
			const pending = pendingExtensionRequests.get(response.id);
			if (pending) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
			return;
		}

		const command = parsed as RpcCommand;
		try {
			const response = await handleCommand(command);
			if (response) {
				output(response);
				// 每次写出后等待 stdout 排空，与客户端形成流控
				await waitForRawStdoutBackpressure();
			}
			// 每条命令处理完都检查扩展是否已请求关机
			await checkShutdownRequested();
		} catch (commandError: unknown) {
			// 命令执行异常：转成该命令的错误响应，而不是让进程崩溃
			output(
				error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				),
			);
			await waitForRawStdoutBackpressure();
		}
	};

	// stdin 关闭（客户端退出/管道断开）：按退出码 0 走关机流程
	const onInputEnd = () => {
		void shutdown();
	};
	process.stdin.on("end", onInputEnd);

	// 挂接 JSONL 读行器，逐行异步处理命令；
	// detachInput 汇总输入侧全部监听，供 shutdown 一次性卸载
	detachInput = (() => {
		const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
			// 异步处理，不阻塞读行循环；错误已兜底为错误响应
			void handleInputLine(line);
		});
		return () => {
			detachJsonl();
			process.stdin.off("end", onInputEnd);
		};
	})();

	// 返回永不 resolve 的 Promise：进程常驻，退出只能走 shutdown()
	return new Promise(() => {});
}
