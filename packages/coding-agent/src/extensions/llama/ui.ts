/**
 * @file ui.ts —— llama.cpp 本地模型扩展的 TUI 管理界面
 *
 * @description
 * 本文件为内置的 llama.cpp 扩展（extensions/llama/）提供全部交互界面：
 * 本地模型列表选择（加载/卸载）、Hugging Face 模型搜索与下载入口、
 * 通用选择/确认对话框、连接错误重试，以及带取消能力的进度条展示。
 *
 * 主要导出：
 * - `LlamaUi` / `LlamaManagerAction`：界面契约与用户操作结果，扩展主逻辑面向它编程；
 * - `HuggingFaceSearch`：Hugging Face 模型搜索组件（输入框 + 结果列表 + 防抖搜索 + 缓存）；
 * - `LlamaView`：实现 `LlamaUi` 的根视图，在同一画布上切换各业务子界面；
 * - `showLlamaUi`：把 `LlamaView` 挂载到宿主 TUI 的入口函数；
 * - `runWithProgress`：把「可取消的后台任务」与「进度 UI」绑定在一起的驱动器。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：终端 UI 基础组件（Container/Text/SelectList/Input 等）；
 * - `./client.ts`：llama.cpp 服务端客户端，提供 `LlamaModelInfo` / `LlamaProgress` 类型；
 * - `./huggingface.ts`：Hugging Face 模型元数据（`HuggingFaceModel`）；
 * - `../../core/*` 与 interactive 模式（DynamicBorder/keyHint/Theme）：宿主侧扩展
 *   上下文、按键绑定与主题。
 */

import {
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";
import { DynamicBorder } from "../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { LlamaModelInfo, LlamaProgress } from "./client.ts";
import type { HuggingFaceModel } from "./huggingface.ts";

// 「下载模型…」列表项的哨兵值：以 NUL 字符开头，保证绝不与任何真实模型 id 冲突
const DOWNLOAD_VALUE = "\0download";

/**
 * 用户在 llama.cpp 管理界面上的一次操作结果：
 * - `model`：选中了一个本地模型（加载/卸载等具体动作由调用方按模型状态决定）；
 * - `download`：选择了「下载模型…」入口；
 * - `close`：直接关闭管理界面（取消）。
 */
export type LlamaManagerAction = { type: "model"; model: LlamaModelInfo } | { type: "download" } | { type: "close" };

/** 进度屏状态：在 LlamaProgress（message/ratio/detail）基础上补上屏标题与模型名 */
interface ProgressState extends LlamaProgress {
	title: string;
	model: string;
}

/**
 * 提取模型的上下文窗口大小标签（如 "128k"、"8192"），用于模型列表的描述行。
 * 优先读服务端元数据 n_ctx（当前上下文长度），缺失时退回 n_ctx_train（训练长度）；
 * 两者都没有则扫描启动参数，寻找 --ctx-size / -c / -ctx 及其紧随的数值。
 */
function contextLabel(model: LlamaModelInfo): string | undefined {
	const context = model.meta?.n_ctx ?? model.meta?.n_ctx_train;
	// ≥1000 才换算成 "k" 形式，否则原样输出
	if (context) return context >= 1000 ? `${Math.round(context / 1000)}k` : String(context);
	const args = model.status.args ?? [];
	// 参数与值成对出现，只扫描到倒数第二个即可（保证 index+1 不越界）
	for (let index = 0; index < args.length - 1; index++) {
		if (args[index] !== "--ctx-size" && args[index] !== "-c" && args[index] !== "-ctx") continue;
		const value = Number(args[index + 1]);
		// 只有有限正数才视为有效的 ctx 值（排除 0、NaN 等）
		if (Number.isFinite(value) && value > 0) return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
	}
	return undefined;
}

/**
 * 拼接模型在列表中的描述行，如 "loaded · 128k context"。
 * sleeping 视同已加载（模型仍在内存中，只是被休眠）；unloaded 不产生状态描述；
 * 且只有已加载的模型才展示上下文大小（此时元数据才可靠）。
 */
function modelDescription(model: LlamaModelInfo): string {
	const details: string[] = [];
	const loaded = model.status.value === "loaded" || model.status.value === "sleeping";
	if (loaded) details.push("loaded");
	else if (model.status.value !== "unloaded") details.push(model.status.value);
	const context = loaded ? contextLabel(model) : undefined;
	if (context) details.push(`${context} context`);
	return details.join(" · ");
}

/** 生成 SelectList 的配色：选中项用 accent 高亮，描述/滚动信息/无匹配提示用弱化色 */
function selectTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("warning", text),
	};
}

