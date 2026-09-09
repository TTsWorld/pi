/**
 * @file 控制台渲染器（ConsoleRenderer）
 * @description pi monorepo agent 包的默认事件渲染器，适用于单发（single-shot）与管道（pipe）模式。
 *              实现 AgentEventReceiver 接口，将 Agent 生命周期中产生的各类事件
 *              （会话开始、思考、工具调用、助手消息、错误等）渲染到终端：
 *              - 通过 console.log / process.stdout 输出彩色文本（基于 chalk）
 *              - 在等待模型响应或工具执行期间，显示行内 spinner 动画
 *              - 在助手消息结束后展示 token 用量等统计指标
 */
import chalk from "chalk";
import type { AgentEvent, AgentEventReceiver } from "../agent.js";

/**
 * 控制台渲染器：接收 Agent 事件流并渲染为人类可读的终端输出。
 *
 * 核心机制：
 * - spinner 动画：用一个 setInterval 定时器以 80ms 间隔轮换 Braille 字符帧，
 *   并通过 \r 回车符反复覆写当前行实现"行内动画"；仅在 stdout 是 TTY 时启用，
 *   避免在管道/重定向输出中产生大量垃圾字符。
 * - 动画抢占：任何新事件（除 token_usage 外）到来时先停掉动画，输出内容后再按需恢复。
 */
export class ConsoleRenderer implements AgentEventReceiver {
	/** spinner 动画的 Braille 字符帧序列 */
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	/** 当前动画帧在 frames 中的索引 */
	private currentFrame = 0;
	/** 动画定时器句柄（未运行为 null） */
	private animationInterval: NodeJS.Timeout | null = null;
	/** 动画是否正在运行 */
	private isAnimating = false;
	/** 当前动画行已写入的内容（用于计算覆写时需要清除的字符数） */
	private animationLine = "";
	/** stdout 是否为 TTY（终端）；非 TTY 时禁用动画 */
	private isTTY = process.stdout.isTTY;
	/** 本次会话累计的工具调用次数 */
	private toolCallCount = 0;
	/** 最近一次上报的输入 token 数 */
	private lastInputTokens = 0;
	/** 最近一次上报的输出 token 数 */
	private lastOutputTokens = 0;
	/** 最近一次上报的缓存读取 token 数 */
	private lastCacheReadTokens = 0;
	/** 最近一次上报的缓存写入 token 数 */
	private lastCacheWriteTokens = 0;
	/** 最近一次上报的推理（reasoning）token 数 */
	private lastReasoningTokens = 0;

	/**
	 * 启动行内 spinner 动画。
	 * 若动画已在运行或 stdout 不是 TTY，则直接跳过（幂等）。
	 * @param text 动画旁显示的提示文本，默认 "Thinking"
	 */
	private startAnimation(text: string = "Thinking"): void {
		if (this.isAnimating || !this.isTTY) return;
		this.isAnimating = true;
		this.currentFrame = 0;

		// Write initial frame
		// 写入首帧：spinner 字符 + 暗色提示文本
		this.animationLine = `${chalk.cyan(this.frames[this.currentFrame])} ${chalk.dim(text)}`;
		process.stdout.write(this.animationLine);

		// 每 80ms 刷新一帧
		this.animationInterval = setInterval(() => {
			// Clear current line
			// 先用空格覆盖当前行（\r 回到行首 -> 输出等长空格 -> 再 \r 回到行首）
			process.stdout.write(`\r${" ".repeat(this.animationLine.length)}\r`);

			// Update frame
			// 切换到下一帧（循环取模）后重新写入
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.animationLine = `${chalk.cyan(this.frames[this.currentFrame])} ${chalk.dim(text)}`;
			process.stdout.write(this.animationLine);
		}, 80);
	}

	/**
	 * 停止 spinner 动画并清空当前行。
	 * 若动画未在运行则不做任何事。
	 */
	private stopAnimation(): void {
		if (!this.isAnimating) return;

		if (this.animationInterval) {
			clearInterval(this.animationInterval);
			this.animationInterval = null;
		}

		// Clear the animation line
		// 清除残留的动画行，避免与后续输出混在同一行
		process.stdout.write(`\r${" ".repeat(this.animationLine.length)}\r`);
		this.isAnimating = false;
		this.animationLine = "";
	}

