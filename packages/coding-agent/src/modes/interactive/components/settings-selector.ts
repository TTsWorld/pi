/**
 * @file settings-selector.ts —— TUI 主设置面板组件（设置项浏览与修改界面）
 *
 * @description
 * 本文件实现交互模式下的主设置选择器 `SettingsSelectorComponent` 及其子菜单：
 * 把全部可配置项（上下文自动压缩、图片显示、消息流推送、网络传输、主题、
 * 每模型思考等级……）组装成一个可搜索的 SettingsList；用户修改某项后，
 * 经 `SettingsCallbacks` 中的对应回调实时通知宿主持久化到 settings-manager。
 *
 * 主要组成：
 * - `SettingsConfig` / `SettingsCallbacks`：设置快照与变更回调的契约定义；
 * - `WarningSettingsSubmenu`：各告警开关的列表子菜单；
 * - `ThemeSubmenu`：主题子菜单，支持单一主题与浅色/深色自动切换两种模式，带实时预览与取消回滚；
 * - 一组模型/主题相关的纯函数工具（配置键生成、标签渲染、覆写摘要等）；
 * - `SettingsSelectorComponent`：主组件，按终端能力与分组顺序组装设置项，并把选值分发到各回调。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：Container / SettingsList / Text 等基础组件与 SettingItem 类型；
 * - `./settings-submenu.ts`：SelectSubmenu / SteppedSubmenu 通用子菜单实现；
 * - `../../../core/settings-manager.ts`：各设置项的类型定义；`../theme/theme.ts`：主题解析与配色。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getSupportedThinkingLevels, type Model, type Transport } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	getCapabilities,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type {
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	TuiMode,
	WarningSettings,
} from "../../../core/settings-manager.ts";
import { getSettingsListTheme, parseAutoThemeSetting, type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";

/** 模型选择器（SteppedSubmenu）的列宽约束：主列（模型名）最小/最大宽度，防止长模型名把描述列挤没 */
const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

/** 各思考等级（ThinkingLevel）对应的人可读描述，展示在等级选择列表中（括号内为近似 token 预算） */
const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

/** 项目信任默认策略（DefaultProjectTrust）→ 界面标签的映射；设置列表以标签作为可选值展示 */
const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "Ask",
	always: "Always trust",
	never: "Never trust",
};

/** 上表的反向映射（标签 → 策略值），用于用户选中某标签后反查回设置值 */
const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

/**
 * 设置选择器的输入配置快照：当前所有设置项的值，以及渲染所需的上下文
 * （可用模型列表、可用主题列表、当前终端实际生效的浅色/深色外观等）。
 * 由宿主在打开面板前从 settings-manager 与运行时状态汇总而来，组件只读。
 */
export interface SettingsConfig {
	// ---- 上下文与模型 ----
	autoCompact: boolean;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	// ---- 图片处理 ----
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	// ---- 消息流推送与网络传输 ----
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	// ---- 推理（思考）等级 ----
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	// ---- 主题 ----
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	// ---- 转录显示 ----
	hideThinkingBlock: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	enableInstallTelemetry: boolean;
	// ---- 快捷键与导航 ----
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	// ---- 终端 UI 细节 ----
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	// ---- 全屏模式 ----
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	// ---- 告警开关 ----
	warnings: WarningSettings;
}

/**
 * 设置项变更回调集合：每个设置项对应一个 on*Change 回调，由宿主提供。
 * 组件在用户改值时调用对应回调，宿主负责持久化设置并同步运行时状态。
 * `onCancel` 在用户退出设置界面时触发。
 */
