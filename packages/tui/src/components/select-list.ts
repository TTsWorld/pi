/**
 * @file 过滤 + 滚动选择列表组件（SelectList）
 * @description
 * pi monorepo 终端 UI 框架（tui 包）中的一个可复用组件：
 * 提供带前缀过滤（starts-with 匹配）和滚动窗口的选项列表，
 * 支持上下方向键移动选中项、Enter 确认选择、Escape 取消。
 *
 * 主要功能：
 * - `setFilter()` 按用户输入的过滤词筛选选项（不区分大小写的前缀匹配）
 * - `render()` 以「选中项居中」的滚动窗口方式渲染可见区间的选项行，
 *   宽度足够时同时展示描述文本，并按终端宽度截断
 * - `handleInput()` 处理方向键 / Enter / Escape 等原始按键序列
 *
 * 依赖关系：
 * - chalk：终端着色（选中项高亮、描述灰显、滚动指示器）
 * - ../tui.js：Component 接口、ComponentRenderResult 渲染结果类型、
 *   getNextComponentId() 组件自增 ID 生成器
 */

import chalk from "chalk";
import { type Component, type ComponentRenderResult, getNextComponentId } from "../tui.js";

/** 选择列表中的单个选项 */
export interface SelectItem {
	/** 选项的实际值（也作为过滤匹配的字段） */
	value: string;
	/** 显示用的标签文本；渲染时优先于 value 展示 */
	label: string;
	/** 可选的补充说明文本，仅在终端宽度足够（> 40 列）时展示 */
	description?: string;
}

/**
 * 过滤 + 滚动选择列表组件。
 *
 * 实现 Component 接口，由外部 TUI 框架驱动渲染与按键分发；
 * 通过 `onSelect` / `onCancel` 回调与宿主交互。
 */
export class SelectList implements Component {
	/** 组件唯一 ID，由 TUI 框架分配，用于 diff 调度 */
	readonly id = getNextComponentId();
	/** 完整的选项列表（过滤的原始数据源） */
	private items: SelectItem[] = [];
	/** 经 filter 过滤后的选项列表（实际渲染和导航的范围） */
	private filteredItems: SelectItem[] = [];
	/** 当前选中项在 filteredItems 中的下标 */
	private selectedIndex: number = 0;
	/** 当前过滤词 */
	private filter: string = "";
	/** 滚动窗口大小：最多同时可见的选项条数 */
	private maxVisible: number = 5;

	/** 选中某项（按 Enter）时触发的回调 */
	public onSelect?: (item: SelectItem) => void;
	/** 取消选择（按 Escape）时触发的回调 */
	public onCancel?: () => void;

	/**
	 * 创建选择列表。
	 * @param items 全部可选选项
	 * @param maxVisible 滚动窗口大小（最多同时显示几条），默认 5
	 */
	constructor(items: SelectItem[], maxVisible: number = 5) {
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
	}

	/**
	 * 设置过滤词并重新筛选选项。
	 * 匹配规则：item.value 不区分大小写地以 filter 开头（前缀匹配）。
	 * @param filter 用户输入的过滤词
	 */
	setFilter(filter: string): void {
		this.filter = filter;
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// 过滤条件变化后选中项可能已不在结果集中，重置到第一项避免悬空下标
		this.selectedIndex = 0;
	}

