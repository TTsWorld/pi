/**
 * @file theme.ts —— 主题系统核心（主题定义、解析、加载与全局实例管理）
 *
 * @description
 * 本文件实现交互式 TUI 的完整主题体系，是所有界面配色的唯一来源：
 * - 用 typebox Schema 定义主题 JSON 文件的结构（约 60 个颜色 token + 变量引用 + 导出配色），
 *   并提供带友好错误信息的校验器；
 * - 提供颜色工具函数：hex/RGB 互转、256 色降级（6x6x6 色立方 + 灰阶，
 *   按人眼感知的加权距离取最近色）、ANSI 前景/背景转义序列生成、变量引用递归解析；
 * - `Theme` 类持有已解析的 ANSI 颜色表，提供 fg/bg/加粗等着色方法，
 *   并按思考等级、bash 模式映射对应的边框颜色；
 * - 主题加载：内置主题（dark/light，懒加载缓存）+ 自定义主题目录扫描 + 运行时注册主题，
 *   三者按名称去重合并后按字母序输出；
 * - 终端明暗检测：OSC 11 查询终端背景色 → COLORFGBG 环境变量 → 兜底 dark，
 *   支持 "light/dark" 自动主题设置（跟随终端配色切换）；
 * - 全局主题实例：通过 globalThis Symbol 共享（兼容 tsx/jiti 双模块加载器），
 *   支持 fs.watch 监听自定义主题文件热重载（100ms 防抖）；
 * - HTML 导出辅助：把主题颜色解析为 CSS 可用的 hex 值；
 * - TUI 辅助：基于当前主题构建 Markdown 渲染、语法高亮、选择列表、编辑器、
 *   设置列表等 pi-tui 组件的主题适配器。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：终端能力检测（truecolor 支持）与各组件主题类型；
 * - `../../../config.ts`：内置/自定义主题目录路径；
 * - `../../../utils/fs-watch.ts` / `syntax-highlight.ts` / `text.ts`：文件监听、
 *   语法高亮与 BOM 剥除工具。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type EditorTheme,
	getCapabilities,
	type MarkdownTheme,
	type RgbColor,
	type SelectListTheme,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { getCustomThemesDir, getThemesDir } from "../../../config.ts";
import type { SourceInfo } from "../../../core/source-info.ts";
import { closeWatcher, watchWithErrorHandler } from "../../../utils/fs-watch.ts";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.ts";
import { stripBom } from "../../../utils/text.ts";

// ============================================================================
// 类型与 Schema
// ============================================================================

/**
 * 单个颜色值的合法表示：字符串（hex 颜色、变量引用或空串）或 256 色索引整数。
 * - 字符串 "#ff0000"：真彩 hex 颜色（256 色终端下会自动降级取最近色）
 * - 字符串 "primary"：指向主题 vars 表中同名键的变量引用（支持嵌套引用）
 * - 字符串 ""：空串表示「使用终端默认颜色」（前景默认/背景默认）
 * - 整数 0-255：直接使用 xterm 256 色索引
 */
const ColorValueSchema = Type.Union([
	Type.String(), // hex 颜色 "#ff0000"、变量引用 "primary" 或空串 ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256 色索引
]);

type ColorValue = Static<typeof ColorValueSchema>;

/**
 * 主题 JSON 文件的结构定义（dark.json / light.json 及自定义主题同此格式）。
 * 顶层字段：`$schema`（编辑器提示用）、`name`（主题名，不含 "/"）、
 * `vars`（变量表，供 colors 中的引用键复用）、`colors`（全部颜色 token）、
 * `export`（HTML 导出专用的页面配色，可选）。
 */
const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// ===== 核心 UI（11 色）=====
		accent: ColorValueSchema, // 强调色：选中项、光标、品牌高亮
		border: ColorValueSchema, // 普通边框色：面板/分隔线主边框
		borderAccent: ColorValueSchema, // 强调边框色：需要突出的边框（如激活面板）
		borderMuted: ColorValueSchema, // 弱化边框色：编辑器等低视觉权重边框
		success: ColorValueSchema, // 成功状态色：成功提示与绿色状态标记
		error: ColorValueSchema, // 错误状态色：错误提示与失败标记
		warning: ColorValueSchema, // 警告状态色：警告提示
		muted: ColorValueSchema, // 次要文字：描述、滚动信息等辅助文本
		dim: ColorValueSchema, // 更暗的弱化文字：设置项说明、提示
		text: ColorValueSchema, // 默认正文文字颜色
		thinkingText: ColorValueSchema, // 思考内容的正文字色
		// ===== 背景与内容文本（11 必需 + 3 可选）=====
		selectedBg: ColorValueSchema, // 列表选中项背景色
		scrollbarThumb: Type.Optional(ColorValueSchema), // 滚动条滑块背景（缺省回退 selectedBg）
		searchMatchBg: Type.Optional(ColorValueSchema), // 搜索命中高亮背景（缺省回退 selectedBg）
		searchMatchText: Type.Optional(ColorValueSchema), // 搜索命中文字色（缺省回退 text）
		userMessageBg: ColorValueSchema, // 用户消息气泡背景
		userMessageText: ColorValueSchema, // 用户消息文字色
		customMessageBg: ColorValueSchema, // 自定义注入消息的背景
		customMessageText: ColorValueSchema, // 自定义注入消息的文字色
		customMessageLabel: ColorValueSchema, // 自定义注入消息的标签色（如消息来源标记）
		toolPendingBg: ColorValueSchema, // 工具运行中状态背景
		toolSuccessBg: ColorValueSchema, // 工具成功结束状态背景
		toolErrorBg: ColorValueSchema, // 工具失败结束状态背景
		toolTitle: ColorValueSchema, // 工具标题文字色（工具调用框标题行）
		toolOutput: ColorValueSchema, // 工具输出文字色
		// ===== Markdown 渲染（10 色）=====
		mdHeading: ColorValueSchema, // 标题
		mdLink: ColorValueSchema, // 链接显示文字
		mdLinkUrl: ColorValueSchema, // 链接 URL 部分
		mdCode: ColorValueSchema, // 行内代码
		mdCodeBlock: ColorValueSchema, // 代码块正文
		mdCodeBlockBorder: ColorValueSchema, // 代码块边框
		mdQuote: ColorValueSchema, // 引用正文
		mdQuoteBorder: ColorValueSchema, // 引用左侧竖线
		mdHr: ColorValueSchema, // 水平分隔线
		mdListBullet: ColorValueSchema, // 列表符号
		// ===== 工具 Diff（3 色）=====
		toolDiffAdded: ColorValueSchema, // diff 新增行
		toolDiffRemoved: ColorValueSchema, // diff 删除行
		toolDiffContext: ColorValueSchema, // diff 上下文行
		// ===== 语法高亮（9 色）=====
		syntaxComment: ColorValueSchema, // 注释
		syntaxKeyword: ColorValueSchema, // 关键字
		syntaxFunction: ColorValueSchema, // 函数名
		syntaxVariable: ColorValueSchema, // 变量/属性/参数
		syntaxString: ColorValueSchema, // 字符串/正则字面量
		syntaxNumber: ColorValueSchema, // 数字/字面量
		syntaxType: ColorValueSchema, // 类型/类/内建标识符
		syntaxOperator: ColorValueSchema, // 运算符
		syntaxPunctuation: ColorValueSchema, // 标点/标签符号
		// ===== 思考等级边框（6 必需 + 1 可选）=====
		thinkingOff: ColorValueSchema, // 思考关闭
		thinkingMinimal: ColorValueSchema, // 思考等级：minimal
		thinkingLow: ColorValueSchema, // 思考等级：low
		thinkingMedium: ColorValueSchema, // 思考等级：medium
		thinkingHigh: ColorValueSchema, // 思考等级：high
		thinkingXhigh: ColorValueSchema, // 思考等级：xhigh
		thinkingMax: Type.Optional(ColorValueSchema), // 思考等级：max（缺省回退 thinkingXhigh）
		// ===== Bash 模式（1 色）=====
		bashMode: ColorValueSchema, // bash 直通模式的边框色（醒目提示当前处于命令直发状态）
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema), // HTML 导出页面背景
			cardBg: Type.Optional(ColorValueSchema), // HTML 导出卡片背景
			infoBg: Type.Optional(ColorValueSchema), // HTML 导出信息块背景
		}),
	),
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

