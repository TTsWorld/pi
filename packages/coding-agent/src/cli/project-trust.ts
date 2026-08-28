/**
 * @file project-trust.ts —— 构造项目信任提示所需的 UI 上下文
 *
 * @description
 * 把 CLI 启动参数（工作目录、运行模式、设置管理器、是否有 UI）适配成
 * core 层的 ProjectTrustContext：其 ui 回调在交互模式下弹出 TUI 选择器/
 * 确认框/输入框；非交互或无 UI 时优雅降级（返回 undefined/false，改用 stderr 输出）。
 */

import chalk from "chalk";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

/**
 * 创建项目信任流程使用的 ProjectTrustContext。
 *
 * @param options.mode 运行模式；只有 interactive 才会真正弹出 TUI 交互
 * @param options.hasUI 当前进程是否具备终端 UI 能力
 */
export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		// core 层用 "tui" 指代交互模式，这里做一次命名映射
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				// 无 UI 或非交互模式：不弹选择框，返回 undefined 交给调用方走默认分支
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				return showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
				);
			},
			confirm: async (title, message) => {
				// 无法交互时一律视为「未确认」（返回 false），绝不替用户默认信任
				if (!options.hasUI) {
					return false;
				}
				if (options.mode !== "interactive") {
					return false;
				}
				return (
					(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
						{ label: "Yes", value: true },
						{ label: "No", value: false },
					])) ?? false
				);
			},
			input: async (title, placeholder) => {
				if (!options.hasUI) {
					return undefined;
				}
				if (options.mode !== "interactive") {
					return undefined;
				}
				return showStartupInput(options.settingsManager, title, placeholder);
			},
			notify: (message, type = "info") => {
				// 非交互模式没有 TUI 通知条，降级为按级别着色的 stderr 输出
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
