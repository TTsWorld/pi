/**
 * @file status-indicator.ts —— 底部状态指示器组件集
 *
 * @description
 * 交互模式下底部状态栏使用的各类加载指示器：正常工作中（working）、
 * 重试倒计时（retry）、上下文压缩（compaction）、分支摘要（branchSummary），
 * 以及空闲时渲染空白的 IdleStatus 占位组件。
 * 全部基于 pi-tui 的 Loader（spinner + 文案），宿主根据当前状态切换显示。
 */
import { type Component, Loader, type TUI } from "@earendil-works/pi-tui";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

/** 状态指示器的种类标签，宿主据此区分当前处于哪种等待状态 */
export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

/**
 * 所有状态指示器的基类：在 Loader（spinner + 消息文案）之上附加 kind 标记，
 * 便于宿主统一识别与调度不同状态的指示器。
 */
export class StatusIndicator extends Loader {
	readonly kind: StatusIndicatorKind;

	constructor(
		kind: StatusIndicatorKind,
		ui: TUI,
		spinnerColorFn: (str: string) => string,
		messageColorFn: (str: string) => string,
		message: string,
		indicator?: WorkingIndicatorOptions,
	) {
		super(ui, spinnerColorFn, messageColorFn, message, indicator);
		this.kind = kind;
	}

	dispose(): void {
		this.stop();
	}
}

/**
 * 「工作中」指示器：accent 色 spinner + 弱化色文案，
 * Agent 正常执行任务时显示。
 */
export class WorkingStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, message: string, indicator?: WorkingIndicatorOptions) {
		super(
			"working",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			message,
			indicator,
		);
	}
}

/**
 * 「重试中」指示器：warning 色 spinner，内部驱动一个 CountdownTimer，
 * 每秒刷新「Retrying (n/m) in Ns...」倒计时文案，结束后自动清空引用。
 */
export class RetryStatusIndicator extends StatusIndicator {
	private countdown: CountdownTimer | undefined;

	constructor(ui: TUI, attempt: number, maxAttempts: number, delayMs: number) {
		// 倒计时文案：显示当前尝试进度与剩余秒数，并提示可用中断键取消
		const retryMessage = (seconds: number) =>
			`Retrying (${attempt}/${maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
		super(
			"retry",
			ui,
			(spinner) => theme.fg("warning", spinner),
			(text) => theme.fg("muted", text),
			retryMessage(Math.ceil(delayMs / 1000)),
		);
		this.countdown = new CountdownTimer(
			delayMs,
			ui,
			(seconds) => {
				this.setMessage(retryMessage(seconds));
			},
			() => {
				this.countdown = undefined;
			},
		);
	}

	override dispose(): void {
		this.countdown?.dispose();
		this.countdown = undefined;
		super.dispose();
	}
}

/** 触发上下文压缩的原因：手动执行 / 达到阈值 / 上下文溢出 */
export type CompactionStatusReason = "manual" | "threshold" | "overflow";

/** 「压缩中」指示器：按触发原因生成不同前缀的提示文案 */
export class CompactionStatusIndicator extends StatusIndicator {
	constructor(ui: TUI, reason: CompactionStatusReason) {
		const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
		// 根据触发原因拼接文案：手动压缩 / 自动压缩 / 溢出后自动压缩
		const label =
			reason === "manual"
				? `Compacting context... ${cancelHint}`
				: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		super(
			"compaction",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
	}
}

/** 「分支摘要生成中」指示器：后台总结当前分支对话时显示 */
export class BranchSummaryStatusIndicator extends StatusIndicator {
	constructor(ui: TUI) {
		super(
			"branchSummary",
			ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
		);
	}
}

/**
 * 空闲状态占位组件：不显示任何内容，仅按宽度渲染两行空白，
 * 保证状态栏在空闲态与工作态之间切换时高度不变、界面不跳动。
 */
export class IdleStatus implements Component {
	invalidate(): void {
		// 没有需要失效的缓存状态。
	}

	render(width: number): string[] {
		const emptyLine = " ".repeat(width);
		return [emptyLine, emptyLine];
	}
}
