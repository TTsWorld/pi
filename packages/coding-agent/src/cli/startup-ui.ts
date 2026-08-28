/**
 * @file startup-ui.ts —— 启动阶段（进入正式界面之前）的终端 UI
 *
 * @description
 * 在 CLI 启动早期搭建临时 TUI，展示轻量交互对话框：showStartupSelector（选项选择）、
 * showFirstTimeSetup（首次设置向导）、showStartupInput（单行输入）。这些对话框出现在
 * 主界面（interactive 模式的完整 TUI）建立之前，因此自带精简的临时 TUI 生命周期管理
 * （创建 → 交互 → 清理 → stop），并负责启动期主题加载与终端深/浅色自动探测。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：终端 UI 框架（ProcessTerminal / TuiMainScreen / 快捷键）；
 * - `../config.ts` 与 `../core/*`：配置常量、设置管理、包管理器、快捷键管理；
 * - `../modes/interactive/*`：主题系统与对话框组件（选择器 / 输入框 / 首次设置向导）。
 */

import { ProcessTerminal, setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { existsSync } from "fs";
import { APP_NAME, CONFIG_DIR_NAME, ENV_AGENT_DIR, getAgentDir, getSettingsPath, PACKAGE_NAME } from "../config.ts";
import { areExperimentalFeaturesEnabled } from "../core/experimental.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import { DefaultPackageManager, type ResolvedResource } from "../core/package-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "../modes/interactive/components/first-time-setup.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalThemeForAuto,
	initTheme,
	loadThemeFromPath,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setRegisteredThemes,
	setTheme,
	type Theme,
} from "../modes/interactive/theme/theme.ts";

// 官方 Pi 发行版的标识三元组；fork / 换皮发行版会替换其中若干项，
// 据此把「官方专属流程」（如首次设置向导）限制在官方分发版中运行
const OFFICIAL_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const OFFICIAL_APP_NAME = "pi";
const OFFICIAL_CONFIG_DIR_NAME = ".pi";

/** 发行版元数据：npm 包名、应用名、配置目录名，三项组合唯一标识一个发行版 */
interface DistributionMetadata {
	packageName: string;
	appName: string;
	configDirName: string;
}

/**
 * 判断当前运行的发行版是否为官方 Pi（而非 fork / 换皮版）。
 * @param metadata - 由 config.ts 常量组成的当前发行版元数据
 * @returns 三项均与官方一致时为 true
 */
function isOfficialDistribution({ packageName, appName, configDirName }: DistributionMetadata): boolean {
	return (
		packageName === OFFICIAL_PACKAGE_NAME &&
		appName === OFFICIAL_APP_NAME &&
		configDirName === OFFICIAL_CONFIG_DIR_NAME
	);
}

/**
 * 从已解析的主题资源列表加载主题（用于启动期注册）；
 * 同名主题先到先得，后续重名直接跳过。
 *
 * @param resources - 包管理器解析出的已启用资源
 * @returns 去重后的主题数组
 */
function loadThemes(resources: ResolvedResource[]): Theme[] {
	const themes: Theme[] = [];
	const seen = new Set<string>();
	for (const resource of resources) {
		if (!resource.enabled) continue;
		try {
			const loadedTheme = loadThemeFromPath(resource.path);
			if (loadedTheme.name) {
				if (seen.has(loadedTheme.name)) continue;
				seen.add(loadedTheme.name);
			}
			themes.push(loadedTheme);
		} catch {
			// 坏主题在此静默跳过：启动期提示不应因主题损坏而失败，
			// 主题诊断由稍后启动流程中的常规资源加载器统一上报。
		}
	}
	return themes;
}

/**
 * 解析并加载启动期可用的主题。
 *
 * 用「仅全局设置」构造内存版 SettingsManager（projectTrusted: false）：此刻项目
 * 尚未通过信任检查；resolve 的 prompt 回调返回 "skip"，避免启动期弹出交互确认。
 *
 * @param settingsManager - 当前设置管理器（读取全局设置）
 * @returns 启动期加载完成的主题数组
 */
async function loadStartupThemes(settingsManager: SettingsManager): Promise<Theme[]> {
	const globalSettingsManager = SettingsManager.inMemory(settingsManager.getGlobalSettings(), {
		projectTrusted: false,
	});
	const packageManager = new DefaultPackageManager({
		cwd: process.cwd(),
		agentDir: getAgentDir(),
		settingsManager: globalSettingsManager,
	});
	const resolvedPaths = await packageManager.resolve(async () => "skip");
	return loadThemes(resolvedPaths.themes);
}

/**
 * 创建启动期使用的临时 TUI 实例（不 start，由调用方决定何时启动）：
 * 注册启动期主题 → 依据设置与终端背景确定初始主题 → 应用用户快捷键 →
 * 构建 TuiMainScreen 并套用光标 / 收缩清屏设置。
 *
 * @param settingsManager - 设置来源（主题、快捷键、光标、清屏行为）
 * @returns 完成初始化、尚未启动的 TUI
 */
