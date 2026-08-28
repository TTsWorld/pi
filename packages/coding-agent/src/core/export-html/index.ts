/**
 * @file export-html/index.ts —— 会话导出 HTML 的入口（模板组装与主题注入）
 *
 * @description
 * 把一段已持久化的 Agent 会话（SessionManager 管理的 .jsonl 会话文件）渲染成
 * 一个可脱离终端独立打开的 HTML 页面：
 * - 读取导出模板目录下的 template.html / template.css / template.js，以及内嵌的
 *   marked（Markdown 渲染）和 highlight.js（代码高亮）两个厂商脚本；
 * - 根据主题名解析终端主题颜色，生成 CSS 自定义属性（--xxx 形式）注入模板，
 *   让导出页面的观感与用户当前 TUI 主题保持一致；
 * - 可选地通过 ToolHtmlRenderer 把自定义工具的 TUI 渲染结果预渲染成 HTML，
 *   随会话数据一起内嵌（见 preRenderCustomTools）；
 * - 会话数据整体 JSON 序列化后 Base64 编码内嵌，规避在 HTML 里做复杂转义。
 *
 * 对外提供两个入口：
 * - exportSessionToHtml：供 TUI 的 /export 命令调用（agent-session.ts 使用），
 *   可携带 AgentState（系统提示词、工具清单）一并导出；
 * - exportFromFile：供 CLI 使用（main.ts），无需运行时状态即可导出任意会话文件。
 *
 * 依赖关系：
 * - ../session-manager.ts：读取会话头、条目列表与叶子节点 ID；
 * - ../../modes/interactive/theme/theme.ts：主题颜色解析（含导出专用配色）；
 * - ../../config.ts：导出模板目录位置与应用名（用于拼默认输出文件名）。
 */

import type { AgentState } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDir } from "../../config.ts";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { SessionManager } from "../session-manager.ts";

/**
 * 自定义工具渲染为 HTML 的接口。
 * 由 agent-session 实现，用于在导出前把扩展工具的输出预先渲染成 HTML。
 */