export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onEnableInstallTelemetryChange: (enabled: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

/**
 * 告警设置子菜单：以列表形式展示可独立开关的告警项（如 Anthropic 额外用量提醒）。
 * 内部维护一份状态副本，每次切换都以新对象整体回调给宿主，避免外部状态被就地修改。
 */
class WarningSettingsSubmenu extends Container {
	/** 内部设置列表（唯一的子组件，承接渲染与键盘输入） */
	private settingsList: SettingsList;
	/** 本地维护的告警状态副本 */
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		// 本地副本：子菜单内的修改先记在这里，每次整体回调
		this.state = { ...warnings };

		// 当前仅一条告警项；新增告警开关时在此追加
		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic extra usage",
				description: "Warn when Anthropic subscription auth may use paid extra usage",
				currentValue: (this.state.anthropicExtraUsage ?? true) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		// 可见行数上限取条目数与 10 的较小值：条目少时不预留空白行
		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	/** 键盘输入直接转发给内部列表 */
	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

/** “清除该模型的思考等级覆写”在等级列表中的哨兵值（正常等级名不会是双下划线包裹的格式） */
const CLEAR_OVERRIDE_VALUE = "__clear__";

/** 生成模型的配置键：`provider/modelId`，作为 modelThinkingOverrides 等映射的统一键 */
function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

/** 生成模型的纯文本展示名：`modelId [provider]`，用于子菜单标题等不含 ANSI 样式的场景 */
function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

/** 汇总思考等级覆写的数量，作为设置项的当前值展示（“none” 或 “N configured”） */
function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return "none";
	return `${count} configured`;
}

/** 生成带供应商着色（muted 色）的模型列表项文本；返回值含 ANSI 样式，仅用于渲染 */
function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

/** 把主题名列表转为 SelectSubmenu 所需的选项（值与标签均为主题名） */
function themeItems(availableThemes: string[]): SelectItem[] {
	return availableThemes.map((name) => ({ value: name, label: name }));
}

/** 自动主题模式的哨兵值：主题设置中用 `/` 表示自动模式（正常主题名不含 `/`） */
const AUTOMATIC_THEME_VALUE = "/";

/** 构建单一主题模式的选项：在所有主题之前额外插入一项 “Automatic”（跟随终端浅色/深色外观） */
function singleModeThemeItems(availableThemes: string[]): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "Automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...themeItems(availableThemes),
	];
}

/**
 * 从偏好主题与后备中挑一个仍可用的主题：
 * 优先用 preferred，其次用 fallback，都不可用时退回列表首项（列表为空才强制用 fallback）。
 */
function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

/**
 * 从当前主题设置推导自动模式的初始浅色/深色主题：
 * 若设置已是 `light/dark` 形式则直接解析；否则把现有单一主题同时作为两者的初值。
 */
function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	// 设置已是 `light/dark` 自动格式时不存在“单一主题”可继承
	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

/**
 * 主题子菜单：管理“单一主题”与“自动（浅色/深色分别配置）”两种模式的切换与预览。
 *
 * 工作原理：内部维护当前模式与三个主题枚举值（single/light/dark）；
 * 浏览过程中的任何选择都先通过 onThemePreview 实时预览，只有点 Apply
 * （或单一模式下直接选定）才通过 onDone 提交；取消时恢复进入前的
 * originalThemeSetting 预览，保证预览不留残留。
 */
