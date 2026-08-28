/**
 * @file tree-selector.ts —— 会话树选择器组件（/tree 命令的交互界面）
 *
 * @description
 * 本文件在 pi-tui 基础组件之上实现终端里的会话树选择器，用于会话树导航（/tree）
 * 与分支选择：把 SessionTreeNode[] 会话树拍平为可见行列表，用 ASCII 树形符号
 * （├─ / └─ / │）可视化层级结构，并提供键盘导航、折叠/展开、过滤、增量搜索、
 * 标签编辑与复制等能力。
 *
 * 主要功能点：
 * - TreeList：核心树列表组件。负责树拍平（flattenTree）、过滤与折叠（applyFilter）、
 *   过滤后可视结构重算（recalculateVisualStructure）、键盘导航与逐行渲染；
 * - 当前分支优先：包含当前叶子（active leaf）的子树总是排在兄弟节点之前，
 *   根到叶子的活跃路径用 • 标记，便于一眼定位当前所在分支；
 * - renderHorizontalViewport：水平视口裁剪——行内容超宽时向左平移正文，
 *   同时保持固定宽度的树形装饰线不动；
 * - SearchLine / TreeHelp / LabelInput：搜索提示行、按键帮助、标签输入等辅助子组件；
 * - TreeSelectorComponent：对外导出的组合容器，负责组装上述子组件、
 *   在树列表与标签输入之间切换焦点并转发键盘输入。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：基础 TUI 组件（Container / Text / Input / Spacer）与
 *   宽度/换行等工具函数（sliceByColumn、truncateToWidth、visibleWidth）；
 * - `../../../core/session-manager.ts`：SessionTreeNode 会话树节点类型；
 * - `../theme/theme.ts`：终端主题配色；
 * - `./dynamic-border.ts` / `./keybinding-hints.ts`：动态边框与按键提示渲染。
 */
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	type Keybinding,
	Spacer,
	sliceByColumn,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SessionTreeNode } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { formatKeyText, keyHint } from "./keybinding-hints.ts";

/** 装饰线（gutter）信息：记录祖先分叉点的延续线位置，以及该位置是否显示 │ */
interface GutterInfo {
	position: number; // 连接符所在 displayIndent 层级
	show: boolean; // true = 显示 │，false = 显示空格
}

/** 拍平后的树节点，是过滤与渲染的最小单元（一次深度优先遍历产出一行） */
interface FlatNode {
	node: SessionTreeNode;
	/** 缩进层级（每级占 3 个字符宽：连接符 2 字符 + 空格 1 字符） */
	indent: number;
	/** 是否显示连接符（├─ 或 └─）——父节点有多个子节点（分叉）时为 true */
	showConnector: boolean;
	/** showConnector 为 true 时：true = 兄弟中最后一个（└─），false = 非最后（├─） */
	isLast: boolean;
	/** 每个祖先分叉点的装饰线信息（用于绘制 │ 延续线） */
	gutters: GutterInfo[];
	/** 该节点是否为「虚拟分叉根」下的根节点（存在多个根节点时） */
	isVirtualRootChild: boolean;
}

/** 水平视口中一行的渲染数据：装饰线固定不随水平滚动移动，正文可被平移裁剪 */
interface HorizontalViewportRow {
	/** 行左侧固定区（光标/选中标记），始终完整显示 */
	gutter: string;
	/** 行主体（树形前缀 + 标签 + 正文），超宽时按列裁剪 */
	body: string;
	/** 锚点列：正文文本（树形缩进/标记之后）在 body 中的起始列 */
	anchorCol: number;
	/** body 的可见宽度（按显示列计算，不含 ANSI 转义序列） */
	bodyWidth: number;
	/** 是否为当前选中行（用于水平平移决策） */
	isSelected: boolean;
}

// 树形装饰线（行首光标/选中标记区）占用的固定列数
const TREE_GUTTER_WIDTH = 2;
// 触发水平平移后，选中行锚点之后至少要保留可见的正文宽度（下限）
const MIN_VISIBLE_ANCHOR_CONTENT_WIDTH = 4;
// 同上（上限）；实际值在两限之间按视口宽度的 1/3 取整
const MAX_VISIBLE_ANCHOR_CONTENT_WIDTH = 20;
// 平移后锚点左侧保留的上下文宽度下限（让用户仍能看到一点前缀）
const MIN_ANCHOR_CONTEXT_WIDTH = 2;
// 同上（上限）；实际值在两限之间按视口宽度的 1/4 取整
const MAX_ANCHOR_CONTEXT_WIDTH = 12;

/**
 * 把树形行渲染进一个水平裁剪的视口。
 *
 * 树形装饰线（gutter）始终保持可见；仅当选中行的锚点（其正文文本在树形
 * 缩进/标记之后的起始位置）太靠右、导致看不到有用内容时，才把行主体左移。
 *
 * @param rows - 已渲染好的行数据（含装饰线、主体、锚点列等）
 * @param width - 组件可用总宽度（列）
 * @returns 每行一个字符串（含 ANSI 颜色码），已按宽度截断
 */
function renderHorizontalViewport(rows: HorizontalViewportRow[], width: number): string[] {
	// ===== 计算平移量 =====
	// 视口宽度 = 总宽减去固定装饰线；最大可平移量 = 最长正文 - 视口宽
	const viewportWidth = Math.max(0, width - TREE_GUTTER_WIDTH);
	const maxBodyWidth = rows.reduce((max, row) => Math.max(max, row.bodyWidth), 0);
	const maxHorizontalScroll = Math.max(0, maxBodyWidth - viewportWidth);
	const selectedRow = rows.find((row) => row.isSelected);

	// 仅在必要时水平平移：保证选中行锚点之后仍能看到足够的正文内容
	let horizontalScroll = 0;
	if (selectedRow && maxHorizontalScroll > 0) {
		// 锚点后至少保留的正文宽：视口宽的 1/3，夹在 [4, 20] 区间内
		const minVisibleAnchorContentWidth = Math.min(
			MAX_VISIBLE_ANCHOR_CONTENT_WIDTH,
			Math.max(MIN_VISIBLE_ANCHOR_CONTENT_WIDTH, Math.floor(viewportWidth / 3)),
		);
		if (selectedRow.anchorCol > viewportWidth - minVisibleAnchorContentWidth) {
			// 平移后锚点左侧保留的上下文宽：视口宽的 1/4，夹在 [2, 12] 区间内
			const anchorContextWidth = Math.min(
				MAX_ANCHOR_CONTEXT_WIDTH,
				Math.max(MIN_ANCHOR_CONTEXT_WIDTH, Math.floor(viewportWidth / 4)),
			);
			horizontalScroll = Math.min(maxHorizontalScroll, selectedRow.anchorCol - anchorContextWidth);
		}
	}

	// ===== 逐行裁剪输出 =====
	// 只裁剪正文部分；固定宽度的装饰线保留可见，作为树形导航参照
	return rows.map((row) => {
		const line =
			// 平移时在裁剪结果后补 ANSI 重置码，避免颜色状态泄漏到行尾
			horizontalScroll > 0
				? `${row.gutter}${sliceByColumn(row.body, horizontalScroll, viewportWidth, true)}\x1b[0m`
				: row.gutter + row.body;
		return truncateToWidth(line, width, "");
	});
}

/**
 * 树展示的过滤模式（导出供外部在打开选择器时指定初始模式）：
 * - "default"：默认视图，隐藏设置/簿记类条目
 * - "no-tools"：默认视图再隐藏工具结果（toolResult）
 * - "user-only"：只显示用户消息
 * - "labeled-only"：只显示打了标签的条目
 * - "all"：显示全部条目
 */
export type FilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/**
 * 树列表组件：支持选中与 ASCII 树形可视化
 * （注：此 JSDoc 描述的是下方的 TreeList 类，原文件即位于此处，保持位置不变）
 */
/** 工具调用信息，用于按 toolCallId 反查工具名与参数 */
interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

