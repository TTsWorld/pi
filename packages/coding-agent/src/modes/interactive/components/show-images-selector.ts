/**
 * @file show-images-selector.ts —— 图片显示开关选择器组件
 *
 * @description
 * 供设置「是否在终端内联显示图片」用的二选一列表（Yes / No）：
 * 基于 pi-tui 的 SelectList，预选当前值，确认/取消后回调宿主，
 * 上下以动态边框包裹。
 */
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

// 主列宽度约束，与主题选择器保持一致的布局风格
const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * 渲染「显示图片与否」选择器的组件（带上下边框）。
 * 键盘输入由宿主通过 getSelectList() 取出内部列表后转发。
 */
export class ShowImagesSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		// 固定的两个选项：内联显示图片 / 显示文字占位
		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		// 顶部边框
		this.addChild(new DynamicBorder());

		// 创建选择列表（最多同时显示 5 项）
		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);

		// 预选当前值：yes 在第 0 项、no 在第 1 项
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		// 确认选中：把字符串选项映射回布尔值
		this.selectList.onSelect = (item) => {
			onSelect(item.value === "yes");
		};

		// 取消选择
		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);

		// 底部边框
		this.addChild(new DynamicBorder());
	}

	/** 暴露内部 SelectList，供宿主接管键盘输入 */
	getSelectList(): SelectList {
		return this.selectList;
	}
}