/** 预编译的 Schema 校验器：Check() 判定合法性，Errors() 输出逐字段错误详情 */
const validateThemeJson = Compile(ThemeJsonSchema);

/**
 * 全部前景色 token 名的联合类型（即 `Theme.fg()` 可用的颜色键）。
 * 与 ThemeJsonSchema 的 colors 一一对应，但不含纯背景色键。
 */
export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "searchMatchText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode";

/** 全部背景色 token 名的联合类型（即 `Theme.bg()` 可用的颜色键）。 */
export type ThemeBg =
	| "selectedBg"
	| "scrollbarThumb"
	| "searchMatchBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg";

/** Schema 中可省略的前景色键（Theme 构造时会用兄弟颜色回退补齐） */
type OptionalThemeColor = "thinkingMax" | "searchMatchText";
/** Schema 中可省略的背景色键（Theme 构造时会用 selectedBg 回退补齐） */
type OptionalThemeBg = "scrollbarThumb" | "searchMatchBg";

/** 终端颜色能力：truecolor（24 位真彩）或 256color（降级调色板） */
type ColorMode = "truecolor" | "256color";

// ============================================================================
// 颜色工具函数
// ============================================================================

/**
 * 解析 "#rrggbb" 格式的 hex 颜色为 RGB 三通道（0-255）。
 * @throws 长度不为 6 或包含非法十六进制字符时抛错
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const cleaned = hex.replace("#", "");
	if (cleaned.length !== 6) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	const r = parseInt(cleaned.substring(0, 2), 16);
	const g = parseInt(cleaned.substring(2, 4), 16);
	const b = parseInt(cleaned.substring(4, 6), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
		throw new Error(`Invalid hex color: ${hex}`);
	}
	return { r, g, b };
}

// 6x6x6 色立方每个通道的取值（索引 0-5 对应 xterm 标准 16-231 号色的阶梯）
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// 灰阶梯度值（对应 232-255 号色，共 24 级灰，从 8 到 238，每级递增 10）
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

/** 在色立方单个通道的 6 个阶梯值中找最接近 value 的索引（0-5） */
function findClosestCubeIndex(value: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < CUBE_VALUES.length; i++) {
		const dist = Math.abs(value - CUBE_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

/** 在 24 级灰阶中找最接近 gray 的索引（0-23） */
function findClosestGrayIndex(gray: number): number {
	let minDist = Infinity;
	let minIdx = 0;
	for (let i = 0; i < GRAY_VALUES.length; i++) {
		const dist = Math.abs(gray - GRAY_VALUES[i]);
		if (dist < minDist) {
			minDist = dist;
			minIdx = i;
		}
	}
	return minIdx;
}

/**
 * 计算两个 RGB 颜色的感知距离（加权欧氏距离平方）。
 * 权重 0.299/0.587/0.114 是亮度公式系数——人眼对绿色最敏感，
 * 因此绿色通道的偏差对距离贡献最大。
 */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
	// 加权欧氏距离（人眼对绿色更敏感）
	const dr = r1 - r2;
	const dg = g1 - g2;
	const db = b1 - b2;
	return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

/**
 * 把真彩 RGB 降级映射到最接近的 xterm 256 色索引。
 * 策略：分别求 6x6x6 色立方与灰阶中的最近色，再按感知距离择优；
 * 近乎无彩（饱和度极低）且灰阶更近时选灰阶，否则选色立方以保留色调。
 */
function rgbTo256(r: number, g: number, b: number): number {
	// 在 6x6x6 色立方中找最近颜色
	const rIdx = findClosestCubeIndex(r);
	const gIdx = findClosestCubeIndex(g);
	const bIdx = findClosestCubeIndex(b);
	const cubeR = CUBE_VALUES[rIdx];
	const cubeG = CUBE_VALUES[gIdx];
	const cubeB = CUBE_VALUES[bIdx];
	// 色立方索引公式：16 起始 + R*36 + G*6 + B
	const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
	const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

	// 在灰阶中找最近灰色：先用亮度公式把 RGB 折算成单通道灰度
	const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
	const grayIdx = findClosestGrayIndex(gray);
	const grayValue = GRAY_VALUES[grayIdx];
	// 灰阶从 232 号开始
	const grayIndex = 232 + grayIdx;
	const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

	// 判断颜色是否有明显饱和度（色调信息是否重要）
	// 若 max-min 差值显著，优先选色立方以保留色调
	const maxC = Math.max(r, g, b);
	const minC = Math.min(r, g, b);
	const spread = maxC - minC;

	// 仅当颜色近乎中性（spread < 10）且灰阶确实更近时才选灰阶
	if (spread < 10 && grayDist < cubeDist) {
		return grayIndex;
	}

	return cubeIndex;
}

/** hex 颜色 → 256 色索引（hexToRgb + rgbTo256 的组合便捷函数） */
function hexTo256(hex: string): number {
	const { r, g, b } = hexToRgb(hex);
	return rgbTo256(r, g, b);
}

/**
 * 把主题色值编码为 ANSI 前景转义序列。
 * - 空串 → `\x1b[39m`（恢复终端默认前景色）
 * - 数字 → `38;5;n`（256 色索引）
 * - hex → truecolor 终端用 `38;2;r;g;b`，否则降级为最近 256 色
 * @throws 颜色值既非空串/数字/hex 时抛错（例如未解析的变量引用）
 */
function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[38;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[38;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

/** 与 {@link fgAnsi} 对应的背景色版本（默认重置码为 `\x1b[49m`，前缀 48） */
function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	if (color.startsWith("#")) {
		if (mode === "truecolor") {
			const { r, g, b } = hexToRgb(color);
			return `\x1b[48;2;${r};${g};${b}m`;
		} else {
			const index = hexTo256(color);
			return `\x1b[48;5;${index}m`;
		}
	}
	throw new Error(`Invalid color value: ${color}`);
}

/**
 * 递归解析变量引用：若 value 是变量名（非空串且不以 # 开头），
 * 则到 vars 表中查其定义并继续解析，直到得到具体的颜色值（hex/数字/空串）。
 * @param visited - 已访问过的变量名集合，用于检测循环引用
 * @throws 循环引用、或引用了 vars 中不存在的键时抛错
 */
function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

/**
 * 批量解析一组颜色的变量引用：对每个键调用 {@link resolveVarRefs}，
 * 返回所有值均为「具体颜色」（hex 字符串 / 256 色数字 / 空串）的新表。
 */
function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

/**
 * 为 Schema 中的可选颜色补齐回退值，得到字段完备的 colors 表：
 * - thinkingMax 回退 thinkingXhigh（旧主题没有 max 档）
 * - scrollbarThumb / searchMatchBg 回退 selectedBg
 * - searchMatchText 回退 text
 */
function withThemeColorFallbacks(colors: ThemeJson["colors"]): ThemeJson["colors"] & {
	thinkingMax: ColorValue;
	scrollbarThumb: ColorValue;
	searchMatchBg: ColorValue;
	searchMatchText: ColorValue;
} {
	return {
		...colors,
		thinkingMax: colors.thinkingMax ?? colors.thinkingXhigh,
		scrollbarThumb: colors.scrollbarThumb ?? colors.selectedBg,
		searchMatchBg: colors.searchMatchBg ?? colors.selectedBg,
		searchMatchText: colors.searchMatchText ?? colors.text,
	};
}

// ============================================================================
// Theme 类
// ============================================================================

/**
 * 已实例化的主题：把主题定义中的颜色值按终端颜色能力预编译成 ANSI 转义序列，
 * 并提供文字着色入口。所有 UI 组件都通过 `theme.fg()/bg()` 取色，
 * 因此主题热切换后无需改动组件代码。
 */
export class Theme {
	readonly name?: string;
	readonly sourcePath?: string;
	sourceInfo?: SourceInfo;
	private fgColors: Map<ThemeColor, string>;
	private bgColors: Map<ThemeBg, string>;
	private mode: ColorMode;

	/**
	 * @param fgColors - 前景色表（可选键允许缺省，内部会补回退值）
	 * @param bgColors - 背景色表（可选键允许缺省，内部会补回退值）
	 * @param mode - 终端颜色能力，决定 hex 颜色编码为真彩还是 256 色
	 * @param options - 主题元信息（名称、来源文件路径、来源描述）
	 */
	constructor(
		fgColors: Record<Exclude<ThemeColor, OptionalThemeColor>, string | number> &
			Partial<Record<OptionalThemeColor, string | number>>,
		bgColors: Record<Exclude<ThemeBg, OptionalThemeBg>, string | number> &
			Partial<Record<OptionalThemeBg, string | number>>,
		mode: ColorMode,
		options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
	) {
		this.name = options.name;
		this.sourcePath = options.sourcePath;
		this.sourceInfo = options.sourceInfo;
		this.mode = mode;
		this.fgColors = new Map();
		const colors = {
			...fgColors,
			thinkingMax: fgColors.thinkingMax ?? fgColors.thinkingXhigh,
			searchMatchText: fgColors.searchMatchText ?? fgColors.text,
		};
		for (const [key, value] of Object.entries(colors) as [ThemeColor, string | number][]) {
			this.fgColors.set(key, fgAnsi(value, mode));
		}
		this.bgColors = new Map();
		// 背景色回退：滚动条滑块与搜索命中背景缺省时用选中背景色
		const backgrounds = {
			...bgColors,
			scrollbarThumb: bgColors.scrollbarThumb ?? bgColors.selectedBg,
			searchMatchBg: bgColors.searchMatchBg ?? bgColors.selectedBg,
		};
		for (const [key, value] of Object.entries(backgrounds) as [ThemeBg, string | number][]) {
			this.bgColors.set(key, bgAnsi(value, mode));
		}
	}

	/**
	 * 用指定前景色渲染文本：包一层对应的 ANSI 序列，结尾只重置前景色
	 * （`\x1b[39m`），避免影响已设置的其他属性（如背景色、加粗）。
	 * @throws 传入未知的颜色键时抛错（通常是类型拼写问题）
	 */
	fg(color: ThemeColor, text: string): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return `${ansi}${text}\x1b[39m`; // 仅重置前景色
	}

	/**
	 * 用指定背景色渲染文本：与 fg() 对称，结尾只重置背景色（`\x1b[49m`）。
	 * @throws 传入未知的背景色键时抛错
	 */
	bg(color: ThemeBg, text: string): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return `${ansi}${text}\x1b[49m`; // 仅重置背景色
	}

	/** 加粗（委托 chalk，与主题无关的通用样式） */
	bold(text: string): string {
		return chalk.bold(text);
	}

	/** 斜体 */
	italic(text: string): string {
		return chalk.italic(text);
	}

	/** 下划线 */
	underline(text: string): string {
		return chalk.underline(text);
	}

	/** 前景/背景反转（用于高亮块） */
	inverse(text: string): string {
		return chalk.inverse(text);
	}

	/** 删除线 */
	strikethrough(text: string): string {
		return chalk.strikethrough(text);
	}

	/**
	 * 获取前景色的原始 ANSI 转义序列（不带文本与重置码）。
	 * 供需要自行拼接序列的底层渲染逻辑使用；一般场景用 {@link fg} 即可。
	 */
	getFgAnsi(color: ThemeColor): string {
		const ansi = this.fgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme color: ${color}`);
		return ansi;
	}

	/** 获取背景色的原始 ANSI 转义序列（背景版 {@link getFgAnsi}） */
	getBgAnsi(color: ThemeBg): string {
		const ansi = this.bgColors.get(color);
		if (!ansi) throw new Error(`Unknown theme background color: ${color}`);
		return ansi;
	}

	/** 返回构造时确定的终端颜色能力（truecolor / 256color） */
	getColorMode(): ColorMode {
		return this.mode;
	}

	/**
	 * 按思考等级取对应的边框着色函数：每个等级映射到主题中
	 * 专属的 thinkingXxx 颜色，让用户从边框颜色即可分辨当前思考档位。
	 */
	getThinkingBorderColor(level: ThinkingLevel): (str: string) => string {
		// 思考等级 → 专属主题颜色的映射
		switch (level) {
			case "off":
				return (str: string) => this.fg("thinkingOff", str);
			case "minimal":
				return (str: string) => this.fg("thinkingMinimal", str);
			case "low":
				return (str: string) => this.fg("thinkingLow", str);
			case "medium":
				return (str: string) => this.fg("thinkingMedium", str);
			case "high":
				return (str: string) => this.fg("thinkingHigh", str);
			case "xhigh":
				return (str: string) => this.fg("thinkingXhigh", str);
			case "max":
				return (str: string) => this.fg("thinkingMax", str);
			default:
				return (str: string) => this.fg("thinkingOff", str);
		}
	}

	/** 取 bash 直通模式的边框着色函数（bashMode 色） */
	getBashModeBorderColor(): (str: string) => string {
		return (str: string) => this.fg("bashMode", str);
	}
}

// ============================================================================
// 主题加载
// ============================================================================

/** 内置主题（dark/light）的懒加载缓存：首次读取 JSON 后常驻内存 */
let BUILTIN_THEMES: Record<string, ThemeJson> | undefined;

/** 获取内置主题表（dark.json / light.json），带 BOM 剥除与一次性缓存。 */
function getBuiltinThemes(): Record<string, ThemeJson> {
	if (!BUILTIN_THEMES) {
		const themesDir = getThemesDir();
		const darkPath = path.join(themesDir, "dark.json");
		const lightPath = path.join(themesDir, "light.json");
		BUILTIN_THEMES = {
			dark: JSON.parse(stripBom(fs.readFileSync(darkPath, "utf-8"))) as ThemeJson,
			light: JSON.parse(stripBom(fs.readFileSync(lightPath, "utf-8"))) as ThemeJson,
		};
	}
	return BUILTIN_THEMES;
}

/** 列出所有可用主题名（内置 + 自定义 + 注册，去重后按字母序）。 */
export function getAvailableThemes(): string[] {
	return getAvailableThemesWithPaths().map(({ name }) => name);
}

/** 主题条目：名称 + 对应 JSON 文件路径（注册的内存主题可能没有路径）。 */
export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

/**
 * 列出所有可用主题（含路径信息）。合并三个来源并按名称去重，
 * 优先级从高到低：内置主题 > 自定义主题目录 > 运行时注册主题
 * （同名时先加入者胜出），最终按名称字母序排序。
 */
export function getAvailableThemesWithPaths(): ThemeInfo[] {
	const themesDir = getThemesDir();
	const result: ThemeInfo[] = [];
	const seen = new Set<string>();
	const addTheme = (themeInfo: ThemeInfo) => {
		if (seen.has(themeInfo.name)) {
			return;
		}
		seen.add(themeInfo.name);
		result.push(themeInfo);
	};

	// 内置主题
	for (const name of Object.keys(getBuiltinThemes())) {
		addTheme({ name, path: path.join(themesDir, `${name}.json`) });
	}

	// 自定义主题
	for (const themeInfo of getCustomThemeInfos()) {
		addTheme(themeInfo);
	}

	// 运行时注册的主题实例
	for (const [name, theme] of registeredThemes.entries()) {
		addTheme({ name, path: theme.sourcePath });
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 扫描自定义主题目录，返回其中每个合法 JSON 主题的名称与路径。
 * 目录不存在时返回空列表；单个主题解析失败会被静默跳过——
 * 完整的报错由资源加载器在正常启动/重载流程中统一给出。
 */
function getCustomThemeInfos(): ThemeInfo[] {
	const customThemesDir = getCustomThemesDir();
	const result: ThemeInfo[] = [];
	if (!fs.existsSync(customThemesDir)) {
		return result;
	}

	for (const file of fs.readdirSync(customThemesDir)) {
		// 只认 .json 文件，其余一律忽略
		if (!file.endsWith(".json")) {
			continue;
		}
		const themePath = path.join(customThemesDir, file);
		try {
			const customTheme = loadThemeFromPath(themePath);
			if (customTheme.name) {
				result.push({ name: customTheme.name, path: themePath });
			}
		} catch {
			// 此处忽略非法主题；资源加载器会在正常启动/重载时报告错误。
		}
	}
	return result;
}

/**
 * 校验主题名：禁止包含 "/"，因为斜杠被 "light/dark" 形式的
 * 自动明暗主题设置占用，带斜杠的名字会产生歧义。
 */
function assertThemeNameIsValid(name: string): void {
	if (name.includes("/")) {
		throw new Error(
			`Invalid theme name "${name}": theme names cannot contain "/" because it is reserved for automatic light/dark theme settings.`,
		);
	}
}

/**
 * 校验已解析的主题 JSON 对象并做主题名检查。
 * 校验失败时把 typebox 错误整理成用户友好的报错信息：
 * 特别地把「colors 缺少必需 token」单独汇总成一份补色清单，
 * 并提示参考内置主题取值；其余错误按路径逐条列出。
 * @param label - 报错时展示的主题标识（通常是文件路径或主题名）
 * @throws Schema 校验失败或主题名含 "/" 时抛错
 */
function parseThemeJson(label: string, json: unknown): ThemeJson {
	if (!validateThemeJson.Check(json)) {
		const errors = Array.from(validateThemeJson.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		// 把 /colors 下缺失的必需字段挑出来单独归类，其余归入通用错误
		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `Invalid theme "${label}":\n`;
		if (missingColors.size > 0) {
			errorMessage += "\nMissing required color tokens:\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
			errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	const themeJson = json as ThemeJson;
	assertThemeNameIsValid(themeJson.name);
	return themeJson;
}

/**
 * 解析主题文件文本内容：剥 BOM → JSON.parse → {@link parseThemeJson} 校验。
 * @throws JSON 语法错误或 Schema 校验失败时抛错
 */
function parseThemeJsonContent(label: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(stripBom(content));
	} catch (error) {
		throw new Error(`Failed to parse theme ${label}: ${error}`);
	}
	return parseThemeJson(label, json);
}

/**
 * 按名称读取主题的原始 JSON 定义（不经过 Theme 实例化），查找顺序：
 * 内置主题缓存 → 带 sourcePath 的注册主题（从磁盘重读，导出场景用）→
 * 自定义主题目录 `${name}.json`。
 * @throws 注册主题缺少 sourcePath（无法导出）或主题不存在时抛错
 */
function loadThemeJson(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme?.sourcePath) {
		// 注册主题需要从源文件重新读取（实例可能已被热重载更新）
		const content = fs.readFileSync(registeredTheme.sourcePath, "utf-8");
		return parseThemeJsonContent(registeredTheme.sourcePath, content);
	}
	if (registeredTheme) {
		throw new Error(`Theme "${name}" does not have a source path for export`);
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	if (!fs.existsSync(themePath)) {
		throw new Error(`Theme not found: ${name}`);
	}
	const content = fs.readFileSync(themePath, "utf-8");
	return parseThemeJsonContent(name, content);
}

/**
 * 从 ThemeJson 创建 Theme 实例：补齐可选色回退值 → 解析变量引用 →
 * 按背景色键集合把颜色拆分为前景/背景两组 → 按终端能力编译 ANSI 序列。
 * 未显式指定 mode 时依据 pi-tui 能力检测自动选择真彩或 256 色。
 */
function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
	const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
	const resolvedColors = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);
	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	// 背景色键集合：resolved 中的键据此一分为二，分拣进前景/背景两张表
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"scrollbarThumb",
		"searchMatchBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	return new Theme(fgColors, bgColors, colorMode, {
		name: themeJson.name,
		sourcePath,
	});
}

/** 从指定 JSON 文件路径读取并实例化主题（含校验）；theme.ts 对外的基本加载入口。 */
export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
	const content = fs.readFileSync(themePath, "utf-8");
	const themeJson = parseThemeJsonContent(themePath, content);
	return createTheme(themeJson, mode, themePath);
}

/**
 * 按名称加载 Theme 实例：已注册的主题实例直接返回（保留热重载缓存），
 * 否则读取 JSON 定义后新建实例。
 * @throws 主题不存在或定义非法时抛错
 */
function loadTheme(name: string, mode?: ColorMode): Theme {
	const registeredTheme = registeredThemes.get(name);
	if (registeredTheme) {
		return registeredTheme;
	}
	const themeJson = loadThemeJson(name);
	return createTheme(themeJson, mode);
}

/** 按名称取主题，加载失败（不存在/非法）时返回 undefined 而不抛错。 */
export function getThemeByName(name: string): Theme | undefined {
	try {
		return loadTheme(name);
	} catch {
		return undefined;
	}
}

/** 终端明暗基调："dark"（深色）或 "light"（浅色） */
export type TerminalTheme = "dark" | "light";

/**
 * 解析 "light主题/dark主题" 形式的自动主题设置。
 * 格式要求：恰好一个 "/"，且两侧主题名非空（允许首尾空白）；
 * 不满足时说明是普通主题名而非自动设置，返回 undefined。
 */
export function parseAutoThemeSetting(
	themeSetting: string | undefined,
): { lightTheme: string; darkTheme: string } | undefined {
	if (!themeSetting) return undefined;
	const slashIndex = themeSetting.indexOf("/");
	// 无斜杠（普通主题名）或多余斜杠（非法格式）都不是自动设置
	if (slashIndex === -1 || themeSetting.indexOf("/", slashIndex + 1) !== -1) {
		return undefined;
	}

	const lightTheme = themeSetting.slice(0, slashIndex).trim();
	const darkTheme = themeSetting.slice(slashIndex + 1).trim();
	if (!lightTheme || !darkTheme) {
		return undefined;
	}
	return { lightTheme, darkTheme };
}

/**
 * 把主题设置解析为当前应使用的具体主题名：
 * - 自动设置（"light/dark"）：按终端明暗基调二选一；
 * - 普通主题名：原样返回；
 * - 含斜杠的非法格式或未设置：返回 undefined（由调用方决定兜底行为）。
 */
export function resolveThemeSetting(
	themeSetting: string | undefined,
	terminalTheme: TerminalTheme,
): string | undefined {
	const autoTheme = parseAutoThemeSetting(themeSetting);
	if (autoTheme) {
		return terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
	}
	if (themeSetting?.includes("/")) return undefined;
	if (typeof themeSetting === "string") return themeSetting;
	return undefined;
}

/** 终端明暗检测结果：基调 + 来源 + 详情描述 + 置信度。 */
export interface TerminalThemeDetection {
	theme: TerminalTheme;
	/** 检测来源：终端背景色查询 / COLORFGBG 环境变量 / 兜底默认 */
	source: "terminal background" | "COLORFGBG" | "fallback";
	/** 人类可读的检测依据（如具体的背景色索引或 RGB 值） */
	detail: string;
	/** 置信度：high 可用于持久化设置，low 仅作会话内默认 */
	confidence: "high" | "low";
}

/** 检测选项：允许注入环境变量（默认 process.env），便于测试。 */
export interface TerminalThemeDetectionOptions {
	env?: NodeJS.ProcessEnv;
}

/** 能查询终端背景色的最小接口（由 TUI 实现 OSC 11 查询）。 */
export interface TerminalBackgroundThemeDetector {
	queryTerminalBackgroundColor({ timeoutMs }: { timeoutMs: number }): Promise<RgbColor | undefined>;
}

/** 在背景色查询之上额外支持查询终端配色方案（明/暗）的探测器。 */
export interface TerminalAutoThemeDetector extends TerminalBackgroundThemeDetector {
	queryTerminalColorScheme?({ timeoutMs }: { timeoutMs: number }): Promise<TerminalTheme | undefined>;
}

/** {@link detectTerminalBackgroundTheme} 的参数。 */
export interface TerminalBackgroundThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalBackgroundThemeDetector;
	timeoutMs: number;
}

/** {@link detectTerminalThemeForAuto} 的参数。 */
export interface TerminalAutoThemeDetectionOptions extends TerminalThemeDetectionOptions {
	ui: TerminalAutoThemeDetector;
	timeoutMs: number;
}

/**
 * 从 COLORFGBG 环境变量解析背景色索引。
 * 该变量格式形如 "15;0"（前景;背景），可能含多层（如 "15;12;0"），
 * 因此从右往左找第一个合法的 0-255 整数作为背景色索引。
 */
function getColorFgBgBackgroundIndex(colorfgbg: string): number | undefined {
	const parts = colorfgbg.split(";");
	for (let i = parts.length - 1; i >= 0; i--) {
		const bg = parseInt(parts[i].trim(), 10);
		if (Number.isInteger(bg) && bg >= 0 && bg <= 255) {
			return bg;
		}
	}
	return undefined;
}

/**
 * 计算 RGB 颜色的相对亮度（WCAG 感知亮度公式）：
 * 先做伽马展开（gamma 解码到线性空间），再加权求和，结果范围 0-1。
 */
function getRgbColorLuminance({ r, g, b }: RgbColor): number {
	const toLinear = (channel: number) => {
		const value = channel / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** 计算 256 色索引对应颜色的亮度（先经 ansi256ToHex 近似转成 hex 再算）。 */
function getAnsiColorLuminance(index: number): number {
	return getRgbColorLuminance(hexToRgb(ansi256ToHex(index)));
}

/** 按 RGB 背景亮度判定明暗基调：亮度 ≥ 0.5 视为浅色终端，否则深色。 */
export function getThemeForRgbColor(rgb: RgbColor): TerminalTheme {
	return getRgbColorLuminance(rgb) >= 0.5 ? "light" : "dark";
}

/**
 * 仅凭环境变量（COLORFGBG）同步检测终端明暗基调。
 * 拿到合法背景色索引即按其亮度判定（high 置信度）；
 * 否则返回 dark 兜底（low 置信度，不应据此持久化设置）。
 */
export function detectTerminalBackgroundFromEnv(options: TerminalThemeDetectionOptions = {}): TerminalThemeDetection {
	const env = options.env ?? process.env;
	const colorfgbg = env.COLORFGBG || "";
	const bg = getColorFgBgBackgroundIndex(colorfgbg);
	if (bg !== undefined) {
		return {
			theme: getAnsiColorLuminance(bg) >= 0.5 ? "light" : "dark",
			source: "COLORFGBG",
			detail: `background color index ${bg}`,
			confidence: "high",
		};
	}

	// 无任何背景提示时兜底为 dark
	return {
		theme: "dark",
		source: "fallback",
		detail: "no terminal background hint found",
		confidence: "low",
	};
}

/**
 * 通过 OSC 11 查询终端背景色判定明暗基调。
 * 查询成功且返回 RGB 时按亮度判定（high）；查询失败或超时则
 * 降级为 {@link detectTerminalBackgroundFromEnv} 的环境变量检测。
 */
export async function detectTerminalBackgroundTheme({
	ui,
	timeoutMs,
	env,
}: TerminalBackgroundThemeDetectionOptions): Promise<TerminalThemeDetection> {
	try {
		const rgb = await ui.queryTerminalBackgroundColor({ timeoutMs });
		if (rgb) {
			return {
				theme: getThemeForRgbColor(rgb),
				source: "terminal background",
				detail: `OSC 11 background rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
				confidence: "high",
			};
		}
	} catch {
		// 终端查询失败时降级为基于环境变量的检测。
	}

	return detectTerminalBackgroundFromEnv({ env });
}

