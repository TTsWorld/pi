/**
 * @file config-selector.ts —— 配置选择器 TUI 组件（管理扩展/技能/提示词/主题等资源的启用与禁用）
 *
 * @description
 * 本文件实现交互模式下用于编辑资源配置的终端界面（如 /config 入口打开的选择器）：
 * 把 settings.json（全局 `~/.config/agent/settings.json` 或项目 `.agent/settings.json`）
 * 解析出的资源路径树渲染为「分组 → 子分组（资源类型） → 资源项」三层可勾选列表，
 * 并把用户在列表上的操作（空格切换勾选、Tab 切换全局/项目模式、输入即搜索过滤）写回 settings。
 *
 * 主要功能点：
 * - 双写作用域：global（写用户级 settings）与 project（写项目级 settings），
 *   项目模式下资源呈现 inherit / load / unload 三态循环，继承自全局的资源暗显；
 * - buildGroups 把 ResolvedPaths 按「origin + scope + source + baseDir」聚合成排序后的分组树；
 * - ResourceList 负责列表渲染、滚动视口、搜索过滤与按键处理；写入时区分
 *   「顶层资源」与「包(package)内资源」两条路径，分别生成 `+pattern` / `-pattern` 模式条目；
 * - ConfigSelectorComponent 为对外导出的容器：组合边框、头部提示与列表，转发焦点与回调。
 *
 * 依赖关系：
 * - @earendil-works/pi-tui：终端 UI 基础组件（Container/Input/Spacer）与按键匹配、宽度计算工具；
 * - ../../../core/package-manager.ts：资源解析结果类型（ResolvedPaths / ResolvedResource / PathMetadata）；
 * - ../../../core/settings-manager.ts：settings.json 的读写（SettingsManager / PackageSource）；
 * - ../theme/theme.ts、./dynamic-border.ts、./keybinding-hints.ts：主题配色、动态边框与按键提示文案。
 */

import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../../../core/package-manager.ts";
import type { PackageSource, SettingsManager } from "../../../core/settings-manager.ts";
import { canonicalizePath, isLocalPath, resolvePath } from "../../../utils/paths.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** 可管理的资源类型：扩展 / 技能 / 提示词模板 / 主题 */
type ResourceType = "extensions" | "skills" | "prompts" | "themes";
/** 列表的写入作用域：global = 用户级 settings，project = 项目级 settings（决定空格键写入哪份文件） */
type ConfigWriteScope = "global" | "project";
/** settings 自身的作用域：user（全局配置）/ project（当前项目配置） */
type SettingsScope = "user" | "project";
/**
 * 项目模式下的覆盖三态（空格键循环切换）：
 * - inherit：继承，无覆盖条目，跟随上层（全局或包默认）行为；
 * - load：项目强制加载（写入 `+pattern` 条目）；
 * - unload：项目强制卸载（写入 `-pattern` 条目）。
 */
type ProjectOverrideState = "inherit" | "load" | "unload";
/** 按写入作用域分别解析出的资源路径树（global / project 各一份） */
export type ScopedResolvedPaths = Record<ConfigWriteScope, ResolvedPaths>;

/** 全部资源类型常量元组（satisfies 约束其取值与 ResourceType 保持一致） */
const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const satisfies readonly ResourceType[];

/** 各资源类型在列表子分组标题上的显示标签 */
const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	extensions: "Extensions",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
};

/**
 * 列表中的一个可勾选资源项（渲染与勾选操作的最小单元）。
 * 由 buildGroups 从 ResolvedResource 加工而来，附带分组归属与展示名。
 */
interface ResourceItem {
	/** 资源绝对路径（也作为同一资源的匹配键组成部分） */
	path: string;
	/** 当前是否启用（决定复选框显示 [x] 还是 [ ]） */
	enabled: boolean;
	/** 来自 package-manager 的解析元数据（origin/scope/source/baseDir，决定写入路径与模式串） */
	metadata: PathMetadata;
	/** 所属资源类型 */
	resourceType: ResourceType;
	/** 列表显示名（如 SKILL.md 显示所在目录名） */
	displayName: string;
	/** 所属分组 key（`origin:scope:source:baseDir`） */
	groupKey: string;
	/** 所属子分组 key（分组 key + 资源类型） */
	subgroupKey: string;
}

/** 分组内按资源类型划分的子分组（如某个包下的 "Extensions" / "Skills" 小节） */
interface ResourceSubgroup {
	/** 子分组对应的资源类型 */
	type: ResourceType;
	/** 显示标签（取自 RESOURCE_TYPE_LABELS） */
	label: string;
	/** 该类型下的资源项列表 */
	items: ResourceItem[];
}

/**
 * 顶层分组：同一来源（某个包，或某作用域 settings 的顶层路径集合）下所有资源的容器。
 * 排序规则见 buildGroups：包在前顶层在后、user 在前 project 在后。
 */
interface ResourceGroup {
	/** 分组唯一 key：`origin:scope:source:baseDir` */
	key: string;
	/** 分组标题（如 `mypkg (user)`、`User (~/.config/agent/)`） */
	label: string;
	/** 资源作用域：user / project / temporary */
	scope: "user" | "project" | "temporary";
	/** 来源形态：package（包内资源）或 top-level（settings 中直接列出的顶层路径） */
	origin: "package" | "top-level";
	/** 来源标识：包名，或顶层来源标记（auto = 自动发现，settings = 显式配置） */
	source: string;
	/** 按资源类型划分的子分组 */
	subgroups: ResourceSubgroup[];
}