/**
 * 会话树导航的核心列表组件（实现 pi-tui 的 Component 接口）。
 *
 * 内部维护两层节点列表：flatNodes（完整拍平的树）与 filteredNodes
 * （应用过滤模式 + 搜索关键词 + 折叠后的可见子集），渲染与导航均基于后者；
 * 键盘交互（移动/翻页/折叠/过滤/搜索/确认/复制/编辑标签）统一在 handleInput 处理。
 */
class TreeList implements Component {
	/** 完整拍平的节点列表（未经过滤；折叠与祖先查找基于它） */
	private flatNodes: FlatNode[] = [];
	/** 过滤（模式 + 搜索 + 折叠）后实际可见的节点列表 */
	private filteredNodes: FlatNode[] = [];
	/** 光标在 filteredNodes 中的下标 */
	private selectedIndex = 0;
	/** 当前活跃分支的叶子 entry id（用于定位与标记活跃路径） */
	private currentLeafId: string | null;
	/** 视口内最多渲染的行数（滚动窗口高度） */
	private maxVisibleLines: number;
	/** 当前过滤模式 */
	private filterMode: FilterMode = "default";
	/** 增量搜索关键词（按空白拆 token，节点文本须全部命中） */
	private searchQuery = "";
	/** toolCallId → 工具名/参数 映射，flattenTree 时从 assistant 消息收集 */
	private toolCallMap: Map<string, ToolCallInfo> = new Map();
	/** 是否存在多个根节点（视为虚拟根节点分叉） */
	private multipleRoots = false;
	/** 是否在标签旁显示时间戳 */
	private showLabelTimestamps = false;
	/** 活跃路径：从根到当前叶子的全部 entry id 集合 */
	private activePathIds: Set<string> = new Set();
	/** 可见树结构：节点 id → 最近可见祖先 id（null = 根层级） */
	private visibleParentMap: Map<string, string | null> = new Map();
	/** 可见树结构：父节点 id（null = 根层级）→ 可见子节点 id 列表 */
	private visibleChildrenMap: Map<string | null, string[]> = new Map();
	/** 上一次有效选中的 entry id（切换过滤后用于恢复光标位置） */
	private lastSelectedId: string | null = null;
	/** 已折叠节点的 entry id 集合（其子孙从可见列表中剔除） */
	private foldedNodes: Set<string> = new Set();

	// 选中/取消/复制/编辑标签的回调，由宿主（TreeSelectorComponent）注入
	/** 按下确认键：携带选中条目 id */
	public onSelect?: (entryId: string) => void;
	/** 按下取消键且无搜索词时触发 */
	public onCancel?: () => void;
	/** 复制当前选中条目（无正文时收到 undefined） */
	public onCopy?: (text: string | undefined) => void;
	/** 请求编辑某条目的标签（携带当前标签值） */
	public onLabelEdit?: (entryId: string, currentLabel: string | undefined) => void;

	/**
	 * @param tree - 会话树的根节点数组（可能因分叉存在多个根）
	 * @param currentLeafId - 当前活跃分支的叶子 entry id
	 * @param maxVisibleLines - 视口最多渲染的行数
	 * @param initialSelectedId - 初始选中的 entry id（缺省用当前叶子）
	 * @param initialFilterMode - 初始过滤模式（缺省 default）
	 */
	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		maxVisibleLines: number,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		// ===== 初始化：拍平树 → 标记活跃路径 → 应用过滤 =====
		this.currentLeafId = currentLeafId;
		this.maxVisibleLines = maxVisibleLines;
		this.filterMode = initialFilterMode ?? "default";
		this.multipleRoots = tree.length > 1;
		this.flatNodes = this.flattenTree(tree);
		this.buildActivePath();
		this.applyFilter();

