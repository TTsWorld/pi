/**
 * @file select-list.ts
 * @description 选择列表组件 —— 键盘导航、前缀过滤与滚动显示
 * @module pi-tui
 *
 * 主要功能：
 * - SelectList 类：实现 Component 接口的交互式选择列表（如命令补全候选列表）
 * - 前缀过滤：setFilter 按 value 做不区分大小写的前缀匹配过滤条目，过滤后重置选中项
 * - 滚动窗口：条目数超过 maxVisible 时，以选中项为中心计算可见窗口，并显示 "当前项/总项数" 指示器
 * - 键盘导航：上/下箭头移动选中项、Enter 触发 onSelect 确认、Esc 触发 onCancel 取消
 * - 双列渲染：选中行带箭头指示符与蓝色高亮；条目含描述且终端足够宽（>40 列）时，值列对齐并灰色展示描述列
 *
 * 依赖关系：
 * - chalk：终端彩色输出（选中高亮、描述灰显、滚动指示）
 * - ./tui.js：Component 组件契约接口与 ComponentRenderResult 渲染结果类型
 */

import chalk from "chalk";
import type { Component, ComponentRenderResult } from "./tui.js";

/**
 * 选择列表中的单个条目。
 */
export interface SelectItem {
	/** 实际取值：用于过滤匹配（前缀比对）与提交；无 label 时也会回退用于显示 */
	value: string;
	/** 显示文本：渲染时优先展示；缺省时回退显示 value */
	label: string;
	/** 可选描述：终端宽度足够（>40 列）时以灰色对齐显示在条目右侧 */
	description?: string;
}

/**
 * 选择列表组件 —— 支持键盘导航、前缀过滤与滚动窗口的交互式列表。
 *
 * 实现 Component 接口：render 输出当前可见窗口内的文本行；
 * handleInput 处理 ↑/↓ 移动选中项、Enter 确认（onSelect）、Esc 取消（onCancel）。
 * 过滤条件变化时基于条目 value 做不区分大小写的前缀匹配，并重置选中项。
 */
export class SelectList implements Component {
	/** 全量条目列表（不因过滤而改变，始终保留原始数据） */
	private items: SelectItem[] = [];
	/** 经当前 filter 过滤后的条目列表（渲染与导航均基于此列表） */
	private filteredItems: SelectItem[] = [];
	/** 当前选中项在 filteredItems 中的下标 */
	private selectedIndex: number = 0;
	/** 当前过滤前缀字符串 */
	private filter: string = "";
	/** 滚动窗口大小：单屏最多可见的条目数 */
	private maxVisible: number = 5;

	/** 选中确认回调：按 Enter 时触发，携带当前选中的条目 */
	public onSelect?: (item: SelectItem) => void;
	/** 取消回调：按 Esc 时触发 */
	public onCancel?: () => void;