/**
 * 为自动主题（"light/dark" 设置）检测终端明暗基调。
 * 优先用终端配色方案查询（OSC 配色事件，能感知系统级切换），
 * 同时并发发起 OSC 11 / COLORFGBG 背景检测作为后备；
 * 配色方案查询失败或无结果时取后备检测结果。
 */
export async function detectTerminalThemeForAuto({
	ui,
	timeoutMs,
	env,
}: TerminalAutoThemeDetectionOptions): Promise<TerminalTheme> {
	let colorSchemePromise: Promise<TerminalTheme | undefined> | undefined;
	try {
		colorSchemePromise = ui.queryTerminalColorScheme?.({ timeoutMs });
	} catch {
		// 启动配色方案查询失败时降级为 OSC 11 / COLORFGBG 检测。
	}
	// 后备检测与配色方案查询并发执行，避免串行等待两次超时
	const backgroundThemePromise = detectTerminalBackgroundTheme({ ui, timeoutMs, env });

	try {
		const colorScheme = await colorSchemePromise;
		if (colorScheme) return colorScheme;
	} catch {
		// 降级为并发进行的 OSC 11 / COLORFGBG 检测结果。
	}
	return (await backgroundThemePromise).theme;
}

/** 默认主题名：按环境变量快速判定的终端明暗基调（"dark" 或 "light"）。 */
export function getDefaultTheme(): string {
	return detectTerminalBackgroundFromEnv().theme;
}