		// 初始选中：优先 initialSelectedId，否则落在当前叶子
		const targetId = initialSelectedId ?? currentLeafId;
		this.selectedIndex = this.findNearestVisibleIndex(targetId);
		this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? null;
	}

	/**
	 * 查找距离指定条目最近的可见条目下标：必要时沿父链向上回溯。
	 *
	 * 使用场景：目标条目被过滤/折叠隐藏时（例如切换过滤模式后原选中节点
	 * 不可见），退而求其最近的可见祖先，避免光标丢失。
	 *
	 * @param entryId - 起始条目 id（可为 null）
	 * @returns filteredNodes 中的下标；无可见祖先时回退到最后一个可见条目
	 */
	private findNearestVisibleIndex(entryId: string | null): number {
		// 空列表时只能返回 0，避免越界
		if (this.filteredNodes.length === 0) return 0;

		// 构建 id → 节点 的映射，用于向上查父节点
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// 构建 可见条目 id → filteredNodes 下标 的映射
		const visibleIdToIndex = new Map<string, number>(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));

		// 从 entryId 沿父链向根回溯，找到第一个可见条目即返回
		let currentId = entryId;
		while (currentId !== null) {
			const index = visibleIdToIndex.get(currentId);
			if (index !== undefined) return index;
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}

		// 兜底：回到最后一个可见条目
		return this.filteredNodes.length - 1;
	}

	/**
	 * 构建活跃路径集合：从根到当前叶子的全部 entry id。
	 * 渲染时这些节点会带 • 前缀标记，让当前分支一目了然。
	 */
	private buildActivePath(): void {
		this.activePathIds.clear();
		if (!this.currentLeafId) return;

		// 构建 id → 节点 的映射，用于向上查父节点
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// 从叶子向根逐级回溯，把沿途 id 全部加入集合
		let currentId: string | null = this.currentLeafId;
		while (currentId) {
			this.activePathIds.add(currentId);
			const node = entryMap.get(currentId);
			if (!node) break;
			currentId = node.node.entry.parentId ?? null;
		}
	}

	/**
	 * 把树深度优先拍平为 FlatNode 列表（列表顺序即渲染顺序）。
	 *
	 * 拍平时同步完成三件事：
	 * 1. 收集 assistant 消息中的工具调用，建立 toolCallMap；
	 * 2. 让包含当前叶子的子树排在兄弟节点之前（当前分支优先）；
	 * 3. 按分叉情况计算每行的缩进、连接符与祖先装饰线。
	 */
	private flattenTree(roots: SessionTreeNode[]): FlatNode[] {
		const result: FlatNode[] = [];
		this.toolCallMap.clear();

		// 缩进规则：
		// - indent 0：保持 0，除非父节点有多个子节点（此时 +1）
		// - indent 1：子节点一律到 indent 2（视觉上把子树分组）
		// - indent 2+：单子链保持平铺，仅当父节点分叉时 +1

		// 栈元素：[节点, 缩进, 是否刚发生分叉, 是否显示连接符, 是否末位兄弟, 装饰线数组, 是否虚拟根子节点]
		type StackItem = [SessionTreeNode, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// ===== 预计算：哪些子树包含活跃叶子（用于当前分支优先排序） =====
		// 用迭代版后序遍历代替递归，避免深树时调用栈溢出
		const containsActive = new Map<SessionTreeNode, boolean>();
		const leafId = this.currentLeafId;
		{
			// 先做前序遍历收集全部节点，再倒序处理以得到后序效果
			const allNodes: SessionTreeNode[] = [];
			const preOrderStack: SessionTreeNode[] = [...roots];
			while (preOrderStack.length > 0) {
				const node = preOrderStack.pop()!;
				allNodes.push(node);
				// 子节点逆序入栈，出栈时即为从左到右
				for (let i = node.children.length - 1; i >= 0; i--) {
					preOrderStack.push(node.children[i]);
				}
			}
			// 倒序处理（后序）：先算子节点，父节点才能汇总子树结果
			for (let i = allNodes.length - 1; i >= 0; i--) {
				const node = allNodes[i];
				let has = leafId !== null && node.entry.id === leafId;
				for (const child of node.children) {
					if (containsActive.get(child)) {
						has = true;
					}
				}
				containsActive.set(node, has);
			}
		}

		// ===== 根节点入栈 =====
		// 逆序入栈；含活跃叶子的根排到最前（当前分支优先）
		// 多根时视为「虚拟根节点」分叉后的多个子节点，整体缩进 +1
		const multipleRoots = roots.length > 1;
		const orderedRoots = [...roots].sort((a, b) => Number(containsActive.get(b)) - Number(containsActive.get(a)));
		for (let i = orderedRoots.length - 1; i >= 0; i--) {
			const isLast = i === orderedRoots.length - 1;
			stack.push([orderedRoots[i], multipleRoots ? 1 : 0, multipleRoots, multipleRoots, isLast, [], multipleRoots]);
		}

		// ===== 主循环：出栈即输出一行；子节点逆序入栈保证正序输出 =====
		while (stack.length > 0) {
			const [node, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			// 从 assistant 消息中提取工具调用，供后续 toolResult 行反查
			const entry = node.entry;
			if (entry.type === "message" && entry.message.role === "assistant") {
				const content = (entry.message as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const block of content) {
						if (typeof block === "object" && block !== null && "type" in block && block.type === "toolCall") {
							const tc = block as { id: string; name: string; arguments: Record<string, unknown> };
							this.toolCallMap.set(tc.id, { name: tc.name, arguments: tc.arguments });
						}
					}
				}
			}

			result.push({ node, indent, showConnector, isLast, gutters, isVirtualRootChild });

			const children = node.children;
			const multipleChildren = children.length > 1;

			// 子节点排序：含活跃叶子的分支排在前，其余保持原序
			const orderedChildren = (() => {
				const prioritized: SessionTreeNode[] = [];
				const rest: SessionTreeNode[] = [];
				for (const child of children) {
					if (containsActive.get(child)) {
						prioritized.push(child);
					} else {
						rest.push(child);
					}
				}
				return [...prioritized, ...rest];
			})();

			// 计算子节点缩进
			let childIndent: number;
			if (multipleChildren) {
				// 父节点分叉：子节点 +1
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				// 分叉后的第一代：+1 以形成视觉分组
				childIndent = indent + 1;
			} else {
				// 单子链：保持平铺不右移
				childIndent = indent;
			}

			// 为子节点构建装饰线数组
			// 若本节点显示了连接符，则为其后代增加一条装饰线记录
			// 仅当连接符实际显示时才加（虚拟根子节点的连接符被抑制，不加）
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			// 连接符显示时，在连接符所在位置加一条装饰线
			// 连接符位于 (displayIndent - 1)，装饰线位置与其对齐
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			// 子节点逆序入栈（配合栈的后进先出，实现正序输出）
			for (let i = orderedChildren.length - 1; i >= 0; i--) {
				const childIsLast = i === orderedChildren.length - 1;
				stack.push([
					orderedChildren[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		return result;
	}

	/**
	 * 重新计算可见节点列表（过滤核心）。
	 *
	 * 过滤管线：记录上次选中 → 按模式过滤 → 搜索过滤 → 剔除折叠节点的后代
	 * → 重算可视结构 → 尽量把光标恢复到原选中节点（或其最近可见祖先）。
	 */
	private applyFilter(): void {
		// 仅在当前有有效选中（列表非空）时更新 lastSelectedId
		// 这样切换到空过滤结果再切回时，原选中位置得以保留
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}

		// 搜索词按空白拆分为多个 token（全部小写化），节点文本须全部命中
		const searchTokens = this.searchQuery.toLowerCase().split(/\s+/).filter(Boolean);

		// ===== 模式 + 搜索过滤 =====
		this.filteredNodes = this.flatNodes.filter((flatNode) => {
			const entry = flatNode.node.entry;
			const isCurrentLeaf = entry.id === this.currentLeafId;

			// 跳过只含工具调用（无正文）的 assistant 消息，错误/中止的除外
			// 当前叶子始终显示，保证活跃位置可见
			if (entry.type === "message" && entry.message.role === "assistant" && !isCurrentLeaf) {
				const msg = entry.message as { stopReason?: string; content?: unknown };
				const hasText = this.hasTextContent(msg.content);
				// stopReason 非 stop/toolUse 即视为出错或被中止
				const isErrorOrAborted = msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== "toolUse";
				// 仅当既无正文、又非错误/中止消息时才隐藏
				if (!hasText && !isErrorOrAborted) {
					return false;
				}
			}

			// 应用过滤模式
			let passesFilter = true;
			// 默认视图下隐藏的条目类型（设置/簿记类）
			const isSettingsEntry =
				entry.type === "label" ||
				entry.type === "custom" ||
				entry.type === "model_change" ||
				entry.type === "thinking_level_change" ||
				entry.type === "session_info";

			switch (this.filterMode) {
				case "user-only":
					// 只显示用户消息
					passesFilter = entry.type === "message" && entry.message.role === "user";
					break;
				case "no-tools":
					// 默认视图再减去工具结果
					passesFilter = !isSettingsEntry && !(entry.type === "message" && entry.message.role === "toolResult");
					break;
				case "labeled-only":
					// 只显示打了标签的条目
					passesFilter = flatNode.node.label !== undefined;
					break;
				case "all":
					// 全部显示
					passesFilter = true;
					break;
				default:
					// 默认模式：隐藏设置/簿记类条目
					passesFilter = !isSettingsEntry;
					break;
			}

			if (!passesFilter) return false;

			// 应用搜索过滤：所有 token 都命中才保留
			if (searchTokens.length > 0) {
				const nodeText = this.getSearchableText(flatNode.node).toLowerCase();
				return searchTokens.every((token) => nodeText.includes(token));
			}

			return true;
		});

		// ===== 折叠过滤：剔除已折叠节点的全部后代 =====
		if (this.foldedNodes.size > 0) {
			// flatNodes 是 DFS 正序，父节点必先于子节点出现，
			// 因此一次顺序扫描即可把「折叠节点的后代的后代」也级联加入 skipSet
			const skipSet = new Set<string>();
			for (const flatNode of this.flatNodes) {
				const { id, parentId } = flatNode.node.entry;
				if (parentId != null && (this.foldedNodes.has(parentId) || skipSet.has(parentId))) {
					skipSet.add(id);
				}
			}
			this.filteredNodes = this.filteredNodes.filter((flatNode) => !skipSet.has(flatNode.node.entry.id));
		}

		// 基于过滤后的可见树重算可视结构（缩进、连接符、装饰线）
		this.recalculateVisualStructure();

		// 尽量把光标留在同一节点上，否则找最近的可见祖先
		if (this.lastSelectedId) {
			this.selectedIndex = this.findNearestVisibleIndex(this.lastSelectedId);
		} else if (this.selectedIndex >= this.filteredNodes.length) {
			// 越界时钳制到最后一个可见条目
			this.selectedIndex = Math.max(0, this.filteredNodes.length - 1);
		}

		// 用实际选中结果回写 lastSelectedId（回溯父链后可能已变化）
		if (this.filteredNodes.length > 0) {
			this.lastSelectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id ?? this.lastSelectedId;
		}
	}

	/**
	 * 为过滤后的视图重算缩进与连接符等可视结构。
	 *
	 * 过滤可能隐藏中间层条目；此时后代条目会「挂靠」到最近的可见祖先上。
	 * 缩进语义与 flattenTree() 保持一致，避免单子链不断向右漂移。
	 */
	private recalculateVisualStructure(): void {
		if (this.filteredNodes.length === 0) return;

		const visibleIds = new Set(this.filteredNodes.map((n) => n.node.entry.id));

		// 基于「完整树」构建 id → 节点 映射，保证父链查找不受过滤影响
		const entryMap = new Map<string, FlatNode>();
		for (const flatNode of this.flatNodes) {
			entryMap.set(flatNode.node.entry.id, flatNode);
		}

		// 沿真实父链向上找最近可见祖先
		const findVisibleAncestor = (nodeId: string): string | null => {
			let currentId = entryMap.get(nodeId)?.node.entry.parentId ?? null;
			while (currentId !== null) {
				if (visibleIds.has(currentId)) {
					return currentId;
				}
				currentId = entryMap.get(currentId)?.node.entry.parentId ?? null;
			}
			return null;
		};

		// 构建可见树结构（两张表）：
		// - visibleParent：nodeId → 最近可见祖先（根层级为 null）
		// - visibleChildren：父 id → 可见子节点列表（保持 filteredNodes 顺序）
		const visibleParent = new Map<string, string | null>();
		const visibleChildren = new Map<string | null, string[]>();
		visibleChildren.set(null, []); // 根层级节点列表（key 为 null）

		for (const flatNode of this.filteredNodes) {
			const nodeId = flatNode.node.entry.id;
			const ancestorId = findVisibleAncestor(nodeId);
			visibleParent.set(nodeId, ancestorId);

			if (!visibleChildren.has(ancestorId)) {
				visibleChildren.set(ancestorId, []);
			}
			visibleChildren.get(ancestorId)!.push(nodeId);
		}

		// 依据可见根节点数量更新 multipleRoots（过滤后可能只剩一个根）
		const visibleRootIds = visibleChildren.get(null)!;
		this.multipleRoots = visibleRootIds.length > 1;

		// 构建 nodeId → FlatNode 的快速查找映射
		const filteredNodeMap = new Map<string, FlatNode>();
		for (const flatNode of this.filteredNodes) {
			filteredNodeMap.set(flatNode.node.entry.id, flatNode);
		}

		// 以 flattenTree() 的缩进语义对可见树做 DFS
		// 栈元素：[节点id, 缩进, 是否刚分叉, 是否显示连接符, 是否末位兄弟, 装饰线数组, 是否虚拟根子节点]
		type StackItem = [string, number, boolean, boolean, boolean, GutterInfo[], boolean];
		const stack: StackItem[] = [];

		// 可见根节点逆序入栈（配合栈的后进先出，实现正序处理）
		for (let i = visibleRootIds.length - 1; i >= 0; i--) {
			const isLast = i === visibleRootIds.length - 1;
			stack.push([
				visibleRootIds[i],
				this.multipleRoots ? 1 : 0,
				this.multipleRoots,
				this.multipleRoots,
				isLast,
				[],
				this.multipleRoots,
			]);
		}

		while (stack.length > 0) {
			const [nodeId, indent, justBranched, showConnector, isLast, gutters, isVirtualRootChild] = stack.pop()!;

			const flatNode = filteredNodeMap.get(nodeId);
			if (!flatNode) continue;

			// 直接回写该节点的可视属性
			flatNode.indent = indent;
			flatNode.showConnector = showConnector;
			flatNode.isLast = isLast;
			flatNode.gutters = gutters;
			flatNode.isVirtualRootChild = isVirtualRootChild;

			// 取该节点在可见树中的子节点
			const children = visibleChildren.get(nodeId) || [];
			const multipleChildren = children.length > 1;

			// 子节点缩进沿用 flattenTree() 规则：分叉点（及分叉后第一代）+1
			let childIndent: number;
			if (multipleChildren) {
				childIndent = indent + 1;
			} else if (justBranched && indent > 0) {
				childIndent = indent + 1;
			} else {
				childIndent = indent;
			}

			// 子节点装饰线沿用 flattenTree() 的连接符/装饰线规则
			const connectorDisplayed = showConnector && !isVirtualRootChild;
			const currentDisplayIndent = this.multipleRoots ? Math.max(0, indent - 1) : indent;
			const connectorPosition = Math.max(0, currentDisplayIndent - 1);
			const childGutters: GutterInfo[] = connectorDisplayed
				? [...gutters, { position: connectorPosition, show: !isLast }]
				: gutters;

			// 子节点逆序入栈（配合栈的后进先出，实现正序处理）
			for (let i = children.length - 1; i >= 0; i--) {
				const childIsLast = i === children.length - 1;
				stack.push([
					children[i],
					childIndent,
					multipleChildren,
					multipleChildren,
					childIsLast,
					childGutters,
					false,
				]);
			}
		}

		// 保存可见树两张表，供导航（折叠判断、分支跳转）做祖先/后代查找
		this.visibleParentMap = visibleParent;
		this.visibleChildrenMap = visibleChildren;
	}

	/**
	 * 汇总节点的可搜索文本：标签 + 各类条目的角色/关键字段。
	 * 搜索匹配即针对该拼接结果（小写化后）进行。
	 */
	private getSearchableText(node: SessionTreeNode): string {
		const entry = node.entry;
		const parts: string[] = [];

		// 标签优先参与匹配
		if (node.label) {
			parts.push(node.label);
		}

		// 按条目类型提取各自的关键可搜索字段
		switch (entry.type) {
			case "message": {
				// 角色名 + 正文；bash 执行额外匹配命令本身
				const msg = entry.message;
				parts.push(msg.role);
				if ("content" in msg && msg.content) {
					parts.push(this.extractContent(msg.content));
				}
				if (msg.role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					if (bashMsg.command) parts.push(bashMsg.command);
				}
				break;
			}
			case "custom_message": {
				parts.push(entry.customType);
				if (typeof entry.content === "string") {
					parts.push(entry.content);
				} else {
					parts.push(this.extractContent(entry.content));
				}
				break;
			}
			case "compaction":
				parts.push("compaction");
				break;
			case "branch_summary":
				parts.push("branch summary", entry.summary);
				break;
			case "session_info":
				parts.push("title");
				if (entry.name) parts.push(entry.name);
				break;
			case "model_change":
				parts.push("model", entry.modelId);
				break;
			case "thinking_level_change":
				parts.push("thinking", entry.thinkingLevel);
				break;
			case "custom":
				parts.push("custom", entry.customType);
				break;
			case "label":
				parts.push("label", entry.label ?? "");
				break;
		}

		return parts.join(" ");
	}

	/** Component 接口：本组件不做缓存，无需失效处理 */
	invalidate(): void {}

	/** 读取当前搜索关键词（SearchLine 展示用） */
	getSearchQuery(): string {
		return this.searchQuery;
	}

	/** 获取当前光标选中的树节点（空列表时为 undefined） */
	getSelectedNode(): SessionTreeNode | undefined {
		return this.filteredNodes[this.selectedIndex]?.node;
	}

	/** 复制当前选中条目的正文（无正文时回调收到 undefined） */
	copySelected(): void {
		const node = this.getSelectedNode();
		this.onCopy?.(node ? this.getEntryCopyText(node) : undefined);
	}

	/**
	 * 更新某节点的标签（就地修改 flatNodes 中的节点数据）。
	 * 清空标签（label 为 undefined）时同时清掉时间戳；
	 * 打标签时未显式传入时间戳则默认取当前时间。
	 */
	updateNodeLabel(entryId: string, label: string | undefined, labelTimestamp?: string): void {
		for (const flatNode of this.flatNodes) {
			if (flatNode.node.entry.id === entryId) {
				flatNode.node.label = label;
				flatNode.node.labelTimestamp = label ? (labelTimestamp ?? new Date().toISOString()) : undefined;
				break;
			}
		}
	}

	/** 组装状态栏后缀：当前过滤模式标记 + 是否显示标签时间戳 */
	private getStatusLabels(): string {
		let labels = "";
		switch (this.filterMode) {
			case "no-tools":
				labels += " [no-tools]";
				break;
			case "user-only":
				labels += " [user]";
				break;
			case "labeled-only":
				labels += " [labeled]";
				break;
			case "all":
				labels += " [all]";
				break;
		}
		if (this.showLabelTimestamps) {
			labels += " [+label time]";
		}
		return labels;
	}

	/**
	 * 渲染组件：滚动窗口内的树行 + 底部状态栏（位置/过滤模式）。
	 *
	 * @param width - 可用宽度（列）
	 * @returns 渲染好的行数组（每行一个字符串）
	 */
	render(width: number): string[] {
		const lines: string[] = [];

		// 空结果兜底：提示无匹配条目
		if (this.filteredNodes.length === 0) {
			lines.push(truncateToWidth(theme.fg("muted", "  No entries found"), width));
			lines.push(truncateToWidth(theme.fg("muted", `  (0/0)${this.getStatusLabels()}`), width));
			return lines;
		}

		// ===== 滚动窗口：让选中行尽量居中 =====
		const startIndex = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(this.maxVisibleLines / 2),
				this.filteredNodes.length - this.maxVisibleLines,
			),
		);
		const endIndex = Math.min(startIndex + this.maxVisibleLines, this.filteredNodes.length);

		// ===== 逐行构建渲染数据 =====
		const renderedRows: HorizontalViewportRow[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const flatNode = this.filteredNodes[i];
			const entry = flatNode.node.entry;
			const isSelected = i === this.selectedIndex;

			// 行构成：光标 + 树形前缀 + 活跃路径标记 + 标签 + 正文
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// 多根时显示整体左移一级（根从 0 开始而非 1）
			const displayIndent = this.multipleRoots ? Math.max(0, flatNode.indent - 1) : flatNode.indent;

			// 构建前缀：装饰线放在各自正确的位置上
			// 每条装饰线记录了自己（连接符）所在的 displayIndent 层级
			const connector =
				flatNode.showConnector && !flatNode.isVirtualRootChild ? (flatNode.isLast ? "└─ " : "├─ ") : "";
			const connectorPosition = connector ? displayIndent - 1 : -1;

			// 逐字符构建前缀，把装饰线与连接符放到对应位置
			// 每个缩进层级占 3 个字符
			const totalChars = displayIndent * 3;
			const prefixChars: string[] = [];
			const isFolded = this.foldedNodes.has(entry.id);
			for (let i = 0; i < totalChars; i++) {
				const level = Math.floor(i / 3);
				const posInLevel = i % 3;

				// 该层级是否有装饰线
				const gutter = flatNode.gutters.find((g) => g.position === level);
				if (gutter) {
					if (posInLevel === 0) {
						prefixChars.push(gutter.show ? "│" : " ");
					} else {
						prefixChars.push(" ");
					}
				} else if (connector && level === connectorPosition) {
					// 连接符所在层级：第二格兼作折叠指示（⊞ 已折叠 / ⊟ 可折叠 / ─ 不可折叠）
					if (posInLevel === 0) {
						prefixChars.push(flatNode.isLast ? "└" : "├");
					} else if (posInLevel === 1) {
						const foldable = this.isFoldable(entry.id);
						prefixChars.push(isFolded ? "⊞" : foldable ? "⊟" : "─");
					} else {
						prefixChars.push(" ");
					}
				} else {
					prefixChars.push(" ");
				}
			}
			const prefix = prefixChars.join("");

			// 无连接符节点（根节点）的折叠标记：直接放在前缀之后
			const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
			const foldMarker = isFolded && !showsFoldInConnector ? theme.fg("accent", "⊞ ") : "";

			// 活跃路径标记 —— 紧贴在条目正文之前显示
			const isOnActivePath = this.activePathIds.has(entry.id);
			const pathMarker = isOnActivePath ? theme.fg("accent", "• ") : "";

			const label = flatNode.node.label ? theme.fg("warning", `[${flatNode.node.label}] `) : "";
			const labelTimestamp =
				this.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
					? theme.fg("muted", `${this.formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
					: "";
			const content = this.getEntryDisplayText(flatNode.node, isSelected);
			// 锚点 = 水平平移的参照：正文之前的所有可见部分
			const prefixPart = theme.fg("dim", prefix) + foldMarker + pathMarker;
			const anchorCol = visibleWidth(prefixPart);
			let gutter = cursor;
			let body = prefixPart + label + labelTimestamp + content;
			// 选中行整行加高亮背景
			if (isSelected) {
				gutter = theme.bg("selectedBg", gutter);
				body = theme.bg("selectedBg", body);
			}
			renderedRows.push({ gutter, body, anchorCol, bodyWidth: visibleWidth(body), isSelected });
		}

		// 交给水平视口裁剪，并附加底部状态栏
		lines.push(...renderHorizontalViewport(renderedRows, width));
		lines.push(
			truncateToWidth(
				theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredNodes.length})${this.getStatusLabels()}`),
				width,
			),
		);

		return lines;
	}

	/**
	 * 获取条目在树中显示的正文文本（含主题配色，按条目类型分派）。
	 * 选中时整体加粗。
	 */
	private getEntryDisplayText(node: SessionTreeNode, isSelected: boolean): string {
		const entry = node.entry;
		let result: string;

		// 单行展示：把换行/制表符压成空格并去掉首尾空白
		const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				const role = msg.role;
				if (role === "user") {
					const msgWithContent = msg as { content?: unknown };
					const content = normalize(this.extractContent(msgWithContent.content));
					result = theme.fg("accent", "user: ") + content;
				} else if (role === "assistant") {
					// assistant：优先显示正文，否则依次退到中止/错误占位（错误截断到 80 字符）
					const msgWithContent = msg as { content?: unknown; stopReason?: string; errorMessage?: string };
					const textContent = normalize(this.extractContent(msgWithContent.content));
					if (textContent) {
						result = theme.fg("success", "assistant: ") + textContent;
					} else if (msgWithContent.stopReason === "aborted") {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(aborted)");
					} else if (msgWithContent.errorMessage) {
						const errMsg = normalize(msgWithContent.errorMessage).slice(0, 80);
						result = theme.fg("success", "assistant: ") + theme.fg("error", errMsg);
					} else {
						result = theme.fg("success", "assistant: ") + theme.fg("muted", "(no content)");
					}
				} else if (role === "toolResult") {
					// 用 toolCallId 反查工具名与参数，格式化为可读摘要
					const toolMsg = msg as { toolCallId?: string; toolName?: string };
					const toolCall = toolMsg.toolCallId ? this.toolCallMap.get(toolMsg.toolCallId) : undefined;
					if (toolCall) {
						result = theme.fg("muted", this.formatToolCall(toolCall.name, toolCall.arguments));
					} else {
						result = theme.fg("muted", `[${toolMsg.toolName ?? "tool"}]`);
					}
				} else if (role === "bashExecution") {
					const bashMsg = msg as { command?: string };
					result = theme.fg("dim", `[bash]: ${normalize(bashMsg.command ?? "")}`);
				} else {
					result = theme.fg("dim", `[${role}]`);
				}
				break;
			}
			case "custom_message": {
				const content =
					typeof entry.content === "string"
						? entry.content
						: entry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
				result = theme.fg("customMessageLabel", `[${entry.customType}]: `) + normalize(content);
				break;
			}
			case "compaction": {
				const tokens = Math.round(entry.tokensBefore / 1000);
				result = theme.fg("borderAccent", `[compaction: ${tokens}k tokens]`);
				break;
			}
			case "branch_summary":
				result = theme.fg("warning", `[branch summary]: `) + normalize(entry.summary);
				break;
			case "model_change":
				result = theme.fg("dim", `[model: ${entry.modelId}]`);
				break;
			case "thinking_level_change":
				result = theme.fg("dim", `[thinking: ${entry.thinkingLevel}]`);
				break;
			case "custom":
				result = theme.fg("dim", `[custom: ${entry.customType}]`);
				break;
			case "label":
				result = theme.fg("dim", `[label: ${entry.label ?? "(cleared)"}]`);
				break;
			case "session_info":
				result = entry.name
					? [theme.fg("dim", "[title: "), theme.fg("dim", entry.name), theme.fg("dim", "]")].join("")
					: [theme.fg("dim", "[title: "), theme.italic(theme.fg("dim", "empty")), theme.fg("dim", "]")].join("");
				break;
			default:
				result = "";
		}

		return isSelected ? theme.bold(result) : result;
	}

	/**
	 * 把标签时间戳格式化为紧凑显示（越近越短，逐年丢弃精度）：
	 * 今天 → HH:mm；今年 → M/D HH:mm；更早 → YY/M/D HH:mm。
	 */
	private formatLabelTimestamp(timestamp: string): string {
		const date = new Date(timestamp);
		const now = new Date();
		const hours = date.getHours().toString().padStart(2, "0");
		const minutes = date.getMinutes().toString().padStart(2, "0");
		const time = `${hours}:${minutes}`;

		// 同一天：只显示时刻
		if (
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate()
		) {
			return time;
		}

		const month = date.getMonth() + 1;
		const day = date.getDate();
		// 同年：补上月/日
		if (date.getFullYear() === now.getFullYear()) {
			return `${month}/${day} ${time}`;
		}

		// 跨年：再补两位年份（取年份后两位）
		const year = date.getFullYear().toString().slice(-2);
		return `${year}/${month}/${day} ${time}`;
	}

	/** 提取正文用于「显示」：截断到 200 字符，避免长文本撑爆一行 */
	private extractContent(content: unknown): string {
		return this.extractFullContent(content).slice(0, 200);
	}

	/**
	 * 提取完整正文：字符串原样返回；内容块数组则只拼接 text 块
	 * （工具调用等其他块不参与），供搜索与复制使用。
	 */
	private extractFullContent(content: unknown): string {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";

		let result = "";
		for (const block of content) {
			if (typeof block === "object" && block !== null && "type" in block && block.type === "text") {
				result += (block as { text: string }).text;
			}
		}
		return result;
	}

	/**
	 * 获取条目的「复制用」文本：取完整正文而非截断版本。
	 * 仅对有实际内容的条目类型生效，空文本返回 undefined。
	 */
	private getEntryCopyText(node: SessionTreeNode): string | undefined {
		const entry = node.entry;
		let text: string | undefined;

		switch (entry.type) {
			case "message":
				if (entry.message.role === "bashExecution") {
					// bash 执行：直接复制命令本身
					text = entry.message.command;
				} else if ("content" in entry.message) {
					text = this.extractFullContent(entry.message.content);
					// assistant 无正文时退而复制错误信息
					if (!text && entry.message.role === "assistant") {
						text = entry.message.errorMessage;
					}
				}
				break;
			case "custom_message":
				text = this.extractFullContent(entry.content);
				break;
			case "compaction":
				text = entry.summary;
				break;
			case "branch_summary":
				text = entry.summary;
				break;
		}

		return text?.trim() ? text : undefined;
	}

	/**
	 * 判断消息内容是否含有非空文本块（用于过滤纯工具调用消息）。
	 * 字符串看 trim 后长度；内容块数组只统计 text 块。
	 */
	private hasTextContent(content: unknown): boolean {
		if (typeof content === "string") return content.trim().length > 0;
		if (Array.isArray(content)) {
			for (const c of content) {
				if (typeof c === "object" && c !== null && "type" in c && c.type === "text") {
					const text = (c as { text?: string }).text;
					if (text && text.trim().length > 0) return true;
				}
			}
		}
		return false;
	}

	/**
	 * 把工具调用格式化为一行可读摘要（toolResult 行的显示文本）。
	 * 对常见内置工具做专属格式（路径用 ~ 缩写、read 带行号范围、
	 * bash 截断等），未知工具退化为截断的 JSON 参数。
	 */
	private formatToolCall(name: string, args: Record<string, unknown>): string {
		// 家目录前缀替换为 ~，让路径更短
		const shortenPath = (p: string): string => {
			const home = process.env.HOME || process.env.USERPROFILE || "";
			if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
			return p;
		};

		switch (name) {
			case "read": {
				// read：路径:起始行[-结束行]（未给 offset 时默认从第 1 行起）
				const path = shortenPath(String(args.path || args.file_path || ""));
				const offset = args.offset as number | undefined;
				const limit = args.limit as number | undefined;
				let display = path;
				if (offset !== undefined || limit !== undefined) {
					const start = offset ?? 1;
					const end = limit !== undefined ? start + limit - 1 : "";
					display += `:${start}${end ? `-${end}` : ""}`;
				}
				return `[read: ${display}]`;
			}
			case "write": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[write: ${path}]`;
			}
			case "edit": {
				const path = shortenPath(String(args.path || args.file_path || ""));
				return `[edit: ${path}]`;
			}
			case "bash": {
				// bash：压缩空白并截断到 50 字符，超长补省略号
				const rawCmd = String(args.command || "");
				const cmd = rawCmd
					.replace(/[\n\t]/g, " ")
					.trim()
					.slice(0, 50);
				return `[bash: ${cmd}${rawCmd.length > 50 ? "..." : ""}]`;
			}
			case "grep": {
				const pattern = String(args.pattern || "");
				const path = shortenPath(String(args.path || "."));
				return `[grep: /${pattern}/ in ${path}]`;
			}
			case "find": {
				const pattern = String(args.pattern || "");
				const path = shortenPath(String(args.path || "."));
				return `[find: ${pattern} in ${path}]`;
			}
			case "ls": {
				const path = shortenPath(String(args.path || "."));
				return `[ls: ${path}]`;
			}
			default: {
				// 自定义工具：显示工具名 + 截断到 40 字符的 JSON 参数
				const argsStr = JSON.stringify(args).slice(0, 40);
				return `[${name}: ${argsStr}${JSON.stringify(args).length > 40 ? "..." : ""}]`;
			}
		}
	}

	/**
	 * 键盘输入统一入口：按 keybinding 语义分发到移动/翻页/折叠/
	 * 过滤/搜索/确认/复制/标签编辑等操作。
	 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// ===== 上下移动（首尾循环滚动） =====
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredNodes.length - 1 : this.selectedIndex - 1;
		} else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.filteredNodes.length - 1 ? 0 : this.selectedIndex + 1;
		} else if (kb.matches(keyData, "app.tree.foldOrUp")) {
			// 折叠/上移：可折叠且未折叠 → 折叠该子树；否则跳到上一个分叉段起点
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.isFoldable(currentId) && !this.foldedNodes.has(currentId)) {
				this.foldedNodes.add(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("up");
			}
		} else if (kb.matches(keyData, "app.tree.unfoldOrDown")) {
			// 展开/下移：已折叠 → 展开该子树；否则跳到下一个分叉段起点
			const currentId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
			if (currentId && this.foldedNodes.has(currentId)) {
				this.foldedNodes.delete(currentId);
				this.applyFilter();
			} else {
				this.selectedIndex = this.findBranchSegmentStart("down");
			}
		} else if (kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.select.pageUp")) {
			// 翻页：上移一屏（到顶不循环）
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.editor.cursorRight") || kb.matches(keyData, "tui.select.pageDown")) {
			// 翻页：下移一屏（到底不循环）
			this.selectedIndex = Math.min(this.filteredNodes.length - 1, this.selectedIndex + this.maxVisibleLines);
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			// 确认：回调 onSelect 并携带选中条目 id（宿主据此切换分支）
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.node.entry.id);
			}
		} else if (kb.matches(keyData, "app.message.copy")) {
			// 复制当前选中条目
			this.copySelected();
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			// 取消：有搜索词时先清空搜索与折叠再过滤，再按一次才真正退出
			if (this.searchQuery) {
				this.searchQuery = "";
				this.foldedNodes.clear();
				this.applyFilter();
			} else {
				this.onCancel?.();
			}
		} else if (kb.matches(keyData, "app.tree.filter.default")) {
			// 直接切换：default 模式
			this.filterMode = "default";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.noTools")) {
			// 切换过滤：no-tools ↔ default
			this.filterMode = this.filterMode === "no-tools" ? "default" : "no-tools";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.userOnly")) {
			// 切换过滤：user-only ↔ default
			this.filterMode = this.filterMode === "user-only" ? "default" : "user-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.labeledOnly")) {
			// 切换过滤：labeled-only ↔ default
			this.filterMode = this.filterMode === "labeled-only" ? "default" : "labeled-only";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.all")) {
			// 切换过滤：all ↔ default
			this.filterMode = this.filterMode === "all" ? "default" : "all";
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleBackward")) {
			// 反向循环切换过滤模式
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex - 1 + modes.length) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "app.tree.filter.cycleForward")) {
			// 正向循环切换过滤模式：default → no-tools → user-only → labeled-only → all → default
			const modes: FilterMode[] = ["default", "no-tools", "user-only", "labeled-only", "all"];
			const currentIndex = modes.indexOf(this.filterMode);
			this.filterMode = modes[(currentIndex + 1) % modes.length];
			this.foldedNodes.clear();
			this.applyFilter();
		} else if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			// 退格：删除最后一个搜索字符并重新过滤
			if (this.searchQuery.length > 0) {
				this.searchQuery = this.searchQuery.slice(0, -1);
				this.foldedNodes.clear();
				this.applyFilter();
			}
		} else if (kb.matches(keyData, "app.tree.editLabel")) {
			// 编辑选中条目的标签（交由宿主弹出输入框）
			const selected = this.filteredNodes[this.selectedIndex];
			if (selected && this.onLabelEdit) {
				this.onLabelEdit(selected.node.entry.id, selected.node.label);
			}
		} else if (kb.matches(keyData, "app.tree.toggleLabelTimestamp")) {
			// 切换标签时间戳显示（纯展示开关，无需重新过滤）
			this.showLabelTimestamps = !this.showLabelTimestamps;
		} else {
			// ===== 兜底：当作增量搜索输入 =====
			// 过滤控制字符（<32 的控制码、0x7f DEL、0x80–0x9f 的 C1 控制字符），
			// 避免方向键等按键的转义序列被误拼进搜索词
			const hasControlChars = [...keyData].some((ch) => {
				const code = ch.charCodeAt(0);
				return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
			});
			if (!hasControlChars && keyData.length > 0) {
				this.searchQuery += keyData;
				this.foldedNodes.clear();
				this.applyFilter();
			}
		}
	}

	/**
	 * 判断节点能否折叠。需同时满足两个条件：
	 * 1. 该节点有可见子节点；
	 * 2. 该节点是根节点（无可见父级），或某分叉段的首节点
	 *    （即可见父级有多个可见子节点）。
	 */
	private isFoldable(entryId: string): boolean {
		// 无可见子节点：折叠无意义
		const children = this.visibleChildrenMap.get(entryId);
		if (!children || children.length === 0) return false;
		// 根节点（无可见父级）可折叠
		const parentId = this.visibleParentMap.get(entryId);
		if (parentId === null || parentId === undefined) return true;
		// 分叉段首节点可折叠：父级有多个可见子节点
		const siblings = this.visibleChildrenMap.get(parentId);
		return siblings !== undefined && siblings.length > 1;
	}

	/**
	 * 在指定方向上查找下一个「分叉段起点」的下标。
	 * 分叉段起点指分叉节点的第一个子节点。
	 *
	 * "up" 沿可见父链向上走；"down" 沿可见子节点向下走
	 * （始终跟随第一个子节点）。
	 */
	private findBranchSegmentStart(direction: "up" | "down"): number {
		const selectedId = this.filteredNodes[this.selectedIndex]?.node.entry.id;
		if (!selectedId) return this.selectedIndex;

		const indexByEntryId = new Map(this.filteredNodes.map((node, i) => [node.node.entry.id, i]));
		let currentId: string = selectedId;
		if (direction === "down") {
			// 向下：沿单子链深入，遇到分叉取第一个子节点；是叶子则停在自身
			while (true) {
				const children: string[] = this.visibleChildrenMap.get(currentId) ?? [];
				if (children.length === 0) return indexByEntryId.get(currentId)!;
				if (children.length > 1) return indexByEntryId.get(children[0])!;
				currentId = children[0];
			}
		}

		// 方向为 "up"：向上找当前所在段的段首（父级有多个子节点且自己在列表中位于其下）
		while (true) {
			const parentId: string | null = this.visibleParentMap.get(currentId) ?? null;
			if (parentId === null) return indexByEntryId.get(currentId)!;
			const children = this.visibleChildrenMap.get(parentId) ?? [];
			if (children.length > 1) {
				const segmentStart = indexByEntryId.get(currentId)!;
				if (segmentStart < this.selectedIndex) {
					return segmentStart;
				}
			}
			currentId = parentId;
		}
	}
}

/** 展示当前搜索关键词的提示行组件（有输入时实时高亮显示） */
class SearchLine implements Component {
	private treeList: TreeList;

	/** 持有 TreeList 引用以读取实时搜索词 */
	constructor(treeList: TreeList) {
		this.treeList = treeList;
	}

	/** Component 接口：无缓存，无需失效处理 */
	invalidate(): void {}

	/** 渲染 "Type to search:" 提示及（若有）当前搜索词 */
	render(width: number): string[] {
		const query = this.treeList.getSearchQuery();
		if (query) {
			return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")} ${theme.fg("accent", query)}`, width)];
		}
		return [truncateToWidth(`  ${theme.fg("muted", "Type to search:")}`, width)];
	}

	// 不接收键盘输入（焦点始终在 TreeList 上）
	handleInput(_keyData: string): void {}
}