export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setRegisteredThemes(await loadStartupThemes(settingsManager));
	const terminalTheme = detectTerminalBackgroundFromEnv().theme;
	initTheme(resolveThemeSetting(settingsManager.getThemeSetting(), terminalTheme) ?? terminalTheme);
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

/**
 * 启动临时 TUI，并异步应用按终端探测出的 auto 主题。
 * @param ui - createStartupTui 创建的 TUI 实例
 * @param settingsManager - 用于读取主题设置
 */
export function startStartupTui(ui: TUI, settingsManager: SettingsManager): void {
	ui.start();
	// 探测在后台进行（void 放弃等待）：TUI 先以初始主题渲染，探测成功后再热切换
	void applyDetectedStartupTheme(ui, settingsManager);
}

/**
 * 主题设置为 auto 时，探测终端深/浅色并热切换到对应主题。
 * 探测超时仅 100ms——终端不响应 OSC 颜色查询时不值得等待，保持现有主题。
 *
 * @param ui - 当前 TUI（OSC 探测需要终端实例）
 * @param settingsManager - 设置来源
 */
async function applyDetectedStartupTheme(ui: TUI, settingsManager: SettingsManager): Promise<void> {
	const themeSetting = settingsManager.getThemeSetting();
	// 用户已显式指定主题（非 auto）则跳过探测
	if (themeSetting && !parseAutoThemeSetting(themeSetting)) return;

	const terminalTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
	setTheme(resolveThemeSetting(themeSetting, terminalTheme) ?? terminalTheme);
	ui.invalidate();
	ui.requestRender();
}

/**
 * 清空临时 TUI 画面并稍作等待：25ms 给终端留出处理清屏转义序列的时间，
 * 避免紧随其后的输出与残留画面错位。
 *
 * @param ui - 待清理的 TUI 实例
 */
async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

/**
 * 判断是否运行首次设置向导。须同时满足以下全部条件：
 * - 当前为官方 Pi 发行版（非 fork / 换皮版）
 * - 已启用实验特性（PI_EXPERIMENTAL=1）
 * - 使用默认 agent 目录（未通过环境变量覆盖为自定义目录）
 * - 此前未完成过设置（settings.json 尚不存在）
 * @param settingsPath - 设置文件路径，默认取全局 settings.json 路径
 * @returns 需要运行首次设置时为 true
 */
export function shouldRunFirstTimeSetup(settingsPath: string = getSettingsPath()): boolean {
	if (
		!isOfficialDistribution({
			packageName: PACKAGE_NAME,
			appName: APP_NAME,
			configDirName: CONFIG_DIR_NAME,
		})
	) {
		return false;
	}
	if (!areExperimentalFeaturesEnabled()) {
		return false;
	}
	if (process.env[ENV_AGENT_DIR]) {
		return false;
	}
	return !existsSync(settingsPath);
}

/**
 * 启动期通用选项选择对话框：弹出单选列表，用户选择或取消后清理 TUI 并结束。
 * @param settingsManager - 用于构建临时 TUI
 * @param title - 对话框标题
 * @param options - 选项列表；label 用于展示，value 为选中后返回的值
 * @returns 用户选中的值；取消时为 undefined
 */
export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		// settled 保证 finish 只生效一次：选择与取消两条回调路径可能竞态
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		// 组件按字符串标签回调选中项，这里反查回调用方传入的 value
		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui, settingsManager);
	});
}

/**
 * 展示首次设置向导并持久化用户选择（主题、是否共享分析数据）。
 * @param settingsManager - 用于读取探测结果并写入 / 落盘设置
 */
export async function showFirstTimeSetup(settingsManager: SettingsManager): Promise<void> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: FirstTimeSetupResult | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			// 仅在用户显式提交时写设置；取消则不落盘任何内容
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
			await clearStartupTui(ui);
			ui.stop();
			resolve();
		};

		const showSetup = async () => {
			// 先 start 再探测：OSC 终端探测要求 TUI 已接管终端
			ui.start();
			const detectedTheme = await detectTerminalThemeForAuto({ ui, timeoutMs: 100 });
			setTheme(detectedTheme);
			// onThemePreview 回调让向导中的主题切换即时预览（setTheme + 重绘）
			const component = new FirstTimeSetupComponent({
				detectedTheme,
				onThemePreview: (themeName) => {
					setTheme(themeName);
					ui.requestRender();
				},
				onSubmit: (result) => void finish(result),
				onCancel: () => void finish(undefined),
			});
			ui.addChild(component);
			ui.setFocus(component);
			ui.requestRender();
		};

		void showSetup();
	});
}

/**
 * 启动期单行文本输入对话框：确认返回输入值，取消返回 undefined；
 * 结束后先释放输入组件再清理画面。
 *
 * @param settingsManager - 用于构建临时 TUI
 * @param title - 输入框标题
 * @param placeholder - 占位提示文本（可选）
 * @returns 用户输入的字符串；取消时为 undefined
 */
export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			// 先释放输入组件（清理其监听器），再清屏停机
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui, settingsManager);
	});
}
