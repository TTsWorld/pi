/**
 * @file session-selector.ts —— TUI 会话选择器组件（Resume Session 面板）
 *
 * @description
 * 本文件实现交互模式下「恢复历史会话」的完整 UI：以带边框的面板列出历史会话，
 * 支持模糊/正则/精确短语搜索、线程化树形展示（按 parentSessionPath 组织父子会话）、
 * 排序与过滤切换（当前目录/全部、全部/仅已命名）、会话预览元信息（消息数、距今年龄、
 * cwd、文件路径）、会话重命名与删除（优先移入系统回收站）、加载进度与状态提示。
 *
 * 组件层次（均由本文件组装，仅顶层类对外导出）：
 * - SessionSelectorComponent —— 顶层容器：持有头部与列表，负责双作用域
 *   （当前目录 / 全部）的会话加载与缓存、切换、删除/重命名后的刷新、重命名模式切换；
 * - SessionSelectorHeader —— 头部信息条：标题、作用域/过滤/排序状态、加载进度、
 *   快捷键提示、删除确认提示与超时自动消失的状态消息；
 * - SessionList —— 列表本体：搜索框 + 单行会话条目（树形前缀 + 名称/首条消息 +
 *   右侧元信息），集中处理全部键盘交互（导航、翻页、删除确认、重命名等）。
 *
 * 辅助部分：buildSessionTree / flattenSessionTree 负责线程化视图的树构建与拍平；
 * deleteSessionFile 负责删除会话文件（优先 trash CLI，失败回退 unlink）。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：基础组件（Container/Input/Text/Spacer）、
 *   按键绑定解析（getKeybindings）与终端宽度工具（truncateToWidth/visibleWidth）；
 * - `../../../core/session-manager.ts`：SessionInfo / SessionListProgress 类型；
 * - `./session-selector-search.ts`：过滤排序（filterAndSortSessions）与命名判定；
 * - `./dynamic-border.ts` / `./keybinding-hints.ts` / `../theme/theme.ts`：
 *   动态边框、快捷键提示与主题配色。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../../../core/session-manager.ts";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.ts";

/**
 * 会话列表的作用域：
 * - "current"：仅显示当前工作目录下创建的会话；
 * - "all"：显示全部历史会话（跨目录），列表条目会附带 cwd 提示。
 */
type SessionScope = "current" | "all";

/**
 * 把家目录前缀缩写为 `~`，仅用于界面显示降噪，不影响真实路径。
 */
function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/**
 * 把会话的最后修改时间格式化为相对现在的紧凑时长字符串。
 * 输出形如 "now" / "5m" / "3h" / "2d" / "1w" / "2mo" / "1y"，
 * 供列表右侧元信息使用，避免完整日期占用过多宽度。
 */
function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	// 先换算成分钟/小时/天三种粒度，再按时间区间从近到远选择展示单位
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

/**
 * 路径规范化的本地包装：兼容 undefined（直接透传），让调用处免于逐个判空。
 * 实际逻辑复用 utils/paths.ts 的实现（导入时重命名为 _canonicalizePath，
 * 避免与本包装函数同名冲突）。
 */
function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

/**
 * 会话选择器的头部信息条（内部组件，不对外导出）。
 *
 * 渲染固定三行：
 * 1. 标题行——左侧面板标题，右侧「作用域 | 名称过滤 | 排序方式」状态；
 * 2~3. 提示行——按状态三选一：删除确认提示（红色）、状态消息（info/error 色）
 *    或常规快捷键提示（两行）。
 *
 * 本组件不处理按键输入，只被动接收外部 setState 调用更新显示；
 * 状态消息支持超时自动隐藏（见 setStatusMessage）。
 */