// ============================================================================
// 全局主题实例
// ============================================================================

// 用 globalThis 共享主题，避免开发模式下 tsx + jiti 双模块加载器各持一份实例
const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme");

// 以 getter 形式导出 theme：每次属性访问都从 globalThis 读取，
// 保证所有模块实例（tsx、jiti）看到的都是同一份（且可热切换的）主题
export const theme: Theme = new Proxy({} as Theme, {
	get(_target, prop) {
		const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
		if (!t) throw new Error("Theme not initialized. Call initTheme() first.");
		return (t as unknown as Record<string | symbol, unknown>)[prop];
	},
});

/** 写入全局主题实例；同时写新旧两个 Symbol 键以兼容旧包名的模块。 */
function setGlobalTheme(t: Theme): void {
	(globalThis as Record<symbol, Theme>)[THEME_KEY] = t;
	(globalThis as Record<symbol, Theme>)[THEME_KEY_OLD] = t;
}

// ----- 模块级主题状态：当前主题名 / 文件监听器 / 热重载防抖定时器 / 变更回调 -----
let currentThemeName: string | undefined;
let themeWatcher: fs.FSWatcher | undefined;
let themeReloadTimer: NodeJS.Timeout | undefined;
let onThemeChangeCallback: (() => void) | undefined;
/** 运行时注册的主题实例表（含热重载后的缓存实例），loadTheme 优先查这里 */
const registeredThemes = new Map<string, Theme>();

