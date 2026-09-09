/**
 * @file tui-renderer.ts
 * @description pi monorepo agent 包交互模式的 TUI（终端用户界面）渲染器。
 *
 * 实现 AgentEventReceiver 接口，把 Agent 循环产生的各类事件（assistant 消息、
 * 思考过程、工具调用/结果、token 用量、错误、中断等）渲染到终端。
 *
 * 五层垂直布局（自上而下）：
 * 1. header        —— 标题与按键提示
 * 2. chatContainer —— 聊天历史（用户消息、assistant 消息、thinking、工具调用与结果）
 * 3. statusContainer —— 状态区（加载动画 "Thinking..."、Ctrl+C 退出提示）
 * 4. editor        —— 文本输入编辑器（支持斜杠命令与文件路径自动补全）
 * 5. tokenContainer —— 单行 token 用量统计（最近一次请求的 input/output/cache 等）
 *
 * 交互约定：
 * - 处理中按 Esc 触发中断回调（onInterruptCallback）
 * - 单击 Ctrl+C 清空编辑器；500ms 内双击 Ctrl+C 直接退出进程
 * - getUserInput() 返回挂起的 Promise，等待编辑器提交后 resolve
 *
 * 依赖关系：
 * - @mariozechner/pi-tui：TUI 框架（TUI / Container / TextComponent / TextEditor 等）
 * - ../agent.js：AgentEvent 事件类型与 AgentEventReceiver 接口
 * - chalk：终端着色
 */
