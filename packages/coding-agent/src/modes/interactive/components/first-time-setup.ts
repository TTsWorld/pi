/**
 * @file first-time-setup.ts —— 首次启动设置向导
 *
 * @description
 * 用户第一次运行 CLI 时弹出的两步向导组件：
 * 第一步选择主题（dark/light，会即时预览），第二步选择是否共享匿名使用数据，
 * 最后一次性把两项结果回传给宿主写入配置。任意一步都可取消（跳过设置）。
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** 向导完成时收集到的用户选择结果。 */
export interface FirstTimeSetupResult {
	theme: TerminalTheme; // 用户选定的终端主题
	shareAnalytics: boolean; // 是否同意共享匿名使用数据
}

/** 首次设置向导的宿主回调与初始参数。 */
export interface FirstTimeSetupOptions {
	detectedTheme: TerminalTheme; // 从系统外观探测到的主题，作为默认选中项
	onThemePreview: (themeName: TerminalTheme) => void; // 切换主题选项时即时预览
	onSubmit: (result: FirstTimeSetupResult) => void; // 完成两步后提交结果
	onCancel: () => void; // 取消/跳过设置
}

// 第一步的主题选项（顺序即展示顺序）
const THEME_OPTIONS: Array<{ value: TerminalTheme; label: string }> = [
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

// 第二步的匿名数据共享选项
const ANALYTICS_OPTIONS: Array<{ value: boolean; label: string }> = [
	{ value: true, label: "Share anonymous usage data" },
	{ value: false, label: "Don't share" },
];

// 向导弹出的 ASCII 装饰 logo（逐行拼出品牌图形）
const SETUP_LOGO_LINES = ["██████", "██  ██", "████  ██", "██    ██"];

/**
 * 首次启动设置对话框：选择主题 + 匿名数据共享开关。
 *
 * 两步共用一个组件：内部以 step 字段区分 "theme" / "analytics" 阶段，
 * 每次交互后整体重建子组件（这样主题预览能让所有文字立即换色）。
 */
export class FirstTimeSetupComponent extends Container {
	private step: "theme" | "analytics" = "theme"; // 当前向导步骤：先主题，后数据共享
	private themeIndex: number;
	private analyticsIndex = 0;
	private readonly options: FirstTimeSetupOptions;

	/** 构造：以探测到的系统主题作为默认选中项，并完成首次渲染。 */
	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		// 找不到匹配项时 findIndex 返回 -1，Math.max(0, -1) 兜底为第 0 项
		this.themeIndex = Math.max(
			0,
			THEME_OPTIONS.findIndex((option) => option.value === options.detectedTheme),
		);
		this.update();
	}

	// 每次变化都整体重建对话框：因为主题预览需要让已渲染的所有文字立即重新着色，
	// 局部更新做不到，索性全量重绘
	private update(): void {
		this.clear();
		// 外框：上边框 + 空行留白
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", SETUP_LOGO_LINES.join("\n")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}, the minimal coding agent.`)), 1, 0),
		);
		this.addChild(new Spacer(1));

		// ===== 按当前步骤渲染主体：主题选择 或 数据共享选择 =====
		if (this.step === "theme") {
			this.addChild(new Text(theme.fg("text", "Pick a theme."), 1, 0));
			this.addChild(new Text(theme.fg("muted", `Detected system appearance: ${this.options.detectedTheme}`), 1, 0));
			this.addChild(new Spacer(1));
			this.addOptionList(
				THEME_OPTIONS.map((option) => option.label),
				this.themeIndex,
			);
		} else {
			this.addChild(new Text(theme.fg("text", "Opt-in to anonymous usage data sharing?"), 1, 0));
			this.addChild(
				new Text(
					theme.fg(
						"muted",
						"Opting in stores a tracking identifier in settings.json and enables anonymous\nusage analytics. This helps us to better debug, reproduce, and resolve issues\nand bugs within Pi. You can observe what is shared using /privacy and make\nchanges anytime in settings.json.",
					),
					1,
					0,
				),
			);
			this.addChild(new Spacer(1));
			this.addOptionList(
				ANALYTICS_OPTIONS.map((option) => option.label),
				this.analyticsIndex,
			);
		}

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", this.step === "theme" ? "continue" : "finish") +
					"  " +
					keyHint("tui.select.cancel", "skip setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	/** 渲染单选选项列表：选中项前缀 "→ " 并着色，未选中项普通文本缩进对齐。 */
	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", labels[i]) : theme.fg("text", labels[i]);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	/**
	 * 按位移量（±1）移动当前步骤的选中项，并触发重绘。
	 * 主题步骤中选中项真正变化时还会调用 onThemePreview 做即时预览。
	 */
	private moveSelection(delta: number): void {
		if (this.step === "theme") {
			// 夹在选项范围内；仅在索引变化时才触发主题预览，避免重复回调
			const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
			if (next !== this.themeIndex) {
				this.themeIndex = next;
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
			}
		} else {
			this.analyticsIndex = Math.max(0, Math.min(ANALYTICS_OPTIONS.length - 1, this.analyticsIndex + delta));
		}
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// 上下移动：方向键之外额外兼容 vim 风格的 j/k
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			// 确认：主题步 -> 进入数据分析步；最后一步 -> 汇总提交
			if (this.step === "theme") {
				this.step = "analytics";
				this.update();
			} else {
				this.options.onSubmit({
					theme: THEME_OPTIONS[this.themeIndex].value,
					shareAnalytics: ANALYTICS_OPTIONS[this.analyticsIndex].value,
				});
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
