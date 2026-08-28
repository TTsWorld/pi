/**
 * @file settings-submenu.ts —— 设置界面的子菜单组件（单步与多步选择器）
 *
 * @description
 * 提供设置面板使用的两级子菜单构件：
 * - SelectSubmenu：单步子菜单，由标题 + 描述 + 选项列表（SelectList）组成，
 *   可选开启「输入即模糊过滤」的搜索框；
 * - SteppedSubmenu：通用 N 步子菜单，基于 SelectSubmenu 组合实现，
 *   每一步的标题 / 描述 / 选项都可依赖前几步的选择结果（共享 context），
 *   Esc 回退一步、第 0 步再 Esc 取消，可选在完成后回到第 0 步循环。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：Container / Input / SelectList / Text 等基础组件，
 *   以及 fuzzyFilter（模糊过滤）与 getKeybindings（按键归类判断）；
 * - `../theme/theme.ts`：主题配色与 SelectList 专属主题。
 */
import {
	type Component,
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";

// 子菜单选项列表的默认布局：主列（选项名）宽度限制在 12~32 格之间
const SUBMENU_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/** SelectSubmenu 的可选配置。 */
export interface SelectSubmenuOptions {
	/** 开启「输入即搜索」的模糊过滤。 */
	searchable?: boolean;
	/** 覆盖选项列表布局（列宽配置）。 */
	layout?: SelectListLayoutOptions;
}

/**
 * 单步子菜单：展示「标题 + 描述 + 选项列表」的选择界面。
 * 开启 `searchable: true` 时顶部附带搜索框，输入内容按模糊匹配实时过滤列表。
 * 选中回调 onSelect / 取消回调 onCancel 均由宿主在构造时注入。
 */
export class SelectSubmenu extends Container {
	// 底层选项列表组件；过滤后会整体重建替换
	private selectList: SelectList;
	// 列表在 children 中的下标，过滤重建时按此替换对应槽位
	private listChildIndex: number;
	// 未过滤的完整选项集，作为模糊过滤的源数据
	private allOptions: SelectItem[];
	private listLayout: SelectListLayoutOptions;
	// 搜索框；仅 searchable 模式下创建
	private searchInput: Input | undefined;
	// 选中某项 / 取消 / 高亮项变化时的宿主回调
	private onSelectCb: (value: string) => void;
	private onCancelCb: () => void;
	private onSelectionChangeCb?: (value: string) => void;

	constructor(
		title: string,
		description: string,
		options: SelectItem[],
		currentValue: string,
		onSelect: (value: string) => void,
		onCancel: () => void,
		onSelectionChange?: (value: string) => void,
		submenuOptions?: SelectSubmenuOptions,
	) {
		super();

		this.allOptions = options;
		this.listLayout = submenuOptions?.layout ?? SUBMENU_SELECT_LIST_LAYOUT;
		this.onSelectCb = onSelect;
		this.onCancelCb = onCancel;
		this.onSelectionChangeCb = onSelectionChange;

		// 标题（accent 前景 + 加粗）
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));

		// 描述（可选，为空则跳过）
		if (description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("muted", description), 0, 0));
		}

		// 搜索框（仅 searchable 模式）
		if (submenuOptions?.searchable) {
			this.addChild(new Spacer(1));
			this.searchInput = new Input();
			// 在搜索框内按回车：把回车转发给选项列表，等效于确认当前高亮项
			this.searchInput.onSubmit = () => {
				this.selectList.handleInput("\r");
			};
			this.addChild(this.searchInput);
		}

		// 空行分隔
		this.addChild(new Spacer(1));

		// 选项列表；记录其在 children 中的下标，供过滤时定点替换
		this.selectList = this.buildSelectList(options, currentValue);
		this.listChildIndex = this.children.length;
		this.addChild(this.selectList);

		// 底部按键提示（文案随是否可搜索切换）
		this.addChild(new Spacer(1));
		const hint = submenuOptions?.searchable
			? "  Type to filter \u00b7 Enter to select \u00b7 Esc to go back"
			: "  Enter to select \u00b7 Esc to go back";
		this.addChild(new Text(theme.fg("dim", hint), 0, 0));
	}

	/**
	 * 构建选项列表：可见高度取「选项数与 10 的较小值」，短列表不留大片空白；
	 * preselect 命中某项时将其设为初始高亮，并挂接选中 / 取消 / 高亮变化回调。
	 */
	private buildSelectList(options: SelectItem[], preselect: string): SelectList {
		const list = new SelectList(options, Math.min(options.length, 10), getSelectListTheme(), this.listLayout);

		// 找到当前值对应的选项并预选中（找不到则保持默认）
		const idx = options.findIndex((o) => o.value === preselect);
		if (idx !== -1) list.setSelectedIndex(idx);

		list.onSelect = (item) => this.onSelectCb(item.value);
		list.onCancel = this.onCancelCb;
		if (this.onSelectionChangeCb) {
			const cb = this.onSelectionChangeCb;
			list.onSelectionChange = (item) => cb(item.value);
		}

		return list;
	}

	/**
	 * 按搜索词过滤选项并原地替换列表组件。
	 * 匹配文本为「label + description」的拼接；空搜索词恢复完整列表。
	 * 重建时 preselect 传空串：过滤结果不再恢复原先选中项。
	 */
	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allOptions, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allOptions;

		// 用新列表定点替换 children 中原列表所在的槽位
		const newList = this.buildSelectList(filtered, "");
		this.children[this.listChildIndex] = newList;
		this.selectList = newList;
	}

	/**
	 * 输入分发（searchable 模式）：列表的上 / 下 / 确认 / 取消键交给选项列表，
	 * 其余按键（可打印字符、退格等）交给搜索框并即时应用过滤；
	 * 非 searchable 模式下全部转发给选项列表。
	 */
	handleInput(data: string): void {
		if (this.searchInput) {
			const kb = getKeybindings();
			// 判断是否命中选项列表的导航 / 确认 / 取消键位
			const isNav =
				kb.matches(data, "tui.select.up") ||
				kb.matches(data, "tui.select.down") ||
				kb.matches(data, "tui.select.confirm") ||
				kb.matches(data, "tui.select.cancel");
			if (isNav) {
				this.selectList.handleInput(data);
			} else {
				this.searchInput.handleInput(data);
				this.applyFilter(this.searchInput.getValue());
			}
		} else {
			this.selectList.handleInput(data);
		}
	}
}