class ThemeSubmenu extends Container {
	/** 当前接收键盘输入的组件（由 setContent 维护，可能与渲染组件不同） */
	private inputComponent: Component | undefined;
	/** 宿主回调集合（这里只用 onThemePreview 做实时预览） */
	private readonly callbacks: SettingsCallbacks;
	/** 可选主题名列表 */
	private readonly availableThemes: string[];
	/** 终端当前实际外观（light/dark），自动模式据此取当前应生效的主题 */
	private readonly terminalTheme: TerminalTheme;
	/** 结束回调：带值 = 提交，无值 = 取消 */
	private readonly onDone: (selectedValue?: string) => void;
	/** 进入子菜单前的原始主题设置，取消时用于恢复预览 */
	private readonly originalThemeSetting: string;
	/** 当前模式：单一主题 / 自动（浅深色分别配置） */
	private mode: "single" | "automatic";
	/** 单一模式下选中的主题名 */
	private singleTheme: string;
	/** 自动模式下的浅色主题名 */
	private lightTheme: string;
	/** 自动模式下的深色主题名 */
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		// 解析现有设置：`light/dark` 形式 → 进入自动模式；否则视为单一主题
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		// 单一模式初值：继承原单一主题；从自动模式切过来时取当前外观对应的那个
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		// 按初始模式直接进入对应页面
		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	/** 键盘输入转发给当前活跃的输入组件（可能与渲染组件不同，见 setContent） */
	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	/**
	 * 替换当前展示内容；渲染组件与接收键盘输入的组件可以不同
	 * （例如自动模式页面的输入要交给内部的 SettingsList 而非外层容器）。
	 */
	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	/** 展示单一主题选择菜单；选中 “Automatic” 时切换到自动模式 */
	private showSingleMenu(): void {
		this.mode = "single";
		// 选中普通主题即直接提交；选 “Automatic” 则先按当前设置预览再切到自动模式页面；
		// 最后一个回调在高亮移动时触发，用于实时预览而不落盘
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose Automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	/** 展示自动模式页：分别配置浅色/深色主题，并提供 Apply（保存返回）与切回单一模式的入口 */
	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.callbacks.onThemePreview?.(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		// “Change mode” 取当前外观对应的主题切回单一模式；“Apply” 才真正保存自动模式设置
		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	/** 构建一个主题二级选择菜单（浅色/深色各用一个）；取消时回退到进入前的预览状态 */
	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	/** 按当前模式计算将要提交的主题设置串 */
	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	/** 自动模式下根据终端当前外观（light/dark）取对应主题 */
	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	/** 拼接自动模式设置串：`浅色主题/深色主题` */
	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	/** 提交主题设置并结束子菜单 */
	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	/** 取消：恢复原始设置的预览后以无值结束（不提交任何改动） */
	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * 主设置选择器组件：构建全部设置项列表并承接值变更分发。
 *
 * 构造流程：先写入无条件展示的静态设置项，再按依赖顺序用 splice 插入
 * 条件项（依赖终端能力，且位置依附于前一项）；SettingsList 的回调按 id
 * 把新值转换回类型化参数后分发到 SettingsCallbacks 的对应回调。
 */
export class SettingsSelectorComponent extends Container {
	/** 主设置列表（唯一交互子组件，含搜索） */
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		// ===== 构造期局部状态 =====
		const supportsImages = getCapabilities().images;
		// 快捷键展示名，用于设置项描述里的动态文案
		const followUpKey = keyDisplayText("app.message.followUp");
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		// 这两个闭包变量是子菜单的“会话内状态”：面板打开期间的中间修改都记在这里，
		// 重新进入子菜单时才能看到刚才的改动，同时通过回调实时同步给宿主
		let currentWarnings = { ...config.warnings };
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		// 配置键 provider/modelId → Model 元数据的查找表，供子菜单按键反查
		const defaultModelByValue = new Map(
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		// defaultModel 必须是已知模型的键才参与列表预选，否则不预选任何项
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		// ===== 无条件展示的静态设置项 =====
		const items: SettingItem[] = [
			// 上下文过大时自动压缩历史
			{
				id: "autocompact",
				label: "Auto-compact",
				description: "Automatically compact context when it gets too large",
				currentValue: config.autoCompact ? "true" : "false",
				values: ["true", "false"],
			},
			// 流式输出期间按 Enter 插入的 steering 消息如何投递
			{
				id: "steering-mode",
				label: "Steering mode",
				description:
					"Enter while streaming queues steering messages. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.",
				currentValue: config.steeringMode,
				values: ["one-at-a-time", "all"],
			},
			{
				id: "follow-up-mode",
				label: "Follow-up mode",
				description: `${followUpKey} queues follow-up messages until agent stops. 'one-at-a-time': deliver one, wait for response. 'all': deliver all at once.`,
				currentValue: config.followUpMode,
				values: ["one-at-a-time", "all"],
			},
			// 传输协议偏好与 HTTP 空闲超时（本地模型可能需要更长或关闭）
			{
				id: "transport",
				label: "Transport",
				description: "Preferred transport for providers that support multiple transports",
				currentValue: config.transport,
				values: ["sse", "websocket", "websocket-cached", "auto"],
			},
			{
				id: "http-idle-timeout",
				label: "HTTP idle timeout",
				description:
					"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			// 转录显示：隐藏思考块、Mermaid 渲染、缓存未命中提示等
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: config.hideThinkingBlock ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: config.mermaidRenderingMode,
				values: ["off", "final", "streaming"],
			},
			{
				id: "cache-miss-notices",
				label: "Cache miss notices",
				description: "Show transcript notices for significant prompt-cache misses and compaction costs",
				currentValue: config.showCacheMissNotices ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "collapse-changelog",
				label: "Collapse changelog",
				description: "Show condensed changelog after updates",
				currentValue: config.collapseChangelog ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup",
				currentValue: config.quietStartup ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "install-telemetry",
				label: "Install telemetry",
				description: "Send an anonymous version/update ping after changelog-detected updates",
				currentValue: config.enableInstallTelemetry ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "default-project-trust",
				label: "Default project trust",
				description: "Fallback behavior when no extension or saved trust decision decides project trust",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			// 空编辑器下双击 Esc 的动作与 /tree 默认过滤器
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: config.doubleEscapeAction,
				values: ["tree", "fork", "none"],
			},
			{
				id: "tree-filter-mode",
				label: "Tree filter mode",
				description: "Default filter when opening /tree",
				currentValue: config.treeFilterMode,
				values: ["default", "no-tools", "user-only", "labeled-only", "all"],
			},
			// 告警子菜单：每次修改即时经 onWarningsChange 同步到本地闭包与宿主
			{
				id: "warnings",
				label: "Warnings",
				description: "Enable or disable individual warnings",
				currentValue: "configure",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			// 每模型思考等级覆写：两步式子菜单（先选模型，再选该模型的默认等级）
			{
				id: "model-thinking",
				label: "Default thinking level per model",
				description: `Override the default thinking level for specific models. ${cycleThinkingKey} cycles in-session.`,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				submenu: (_currentValue, done) => {
					// 步骤一选模型、步骤二选等级；options 是惰性函数，每次进入都按最新覆写状态重算
					const steps: SteppedSubmenuStep[] = [
						{
							key: "model",
							title: "Per-Model Thinking Level",
							description: "Select a model to configure",
							options: () => {
								// 排序：当前模型置顶、其次默认模型，其余按 provider 字典序，方便快速定位
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									const aKey = modelSettingKey(a);
									const bKey = modelSettingKey(b);
									if (aKey === currentModelKey) return -1;
									if (bKey === currentModelKey) return 1;
									if (aKey === currentDefaultModelKey) return -1;
									if (bKey === currentDefaultModelKey) return 1;
									return a.provider.localeCompare(b.provider);
								});
								const items: SelectItem[] = sorted.map((model) => {
									const key = modelSettingKey(model);
									const override = currentModelThinkingLevels[key];
									return {
										value: key,
										label: modelItemLabel(model),
										description: override ?? undefined,
									};
								});
								// 无可用模型时给出占位项，提示先登录或配置 API key
								if (items.length === 0) {
									items.push({
										value: "__none__",
										label: "No models available",
										description: "Log in to a provider or configure an API key first",
									});
								}
								return items;
							},
							// 默认高亮当前模型，其次默认模型
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							// 模型较多，开启搜索过滤
							searchable: true,
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							key: "level",
							title: (ctx) => {
								const m = defaultModelByValue.get(ctx.model);
								return `Thinking Level for ${m ? modelDisplayLabel(m) : ctx.model}`;
							},
							description: "Select default thinking level for this model",
							options: (ctx) => {
								const model = defaultModelByValue.get(ctx.model);
								// 键不在查找表中（如占位项）时给出空列表
								if (!model) return [];
								// 不支持推理的模型只有 off 一档可选
								const levels = (
									model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
								) as ThinkingLevel[];
								const items: SelectItem[] = levels.map((level) => ({
									value: level,
									label: level,
									description: THINKING_DESCRIPTIONS[level],
								}));
								// 已有覆写时额外提供“清除覆写”选项，回退到全局默认等级
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									items.push({
										value: CLEAR_OVERRIDE_VALUE,
										label: "(clear override)",
										description: `Revert to global default (${config.thinkingLevel})`,
									});
								}
								return items;
							},
							// 已有覆写时高亮当前覆写值
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

					return new SteppedSubmenu(
						steps,
						(selections) => {
							const model = defaultModelByValue.get(selections.model);
							if (!model) return;
							// 哨兵值表示删除该模型的覆写；否则写入/更新覆写，并同步本地状态
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								delete currentModelThinkingLevels[selections.model];
							} else {
								callbacks.onModelThinkingLevelChange(
									model.provider,
									model.id,
									selections.level as ThinkingLevel,
								);
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						() => {
							done(summary());
						},
						// loop: 配置完一个模型后回到模型列表，便于连续配置多个
						{ loop: true },
					);
				},
			},
			// 全屏模式：布局、退出时的输出、滚动条行为
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; fullscreen mode is experimental",
				currentValue: config.tuiMode,
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: config.fullscreenExitOutput,
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: config.fullscreenScrollbar,
				values: ["auto", "always", "hidden"],
			},
			// 主题子菜单：浏览时实时预览，仅退出时经 onThemeChange 落盘一次
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// ===== 按终端能力/分组顺序条件插入的设置项 =====
		// 图片相关开关仅在终端支持图片渲染时展示
		if (supportsImages) {
			// 插入到 autocompact 之后
			items.splice(1, 0, {
				id: "show-images",
				label: "Show images",
				description: "Render images inline in terminal",
				currentValue: config.showImages ? "true" : "false",
				values: ["true", "false"],
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "Image width",
				description: "Preferred inline image width in terminal cells",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// 图片自动缩放开关（始终展示；同时作用于上传附件与工具读取的图片）
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
			currentValue: config.autoResizeImages ? "true" : "false",
			values: ["true", "false"],
		});

		// 屏蔽图片开关（始终展示，插入到 auto-resize-images 之后）
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
			currentValue: config.blockImages ? "true" : "false",
			values: ["true", "false"],
		});

		// Skill 命令开关（插入到 block-images 之后）
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
			currentValue: config.enableSkillCommands ? "true" : "false",
			values: ["true", "false"],
		});

		// 硬件光标开关（插入到 skill-commands 之后）
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
			currentValue: config.showHardwareCursor ? "true" : "false",
			values: ["true", "false"],
		});

