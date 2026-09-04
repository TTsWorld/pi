/**
 * @file console-renderer.ts
 * @description 控制台渲染器 —— chalk 着色的普通终端输出与 spinner 动画
 * @module pi-agent
 *
 * 主要功能：
 * - 实现 AgentEventReceiver 接口，把 Agent 事件流渲染为普通终端输出
 * - 用 chalk 为不同角色着色（[user] 绿 / [assistant] 橙 / [tool] 黄 / [error] 红）
 * - 模型思考、工具执行期间显示 braille spinner 帧动画（80ms 一帧）
 * - tool 结果超过 10 行自动截断；非 TTY 环境（管道/重定向）自动禁用动画
 */
import chalk from "chalk";
import type { AgentEvent, AgentEventReceiver } from "../agent.js";

/**
 * 控制台渲染器：面向普通终端（非 TUI）的 AgentEventReceiver 实现。
 *
 * 职责是把 Agent 运行过程中产生的事件流（会话开始、助手输出、思考、
 * 工具调用/结果、错误、打断等）逐条打印到 stdout/stderr，
 * 并在等待期间用 spinner 动画提示"仍在工作中"。
 */
export class ConsoleRenderer implements AgentEventReceiver {
	/** spinner 使用的 braille（盲文点阵）帧序列，循环播放形成旋转效果 */
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	/** 当前播放到第几帧（在 frames 数组内循环取模） */
	private currentFrame = 0;
	/** setInterval 返回的定时器句柄，非播放状态为 null */
	private animationInterval: NodeJS.Timeout | null = null;
	/** 是否正在播放 spinner 动画（防止重复启动） */
	private isAnimating = false;
	/** 最近一次写入的动画行内容，用于计算擦除该行所需的空格数 */
	private animationLine = "";
	/** stdout 是否为 TTY；输出被管道/重定向（如 `| grep`、`> log.txt`）时为 undefined，此时禁用动画 */
	private isTTY = process.stdout.isTTY;

	/**
	 * 启动 spinner 动画：立即写入首帧，之后每 80ms 定时刷新一帧。
	 * @param text 动画旁显示的提示文字，默认 "Thinking"
	 */
	private startAnimation(text: string = "Thinking"): void {
		// 已在播放则不重复启动；非 TTY 时直接跳过——
		// 管道/重定向场景下 \r 与动画帧会污染落盘的日志，且无人观看动画
		if (this.isAnimating || !this.isTTY) return;
		this.isAnimating = true;
		this.currentFrame = 0;

		// 写入首帧：青色 spinner 符号 + 暗色提示文字
		this.animationLine = `${chalk.cyan(this.frames[this.currentFrame])} ${chalk.dim(text)}`;
		process.stdout.write(this.animationLine);

		// 每 80ms 刷新一帧，形成旋转动画
		this.animationInterval = setInterval(() => {
			// 用 \r 回到行首并以等长空格覆盖，擦掉上一帧
			process.stdout.write(`\r${" ".repeat(this.animationLine.length)}\r`);

			// 切换到下一帧（对总帧数取模实现循环）
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.animationLine = `${chalk.cyan(this.frames[this.currentFrame])} ${chalk.dim(text)}`;
			process.stdout.write(this.animationLine);
		}, 80);
	}

	/**
	 * 停止 spinner 动画：清除定时器并擦除当前动画行，把终端还给正常输出。
	 */
	private stopAnimation(): void {
		// 未在播放时无需清理
		if (!this.isAnimating) return;

		if (this.animationInterval) {
			clearInterval(this.animationInterval);
			this.animationInterval = null;
		}

		// 擦除动画行（\r 回到行首 + 等长空格覆盖 + 再 \r 回到行首）
		process.stdout.write(`\r${" ".repeat(this.animationLine.length)}\r`);
		this.isAnimating = false;
		this.animationLine = "";
	}

	/**
	 * AgentEventReceiver 事件入口：按事件类型分发生成对应的控制台输出。
	 *
	 * 通用规则：除 token_usage 外，任何新事件到达时先停掉 spinner，
	 * 避免动画行与新打印的内容交错错乱；仍需继续等待的分支随后会重启动画。
	 * @param event Agent 运行过程中产生的事件
	 */
	async on(event: AgentEvent): Promise<void> {
		// 除 token_usage（纯统计事件，无输出）外，先停掉动画再打印新内容
		if (event.type !== "token_usage" && this.isAnimating) {
			this.stopAnimation();
		}

		switch (event.type) {
			// 会话开始：蓝色打印会话 ID / 模型 / API / Base URL，暗色打印系统提示词
			case "session_start":
				console.log(
					chalk.blue(
						`[Session started] ID: ${event.sessionId}, Model: ${event.model}, API: ${event.api}, Base URL: ${event.baseURL}`,
					),
				);
				console.log(chalk.dim(`System Prompt: ${event.systemPrompt}\n`));
				break;

			// 助手回合开始：橙色 [assistant] 前缀，并启动 "Thinking" 动画等待模型输出
			case "assistant_start":
				console.log(chalk.hex("#FFA500")("[assistant]"));
				this.startAnimation();
				break;

			// 思考内容：暗色输出思维链文本，随后恢复动画继续等待
			case "thinking":
				this.stopAnimation();
				console.log(chalk.dim("[thinking]"));
				console.log(chalk.dim(event.text));
				console.log();
				// 展示完思考内容后恢复动画，提示仍在处理中
				this.startAnimation("Processing");
				break;

			// 工具调用：黄色打印工具名与参数，随后以 "Running <工具名>" 动画等待执行完成
			case "tool_call":
				this.stopAnimation();
				console.log(chalk.yellow(`[tool] ${event.name}(${event.args})`));
				// 工具执行期间恢复动画，提示正在运行
				this.startAnimation(`Running ${event.name}`);
				break;

			// 工具结果：输出结果文本（错误为红色，正常为灰色），超过 10 行截断并提示省略行数
			case "tool_result": {
				this.stopAnimation();
				const lines = event.result.split("\n");
				// 控制台只展示前 10 行，避免长输出刷屏
				const maxLines = 10;
				const truncated = lines.length > maxLines;
				const toShow = truncated ? lines.slice(0, maxLines) : lines;

				const text = toShow.join("\n");
				console.log(event.isError ? chalk.red(text) : chalk.gray(text));

				// 截断时用暗色提示被省略的行数，让用户感知输出不完整
				if (truncated) {
					console.log(chalk.dim(`... (${lines.length - maxLines} more lines)`));
				}
				console.log();
				// 输出完结果后恢复 "Thinking" 动画，等待下一轮
				this.startAnimation("Thinking");
				break;
			}

			// 助手完整消息：不加前缀直接输出正文，空行分隔，保持阅读体验
			case "assistant_message":
				this.stopAnimation();
				console.log(event.text);
				console.log();
				break;

			// 错误：红色输出到 stderr，与正常 stdout 分离，便于单独重定向排查
			case "error":
				this.stopAnimation();
				console.error(chalk.red(`[error] ${event.message}\n`));
				break;

			// 用户消息：绿色 [user] 前缀 + 消息原文
			case "user_message":
				console.log(chalk.green("[user]"));
				console.log(event.text);
				console.log();
				break;

			// 用户打断：停掉动画并红色提示
			case "interrupted":
				this.stopAnimation();
				console.log(chalk.red("[Interrupted by user]\n"));
				break;

			case "token_usage":
				// token 用量在控制台模式下不展示（TUI 模式才显示）
				// 此事件也不停止动画（见 on() 开头的过滤条件）
				break;
		}
	}
}