// ============================================================================
// SteppedSubmenu —— 可复用的多步选择器
// ============================================================================

/** {@link SteppedSubmenu} 中的单个步骤定义。 */
export interface SteppedSubmenuStep {
	/** 唯一键：本步选中的值会以该键存入结果上下文。 */
	key: string;
	/** 步骤顶部标题；支持函数形式以接收前几步的选择结果。 */
	title: string | ((context: Record<string, string>) => string);
	/** 标题下方的描述；支持函数形式以接收前几步的选择结果。 */
	description: string | ((context: Record<string, string>) => string);
	/** 构建本步的选项列表；每次进入该步骤时都会重新调用。 */
	options: (context: Record<string, string>) => SelectItem[];
	/** 进入本步时可选地预选某个值。 */
	preselect?: (context: Record<string, string>) => string | undefined;
	/** 本步是否开启「输入即搜索」的模糊过滤。 */
	searchable?: boolean;
	/** 本步是否覆盖选项列表布局（列宽配置）。 */
	layout?: SelectListLayoutOptions;
}

/** SteppedSubmenu 的可选配置。 */
interface SteppedSubmenuOptions {
	/** 从该下标（0 起）的步骤开始，跳过之前的步骤；被跳过的键需经 initialContext 补齐。 */
	startAtStep?: number;
	/** 预填被跳过步骤的选择结果。 */
	initialContext?: Record<string, string>;
	/** 完成最后一步后回到第 0 步继续，而不是关闭子菜单。 */
	loop?: boolean;
}