/**
 * 渲染树选择器按键帮助的组件：把帮助项按语义块拼接，
 * 并在必要时按可见宽度换行（感知 ANSI 颜色码的换行）。
 */
class TreeHelp implements Component {
	/** Component 接口：无缓存，无需失效处理 */
	invalidate(): void {}

	render(width: number): string[] {
		// 先把每个帮助项格式化为「按键 + 说明」文本（键位未配置时仅显示说明）
		const items = TREE_HELP_ITEMS.map(({ keys, label, labelFirst }) => {
			const text = formatHelpKeys(keys);
			if (!text) return label;
			return labelFirst ? `${label} ${text}` : `${text} ${label}`;
		});

		const availableWidth = Math.max(1, width);
		const indent = "  ";
		const separator = " · ";
		const lines: string[] = [];
		let currentLine = "";

		// 贪心拼接：能放下就并入当前行，放不下就把当前行换行输出
		for (const item of items) {
			// 新起一行的首项尽量带缩进；连缩进都放不下时退化为不缩进
			const candidate = currentLine
				? `${currentLine}${separator}${item}`
				: visibleWidth(`${indent}${item}`) <= availableWidth
					? `${indent}${item}`
					: item;
			if (!currentLine || visibleWidth(candidate) <= availableWidth) {
				currentLine = candidate;
				continue;
			}

			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
			currentLine = visibleWidth(`${indent}${item}`) <= availableWidth ? `${indent}${item}` : item;
		}

		if (currentLine) {
			lines.push(...wrapTextWithAnsi(currentLine.trimEnd(), availableWidth));
		}

		return lines.map((line) => theme.fg("muted", line));
	}
}