/** 组装标准面板：上下各一条动态宽度边框，中间为加粗标题 + body 组件，footer 作为底部快捷键提示行 */
function frame(theme: Theme, title: string, body: Component[], footer?: string): Container {
	const container = new Container();
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	for (const child of body) container.addChild(child);
	if (footer) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
	}
	container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return container;
}

/**
 * llama.cpp 管理界面的 UI 契约（由 LlamaView 实现，扩展主逻辑面向此接口编程）。
 * 每个方法对应一屏界面；Promise 的 resolve 值即用户在该屏上的选择结果。
 */
export interface LlamaUi {
	/** 模型列表屏：返回用户选中的模型 / 进入下载流程 / 关闭界面 */
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction>;
	/** 通用单选对话框；取消时 resolve undefined */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Yes/No 确认框；resolve true 表示选择 Yes */
	confirm(title: string, message: string): Promise<boolean>;
	/** 连接 llama.cpp 服务失败的错误屏；返回用户选择重试还是关闭 */
	connectionError(serverUrl: string, message: string): Promise<"retry" | "close">;
	/** Hugging Face 模型搜索屏；resolve 为选中的模型标识，取消/返回时为 undefined */
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined>;
	/** 展示一条无交互的状态消息 */
	showStatus(title: string, message: string): void;
	/** 进入进度展示态并等待用户按取消键（resolve 即用户请求停止） */
	progress(state: ProgressState): Promise<void>;
	/** 就地刷新进度屏内容；仅在 progress() 之后生效 */
	updateProgress(state: ProgressState): void;
}

/**
 * 把下载量等大数字压缩为紧凑形式：1.2M / 12M / 1.2k / 12k。
 * 数值越大保留的小数位越少（≥1000 万按 M 取整、≥10 万按 k 取整），1000 以下原样输出。
 */
function compactCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
	return String(value);
}

/**
 * Hugging Face 模型搜索组件：上方输入框 + 下方结果列表。
 * 输入满 2 个字符后防抖 500ms 才发起远程搜索，结果按查询词缓存，
 * 已有结果上再用 fuzzyFilter 做本地过滤；上下键循环滚动选中项，
 * 回车确认（输入恰为 owner/repo[:quant] 形式时直接按精确标识选中），Esc 取消。
 */