	/**
	 * 输出最近一轮的 token 用量统计行。
	 * 格式：`↑输入 ↓输出 [⚡推理] [(⟲缓存读 ⟳缓存写)] [⚒ 工具次数]`，
	 * 各部分按需出现（值为 0 时省略）。
	 */
	private displayMetrics(): void {
		// Build metrics display
		// 基础部分：输入/输出 token 数
		let metricsText = chalk.dim(
			`↑${this.lastInputTokens.toLocaleString()} ↓${this.lastOutputTokens.toLocaleString()}`,
		);

		// Add reasoning tokens if present
		// 有推理 token 时追加 ⚡ 部分
		if (this.lastReasoningTokens > 0) {
			metricsText += chalk.dim(` ⚡${this.lastReasoningTokens.toLocaleString()}`);
		}

		// Add cache info if available
		// 有缓存读写时追加括号内的缓存统计
		if (this.lastCacheReadTokens > 0 || this.lastCacheWriteTokens > 0) {
			const cacheText: string[] = [];
			if (this.lastCacheReadTokens > 0) {
				cacheText.push(`⟲${this.lastCacheReadTokens.toLocaleString()}`);
			}
			if (this.lastCacheWriteTokens > 0) {
				cacheText.push(`⟳${this.lastCacheWriteTokens.toLocaleString()}`);
			}
			metricsText += chalk.dim(` (${cacheText.join(" ")})`);
		}

		// Add tool call count
		// 有工具调用时追加 ⚒ 计数
		if (this.toolCallCount > 0) {
			metricsText += chalk.dim(` ⚒ ${this.toolCallCount}`);
		}

		console.log(metricsText);
		console.log();
	}

	/**
	 * Agent 事件入口：按事件类型分发渲染。
	 *
	 * 通用规则：除 token_usage（仅静默记录数据）外，任何事件到来都会先停掉
	 * 当前动画，输出对应内容；需要继续等待的场景（工具执行中、思考后）
	 * 会随后重新启动动画。
	 * @param event Agent 生命周期事件
	 */
	async on(event: AgentEvent): Promise<void> {
		// Stop animation for any new event except token_usage
		// 除 token_usage 外，任何新事件都先停掉动画
		if (event.type !== "token_usage" && this.isAnimating) {
			this.stopAnimation();
		}

		switch (event.type) {
			// 会话开始：打印会话 ID、模型、API 类型、Base URL 及系统提示词
			case "session_start":
				console.log(
					chalk.blue(
						`[Session started] ID: ${event.sessionId}, Model: ${event.model}, API: ${event.api}, Base URL: ${event.baseURL}`,
					),
				);
				console.log(chalk.dim(`System Prompt: ${event.systemPrompt}\n`));
				break;

			// 助手开始生成：打印标记并启动默认 "Thinking" 动画
			case "assistant_start":
				console.log(chalk.hex("#FFA500")("[assistant]"));
				this.startAnimation();
				break;

			// 推理文本：原样输出思考内容，然后以 "Processing" 恢复动画
			case "reasoning":
				this.stopAnimation();
				console.log(chalk.dim("[thinking]"));
				console.log(chalk.dim(event.text));
				console.log();
				// Resume animation after showing thinking
				// 展示完思考内容后恢复动画
				this.startAnimation("Processing");
				break;

			// 工具调用：打印工具名与参数，工具执行期间以 "Running <工具名>" 恢复动画
			case "tool_call":
				this.stopAnimation();
				this.toolCallCount++;
				console.log(chalk.yellow(`[tool] ${event.name}(${event.args})`));
				// Resume animation while tool executes
				// 工具执行期间恢复动画
				this.startAnimation(`Running ${event.name}`);
				break;

			// 工具结果：最多显示前 10 行，超出部分截断并提示剩余行数；随后恢复 "Thinking" 动画
			case "tool_result": {
				this.stopAnimation();
				const lines = event.result.split("\n");
				const maxLines = 10;
				const truncated = lines.length > maxLines;
				const toShow = truncated ? lines.slice(0, maxLines) : lines;

				const text = toShow.join("\n");
				console.log(event.isError ? chalk.red(text) : chalk.gray(text));

				if (truncated) {
					console.log(chalk.dim(`... (${lines.length - maxLines} more lines)`));
				}
				console.log();
				// Resume animation after tool result
				// 输出工具结果后恢复动画
				this.startAnimation("Thinking");
				break;
			}

			// 助手完整消息：输出正文，随后展示 token 用量统计
			case "assistant_message":
				this.stopAnimation();
				console.log(event.text);
				console.log();
				// Display metrics after assistant message
				// 助手消息结束后展示用量指标
				this.displayMetrics();
				break;

			// 错误：输出到 stderr
			case "error":
				this.stopAnimation();
				console.error(chalk.red(`[error] ${event.message}\n`));
				break;

			// 用户消息：绿色标记 + 正文
			case "user_message":
				console.log(chalk.green("[user]"));
				console.log(event.text);
				console.log();
				break;

			// 被用户中断
			case "interrupted":
				this.stopAnimation();
				console.log(chalk.red("[Interrupted by user]\n"));
				break;

			// token 用量：仅静默记录，等助手消息结束后统一展示
			case "token_usage":
				// Store token usage for display after assistant message
				// 暂存 token 用量，供 assistant_message 后的 displayMetrics 使用
				this.lastInputTokens = event.inputTokens;
				this.lastOutputTokens = event.outputTokens;
				this.lastCacheReadTokens = event.cacheReadTokens;
				this.lastCacheWriteTokens = event.cacheWriteTokens;
				this.lastReasoningTokens = event.reasoningTokens;
				// Don't stop animation for this event
				// 此事件不打断动画
				break;
		}
	}
}