/** 帮助项清单：动作说明 + 对应 keybinding 语义 id（labelFirst 表示说明放在按键之前） */
const TREE_HELP_ITEMS: Array<{ keys: Keybinding[]; label: string; labelFirst?: boolean }> = [
	{ keys: ["tui.select.up", "tui.select.down"], label: "move" },
	{ keys: ["tui.editor.cursorLeft", "tui.editor.cursorRight"], label: "page" },
	{ keys: ["app.tree.foldOrUp", "app.tree.unfoldOrDown"], label: "branch" },
	{ keys: ["app.message.copy"], label: "copy" },
	{ keys: ["app.tree.editLabel"], label: "label" },
	{ keys: ["app.tree.toggleLabelTimestamp"], label: "label time" },
	{
		keys: [
			"app.tree.filter.default",
			"app.tree.filter.noTools",
			"app.tree.filter.userOnly",
			"app.tree.filter.labeledOnly",
			"app.tree.filter.all",
		],
		label: "filters",
		labelFirst: true,
	},
	{ keys: ["app.tree.filter.cycleForward", "app.tree.filter.cycleBackward"], label: "cycle", labelFirst: true },
];

/**
 * 把一组 keybinding 语义 id 格式化为紧凑的按键文本：
 * 逐个取首个实际按键、合并公共修饰键前缀（compactRawKeys），
 * 再做缩写与箭头符号替换（pageUp→pgup、up→↑ 等）以缩短帮助行宽度。
 */