class HuggingFaceSearch extends Container implements Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>;
	/** 查询词（小写）→ 结果 的会话级缓存，由 LlamaView 持有、跨多次打开共享 */
	private readonly cache: Map<string, HuggingFaceModel[]>;
	private readonly onSelectModel: (model: string | undefined) => void;
	private readonly input = new Input();
	private readonly resultsContainer = new Container();
	private results: HuggingFaceModel[] = [];
	private filteredResults: HuggingFaceModel[] = [];
	private selectedIndex = 0;
	private query = "";
	/** 状态行文案：随输入长度/搜索阶段变化（提示语、错误信息或空串） */
	private status = "Type at least 2 characters";
	/** 防抖定时器句柄：新输入会重置它，避免频繁发请求 */
	private debounce: ReturnType<typeof setTimeout> | undefined;
	/** 在途搜索请求的控制器：发起下一次搜索前先 abort 旧请求 */
	private request: AbortController | undefined;
	/** 组件是否已关闭；关闭后迟到的搜索响应一律丢弃 */
	private closed = false;
	private _focused = false;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
		cache: Map<string, HuggingFaceModel[]>,
		onSelectModel: (model: string | undefined) => void,
	) {
		super();
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.search = search;
		this.cache = cache;
		this.onSelectModel = onSelectModel;
		this.addChild(new Text(theme.fg("dim", "Model name or owner/repository[:quant]"), 1, 0));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.resultsContainer);
		this.updateResults();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	// ===== 重绘结果列表（滚动窗口） =====
	private updateResults(): void {
		this.resultsContainer.clear();
		// 可见行数上限：窗口尽量以选中项为中心，越界时贴住列表顶部/底部
		const maxVisible = 10;
		const start = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredResults.length - maxVisible),
		);
		const end = Math.min(start + maxVisible, this.filteredResults.length);
		for (let index = start; index < end; index++) {
			const model = this.filteredResults[index];
			if (!model) continue;
			const prefix = index === this.selectedIndex ? "→ " : "  ";
			const details = `${compactCount(model.downloads)} downloads`;
			this.resultsContainer.addChild(
				new Text(
					index === this.selectedIndex
						? this.theme.fg("accent", `${prefix}${model.id}  ${details}`)
						: `${prefix}${model.id}${this.theme.fg("muted", `  ${details}`)}`,
					0,
					0,
				),
			);
		}
		// 结果超出可视窗口时展示 "序号/总数" 滚动指示
		if (start > 0 || end < this.filteredResults.length) {
			this.resultsContainer.addChild(
				new Text(this.theme.fg("dim", `  (${this.selectedIndex + 1}/${this.filteredResults.length})`), 0, 0),
			);
		}
		// 状态行：无结果时始终展示；有结果时仅保留 "搜索中" 提示
		if (this.filteredResults.length === 0) {
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		} else if (this.status === "Searching Hugging Face…") {
			this.resultsContainer.addChild(new Text(this.theme.fg("dim", `  ${this.status}`), 0, 0));
		}
		this.tui.requestRender();
	}

	/** 在已获取的结果上做本地模糊过滤；无查询词时展示全部 */
	private filterResults(): void {
		if (this.query) {
			// 先用 fuzzyFilter 算出匹配的 id 集合，再按原顺序过滤，保持列表稳定
			const matches = new Set(fuzzyFilter(this.results, this.query, (model) => model.id).map((model) => model.id));
			this.filteredResults = this.results.filter((model) => matches.has(model.id));
		} else {
			this.filteredResults = this.results;
		}
		// 过滤后列表可能变短：把选中项钳制回有效范围内
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredResults.length - 1));
		this.updateResults();
	}

	/** 输入变化后的调度入口：先清理旧的防抖与在途请求，再决定走缓存还是安排远程搜索 */
	private scheduleSearch(): void {
		// 取消上一次防抖计时与仍在途的搜索请求，保证同一时刻只有一个待发/在途请求
		if (this.debounce) clearTimeout(this.debounce);
		this.request?.abort();
		this.request = undefined;
		// 少于 2 个字符不发请求：太短的查询既无意义又浪费 API 调用
		if (this.query.length < 2) {
			this.status = "Type at least 2 characters";
			this.filterResults();
			return;
		}
		// 命中缓存直接复用（空结果同样缓存，可短路重复的无效查询）
		const cached = this.cache.get(this.query.toLowerCase());
		if (cached) {
			this.results = cached;
			this.status = cached.length === 0 ? "No GGUF models found" : "";
			this.filterResults();
			return;
		}
		this.status = "Searching Hugging Face…";
		this.filterResults();
		// 500ms 防抖：等用户停下输入再真正发起远程搜索
		this.debounce = setTimeout(() => void this.runSearch(this.query), 500);
	}

	/** 执行远程搜索并写入缓存；组件已关闭/请求已被替换/查询词已变 时丢弃过期响应 */
	private async runSearch(query: string): Promise<void> {
		const request = new AbortController();
		this.request = request;
		try {
			const results = await this.search(query, request.signal);
			this.cache.set(query.toLowerCase(), results);
			// 过期守卫：即便结果已拿到，晚到的响应也不能覆盖当前界面状态
			if (this.closed || request.signal.aborted || this.query !== query) return;
			this.results = results;
			this.selectedIndex = 0;
			this.status = results.length === 0 ? "No GGUF models found" : "";
			this.filterResults();
		} catch (error) {
			// 报错同样先做过期守卫，再展示错误文案（abort 产生的取消错误不应覆盖新查询）
			if (this.closed || request.signal.aborted || this.query !== query) return;
			this.results = [];
			this.status = error instanceof Error ? error.message : String(error);
			this.filterResults();
		} finally {
			// 只有仍是「当前在途请求」时才清空引用，避免误清后续的新请求
			if (this.request === request) this.request = undefined;
		}
	}

	/** 关闭组件并回调选中结果（undefined 表示取消）；closed 标记保证只回调一次 */
	private close(model: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		if (this.debounce) clearTimeout(this.debounce);
		this.request?.abort();
		this.onSelectModel(model);
	}

	/** 键盘入口：导航/确认/取消优先拦截，其余交给输入框；输入变化后再调度搜索 */
	handleInput(data: string): void {
		// 上键：到顶后循环到底部
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.filteredResults.length - 1 : this.selectedIndex - 1;
				this.updateResults();
			}
			return;
		}
		// 下键：到底后循环回顶部
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredResults.length > 0) {
				this.selectedIndex = this.selectedIndex === this.filteredResults.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateResults();
			}
			return;
		}
		// 确认键：输入恰为 owner/repo[:quant] 形式时按精确标识直接选中，否则取列表选中项
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const exact = /^[^/\s]+\/[^:\s]+(?::[^\s:]+)?$/u.test(this.query) ? this.query : undefined;
			const selected = exact ?? this.filteredResults[this.selectedIndex]?.id;
			if (selected) this.close(selected);
			return;
		}
		// 取消键：以 undefined 结束（返回上一屏）
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.close(undefined);
			return;
		}
		// 其余按键交给输入框；只有输入内容真的变化时才重新调度搜索
		this.input.handleInput(data);
		const query = this.input.getValue().trim();
		if (query === this.query) return;
		this.query = query;
		this.scheduleSearch();
	}
}

