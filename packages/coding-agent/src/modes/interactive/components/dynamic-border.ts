/**
 * @file dynamic-border.ts —— 随视口宽度自适应的动态边框组件
 *
 * @description
 * 渲染一条与给定宽度等长的水平分隔线（─），宽度变化时自动适配，
 * 用作选择器、加载器、公告等组件的上下边界。
 */
import type { Component } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * 随视口宽度自适应的动态边框组件。
 *
 * NOTE: 经 jiti 加载的扩展使用本组件时，全局 `theme` 可能是 undefined
 * （jiti 会创建独立的模块缓存）。因此在导出给扩展使用的组件里
 * 请务必显式传入颜色函数，不要依赖默认值。
 */
export class DynamicBorder implements Component {
	/** 边框字符的着色函数 */
	private color: (str: string) => string;

	// 默认用主题的 border 色；扩展场景务必显式传入（见上方 NOTE）
	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态。
	}

	/** 渲染一条与宽度等长的边框线（至少 1 个字符） */
	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