function formatHelpKeys(keybindings: Keybinding[]): string {
	const keys: string[] = [];
	// 逐个取 keybinding 绑定的第一个实际按键（未绑定则跳过）
	for (const keybinding of keybindings) {
		const key = getKeybindings().getKeys(keybinding)[0];
		if (key !== undefined) keys.push(key);
	}
	if (keys.length === 0) return "";

	// 文本缩写与方向键符号化，控制帮助行宽度
	return formatKeyText(compactRawKeys(keys))
		.replace(/\bpageUp\b/g, "pgup")
		.replace(/\bpageDown\b/g, "pgdn")
		.replace(/\bup\b/g, "↑")
		.replace(/\bdown\b/g, "↓")
		.replace(/\bleft\b/g, "←")
		.replace(/\bright\b/g, "→");
}

/**
 * 压缩多个按键的显示：若所有按键共享同一修饰键前缀（如都是 ctrl+），
 * 则合并为 `ctrl+a/b/c` 形式；否则退化为 `/` 直接连接。
 */
function compactRawKeys(keys: string[]): string {
	if (keys.length === 1) return keys[0]!;

	// 按最后一个 + 拆出「修饰键前缀 + 主键」
	const parts = keys.map((key) => {
		const separatorIndex = key.lastIndexOf("+");
		return separatorIndex === -1
			? { prefix: "", suffix: key }
			: { prefix: key.slice(0, separatorIndex + 1), suffix: key.slice(separatorIndex + 1) };
	});
	// 仅当所有按键前缀一致时才合并前缀
	const prefix = parts[0]!.prefix;
	return prefix && parts.every((part) => part.prefix === prefix)
		? `${prefix}${parts.map((part) => part.suffix).join("/")}`
		: keys.join("/");
}