export interface ToolHtmlRenderer {
	/** 把一次工具调用渲染为 HTML；工具没有自定义渲染器时返回 undefined。 */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** 把工具结果渲染为 HTML（返回折叠态/展开态两种）；工具没有自定义渲染器时返回 undefined。 */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/** 某次自定义工具调用及其结果预先渲染出的 HTML（以 toolCallId 为键存放） */
interface RenderedToolHtml {
	callHtml?: string;
	resultHtmlCollapsed?: string;
	resultHtmlExpanded?: string;
}

/** HTML 导出选项（两个导出入口共用） */
export interface ExportOptions {
	/** 输出文件路径；缺省时按会话文件名生成 <APP_NAME>-session-<名字>.html */
	outputPath?: string;
	/** 终端主题名；缺省时使用当前默认主题 */
	themeName?: string;
	/** 可选的自定义工具渲染器 */
	toolRenderer?: ToolHtmlRenderer;
}

/**
 * 把颜色字符串解析为 RGB 分量。
 * 支持 hex（#RRGGBB）与 rgb(r,g,b) 两种格式；两者都不匹配时返回 undefined，
 * 由调用方决定兜底行为。
 */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/**
 * 计算颜色的相对亮度（0-1，越大越亮）。
 * 采用 WCAG 的相对亮度公式：先把各通道做 sRGB → 线性空间的 gamma 展开，
 * 再按人眼对红绿蓝的敏感度加权（0.2126 / 0.7152 / 0.0722）求和。
 */
function getLuminance(r: number, g: number, b: number): number {
	// 单通道 sRGB（0-255 归一到 0-1）转线性亮度；0.03928 是分段公式的分界阈值
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 调整颜色亮度：各通道统一乘以 factor。
 * factor > 1 提亮、< 1 压暗；解析失败的颜色原样返回。
 */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	// 解析失败（如命名色）时不做处理，保证输出仍是合法 CSS 颜色
	if (!parsed) return color;
	// 单通道乘系数后夹回 0-255，避免乘出越界值
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/**
 * 从基准色（通常是主题的 userMessageBg）推导导出页面的一组背景色：
 * 页面底色 pageBg、卡片底色 cardBg、提示条底色 infoBg。
 * 思路是保持与基准色同一色系，仅按明暗微调，让导出观感贴近原主题。
 */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		// 基准色解析失败时的兜底：一套经典深色调（暗页面 + 略亮的卡片 + 偏暖的提示条）
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	// 0.5 为明暗分界：亮色主题与暗色主题的推导方向相反
	const isLight = luminance > 0.5;

	if (isLight) {
		// 亮色主题：页面略压暗以衬托卡片，infoBg 朝暖色偏移（红绿升、蓝降）
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	// 暗色主题：页面压得更暗、卡片略亮以形成层次，infoBg 朝暖色提亮
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * 根据主题颜色生成 CSS 自定义属性声明（逐行拼接成 `--key: value;`），
 * 最终会被注入导出模板的 CSS 中。
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	// 终端主题的每个颜色项原样映射成一个 CSS 变量，供模板引用
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// 优先使用主题显式声明的导出配色；没有时再从 userMessageBg 自动推导
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

/** 内嵌进导出页面的会话数据（前端模板 JS 会 Base64 解码后按此结构渲染） */
interface SessionData {
	/** 会话头（模型、时间等元信息） */
	header: ReturnType<SessionManager["getHeader"]>;
	/** 会话全部条目（消息树的所有节点，前端沿分支路径渲染） */
	entries: ReturnType<SessionManager["getEntries"]>;
	/** 当前分支的叶子节点 ID，前端据此确定渲染到哪条对话路径 */
	leafId: string | null;
	/** 导出时使用的系统提示词（仅 TUI 导出能提供） */
	systemPrompt?: string;
	/** 导出时注册的工具清单（仅 TUI 导出能提供） */
	tools?: Array<Pick<ToolDefinition, "name" | "description" | "parameters">>;
	/** 自定义工具调用/结果预渲染出的 HTML，以 toolCallId 为键 */
	renderedTools?: Record<string, RenderedToolHtml>;
}

/**
 * 核心 HTML 生成逻辑，被下面两个导出入口共用。
 * 流程：读取模板与厂商脚本 → 生成主题 CSS 变量 → 会话数据 Base64 内嵌 →
 * 逐个替换模板占位符，最终产出单文件 HTML。
 */
function generateHtml(sessionData: SessionData, themeName?: string): string {
	// 模板三件套与两个厂商脚本（marked 渲染 Markdown、highlight.js 做代码高亮）
	// 全部读入内存并内嵌进产物，导出的 HTML 因此不依赖网络与本地资源
	const templateDir = getExportTemplateDir();
	const template = readFileSync(join(templateDir, "template.html"), "utf-8");
	const templateCss = readFileSync(join(templateDir, "template.css"), "utf-8");
	const templateJs = readFileSync(join(templateDir, "template.js"), "utf-8");
	const markedJs = readFileSync(join(templateDir, "vendor", "marked.min.js"), "utf-8");
	const hljsJs = readFileSync(join(templateDir, "vendor", "highlight.min.js"), "utf-8");

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;

	// 会话数据先 JSON 序列化再 Base64 编码内嵌：避免把大段 JSON 直接写进 HTML
	// 时还要处理 <script> 标签、引号等转义问题
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");

	// 把主题变量与三处背景色注入 CSS 模板
	const css = templateCss
		.replace("{{THEME_VARS}}", themeVars)
		.replace("{{BODY_BG}}", bodyBg)
		.replace("{{CONTAINER_BG}}", containerBg)
		.replace("{{INFO_BG}}", infoBg);

	// 依次填充 HTML 模板的占位符：样式、交互脚本、会话数据与厂商库
	return template
		.replace("{{CSS}}", css)
		.replace("{{JS}}", templateJs)
		.replace("{{SESSION_DATA}}", sessionDataBase64)
		.replace("{{MARKED_JS}}", markedJs)
		.replace("{{HIGHLIGHT_JS}}", hljsJs);
}

/** 由 HTML 模板（前端 JS）直接渲染的内置工具，不走 TUI→ANSI→HTML 预渲染管线 */
const TEMPLATE_RENDERED_TOOLS = new Set(["bash", "read", "write", "edit", "ls"]);

/**
 * 用工具的 TUI 渲染器把自定义工具预渲染成 HTML。
 * 遍历会话条目，收集所有「非模板渲染」工具的调用与结果 HTML，
 * 返回以 toolCallId 为键的映射，随会话数据一起内嵌进导出页面。
 */
function preRenderCustomTools(
	entries: SessionEntry[],
	toolRenderer: ToolHtmlRenderer,
): Record<string, RenderedToolHtml> {
	const renderedTools: Record<string, RenderedToolHtml> = {};

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const msg = entry.message;

		// 先处理 assistant 消息里的工具调用块
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === "toolCall" && !TEMPLATE_RENDERED_TOOLS.has(block.name)) {
					const callHtml = toolRenderer.renderCall(block.id, block.name, block.arguments);
					if (callHtml) {
						renderedTools[block.id] = { callHtml };
					}
				}
			}
		}

