/**
 * @file bordered-loader.ts —— 带边框的加载指示器组件
 *
 * @description
 * 为扩展 UI 提供的 Loader 包装：上下以动态边框包住 spinner + 文案，
 * 可选可取消模式（显示取消键位提示并提供 AbortSignal），
 * 也可退化为不可取消的普通 Loader（信号由内部 AbortController 提供）。
 */
import { CancellableLoader, Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * 用边框包装的 Loader 组件，供扩展 UI 使用。
 * cancellable 为 true（默认）时内部是 CancellableLoader，
 * 否则是普通 Loader + 独立的 AbortController。
 */
export class BorderedLoader extends Container {
	private loader: CancellableLoader | Loader;
	private cancellable: boolean;
	private signalController?: AbortController;

	constructor(tui: TUI, theme: Theme, message: string, options?: { cancellable?: boolean }) {
		super();
		// 默认可取消；不可取消时用独立 AbortController 暴露 signal
		this.cancellable = options?.cancellable ?? true;
		const borderColor = (s: string) => theme.fg("border", s);
		// 顶部动态边框
		this.addChild(new DynamicBorder(borderColor));
		if (this.cancellable) {
			// 可取消：CancellableLoader 自带取消键处理与 AbortSignal
			this.loader = new CancellableLoader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		} else {
			// 不可取消：普通 Loader，signal 由自建控制器提供
			this.signalController = new AbortController();
			this.loader = new Loader(
				tui,
				(s) => theme.fg("accent", s),
				(s) => theme.fg("muted", s),
				message,
			);
		}
		this.addChild(this.loader);
		if (this.cancellable) {
			// 可取消模式在底部追加取消键位提示
			this.addChild(new Spacer(1));
			this.addChild(new Text(keyHint("tui.select.cancel", "cancel"), 1, 0));
		}
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder(borderColor));
	}

	/** 获取中断信号：可取消时取 CancellableLoader 的，否则取内部控制器的 */
	get signal(): AbortSignal {
		if (this.cancellable) {
			return (this.loader as CancellableLoader).signal;
		}
		return this.signalController?.signal ?? new AbortController().signal;
	}

	/** 设置中断回调（仅可取消模式生效） */
	set onAbort(fn: (() => void) | undefined) {
		if (this.cancellable) {
			(this.loader as CancellableLoader).onAbort = fn;
		}
	}

	/** 转发键盘输入给内部 CancellableLoader（仅可取消模式生效） */
	handleInput(data: string): void {
		if (this.cancellable) {
			(this.loader as CancellableLoader).handleInput(data);
		}
	}

	/** 释放资源：优先调用 dispose，否则退回 stop 停止 spinner */
	dispose(): void {
		// 鸭子类型探测：Loader 实现可能只有 stop 而没有 dispose
		if ("dispose" in this.loader && typeof this.loader.dispose === "function") {
			this.loader.dispose();
		} else if ("stop" in this.loader && typeof this.loader.stop === "function") {
			this.loader.stop();
		}
	}
}
