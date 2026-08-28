/**
 * @file model-selector.ts —— Ctrl+P 模型选择器浮层组件
 *
 * @description
 * 本文件实现 `ModelSelectorComponent`：交互模式下按 Ctrl+P 弹出的模型选择器。
 * 用户可在带模糊搜索的模型列表中切换当前使用的模型（Enter 选中），
 * 也可按 Ctrl+S 把选中模型同时保存为默认模型；Esc / Ctrl+C 取消退出。
 *
 * 主要功能点：
 * - 双范围（scope）切换：all（全部可用模型）与 scoped（`--models` 配置的
 *   循环模型列表，每项可携带独立 thinking level），按 Tab 在两者间来回切换；
 * - 打开时先用模型运行时的本地快照立即渲染（秒开不阻塞），再后台刷新模型目录，
 *   刷新带 15 秒超时保护，失败/超时则回退展示缓存模型并给出错误提示；
 * - 搜索为模糊匹配；输入 "default" 的前缀可把默认模型置顶筛选出来；
 * - 排序规则：当前使用的模型置顶，其次是默认模型，其余按 provider 字母序。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：Model 类型与 modelsAreEqual 等值比较；
 * - `@earendil-works/pi-tui`：Container / Input / Text 等终端 UI 原语与按键匹配；
 * - `../../../core/model-runtime.ts`：ModelRuntime，提供可用模型快照与加载错误；
 * - `../model-catalog-refresh.ts`：后台刷新各 provider 的模型目录；
 * - `../model-search.ts`：构造搜索用文本；`./dynamic-border.ts` 动态边框。
 */
import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import { refreshModelCatalogs } from "../model-catalog-refresh.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/** 模型列表条目：以 provider + id 唯一标识，model 为完整模型对象 */
interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

/** `--models` 循环列表条目：除模型对象外，可携带该条目专属的 thinking level */
interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

/** 默认模型引用（provider + id），用于在列表中渲染 "· default" 徽章 */
interface DefaultModelReference {
	provider: string;
	id: string;
}

/** 列表范围："all" 展示全部可用模型；"scoped" 仅展示 `--models` 循环列表 */
type ModelScope = "all" | "scoped";

/**
 * 渲染带搜索框的模型选择器组件。
 *
 * 整体为浮层布局：上下动态边框 + 范围提示 + 搜索框 + 模型列表 + 按键提示。
 * 构造完成后先用本地快照渲染一次、立即可交互，随后在后台刷新模型目录并重绘，
 * 避免 UI 打开时被网络请求阻塞。
 */
export class ModelSelectorComponent extends Container implements Focusable {
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
	/** 全量可用模型（来自快照并已按排序规则整理） */
	private allModels: ModelItem[] = [];
	/** `--models` 循环列表对应的条目（已尽量替换为快照中的最新模型对象） */
	private scopedModelItems: ModelItem[] = [];
	/** 当前范围下实际展示的数据源（allModels 或 scopedModelItems 之一） */
	private activeModels: ModelItem[] = [];
	/** 经搜索词过滤后的列表 */
	private filteredModels: ModelItem[] = [];
	/** 当前高亮行下标（指向 filteredModels） */
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private modelRuntime: ModelRuntime;
	private onSelectCallback: (model: Model<any>) => void;
	private onSelectAsDefaultCallback?: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	/** 目录刷新失败等错误信息，显示在列表底部 */
	private errorMessage?: string;
	/** 刷新状态文案（进行中/完成）；refreshStatusSuccess 为 true 时以成功色显示 */
	private refreshStatusMessage = "Refreshing model catalogs…";
	private refreshStatusSuccess = false;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private defaultModel?: DefaultModelReference;
	/** 当前列表范围；构造时若有 scoped 配置则初始为 "scoped" */
	private scope: ModelScope = "all";
	/** "Scope: all | scoped" 切换行的 Text，范围变化时原地更新文案 */
	private scopeText?: Text;
	/** Tab 切换范围的按键提示 Text */
	private scopeHintText?: Text;
	/** 后台目录刷新的中断控制器：15 秒超时或组件关闭时 abort */
	private readonly refreshAbortController = new AbortController();
	private refreshTimeout?: ReturnType<typeof setTimeout>;
	/** 组件是否已关闭；关闭后忽略迟到的刷新回调，避免向已销毁的 UI 写入 */
	private closed = false;

