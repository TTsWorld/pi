/**
 * @file extension-selector.ts —— 扩展通用选项列表选择器
 *
 * @description
 * 面向扩展的通用选择器组件：以字符串列表展示候选项，
 * 支持键盘上下导航（含 vim 风格 j/k）、确认与取消，
 * 并可选超时倒计时（标题实时显示剩余秒数，到时自动取消）。
 */

import { Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** ExtensionSelectorComponent 的可选配置项 */
export interface ExtensionSelectorOptions {
	/** 宿主 TUI 实例，超时倒计时依赖它驱动定时器 */
	tui?: TUI;
	/** 超时毫秒数；大于 0 且提供 tui 时启用倒计时，到时自动触发取消 */
	timeout?: number;
	/** 按下「展开工具列表」键位时的回调 */
	onToggleToolsExpanded?: () => void;
}

/**
 * 通用选项选择器组件：渲染标题、选项列表与底部键位提示，
 * 宿主通过 handleInput 把键盘事件转发进来，选中/取消时回调。
 */
export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		// 记录原始标题，倒计时刷新时在其后追加剩余秒数
		this.baseTitle = title;

		// 顶部动态边框 + 空行
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// 标题行：accent 色加粗；倒计时模式下会被反复覆写
		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		// 配置了超时则创建倒计时：标题实时显示剩余秒数，归零后自动取消
		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		// 选项列表容器（updateList 时整体重建其中的内容）
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		// 底部键位提示行：导航 / 确认 / 取消
		// 具体按键文案由当前键位配置动态生成
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// 初始渲染一次列表
		this.updateList();
	}

	/** 重建选项列表：当前选中项前加「→ 」并以 accent 色高亮 */
	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			// 选中项带箭头高亮，未选中项缩进两格与箭头对齐
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	/** 处理键盘输入：上下移动光标，确认/取消时回调宿主 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			// 展开工具列表（若宿主提供了回调）
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			// 上移（支持 vim 风格 k 键），不越过第一项
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			// 下移（支持 vim 风格 j 键），不越过最后一项
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 确认：回调当前选中项
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 取消选择
			this.onCancelCallback();
		}
	}

	/** 释放资源：销毁可能存在的倒计时定时器 */
	dispose(): void {
		this.countdown?.dispose();
	}
}
