/**
 * @file tui-renderer.ts
 * @description TUI 交互式渲染器 —— 基于 pi-tui 的全屏 Agent 对话界面
 * @module pi-agent
 *
 * 主要功能：
 * - 提供完整交互式终端界面：header / 聊天历史 / 加载动画 / 输入编辑器 / token 用量行
 * - 实现 AgentEventReceiver 接口，把 Agent 事件流映射为 pi-tui 组件渲染
 * - 拦截全局按键：Esc 中断 Agent 运行，Ctrl+C 清空编辑器、双击退出
 * - 通过 getUserInput() 把编辑器提交包装为 Promise，供 CLI 主循环 await
 *
 * 依赖关系：
 * - pi-tui（TUI / Container / TextComponent / MarkdownComponent / TextEditor / 自动补全等组件）
 * - ../agent.js 的 AgentEvent / AgentEventReceiver（事件类型定义与接收器接口）
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
 * 加载动画组件 —— 基于 TextComponent 扩展的 "Thinking..." 帧动画
 *
 * 通过 setInterval 每 80ms 轮换一个盲文（Braille）帧字符，模拟"正在思考"的视觉效果。
 * 继承 TextComponent 是为了能直接作为子组件加入 statusContainer；
 * 动画期间每帧都调用 requestRender 触发 TUI 重绘。
 */
class LoadingAnimation extends TextComponent {
	/** 盲文帧字符序列，依次轮播形成旋转动画 */
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	/** 当前播放到的帧下标 */
	private currentFrame = 0;
	/** 定时器句柄，null 表示动画已停止 */
	private intervalId: NodeJS.Timeout | null = null;
	/** 宿主 TUI 实例，用于请求重绘 */
	private ui: TUI | null = null;

	/**
	 * 创建并立即启动动画
	 * @param ui 宿主 TUI 实例（每帧动画需要请求其重绘）
	 */
	constructor(ui: TUI) {
		// 底部预留 1 行间距
		super("", { bottom: 1 });
		this.ui = ui;
		this.start();
	}

	/** 启动动画：先立即渲染一帧，再按 80ms 间隔循环轮播 */
	start() {
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80);
	}

	/** 停止动画并清理定时器（幂等，可安全重复调用） */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/** 渲染当前帧：青色帧字符 + 灰色 "Thinking..." 文案，并请求 TUI 重绘 */
	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		this.setText(`${chalk.cyan(frame)} ${chalk.dim("Thinking...")}`);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}

/**
 * TUI 交互式渲染器 —— Agent 事件流到终端 UI 的桥接层
 *
 * 实现 AgentEventReceiver 接口：Agent 循环产生的每类事件（assistant_start / thinking /
 * tool_call / tool_result / assistant_message / error / user_message / token_usage /
 * interrupted）都在 on() 中映射为对应的 pi-tui 组件并渲染。
 *
 * 界面自上而下依次为：
 *   header          标题与快捷键说明
 *   chatContainer   聊天历史（用户消息 / 助手回复 / 工具调用与结果）
 *   statusContainer 状态区（LoadingAnimation 加载动画 / Ctrl+C 退出提示）
 *   Whitespace      1 行留白
 *   editor          多行文本编辑器（挂载 CombinedAutocompleteProvider 自动补全）
 *   tokenContainer  token 用量行（↑in ↓out (⟲cache) 格式）
 */
export class TuiRenderer implements AgentEventReceiver {
	/** pi-tui 根容器，管理整体布局与焦点 */
	private ui: TUI;
	/** 聊天历史容器：所有对话内容（用户/助手/工具）都追加在此 */
	private chatContainer: Container;
	/** 状态区容器：加载动画与 Ctrl+C 退出提示 */
	private statusContainer: Container;
	/** 底部文本输入编辑器 */
	private editor: TextEditor;
	/** token 用量行容器（编辑器下方） */
	private tokenContainer: Container;
	/** UI 是否已初始化（init() 幂等执行的标记） */
	private isInitialized = false;
	/** 编辑器提交回调，由 getUserInput() 设置，供主循环取回用户输入 */
	private onInputCallback?: (text: string) => void;
	/** 当前活跃的加载动画实例，null 表示空闲 */
	private currentLoadingAnimation: LoadingAnimation | null = null;
	/** 用户按下 Esc 时的中断回调（通常绑定 agent.interrupt()） */
	private onInterruptCallback?: () => void;
	/** 上次 Ctrl+C 的时间戳（毫秒），用于判断 500ms 内的双击退出 */
	private lastSigintTime = 0;
	/** 最近一次上报的输入 token 数 */
	private lastInputTokens = 0;
	/** 最近一次上报的输出 token 数 */
	private lastOutputTokens = 0;
	/** 最近一次上报的缓存读取 token 数 */
	private lastCacheReadTokens = 0;
	/** 最近一次上报的缓存写入 token 数 */
	private lastCacheWriteTokens = 0;
	/** token 用量文本组件的引用（每次刷新时重建） */
	private tokenStatusComponent: TextComponent | null = null;