/**
 * 把基准目录格式化为简短展示路径：home 前缀替换为 `~`，
 * 分隔符统一为 `/`，并保证以 `/` 结尾（用于分组标题，如 `User (~/.config/agent/)`）。
 */
function formatBaseDir(baseDir: string): string {
	const homeDir = homedir();
	let displayPath: string;

	if (baseDir === homeDir) {
		displayPath = "~";
	} else if (baseDir.startsWith(homeDir)) {
		// 把 home 前缀替换为 ~，并把 Windows 反斜杠分隔符统一为 / 以便展示
		const rest = baseDir.slice(homeDir.length);
		displayPath = `~${rest.replace(/\\/g, "/")}`;
	} else {
		displayPath = baseDir.replace(/\\/g, "/");
	}

	return displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
}

/**
 * 生成分组标题：
 * - 包来源：`包名 (作用域)`；
 * - 顶层自动发现的资源：带基准目录的 `User (…)` / `Project (…)`；
 * - settings 显式配置的顶层资源：`User settings` / `Project settings`。
 */
function getGroupLabel(metadata: PathMetadata, agentDir: string): string {
	if (metadata.origin === "package") {
		return `${metadata.source} (${metadata.scope})`;
	}
	// 顶层（非包内）资源
	if (metadata.source === "auto") {
		if (metadata.baseDir) {
			return metadata.scope === "user"
				? `User (${formatBaseDir(metadata.baseDir)})`
				: `Project (${formatBaseDir(metadata.baseDir)})`;
		}
		return metadata.scope === "user" ? `User (${formatBaseDir(agentDir)})` : `Project (${CONFIG_DIR_NAME}/)`;
	}
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

/**
 * 把某作用域解析出的 ResolvedPaths 组装为排序后的分组树：
 * 以 `origin:scope:source:baseDir` 为 key 聚合四类资源，组内再按资源类型建子分组，
 * 最后统一排序（包优先、user 优先；组内按类型固定顺序，项按显示名字典序）。
 */
function buildGroups(resolved: ResolvedPaths, agentDir: string): ResourceGroup[] {
	const groupMap = new Map<string, ResourceGroup>();

	// 把某一类型的资源数组合入分组树：分组/子分组不存在则先创建，再生成显示名并追加资源项
	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		for (const res of resources) {
			const { path, enabled, metadata } = res;
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.baseDir ?? ""}`;

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					key: groupKey,
					label: getGroupLabel(metadata, agentDir),
					scope: metadata.scope,
					origin: metadata.origin,
					source: metadata.source,
					subgroups: [],
				});
			}

			const group = groupMap.get(groupKey)!;
			const subgroupKey = `${groupKey}:${resourceType}`;

			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			if (!subgroup) {
				subgroup = {
					type: resourceType,
					label: RESOURCE_TYPE_LABELS[resourceType],
					items: [],
				};
				group.subgroups.push(subgroup);
			}

			// 生成显示名：SKILL.md 用所在目录名；扩展若不在 extensions/ 目录下则带父目录前缀；其余用文件名
			const fileName = basename(path);
			const parentFolder = basename(dirname(path));
			let displayName: string;
			if (resourceType === "extensions" && parentFolder !== "extensions") {
				displayName = `${parentFolder}/${fileName}`;
			} else if (resourceType === "skills" && fileName === "SKILL.md") {
				displayName = parentFolder;
			} else {
				displayName = fileName;
			}
			subgroup.items.push({
				path,
				enabled,
				metadata,
				resourceType,
				displayName,
				groupKey,
				subgroupKey,
			});
		}
	};

	addToGroup(resolved.extensions, "extensions");
	addToGroup(resolved.skills, "skills");
	addToGroup(resolved.prompts, "prompts");
	addToGroup(resolved.themes, "themes");

	// 分组排序：包在前、顶层在后；同为包/顶层时 user 在前、project 在后；最后按 source 字典序
	const groups = Array.from(groupMap.values());
	groups.sort((a, b) => {
		if (a.origin !== b.origin) {
			return a.origin === "package" ? -1 : 1;
		}
		if (a.scope !== b.scope) {
			return a.scope === "user" ? -1 : 1;
		}
		return a.source.localeCompare(b.source);
	});

	// 组内子分组按资源类型固定顺序（extensions→skills→prompts→themes）排列，资源项按显示名字典序排列
	const typeOrder: Record<ResourceType, number> = { extensions: 0, skills: 1, prompts: 2, themes: 3 };
	for (const group of groups) {
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		for (const subgroup of group.subgroups) {
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}

	return groups;
}

/**
 * 拍平后的列表条目（判别联合）：分组标题行 / 子分组标题行 / 可选中的资源项。
 * ResourceList 的渲染视口、导航与过滤都作用在这个一维数组上。
 */
type FlatEntry =
	| { type: "group"; group: ResourceGroup }
	| { type: "subgroup"; subgroup: ResourceSubgroup; group: ResourceGroup }
	| { type: "item"; item: ResourceItem };

/**
 * 选择器顶栏组件：渲染标题（"Global Resources" / "Project Local Resources"）、
 * 按键提示（Tab 切换模式、空格切换勾选、esc 关闭）以及当前写入的 settings 文件路径说明。
 */
class ConfigSelectorHeader implements Component {
	/** 标题对应的写入作用域 */
	private writeScope: ConfigWriteScope;
	/** 项目模式是否可用（不可用时隐藏 Tab 切换提示） */
	private projectModeAvailable: boolean;

	constructor(writeScope: ConfigWriteScope, projectModeAvailable: boolean) {
		this.writeScope = writeScope;
		this.projectModeAvailable = projectModeAvailable;
	}

	/** 切换标题展示的写入作用域（Tab 切换模式时由容器调用） */
	setWriteScope(writeScope: ConfigWriteScope): void {
		this.writeScope = writeScope;
	}

	// 无缓存状态，无需失效处理
	invalidate(): void {}

	// 渲染两行：① 标题 + 右侧按键提示（按宽度补空格对齐）；② 写入的 settings 文件路径说明
	render(width: number): string[] {
		const title = theme.bold(this.writeScope === "project" ? "Project Local Resources" : "Global Resources");
		const sep = theme.fg("muted", " · ");
		const switchHint = this.projectModeAvailable ? keyHint("tui.input.tab", "switch mode") + sep : "";
		const actionHint =
			this.writeScope === "project" ? rawKeyHint("space", "cycle inherit/+/-") : rawKeyHint("space", "toggle");
		const hint = switchHint + actionHint + sep + rawKeyHint("esc", "close");
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
		const scopeHint =
			this.writeScope === "project"
				? theme.fg("muted", `${CONFIG_DIR_NAME}/settings.json · inherited global resources are dimmed`)
				: theme.fg("muted", `~/${CONFIG_DIR_NAME}/agent/settings.json`);

		return [
			truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""),
			truncateToWidth(scopeHint, width, ""),
		];
	}
}

/**
 * 资源列表组件：渲染分组化的可勾选列表，处理导航/搜索/勾选按键，
 * 并通过 SettingsManager 把变更写回全局或项目 settings.json。
 *
 * 关键状态：
 * - flatItems：当前作用域下拍平的完整列表；filteredItems：搜索过滤后的视图（渲染与导航都用它）；
 * - inheritedEnabledByKey：全局作用域各资源启用状态的快照，
 *   项目模式下用于计算「继承」态的显示与三态循环方向；
 * - 勾选写入分两条路径：顶层资源写 settings 顶层数组，包内资源写 packages[i] 的类型过滤数组。
 */
class ResourceList implements Component, Focusable {
	/** 两个写入作用域各自的分组树 */
	private groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>;
	/** 拍平后的完整列表（group/subgroup/item 三种条目混排） */
	private flatItems: FlatEntry[] = [];
	/** 搜索过滤后的列表（渲染与导航实际使用的视图） */
	private filteredItems: FlatEntry[] = [];
	/** 当前选中条目在 filteredItems 中的下标 */
	private selectedIndex = 0;
	/** 搜索输入框（未被列表消费的按键都会转发给它） */
	private searchInput: Input;
	/** 视口最多可见的列表行数（终端高度减去边框等界面装饰） */
	private maxVisible: number;
	/** settings 读写句柄 */
	private settingsManager: SettingsManager;
	/** 当前工作目录（项目级 settings 的基准） */
	private cwd: string;
	/** 全局 agent 配置目录（用户级 settings 的基准） */
	private agentDir: string;
	/** 当前写入作用域 */
	private writeScope: ConfigWriteScope;
	/** 全局作用域资源启用状态快照（key 为 `资源类型:规范化路径`） */
	private inheritedEnabledByKey: Map<string, boolean>;

	// 宿主注入的回调：esc 取消 / ctrl+c 退出 / 勾选成功 / Tab 切换全局-项目模式
	public onCancel?: () => void;
	public onExit?: () => void;
	public onToggle?: (item: ResourceItem, newEnabled: boolean) => void;
	public onSwitchMode?: () => void;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// 焦点变化同步转发给搜索框，保证输入态一致
		this.searchInput.focused = value;
	}

	constructor(
		groupsByScope: Record<ConfigWriteScope, ResourceGroup[]>,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		terminalHeight?: number,
		writeScope: ConfigWriteScope = "global",
	) {
		this.groupsByScope = groupsByScope;
		this.settingsManager = settingsManager;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.writeScope = writeScope;
		// 记录全局作用域的启用快照：项目模式下据此还原“继承”状态的勾选显示
		this.inheritedEnabledByKey = this.buildInheritedEnabledMap(groupsByScope.global);
		this.searchInput = new Input();
		// 8 行界面装饰高度：顶部留白 + 上边框 + 留白 + 头部(2 行) + 留白 + 底部留白 + 下边框
		const chrome = 8;
		this.maxVisible = Math.max(5, (terminalHeight ?? 24) - chrome);
		this.buildFlatList();
		this.filteredItems = [...this.flatItems];
	}

	/** 切换写入作用域：重建拍平列表并按当前搜索词重新过滤（选中重置到首项） */
	setWriteScope(writeScope: ConfigWriteScope): void {
		this.writeScope = writeScope;
		this.buildFlatList();
		this.filterItems(this.searchInput.getValue());
	}

	/** 当前写入作用域对应的分组树 */
	private get groups(): ResourceGroup[] {
		return this.groupsByScope[this.writeScope];
	}

	/** 建立「资源键 → 启用状态」映射，作为项目模式下继承态的基准快照 */
	private buildInheritedEnabledMap(groups: ResourceGroup[]): Map<string, boolean> {
		const result = new Map<string, boolean>();
		for (const group of groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					result.set(this.getResourceItemKey(item), item.enabled);
				}
			}
		}
		return result;
	}

	/** 把当前作用域的分组树拍平为一维数组（group → subgroup → item 逐层展开） */
	private buildFlatList(): void {
		this.flatItems = [];
		for (const group of this.groups) {
			this.flatItems.push({ type: "group", group });
			for (const subgroup of group.subgroups) {
				this.flatItems.push({ type: "subgroup", subgroup, group });
				for (const item of subgroup.items) {
					this.flatItems.push({ type: "item", item });
				}
			}
		}
		// 初始选中第一个资源项（跳过分组/子分组标题行）
		this.selectedIndex = this.flatItems.findIndex((e) => e.type === "item");
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	/** 从 fromIndex 沿 direction 找下一个可选中的资源项（跳过标题行）；找不到则原地不动 */
	private findNextItem(fromIndex: number, direction: 1 | -1): number {
		let idx = fromIndex + direction;
		while (idx >= 0 && idx < this.filteredItems.length) {
			if (this.filteredItems[idx].type === "item") {
				return idx;
			}
			idx += direction;
		}
		return fromIndex; // 找不到可选项时停留在当前位置
	}

	/**
	 * 按搜索词过滤列表：匹配 displayName / 资源类型 / 路径（均忽略大小写），
	 * 只保留命中的资源项以及包含命中项的子分组与分组标题行，最后重置选中到首项。
	 */
	private filterItems(query: string): void {
		if (!query.trim()) {
			this.filteredItems = [...this.flatItems];
			this.selectFirstItem();
			return;
		}

		const lowerQuery = query.toLowerCase();
		const matchingItems = new Set<ResourceItem>();
		const matchingSubgroups = new Set<ResourceSubgroup>();
		const matchingGroups = new Set<ResourceGroup>();

		for (const entry of this.flatItems) {
			if (entry.type === "item") {
				const item = entry.item;
				if (
					item.displayName.toLowerCase().includes(lowerQuery) ||
					item.resourceType.toLowerCase().includes(lowerQuery) ||
					item.path.toLowerCase().includes(lowerQuery)
				) {
					matchingItems.add(item);
				}
			}
		}

		// 找出包含命中资源的子分组与分组，保留其标题行以维持层级结构
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					if (matchingItems.has(item)) {
						matchingSubgroups.add(subgroup);
						matchingGroups.add(group);
					}
				}
			}
		}

		this.filteredItems = [];
		for (const entry of this.flatItems) {
			if (entry.type === "group" && matchingGroups.has(entry.group)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "item" && matchingItems.has(entry.item)) {
				this.filteredItems.push(entry);
			}
		}

		this.selectFirstItem();
	}

	/** 选中过滤结果中的第一个资源项；列表中没有资源项时退回到第 0 行 */
	private selectFirstItem(): void {
		const firstItemIndex = this.filteredItems.findIndex((e) => e.type === "item");
		this.selectedIndex = firstItemIndex >= 0 ? firstItemIndex : 0;
	}

	/** 同步更新资源项启用状态：渲染用的 item 与分组树中的原始对象都要改（两者可能不是同一引用） */
	updateItem(item: ResourceItem, enabled: boolean): void {
		item.enabled = enabled;
		// 同步更新分组树中的同一资源对象
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				const found = subgroup.items.find((i) => i.path === item.path && i.resourceType === item.resourceType);
				if (found) {
					found.enabled = enabled;
					return;
				}
			}
		}
	}

	// 无缓存状态，无需失效处理
	invalidate(): void {}

	/** 渲染列表：搜索框 + 可见视口内的条目 + 滚动位置指示 */
	render(width: number): string[] {
		const lines: string[] = [];

		// 搜索输入框
		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.filteredItems.length === 0) {
			lines.push(theme.fg("muted", "  No resources found"));
			return lines;
		}

		// 计算可见视口：让选中项尽量居中，同时不越出列表上下界
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.filteredItems[i];
			const isSelected = i === this.selectedIndex;

			if (entry.type === "group") {
				// 分组标题行：不参与选中；项目模式下继承自全局的分组追加后缀并变暗
				const inherited = this.writeScope === "project" && entry.group.scope === "user";
				const label = theme.bold(`${entry.group.label}${inherited ? " · inherited global" : ""}`);
				const groupLine = theme.fg(inherited ? "dim" : "accent", label);
				lines.push(truncateToWidth(`  ${groupLine}`, width, ""));
			} else if (entry.type === "subgroup") {
				// 子分组标题行：缩进展示，不参与选中；继承自全局时同样变暗
				const color = this.writeScope === "project" && entry.group.scope === "user" ? "dim" : "muted";
				const subgroupLine = theme.fg(color, entry.subgroup.label);
				lines.push(truncateToWidth(`    ${subgroupLine}`, width, ""));
			} else {
				// 资源项行：只有资源项显示光标 >，继承且未覆盖的项暗显
				const item = entry.item;
				const cursor = isSelected ? "> " : "  ";
				const dimmed = this.isDimmedItem(item);
				const nameText = isSelected && !dimmed ? theme.bold(item.displayName) : item.displayName;
				const name = dimmed ? theme.fg("dim", nameText) : nameText;
				lines.push(
					truncateToWidth(
						`${cursor}    ${this.renderCheckbox(item)} ${name}${this.getItemSuffix(item)}`,
						width,
						"...",
					),
				);
			}
		}

		// 滚动指示：仅在列表上下被截断时显示 (当前资源序号/资源总数)
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const itemCount = this.filteredItems.filter((e) => e.type === "item").length;
			const currentItemIndex =
				this.filteredItems.slice(0, this.selectedIndex).filter((e) => e.type === "item").length + 1;
			lines.push(theme.fg("dim", `  (${currentItemIndex}/${itemCount})`));
		}

		return lines;
	}

	/**
	 * 处理按键：上下导航（跳过标题行）、翻页、esc 取消、ctrl+c 退出、
	 * Tab 切换全局/项目模式、空格/确认键切换勾选；其余按键转发给搜索框并按新输入重新过滤。
	 */
	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, -1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.findNextItem(this.selectedIndex, 1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			// 上翻一页后向后找最近的资源项（跳过标题行）
			let target = Math.max(0, this.selectedIndex - this.maxVisible);
			while (target < this.filteredItems.length && this.filteredItems[target].type !== "item") {
				target++;
			}
			if (target < this.filteredItems.length) {
				this.selectedIndex = target;
			}
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			// 下翻一页后向前找最近的资源项（跳过标题行）
			let target = Math.min(this.filteredItems.length - 1, this.selectedIndex + this.maxVisible);
			while (target >= 0 && this.filteredItems[target].type !== "item") {
				target--;
			}
			if (target >= 0) {
				this.selectedIndex = target;
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.onExit?.();
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			this.onSwitchMode?.();
			return;
		}
		// 空格/确认键：切换勾选。项目模式下任何项都可写覆盖；
		// 全局模式下只允许改 user 作用域的项（project 项归项目 settings 管）
		if (data === " " || kb.matches(data, "tui.select.confirm")) {
			const entry = this.filteredItems[this.selectedIndex];
			if (entry?.type === "item" && (this.writeScope === "project" || this.getItemScope(entry.item) === "user")) {
				const newEnabled = this.toggleResource(entry.item);
				if (newEnabled !== undefined) {
					this.updateItem(entry.item, newEnabled);
					this.onToggle?.(entry.item, newEnabled);
				}
			}
			return;
		}

		// 其余按键交给搜索框处理，并按输入内容重新过滤
		this.searchInput.handleInput(data);
		this.filterItems(this.searchInput.getValue());
	}

	/**
	 * 切换资源的启用状态；返回切换后的新状态，返回 undefined 表示写入失败（UI 不更新）。
	 * - 项目模式：在 inherit/load/unload 三态间循环，写入项目覆盖条目；
	 * - 全局模式：直接取反，并按资源来源分发到顶层或包两条写入路径。
	 */
	private toggleResource(item: ResourceItem): boolean | undefined {
		if (this.writeScope === "project") {
			const state = this.getNextOverrideState(item);
			if (!this.setProjectResourceOverride(item, state)) return undefined;
			return state === "inherit" ? this.getInheritedEnabled(item) : state === "load";
		}

		const enabled = !item.enabled;
		if (item.metadata.origin === "top-level") {
			this.toggleTopLevelResource(item, enabled);
		} else {
			this.togglePackageResource(item, enabled);
		}
		return enabled;
	}

	/**
	 * 切换「顶层资源」（settings 顶层的 extensions/skills/… 路径数组中的条目）：
	 * 先移除该资源已有的 `!/+/-` 任意前缀条目，再按新状态追加 `+pattern`（启用）或 `-pattern`（禁用）。
	 */
	private toggleTopLevelResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (settings[arrayKey] ?? []) as string[];

		// 生成该资源的匹配模式串（相对基准目录的路径）
		const pattern = this.getResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// 先移除该资源已有的任意前缀条目，避免重复
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		// 按作用域与资源类型调用对应 setter 写回 settings
		if (scope === "project") {
			if (arrayKey === "extensions") {
				this.settingsManager.setProjectExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setProjectSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setProjectPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setProjectThemePaths(updated);
			}
		} else {
			if (arrayKey === "extensions") {
				this.settingsManager.setExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setThemePaths(updated);
			}
		}
	}

	/**
	 * 切换「包内资源」：写入 settings.packages 中对应包条目的类型过滤数组。
	 * 包条目若还是字符串形式会先升级为对象；过滤数组清空后回落为字符串形式，避免留下空对象。
	 */
	private togglePackageResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const pkgIndex = packages.findIndex((pkg) => {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			return source === item.metadata.source;
		});

		// settings 中找不到对应包条目：无事可做
		if (pkgIndex === -1) return;

		let pkg = packages[pkgIndex];

		// 包条目还是字符串形式时，先升级为对象形式以便挂载过滤数组
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}

		// 取该包下此资源类型的过滤数组（arrayKey 同时是包对象上的字段名）
		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (pkg[arrayKey] ?? []) as string[];

		// 生成相对包根目录的模式串
		const pattern = this.getPackageResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// 先移除该资源已有的任意前缀条目，避免重复
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		// 数组清空时置 undefined，settings 序列化后不留空数组
		(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;

		// 四类过滤数组全空时回收对象形式，把包条目还原为纯 source 字符串
		const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
			(k) => (pkg as Record<string, unknown>)[k] !== undefined,
		);
		if (!hasFilters) {
			packages[pkgIndex] = (pkg as { source: string }).source;
		}

		if (scope === "project") {
			this.settingsManager.setProjectPackages(packages);
		} else {
			this.settingsManager.setPackages(packages);
		}
	}

	/** 渲染复选框：项目模式显示三态 [+]/[-]/继承原状，全局模式显示 [x]/[ ] */
	private renderCheckbox(item: ResourceItem): string {
		if (this.writeScope === "project") {
			const state = this.getProjectOverrideState(item);
			if (state === "load") return theme.fg("success", "[+]");
			if (state === "unload") return theme.fg("warning", "[-]");
			return theme.fg("dim", item.enabled ? "[x]" : "[ ]");
		}
		return item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
	}

	/** 项目模式下资源名后的状态后缀（project load / project unload / inherited global） */
	private getItemSuffix(item: ResourceItem): string {
		if (this.writeScope !== "project") return "";
		const state = this.getProjectOverrideState(item);
		if (state === "load") return theme.fg("muted", "  project load");
		if (state === "unload") return theme.fg("muted", "  project unload");
		return this.isInheritedGlobalItem(item) ? theme.fg("dim", "  inherited global") : "";
	}

	/** 是否暗显：项目模式下继承自全局、且未设置任何覆盖的资源项 */
	private isDimmedItem(item: ResourceItem): boolean {
		return (
			this.writeScope === "project" &&
			this.isInheritedGlobalItem(item) &&
			this.getProjectOverrideState(item) === "inherit"
		);
	}

	/** 写入项目覆盖状态：按资源来源分发到顶层或包两条写入路径 */
	private setProjectResourceOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		return item.metadata.origin === "top-level"
			? this.setProjectTopLevelOverride(item, state)
			: this.setProjectPackageOverride(item, state);
	}

	/**
	 * 把顶层资源的覆盖状态写入项目 settings 的顶层数组：
	 * 先移除旧覆盖条目；load/unload 时追加对应 `+`/`-` 条目（继承自全局的资源
	 * 还需先写入基础路径，保证模式串可命中），inherit 则只删不加。
	 */
	private setProjectTopLevelOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		const current = (this.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[];
		const pattern = this.isInheritedGlobalItem(item) ? item.path : this.getResourcePatternForScope(item, "project");
		const patterns = this.getTopLevelOverridePatterns(item, "project");
		// 移除该资源所有旧覆盖条目；inherit 时还要删掉继承项的基础路径条目
		const updated = current.filter((entry) => {
			const target = this.getPatternEntryTarget(entry);
			if ((entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")) && patterns.has(target))
				return false;
			return !(state === "inherit" && this.isInheritedGlobalItem(item) && target === pattern);
		});
		if (state !== "inherit") {
			if (this.isInheritedGlobalItem(item) && !updated.includes(pattern)) updated.push(pattern);
			updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		}
		this.setProjectTopLevelPaths(item.resourceType, updated);
		return true;
	}

	/** 按资源类型把路径数组写回项目 settings 的对应顶层字段 */
	private setProjectTopLevelPaths(key: ResourceType, paths: string[]): void {
		if (key === "extensions") this.settingsManager.setProjectExtensionPaths(paths);
		else if (key === "skills") this.settingsManager.setProjectSkillPaths(paths);
		else if (key === "prompts") this.settingsManager.setProjectPromptTemplatePaths(paths);
		else this.settingsManager.setProjectThemePaths(paths);
	}

	/**
	 * 把包内资源的覆盖状态写入项目 settings.packages：
	 * 找不到对应包且目标是 inherit 时放弃；否则必要时新建 autoload:false 的包条目，
	 * 更新其类型过滤数组；数组清空后回落为字符串形式（新建的覆盖条目则整体删除）。
	 */
	private setProjectPackageOverride(item: ResourceItem, state: ProjectOverrideState): boolean {
		const packages = [...(this.settingsManager.getProjectSettings().packages ?? [])] as PackageSource[];
		let pkgIndex = packages.findIndex((pkg) =>
			this.packageSourceStringMatches(
				item.metadata.source,
				this.getItemScope(item),
				typeof pkg === "string" ? pkg : pkg.source,
				"project",
			),
		);
		// 项目 settings 中还没有该包：inherit 无事可做；load/unload 则新建覆盖用包条目
		if (pkgIndex === -1) {
			if (state === "inherit") return false;
			packages.push(this.createPackageOverrideSource(item));
			pkgIndex = packages.length - 1;
		}
		let pkg = packages[pkgIndex];
		if (pkg === undefined) return false;
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}
		const pattern = this.getPackageResourcePattern(item);
		// 移除该资源所有旧条目（任意前缀），再按目标状态追加 `+`/`-` 覆盖条目
		const updated = ((pkg[item.resourceType] ?? []) as string[]).filter(
			(entry) => this.getPatternEntryTarget(entry) !== pattern,
		);
		if (state !== "inherit") updated.push(`${state === "load" ? "+" : "-"}${pattern}`);
		// 数组清空时置 undefined，不留空数组
		(pkg as Record<string, unknown>)[item.resourceType] = updated.length > 0 ? updated : undefined;
		// 四类过滤数组全空：新建的覆盖条目（autoload===false）直接删除，原有条目还原为字符串
		if (!RESOURCE_TYPES.some((key) => (pkg as Record<string, unknown>)[key] !== undefined)) {
			if (pkg.autoload === false) packages.splice(pkgIndex, 1);
			else packages[pkgIndex] = pkg.source;
		}
		this.settingsManager.setProjectPackages(packages);
		return true;
	}

	/**
	 * 计算空格键三态循环的下一状态：inherit 先翻到与继承态相反的显式态
	 * （继承启用→提议 unload，继承禁用→提议 load）；显式态则先回到 inherit，
	 * 再次按下才翻到另一个显式态，减少误操作成本。
	 */
	private getNextOverrideState(item: ResourceItem): ProjectOverrideState {
		const state = this.getProjectOverrideState(item);
		const inheritedEnabled = this.getInheritedEnabled(item);
		if (state === "inherit") return inheritedEnabled ? "unload" : "load";
		if (state === "unload") return inheritedEnabled ? "load" : "inherit";
		return inheritedEnabled ? "inherit" : "unload";
	}

	/** 读取资源当前的项目覆盖状态：顶层资源看项目 settings 顶层数组，包内资源看包条目的过滤数组 */
	private getProjectOverrideState(item: ResourceItem): ProjectOverrideState {
		if (this.writeScope !== "project") return "inherit";
		if (item.metadata.origin === "top-level") {
			return this.getOverrideStateFromEntries(
				(this.settingsManager.getProjectSettings()[item.resourceType] ?? []) as string[],
				this.getTopLevelOverridePatterns(item, "project"),
				false,
			);
		}
		const pkg = this.findMatchingPackageSource(item, "project");
		if (typeof pkg !== "object") return "inherit";
		const entries = pkg[item.resourceType];
		if (entries === undefined) return "inherit";
		return this.getOverrideStateFromEntries(
			entries,
			new Set([this.getPackageResourcePattern(item)]),
			pkg.autoload !== false,
		);
	}

	/**
	 * 从模式条目数组推断覆盖状态：命中目标模式的条目中最后一条生效
	 * （`!`/`-` 前缀 = unload，其余前缀 = load），都不命中则 inherit。
	 * @param emptyArrayIsUnload 数组显式为空时视为整包 unload（对应包级 autoload:false 语义）
	 */
	private getOverrideStateFromEntries(
		entries: string[],
		patterns: Set<string>,
		emptyArrayIsUnload: boolean,
	): ProjectOverrideState {
		if (entries.length === 0 && emptyArrayIsUnload) return "unload";
		let state: ProjectOverrideState = "inherit";
		for (const entry of entries) {
			if (!patterns.has(this.getPatternEntryTarget(entry))) continue;
			if (entry.startsWith("!") || entry.startsWith("-")) state = "unload";
			else state = "load";
		}
		return state;
	}

	/** 读取资源在全局作用域下的启用状态；快照缺失时 user 项取当前值，其余默认启用 */
	private getInheritedEnabled(item: ResourceItem): boolean {
		return (
			this.inheritedEnabledByKey.get(this.getResourceItemKey(item)) ??
			(this.getItemScope(item) === "user" ? item.enabled : true)
		);
	}

	/** 是否属于“继承自全局”的资源：user 作用域，或曾出现在全局快照中 */
	private isInheritedGlobalItem(item: ResourceItem): boolean {
		return this.getItemScope(item) === "user" || this.inheritedEnabledByKey.has(this.getResourceItemKey(item));
	}

	/**
	 * 收集资源在指定作用域下可能被引用的全部模式串形态（相对路径/绝对路径等），
	 * 用于识别并清理旧覆盖条目时兼容历史写法。
	 */
	private getTopLevelOverridePatterns(item: ResourceItem, scope: SettingsScope): Set<string> {
		const baseDir = this.getTopLevelBaseDir(scope);
		const patterns = new Set<string>([
			this.getResourcePatternForScope(item, scope),
			item.path,
			relative(baseDir, item.path),
		]);
		if (item.metadata.baseDir) patterns.add(relative(item.metadata.baseDir, item.path));
		return patterns;
	}

	/** 生成资源在指定作用域 settings 中的模式串：跨作用域引用用绝对路径，同作用域用相对路径 */
	private getResourcePatternForScope(item: ResourceItem, scope: SettingsScope): string {
		const sourceScope = this.getItemScope(item);
		if (scope !== sourceScope) return item.path;
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(sourceScope);
		return relative(baseDir, item.path);
	}

	/**
	 * 为项目 settings 新建包覆盖条目：本地路径解析为相对项目根的路径（根本身用 "."），
	 * 非本地 source 保持原样；autoload 置 false，避免仅为覆盖而触发包自动加载。
	 */
	private createPackageOverrideSource(item: ResourceItem): PackageSource {
		const source = item.metadata.source;
		if (!isLocalPath(source)) return { source, autoload: false };
		const sourcePath = resolvePath(source, this.getTopLevelBaseDir(this.getItemScope(item)), { trim: true });
		return { source: relative(this.getTopLevelBaseDir("project"), sourcePath) || ".", autoload: false };
	}

	/** 比较两个包 source 是否指向同一目标：字符串相等即命中；均为本地路径时按各自基准目录解析后比较 */
	private packageSourceStringMatches(
		leftSource: string,
		leftScope: SettingsScope,
		rightSource: string,
		rightScope: SettingsScope,
	): boolean {
		if (leftSource === rightSource) return true;
		if (!isLocalPath(leftSource) || !isLocalPath(rightSource)) return false;
		const left = resolvePath(leftSource, this.getTopLevelBaseDir(leftScope), { trim: true });
		const right = resolvePath(rightSource, this.getTopLevelBaseDir(rightScope), { trim: true });
		return left === right;
	}

	/** 在指定作用域的 settings.packages 中查找与资源来源匹配的包条目 */
	private findMatchingPackageSource(item: ResourceItem, targetScope: SettingsScope): PackageSource | undefined {
		const settings =
			targetScope === "project"
				? this.settingsManager.getProjectSettings()
				: this.settingsManager.getGlobalSettings();
		return (settings.packages ?? []).find((pkg) =>
			this.packageSourceStringMatches(
				item.metadata.source,
				this.getItemScope(item),
				typeof pkg === "string" ? pkg : pkg.source,
				targetScope,
			),
		);
	}

	/** 剥掉模式条目的 `!/+/-` 前缀，得到它指向的目标模式串 */
	private getPatternEntryTarget(entry: string): string {
		return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-") ? entry.slice(1) : entry;
	}

	/** 生成资源唯一键（资源类型 + 规范化路径），用于继承态快照的索引 */
	private getResourceItemKey(item: ResourceItem): string {
		return `${item.resourceType}:${canonicalizePath(item.path)}`;
	}

	/** 资源所属的 settings 作用域（temporary 等非 project 的情况一律归入 user） */
	private getItemScope(item: ResourceItem): SettingsScope {
		return item.metadata.scope === "project" ? "project" : "user";
	}

	/** 顶层资源的基准目录：project 作用域为 `cwd/.agent`，user 作用域为全局 agentDir */
	private getTopLevelBaseDir(scope: "user" | "project"): string {
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}

	/** 生成顶层资源的模式串（相对其基准目录的路径） */
	private getResourcePattern(item: ResourceItem): string {
		const scope = item.metadata.scope as "user" | "project";
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(scope);
		return relative(baseDir, item.path);
	}

	/** 生成包内资源的模式串（相对包根目录；缺省以资源父目录为基准） */
	private getPackageResourcePattern(item: ResourceItem): string {
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		return relative(baseDir, item.path);
	}
}

/**
 * 对外导出的配置选择器容器组件：
 * 组合动态边框、头部提示（ConfigSelectorHeader）与资源列表（ResourceList），
 * 并把取消/退出/勾选/切换模式等回调与焦点管理接入宿主。
 * Tab 键在 global / project 两个写作用域之间切换。
 */
export class ConfigSelectorComponent extends Container implements Focusable {
	/** 顶部标题/提示栏 */
	private header: ConfigSelectorHeader;
	/** 资源列表主体 */
	private resourceList: ResourceList;
	/** 当前写入作用域 */
	private writeScope: ConfigWriteScope;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		// 焦点变化同步转发给资源列表（列表再转发给其搜索框）
		this.resourceList.focused = value;
	}

	/**
	 * @param resolvedPaths 两个作用域各自的资源解析结果
	 * @param settingsManager settings 读写句柄
	 * @param cwd 当前工作目录（项目级 settings 的基准）
	 * @param agentDir 全局 agent 配置目录（用户级 settings 的基准）
	 * @param onClose esc 取消回调
	 * @param onExit ctrl+c 退出回调
	 * @param requestRender 请求宿主重绘（勾选/切换模式后调用）
	 * @param terminalHeight 终端高度（决定列表可见行数），缺省按 24 行估算
	 * @param writeScope 初始写入作用域，默认 global
	 * @param projectModeAvailable 是否允许 Tab 切换项目模式
	 */
	constructor(
		resolvedPaths: ScopedResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
		terminalHeight?: number,
		writeScope: ConfigWriteScope = "global",
		projectModeAvailable = true,
	) {
		super();

		this.writeScope = writeScope;
		// 两个作用域各自构建分组树，列表切换模式时直接取对应副本
		const groupsByScope = {
			global: buildGroups(resolvedPaths.global, agentDir),
			project: buildGroups(resolvedPaths.project, agentDir),
		};

		// 顶部：留白 + 边框 + 留白 + 头部提示 + 留白
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.header = new ConfigSelectorHeader(this.writeScope, projectModeAvailable);
		this.addChild(this.header);
		this.addChild(new Spacer(1));

		// 资源列表主体，并接好取消/退出/勾选/切换模式回调
		this.resourceList = new ResourceList(
			groupsByScope,
			settingsManager,
			cwd,
			agentDir,
			terminalHeight,
			this.writeScope,
		);
		// 接线各类回调：取消/退出透传宿主；勾选后请求重绘；可用时 Tab 切换写作用域
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = () => requestRender();
		if (projectModeAvailable) {
			this.resourceList.onSwitchMode = () => {
				this.switchWriteScope();
				requestRender();
			};
		}
		this.addChild(this.resourceList);

		// 底部：留白 + 下边框
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/** 在 global/project 写作用域间切换，并同步头部与列表 */
	private switchWriteScope(): void {
		this.writeScope = this.writeScope === "global" ? "project" : "global";
		this.header.setWriteScope(this.writeScope);
		this.resourceList.setWriteScope(this.writeScope);
	}

	/** 暴露内部列表（供宿主在勾选后同步单项状态或读取选中信息） */
	getResourceList(): ResourceList {
		return this.resourceList;
	}
}
