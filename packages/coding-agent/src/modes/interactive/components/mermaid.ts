/**
 * @file mermaid.ts —— Mermaid 图表的终端渲染 Markdown 转换器
 *
 * @description
 * 提供一个 MarkdownTransformer：扫描 Markdown 中的顶层 Mermaid 代码块，
 * 用 grok-mermaid 渲染成 Unicode 字符图表，并按当前主题着色后
 * 以行内代码形式回填，保证等宽对齐。支持关闭 / 流式 / 始终三种渲染模式。
 */
import { Marked, type Token } from "@earendil-works/pi-tui";
import { type MermaidArt, render, type Span } from "grok-mermaid";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../theme/theme.ts";

// 复用的 Markdown 词法分析器，用于把文档切分为顶层 token
const markdownParser = new Marked();

/** 创建 Mermaid 转换器所需的选项 */
interface MermaidTransformerOptions {
	/** 获取当前渲染模式（off / streaming / always），每次转换时动态读取 */
	getMode: () => MermaidRenderingMode;
	/** 可选主题；提供时按语义 span 给图表着色 */
	theme?: Theme;
}

/** 类型守卫：判断 Markdown token 是否为 mermaid 代码块（lang 首词为 mermaid） */
function isMermaid(token: Token): token is Token & { type: "code"; text: string; lang?: string } {
	// 只取 lang 的第一个单词比较，忽略大小写与首尾空白
	return token.type === "code" && token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === "mermaid";
}

/**
 * 把图表的单行文本包装成 Markdown 行内代码，
 * 关键在于正确处理内容本身含反引号的情形（见下方注释）。
 */
function codeSpan(line: string): string {
	// 把图表的每一行编码为行内代码（` ... `），让 Markdown 保留其中的
	// 空格与制表框线字符。空行用不间断空格代替，因为空的行内代码
	// 没有可见高度。
	const content = line || "\u00a0";
	// CommonMark 行内代码使用成对的反引号作定界符，因此要选一个比内容中
	// 任意连续反引号更长的定界符（``hel`lo`` -> <code>hel`lo</code>）。
	// 若内容以反引号开头或结尾，用一个空格把它与定界符隔开即可保留该反引号，
	// 渲染时 CommonMark 会去掉这层填充（`` `edge` `` -> <code>`edge`</code>）。
	// Mermaid 标签里可以保留反引号，例如：
	//   `┌──────────────┐    ┌──────────────┐`
	// ```│ plain ` tick ├───▶│ two `` ticks │```
	//   `└──────────────┘    └──────────────┘`
	const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
	const fence = "`".repeat(longestBacktickRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/** 按语义类别把单个 span 映射为主题前景色（边框/文本/边线/标题等） */
function styleSpan(span: Span, theme: Theme): string {
	switch (span.cls) {
		case "border":
			return theme.fg("borderMuted", span.text);
		case "text":
			return theme.fg("text", span.text);
		case "edge":
			return theme.fg("accent", span.text);
		case "edgeLabel":
			return theme.fg("muted", span.text);
		case "title":
			return theme.fg("accent", theme.bold(span.text));
		case "none":
			return span.text;
	}
}

/** 把渲染结果的每一行逐 span 着色后拼接为字符串数组 */
function themedLines(art: MermaidArt, theme: Theme): string[] {
	return art.styled.map((row) => row.map((span) => styleSpan(span, theme)).join(""));
}

/**
 * 创建一个 Markdown 转换器：把顶层的 Mermaid 代码块替换为 Unicode 终端图表。
 *
 * 非交互场景（如导出）可不传主题，退回 art.plain 纯文本；
 * 渲染失败或图表宽度超出可用宽度时，保留原始代码块不动。
 */
export function createMermaidMarkdownTransformer(options: MermaidTransformerOptions): MarkdownTransformer {
	return (markdown, context) => {
		const mode = options.getMode();
		// 关闭模式、思考消息、或流式但未开流式渲染时，原文返回
		if (
			mode === "off" ||
			context.messageType === "assistant-thinking" ||
			(context.isStreaming && mode !== "streaming")
		) {
			return markdown;
		}

		// 逐 token 处理：非 mermaid 块原样保留
		return markdownParser
			.lexer(markdown)
			.map((token) => {
				if (!isMermaid(token)) return token.raw;
				const art = render(token.text);
				// 渲染失败或图表比可用宽度还宽时，放弃替换
				if (!art || art.width > context.availableWidth) return token.raw;
				// 非流式且带警告：图表下方追加 warning 色的提示行
				if (!context.isStreaming && art.warnings.length > 0) {
					const suffix = art.warnings.length > 1 ? ` (+${art.warnings.length - 1} more)` : "";
					const warning = `Mermaid diagram not rendered: ${art.warnings[0]}${suffix}`;
					const styledWarning = options.theme ? options.theme.fg("warning", warning) : warning;
					return `${token.raw}\n${codeSpan(styledWarning)}  \n`;
				}
				const lines = options.theme ? themedLines(art, options.theme) : art.plain;
				// 用 Markdown 硬换行保证图表每一行各占一行。
				return `${lines.map(codeSpan).join("  \n")}\n`;
			})
			.join("");
	};
}
