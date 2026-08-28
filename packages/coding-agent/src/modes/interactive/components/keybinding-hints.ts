/**
 * @file keybinding-hints.ts —— 键位提示文案格式化工具
 *
 * @description
 * 把键位标识（如 "ctrl+k/up"）格式化为用户可读的显示文本，
 * 并提供「键位 + 功能说明」的着色提示片段（keyHint / rawKeyHint），
 * 供选择器、加载器等组件在底部展示操作提示。
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** 键位文本格式化选项 */
export interface KeyTextFormatOptions {
	/** 是否把每个部分首字母大写（如 ctrl → Ctrl） */
	capitalize?: boolean;
}

/** 格式化单个按键部分（如 "ctrl"、"alt"），处理平台差异与大写 */
function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	// macOS 上把 Alt 显示为 Option，符合当地用户习惯
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

/** 格式化完整的键位字符串（支持 "/" 分隔多组、"+" 组合修饰键） */
export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

/** 把 KeyId 数组格式化为可读文本；空数组返回空串 */
function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

/** 查询键位绑定并返回小写形式的显示文本（如 "ctrl+c"） */
export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

/** 同 keyText，但每个部分首字母大写（如 "Ctrl+C"），用于正文叙述 */
export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

/** 生成「暗色键位 + 弱化说明」的提示片段（如 ^C 取消），按当前绑定解析 */
export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

/** 同 keyHint，但接受原始键位字符串而非键位绑定 ID */
export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