		// 再处理工具结果消息
		if (msg.role === "toolResult" && msg.toolCallId) {
			const toolName = msg.toolName || "";
			// 两种情况需要渲染结果：调用块已预渲染过，或该工具不由模板渲染
			const existing = renderedTools[msg.toolCallId];
			if (existing || !TEMPLATE_RENDERED_TOOLS.has(toolName)) {
				const rendered = toolRenderer.renderResult(
					msg.toolCallId,
					toolName,
					msg.content,
					msg.details,
					msg.isError || false,
				);
				if (rendered) {
					renderedTools[msg.toolCallId] = {
						...existing,
						resultHtmlCollapsed: rendered.collapsed,
						resultHtmlExpanded: rendered.expanded,
					};
				}
			}
		}
	}

	return renderedTools;
}

/**
 * 把当前会话导出为 HTML（基于 SessionManager 与可选的 AgentState）。
 * 供 TUI 的 /export 命令调用（见 agent-session.ts）；携带 state 时可顺带
 * 导出系统提示词与工具清单。
 *
 * @param sm - 当前会话的 SessionManager（会话必须已持久化到磁盘）
 * @param state - 可选的 Agent 运行时状态，提供 systemPrompt 与 tools
 * @param options - 导出选项；也兼容直接传字符串（视为输出路径）
 * @returns 实际写入的输出文件路径
 * @throws 会话仍只在内存中（无会话文件）或会话文件尚不存在时抛错
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	// 兼容旧签名：options 为字符串时当作输出路径
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};

	const sessionFile = sm.getSessionFile();
	if (!sessionFile) {
		throw new Error("Cannot export in-memory session to HTML");
	}
	if (!existsSync(sessionFile)) {
		throw new Error("Nothing to export yet - start a conversation first");
	}

	const entries = sm.getEntries();

	// 提供了工具渲染器时，先把自定义工具预渲染成 HTML
	let renderedTools: Record<string, RenderedToolHtml> | undefined;
	if (opts.toolRenderer) {
		renderedTools = preRenderCustomTools(entries, opts.toolRenderer);
		// 一个都没渲染到就不带该字段，省得序列化一个空对象
		if (Object.keys(renderedTools).length === 0) {
			renderedTools = undefined;
		}
	}

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries,
		leafId: sm.getLeafId(),
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
		renderedTools,
	};

	const html = generateHtml(sessionData, opts.themeName);

	// 未指定输出路径时，默认输出到当前目录，文件名沿用会话文件名
	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}

/**
 * 把任意会话文件导出为 HTML（独立入口，不依赖 AgentState）。
 * 供 CLI 使用（见 main.ts），可导出历史会话文件；
 * 因此不含系统提示词与工具清单（会话文件里没有这些信息）。
 *
 * @param inputPath - .jsonl 会话文件路径
 * @param options - 导出选项；也兼容直接传字符串（视为输出路径）
 * @returns 实际写入的输出文件路径
 * @throws 输入文件不存在时抛错
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	// 以只读方式打开目标会话文件
	const sm = SessionManager.open(resolvedInputPath);

	const sessionData: SessionData = {
		header: sm.getHeader(),
		entries: sm.getEntries(),
		leafId: sm.getLeafId(),
		systemPrompt: undefined,
		tools: undefined,
	};

	const html = generateHtml(sessionData, opts.themeName);

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const inputBasename = basename(resolvedInputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	writeFileSync(outputPath, html, "utf8");
	return outputPath;
}
