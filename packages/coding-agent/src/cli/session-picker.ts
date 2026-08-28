/**
 * @file session-picker.ts —— `--resume` 标志的 TUI 会话选择器
 *
 * @description
 * 在启动期 TUI 中挂载 SessionSelectorComponent 供用户挑选要恢复的会话：
 * 选中返回会话文件路径，取消返回 null，用户在组件里选择退出则直接结束进程。
 */

import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.ts";
import { createStartupTui, startStartupTui } from "./startup-ui.ts";

/** 会话列表加载函数：支持按进度回调增量上报（大目录下可先展示部分结果） */
type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/**
 * 显示 TUI 会话选择器。
 *
 * @returns 选中的会话文件路径；用户取消时返回 null
 */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	settingsManager: SettingsManager,
): Promise<string | null> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		const keybindings = KeybindingsManager.create();
		// 安装为全局键位，让组件按用户自定义的快捷键操作
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				// resolved 防御：确保选中/取消/退出回调只生效一次
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				// 用户在选择器里选择退出：直接结束进程
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		startStartupTui(ui, settingsManager);
	});
}
