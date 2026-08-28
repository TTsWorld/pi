/**
 * @file scoped-models-selector.ts —— `--models` 循环模型列表配置组件
 *
 * @description
 * 本文件实现 `ScopedModelsSelectorComponent`：用于勾选与排序 Ctrl+P 循环切换
 * 使用的模型集合（即 `--models` / app.models 配置的 scoped 列表）。
 * 用户可逐个或按 provider 整体启用/停用模型、上下调整启用模型的循环顺序；
 * 所有变更默认仅作用于当前会话（session-only），按保存键（Ctrl+S）才持久化到设置。
 *
 * 文件前半部分是一组针对 `EnabledIds` 的纯函数（不可变操作）：
 * 用 null 表示"全部启用、按目录原始顺序"，用有序 string[] 表示显式启用的
 * id 列表（其顺序即 Ctrl+P 的循环顺序）；null 与"恰好覆盖全部"的列表语义等价，
 * 操作中会尽量归一化回 null。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：Model 类型；
 * - `@earendil-works/pi-tui`：Container / Input / Text 等 UI 原语与按键匹配；
 * - `../model-search.ts`：构造模糊搜索用文本；`./dynamic-border.ts` 动态边框。
 */
import type { Model } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { getModelSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText } from "./keybinding-hints.ts";

// EnabledIds：null = 全部启用（不过滤，保持目录顺序）；string[] = 显式启用的有序 id 列表
type EnabledIds = string[] | null;

/** 判断 id 是否启用：null（全启用）恒为 true，否则查显式列表 */
function isEnabled(enabledIds: EnabledIds, id: string): boolean {
	return enabledIds === null || enabledIds.includes(id);
}

/**
 * 切换某个 id 的启用状态（不可变操作，返回新数组）。
 * 注意从 null（全部启用）出发的第一次切换语义是"只保留这一个"——
 * 因为 null 无法表达"除它以外全部启用"。
 */
function toggle(enabledIds: EnabledIds, id: string): EnabledIds {
	if (enabledIds === null) return [id]; // 第一次切换：从只启用这一个开始
	const index = enabledIds.indexOf(id);
	if (index >= 0) return [...enabledIds.slice(0, index), ...enabledIds.slice(index + 1)];
	return [...enabledIds, id];
}

/**
 * 启用一组 id（targetIds 缺省为全部）。
 * 启用后若恰好覆盖了所有已知模型，则归一化回 null（语义等价且表示形式更简洁）。
 */
function enableAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) return null; // 已是全部启用
	const targets = targetIds ?? allIds;
	const result = [...enabledIds];
	for (const id of targets) {
		if (!result.includes(id)) result.push(id);
	}
	return result.length === allIds.length && result.every((id) => allIds.includes(id)) ? null : result;
}

/**
 * 停用一组 id（targetIds 缺省为"当前启用的全部"）。
 * 从 null（全启用）出发时需换算成显式列表：指定目标则"除目标外全部启用"，
 * 未指定则清空为空列表 []（显式的"一个都不启用"）。
 */
function clearAll(enabledIds: EnabledIds, allIds: string[], targetIds?: string[]): EnabledIds {
	if (enabledIds === null) {
		return targetIds ? allIds.filter((id) => !targetIds.includes(id)) : [];
	}
	const targets = new Set(targetIds ?? enabledIds);
	return enabledIds.filter((id) => !targets.has(id));
}

/**
 * 在启用列表内把 id 上移/下移 delta 位（不可变操作）。
 * id 不在列表中或移动越界时原样返回；null（无显式顺序）无序可调，直接返回。
 */
function move(enabledIds: EnabledIds, id: string, delta: number): EnabledIds {
	if (enabledIds === null) return null;
	const list = [...enabledIds];
	const index = list.indexOf(id);
	if (index < 0) return list;
	const newIndex = index + delta;
	if (newIndex < 0 || newIndex >= list.length) return list;
	const result = [...list];
	[result[index], result[newIndex]] = [result[newIndex], result[index]];
	return result;
}

/**
 * 计算展示顺序：启用的 id 按其自身顺序在前，未启用的按目录原始顺序垫底，
 * 保证列表中勾选项的相对顺序就是 Ctrl+P 的循环切换顺序。
 */
function getSortedIds(enabledIds: EnabledIds, allIds: string[]): string[] {
	if (enabledIds === null) return allIds;
	const enabledSet = new Set(enabledIds);
	return [...enabledIds, ...allIds.filter((id) => !enabledSet.has(id))];
}

