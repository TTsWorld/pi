/**
 * @file theme-controller.ts —— 交互模式主题控制器
 *
 * @description
 * 实现 `InteractiveThemeController`：交互式 TUI 中主题生命周期的管理者，
 * 在 theme.ts 底层机制之上封装：启动初始化（支持 "light/dark" 自动明暗设置）、
 * 按设置应用主题（含终端明暗检测与高置信度结果持久化）、主题切换/预览、
 * 监听终端配色事件以自动跟随系统明暗、加载失败统一回退 dark 并报错。
 *
 * 依赖：`./theme.ts`（底层主题实现）、`core/settings-manager.ts`（设置持久化）、
 * `@earendil-works/pi-tui`（重绘失效与终端配色事件订阅）。
 */

import type { TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	detectTerminalThemeForAuto,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

/** 主题应用结果：success 为是否成功；失败时 error 携带可展示的错误说明 */
type ThemeResult = { success: boolean; error?: string };

/**
 * 交互模式主题控制器：持有当前主题设置与终端明暗状态，
 * 是 UI 层与 theme.ts 底层主题机制之间的中介。
 * 通过订阅 TUI 的终端配色事件实现「自动主题跟随终端明暗切换」。
 */
export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	/** 用户显式选择的主题设置（普通主题名或 "light/dark" 自动设置） */
	private currentThemeSetting: string | undefined;
	/** 当前终端明暗基调（构造时先用环境变量快速估计） */
	private terminalTheme: TerminalTheme = detectTerminalBackgroundFromEnv().theme;
	/** 当前实际生效的主题名（加载失败回退后为 "dark"） */
	private activeThemeName: string | undefined;
	/** 是否启用「跟随终端配色自动切换」 */
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;

	/**
	 * @param options.getSettingsManager - 惰性获取设置管理器（避免构造期强依赖）
	 * @param options.showError - 向用户展示错误信息的回调
	 * @param options.onChanged - 主题生效后的通知回调（如刷新状态栏）
	 * @param options.initialThemeSetting - 启动参数带来的初始主题设置（优先于持久化设置）
	 */
	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		// 解析出具体主题名（自动设置按当前终端明暗二选一），并开启热重载监听
		this.activeThemeName = resolveThemeSetting(
			this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting(),
			this.terminalTheme,
		);
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	/** TUI 实例更换后重新绑定配色事件监听（先退订旧实例再绑新的）。 */
	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	/**
	 * 按当前主题设置应用主题，分三种情况：
	 * 1. 自动设置（"light/dark"）：检测终端明暗后选中对应主题，并启用自动跟随；
	 * 2. 普通主题名：直接应用；
	 * 3. 未设置任何主题：按终端背景检测结果应用默认明暗主题，
	 *    且仅当检测置信度为 high 时才把结果持久化进设置。
	 */
	async applyFromSettings(): Promise<void> {
		const settingsManager = this.getSettingsManager();
		const themeSetting = this.currentThemeSetting ?? settingsManager.getThemeSetting();
		const autoTheme = parseAutoThemeSetting(themeSetting);
		if (autoTheme) {
			this.terminalTheme = await detectTerminalThemeForAuto({ ui: this.ui, timeoutMs: 100 });
			this.setAutoSync(true);
			this.applyThemeName(this.terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme, true);
			return;
		}

		this.setAutoSync(false);
		if (themeSetting !== undefined) {
			this.applyThemeName(themeSetting, true);
			return;
		}

		// 无任何设置：检测终端背景明暗，按结果应用 light/dark
		const detection = await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 });
		this.terminalTheme = detection.theme;
		if (!this.applyThemeName(detection.theme).success) return;
		// 只有高置信度检测结果才值得写回设置（low 只是兜底猜测）
		if (detection.confidence === "high") {
			settingsManager.setTheme(detection.theme);
			await settingsManager.flush();
		}
	}

	/** 获取当前主题选择（用于 UI 展示）：显式设置 > 持久化设置 > 实际生效主题名。 */
	getThemeSelection(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	/**
	 * 切换到指定主题名（如 /theme 命令）。成功时记住该选择；
	 * 失败时可选通过 showError 报错。显式选择会关闭自动跟随。
	 */
	setThemeName(themeName: string, showError = false): ThemeResult {
		this.setAutoSync(false);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	/** 更新主题设置（普通主题名或 "light/dark" 自动设置）并立即生效。 */
	async setThemeSetting(themeSetting: string): Promise<void> {
		this.currentThemeSetting = themeSetting;
		await this.applyFromSettings();
	}

	/** 直接安装一个内存中的 Theme 实例（如主题编辑器预览），activeThemeName 标记为 "<in-memory>"。 */
	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	/**
	 * 临时预览某个主题设置/主题名（不写入 currentThemeSetting）：
	 * 解析出主题名后即刻切换并请求重绘，供设置界面实时预览。
	 */
	preview(themeSettingOrName: string): void {
		const themeName = resolveThemeSetting(themeSettingOrName, this.terminalTheme) ?? this.activeThemeName;
		if (!themeName) return;
		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	/** 关闭自动跟随（终端配色变化不再触发主题切换）。 */
	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	/** 当前终端明暗基调。 */
	getTerminalTheme(): TerminalTheme {
		return this.terminalTheme;
	}

	/**
	 * 按名称应用主题并刷新 UI。加载失败时回退到 dark：
	 * activeThemeName 记录回退后的实际主题名，showError 时向用户报告原因。
	 */
	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : "dark";
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
		}
		return result;
	}

	/** 通知主题已变化：使 TUI 全量失效并触发外部 onChanged 回调。 */
	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}

	/** 开关自动跟随；状态变化时同步 TUI 的配色事件上报开关（幂等）。 */
	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	/** 订阅 TUI 的终端配色变化事件（保存退订函数供 rebindTui 使用）。 */
	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalTheme(terminalTheme),
		);
	}

	/**
	 * 终端配色变化事件处理：仅在自动跟随开启且设置仍是
	 * "light/dark" 自动格式时，切换到与新明暗对应的主题；
	 * 设置已不是自动格式则自动关闭跟随。
	 */
	private applyTerminalTheme(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		this.terminalTheme = terminalTheme;
		const autoTheme = parseAutoThemeSetting(this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting());
		if (!autoTheme) {
			this.setAutoSync(false);
			return;
		}
		const themeName = terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
		// 主题没变就不必重载（避免无谓的全量重绘）
		if (themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}
}
