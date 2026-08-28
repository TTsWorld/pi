/**
 * @file clipboard-native.ts —— 原生剪贴板模块的按需加载
 *
 * @description
 * 通过 createRequire 从多个解析根（当前模块、可执行文件目录）尝试加载
 * @mariozechner/clipboard 原生模块；Termux / 无显示环境的 Linux 直接禁用，
 * 加载失败返回 null，由调用方优雅降级。
 */

import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

/** 剪贴板原生模块需要满足的最小接口（读文本 / 写文本 / 查询与读取图片）。 */
export type ClipboardModule = {
	getText: () => Promise<string>;
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

type ClipboardRequire = (id: string) => unknown;

// 两个解析根：先按当前模块位置解析（开发 / npm 安装），再按可执行文件目录解析（打包产物）
const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
// Linux 需要有 X11 / Wayland 显示环境才可用剪贴板
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

/**
 * 依次尝试各解析根加载剪贴板原生模块。
 *
 * @param requires - 模块解析函数列表，默认为当前模块与可执行文件目录两个根
 * @returns 剪贴板模块；全部加载失败时返回 null
 */
export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		try {
			return requireClipboard("@mariozechner/clipboard") as ClipboardModule;
		} catch {
			// 加载失败则换下一个解析根重试。
		}
	}
	return null;
}

// Termux 环境或无显示环境不可用；模块加载失败时为 null，调用方按「无剪贴板」处理
const clipboard = !process.env.TERMUX_VERSION && hasDisplay ? loadClipboardNative() : null;

export { clipboard };