class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// 进度信息只隶属于「当前这一次加载」；加载状态被重设时清零，避免残留旧进度
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	/**
	 * 设置状态消息（如「已移入回收站」「删除失败：...」）。
	 * 传入 autoHideMs 时超时后自动清除并触发重绘；设置新消息前会先取消旧的超时定时器。
	 */
	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		// 标题随作用域切换；右侧状态由排序方式与名称过滤两个标签组成
		const title = this.scope === "current" ? "Resume Session (Current Folder)" : "Resume Session (All)";
		const leftText = theme.bold(title);

		const sortLabel = this.sortMode === "threaded" ? "Threaded" : this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		// 作用域指示：加载中显示进度，否则高亮当前选中的一侧（◉ / ○ 对比）
		let scopeText: string;
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", `Loading ${progressText}`)}`;
		} else if (this.scope === "current") {
			scopeText = `${theme.fg("accent", "◉ Current Folder")}${theme.fg("muted", " | ○ All")}`;
		} else {
			scopeText = `${theme.fg("muted", "○ Current Folder | ")}${theme.fg("accent", "◉ All")}`;
		}

		// 右侧状态优先占用所需宽度（超出总宽则截断），标题只使用剩余宽度；两侧靠中间空格推开
		const rightText = truncateToWidth(`${scopeText}  ${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// 构建提示行——内容随状态三选一（删除确认 / 状态消息 / 常规快捷键），所有分支都按总宽截断
		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			// 常规提示：第一行为搜索语法，第二行为各项开关快捷键（重命名提示仅在能力可用时追加）
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 =
				keyHint("tui.input.tab", "scope") + sep + theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.session.delete", "delete"),
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			const hint2 = hint2Parts.join(sep);
			hintLine1 = truncateToWidth(hint1, width, "…");
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

/** 会话树节点：按父子关系（parentSessionPath）层级展示会话时使用 */
interface SessionTreeNode {
	/** 该节点对应的会话信息 */
	session: SessionInfo;
	/** 子会话节点（从本会话派生出的分支） */
	children: SessionTreeNode[];
	/** 整棵子树中最新的活动时间戳（毫秒），用于让子树整体按活跃度排序 */
	latestActivity: number;
}

/** 拍平后的展示节点：在会话信息之外附带树形渲染所需的层级结构元数据 */
interface FlatSessionNode {
	/** 对应的会话 */
	session: SessionInfo;
	/** 嵌套深度（根节点为 0，决定缩进层数） */
	depth: number;
	/** 是否为父节点的最后一个孩子（决定树枝符号用 └─ 还是 ├─） */
	isLast: boolean;
	/** 逐层记录每个祖先层级之后是否还有兄弟节点（决定是否绘制 │ 延续竖线） */
	ancestorContinues: boolean[];
}

/**
 * 依据 parentSessionPath 把会话列表组装成森林（多棵树）。
 * 父会话不存在（或不在本次列表中）的会话视为根节点。
 * 返回的根节点数组按「子树最新活动时间」降序排列。
 */
function buildSessionTree(sessions: SessionInfo[]): SessionTreeNode[] {
	// 第一遍：以「规范化后的会话路径」为 key 建立路径 -> 节点索引
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [], latestActivity: session.modified.getTime() });
	}

	const roots: SessionTreeNode[] = [];

	// 第二遍：挂接父子关系；父路径不在索引中（父会话被删或未加载）则降级为根节点
	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// 自底向上聚合：让父节点的 latestActivity 覆盖所有子孙的最新活动，
	// 这样活跃的子分支能带动整棵树在排序中靠前
	const updateLatestActivity = (node: SessionTreeNode): number => {
		let latestActivity = node.session.modified.getTime();
		for (const child of node.children) {
			latestActivity = Math.max(latestActivity, updateLatestActivity(child));
		}
		node.latestActivity = latestActivity;
		return latestActivity;
	};

	for (const root of roots) {
		updateLatestActivity(root);
	}

	// 每一层级内部都按「子树最新活动时间」降序排序（根数组与各节点的孩子数组统一处理）
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.latestActivity - a.latestActivity);
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * 把树深度优先拍平成一维展示列表，同时记录每个节点的缩进深度、
 * 树枝符号与祖先延续线信息，供列表逐行渲染树形前缀（见 buildTreePrefix）。
 */
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	// DFS：进入子节点时把「当前层级是否延续」追加进祖先数组（拷贝新数组，兄弟节点间互不影响）
	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// 只有非根层级需要记录延续线：父节点后面还有兄弟时才画 │
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/**
 * 自定义会话列表组件：搜索框 + 单行会话条目，支持线程化树形展示。
 *
 * 同时实现 Component 与 Focusable；焦点会透传给内部搜索框（保证 IME 光标定位）。
 * 所有键盘交互集中在 handleInput 分派：先拦截模态的删除确认与各类切换/操作快捷键，
 * 再处理上下移动/翻页/确认/取消，其余按键转发给搜索框并即时重新过滤。
 */
class SessionList implements Component, Focusable {
	/** 获取当前选中会话的文件路径（无选中项时返回 undefined） */
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	/** 过滤前的全部会话（由宿主 setSessions 注入） */
	private allSessions: SessionInfo[] = [];
	/** 过滤 + 排序（必要时树形化）之后的拍平展示列表 */
	private filteredSessions: FlatSessionNode[] = [];
	/** 当前选中项在 filteredSessions 中的下标 */
	private selectedIndex: number = 0;
	/** 顶部搜索输入框 */
	private searchInput: Input;
	/** 是否在条目右侧附带显示会话的工作目录（"all" 作用域下为 true） */
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	/** 是否在条目右侧显示会话文件路径 */
	private showPath = false;
	/** 正在等待删除确认的会话路径；非 null 时列表进入模态确认状态 */
	private confirmingDeletePath: string | null = null;
	/** 当前活动会话的规范化路径（用于高亮标记与禁止删除自身） */
	private currentSessionCanonicalPath?: string;
	// ===== 宿主（SessionSelectorComponent）注入的回调 =====
	/** 选中某个会话（按文件路径） */
	public onSelect?: (sessionPath: string) => void;
	/** 取消选择（Escape） */
	public onCancel?: () => void;
	/** 退出选择器 */
	public onExit: () => void = () => {};
	/** 切换作用域（当前目录 <-> 全部） */
	public onToggleScope?: () => void;
	/** 切换排序模式 */
	public onToggleSort?: () => void;
	/** 切换命名过滤（全部 <-> 仅已命名） */
	public onToggleNameFilter?: () => void;
	/** 路径显示开关变化 */
	public onTogglePath?: (showPath: boolean) => void;
	/** 删除确认状态变化（供头部同步切换确认提示） */
	public onDeleteConfirmationChange?: (path: string | null) => void;
	/** 确认删除后执行实际删除 */
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	/** 请求重命名指定会话 */
	public onRenameSession?: (sessionPath: string) => void;
	/** 上报错误提示 */
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // 可视区最多显示的会话条数（每条一行）

	// Focusable 实现——把焦点透传给搜索框，保证 IME（输入法组合输入）时光标定位正确
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	/**
	 * @param sessions 初始会话列表（可为空，随后由宿主 setSessions 更新）
	 * @param showCwd 是否在条目右侧显示工作目录
	 * @param sortMode 初始排序模式
	 * @param nameFilter 初始命名过滤
	 * @param keybindings 按键绑定管理器
	 * @param currentSessionFilePath 当前活动会话的路径（可选）
	 */
	constructor(
		sessions: SessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// 搜索框内按 Enter：等价于确认选中当前高亮项
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	/** 切换排序模式，并按当前搜索词重新过滤 */
	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	/** 切换命名过滤，并按当前搜索词重新过滤 */
	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	/** 替换会话数据源（加载完成或删除后调用），保持搜索词不变并重新过滤 */
	setSessions(sessions: SessionInfo[], showCwd: boolean): void {
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.filterSessions(this.searchInput.getValue());
	}

	/**
	 * 依据搜索词 + 排序模式 + 命名过滤重建 filteredSessions 展示列表。
	 *
	 * 只有「线程化排序且无搜索词」时才展示树形结构；一旦带有搜索词或切换到
	 * 其他排序模式，一律退化为平铺列表——搜索命中项可能分散在各子树中，
	 * 保留树形缩进反而难以快速定位。
	 */
	private filterSessions(query: string): void {
		const trimmed = query.trim();
		// 命名过滤：named 模式只保留设置过自定义名称的会话
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		if (this.sortMode === "threaded" && !trimmed) {
			// 线程化模式且无搜索词：构建并拍平树形结构
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// 其他排序模式或带搜索词：走统一的过滤排序逻辑，输出平铺列表
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		// 列表变短后把选中下标收敛回有效范围（避免高亮悬空）
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	/** 更新删除确认状态，并同步通知头部切换确认提示文案 */
	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	/** 对当前选中会话发起删除确认（模态）；列表为空时静默忽略 */
	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// 禁止删除当前正在使用的会话（删除自身会导致会话状态不一致）
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.session.path);
	}

	/** 判断给定路径是否为当前活动会话：两边都规范化后再比较，避免等价路径写法误判 */
	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	/**
	 * 渲染列表区域：搜索框 +（空态提示 或 会话条目列表，含滚动窗口与滚动指示）。
	 * 每个会话固定单行：光标 + 树形前缀 + 名称/首条消息（左）+ 元信息（右）。
	 */
	render(width: number): string[] {
		const lines: string[] = [];

		// 渲染搜索框
		lines.push(...this.searchInput.render(width));
		lines.push(""); // 搜索框后留一个空行分隔

		// 空态：按「命名过滤」与「作用域」的组合给出有针对性的提示
		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
			} else if (this.showCwd) {
				// 「All」作用域：所有目录下都没有匹配的会话
				emptyMessage = "  No sessions found";
			} else {
				// 「当前目录」作用域：提示按 Tab 切换到全部会话再试
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// 计算滚动窗口：让选中项尽量居中（向上偏移半屏），同时窗口整体不越出列表两端
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// 逐行渲染可视区内的会话（每条一行，带树形前缀）
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.path);

			// 构建树形前缀（│ 延续线 + └─/├─ 树枝符号）
			const prefix = this.buildTreePrefix(node);

			// 展示文本：优先自定义名称，否则取首条消息
			const hasName = !!session.name;
			const displayText = session.name ?? session.firstMessage;
			// 控制字符（换行/退格等）替换为空格，避免破坏单行布局
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// 右侧元信息：消息数 + 距今时长；按需再前置 cwd / 会话文件路径
			const age = formatSessionDate(session.modified);
			const msgCount = String(session.messageCount);
			let rightPart = `${msgCount} ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${shortenPath(session.cwd)} ${rightPart}`;
			}
			if (this.showPath) {
				rightPart = `${shortenPath(session.path)} ${rightPart}`;
			}

			// 光标指示符：选中项显示 ›，未选中用两个空格占位保持对齐
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// 计算消息文本可用宽度：总宽扣除光标、前缀与右侧信息
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2; // +2 为与消息之间的间隔空隙
			const availableForMsg = width - 2 - prefixWidth - rightWidth; // -2 为行首光标占位

			// 至少保留 10 列，避免极窄终端下截断函数收到负宽度
			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// 消息着色：删除确认=红、当前会话=强调色、已命名=警示色；选中项额外加粗
			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = theme.bold(styledMsg);
			}

			// 拼接整行：左侧内容 + 中间空格撑开 + 右侧信息；选中行整行加高亮背景
			const leftPart = cursor + theme.fg("dim", prefix) + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(truncateToWidth(line, width));
		}

		// 窗口未覆盖整个列表（可滚动）时，追加「当前位置/总数」滚动指示
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	/** 按节点的深度与祖先延续信息生成树形缩进前缀（如 "│  └─ "）；根节点无前缀 */
	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	/**
	 * 统一键盘入口。按键分派顺序（前者优先）：
	 * 删除确认（模态，吞掉全部按键）→ 作用域/排序/过滤/路径/删除/重命名等操作快捷键
	 * → 上下移动/翻页/确认/取消 → 其余全部转发给搜索框。
	 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// 删除确认是模态状态：最先处理并拦截所有按键
		if (this.confirmingDeletePath !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				// 确认删除：先退出确认态再异步执行，避免删除期间仍处于模态
				const pathToDelete = this.confirmingDeletePath;
				this.setConfirmingDeletePath(null);
				void this.onDeleteSession?.(pathToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeletePath(null);
				return;
			}
			// 确认期间忽略其余所有按键
			return;
		}

		// Tab：切换作用域（当前目录 <-> 全部）
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		// 切换排序模式
		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		// 切换命名过滤（全部 <-> 仅已命名）
		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		// 切换是否显示会话文件路径
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// 显式删除快捷键：发起删除确认
		//（对无法区分 Ctrl+Backspace 与 Backspace 的终端尤其有用）
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// 重命名当前选中的会话
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Ctrl+Backspace：删除的「非侵入式」便捷别名——
		// 仅当搜索词为空时才触发删除；否则转发给输入框执行「删除一个词」的编辑操作
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// 上移一行（到顶即停）
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// 下移一行（到底即停）
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// 上翻一页：一次移动 maxVisible 条
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// 下翻一页：一次移动 maxVisible 条
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// 确认：恢复当前选中的会话
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		}
		// Escape：取消选择
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// 其余按键（普通字符、编辑键等）转发给搜索框，并即时重新过滤列表
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

/**
 * 会话列表加载器：按需拉取某个作用域（当前目录 / 全部）的会话；
 * 可选的 onProgress 用于上报「已加载/总数」的增量进度（驱动头部进度显示）。
 */
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/**
 * 删除会话文件：优先尝试 `trash` CLI（移入系统回收站，可恢复），
 * trash 不可用或执行失败时回退为 unlink 永久删除。
 *
 * @returns ok 表示是否删除成功；method 记录实际采用的删除方式；
 * error 为失败原因——若回退的 unlink 也失败，会把 trash 的报错提示附在后面，
 * 便于诊断 trash 为何不可用（如未安装）
 */
async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	// 优先尝试 trash（若已安装）
	// 路径以 "-" 开头时补上 "--" 分隔符，防止被 trash 当作选项参数解析
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	// 汇总 trash 的失败原因（spawn error + stderr 首行，截断到 200 字符），供最终报错时附带展示
	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// trash 退出码为 0，或文件此后已不存在（如已被其他进程删除），都视为删除成功
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// 回退：unlink 永久删除（不可恢复）
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}

/**
 * 会话选择器顶层组件（本文件唯一导出项）：组装头部信息条与会话列表，
 * 并承载全部业务状态与数据流。
 *
 * 职责要点：
 * - 双作用域数据：current / all 各自持有缓存与加载器，「全部」作用域惰性加载
 *   （首次切换到 All 时才触发全量扫描）；
 * - 删除/重命名等改动后自动按当前作用域重新加载会话（refreshSessionsAfterMutation）；
 * - 内部有 "list" / "rename" 两种模式：重命名时整体切换为独立的输入面板；
 * - 异步竞态防护：加载结果返回时通过「作用域一致性 + 自增序号（allLoadSeq）」
 *   双重校验，丢弃过期响应，避免旧数据覆盖新状态。
 */
export class SessionSelectorComponent extends Container implements Focusable {
	/**
	 * 键盘入口：重命名模式下 Escape 退出、其余交给重命名输入框；
	 * 列表模式下透传给会话列表处理。
	 */
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	/** 是否支持重命名（由是否注入 renameSession 回调决定，控制提示是否展示） */
	private canRename = true;
	/** 会话列表组件（搜索 + 条目 + 滚动） */
	private sessionList: SessionList;
	/** 头部信息条（状态、进度、提示） */
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	/** 当前作用域与展示选项 */
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	/** 「当前目录」作用域的会话缓存（null = 尚未加载过） */
	private currentSessions: SessionInfo[] | null = null;
	/** 「全部」作用域的会话缓存（null = 尚未加载过；惰性加载） */
	private allSessions: SessionInfo[] | null = null;
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	/** 请求外层重绘的回调 */
	private requestRender: () => void;
	/** 宿主注入的重命名实现（未提供则隐藏重命名能力） */
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	/** 两个作用域各自的加载中标记 */
	private currentLoading = false;
	private allLoading = false;
	/** 「全部」作用域的加载序号：每次发起新加载自增，用于丢弃过期响应 */
	private allLoadSeq = 0;

	/** 内部模式：正常列表 或 重命名输入面板 */
	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	/** 正在重命名的会话路径 */
	private renameTargetPath: string | null = null;

	// Focusable 实现——把焦点透传给会话列表与重命名输入框（IME 光标定位）
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	/** 按统一骨架重建容器布局：上边框 +（可选）头部 + 内容 + 下边框，段间以 Spacer 留白 */
	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	/**
	 * @param currentSessionsLoader 「当前目录」作用域的会话加载器（构造后立即调用一次）
	 * @param allSessionsLoader 「全部」作用域的会话加载器（首次切换到 All 时才调用）
	 * @param onSelect 选中会话后的回调（由宿主真正执行会话恢复）
	 * @param onCancel 用户取消选择
	 * @param onExit 退出选择器
	 * @param requestRender 请求外层重绘
	 * @param options 可选能力注入：重命名回调、重命名提示开关、按键绑定管理器
	 * @param currentSessionFilePath 当前活动会话的路径（用于高亮与禁止删除自身）
	 */
	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: {
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
			keybindings?: KeybindingsManager;
		},
		currentSessionFilePath?: string,
	) {
		super();
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// 创建会话列表（初始为空，待加载完成后由 setSessions 填充）
		this.sessionList = new SessionList(
			[],
			false,
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
		);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// 选中/取消/退出时清空头部状态消息（连带取消其自动隐藏定时器），
		// 避免离开选择器后定时器仍触发无谓的重绘
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		// 重命名入口：加载中不允许进入（数据可能过期）；从当前作用域缓存里取原名用于预填
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.scope === "current" && this.currentLoading) return;
			if (this.scope === "all" && this.allLoading) return;

			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// 把列表内部的状态变化同步到头部显示
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// 删除会话：先删文件，成功后同步更新两份本地缓存并刷新列表
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			const result = await deleteSessionFile(sessionPath);

			if (result.ok) {
				// 本地缓存先剔除该会话让 UI 立即反馈；随后再从磁盘重新加载校准
				if (this.currentSessions) {
					this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
				}
				if (this.allSessions) {
					this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
				}

				const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
				const showCwd = this.scope === "all";
				this.sessionList.setSessions(sessions, showCwd);

				// 按实际删除方式给出提示（回收站可恢复 / 永久删除）
				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				await this.refreshSessionsAfterMutation();
			} else {
				const errorMessage = result.error ?? "Unknown error";
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			this.requestRender();
		};

		// 构造完成后立即开始加载当前目录的会话
		this.loadCurrentSessions();
	}

	/** 触发「当前目录」作用域的首次加载（fire-and-forget，错误在 loadScope 内部消化） */
	private loadCurrentSessions(): void {
		void this.loadScope("current", "initial");
	}

	/** 进入重命名模式：整体切换为独立的输入面板，并预填会话当前名称 */
	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	/** 退出重命名模式：清空重命名目标并恢复列表布局 */
	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	/**
	 * 提交重命名：空名称视为无效输入直接忽略；
	 * 无论成功与否都在 finally 中退出重命名模式，避免卡在面板里。
	 */
	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// 读取重命名回调（构造时注入，可能未提供）
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.refreshSessionsAfterMutation();
		} finally {
			this.exitRenameMode();
		}
	}

	/**
	 * 加载指定作用域的会话并更新列表 UI。
	 *
	 * 异步竞态防护：请求在途期间用户可能已切换作用域、或对同一作用域再次发起加载。
	 * 响应返回时做双重校验——「作用域已不是发起时的作用域」或「all 作用域的
	 * 加载序号已被更新的请求超越」——满足任一条件即丢弃本次结果，防止旧响应覆盖新状态。
	 *
	 * @param reason 加载触发方式：initial（构造时）/ refresh（删改后刷新）/ toggle（切换作用域）
	 */
	private async loadScope(scope: SessionScope, reason: "initial" | "refresh" | "toggle"): Promise<void> {
		const showCwd = scope === "all";

		// 标记对应作用域为加载中
		if (scope === "current") {
			this.currentLoading = true;
		} else {
			this.allLoading = true;
		}

		// all 作用域用自增序号区分新旧请求；current 作用域只需作用域一致性判断
		const seq = scope === "all" ? ++this.allLoadSeq : undefined;
		this.header.setScope(scope);
		this.header.setLoading(true);
		this.requestRender();

		// 进度回调同样要做过期校验：过期请求的进度不更新 UI
		const onProgress = (loaded: number, total: number) => {
			if (scope !== this.scope) return;
			if (seq !== undefined && seq !== this.allLoadSeq) return;
			this.header.setProgress(loaded, total);
			this.requestRender();
		};

		try {
			const sessions = await (scope === "current"
				? this.currentSessionsLoader(onProgress)
				: this.allSessionsLoader(onProgress));

			// 先无条件落地缓存并复位加载标记（即便 UI 已切走，缓存仍然有效可用）
			if (scope === "current") {
				this.currentSessions = sessions;
				this.currentLoading = false;
			} else {
				this.allSessions = sessions;
				this.allLoading = false;
			}

			// 已过期（用户切走或发起了更新的加载）则不再更新 UI
			if (scope !== this.scope) return;
			if (seq !== undefined && seq !== this.allLoadSeq) return;

			this.header.setLoading(false);
			this.sessionList.setSessions(sessions, showCwd);
			this.requestRender();
		} catch (err) {
			if (scope === "current") {
				this.currentLoading = false;
			} else {
				this.allLoading = false;
			}

			// 过期请求的错误同样静默丢弃
			if (scope !== this.scope) return;
			if (seq !== undefined && seq !== this.allLoadSeq) return;

			const message = err instanceof Error ? err.message : String(err);
			this.header.setLoading(false);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);

			// 首次加载即失败：置为空列表，让空态提示接管界面
			if (reason === "initial") {
				this.sessionList.setSessions([], showCwd);
			}
			this.requestRender();
		}
	}

	/** 循环切换排序模式 */
	private toggleSortMode(): void {
		// 循环顺序：threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	/** 切换命名过滤：全部 <-> 仅已命名 */
	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	/** 删除/重命名等变更发生后，按当前作用域重新加载会话，与磁盘状态校准 */
	private async refreshSessionsAfterMutation(): Promise<void> {
		await this.loadScope(this.scope, "refresh");
	}

	/**
	 * 切换作用域：
	 * - current -> all：已有缓存则直接复用（不重复加载），否则按需发起全量加载；
	 * - all -> current：立即恢复当前目录的缓存，并把头部加载态对齐到 currentLoading。
	 */
	private toggleScope(): void {
		if (this.scope === "current") {
			this.scope = "all";
			this.header.setScope(this.scope);

			// 已加载过「全部」会话：直接用缓存渲染，避免每次切换都重新扫描
			if (this.allSessions !== null) {
				this.header.setLoading(false);
				this.sessionList.setSessions(this.allSessions, true);
				this.requestRender();
				return;
			}

			if (!this.allLoading) {
				void this.loadScope("all", "toggle");
			}
			return;
		}

		this.scope = "current";
		this.header.setScope(this.scope);
		this.header.setLoading(this.currentLoading);
		this.sessionList.setSessions(this.currentSessions ?? [], false);
		this.requestRender();
	}

	/** 暴露内部的会话列表组件（宿主用于查询当前选中项等） */
	getSessionList(): SessionList {
		return this.sessionList;
	}
}