/** 编辑标签时显示的单行输入组件（包一层 Input 以复用其编辑能力） */
class LabelInput implements Component, Focusable {
	private input: Input;
	/** 正在编辑标签的条目 id（提交时原样带回） */
	private entryId: string;
	/** 提交回调：label 为 undefined 表示清空标签 */
	public onSubmit?: (entryId: string, label: string | undefined) => void;
	public onCancel?: () => void;

	// Focusable 实现 —— 把焦点状态转发给内部 Input，用于输入法（IME）光标定位
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(entryId: string, currentLabel: string | undefined) {
		this.entryId = entryId;
		this.input = new Input();
		if (currentLabel) {
			this.input.setValue(currentLabel);
		}
	}

	/** Component 接口：无缓存，无需失效处理 */
	invalidate(): void {}

	/** 渲染提示语、输入框与保存/取消键提示三段 */
	render(width: number): string[] {
		const lines: string[] = [];
		const indent = "  ";
		const availableWidth = width - indent.length;
		lines.push(truncateToWidth(`${indent}${theme.fg("muted", "Label (empty to remove):")}`, width));
		lines.push(...this.input.render(availableWidth).map((line) => truncateToWidth(`${indent}${line}`, width)));
		lines.push(
			truncateToWidth(
				`${indent}${keyHint("tui.select.confirm", "save")}  ${keyHint("tui.select.cancel", "cancel")}`,
				width,
			),
		);
		return lines;
	}

