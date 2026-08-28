/**
 * @file oauth-selector.ts —— 认证 provider 选择组件（OAuth 订阅 / API key）
 *
 * @description
 * 本文件实现登录与登出流程共用的「认证 provider 选择器」TUI 组件：
 * `OAuthSelectorComponent` 以可滚动列表展示全部候选 provider，顶部内置
 * 搜索输入框，支持按「名称 + ID + 认证方式 + 方法名」模糊过滤；
 * 键盘交互包括上下移动选中项、Enter 确认、Escape/Ctrl+C 取消，
 * 其余按键交给搜索框并即时重新过滤。每个条目还会依据 `AuthCheck`
 * 状态渲染「✓ configured / unconfigured / env: XXX」等配置状态指示。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：认证类型（ApiKeyAuth / OAuthAuth / AuthCheck）；
 * - `@earendil-works/pi-tui`：Container / Input / TruncatedText 等 TUI 基础组件，
 *   以及 fuzzyFilter（模糊过滤）与 getKeybindings（统一键位绑定）；
 * - `../theme/theme.ts`：主题配色；
 * - `./dynamic-border.ts`：随终端宽度自适应的动态边框。
 */
import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@earendil-works/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	TruncatedText,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/**
 * 认证选择器中单个 provider 的数据模型：标识、展示名、认证方式及当前配置状态。
 */
export type AuthSelectorProvider = {
	/** provider 唯一标识（如 "anthropic"） */
	id: string;
	/** 展示给用户的 provider 名称 */
	name: string;
	/** 该条目支持的认证方式：OAuth 订阅或 API key */
	authType: "oauth" | "api_key";
	/** 对应的认证方法描述（其名称参与模糊搜索匹配） */
	method?: ApiKeyAuth | OAuthAuth;
	/** 当前认证状态检查结果；缺省视为「未配置」 */
	status?: AuthCheck;
};

/**
 * 将认证方式映射为用户可读的标签：OAuth 显示为 "subscription"（订阅），API key 保持原样。
 *
 * @param authType - 认证方式
 * @returns 列表条目中展示的类型标签文本
 */
export function formatAuthSelectorProviderType(authType: AuthSelectorProvider["authType"]): string {
	return authType === "oauth" ? "subscription" : "API key";
}

