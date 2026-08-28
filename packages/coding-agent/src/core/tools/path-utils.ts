/**
 * @file path-utils.ts \u2014\u2014 \u6587\u4EF6\u7C7B\u5DE5\u5177\u7684\u8DEF\u5F84\u89E3\u6790\u8F85\u52A9\uFF08\u542B macOS \u6587\u4EF6\u540D Unicode \u53D8\u4F53\u56DE\u9000\uFF09
 *
 * @description
 * \u4E3A read / grep / edit \u7B49\u5DE5\u5177\u63D0\u4F9B\u7EDF\u4E00\u7684\u8DEF\u5F84\u5904\u7406\u5165\u53E3\uFF1A
 * - \u8DEF\u5F84\u89C4\u8303\u5316\u4E0E\u6309 cwd \u89E3\u6790\uFF08`~` \u5C55\u5F00\u3001`@` \u524D\u7F00\u5265\u79BB\u3001Unicode \u7A7A\u683C\u5F52\u4E00\uFF09\uFF1B
 * - \u9488\u5BF9 macOS \u622A\u56FE\u6587\u4EF6\u540D\u7684\u591A\u91CD\u53D8\u4F53\u56DE\u9000\uFF1A\u78C1\u76D8\u4E0A\u7684\u771F\u5B9E\u6587\u4EF6\u540D\u53EF\u80FD\u542B\u6709
 *   \u7A84\u4E0D\u6362\u884C\u7A7A\u683C\u3001NFD \u5206\u89E3\u5F0F Unicode \u6216\u5F2F\u5F15\u53F7\uFF08U+2019\uFF09\uFF0C\u800C\u7528\u6237\u624B\u6253\u7684
 *   \u8DEF\u5F84\u662F\u666E\u901A\u7A7A\u683C / NFC / \u76F4\u5F15\u53F7\uFF0C\u6309\u5B57\u9762\u5339\u914D\u4F1A\u627E\u4E0D\u5230\u6587\u4EF6\uFF1B
 * - \u63D0\u4F9B\u540C\u6B65\uFF08resolveReadPath\uFF09\u4E0E\u5F02\u6B65\uFF08resolveReadPathAsync\uFF09\u4E24\u5957\u89E3\u6790\u63A5\u53E3\u3002
 *
 * \u4F9D\u8D56\u5173\u7CFB\uFF1A
 * - `node:fs` / `node:fs/promises`\uFF1A\u6587\u4EF6\u5B58\u5728\u6027\u68C0\u67E5\uFF1B
 * - `../../utils/paths.ts`\uFF1A\u5E95\u5C42\u8DEF\u5F84\u89C4\u8303\u5316\uFF08normalizePath\uFF09\u4E0E\u89E3\u6790\uFF08resolvePath\uFF09\u3002
 */

import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { normalizePath, resolvePath } from "../../utils/paths.ts";

/** \u7A84\u4E0D\u6362\u884C\u7A7A\u683C\uFF08U+202F\uFF09\uFF1AmacOS \u622A\u56FE\u6587\u4EF6\u540D\u4E2D AM/PM \u524D\u5B9E\u9645\u4F7F\u7528\u7684\u5206\u9694\u5B57\u7B26 */
const NARROW_NO_BREAK_SPACE = "\u202F";

/** 生成 AM/PM 变体：把 " AM." / " PM." 前的普通空格替换为窄不换行空格（macOS 截图命名惯例） */
function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
	// macOS 以 NFD（分解形式）存储文件名，此处尝试把用户输入转换为 NFD
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS 在截图名（如法语 "Capture d'écran"）中使用 U+2019（右单引号）
	// 而用户通常键入的是 U+0027（直引号）
	return filePath.replace(/'/g, "\u2019");
}

/** 同步检查文件是否存在（仅判断存在性 F_OK，不校验读写权限） */
function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 异步检查文件是否存在。
 * 与同步版 fileExists 功能相同，供异步代码路径使用，避免阻塞事件循环。
 */
export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * 展开并规范化路径：`~` 展开、`@` 前缀剥离、Unicode 空格归一。
 * 不做基于 cwd 的相对路径解析，结果仍可能是相对路径。
 */
export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 将路径解析为相对于给定 cwd 的绝对路径。
 * 内部处理 `~` 展开与输入已是绝对路径两种情况。
 */
export function resolveToCwd(filePath: string, cwd: string): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * 解析「读取用」路径：先按 cwd 正常解析，若文件不存在，
 * 再依次回退尝试 macOS 截图文件名的多种 Unicode 变体。
 * 所有变体均未命中时返回原始解析结果，由调用方处理后续读取失败。
 */
export function resolveReadPath(filePath: string, cwd: string): string {
	const resolved = resolveToCwd(filePath, cwd);

	if (fileExists(resolved)) {
		return resolved;
	}

	// 尝试 macOS AM/PM 变体（AM/PM 前是窄不换行空格）
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && fileExists(amPmVariant)) {
		return amPmVariant;
	}

	// 尝试 NFD 变体（macOS 以 NFD 形式存储文件名）
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && fileExists(nfdVariant)) {
		return nfdVariant;
	}

	// 尝试弯引号变体（macOS 截图名中使用 U+2019）
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && fileExists(curlyVariant)) {
		return curlyVariant;
	}

	// 尝试 NFD + 弯引号的组合变体（针对法语 macOS 截图，如 "Capture d'écran"）
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
		return nfdCurlyVariant;
	}

	return resolved;
}

/**
 * {@link resolveReadPath} 的异步版本：存在性检查全部走异步 IO，
 * 语义与变体回退顺序和同步版完全一致。
 */
export async function resolveReadPathAsync(filePath: string, cwd: string): Promise<string> {
	const resolved = resolveToCwd(filePath, cwd);

	if (await pathExists(resolved)) {
		return resolved;
	}

	// 尝试 macOS AM/PM 变体（AM/PM 前是窄不换行空格）
	const amPmVariant = tryMacOSScreenshotPath(resolved);
	if (amPmVariant !== resolved && (await pathExists(amPmVariant))) {
		return amPmVariant;
	}

	// 尝试 NFD 变体（macOS 以 NFD 形式存储文件名）
	const nfdVariant = tryNFDVariant(resolved);
	if (nfdVariant !== resolved && (await pathExists(nfdVariant))) {
		return nfdVariant;
	}

	// 尝试弯引号变体（macOS 截图名中使用 U+2019）
	const curlyVariant = tryCurlyQuoteVariant(resolved);
	if (curlyVariant !== resolved && (await pathExists(curlyVariant))) {
		return curlyVariant;
	}

	// 尝试 NFD + 弯引号的组合变体（针对法语 macOS 截图，如 "Capture d'écran"）
	const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
	if (nfdCurlyVariant !== resolved && (await pathExists(nfdCurlyVariant))) {
		return nfdCurlyVariant;
	}

	return resolved;
}
