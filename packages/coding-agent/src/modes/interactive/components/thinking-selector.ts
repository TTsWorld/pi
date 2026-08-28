/**
 * @file thinking-selector.ts —— 思考级别选择器组件
 *
 * @description
 * 渲染一个带边框的弹层，让用户在会话内选择模型思考（reasoning）级别：
 * 顶部有搜索框支持模糊过滤，主体是级别列表（off/minimal/low/medium/high/xhigh/max），
 * Enter 选定、Ctrl+S 设为默认、Esc 取消。
 * 列表基于 pi-tui 的 SelectList 实现，输入按「导航键优先、其余进搜索框」分流。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

// 思考级别列表的列宽约束：主列（级别名）占 12~32 列，保证描述文字有足够空间
const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

// 各思考级别的展示描述（token 数为大致量级，帮助用户权衡速度与深度）
const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/**
 * 带边框的思考级别选择器组件。
 *
 * 组成：顶部边框 + 标题/提示 + 搜索输入框 + SelectList 列表 + 按键提示 + 底部边框。
 * 实现 Focusable：聚焦状态会同步给内部搜索框；键盘输入在「列表导航」与
 * 「搜索过滤」之间智能分流。
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: SelectItem[];
	private onSelect: (level: ThinkingLevel) => void;
	private onCancel: () => void;
	private onSelectAsDefault?: (level: ThinkingLevel) => void;
	private _focused = false;

	/** 当前是否获得焦点（Focusable 接口）。 */
	get focused(): boolean {
		return this._focused;
	}

	/** 设置焦点时同步联动内部搜索框，保证光标显隐正确。 */
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		super();
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.onSelectAsDefault = onSelectAsDefault;

		// 构建全部可选项；若某级别恰为默认级别，则在描述后追加 " · default" 标记
		this.allItems = availableLevels.map((level) => ({
			value: level,
			label: level,
			description:
				level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · default` : LEVEL_DESCRIPTIONS[level],
		}));

		// ===== 顶部：边框 + 标题 + 快捷键提示 + 搜索框 =====
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("Thinking Level", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} cycles thinking levels in-session`, 0, 0));
		this.addChild(new Spacer(1));

		// 搜索框中直接回车等价于确认列表当前选中项
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// 创建选择列表，并记录其在容器 children 中的下标（过滤时按此下标原地替换）
		this.selectList = this.buildSelectList(this.allItems, currentLevel);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Ctrl+S to set as default · Esc to cancel"), 0, 0));

		// 底部边框收尾
		this.addChild(new DynamicBorder());
	}

	/**
	 * 构建一个 SelectList 实例：所有项一次全部可见（高度 = 项数，至少 1），
	 * 并挂接选中/取消回调；preselect 命中时预先高亮该级别。
	 */
	private buildSelectList(items: SelectItem[], preselect?: ThinkingLevel): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), THINKING_SELECT_LIST_LAYOUT);
		const currentIndex = items.findIndex((item) => item.value === preselect);
		if (currentIndex !== -1) {
			list.setSelectedIndex(currentIndex);
		}
		list.onSelect = (item) => this.onSelect(item.value as ThinkingLevel);
		list.onCancel = () => this.onCancel();
		return list;
	}

	/**
	 * 按搜索词过滤列表并用新列表原地替换旧实例。
	 * 过滤前先记住当前选中值并在新列表中恢复，避免输入时选中态被重置。
	 */
	private applyFilter(query: string): void {
		// 以「标签 + 描述」拼成的文本做模糊匹配，命中任一即可保留
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allItems;
		const selectedValue = this.selectList.getSelectedItem()?.value as ThinkingLevel | undefined;
		const newList = this.buildSelectList(filtered, selectedValue);
		this.children[this.selectListChildIndex] = newList;
		this.selectList = newList;
	}

	handleInput(keyData: string): void {
		// Ctrl+S：把当前选中级别设为默认（仅在提供 onSelectAsDefault 回调时生效）
		if (matchesKey(keyData, "ctrl+s") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);
			return;
		}

		// ===== 按键分流 =====
		// 导航/确认/取消键交给列表处理；其余按键（普通字符、退格等）进入搜索框
		const kb = getKeybindings();
		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (isNav) {
			this.selectList.handleInput(keyData);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	/** 暴露内部列表实例（宿主可据此查询选中项或驱动渲染）。 */
	getSelectList(): SelectList {
		return this.selectList;
	}
}