		// 输入框内边距设置（插入到 show-hardware-cursor 之后）
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// 输出区内边距设置（插入到 editor-padding 之后）
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "Output padding",
			description: "Horizontal padding for user messages, assistant messages, and thinking",
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// 自动补全最大可见项设置（插入到 output-padding 之后）
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// 内容收缩时清屏开关（插入到 autocomplete-max-visible 之后）
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
			currentValue: config.clearOnShrink ? "true" : "false",
			values: ["true", "false"],
		});

		// 终端进度指示开关（插入到 clear-on-shrink 之后）
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
			currentValue: config.showTerminalProgress ? "true" : "false",
			values: ["true", "false"],
		});

		// 添加动态边框（此处为列表上边框，下边框在末尾添加）
		this.addChild(new DynamicBorder());

		// 最多同时显示 10 行，超出部分滚动查看
		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			// ===== 值变更分发：字符串新值逐项转换回类型化参数后交给对应回调 =====
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(newValue === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(newValue === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(newValue === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(newValue === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(newValue === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(newValue as "all" | "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(newValue as Transport);
						break;
					case "http-idle-timeout": {
						// 按界面标签反查对应选项的毫秒值
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(newValue === "true");
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(newValue as MermaidRenderingMode);
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(newValue === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(newValue === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(newValue === "true");
						break;
					case "install-telemetry":
						callbacks.onEnableInstallTelemetryChange(newValue === "true");
						break;
					case "default-project-trust": {
						// 由界面标签反查回策略值（标签不在映射中时静默忽略）
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(newValue as "fork" | "tree");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(
							newValue as "default" | "no-tools" | "user-only" | "labeled-only" | "all",
						);
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(newValue === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(newValue === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(newValue === "true");
						break;
					case "tui-mode":
						callbacks.onTuiModeChange(newValue as TuiMode);
						break;
					case "fullscreen-exit-output":
						callbacks.onFullscreenExitOutputChange(newValue as FullscreenExitOutput);
						break;
					case "fullscreen-scrollbar":
						callbacks.onFullscreenScrollbarChange(newValue as ScrollViewScrollbar);
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			// 开启设置项搜索，条目较多时快速定位
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	/** 暴露内部 SettingsList，供宿主把键盘输入转发给列表处理 */
	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
