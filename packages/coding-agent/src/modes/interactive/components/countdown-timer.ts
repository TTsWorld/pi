/**
 * @file countdown-timer.ts —— 对话框组件可复用的倒计时器
 *
 * @description
 * 以秒为单位倒计时：每秒回调一次 onTick 报告剩余秒数，
 * 归零时停止并回调 onExpire。有 TUI 实例时每 tick 主动请求重绘，
 * 供选择器/输入框/重试指示器等实现超时自动取消。
 */

import type { TUI } from "@earendil-works/pi-tui";

/** 每秒递减的倒计时器；用完必须调用 dispose 释放定时器 */
export class CountdownTimer {
	private intervalId: ReturnType<typeof setInterval> | undefined;
	private remainingSeconds: number;
	private tui: TUI | undefined;
	private onTick: (seconds: number) => void;
	private onExpire: () => void;

	constructor(timeoutMs: number, tui: TUI | undefined, onTick: (seconds: number) => void, onExpire: () => void) {
		this.tui = tui;
		this.onTick = onTick;
		this.onExpire = onExpire;
		// 毫秒向上取整为秒，作为初始剩余时间
		this.remainingSeconds = Math.ceil(timeoutMs / 1000);
		// 立即回调一次，让宿主先显示初始秒数
		this.onTick(this.remainingSeconds);

		this.intervalId = setInterval(() => {
			// 每秒递减并回调，同时请求 TUI 重绘
			this.remainingSeconds--;
			this.onTick(this.remainingSeconds);
			this.tui?.requestRender();

			// 归零：先停表，再触发到期回调
			if (this.remainingSeconds <= 0) {
				this.dispose();
				this.onExpire();
			}
		}, 1000);
	}

	/** 停止倒计时并清理定时器（到期后自动调用，也可提前手动取消） */
	dispose(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = undefined;
		}
	}
}