	/** 构造函数：仅创建各组件实例；布局组装与按键绑定延迟到 init() 完成 */
	constructor() {
		this.ui = new TUI();
		this.chatContainer = new Container();
		this.statusContainer = new Container();
		this.editor = new TextEditor();
		this.tokenContainer = new Container();

		// 为文件路径与斜杠命令设置自动补全
		const autocompleteProvider = new CombinedAutocompleteProvider(
			[],
			process.cwd(), // 文件路径补全的基准目录
		);
		this.editor.setAutocompleteProvider(autocompleteProvider);
	}

	/**
	 * 初始化 UI：组装布局、绑定全局按键与编辑器提交处理，并启动 TUI。
	 * 幂等：已初始化时直接返回；on() 首次收到事件时也会自动调用本方法。
	 */
	async init(): Promise<void> {
		if (this.isInitialized) return;

		// 添加带操作说明的头部
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

		// ========== 组装界面布局（自上而下） ==========
		// header → 聊天历史 → 状态区（加载动画） → 1 行留白 → 编辑器 → token 用量行
		this.ui.addChild(header);
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(this.statusContainer);
		this.ui.addChild(new WhitespaceComponent(1));
		this.ui.addChild(this.editor);
		this.ui.addChild(this.tokenContainer);
		// 焦点固定在编辑器上，用户按键默认直接进入输入框
		this.ui.setFocus(this.editor);

		// ========== 设置 Esc 与 Ctrl+C 的全局按键处理 ==========
		// 返回 true 表示按键继续传递给编辑器，false 表示拦截（编辑器收不到该按键）
		this.ui.onGlobalKeyPress = (data: string): boolean => {
			// Agent 处理中（加载动画存在）时按下 Esc：中断当前运行
			if (data === "\x1b" && this.currentLoadingAnimation) {
				// 若已设置中断回调则触发（通常为 agent.interrupt()）
				if (this.onInterruptCallback) {
					this.onInterruptCallback();
				}

				// 立即停止加载动画并清空状态区
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.statusContainer.clear();
					this.currentLoadingAnimation = null;
				}

				// 此处不显示中断提示 —— 后续的 interrupted 事件会负责渲染

				// 恢复编辑器提交能力，允许用户立刻输入新指令
				this.editor.disableSubmit = false;

				this.ui.requestRender();

				// 不把该按键转发给编辑器
				return false;
			}

			// 处理 Ctrl+C（终端 raw 模式下发送的是 \x03）
			// 设计为"双击退出"：第一次仅清空编辑器并给出提示，避免误触直接退出程序
			if (data === "\x03") {
				const now = Date.now();
				const timeSinceLastCtrlC = now - this.lastSigintTime;

				if (timeSinceLastCtrlC < 500) {
					// 500ms 内第二次 Ctrl+C —— 真正退出程序
					this.stop();
					process.exit(0);
				} else {
					// 第一次 Ctrl+C —— 仅清空编辑器并记录时间戳
					this.clearEditor();
					this.lastSigintTime = now;
				}

				// 不把该按键转发给编辑器
				return false;
			}

			// 其余按键一律转发给编辑器正常处理
			return true;
		};

		// 处理编辑器提交（用户输入完成后发送）
		this.editor.onSubmit = (text: string) => {
			text = text.trim();
			if (!text) return;

			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
		};

