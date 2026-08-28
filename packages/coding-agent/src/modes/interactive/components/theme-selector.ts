/**
 * @file theme-selector.ts —— 主题选择器组件
 *
 * @description
 * 供 /theme 命令使用的主题选择界面：基于 pi-tui 的 SelectList 展示
 * 所有可用主题，移动光标时实时预览（onPreview），确认/取消后回调宿主。
 * 上下以动态边框包裹。
 */
import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@earendil-works/pi-tui";
import { getAvailableThemes, getSelectListTheme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

// 主题名列的宽度约束：至少 12 列、最多 32 列
// 避免主题名过长时撑爆选择列表的布局
const THEME_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * 渲染主题选择器的组件。
 * 光标移动即触发预览回调，确认选中或取消时结束。
 * 键盘输入由宿主通过 getSelectList() 取出内部列表后转发。
 */
export class ThemeSelectorComponent extends Container {
	private selectList: SelectList;
	/** 实时预览回调：光标停在某个主题上时宿主临时切换到该主题 */
	private onPreview: (themeName: string) => void;

	constructor(
		currentTheme: string,
		onSelect: (themeName: string) => void,
		onCancel: () => void,
		onPreview: (themeName: string) => void,
	) {
		super();
		this.onPreview = onPreview;

		// 获取可用主题并构造选项列表，当前主题标注 (current)
		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			// label 即主题名，当前主题在描述列标注
			label: name,
			description: name === currentTheme ? "(current)" : undefined,
		}));

		// 顶部边框
		this.addChild(new DynamicBorder());

		// 创建选择列表（最多同时显示 10 项）
		this.selectList = new SelectList(themeItems, 10, getSelectListTheme(), THEME_SELECT_LIST_LAYOUT);

		// 预选当前主题，光标初始落在它上面
		const currentIndex = themes.indexOf(currentTheme);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		// 确认选中
		this.selectList.onSelect = (item) => {
			onSelect(item.value);
		};

		// 取消选择
		this.selectList.onCancel = () => {
			onCancel();
		};

		// 光标移动：实时预览所停主题
		this.selectList.onSelectionChange = (item) => {
			this.onPreview(item.value);
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