/**
 * llama.cpp 管理界面的根视图：实现 LlamaUi 契约。
 * 内部维护「内容面板 + 输入处理组件 + 焦点目标」三件套；各业务界面
 * （模型列表、选择框、搜索、进度等）都通过 setContent 整体替换画布，
 * 从而在同一个 TUI 挂载点上完成多屏切换。
 */
class LlamaView implements LlamaUi, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	/** 会话级搜索缓存：跨多次打开 HuggingFaceSearch 复用，避免重复请求 */
	private readonly searchCache = new Map<string, HuggingFaceModel[]>();
	/** 当前内容面板（frame 产出的 Container） */
	private content: Container;
	/** 当前界面的按键处理组件（SelectList / HuggingFaceSearch 等） */
	private inputHandler: { handleInput?(data: string): void } | undefined;
	/** 当前界面的焦点承载组件，focused 状态转发给它 */
	private inputTarget: Focusable | undefined;
	/** progress() 创建的「用户请求停止」Promise；resolve 即用户按了取消键 */
	private progressPromise: Promise<void> | undefined;
	private progressResolver: (() => void) | undefined;
	/** 是否处于进度展示态：updateProgress 只在该状态下生效 */
	private showingProgress = false;
	private _focused = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		// 先渲染占位的 "Loading…" 面板，等首个业务界面到来后再替换
		this.content = frame(theme, "llama.cpp models", [new Text(theme.fg("muted", "Loading…"), 1, 1)]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.inputTarget) this.inputTarget.focused = value;
	}

	/**
	 * 切换到新界面：归还旧目标的焦点、清空进度态，替换内容与输入处理组件，
	 * 再把当前焦点状态交给新目标并请求重绘。所有 show* 方法最终都走这里。
	 */
	private setContent(
		content: Container,
		inputHandler?: { handleInput?(data: string): void },
		inputTarget?: Focusable,
	): void {
		if (this.inputTarget) this.inputTarget.focused = false;
		this.progressPromise = undefined;
		this.progressResolver = undefined;
		this.showingProgress = false;
		this.content = content;
		this.inputHandler = inputHandler;
		this.inputTarget = inputTarget;
		if (this.inputTarget) this.inputTarget.focused = this._focused;
		this.tui.requestRender();
	}

	/** 模型列表屏：已加载的排最前，其余按 id 字典序；末尾固定追加「下载模型…」入口 */
	showModels(serverUrl: string, models: LlamaModelInfo[]): Promise<LlamaManagerAction> {
		// loaded 状态的模型置顶，其余按 id 字典序排列
		const sorted = [...models].sort((left, right) => {
			const loaded = Number(right.status.value === "loaded") - Number(left.status.value === "loaded");
			return loaded || left.id.localeCompare(right.id);
		});
		const byId = new Map(sorted.map((model) => [model.id, model]));
		const items: SelectItem[] = [
			...sorted.map((model) => ({
				value: model.id,
				label: model.id,
				description: modelDescription(model),
			})),
			// 哨兵项：选中后进入 Hugging Face 下载流程
			{ value: DOWNLOAD_VALUE, label: "Download model…", description: "Hugging Face owner/repository[:quant]" },
		];
		return new Promise((resolve) => {
			// 最多同屏 12 行（不足则按实际数量），超出由 SelectList 内部滚动
			const list = new SelectList(items, Math.min(items.length, 12), selectTheme(this.theme), {
				// 主列（模型 id）宽度区间：兼顾长 id 展示与描述列的可用空间
				minPrimaryColumnWidth: 36,
				maxPrimaryColumnWidth: 56,
			});
			list.onSelect = (item) => {
				if (item.value === DOWNLOAD_VALUE) resolve({ type: "download" });
				else {
					const model = byId.get(item.value);
					if (model) resolve({ type: "model", model });
				}
			};
			list.onCancel = () => resolve({ type: "close" });
			this.setContent(
				frame(
					this.theme,
					"llama.cpp models",
					[new Text(this.theme.fg("dim", serverUrl), 1, 0), new Spacer(1), list],
					`${keyHint("tui.select.confirm", "load/unload/download")} • ${keyHint("tui.select.cancel", "close")}`,
				),
				list,
			);
		});
	}

	/** 通用单选框：options 包装为 SelectList，确认返回选项值、取消返回 undefined */
	select(title: string, options: string[]): Promise<string | undefined> {
		return new Promise((resolve) => {
			const list = new SelectList(
				options.map((option) => ({ value: option, label: option })),
				Math.min(options.length, 12),
				selectTheme(this.theme),
			);
			list.onSelect = (item) => resolve(item.value);
			list.onCancel = () => resolve(undefined);
			this.setContent(
				frame(
					this.theme,
					title,
					[new Spacer(1), list],
					`${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "cancel")}`,
				),
				list,
			);
		});
	}

	/** Yes/No 确认框：复用 select 实现，选 Yes 时返回 true */
	async confirm(title: string, message: string): Promise<boolean> {
		return (await this.select(`${title}\n${message}`, ["Yes", "No"])) === "Yes";
	}

	/** 连接失败错误屏：标题携带服务地址与错误信息，用户可选择重试或关闭 */
	async connectionError(serverUrl: string, message: string): Promise<"retry" | "close"> {
		const choice = await this.select(`llama.cpp unavailable\n${serverUrl}\n\n${message}`, ["Retry", "Close"]);
		return choice === "Retry" ? "retry" : "close";
	}

	/** Hugging Face 搜索屏：resolve 为选中的模型标识；取消/返回时为 undefined */
	searchModels(
		search: (query: string, signal: AbortSignal) => Promise<HuggingFaceModel[]>,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			const component = new HuggingFaceSearch(
				this.tui,
				this.theme,
				this.keybindings,
				search,
				this.searchCache,
				resolve,
			);
			this.setContent(
				frame(
					this.theme,
					"Download model",
					[new Spacer(1), component],
					`${keyHint("tui.select.confirm", "select")} • ${keyHint("tui.select.cancel", "back")}`,
				),
				component,
				component,
			);
		});
	}

	/** 展示一条无交互的状态消息面板 */
	showStatus(title: string, message: string): void {
		this.setContent(frame(this.theme, title, [new Spacer(1), new Text(this.theme.fg("muted", message), 1, 0)]));
	}

	/**
	 * 进入进度展示态并等待用户取消。stop Promise 只在首次调用时创建，
	 * 之后重复调用复用同一个 Promise——runWithProgress 的等待循环依赖
	 * 这一语义来反复监听用户的取消动作。
	 */
	progress(state: ProgressState): Promise<void> {
		if (!this.progressPromise) {
			this.progressPromise = new Promise((resolve) => {
				this.progressResolver = resolve;
			});
		}
		this.showingProgress = true;
		this.updateProgress(state);
		return this.progressPromise;
	}

	/** 刷新进度屏：模型名 + 消息 + 可选进度条 + 可选明细；仅在进度态下生效 */
	updateProgress(state: ProgressState): void {
		// 非进度态直接忽略，防止把普通界面误刷成进度屏
		if (!this.showingProgress) return;
		const body = [
			new Text(this.theme.fg("text", state.model), 1, 0),
			new Spacer(1),
			new Text(this.theme.fg("muted", state.message), 1, 0),
		];
		if (state.ratio !== undefined) {
			// 40 格宽的进度条；ratio 先钳制到 [0,1]，防御外部传入的越界值
			const available = 40;
			const filled = Math.round(Math.max(0, Math.min(1, state.ratio)) * available);
			body.push(
				new Text(
					this.theme.fg(
						"accent",
						`${"█".repeat(filled)}${"─".repeat(available - filled)} ${Math.round(state.ratio * 100)}%`,
					),
					1,
					0,
				),
			);
		}
		if (state.detail) body.push(new Text(this.theme.fg("dim", state.detail), 1, 0));
		this.content = frame(this.theme, state.title, body, keyHint("tui.select.cancel", "stop"));
		// 进度屏不接受列表输入，只监听取消键（由根视图 handleInput 处理）
		this.inputHandler = undefined;
		this.tui.requestRender();
	}

	/** 根视图按键入口：进度态下取消键触发 stop；其余转发给当前界面的处理组件 */
	handleInput(data: string): void {
		// 进度屏上按取消：resolve progress() 的 Promise 通知任务方停止，
		// 同时清空引用（下次进入进度屏时会重建）
		if (this.progressResolver && this.keybindings.matches(data, "tui.select.cancel")) {
			const resolve = this.progressResolver;
			this.progressPromise = undefined;
			this.progressResolver = undefined;
			resolve();
			return;
		}
		this.inputHandler?.handleInput?.(data);
		this.tui.requestRender();
	}

	/** 渲染当前面板；逐行按可视宽度兜底截断，防止内容在窄终端下溢出换行 */
	render(width: number): string[] {
		return this.content
			.render(width)
			.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
	}

	/** 透传失效通知给当前内容面板 */
	invalidate(): void {
		this.content.invalidate();
	}
}