/** 列表条目：fullId 为 "provider/id"；model 为 undefined 表示该模型当前不可用 */
interface ModelItem {
	fullId: string;
	model: Model<any> | undefined;
	enabled: boolean;
}

/** 组件初始状态配置 */
export interface ModelsConfig {
	/** 全部已知模型（通常来自模型运行时快照） */
	allModels: Model<any>[];
	/** 当前启用的有序 id 列表；null 表示全部启用 */
	enabledModelIds: string[] | null;
	/** 可选的目录刷新状态文案（如"刷新中/已刷新"） */
	refreshStatus?: string;
}

/** 组件对外回调集合 */
export interface ModelsCallbacks {
	/** 启用集合或其顺序发生变化时回调（仅会话级，不持久化） */
	onChange: (enabledModelIds: string[] | null) => void | Promise<void>;
	/** 用户要求把当前选择持久化写入设置时回调 */
	onPersist: (enabledModelIds: string[] | null) => void | Promise<void>;
	onCancel: () => void;
}

/**
 * 为 Ctrl+P 循环切换启用/停用模型的配置组件。
 *
 * 布局：上下动态边框 + 标题与"会话级生效"说明 + 搜索框 + 模型列表 + 页脚提示。
 * 所有变更仅对当前会话生效（session-only），直到用户按保存键显式持久化；
 * 有未保存变更时页脚会追加 "(unsaved)" 提示。
 */
export class ScopedModelsSelectorComponent extends Container implements Focusable {
	/** fullId（"provider/id"）→ 模型对象 的索引 */
	private modelsById: Map<string, Model<any>> = new Map();
	/** 全部已知模型的 fullId，保持目录原始顺序 */
	private allIds: string[] = [];
	/** 当前启用集合；null 表示全部启用 */
	private enabledIds: EnabledIds = null;
	/** 经搜索词过滤后的展示列表 */
	private filteredItems: ModelItem[] = [];
	/** 当前高亮行下标（指向 filteredItems） */
	private selectedIndex = 0;
	private searchInput: Input;

	// Focusable 实现——把焦点状态透传给搜索框，保证输入法（IME）光标定位正确
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	/** 页脚提示 Text：按键说明 + 启用计数 + 可选的 "(unsaved)" 标记 */
	private footerText: Text;
	private callbacks: ModelsCallbacks;
	/** 列表可见窗口的行数 */
	private maxVisible = 8;
	/** 有未持久化的变更时在页脚显示 "(unsaved)" */
	private isDirty = false;
	/** 目录刷新状态行（可选），可由外部经 setRefreshStatus 更新 */
	private refreshStatusText?: Text;

	constructor(config: ModelsConfig, callbacks: ModelsCallbacks) {
		super();
		this.callbacks = callbacks;

		// 建立 fullId（provider/id）→ 模型的索引；allIds 保持目录顺序
		for (const model of config.allModels) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}

		// null 保持 null（全部启用）；数组复制一份，避免与外部共享可变引用
		this.enabledIds = config.enabledModelIds === null ? null : [...config.enabledModelIds];
		this.filteredItems = this.buildItems();

		// 头部：边框 + 标题 + "仅会话生效，保存需按键" 说明
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Model Configuration")), 0, 0));
		this.addChild(
			new Text(theme.fg("muted", `Session-only. ${keyText("app.models.save")} to save to settings.`), 0, 0),
		);
		this.addChild(new Spacer(1));

		// 搜索输入框
		this.searchInput = new Input();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// 列表容器（updateList 会反复清空并重建其内容）
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		// 页脚：可选的刷新状态行 + 按键提示行
		this.addChild(new Spacer(1));
		if (config.refreshStatus) {
			this.refreshStatusText = new Text(theme.fg("muted", `  ${config.refreshStatus}`), 0, 0);
			this.addChild(this.refreshStatusText);
		}
		this.footerText = new Text(this.getFooterText(), 0, 0);
		this.addChild(this.footerText);

