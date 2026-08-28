/**
 * @file extension-input.ts —— 扩展用简单文本输入组件
 *
 * @description
 * 面向扩展的单行文本输入框：标题 + 输入区 + 底部提交/取消键位提示，
 * 外层包裹动态边框。支持可选的超时倒计时（标题显示剩余秒数，到时自动取消）。
 */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/** ExtensionInputComponent 的可选配置项 */
export interface ExtensionInputOptions {
	/** 宿主 TUI 实例，超时倒计时依赖它驱动定时器 */
	tui?: TUI;
	/** 超时毫秒数；大于 0 且提供 tui 时启用倒计时，到时自动触发取消 */
	timeout?: number;
}

/**
 * 扩展用文本输入组件：内部持有 pi-tui 的 Input 处理常规编辑按键，
 * 确认/取消键位则在本组件拦截后回调宿主。
 */
export class ExtensionInputComponent extends Container implements Focusable {
	private input: Input;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;

	// Focusable 实现——同步传播给内部 Input，用于输入法（IME）光标定位
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		title: string,
		// 占位符参数当前未使用，保留以兼容现有调用方签名
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: ExtensionInputOptions,
	) {
		super();

		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		// 记录原始标题，倒计时刷新时在其后追加剩余秒数
		this.baseTitle = title;

		// 顶部动态边框 + 空行
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// 标题行：accent 色；倒计时模式下会被反复覆写
		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		// 配置了超时则创建倒计时：标题实时显示剩余秒数，归零后自动取消
		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", `${this.baseTitle} (${s}s)`)),
				() => this.onCancelCallback(),
			);
		}

		// 实际的文本输入区
		this.input = new Input();
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		// 底部键位提示行：提交 / 取消
		this.addChild(
			new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/** 处理键盘输入：确认/取消在本层拦截，其余交给内部 Input */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 确认：提交当前输入值
			this.onSubmitCallback(this.input.getValue());
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 取消输入
			this.onCancelCallback();
		} else {
			// 其余按键走常规文本编辑
			this.input.handleInput(keyData);
		}
	}

	/** 释放资源：销毁可能存在的倒计时定时器 */
	dispose(): void {
		this.countdown?.dispose();
	}
}