		// 启动 UI（进入 raw 模式并开始渲染循环）
		await this.ui.start();
		this.isInitialized = true;
	}

	/**
	 * AgentEventReceiver 接口实现：把每类 Agent 事件映射为对应的 UI 行为。
	 * 首次调用时会先自动初始化 UI；处理完事件后统一请求一次重绘。
	 *
	 * 事件 → UI 映射总览：
	 * - assistant_start  → 橙色 [assistant] 标签 + 启动加载动画 + 禁用编辑器提交
	 * - thinking         → 灰色暗淡的 [thinking] 块
	 * - tool_call        → 黄色 [tool] 名称(参数) 单行
	 * - tool_result      → 灰色（出错为红色）逐行结果，超过 10 行截断
	 * - assistant_message→ MarkdownComponent 富文本 + 停止动画 + 恢复提交
	 * - error            → 红色 [error] 信息
	 * - user_message     → 绿色 [user] 标签 + 正文
	 * - token_usage      → 刷新底部 token 用量行
	 * - interrupted      → 红色中断提示 + 恢复编辑器提交
	 */
	async on(event: AgentEvent): Promise<void> {
		// 确保 UI 已初始化（延迟到首个事件到达时才启动界面）
		if (!this.isInitialized) {
			await this.init();
		}

		switch (event.type) {
			// 助手回合开始：渲染橙色 [assistant] 标签并启动加载动画；
			// 同时禁用编辑器提交（disableSubmit），防止处理期间用户继续发消息打乱流程
			case "assistant_start":
				this.chatContainer.addChild(new TextComponent(chalk.hex("#FFA500")("[assistant]")));
				// 处理期间禁用编辑器提交
				this.editor.disableSubmit = true;
				// 在状态区启动加载动画
				this.statusContainer.clear();
				this.currentLoadingAnimation = new LoadingAnimation(this.ui);
				this.statusContainer.addChild(this.currentLoadingAnimation);
				break;

			// 思考过程：以灰色暗淡文字整块展示，[thinking] 标签开头
			case "thinking": {
				// 用暗淡文字显示思考内容
				const thinkingContainer = new Container();
				thinkingContainer.addChild(new TextComponent(chalk.dim("[thinking]")));

				// 按行拆分思考文本以便更好地展示
				const thinkingLines = event.text.split("\n");
				for (const line of thinkingLines) {
					thinkingContainer.addChild(new TextComponent(chalk.dim(line)));
				}
				thinkingContainer.addChild(new WhitespaceComponent(1));
				this.chatContainer.addChild(thinkingContainer);
				break;
			}

			// 工具调用：黄色 [tool] 名称(参数) 单行展示
			case "tool_call":
				this.chatContainer.addChild(new TextComponent(chalk.yellow(`[tool] ${event.name}(${event.args})`)));
				break;

			// 工具结果：灰色（isError 时为红色）逐行展示，超过 10 行截断
			case "tool_result": {
				// 截断展示工具结果
				const lines = event.result.split("\n");
				const maxLines = 10; // 最多展示的行数
				const truncated = lines.length > maxLines;
				const toShow = truncated ? lines.slice(0, maxLines) : lines;

				const resultContainer = new Container();
				for (const line of toShow) {
					resultContainer.addChild(new TextComponent(event.isError ? chalk.red(line) : chalk.gray(line)));
				}

				if (truncated) {
					// 提示被截断的剩余行数
					resultContainer.addChild(new TextComponent(chalk.dim(`... (${lines.length - maxLines} more lines)`)));
				}
				resultContainer.addChild(new WhitespaceComponent(1));
				this.chatContainer.addChild(resultContainer);
				break;
			}

			// 助手回复：停止加载动画、恢复编辑器提交，用 Markdown 渲染正文
			case "assistant_message":
				// 助手回复时停止加载动画
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.currentLoadingAnimation = null;
					this.statusContainer.clear();
				}
				// 恢复编辑器提交
				this.editor.disableSubmit = false;
				// 使用 MarkdownComponent 获得富文本格式
				this.chatContainer.addChild(new MarkdownComponent(event.text));
				this.chatContainer.addChild(new WhitespaceComponent(1));
				break;

			// 出错：停止加载动画、恢复编辑器提交，红色显示错误信息
			case "error":
				// 出错时停止加载动画
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.currentLoadingAnimation = null;
					this.statusContainer.clear();
				}
				// 恢复编辑器提交
				this.editor.disableSubmit = false;
				this.chatContainer.addChild(new TextComponent(chalk.red(`[error] ${event.message}`), { bottom: 1 }));
				break;

			// 用户消息：绿色 [user] 标签 + 正文
			case "user_message":
				// 渲染用户消息
				this.chatContainer.addChild(new TextComponent(chalk.green("[user]")));
				this.chatContainer.addChild(new TextComponent(event.text, { bottom: 1 }));
				break;

			// token 用量：记录最新计数并刷新底部用量行
			case "token_usage":
				// 保存最新的 token 计数（非累计值 —— prompt 本身已包含完整上下文，直接覆盖即可）
				this.lastInputTokens = event.inputTokens;
				this.lastOutputTokens = event.outputTokens;
				this.lastCacheReadTokens = event.cacheReadTokens;
				this.lastCacheWriteTokens = event.cacheWriteTokens;
				this.updateTokenDisplay();
				break;

			// 用户中断：停止加载动画、显示红色中断提示、恢复编辑器提交
			case "interrupted":
				// 停止加载动画
				if (this.currentLoadingAnimation) {
					this.currentLoadingAnimation.stop();
					this.currentLoadingAnimation = null;
					this.statusContainer.clear();
				}
				// 显示中断提示
				this.chatContainer.addChild(new TextComponent(chalk.red("[Interrupted by user]"), { bottom: 1 }));
				// 恢复编辑器提交
				this.editor.disableSubmit = false;
				break;
		}

		// 所有事件处理完毕后统一请求一次重绘
		this.ui.requestRender();
	}

	/**
	 * 刷新底部 token 用量行。
	 * 显示格式：↑输入 ↓输出 (⟲缓存读 ⟳缓存写)，数字用 toLocaleString 加千分位。
	 */
	private updateTokenDisplay(): void {
		// 清空并更新 token 显示
		this.tokenContainer.clear();

		// 构造 token 显示文本
		let tokenText = chalk.dim(`↑${this.lastInputTokens.toLocaleString()} ↓${this.lastOutputTokens.toLocaleString()}`);

		// 有缓存数据时附加缓存信息
		if (this.lastCacheReadTokens > 0 || this.lastCacheWriteTokens > 0) {
			const cacheText: string[] = [];
			if (this.lastCacheReadTokens > 0) {
				cacheText.push(`⟲${this.lastCacheReadTokens.toLocaleString()}`); // 缓存读取
			}
			if (this.lastCacheWriteTokens > 0) {
				cacheText.push(`⟳${this.lastCacheWriteTokens.toLocaleString()}`); // 缓存写入
			}
			tokenText += chalk.dim(` (${cacheText.join(" ")})`);
		}

		this.tokenStatusComponent = new TextComponent(tokenText);
		this.tokenContainer.addChild(this.tokenStatusComponent);
	}

	/**
	 * 获取用户输入：把编辑器的提交动作包装为 Promise。
	 *
	 * 原理：先把 onSubmit 的处理函数存入 onInputCallback，返回的 Promise 在用户
	 * 提交前一直处于 pending 状态，CLI 主循环 await 它即可同步拿到一行输入；
	 * 回调触发时先自我清除再 resolve，保证每次 getUserInput() 只消费一次提交事件。
	 */
	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined; // 清除回调，避免重复触发
				resolve(text);
			};
		});
	}

	/**
	 * 设置中断回调：Agent 处理中按 Esc 时触发。
	 * CLI 主循环用它绑定 agent.interrupt()，实现"按 Esc 打断当前运行"。
	 */
	setInterruptCallback(callback: () => void): void {
		this.onInterruptCallback = callback;
	}

	/**
	 * 清空编辑器内容，并在状态区临时显示"再按一次 Ctrl+C 退出"提示。
	 * 提示 500ms 后自动消失，与双击退出的判定时间窗口保持一致。
	 */
	clearEditor(): void {
		this.editor.setText("");

		// 在状态区显示提示
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
	 * 仅渲染 [assistant] 标签而不启动加载动画。
	 * 用于会话回放：恢复历史会话时为已有的助手消息补齐标签。
	 */
	renderAssistantLabel(): void {
		// 只渲染助手标签，不启动动画
		// 用于恢复的会话历史
		this.chatContainer.addChild(new TextComponent(chalk.hex("#FFA500")("[assistant]")));
		this.ui.requestRender();
	}

	/**
	 * 停止渲染器：先终止加载动画；若 UI 已启动，则停止 TUI
	 * （退出 raw 模式、恢复终端状态）并重置初始化标记。
	 */
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