		this.addChild(new DynamicBorder());
		this.updateList();
	}

	/**
	 * 外部（目录刷新完成后）推入新的模型集合，原地重建索引与列表。
	 * 尽量保持刷新前的选中项不跳变：先记下原高亮条目，重建后若仍存在则恢复其位置。
	 */
	updateModels(models: readonly Model<any>[], enabledModelIds?: string[] | null): void {
		// 记住刷新前的高亮条目，刷新后尝试恢复
		const selectedId = this.filteredItems[this.selectedIndex]?.fullId;
		if (enabledModelIds !== undefined) this.enabledIds = enabledModelIds === null ? null : [...enabledModelIds];
		this.modelsById.clear();
		this.allIds = [];
		for (const model of models) {
			const fullId = `${model.provider}/${model.id}`;
			this.modelsById.set(fullId, model);
			this.allIds.push(fullId);
		}
		this.refresh();
		// 仅当原选中项仍在（过滤后的）列表中时才恢复下标
		const refreshedIndex = selectedId ? this.filteredItems.findIndex((item) => item.fullId === selectedId) : -1;
		if (refreshedIndex >= 0) {
			this.selectedIndex = refreshedIndex;
			this.updateList();
		}
	}

	/** 更新目录刷新状态行的文案与颜色（muted / success / warning） */
	setRefreshStatus(message: string, kind: "muted" | "success" | "warning"): void {
		this.refreshStatusText?.setText(theme.fg(kind, `  ${message}`));
	}

	/** 按展示顺序（启用项在前、按启用顺序）构造完整列表条目 */
	private buildItems(): ModelItem[] {
		return getSortedIds(this.enabledIds, this.allIds).map((id) => ({
			fullId: id,
			model: this.modelsById.get(id),
			enabled: isEnabled(this.enabledIds, id),
		}));
	}

	/**
	 * 生成页脚文案：按键提示 + 启用计数。
	 * 全部启用时显示 "all enabled"，否则显示 "n/total enabled"；
	 * 启用集合中含已不在目录里的模型（目录刷新后下线）时追加 "k unavailable"。
	 * 有未保存变更时在末尾追加黄色的 "(unsaved)"。
	 */
	private getFooterText(): string {
		const enabledCount = this.enabledIds?.filter((id) => this.modelsById.has(id)).length ?? this.allIds.length;
		// 启用集合中已不在当前目录里的模型计数
		const unavailableCount = this.enabledIds?.filter((id) => !this.modelsById.has(id)).length ?? 0;
		const allEnabled = this.enabledIds === null;
		const countText = allEnabled
			? "all enabled"
			: `${enabledCount}/${this.allIds.length} enabled${unavailableCount ? ` · ${unavailableCount} unavailable` : ""}`;
		const parts = [
			`${keyText("tui.select.confirm")} toggle`,
			`${keyText("app.models.enableAll")} all`,
			`${keyText("app.models.clearAll")} clear`,
			`${keyText("app.models.toggleProvider")} provider`,
			`${keyText("app.models.reorderUp")}/${keyText("app.models.reorderDown")} reorder`,
			`${keyText("app.models.save")} save`,
			countText,
		];
		return this.isDirty
			? theme.fg("dim", `  ${parts.join(" · ")} `) + theme.fg("warning", "(unsaved)")
			: theme.fg("dim", `  ${parts.join(" · ")}`);
	}

	/** 重建条目并按当前搜索词过滤、收敛高亮下标，随后重绘列表与页脚 */
	private refresh(): void {
		const query = this.searchInput.getValue();
		const items = this.buildItems();
		// 有搜索词时模糊匹配（模型不可用时退化用 fullId 参与匹配）
		this.filteredItems = query
			? fuzzyFilter(items, query, (item) =>
					item.model
						? getModelSearchText({ id: item.model.id, provider: item.model.provider, name: item.model.name })
						: item.fullId,
				)
			: items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
		this.footerText.setText(this.getFooterText());
	}

	/** 把当前启用集合（复制一份防外部篡改）通过 onChange 通知外部（会话级，不落盘） */
	private notifyChange(): void {
		this.callbacks.onChange(this.enabledIds === null ? null : [...this.enabledIds]);
	}

	/** 重绘列表：滚动窗口、选中态、启用勾/叉标记、滚动指示器与选中模型名称 */
	private updateList(): void {
		this.listContainer.clear();

		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
			return;
		}

		// 计算滚动窗口起点：让选中行尽量居中，同时不越出列表两端
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);
		const allEnabled = this.enabledIds === null;

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i]!;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const id = item.model?.id ?? item.fullId;
			const modelText = isSelected ? theme.fg("accent", id) : id;
			const providerBadge = theme.fg("muted", item.model ? ` [${item.model.provider}]` : " [unavailable]");
			// 状态标记：全部启用（null）时不显示；否则勾（启用）/叉（停用或不可用）
			const status = item.model
				? allEnabled
					? ""
					: item.enabled
						? theme.fg("success", " ✓")
						: theme.fg("dim", " ✗")
				: theme.fg("dim", " ✗");
			this.listContainer.addChild(new Text(`${prefix}${modelText}${providerBadge}${status}`, 0, 0));
		}

		// 列表被截断（上方或下方还有条目）时显示 "当前位置/总数" 滚动指示器
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 0, 0),
			);
		}

		// 列表底部展示选中模型的完整名称；模型不可用时给出提示
		if (this.filteredItems.length > 0) {
			const selected = this.filteredItems[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(
					theme.fg("muted", `  ${selected.model ? `Model Name: ${selected.model.name}` : "Model unavailable"}`),
					0,
					0,
				),
			);
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// 上下导航（到边界时循环回绕）
		if (kb.matches(data, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredItems.length - 1 : this.selectedIndex - 1;
			this.updateList();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
			return;
		}

		// 重排启用模型的循环顺序（null 表示无固定顺序，无序可调）
		const reorderUp = kb.matches(data, "app.models.reorderUp");
		const reorderDown = kb.matches(data, "app.models.reorderDown");
		if (reorderUp || reorderDown) {
			if (this.enabledIds === null) return;
			const item = this.filteredItems[this.selectedIndex];
			if (item && isEnabled(this.enabledIds, item.fullId)) {
				const delta = reorderUp ? -1 : 1;
				const currentIndex = this.enabledIds.indexOf(item.fullId);
				const newIndex = currentIndex + delta;
				// 仅在未越界时移动，并让高亮行跟随条目一起移动
				if (newIndex >= 0 && newIndex < this.enabledIds.length) {
					this.enabledIds = move(this.enabledIds, item.fullId, delta);
					this.isDirty = true;
					this.selectedIndex += delta;
					this.refresh();
					this.notifyChange();
				}
			}
			return;
		}

		// Enter：勾选/取消勾选当前项
		if (kb.matches(data, "tui.select.confirm")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item) {
				this.enabledIds = toggle(this.enabledIds, item.fullId);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// 全部启用（搜索激活时仅作用于当前过滤结果，否则作用于全部）
		if (kb.matches(data, "app.models.enableAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = enableAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// 全部清空（搜索激活时仅作用于当前过滤结果，否则作用于全部）
		if (kb.matches(data, "app.models.clearAll")) {
			const targetIds = this.searchInput.getValue() ? this.filteredItems.map((i) => i.fullId) : undefined;
			this.enabledIds = clearAll(this.enabledIds, this.allIds, targetIds);
			this.isDirty = true;
			this.refresh();
			this.notifyChange();
			return;
		}

		// 整体开关当前项所属 provider：该 provider 全启用则全部停用，否则全部启用
		if (kb.matches(data, "app.models.toggleProvider")) {
			const item = this.filteredItems[this.selectedIndex];
			if (item?.model) {
				const provider = item.model.provider;
				const providerIds = this.allIds.filter((id) => this.modelsById.get(id)!.provider === provider);
				const allEnabled = providerIds.every((id) => isEnabled(this.enabledIds, id));
				this.enabledIds = allEnabled
					? clearAll(this.enabledIds, this.allIds, providerIds)
					: enableAll(this.enabledIds, this.allIds, providerIds);
				this.isDirty = true;
				this.refresh();
				this.notifyChange();
			}
			return;
		}

		// 保存：把当前启用集合持久化到设置，并清除未保存标记
		if (kb.matches(data, "app.models.save")) {
			this.callbacks.onPersist(this.enabledIds === null ? null : [...this.enabledIds]);
			this.isDirty = false;
			this.footerText.setText(this.getFooterText());
			return;
		}

		// Ctrl+C——先清空搜索词；搜索已为空则取消退出
		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refresh();
			} else {
				this.callbacks.onCancel();
			}
			return;
		}

		// Esc——取消退出
		if (matchesKey(data, Key.escape)) {
			this.callbacks.onCancel();
			return;
		}

		// 其余按键交给搜索框处理，输入变化后立即刷新过滤
		this.searchInput.handleInput(data);
		this.refresh();
	}

	/** 暴露内部搜索框，供外部聚焦（如浮层打开时定位光标） */
	getSearchInput(): Input {
		return this.searchInput;
	}
}