import {
	CombinedAutocompleteProvider,
	Container,
	MarkdownComponent,
	TextComponent,
	TextEditor,
	TUI,
	WhitespaceComponent,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import type { AgentEvent, AgentEventReceiver } from "../agent.js";

/**
 * 加载动画组件（"Thinking..." 布林盲文旋转帧）。
 *
 * 继承 TextComponent，以 80ms 为周期循环播放盲文旋转字符，
 * 模拟 assistant 正在思考的效果；处理结束后需调用 stop() 停止定时器。
 */
class LoadingAnimation extends TextComponent {
	/** 布林盲文旋转帧序列 */
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	/** 当前帧下标 */
	private currentFrame = 0;
	/** 帧切换定时器句柄，stop() 后置空 */
	private intervalId: NodeJS.Timeout | null = null;
	/** 持有 TUI 实例以便每次换帧后请求重绘 */
	private ui: TUI | null = null;

	/**
	 * @param ui TUI 实例，用于换帧后触发重绘
	 */
	constructor(ui: TUI) {
		super("", { bottom: 1 });
		this.ui = ui;
		this.start();
	}

	/** 启动动画：先立即渲染第一帧，再以 80ms 间隔循环切换帧 */
	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
	}

	/** 停止动画并清除定时器，避免组件销毁后定时器仍在触发 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** 渲染当前帧（旋转字符 + "Thinking..." 弱化文本）并请求 TUI 重绘 */
	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		this.setText(`${chalk.cyan(frame)} ${chalk.dim("Thinking...")}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}

/**
 * 交互模式终端渲染器。
 *
 * 实现 AgentEventReceiver：Agent 主循环每产生一个事件就调用 on()，
 * 渲染器根据事件类型更新对应的 UI 组件（事件驱动，而非主动轮询）。
 */
export class TuiRenderer implements AgentEventReceiver {
	/** TUI 框架根实例，负责整体渲染与键盘输入 */
	private ui: TUI;
	/** 聊天历史容器：用户/assistant 消息、thinking、工具调用与结果 */
	private chatContainer: Container;
	/** 状态容器：加载动画、Ctrl+C 退出提示等临时信息 */
	private statusContainer: Container;
	/** 底部文本编辑器，用户在此输入消息 */
	private editor: TextEditor;
	/** token 用量显示容器（布局最底部一行） */
	private tokenContainer: Container;
	/** init() 是否已执行过，防止重复初始化 */
	private isInitialized = false;
	/** 编辑器提交回调，由 getUserInput() 设置，用于把用户输入传回调用方 */
	private onInputCallback?: (text: string) => void;
	/** 当前正在播放的加载动画实例，无动画时为 null */
	private currentLoadingAnimation: LoadingAnimation | null = null;
	/** Esc 中断回调，处理中按 Esc 时触发（由外部注入中断 Agent 循环） */
	private onInterruptCallback?: () => void;
	/** 上一次 Ctrl+C 的时间戳，用于实现「500ms 内双击退出」 */
	private lastSigintTime = 0;
	// ===== 最近一次请求的 token 计数（非累计，见 token_usage 事件说明）=====
	private lastInputTokens = 0;
	private lastOutputTokens = 0;
	private lastCacheReadTokens = 0;
	private lastCacheWriteTokens = 0;
	private lastReasoningTokens = 0;
	/** 本次会话中（当前 assistant 回合内）的工具调用次数 */
	private toolCallCount = 0;
	// 累计 token 统计（跨所有请求求和，供 /tokens 命令展示）
	private cumulativeInputTokens = 0;
	private cumulativeOutputTokens = 0;
	private cumulativeCacheReadTokens = 0;
	private cumulativeCacheWriteTokens = 0;
	private cumulativeReasoningTokens = 0;
	private cumulativeToolCallCount = 0;
	/** token 状态行组件引用（当前未直接使用，仅保留句柄） */
	private tokenStatusComponent: TextComponent | null = null;

	/** 构造函数：创建 TUI 实例与各层容器组件，并配置编辑器自动补全 */
	constructor() {
		this.ui = new TUI();
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.editor = new TextEditor();
		this.tokenContainer = new Container();

		// 为文件路径和斜杠命令设置自动补全
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[
				{
					name: "tokens",
					description: "Show cumulative token usage for this session",
				},
			],
			process.cwd(), // 文件路径补全的基准目录
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
	}

	/**
	 * 初始化并启动 TUI。
	 *
	 * 幂等：已初始化则直接返回。负责构建五层布局、注册全局按键处理
	 * （Esc 中断 / Ctrl+C 清空或退出）以及编辑器提交（斜杠命令与普通消息）。
	 */
	async init(): Promise<void> {
		if (this.isInitialized) return;

		// ========== 头部：标题与按键说明 ==========
		const header = new TextComponent(
			chalk.gray(chalk.blueBright(">> pi interactive chat <<<")) +
				"\n" +
				chalk.dim("Press Escape to interrupt while processing") +
				"\n" +
				chalk.dim("Press CTRL+C to clear the text editor") +
				"\n" +
				chalk.dim("Press CTRL+C twice quickly to exit"),
			{ bottom: 1 },
		);

		// ========== 组装五层 UI 布局 ==========
		// 顺序即渲染顺序：header / 聊天 / 状态 / 空行间隔 / 编辑器 / token 行
		this.ui.addChild(header);
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(new WhitespaceComponent(1));
		this.ui.addChild(this.editor);
		this.ui.addChild(this.tokenContainer);
		// 焦点固定在编辑器上，键盘输入默认进入输入框
		this.ui.setFocus(this.editor);

		// ========== 全局按键拦截：Escape 与 Ctrl+C ==========
		// 返回 true 表示继续把按键转发给聚焦的编辑器，false 表示拦截
		this.ui.onGlobalKeyPress = (data: string): boolean => {
			// 处理中按 Escape：触发中断
			if (data === "\x1b" && this.currentLoadingAnimation) {
				// 若设置了中断回调则调用（由外部决定如何中断 Agent 循环）
				if (this.onInterruptCallback) {
					this.onInterruptCallback();
				}

				// 这里不做任何 UI 清理 —— 交给 interrupted 事件处理
				// 这样可以避免竞态条件，并确保中断消息被正确显示

				// 不转发给编辑器
				return false;
			}

			// 处理 Ctrl+C（raw mode 下发送 \x03）
			if (data === "\x03") {
				const now = Date.now();
				const timeSinceLastCtrlC = now - this.lastSigintTime;

				if (timeSinceLastCtrlC < 500) {
					// 500ms 内第二次 Ctrl+C —— 退出
					this.stop();
					process.exit(0);
				} else {
					// 第一次 Ctrl+C —— 清空编辑器
					this.clearEditor();
					this.lastSigintTime = now;
				}

				// 不转发给编辑器
				return false;
			}

			// 其余按键正常转发
			return true;
		};

		// ========== 编辑器提交处理：斜杠命令与普通消息 ==========
		this.editor.onSubmit = (text: string) => {
			text = text.trim();
			if (!text) return;

			// 处理斜杠命令
			if (text.startsWith("/")) {
				const [command, ...args] = text.slice(1).split(" ");
				if (command === "tokens") {
					this.showTokenUsage();
					return;
				}
				// 未知斜杠命令，忽略
				return;
			}

			// 普通消息交给输入回调（即 getUserInput() 挂起的 Promise）
			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
		};

		// ========== 启动 UI ==========
		await this.ui.start();
		this.isInitialized = true;
	}

	/**
	 * AgentEventReceiver 接口实现：接收 Agent 事件并分发到对应 UI 更新。
	 *
	 * 首次调用时会先完成 UI 懒初始化；事件处理完毕后统一请求一次重绘。
	 * @param event Agent 循环产生的当前事件
	 */
	async on(event: AgentEvent): Promise<void> {
		// 确保 UI 已初始化（懒初始化，避免构造函数里就接管终端）
		if (!this.isInitialized) {
			await this.init();
		}

		switch (event.type) {
			// assistant 回合开始：显示标签、锁定编辑器提交、启动加载动画
			case "assistant_start":
				this.chatContainer.addChild(new TextComponent(chalk.hex("#FFA500")("[assistant]")));
				// 处理期间禁用编辑器提交，防止并发发起多条消息
				this.editor.disableSubmit = true;
				// 在状态容器中启动加载动画
				this.statusContainer.clear();
				this.currentLoadingAnimation = new LoadingAnimation(this.ui);
				this.statusContainer.addChild(this.currentLoadingAnimation);
				break;

			// 思考过程：以弱化（dim）文本逐行显示
			case "reasoning": {
				// 用弱化文本展示 thinking
				const thinkingContainer = new Container();
				thinkingContainer.addChild(new TextComponent(chalk.dim("[thinking]")));

				// 按行拆分 thinking 文本以便更好地展示
				const thinkingLines = event.text.split("\n");
				for (const line of thinkingLines) {
					thinkingContainer.addChild(new TextComponent(chalk.dim(line)));
				}
				thinkingContainer.addChild(new WhitespaceComponent(1));
				this.chatContainer.addChild(thinkingContainer);
				break;
			}

			// 工具调用：显示调用签名，并累加工具调用计数
			case "tool_call":
				this.toolCallCount++;
				this.cumulativeToolCallCount++;
				this.updateTokenDisplay();
				this.chatContainer.addChild(new TextComponent(chalk.yellow(`[tool] ${event.name}(${event.args})`)));
				break;

			// 工具结果：最多显示前 10 行，超出部分截断并提示剩余行数
			case "tool_result": {
				// 展示工具结果（带截断）
				const lines = event.result.split("\n");
				const maxLines = 10;
				const truncated = lines.length > maxLines;
				const toShow = truncated ? lines.slice(0, maxLines) : lines;

				const resultContainer = new Container();
				for (const line of toShow) {
					// 出错的结果显示为红色，正常结果为灰色
					resultContainer.addChild(new TextComponent(event.isError ? chalk.red(line) : chalk.gray(line)));
				}

				if (truncated) {
					resultContainer.addChild(new TextComponent(chalk.dim(`... (${lines.length - maxLines} more lines)`)));
				}
				resultContainer.addChild(new WhitespaceComponent(1));
				this.chatContainer.addChild(resultContainer);
				break;
			}

			// assistant 正式回复：停止动画、恢复编辑器，用 Markdown 渲染消息
			case "assistant_message":
				// assistant 响应时停止加载动画
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.currentLoadingAnimation = null;
					this.statusContainer.clear();
				}
				// 重新启用编辑器提交
				this.editor.disableSubmit = false;
				// 使用 MarkdownComponent 渲染富文本格式
				this.chatContainer.addChild(new MarkdownComponent(event.text));
				this.chatContainer.addChild(new WhitespaceComponent(1));
				break;

			// 错误：停止动画、恢复编辑器，红色显示错误信息
			case "error":
				// 出错时停止加载动画
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.currentLoadingAnimation = null;
					this.statusContainer.clear();
				}
				// 重新启用编辑器提交
				this.editor.disableSubmit = false;
				this.chatContainer.addChild(new TextComponent(chalk.red(`[error] ${event.message}`), { bottom: 1 }));
				break;

			// 用户消息：回显绿色 [user] 标签与消息内容
			case "user_message":
				// 渲染用户消息
				this.chatContainer.addChild(new TextComponent(chalk.green("[user]")));
				this.chatContainer.addChild(new TextComponent(event.text, { bottom: 1 }));
				break;

			// token 用量：更新「最近一次」计数并累加会话累计值
			case "token_usage":
				// 保存最近一次 token 计数（非累计，因为 prompt 包含完整上下文，
				// 每次事件的数值都是「该次请求」的量，而非增量）
				this.lastInputTokens = event.inputTokens;
				this.lastOutputTokens = event.outputTokens;
				this.lastCacheReadTokens = event.cacheReadTokens;
				this.lastCacheWriteTokens = event.cacheWriteTokens;
				this.lastReasoningTokens = event.reasoningTokens;

				// 累加累计总量（用于 /tokens 命令的会话汇总）
				this.cumulativeInputTokens += event.inputTokens;
				this.cumulativeOutputTokens += event.outputTokens;
				this.cumulativeCacheReadTokens += event.cacheReadTokens;
				this.cumulativeCacheWriteTokens += event.cacheWriteTokens;
				this.cumulativeReasoningTokens += event.reasoningTokens;

				this.updateTokenDisplay();
				break;

			// 用户中断：停止动画、显示中断提示、恢复编辑器提交
			case "interrupted":
				// 停止加载动画
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.currentLoadingAnimation = null;
					this.statusContainer.clear();
				}
				// 显示中断消息
				this.chatContainer.addChild(new TextComponent(chalk.red("[Interrupted by user]"), { bottom: 1 }));
				// 重新启用编辑器提交
				this.editor.disableSubmit = false;
				// 显式请求重绘，确保消息立即显示
				this.ui.requestRender();
				break;
		}

		// 每个事件处理完后统一请求重绘
		this.ui.requestRender();
	}

	/**
	 * 重建底部 token 状态行。
	 *
	 * 展示最近一次请求的 input/output token，按需附加 reasoning、
	 * cache 读写与工具调用次数；每次都是清空后整体重建。
	 */
	private updateTokenDisplay(): void {
		// 清空并更新 token 显示
		this.tokenContainer.clear();

		// 构建基础 token 文本：↑ 输入 ↓ 输出
		let tokenText = chalk.dim(
			`↑ ${this.lastInputTokens.toLocaleString()} ↓ ${this.lastOutputTokens.toLocaleString()}`,
		);

		// 若有 reasoning token 则追加（⚡ 前缀）
		if (this.lastReasoningTokens > 0) {
			tokenText += chalk.dim(` ⚡ ${this.lastReasoningTokens.toLocaleString()}`);
		}

		// 若有 cache 读写则追加括号说明
		if (this.lastCacheReadTokens > 0 || this.lastCacheWriteTokens > 0) {
			const cacheText: string[] = [];
			if (this.lastCacheReadTokens > 0) {
				cacheText.push(` cache read: ${this.lastCacheReadTokens.toLocaleString()}`);
			}
			if (this.lastCacheWriteTokens > 0) {
				cacheText.push(` cache write: ${this.lastCacheWriteTokens.toLocaleString()}`);
			}
			tokenText += chalk.dim(` (${cacheText.join(" ")})`);
		}

		// 追加工具调用次数（⚒ 前缀）
		if (this.toolCallCount > 0) {
			tokenText += chalk.dim(` ⚒ ${this.toolCallCount}`);
		}

		this.tokenStatusComponent = new TextComponent(tokenText);
		this.tokenContainer.addChild(this.tokenStatusComponent);
	}

	/**
	 * 挂起等待用户输入。
	 *
	 * 返回的 Promise 在用户提交一条非空、非斜杠命令的输入时 resolve，
	 * 调用方（Agent 主循环）由此实现「一问一答」的同步节奏。
	 */
	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined; // 用完即清除回调，一次性使用
				resolve(text);
			};
		});
	}

	/**
	 * 设置 Esc 中断回调。
	 * @param callback 处理中按 Esc 时触发的回调（通常用于中断 Agent 循环）
	 */
	setInterruptCallback(callback: () => void): void {
		this.onInterruptCallback = callback;
	}

	/**
	 * 清空编辑器并短暂显示退出提示。
	 *
	 * 单击 Ctrl+C 时调用：提示用户「再按一次 Ctrl+C 退出」，
	 * 提示在 500ms 后自动消失（与双击退出的判定窗口一致）。
	 */
	clearEditor(): void {
		this.editor.setText("");

		// 在状态容器中显示提示
		this.statusContainer.clear();
		const hint = new TextComponent(chalk.dim("Press Ctrl+C again to exit"));
		this.statusContainer.addChild(hint);
		this.ui.requestRender();

		// 500ms 后清除提示
		setTimeout(() => {
			this.statusContainer.clear();
			this.ui.requestRender();
		}, 500);
	}

	/**
	 * 仅渲染 assistant 标签，不启动动画。
	 * 用于恢复（restore）历史会话时补齐 [assistant] 标签，
	 * 因为历史回放不需要 "Thinking..." 动画。
	 */
	renderAssistantLabel(): void {
		// 只渲染 assistant 标签而不启动动画
		// 用于恢复的会话历史
		this.chatContainer.addChild(new TextComponent(chalk.hex("#FFA500")("[assistant]")));
		this.ui.requestRender();
	}

	/**
	 * 处理 /tokens 斜杠命令：在聊天区显示本会话的累计 token 用量汇总。
	 * 包含 input/output/reasoning/cache 读写与工具调用总数，斜体展示。
	 */
	private showTokenUsage(): void {
		let tokenText = chalk.dim(
			`Total usage\n   input: ${this.cumulativeInputTokens.toLocaleString()}\n   output: ${this.cumulativeOutputTokens.toLocaleString()}`,
		);

		if (this.cumulativeReasoningTokens > 0) {
			tokenText += chalk.dim(`\n   reasoning: ${this.cumulativeReasoningTokens.toLocaleString()}`);
		}

		if (this.cumulativeCacheReadTokens > 0 || this.cumulativeCacheWriteTokens > 0) {
			const cacheText: string[] = [];
			if (this.cumulativeCacheReadTokens > 0) {
				cacheText.push(`\n  cache read: ${this.cumulativeCacheReadTokens.toLocaleString()}`);
			}
			if (this.cumulativeCacheWriteTokens > 0) {
				cacheText.push(`\n   cache right: ${this.cumulativeCacheWriteTokens.toLocaleString()}`);
			}
			tokenText += chalk.dim(` ${cacheText.join(" ")}`);
		}

		if (this.cumulativeToolCallCount > 0) {
			tokenText += chalk.dim(`\n   tool calls: ${this.cumulativeToolCallCount}`);
		}

		const tokenSummary = new TextComponent(chalk.italic(tokenText), { bottom: 1 });
		this.chatContainer.addChild(tokenSummary);
		this.ui.requestRender();
	}

	/** 停止渲染器：终止加载动画定时器并关闭 TUI（恢复终端状态） */
	stop(): void {
		if (this.currentLoadingAnimation) {
			this.currentLoadingAnimation.stop();
			this.currentLoadingAnimation = null;
		}
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}
