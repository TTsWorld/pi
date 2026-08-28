/**
 * @file open-browser.ts —— 跨平台打开 URL / 文件
 *
 * @description
 * 按平台选择 open（macOS）、rundll32（Windows）或 xdg-open（Linux），
 * 以不经过 shell 的方式调起系统默认处理器。
 */

import { spawn } from "node:child_process";

/**
 * 用平台默认的浏览器 / 处理器打开 URL 或文件。
 *
 * 刻意不经过 shell。Windows 上不要用 `cmd /c start`：
 * cmd.exe 会在 `start` 执行前重新解析元字符（&、|、^ 等），
 * 攻击者构造的 URL 可能借此注入命令。
 *
 * @param target - 要打开的 URL 或文件路径
 */
export function openBrowser(target: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	// spawn 通过 error 事件上报启动器失败（例如缺少 xdg-open）。开浏览器属于尽力而为：
	// 调用方仍会把目标展示给用户，因此不能让启动器失败演变为进程崩溃。
	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", () => {})
		.unref();
}