/**
 * 渲染认证 provider 选择器的 TUI 组件（登录/登出共用）。
 *
 * 结构自上而下为：动态边框 → 标题 → 搜索框 → 可滚动列表 → 动态边框；
 * 实现 Focusable 接口以接收按键，并按统一键位绑定处理导航与确认/取消。
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable 接口实现——把焦点状态透传给搜索输入框，以便输入法（IME）正确定位光标
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	/** 全量 provider（未过滤） */
	private allProviders: AuthSelectorProvider[];
	/** 按当前搜索词过滤后的 provider（列表实际渲染的数据源） */
	private filteredProviders: AuthSelectorProvider[];
	/** 当前选中项索引（相对 filteredProviders） */
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private onSelectCallback: (providerId: string, authType: AuthSelectorProvider["authType"]) => void;
	private onCancelCallback: () => void;
	/** 仅当候选中同时存在多种认证方式时才展示类型标签，避免单一方式时的视觉噪音 */
	private showAuthTypeLabels: boolean;

	/**
	 * @param mode - 组件用途：login（选择要配置的 provider）或 logout（选择要登出的 provider）
	 * @param providers - 候选 provider 列表
	 * @param onSelect - 选中确认回调，携带 provider id 与其认证方式
	 * @param onCancel - 取消回调（Escape / Ctrl+C）
	 * @param initialSearchInput - 可选的初始搜索词，用于预填搜索框并完成首次过滤
	 */
	constructor(
		mode: "login" | "logout",
		providers: AuthSelectorProvider[],
		onSelect: (providerId: string, authType: AuthSelectorProvider["authType"]) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.mode = mode;
		this.allProviders = providers;
		this.filteredProviders = providers;
		// 候选中认证方式种类数大于 1 时才需要展示类型标签
		this.showAuthTypeLabels = new Set(providers.map((provider) => provider.authType)).size > 1;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// 顶部边框
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// 标题（按登录/登出模式区分文案）
		const title = mode === "login" ? "Select provider to configure:" : "Select provider to logout:";
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		// 在搜索框内直接回车：确认当前选中项（列表非空时）
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// 列表容器：条目行在每次 updateList 时整体重建
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// 底部边框
		this.addChild(new DynamicBorder());

		// 初始渲染：依据初始搜索词完成首次过滤
		this.filterProviders(initialSearchInput ?? "");
	}

	/**
	 * 按搜索词过滤 provider 并重建列表。
	 *
	 * 匹配对象为「名称 + ID + 认证方式 + 方法名」的拼接文本（fuzzyFilter 模糊匹配）；
	 * 空查询直接返回全量列表。过滤后将选中索引钳制回有效范围，
	 * 避免沿用已被过滤掉的旧位置导致越界。
	 */
	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(
					this.allProviders,
					query,
					(provider) => `${provider.name} ${provider.id} ${provider.authType} ${provider.method?.name ?? ""}`,
				)
			: this.allProviders;
		// 将选中索引钳制到 [0, filteredProviders.length - 1]
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	/**
	 * 重建列表可视区域。
	 *
	 * 以选中项为中心截取一个最多 8 行的滚动窗口（选中项靠近列表边缘时窗口贴边）；
	 * 列表被截断时追加「第 n/总数」滚动提示；过滤结果为空时展示空态文案。
	 */
	private updateList(): void {
		this.listContainer.clear();

		// 可视窗口最多显示 8 行（魔法数字：滚动列表高度）
		const maxVisible = 8;
		// 让选中项尽量落在窗口中间；滚动到列表底部时窗口贴底而非越界
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			const statusIndicator = this.formatStatusIndicator(provider);
			const authTypeLabel = this.showAuthTypeLabels
				? theme.fg("muted", ` [${formatAuthSelectorProviderType(provider.authType)}]`)
				: "";
			let line = "";
			// 选中行：箭头前缀 + 强调色高亮；未选中行：两个空格占位以保持缩进对齐
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const text = theme.fg("accent", provider.name);
				line = prefix + text + authTypeLabel + statusIndicator;
			} else {
				const text = `  ${theme.fg("text", provider.name)}`;
				line = text + authTypeLabel + statusIndicator;
			}

			this.listContainer.addChild(new TruncatedText(line, 1, 0));
		}

		// 列表上/下被截断时，追加「当前位置/总数」滚动提示
		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		// 空态：区分「本身没有任何 provider」与「搜索无匹配」两种文案
		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers logged in. Use /login first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `  ${message}`), 1, 0));
		}
	}

	/**
	 * 生成 provider 条目右侧的配置状态指示文本。
	 *
	 * 规则（按优先级）：
	 * - 无状态信息 → 「unconfigured」；
	 * - 状态的认证类型与条目声明的 authType 不一致 → 以 warning 色提示
	 *   已用另一种方式配置（如条目是 OAuth 但实际配了 API key）；
	 * - 来源为空 / OAuth / 存储凭据 → 统一显示「✓ configured」；
	 * - 其余来源：若形如环境变量名列表则加 "env: " 前缀展示。
	 */
	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		if (!provider.status) return theme.fg("muted", " • unconfigured");
		if (provider.status.type !== provider.authType) {
			const label = provider.status.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("muted", " • ") + theme.fg("warning", label);
		}
		if (
			!provider.status.source ||
			provider.status.source === "OAuth" ||
			provider.status.source === "stored credential"
		) {
			return theme.fg("success", " ✓ configured");
		}
		// 匹配「全大写蛇形标识符（可逗号分隔多个）」即环境变量名列表，展示时加 env: 前缀
		const source = /^[A-Z][A-Z0-9_]*(?:, [A-Z][A-Z0-9_]*)*$/.test(provider.status.source)
			? `env: ${provider.status.source}`
			: provider.status.source;
		return theme.fg("success", ` ✓ ${source}`);
	}

	/**
	 * 处理按键输入（Focusable 协议入口）。
	 *
	 * 优先匹配列表导航键位：上/下移动选中项、Enter 确认、Escape 或 Ctrl+C 取消；
	 * 其余按键（可打印字符、退格等）交给搜索框，并按最新输入即时重新过滤列表。
	 *
	 * @param keyData - 原始终端按键序列
	 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// 上方向键
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// 下方向键
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		}
		// 回车确认
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider.id, selectedProvider.authType);
			}
		}
		// Escape 或 Ctrl+C 取消
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// 其余按键交给搜索框处理，并按新输入重新过滤
		else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}
}