	/**
	 * @param tui - \u5bbf\u4e3b TUI \u5b9e\u4f8b\uff0c\u7528\u4e8e\u8bf7\u6c42\u91cd\u7ed8
	 * @param currentModel - \u5f53\u524d\u4f7f\u7528\u7684\u6a21\u578b\uff08\u5217\u8868\u4e2d\u7f6e\u9876\u5e76\u4ee5 \u2713 \u6807\u6ce8\uff09
	 * @param modelRuntime - \u6a21\u578b\u8fd0\u884c\u65f6\uff0c\u63d0\u4f9b\u53ef\u7528\u6a21\u578b\u5feb\u7167\u4e0e\u5237\u65b0\u5165\u53e3
	 * @param scopedModels - `--models` \u914d\u7f6e\u7684\u5faa\u73af\u6a21\u578b\u5217\u8868\uff1b\u975e\u7a7a\u65f6\u521d\u59cb\u8303\u56f4\u4e3a scoped
	 * @param onSelect - \u9009\u4e2d\u6a21\u578b\u540e\u7684\u56de\u8c03\uff08Enter\uff09
	 * @param onCancel - \u53d6\u6d88\uff08Esc / Ctrl+C\uff09\u56de\u8c03
	 * @param initialSearchInput - \u521d\u59cb\u641c\u7d22\u8bcd\uff08\u5982\u4ece\u5916\u90e8\u9884\u586b\uff09
	 * @param onSelectAsDefault - Ctrl+S "\u9009\u4e2d\u5e76\u4fdd\u5b58\u4e3a\u9ed8\u8ba4" \u7684\u56de\u8c03\uff1b\u4f20\u5165\u540e\u624d\u542f\u7528\u8be5\u80fd\u529b
	 * @param defaultModel - \u5f53\u524d\u9ed8\u8ba4\u6a21\u578b\u5f15\u7528\uff0c\u7528\u4e8e\u6e32\u67d3 default \u5fbd\u7ae0
	 */
	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRuntime: ModelRuntime,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		onSelectAsDefault?: (model: Model<any>) => void,
		defaultModel?: DefaultModelReference,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.modelRuntime = modelRuntime;
		this.scopedModels = scopedModels;
		this.defaultModel = defaultModel;
		// \u6709 --models \u914d\u7f6e\u65f6\u521d\u59cb\u805a\u7126 scoped \u8303\u56f4\uff0c\u5426\u5219\u53ea\u80fd\u6d4f\u89c8 all
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onSelectAsDefaultCallback = onSelectAsDefault;
		this.onCancelCallback = onCancel;

		// \u9876\u90e8\u8fb9\u6846
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// \u8303\u56f4\u63d0\u793a\uff1a\u6709 scoped \u914d\u7f6e\u65f6\u663e\u793a "Scope: all | scoped" \u5207\u6362\u884c\uff1b
		// \u5426\u5219\u63d0\u793a\u5f53\u524d\u53ea\u5c55\u793a\u5df2\u767b\u5f55 provider \u7684\u6a21\u578b
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models from configured providers. Use /login to add providers.";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// \u521b\u5efa\u641c\u7d22\u8f93\u5165\u6846
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// \u5728\u641c\u7d22\u6846\u4e2d\u6309 Enter\uff1a\u9009\u4e2d\u5f53\u524d\u9ad8\u4eae\uff08\u5df2\u8fc7\u6ee4\uff09\u7684\u6761\u76ee
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// \u521b\u5efa\u5217\u8868\u5bb9\u5668\uff08updateList \u4f1a\u53cd\u590d\u6e05\u7a7a\u5e76\u91cd\u5efa\u5176\u5185\u5bb9\uff09
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// \u5e95\u90e8\u6309\u952e\u63d0\u793a\uff08\u4ec5\u5728\u652f\u6301"\u8bbe\u4e3a\u9ed8\u8ba4"\u65f6\u624d\u5c55\u793a Ctrl+S \u63d0\u793a\uff09
		if (this.onSelectAsDefaultCallback) {
			this.addChild(
				new Text(theme.fg("dim", "  Enter to select \u00b7 Ctrl+S to set as default \u00b7 Esc to cancel"), 0, 0),
			);
		}

		// \u5e95\u90e8\u8fb9\u6846
		this.addChild(new DynamicBorder());

