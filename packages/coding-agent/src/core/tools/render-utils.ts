/**
 * @file render-utils.ts —— 工具终端渲染辅助函数
 *
 * @description
 * 供各工具的 render 实现（把工具调用与结果画到终端）复用的小工具集：
 * 路径缩短与超链接、宽松取串、Tab / CR 净化、内容块转文本（含图片降级占位）等。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：终端能力探测、超链接包装、图片降级占位；
 * - `../../modes/interactive/theme/theme.ts` 与 `../../utils/*`：主题着色、
 *   ANSI 剥离、路径解析、二进制输出净化。
 */

import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getCapabilities, getImageDimensions, hyperlink, imageFallback } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

/** 把位于用户主目录下的绝对路径前缀替换为 `~` 以缩短显示；非字符串输入返回空串 */
export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** 若终端支持超链接（OSC 8），把着色文本包装为指向该文件 file:// URL 的可点击链接；否则原样返回 */
export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

/** 宽松取字符串：null/undefined 归一为空串，其余类型返回 null，便于区分「参数缺失」与「空字符串」 */
export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

/** 把 Tab 统一替换为 3 个空格，避免终端 Tab 展开宽度因所在列不同而不可控 */
export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/** 去掉所有 \r（CRLF 与孤立 CR），统一为纯 \n 换行，便于按行渲染 */
export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

/**
 * 把工具结果中的内容块转换为终端可显示的纯文本。
 * 文本块先净化（剥 ANSI、剔二进制乱码、去 \r）再用换行拼接；
 * 图片块在终端不支持图片（或未开启显示）时降级为含 MIME 与尺寸的文本占位符。
 */
export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	// 图片块仅在终端支持且允许显示时交给 TUI 呈现；否则降级为文本占位符拼进输出
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

/** 工具 render 结果的结构约束（鸭子类型）：content 为内容块数组，details 为各工具自定义展示详情 */
export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

/** 渲染「[invalid arg]」错误标记，用于路径参数缺失/类型不符时的占位显示 */
export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

/**
 * 渲染工具输出里的路径参数：null 视为非法参数并显示错误标记；
 * 空字符串回退到 emptyFallback，仍为空则显示 "..."；正常路径缩短为
 * ~ 相对形式并视终端能力附加文件超链接。
 */
export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