/**
 * 把 llama.cpp 管理界面挂载到宿主 TUI 的入口函数。
 * 通过 ctx.ui.custom 接管整屏；run 回调拿到实现 LlamaUi 的视图后驱动整个流程，
 * 无论正常结束还是抛错都调用 done() 收尾，异常另以 notify 弹出错误提示。
 */
export async function showLlamaUi(ctx: ExtensionCommandContext, run: (ui: LlamaUi) => Promise<void>): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new LlamaView(tui, theme, keybindings);
		// run 的结果决定收尾方式：成功静默退出，失败转成用户可见的错误通知
		void run(view).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return view;
	});
}

/**
 * 「可取消任务 + 进度 UI」驱动器。
 * 启动 options.run（可通过 signal 中断、通过 update 回调上报进度）并同时展示进度屏；
 * 用户在进度屏按取消键后先弹确认框：确认则调用 options.cancel 优雅取消并 abort 兜底，
 * 拒绝则继续等待。任务自然结束返回其结果，被取消则返回 { cancelled: true }。
 *
 * 采用 while + Promise.race 轮询而非一次性 await 的原因：进度屏的 stop Promise
 * 可能被多次触发（用户反复按取消），每次都需重新弹确认框，直到任务完成或确认取消。
 */
export async function runWithProgress<T>(
	ui: LlamaUi,
	options: {
		title: string;
		model: string;
		initialMessage: string;
		cancelTitle: string;
		cancelMessage: string;
		run(signal: AbortSignal, update: (progress: LlamaProgress) => void): Promise<T>;
		cancel(): Promise<void>;
	},
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
	const controller = new AbortController();
	const state: ProgressState = { title: options.title, model: options.model, message: options.initialMessage };
	// 把 run 的成功/失败归一为不抛错的 settled 结果，便于与进度 stop Promise 一起 race
	const settled = options
		.run(controller.signal, (progress) => {
			Object.assign(state, progress);
			ui.updateProgress(state);
		})
		.then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	let completed = false;
	// finally 只做标记：循环靠它区分「任务已结束」与「用户又一次按了取消」
	settled.finally(() => {
		completed = true;
	});

	while (!completed) {
		// ===== 等待二者之一：任务自然完成，或用户在进度屏上按了取消 =====
		const outcome = await Promise.race([
			settled.then(() => "settled" as const),
			ui.progress(state).then(() => "stop" as const),
		]);
		if (outcome === "settled") break;
		// 用户请求停止：弹确认框；反悔（或任务恰好已完成）则回到循环继续等待
		const stop = await ui.confirm(options.cancelTitle, options.cancelMessage);
		if (!stop || completed) continue;
		try {
			// 先执行业务侧的优雅取消（如终止下载子进程），无论成败都 abort 信号兜底
			await options.cancel();
		} finally {
			controller.abort(new Error("Cancelled"));
		}
		await settled;
		return { cancelled: true };
	}

	const result = await settled;
	// 归一时吞掉的错误在这里原样抛回，交由调用方处理
	if (!result.ok) throw result.error;
	return { cancelled: false, value: result.value };
}