	/**
	 * 创建选择列表。
	 * @param items 初始条目列表（初始时过滤结果即全量列表）
	 * @param maxVisible 滚动窗口大小（单屏最多显示的条目数），默认 5
	 */
	constructor(items: SelectItem[], maxVisible: number = 5) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
	}

	/**
	 * 设置过滤前缀并重算可见条目。
	 * 匹配规则：条目 value 与 filter 均转小写后做前缀匹配（不区分大小写）。
	 * @param filter 过滤前缀字符串
	 */
	setFilter(filter: string): void {
		this.filter = filter;
		// 前缀匹配：仅保留 value 以 filter 开头的条目（两侧都转小写，实现不区分大小写）
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// 过滤条件变化后选中项重置为第一条，避免下标越界或仍指向已被过滤掉的条目
		this.selectedIndex = 0;
	}

	/**
	 * 渲染列表当前可见窗口为文本行。
	 * @param width 可用宽度（终端列数），用于决定描述列是否显示以及各处截断长度
	 * @returns 渲染出的文本行及变化标志（本组件恒为 true）
	 */
	render(width: number): ComponentRenderResult {
		const lines: string[] = [];

		// ========== 空结果边界处理 ==========
		// 过滤后无任何匹配条目时，仅输出灰色提示并直接返回
		if (this.filteredItems.length === 0) {
			lines.push(chalk.gray("  No matching commands"));
			return { lines, changed: true };
		}

		// ========== 计算滚动窗口（可见范围） ==========
		// 以选中项为中心：理想起点为 selectedIndex - maxVisible/2（向下取整），
		// 再经 Math.min/Math.max 双重夹取，保证窗口在列表头尾均不越界
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// ========== 渲染可见条目 ==========
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			// 防御性检查：越界下标直接跳过（正常情况下不会发生）
			if (!item) continue;

			const isSelected = i === this.selectedIndex;

			let line = "";
			if (isSelected) {
				// 选中行：蓝色箭头指示符标记当前位置
				const prefix = chalk.blue("→ ");
				// 显示文本优先取 label，缺省时回退到 value
				const displayValue = item.label || item.value;

				// 宽度门槛 40 列：条目带描述且终端足够宽时，才尝试在右侧展示描述列
				if (item.description && width > 40) {
					// 值列最多占 30 个字符，超出截断，为描述列留出空间
					const maxValueLength = Math.min(displayValue.length, 30);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					// 值列补齐到 32 列，保证各条目的描述列纵向对齐（至少 1 个空格）
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// 计算描述列的起始列位置；prefix 含 ANSI 颜色转义码，需减去多出的 2 个字符长度
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length - 2; // -2 抵消箭头颜色码
					// 再预留 2 列安全边距，得到描述的可用宽度
					const remainingWidth = width - descriptionStart - 2; // -2 为安全边距

					// 描述可用宽度 >10 列才显示，否则截断后过短、没有展示价值
					if (remainingWidth > 10) {
						const truncatedDesc = item.description.substring(0, remainingWidth);
						line = prefix + chalk.blue(truncatedValue) + chalk.gray(spacing + truncatedDesc);
					} else {
						// 剩余空间不足以展示描述：只渲染值并按终端宽度截断
						const maxWidth = width - 4; // 2 列箭头前缀 + 2 列安全边距
						line = prefix + chalk.blue(displayValue.substring(0, maxWidth));
					}
				} else {
					// 无描述或终端太窄：只渲染值（扣减 2 列箭头前缀 + 2 列安全边距）
					const maxWidth = width - 4; // 2 列箭头前缀 + 2 列安全边距
					line = prefix + chalk.blue(displayValue.substring(0, maxWidth));
				}
			} else {
				// 非选中行：两个空格占位（与选中行的 "→ " 前缀等宽），文本不带颜色
				const displayValue = item.label || item.value;
				const prefix = "  ";

				// 与选中行相同：条目带描述且终端宽度 >40 列时展示描述列
				if (item.description && width > 40) {
					// 值列最多占 30 个字符，超出截断
					const maxValueLength = Math.min(displayValue.length, 30);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					// 值列补齐到 32 列，保证描述列纵向对齐
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// 纯空格前缀不含颜色码，长度直接累加即为描述起始列
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
					// 预留 2 列安全边距，得到描述的可用宽度
					const remainingWidth = width - descriptionStart - 2; // -2 为安全边距

					// 描述可用宽度 >10 列才显示
					if (remainingWidth > 10) {
						const truncatedDesc = item.description.substring(0, remainingWidth);
						line = prefix + truncatedValue + chalk.gray(spacing + truncatedDesc);
					} else {
						// 剩余空间不足以展示描述：只渲染值并按宽度截断（前缀 2 列 + 安全边距 2 列）
						const maxWidth = width - prefix.length - 2;
						line = prefix + displayValue.substring(0, maxWidth);
					}
				} else {
					// 无描述或终端太窄：只渲染值并截断
					const maxWidth = width - prefix.length - 2;
					line = prefix + displayValue.substring(0, maxWidth);
				}
			}

			lines.push(line);
		}

		// ========== 滚动指示器 ==========
		// 仅当窗口未覆盖全部条目（上方或下方仍有未显示的条目）时，追加 "当前项/总项数" 提示
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollInfo = chalk.gray(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`);
			lines.push(scrollInfo);
		}

		return { lines, changed: true };
	}

	/**
	 * 处理原始按键输入，实现键盘导航。
	 * 按键值为终端 raw 模式下的原始转义序列或控制字符。
	 * @param keyData 原始按键数据
	 */
	handleInput(keyData: string): void {
		// ========== 上箭头（\x1b[A）：选中项上移一位，但不越过首项 ==========
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// ========== 下箭头（\x1b[B）：选中项下移一位，但不越过过滤后最后一项 ==========
		else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
		}
		// ========== Enter（\r）：确认选择，触发 onSelect 回调 ==========
		else if (keyData === "\r") {
			const selectedItem = this.filteredItems[this.selectedIndex];
			// 边界保护：过滤后列表可能为空（此时取不到条目），不触发回调
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// ========== Esc（\x1b）：取消选择，触发 onCancel 回调 ==========
		else if (keyData === "\x1b") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/**
	 * 获取当前选中的条目。
	 * @returns 选中条目；过滤后列表为空（无条目可选）时返回 null
	 */
	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