		// \u5148\u7528\u5f53\u524d\u5feb\u7167\u7acb\u5373\u6e32\u67d3\uff0c\u518d\u5728\u540e\u53f0\u5237\u65b0\u6a21\u578b\u76ee\u5f55\uff1bvoid \u8868\u793a\u4e0d\u7b49\u5f85\u5237\u65b0\u5b8c\u6210
		this.loadModelsFromSnapshot();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
		void this.refreshModels();
	}

	/**
	 * 从模型运行时的本地快照重建列表数据（纯同步，不发起网络请求）。
	 *
	 * 快照中的模型对象可能比 scopedModels 携带的更新（例如目录刚刷新过），
	 * 因此这里会用 getModel 把 scoped 条目的模型对象替换为最新版本；
	 * 查不到时（模型已下线）保留原对象继续展示。
	 */
	private loadModelsFromSnapshot(): void {
		const models = this.modelRuntime.getAvailableSnapshot().map((model: Model<any>) => ({
			provider: model.provider,
			id: model.id,
			model,
		}));
		this.allModels = this.sortModels(models);
		// 用快照中可能更新的模型对象刷新 scoped 条目；查不到则保留原样
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRuntime.getModel(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		// 高亮行优先对准当前使用的模型；若不在列表中，则把旧下标收敛到合法范围
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	/**
	 * 后台刷新各 provider 的模型目录，完成后重建列表。
	 *
	 * 带 15 秒超时保护：到点即通过 AbortController 中断刷新并回退到缓存模型。
	 * 结束后按结果分档设置错误提示（超时 / 单个 provider 失败 / 多个失败），
	 * 全部成功时展示成功文案；组件已关闭则直接返回，丢弃过期结果。
	 */
	private async refreshModels(): Promise<void> {
		// 目录刷新的最长等待时间（毫秒），超时即放弃、改用缓存模型
		const timeoutMs = 15_000;
		let timedOut = false;
		this.refreshTimeout = setTimeout(() => {
			timedOut = true;
			this.refreshAbortController.abort();
		}, timeoutMs);
		try {
			const result = await refreshModelCatalogs(this.modelRuntime, this.refreshAbortController.signal);
			if (this.closed) return;
			this.refreshStatusMessage = "";
			if (result.aborted && timedOut) {
				// 被超时定时器中断
				this.errorMessage = "Model refresh timed out; showing cached models.";
			} else if (result.errors.size === 1) {
				// 单个 provider 刷新失败：点名提示
				this.errorMessage = `Could not refresh ${result.errors.keys().next().value}; showing cached models.`;
			} else if (result.errors.size > 1) {
				// 多个 provider 失败：汇总数量与名单
				this.errorMessage = `Could not refresh ${result.errors.size} model catalogs (${[...result.errors.keys()].join(", ")}); showing cached models.`;
			} else {
				// 目录刷新本身无错；仍需检查运行时残留的模型加载错误
				this.errorMessage = this.modelRuntime.getError();
				if (!this.errorMessage) {
					this.refreshStatusMessage = "Model catalogs refreshed.";
					this.refreshStatusSuccess = true;
				}
			}
			this.loadModelsFromSnapshot();
			this.filterModels(this.searchInput.getValue());
			this.tui.requestRender();
		} catch (error) {
			if (this.closed) return;
			this.refreshStatusMessage = "";
			// 刷新流程本身抛异常（而非单个 provider 失败）：区分超时与其他错误
			this.errorMessage = timedOut
				? "Model refresh timed out; showing cached models."
				: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`;
			this.updateList();
			this.tui.requestRender();
		} finally {
			if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		}
	}

	/** 标记组件已关闭：中断后台目录刷新并清理定时器；重复调用安全（幂等） */
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshAbortController.abort();
	}

	/**
	 * 排序模型列表：当前使用的模型置顶，其次是默认模型，其余按 provider 字母序。
	 * 在副本上排序，不改动入参数组。
	 */
	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// 比较优先级：当前模型 > 默认模型 > provider 名称
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			const aIsDefault = this.isDefaultModel(a.model);
			const bIsDefault = this.isDefaultModel(b.model);
			if (aIsDefault && !bIsDefault) return -1;
			if (!aIsDefault && bIsDefault) return 1;
			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	/** 生成 "Scope: all | scoped" 行：当前范围高亮（accent），另一侧置灰 */
	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	/** 生成 Tab 切换范围的按键提示（实际按键从 keybinding 配置读取） */
	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	/** 判断 model 是否为默认模型（provider 与 id 均相同才视为同一个） */
	private isDefaultModel(model: Model<any>): boolean {
		return this.defaultModel?.provider === model.provider && this.defaultModel.id === model.id;
	}

	/**
	 * 判断搜索词是否为 "default" 的前缀（如 "d"、"def"）。
	 * 用于支持"只看默认模型"的特殊搜索语法——配合 filterModels 中的置顶逻辑。
	 */
	private isDefaultSearch(query: string): boolean {
		const normalized = query.trim().toLowerCase();
		return normalized.length > 0 && "default".startsWith(normalized);
	}

	/**
	 * 切换列表范围（all / scoped）并重算列表与高亮行。
	 * 切换后高亮行优先对准当前使用的模型，找不到则回到第一行；
	 * "Scope" 行文案同步刷新。已是目标范围时为空操作。
	 */
	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		// 切换数据源后把高亮行对准当前模型；不在列表中则回到第一行
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	/**
	 * 按搜索词对当前范围的模型列表做模糊过滤。
	 *
	 * 参与匹配的文本由 id / provider / name 拼接而成，默认模型额外追加
	 * " default" 后缀，因此能直接用 "default" 搜到默认模型；
	 * 当搜索词是 "default" 的前缀时，进一步把默认模型置顶拼回结果。
	 * 有搜索词时高亮行移到第一行（最佳匹配），清空搜索词后则把
	 * 高亮行收敛回（恢复后的）列表长度以内。
	 */
	private filterModels(query: string): void {
		if (query) {
			// 模糊匹配；默认模型的搜索文本带 " default" 后缀
			const filtered = fuzzyFilter(this.activeModels, query, (item) => {
				const defaultText = this.isDefaultModel(item.model) ? " default" : "";
				return `${getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.model.name })}${defaultText}`;
			});
			if (this.isDefaultSearch(query)) {
				// "default" 前缀搜索：默认模型置顶，其余匹配项跟在后面（用 \0 拼 key 去重）
				const defaultItems = this.activeModels.filter((item) => this.isDefaultModel(item.model));
				const defaultKeys = new Set(defaultItems.map((item) => `${item.provider}\0${item.id}`));
				this.filteredModels = [
					...defaultItems,
					...filtered.filter((item) => !defaultKeys.has(`${item.provider}\0${item.id}`)),
				];
			} else {
				this.filteredModels = filtered;
			}
		} else {
			this.filteredModels = this.activeModels;
		}
		// 按搜索词过滤时把高亮行移到第一行，让最佳匹配项被选中；
		// 清空搜索词时保持当前位置，只把下标收敛到恢复后的列表长度以内。
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	/** 重绘可见列表：滚动窗口、选中态与徽章、错误/空结果提示、刷新状态 */
	private updateList(): void {
		this.listContainer.clear();

		// 列表可见窗口最多 10 行
		const maxVisible = 10;
		// 计算滚动窗口起点：让选中行尽量居中，同时不越出列表两端
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// 渲染过滤后模型的可见切片
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const isDefault = this.isDefaultModel(item.model);
			const defaultBadge = isDefault ? theme.fg("muted", " · default") : "";

			// 选中行带 "→ " 前缀并高亮；当前模型带 ✓，默认模型带徽章
			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = `${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${prefix + theme.fg("accent", modelText)} ${providerBadge}${defaultBadge}${checkmark}`;
			} else {
				const modelText = `  ${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
				line = `${modelText} ${providerBadge}${defaultBadge}${checkmark}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// 列表被截断（上方或下方还有条目）时显示 "当前位置/总数" 滚动指示器
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// 错误信息、无匹配提示、选中模型完整名称三者择一展示
		if (this.errorMessage) {
			// 错误以红色逐行显示（文案可能包含换行）
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
		if (this.refreshStatusMessage) {
			// 目录刷新状态：成功用绿色，进行中用灰色
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(
				new Text(theme.fg(this.refreshStatusSuccess ? "success" : "muted", `  ${this.refreshStatusMessage}`), 0, 0),
			);
		}
	}

	/**
	 * 处理按键输入：Tab 在 all/scoped 间切换，上下键循环移动高亮，
	 * Enter 确认选中，Esc / Ctrl+C 取消，Ctrl+S 选中并保存为默认模型，
	 * 其余按键交给搜索框并触发重新过滤。
	 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Tab：在 all / scoped 范围间切换（仅当存在 scoped 配置时才生效）
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// 上方向键——已到顶部时回绕到底部
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// 下方向键——已到底部时回绕到顶部
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter：确认选中当前高亮项
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Esc 或 Ctrl+C：取消退出
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.dispose();
			this.onCancelCallback();
		}
		// Ctrl+S——选中并保存为默认模型（仅当宿主提供了相应回调）
		else if (matchesKey(keyData, "ctrl+s") && this.onSelectAsDefaultCallback) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.dispose();
				this.onSelectAsDefaultCallback(selectedModel.model);
			}
		}
		// 其余按键交给搜索框处理，输入变化后立即重新过滤列表
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	/** 选中模型：先关闭组件（中断后台刷新），再回调上交选中的模型 */
	private handleSelect(model: Model<any>): void {
		this.dispose();
		this.onSelectCallback(model);
	}

	/** 暴露内部搜索框，供外部聚焦（如浮层打开时定位光标） */
	getSearchInput(): Input {
		return this.searchInput;
	}
}
