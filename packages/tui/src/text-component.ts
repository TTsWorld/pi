/**
 * @file text-component.ts
 * @description 静态文本组件 —— 按宽度自动换行与四边内边距渲染
 * @module pi-tui
 *
 * 主要功能：
 * - 渲染一段静态多行文本，按传入的可用宽度做英文单词级自动换行（word wrapping）
 * - 支持上/下/左/右四边内边距（Padding），各方向可选，缺省为 0
 * - 换行时的长度计算感知 ANSI 转义序列（颜色/样式码不占显示宽度）
 * - 通过对比本次与上次渲染结果输出 changed 标记，支持外层增量重绘优化
 *
 * 依赖关系：
 * - ./tui.js：Component（组件契约）、ComponentRenderResult（渲染结果）、Padding（内边距配置）
 */

import type { Component, ComponentRenderResult, Padding } from "./tui.js";

/**
 * 静态文本组件。
 * 实现 Component 接口：将一段固定文本按给定宽度换行渲染为若干行，
 * 可附加四边内边距；文本内容可在运行时通过 setText 更新。
 */
export class TextComponent implements Component {
	/** 当前持有的文本内容（可含换行符与 ANSI 转义序列） */
	private text: string;
	/** 上一次 render 输出的行快照，用于判断内容是否变化 */
	private lastRenderedLines: string[] = [];
	/** 四边内边距（构造时已把可选字段补全为具体数值） */
	private padding: Required<Padding>;

	/**
	 * 创建静态文本组件。
	 * @param text 初始文本内容，可包含换行符（换行按原样保留）与 ANSI 转义序列
	 * @param padding 四边内边距配置（单位：顶部/底部为行数，左侧/右侧为列数），可选，缺省为 0
	 */
	constructor(text: string, padding?: Padding) {
		this.text = text;
		// 将可选的 Padding 归一化为四边齐全的对象，后续使用无需再判空
		this.padding = {
			top: padding?.top ?? 0,
			bottom: padding?.bottom ?? 0,
			left: padding?.left ?? 0,
			right: padding?.right ?? 0,
		};
	}

	/**
	 * 将文本渲染为若干行：施加内边距并按可用宽度做单词级换行。
	 * 整体顺序：顶部内边距空行 → 逐行换行后的内容（每行行首拼左内边距）→ 底部内边距空行。
	 * @param width 可用总宽度（终端列数）
	 * @returns 渲染出的文本行及内容是否较上次发生变化
	 */
	render(width: number): ComponentRenderResult {
		// 计算扣除左右内边距后的可用内容宽度；
		// Math.max(1, ...) 兜底，避免宽度不足时得到 0 或负值导致换行逻辑失效
		const availableWidth = Math.max(1, width - this.padding.left - this.padding.right);
		// 左内边距：与 left 等宽的空格串，之后拼到每一内容行行首
		const leftPadding = " ".repeat(this.padding.left);

		// 先按换行符切分，保留文本中原有的换行（显式换行不做折叠）
		const textLines = this.text.split("\n");
		const lines: string[] = [];

		// 顶部内边距：先压入 top 个空行
		for (let i = 0; i < this.padding.top; i++) {
			lines.push("");
		}

		// 逐行处理，做单词级自动换行
		for (const textLine of textLines) {
			if (textLine.length === 0) {
				// 空行原样保留，但仍拼上左内边距以保持缩进对齐
				lines.push(leftPadding);
			} else {
				// 按空格分词做 word wrapping；长度计算感知 ANSI 转义序列
				const words = textLine.split(" ");
				let currentLine = ""; // 当前正在累积的行内容（不含左内边距）
				let currentVisibleLength = 0; // 当前行的可见字符数（不含 ANSI 码）

				for (const word of words) {
					const wordVisibleLength = this.getVisibleLength(word);
					// 词间分隔空格数：行内非首词为 1，行首词为 0（无需前导空格）
					const spaceLength = currentLine ? 1 : 0;

					// 贪心策略：当前行还放得下这个单词，就继续追加
					if (currentVisibleLength + spaceLength + wordVisibleLength <= availableWidth) {
						currentLine += (currentLine ? " " : "") + word;
						currentVisibleLength += spaceLength + wordVisibleLength;
					} else {
						// 放不下：先把已累积的行落盘（拼上左内边距）……
						if (currentLine) {
							lines.push(leftPadding + currentLine);
						}
						// ……再从当前单词开启新行。
						// 边界：单个单词本身超宽时不再切分，整词独占一行（可能溢出）
						currentLine = word;
						currentVisibleLength = wordVisibleLength;
					}
				}

				// 收尾：压入最后一个未满的行
				if (currentLine) {
					lines.push(leftPadding + currentLine);
				}
			}
		}

		// 底部内边距：最后压入 bottom 个空行
		for (let i = 0; i < this.padding.bottom; i++) {
			lines.push("");
		}

		// 边界兜底：保证至少返回一行（如文本为空且无内边距时）
		const newLines = lines.length > 0 ? lines : [""];

		// 与上次渲染结果逐行比较，判断内容是否变化
		const changed = !this.arraysEqual(newLines, this.lastRenderedLines);

		// 无论是否变化都缓存本次结果，作为下一次比较的基准
		this.lastRenderedLines = [...newLines];

		return {
			lines: newLines,
			changed,
		};
	}

	/**
	 * 更新文本内容（下次 render 时生效）。
	 * @param text 新的文本内容
	 */
	setText(text: string): void {
		this.text = text;
	}

	/**
	 * 获取当前文本内容。
	 * @returns 当前文本（原始未渲染形式）
	 */
	getText(): string {
		return this.text;
	}

	/**
	 * 逐元素比较两个字符串数组是否完全相同。
	 * @param a 数组一
	 * @param b 数组二
	 * @returns 长度及所有元素均一致时返回 true
	 */
	private arraysEqual(a: string[], b: string[]): boolean {
		// 长度不同直接判不等（快速短路）
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	/**
	 * 计算字符串在终端上的可见长度。
	 * @param str 待测字符串，可能包含 ANSI 转义序列
	 * @returns 剔除 ANSI 转义序列后的字符数
	 */
	private getVisibleLength(str: string): number {
		// 先移除 ANSI 转义序列（\x1b[...m 形式的 SGR 颜色/样式码）再计数，
		// 这些码不占终端显示宽度；`str || ""` 兜底防 null/undefined
		return (str || "").replace(/\x1b\[[0-9;]*m/g, "").length;
	}
}