/**
 * 整体替换运行时注册的主题集合（供扩展/测试注入已实例化的主题）。
 * 仅收录带名称的主题，且名称必须通过合法性校验。
 */
export function setRegisteredThemes(themes: Theme[]): void {
	registeredThemes.clear();
	for (const theme of themes) {
		if (theme.name) {
			assertThemeNameIsValid(theme.name);
			registeredThemes.set(theme.name, theme);
		}
	}
}

/**
 * 初始化全局主题。未指定主题名时按终端明暗取默认主题；
 * 主题非法时静默回退到 dark（启动阶段不应因主题问题报错）。
 * @param enableWatcher - 是否监听主题文件变化以支持热重载（交互模式用）
 */
export function initTheme(themeName?: string, enableWatcher: boolean = false): void {
	const name = themeName ?? getDefaultTheme();
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
	} catch (_error) {
		// 主题非法 - 静默回退到 dark 主题
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// 回退主题不启动监听器
	}
}

/**
 * 切换全局主题（按名称加载）。成功时触发 onThemeChange 回调并返回 success；
 * 失败时回退到 dark 并把错误信息带回给调用方展示（例如 /theme 命令）。
 * @param enableWatcher - 是否为新主题启动文件热重载监听
 */
export function setTheme(name: string, enableWatcher: boolean = false): { success: boolean; error?: string } {
	currentThemeName = name;
	try {
		setGlobalTheme(loadTheme(name));
		if (enableWatcher) {
			startThemeWatcher();
		}
		if (onThemeChangeCallback) {
			onThemeChangeCallback();
		}
		return { success: true };
	} catch (error) {
		// 主题非法 - 回退到 dark 主题
		currentThemeName = "dark";
		setGlobalTheme(loadTheme("dark"));
		// 回退主题不启动监听器
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * 直接设置一个已实例化的 Theme 作为全局主题（绕过按名加载）。
 * 主题名标记为 "<in-memory>"；由于没有对应文件，热重载监听会被停止。
 */
export function setThemeInstance(themeInstance: Theme): void {
	setGlobalTheme(themeInstance);
	currentThemeName = "<in-memory>";
	stopThemeWatcher(); // 无法监听直接传入的实例
	if (onThemeChangeCallback) {
		onThemeChangeCallback();
	}
}

/**
 * 注册主题变更回调（单个槽位，后注册者覆盖前者）。
 * 热重载与显式切换都会触发，通常用于让 TUI 失效重绘。
 */
export function onThemeChange(callback: () => void): void {
	onThemeChangeCallback = callback;
}

/**
 * 启动自定义主题文件的热重载监听。
 * 仅对「自定义主题且 JSON 文件存在」的场景生效（内置 dark/light 无需监听）；
 * 监听整个自定义主题目录而非单个文件（部分平台不支持单文件监听），
 * 事件经 100ms 防抖后重载主题并更新全局实例与注册缓存。
 * 编辑器保存时的中间状态（文件暂时缺失/半写完的非法 JSON）会被安全跳过。
 */
function startThemeWatcher(): void {
	stopThemeWatcher();

	// 只监听自定义主题（内置主题不监听）
	if (!currentThemeName || currentThemeName === "dark" || currentThemeName === "light") {
		return;
	}

	const customThemesDir = getCustomThemesDir();
	const watchedThemeName = currentThemeName;
	const watchedFileName = `${watchedThemeName}.json`;
	const themeFile = path.join(customThemesDir, watchedFileName);

	// 只在文件存在时监听
	if (!fs.existsSync(themeFile)) {
		return;
	}

	const scheduleReload = () => {
		// 100ms 防抖：编辑器保存常触发多个连续事件，只重载最后一次
		if (themeReloadTimer) {
			clearTimeout(themeReloadTimer);
		}
		themeReloadTimer = setTimeout(() => {
			themeReloadTimer = undefined;

			// 切换主题或停止监听后，忽略过期的定时器回调
			if (currentThemeName !== watchedThemeName) {
				return;
			}

			// 文件暂时缺失（如原子写替换的间隙）时保留当前主题不动
			if (!fs.existsSync(themeFile)) {
				return;
			}

			try {
				// 从磁盘重载主题并刷新注册表缓存
				const reloadedTheme = loadThemeFromPath(themeFile);
				registeredThemes.set(watchedThemeName, reloadedTheme);
				setGlobalTheme(reloadedTheme);
				// 通知回调（使 UI 失效重绘）
				if (onThemeChangeCallback) {
					onThemeChangeCallback();
				}
			} catch (_error) {
				// 忽略错误（文件可能正处于编辑中的非法状态）
			}
		}, 100);
	};

	themeWatcher =
		watchWithErrorHandler(
			customThemesDir,
			(_eventType, filename) => {
				// 闭包捕获的是启动监听时的主题名，主题已切换则不再关心事件
				if (currentThemeName !== watchedThemeName) {
					return;
				}
				// 某些平台事件不带文件名，只能保守地调度一次重载
				if (!filename) {
					scheduleReload();
					return;
				}
				if (filename !== watchedFileName) {
					return;
				}
				scheduleReload();
			},
			() => {
				closeWatcher(themeWatcher);
				themeWatcher = undefined;
			},
		) ?? undefined;
}

/** 停止主题热重载：清理防抖定时器并关闭文件监听器（幂等）。 */
export function stopThemeWatcher(): void {
	if (themeReloadTimer) {
		clearTimeout(themeReloadTimer);
		themeReloadTimer = undefined;
	}
	closeWatcher(themeWatcher);
	themeWatcher = undefined;
}

// ============================================================================
// HTML 导出辅助
// ============================================================================

/**
 * 把 256 色索引转换为近似的 hex 字符串。
 * 索引 0-15：基本色（采用常见终端的近似值）
 * 索引 16-231：6x6x6 色立方
 * 索引 232-255：灰阶梯度
 */
function ansi256ToHex(index: number): string {
	// 基本色（0-15）- 采用常见终端取值的近似值
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// 色立方（16-231）：6x6x6 = 216 色
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// 灰阶（232-255）：24 级灰，从 8 开始每级递增 10
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 获取解析后的主题颜色，统一转换为 CSS 可用的 hex 字符串。
 * 供 HTML 导出流程生成 CSS 自定义属性（--theme-xxx）使用。
 */
export function getResolvedThemeColors(themeName?: string): Record<string, string> {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	const isLight = name === "light";
	const themeJson = loadThemeJson(name);
	const resolved = resolveThemeColors(withThemeColorFallbacks(themeJson.colors), themeJson.vars);

	// 空值（终端默认前景色）在 HTML 中需要一个具体回退色
	const defaultText = isLight ? "#000000" : "#e5e5e7";

	const cssColors: Record<string, string> = {};
	for (const [key, value] of Object.entries(resolved)) {
		if (typeof value === "number") {
			cssColors[key] = ansi256ToHex(value);
		} else if (value === "") {
			// 空串表示终端默认颜色 - HTML 中改用合理的回退色
			cssColors[key] = defaultText;
		} else {
			cssColors[key] = value;
		}
	}
	return cssColors;
}

/**
 * 判断是否为「浅色」主题（供需要区分明/暗变体的 CSS 使用）。
 */
export function isLightTheme(themeName?: string): boolean {
	// 目前只按名称判断 - 今后可扩展为分析颜色亮度
	return themeName === "light";
}

/**
 * 获取主题 JSON 中 export 段显式声明的导出配色。
 * 未设置 export 段或某个颜色未显式给出时，对应字段返回 undefined
 * （调用方需自行准备默认值）；加载失败也返回空对象。
 */
export function getThemeExportColors(themeName?: string): {
	pageBg?: string;
	cardBg?: string;
	infoBg?: string;
} {
	const name = themeName ?? currentThemeName ?? getDefaultTheme();
	try {
		const themeJson = loadThemeJson(name);
		const exportSection = themeJson.export;
		if (!exportSection) return {};

		const vars = themeJson.vars ?? {};
		// 单值解析：变量引用展开 → 256 色索引转 hex；空串与未设置视为无值
		const resolve = (value: ColorValue | undefined): string | undefined => {
			if (value === undefined) return undefined;
			const resolved = resolveVarRefs(value, vars);
			if (typeof resolved === "number") return ansi256ToHex(resolved);
			if (resolved === "") return undefined;
			return resolved;
		};

		return {
			pageBg: resolve(exportSection.pageBg),
			cardBg: resolve(exportSection.cardBg),
			infoBg: resolve(exportSection.infoBg),
		};
	} catch {
		return {};
	}
}

// ============================================================================
// TUI 辅助
// ============================================================================

/** cli-highlight 的主题格式：语法 token 名 → 着色函数 */
type CliHighlightTheme = Record<string, (s: string) => string>;

// 语法高亮主题缓存：以 Theme 实例为键，主题切换后自动重建
let cachedHighlightThemeFor: Theme | undefined;
let cachedCliHighlightTheme: CliHighlightTheme | undefined;

/**
 * 把 cli-highlight 的语法 token 映射到主题颜色：
 * keyword/function/string 等常规 token 一一对应 syntaxXxx 色，
 * emphasis/strong/link 映射为样式而非颜色，
 * addition/deletion 复用 diff 新增/删除色。
 */
function buildCliHighlightTheme(t: Theme): CliHighlightTheme {
	return {
		keyword: (s: string) => t.fg("syntaxKeyword", s),
		built_in: (s: string) => t.fg("syntaxType", s),
		literal: (s: string) => t.fg("syntaxNumber", s),
		number: (s: string) => t.fg("syntaxNumber", s),
		regexp: (s: string) => t.fg("syntaxString", s),
		string: (s: string) => t.fg("syntaxString", s),
		comment: (s: string) => t.fg("syntaxComment", s),
		doctag: (s: string) => t.fg("syntaxComment", s),
		meta: (s: string) => t.fg("muted", s),
		function: (s: string) => t.fg("syntaxFunction", s),
		title: (s: string) => t.fg("syntaxFunction", s),
		class: (s: string) => t.fg("syntaxType", s),
		type: (s: string) => t.fg("syntaxType", s),
		tag: (s: string) => t.fg("syntaxPunctuation", s),
		name: (s: string) => t.fg("syntaxKeyword", s),
		attr: (s: string) => t.fg("syntaxVariable", s),
		variable: (s: string) => t.fg("syntaxVariable", s),
		params: (s: string) => t.fg("syntaxVariable", s),
		operator: (s: string) => t.fg("syntaxOperator", s),
		punctuation: (s: string) => t.fg("syntaxPunctuation", s),
		emphasis: (s: string) => t.italic(s),
		strong: (s: string) => t.bold(s),
		link: (s: string) => t.underline(s),
		addition: (s: string) => t.fg("toolDiffAdded", s),
		deletion: (s: string) => t.fg("toolDiffRemoved", s),
	};
}

/** 取语法高亮主题（带单槽缓存）：主题实例变化时才重新构建映射表。 */
function getCliHighlightTheme(t: Theme): CliHighlightTheme {
	if (cachedHighlightThemeFor !== t || !cachedCliHighlightTheme) {
		cachedHighlightThemeFor = t;
		cachedCliHighlightTheme = buildCliHighlightTheme(t);
	}
	return cachedCliHighlightTheme;
}

/**
 * 按指定语言对代码做语法高亮，返回逐行数组。
 * 语言不合法时退化为整块使用代码块颜色渲染（不做高亮）；
 * 高亮过程抛错时返回原始行，保证渲染永不中断。
 */
export function highlightCode(code: string, lang?: string): string[] {
	// 高亮前先校验语言，避免 cli-highlight 向 stderr 刷警告
	const validLang = lang && supportsLanguage(lang) ? lang : undefined;
	// 未指定合法语言时跳过高亮。cli-highlight 的自动检测不可靠，
	// 会把散文误判成 AppleScript、LiveCodeServer 等语言，
	// 把随机英文单词染成关键字色。
	if (!validLang) {
		return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
	}
	const opts = {
		language: validLang,
		ignoreIllegals: true,
		theme: getCliHighlightTheme(theme),
	};
	try {
		return highlight(code, opts).split("\n");
	} catch {
		// 高亮失败时返回未着色的原始行
		return code.split("\n");
	}
}

/**
 * 从文件路径的扩展名推断 cli-highlight 语言标识。
 * 不认识的扩展名返回 undefined（调用方会跳过高亮）。
 */
export function getLanguageFromPath(filePath: string): string | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (!ext) return undefined;

	const extToLang: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		mjs: "javascript",
		cjs: "javascript",
		py: "python",
		rb: "ruby",
		rs: "rust",
		go: "go",
		java: "java",
		kt: "kotlin",
		swift: "swift",
		c: "c",
		h: "c",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		hpp: "cpp",
		cs: "csharp",
		php: "php",
		sh: "bash",
		bash: "bash",
		zsh: "bash",
		fish: "fish",
		ps1: "powershell",
		sql: "sql",
		html: "html",
		htm: "html",
		css: "css",
		scss: "scss",
		sass: "sass",
		less: "less",
		json: "json",
		yaml: "yaml",
		yml: "yaml",
		toml: "toml",
		xml: "xml",
		md: "markdown",
		markdown: "markdown",
		dockerfile: "dockerfile",
		makefile: "makefile",
		cmake: "cmake",
		lua: "lua",
		perl: "perl",
		r: "r",
		scala: "scala",
		clj: "clojure",
		ex: "elixir",
		exs: "elixir",
		erl: "erlang",
		hs: "haskell",
		ml: "ocaml",
		vim: "vim",
		graphql: "graphql",
		proto: "protobuf",
		tf: "hcl",
		hcl: "hcl",
	};

	return extToLang[ext];
}

/**
 * 构建 pi-tui 的 Markdown 渲染主题：把各 Markdown 元素（标题/链接/代码/
 * 引用/分隔线/列表等）映射到当前主题的 mdXxx 颜色与文本样式；
 * 代码块高亮复用 {@link highlightCode} 的同一套逻辑。
 */
export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		highlightCode: (code: string, lang?: string): string[] => {
			// 高亮前先校验语言，避免 cli-highlight 向 stderr 刷警告
			const validLang = lang && supportsLanguage(lang) ? lang : undefined;
			// 未指定合法语言时跳过高亮。cli-highlight 的自动检测不可靠，
			// 会把散文误判成 AppleScript、LiveCodeServer 等语言，
			// 把随机英文单词染成关键字色。
			if (!validLang) {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
			const opts = {
				language: validLang,
				ignoreIllegals: true,
				theme: getCliHighlightTheme(theme),
			};
			try {
				return highlight(code, opts).split("\n");
			} catch {
				return code.split("\n").map((line) => theme.fg("mdCodeBlock", line));
			}
		},
	};
}

/** 构建下拉选择列表主题：选中项用强调色，描述/滚动信息/无匹配提示用弱化色。 */
export function getSelectListTheme(): SelectListTheme {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

/** 构建编辑器主题：边框用弱化边框色，内嵌选择列表复用选择列表主题。 */
export function getEditorTheme(): EditorTheme {
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		selectList: getSelectListTheme(),
	};
}

/**
 * 构建设置列表主题：选中行的标签/取值用强调色，
 * 未选中取值用弱化色，描述与提示用更暗的 dim 色，光标为强调色箭头。
 */
export function getSettingsListTheme(): SettingsListTheme {
	return {
		label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
		value: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text: string) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text: string) => theme.fg("dim", text),
	};
}
