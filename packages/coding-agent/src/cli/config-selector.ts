/**
 * @file config-selector.ts —— `pi config` 命令的 TUI 配置选择器
 *
 * @description
 * 启动一个独立的启动期 TUI，挂载 ConfigSelectorComponent 供用户浏览/编辑配置；
 * 组件关闭（保存或退出）后结束 Promise，控制权交回 CLI 主流程。
 */

import { ProcessTerminal, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ConfigSelectorComponent, type ScopedResolvedPaths } from "../modes/interactive/components/config-selector.ts";
import { initTheme, stopThemeWatcher } from "../modes/interactive/theme/theme.ts";

/** 传递给 ConfigSelectorComponent 的全部启动参数 */
export interface ConfigSelectorOptions {
	resolvedPaths: ScopedResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
	/** 配置写入范围：global（用户级）或 project（项目级） */
	writeScope: "global" | "project";
	/** 项目级配置在当前环境是否可用（决定 UI 是否展示该选项） */
	projectModeAvailable: boolean;
}

/**
 * 显示 TUI 配置选择器，组件关闭（用户保存或退出）后返回。
 * 返回前负责初始化主题并停止主题监听，保证 TUI 生命周期完整。
 */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// 先初始化主题再显示 TUI，确保首帧就用对配色
	initTheme(options.settingsManager.getTheme(), true);

	return new Promise((resolve) => {
		const ui: TUI = new TuiMainScreen(new ProcessTerminal(), undefined, options.agentDir);
		let resolved = false;

		const selector = new ConfigSelectorComponent(
			options.resolvedPaths,
			options.settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				// resolved 防御：组件可能多次触发关闭回调，只处理第一次
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				// 用户在选择器里选择退出：直接结束进程
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
			options.writeScope,
			options.projectModeAvailable,
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