	/**
	 * 渲染列表的可见区域。
	 * @param width 终端可用宽度（列数），决定描述文本是否展示以及截断长度
	 * @returns 渲染结果：逐行文本 + changed 标记
	 */
	render(width: number): ComponentRenderResult {
		const lines: string[] = [];

		// 没有任何选项命中过滤词时，只渲染一条提示信息
		if (this.filteredItems.length === 0) {
			lines.push(chalk.gray("  No matching commands"));
			return { lines, changed: true };
		}

		// ========== 计算滚动窗口（可见区间） ==========
		// 以选中项为中心的窗口：理想起点是 selectedIndex - maxVisible/2，
		// 再用 Math.max/min 夹在 [0, length - maxVisible] 内，
		// 保证窗口既不越出列表顶部，也能在列表尾部完整占满 maxVisible 条
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		// ========== 逐行渲染可见选项 ==========
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;

			let line = "";
			if (isSelected) {
				// ========== 选中项渲染：蓝色箭头前缀 + 高亮文本 ==========
				// 用箭头指示符标记当前选中行
				const prefix = chalk.blue("→ ");
				const displayValue = item.label || item.value;

				if (item.description && width > 40) {
					// 宽度足够时：值与描述同行排列
					// 值最长截到 30 列，保证描述有起始空间
					const maxValueLength = Math.min(displayValue.length, 30);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					// 用空格把描述推到至少第 32 列，形成对齐的两列布局
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// 计算描述可用的剩余宽度
					// -2 是为了抵消箭头前缀里 chalk 颜色转义码占用的长度
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length - 2; // -2 抵消箭头的颜色转义码
					const remainingWidth = width - descriptionStart - 2; // -2 为安全余量，避免顶到右边缘

					if (remainingWidth > 10) {
						// 剩余空间足够（> 10 列）才值得展示描述
						const truncatedDesc = item.description.substring(0, remainingWidth);
						line = prefix + chalk.blue(truncatedValue) + chalk.gray(spacing + truncatedDesc);
					} else {
						// 剩余空间不足：退化为只显示值
						// 扣除 4 列 = 箭头 2 列（"→ "）+ 安全余量 2 列
						const maxWidth = width - 4; // 2 列给箭头 + 空格，2 列安全余量
						line = prefix + chalk.blue(displayValue.substring(0, maxWidth));
					}
				} else {
					// 无描述或终端太窄（≤ 40 列）：只显示值
					const maxWidth = width - 4; // 2 列给箭头 + 空格，2 列安全余量
					line = prefix + chalk.blue(displayValue.substring(0, maxWidth));
				}
			} else {
				// ========== 非选中项渲染：两空格前缀、无着色 ==========
				const displayValue = item.label || item.value;
				const prefix = "  ";

				if (item.description && width > 40) {
					// 与选中项分支相同的两列布局逻辑，但不做高亮
					// 值最长截到 30 列，保证描述有起始空间
					const maxValueLength = Math.min(displayValue.length, 30);
					const truncatedValue = displayValue.substring(0, maxValueLength);
					// 用空格把描述推到至少第 32 列，与选中项的列对齐方式保持一致
					const spacing = " ".repeat(Math.max(1, 32 - truncatedValue.length));

					// 计算描述可用的剩余宽度（普通前缀无颜色码，无需额外补偿）
					// 留 2 列安全余量
					const descriptionStart = prefix.length + truncatedValue.length + spacing.length;
					const remainingWidth = width - descriptionStart - 2; // -2 为安全余量

					if (remainingWidth > 10) {
						// 剩余空间足够（> 10 列）才展示描述（灰显）
						const truncatedDesc = item.description.substring(0, remainingWidth);
						line = prefix + truncatedValue + chalk.gray(spacing + truncatedDesc);
					} else {
						// 剩余空间不足：只显示值
						const maxWidth = width - prefix.length - 2;
						line = prefix + displayValue.substring(0, maxWidth);
					}
				} else {
					// 无描述或终端太窄（≤ 40 列）：只显示值
					const maxWidth = width - prefix.length - 2;
					line = prefix + displayValue.substring(0, maxWidth);
				}
			}

			lines.push(line);
		}

		// ========== 滚动指示器 ==========
		// 列表未完整展示在窗口内（上方或下方还有被截掉的项）时，
		// 追加一行灰色的「当前位置/总数」提示，例如 (3/12)
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const scrollInfo = chalk.gray(`  (${this.selectedIndex + 1}/${this.filteredItems.length})`);
			lines.push(scrollInfo);
		}

		return { lines, changed: true };
	}

	/**
	 * 处理原始按键输入（由外部键盘事件循环分发）。
	 * @param keyData 按键的原始转义序列或字符
	 */
	handleInput(keyData: string): void {
		// 上方向键（ANSI 转义序列 \x1b[A）：选中项上移，顶部边界夹在 0
		if (keyData === "\x1b[A") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// 下方向键（ANSI 转义序列 \x1b[B）：选中项下移，底部边界夹在最后一项
		else if (keyData === "\x1b[B") {
			this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
		}
		// Enter（\r 回车符）：确认选择，触发 onSelect 回调
		else if (keyData === "\r") {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape（裸 \x1b）：取消选择，触发 onCancel 回调
		else if (keyData === "\x1b") {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/**
	 * 获取当前选中的选项。
	 * @returns 当前选中项；若过滤结果为空（无选中项）则返回 null
	 */
	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}
