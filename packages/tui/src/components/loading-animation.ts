import chalk from "chalk";
import type { TUI } from "../tui.js";
import { TextComponent } from "./text-component.js";

/**
 * @file loading-animation.ts
 * @description 终端加载动画组件：在底部状态栏显示 braille（盲文点阵）旋转帧动画 + 提示文字，
 *              用于在耗时操作期间向用户反馈"正在进行中"的状态。
 *
 * 主要功能：
 * - 以 80ms 为间隔循环播放 10 个 braille 旋转帧，形成平滑的旋转效果
 * - 支持动态更新提示文字（setMessage）
 * - 构造时自动启动动画，外部操作完成后调用 stop() 停止
 *
 * 依赖关系：
 * - chalk：为动画帧和提示文字着色（帧为青色，文字为暗淡色）
 * - TUI（../tui.js）：持有 TUI 实例引用，每次帧更新后调用 requestRender() 触发重绘
 * - TextComponent（./text-component.js）：继承自文本组件，复用其渲染与 ANSI 换行逻辑
 */

/**
 * 加载动画组件，每 80ms 更新一次
 * 模拟在单缓冲（single-buffer）模式下会导致画面闪烁的动画组件
 */
export class LoadingAnimation extends TextComponent {
	// braille 盲文字符组成的 10 帧旋转序列，相邻帧之间点阵位置渐变，视觉上形成连续旋转
	private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	// 当前播放到的帧下标，配合取模运算实现循环播放
	private currentFrame = 0;
	// 定时器句柄；为 null 表示动画已停止（避免重复 clearInterval）
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;

	/**
	 * 创建并立即启动加载动画
	 *
	 * @param ui TUI 实例，用于帧更新后触发重绘
	 * @param message 动画旁显示的提示文字，默认 "Loading..."
	 */
	constructor(
		ui: TUI,
		private message: string = "Loading...",
	) {
		// bottom: 1 —— 预留 1 行底部内边距，让动画贴近终端底部显示
		super("", { bottom: 1 });
		this.ui = ui;
		this.start();
	}

	/**
	 * 启动动画：先立即渲染第一帧，再按固定间隔轮播后续帧
	 */
	start() {
		// 先同步渲染一次，避免等到第一个 tick 才出现动画（消除启动时的空白期）
		this.updateDisplay();
		this.intervalId = setInterval(() => {
			// 取模实现帧下标循环：到最后一帧后回到第 0 帧
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			this.updateDisplay();
		}, 80); // 80ms 帧间隔：足够快以呈现流畅旋转，又不至于过于频繁地触发重绘
	}

	/**
	 * 停止动画并清除定时器，防止组件销毁后定时器继续触发（内存泄漏）
	 */
	stop() {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	/**
	 * 更新提示文字并立即刷新显示
	 *
	 * @param message 新的提示文字
	 */
	setMessage(message: string) {
		this.message = message;
		this.updateDisplay();
	}

	/**
	 * 刷新单帧显示：拼接"彩色帧 + 暗淡提示文字"，并请求 TUI 重绘
	 */
	private updateDisplay() {
		const frame = this.frames[this.currentFrame];
		// 帧用青色高亮、文字用暗淡色，形成视觉主次区分
		this.setText(`${chalk.cyan(frame)} ${chalk.dim(this.message)}`);
		if (this.ui) {
			// 文本内容已更新，但真正画到终端还需 TUI 调度一次渲染
			this.ui.requestRender();
		}
	}
}
