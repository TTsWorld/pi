/**
 * @file whitespace-component.ts
 * @description 空白占位组件 —— 渲染指定数量的空行，用于组件间垂直间距
 * @module pi-tui
 *
 * 主要功能：
 * - 按构造时指定的数量生成空行（负数会被截断为 0）
 * - 内容固定不变：仅首次 render 报告 changed: true，后续渲染可跳过重绘
 * - 实现 Component 接口，可嵌入任意容器布局中充当"间隔物"
 */
import type { Component, ComponentRenderResult } from "./tui.js";

/**
 * 空白占位组件 —— 渲染指定数量的空行，用于组件之间的垂直间距。
 * 内容在构造时即已固定：仅首次渲染报告"已变化"，之后渲染循环可直接跳过重绘。
 */
export class WhitespaceComponent implements Component {
	/** 预生成的空行数组（长度即空行数量），每次渲染直接复用 */
	private lines: string[] = [];
	/** 需要渲染的空行数量（保证非负） */
	private lineCount: number;
	/** 是否尚未渲染过；首次渲染返回 changed: true 以触发实际绘制 */
	private firstRender: boolean = true;

	/**
	 * 创建空白占位组件。
	 * @param lineCount 空行数量，默认为 1；传入负数会被截断为 0
	 */
	constructor(lineCount: number = 1) {
		this.lineCount = Math.max(0, lineCount); // 保证非负
		this.lines = new Array(this.lineCount).fill(""); // 预生成 lineCount 个空字符串行
	}

	/**
	 * 渲染组件：返回构造时预生成的空行数组。
	 * 空行内容与终端宽度无关，因此忽略 _width 参数。
	 * @param _width 可用宽度（终端列数，本组件未使用）
	 * @returns 渲染结果：空行数组；仅首次调用时 changed 为 true，之后恒为 false
	 */
	render(_width: number): ComponentRenderResult {
		const result = {
			lines: this.lines, // 固定不变的空行，直接复用
			changed: this.firstRender, // 只有首次渲染才标记"已变化"
		};
		this.firstRender = false; // 后续渲染不再报告变化
		return result;
	}
}