/**
 * 基于 {@link SelectSubmenu} 组合出的通用 N 步子菜单。
 *
 * 每一步的标题 / 描述 / 选项都通过共享上下文（context）依赖前几步的选择结果；
 * 按 Esc 回退一步，第 0 步再按 Esc 则整体取消；
 * 开启 `loop: true` 时，完成最后一步会先回调 onComplete，再回到第 0 步循环。
 */
export class SteppedSubmenu extends Container {
	// 全部步骤定义（顺序即流程顺序）
	private readonly steps: SteppedSubmenuStep[];
	// 全部步骤完成后的回调，参数为汇总的选择结果
	private readonly onComplete: (context: Record<string, string>) => void;
	// 在第 0 步取消时的回调
	private readonly onCancel: () => void;
	private readonly opts: SteppedSubmenuOptions;
	// 当前展示的单步组件，随前进 / 回退整体替换
	private activeComponent: Component;
	// 各步骤的选择结果（key → value），完成时整体交给 onComplete
	private context: Record<string, string>;

	constructor(
		steps: SteppedSubmenuStep[],
		onComplete: (context: Record<string, string>) => void,
		onCancel: () => void,
		opts: SteppedSubmenuOptions = {},
	) {
		super();
		this.steps = steps;
		this.onComplete = onComplete;
		this.onCancel = onCancel;
		this.opts = opts;
		// 复制 initialContext，避免外部对象被内部回退逻辑（delete key）意外修改
		this.context = { ...(opts.initialContext ?? {}) };
		// 默认从第 0 步开始；startAtStep 可跳过前置步骤（需配合 initialContext）
		this.activeComponent = this.buildStep(opts.startAtStep ?? 0);
	}

	/**
	 * 构建第 stepIndex 步的单步组件。
	 * 标题 / 描述 / 选项均以最新 context 求值；多于一步时在描述前加「Step n/m ·」前缀。
	 * 选中回调负责「前进 / 完成并交付 / 循环重启」，取消回调负责「回退 / 取消」。
	 */
	private buildStep(stepIndex: number): Component {
		const step = this.steps[stepIndex];
		const total = this.steps.length;
		// 只有多步流程才显示步骤进度前缀
		const stepLabel = total > 1 ? `Step ${stepIndex + 1}/${total} \u00b7 ` : "";

		// 函数形式支持依赖 context 动态求值，字符串形式则直接使用
		const title = typeof step.title === "function" ? step.title(this.context) : step.title;
		const desc = typeof step.description === "function" ? step.description(this.context) : step.description;
		const items = step.options(this.context);
		const preselect = step.preselect?.(this.context) ?? "";

		return new SelectSubmenu(
			title,
			`${stepLabel}${desc}`,
			items,
			preselect,
			(value) => {
				// 记录本步选择，供后续步骤与最终交付使用
				this.context[step.key] = value;

				if (stepIndex < total - 1) {
					// 还有后续步骤：前进一步
					this.activeComponent = this.buildStep(stepIndex + 1);
				} else {
					// 最后一步：复制 context 交付，避免调用方拿到内部可变引用
					this.onComplete({ ...this.context });

					if (this.opts.loop) {
						// 循环模式：清空上下文回到第 0 步
						this.context = {};
						this.activeComponent = this.buildStep(0);
					} else {
						// 非循环：复用 onCancel 通道关闭子菜单
						this.onCancel();
					}
				}
			},
			() => {
				if (stepIndex > 0) {
					// 回退：清掉本步已选的值后回到上一步
					delete this.context[step.key];
					this.activeComponent = this.buildStep(stepIndex - 1);
				} else {
					// 第 0 步无处可退：整体取消
					this.onCancel();
				}
			},
			undefined,
			step.searchable || step.layout ? { searchable: step.searchable, layout: step.layout } : undefined,
		);
	}

	/** 渲染当前活动步骤（容器本身不产生额外内容）。 */
	render(width: number): string[] {
		return this.activeComponent.render(width);
	}

	/** 把输入转发给当前活动步骤（若其支持输入处理）。 */
	handleInput(data: string): void {
		this.activeComponent.handleInput?.(data);
	}

	/** 把缓存失效转发给当前活动步骤（若其支持）。 */
	invalidate(): void {
		this.activeComponent.invalidate?.();
	}
}
