/**
 * @file custom-entry.ts —— 扩展自定义会话条目渲染组件
 *
 * @description
 * 渲染扩展写入会话记录（session）的 CustomEntry 条目：完全委托扩展
 * 提供的 EntryRenderer 生成组件，渲染抛错时降级为错误提示框。
 * 与 CustomMessageComponent 不同，这里没有默认样式，渲染器是必需的。
 */
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "../../../core/extensions/types.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

/**
 * 渲染来自扩展的自定义会话条目的组件。
 * 宿主负责会话记录的行距；渲染器输出只需提供自己的内容。
 * 渲染失败时不抛出，而是显示带错误信息的提示框。
 */
export class CustomEntryComponent extends Container {
	private entry: CustomEntry<unknown>;
	private renderer: EntryRenderer;
	private customComponent?: Component;
	private _expanded = false;

	constructor(entry: CustomEntry<unknown>, renderer: EntryRenderer) {
		super();
		this.entry = entry;
		this.renderer = renderer;
		this.rebuild();
	}

	/** 是否渲染出了内容（渲染器返回空则视为无内容，宿主可据此跳过） */
	hasContent(): boolean {
		return this.customComponent !== undefined;
	}

	/** 切换展开/折叠状态，状态变化时重建内容 */
	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	/** 继承自 Container：失效时连带重建内部内容（适配宽度变化等场景） */
	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	/**
	 * 重建内部内容：清空后重新调用扩展渲染器生成组件，
	 * 渲染抛错时降级为错误提示框。
	 */
	private rebuild(): void {
		this.clear();
		this.customComponent = undefined;

		let component: Component | undefined;
		try {
			// 委托扩展的 EntryRenderer，传入当前展开状态与主题
			component = this.renderer(this.entry, { expanded: this._expanded }, theme);
		} catch (error) {
			// 渲染器抛错：兜底渲染一个错误信息框而不是让 UI 崩溃
			const message = error instanceof Error ? error.message : String(error);
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(theme.fg("error", `[${this.entry.customType}] renderer failed: ${message}`), 0, 0));
			component = box;
		}

		// 渲染器显式返回空：本条目不显示任何内容
		if (!component) {
			return;
		}

		this.customComponent = component;
		this.addChild(new Spacer(1));
		this.addChild(component);
	}
}