	/** 键盘输入：确认提交（空值转为 undefined 即清除标签）、取消退出，其余交给内部输入框 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			const value = this.input.getValue().trim();
			this.onSubmit?.(this.entryId, value || undefined);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel?.();
		} else {
			this.input.handleInput(keyData);
		}
	}
}

/**
 * 会话树选择器组件（对外导出）：渲染用于导航的会话树选择界面。
 *
 * 以 Container 组合树列表、搜索行、帮助行与标签输入等子组件；
 * 键盘输入在「树列表」与「标签输入」之间按当前状态转发。
 */
export class TreeSelectorComponent extends Container implements Focusable {
	/** 核心树列表（经 getTreeList 暴露给外部查询状态） */
	private treeList: TreeList;
	/** 当前是否处于标签编辑态（null = 显示树列表） */
	private labelInput: LabelInput | null = null;
	/** 标签输入的容器（编辑态时切换显示内容） */
	private labelInputContainer: Container;
	/** 树列表的容器（编辑态时清空以腾出空间） */
	private treeContainer: Container;
	/** 标签变更回调（持久化由外部负责） */
	private onLabelChangeCallback?: (entryId: string, label: string | undefined) => void;
	public onCopy?: (text: string | undefined) => void;

	// Focusable 实现 —— 编辑标签时把焦点转发给 labelInput，用于输入法（IME）光标定位
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// 标签输入激活时同步转发焦点状态
		if (this.labelInput) {
			this.labelInput.focused = value;
		}
	}

	constructor(
		tree: SessionTreeNode[],
		currentLeafId: string | null,
		terminalHeight: number,
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		onLabelChange?: (entryId: string, label: string | undefined) => void,
		initialSelectedId?: string,
		initialFilterMode?: FilterMode,
	) {
		super();

		this.onLabelChangeCallback = onLabelChange;
		// 可见行数 = 终端高度的一半，至少 5 行，避免窗口过矮时无内容可显示
		const maxVisibleLines = Math.max(5, Math.floor(terminalHeight / 2));

		// ===== 组装树列表并接线回调 =====
		this.treeList = new TreeList(tree, currentLeafId, maxVisibleLines, initialSelectedId, initialFilterMode);
		this.treeList.onSelect = onSelect;
		this.treeList.onCancel = onCancel;
		this.treeList.onCopy = (text) => this.onCopy?.(text);
		this.treeList.onLabelEdit = (entryId, currentLabel) => this.showLabelInput(entryId, currentLabel);

		this.treeContainer = new Container();
		this.treeContainer.addChild(this.treeList);

		this.labelInputContainer = new Container();

		// ===== 垂直布局：留白 / 边框 / 标题 / 帮助 / 搜索行 / 树 / 标签输入 / 留白 / 边框 =====
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold("  Session Tree"), 1, 0));
		this.addChild(new TreeHelp());
		this.addChild(new SearchLine(this.treeList));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.treeContainer);
		this.addChild(this.labelInputContainer);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// 空树没有可导航内容：延迟一拍触发取消，等组件挂载后再正常关闭
		if (tree.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	/** 进入标签编辑态：创建输入组件、接线回调，并切换两个容器的显示内容 */
	private showLabelInput(entryId: string, currentLabel: string | undefined): void {
		this.labelInput = new LabelInput(entryId, currentLabel);
		this.labelInput.onSubmit = (id, label) => {
			// 先就地更新节点数据，再通知外部持久化，最后回到树列表
			this.treeList.updateNodeLabel(id, label);
			this.onLabelChangeCallback?.(id, label);
			this.hideLabelInput();
		};
		this.labelInput.onCancel = () => this.hideLabelInput();

		// 把当前焦点状态同步给新建的 labelInput
		this.labelInput.focused = this._focused;

		// 树列表让位给标签输入
		this.treeContainer.clear();
		this.labelInputContainer.clear();
		this.labelInputContainer.addChild(this.labelInput);
	}

	/** 退出标签编辑态：移除输入组件并恢复树列表显示 */
	private hideLabelInput(): void {
		this.labelInput = null;
		this.labelInputContainer.clear();
		this.treeContainer.clear();
		this.treeContainer.addChild(this.treeList);
	}

	/** 键盘输入转发：编辑标签时给输入框，否则给树列表 */
	handleInput(keyData: string): void {
		if (this.labelInput) {
			this.labelInput.handleInput(keyData);
		} else {
			this.treeList.handleInput(keyData);
		}
	}

	/** 暴露内部 TreeList（外部可查询选中节点/搜索词等状态） */
	getTreeList(): TreeList {
		return this.treeList;
	}
}
