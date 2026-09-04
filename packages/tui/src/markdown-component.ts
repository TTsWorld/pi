/**
 * @file markdown-component.ts
 * @description Markdown 渲染组件 —— 将 Markdown 文本解析并渲染为带样式的终端输出
 * @module pi-tui
 *
 * 主要功能：
 * - 使用 marked 的词法分析器（lexer）将 Markdown 文本切分为 token 树
 * - 将块级 token（标题/段落/代码块/列表/引用/分隔线等）转换为带 ANSI 颜色样式的终端行
 * - 递归渲染行内 token（粗体/斜体/行内代码/链接/删除线/换行）
 * - 按终端宽度对已着色的行做折行处理（正确跳过 ANSI 转义序列，不重复计数）
 * - 通过对比前后两次渲染结果，向渲染循环报告内容是否发生变化（changed）
 *
 * 依赖关系：
 * - marked：Markdown 解析（lexer 产出 token 流）
 * - chalk：生成 ANSI 颜色/样式转义序列
 * - ./tui.js：Component 组件契约与 ComponentRenderResult 渲染结果类型
 */

import chalk from "chalk";
import { marked, type Token } from "marked";
import type { Component, ComponentRenderResult } from "./tui.js";

/**
 * Markdown 渲染组件。
 * 实现 Component 契约：每次 render(width) 时解析当前 Markdown 文本，
 * 输出按指定宽度折行、带 ANSI 样式的终端文本行。
 */
export class MarkdownComponent implements Component {
	/** 当前待渲染的 Markdown 源文本 */
	private text: string;
	/** 最近一次渲染产生的（已折行）文本行 */
	private lines: string[] = [];
	/** 上一次渲染的文本行，用于计算 changed 标记 */
	private previousLines: string[] = [];

	/**
	 * 创建 Markdown 渲染组件。
	 * @param text 初始 Markdown 文本，默认为空字符串
	 */
	constructor(text: string = "") {
		this.text = text;
	}

	/**
	 * 更新待渲染的 Markdown 文本。
	 * 不会立即渲染，真正的解析与折行发生在下一次 render() 调用时。
	 * @param text 新的 Markdown 文本
	 */
	setText(text: string): void {
		this.text = text;
	}

	/**
	 * 渲染 Markdown 文本为终端文本行。
	 * 流程：词法分析 → 逐 token 转换为带样式的行 → 按宽度折行 → 与上次结果对比得出 changed。
	 * @param width 可用宽度（终端列数），超出该宽度的行会被折行
	 * @returns 渲染出的文本行及内容是否发生变化
	 */
	render(width: number): ComponentRenderResult {
		// ========== 词法分析：将 Markdown 源文本解析为 token 流 ==========
		const tokens = marked.lexer(this.text);

		// ========== 逐 token 转换：把每个 token 渲染为带 ANSI 样式的行 ==========
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			// 预取下一个 token 的类型，供块级元素决定是否需要追加空行（间距控制）
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, width, nextToken?.type);
			renderedLines.push(...tokenLines);
		}

		// ========== 折行：确保每行的可见宽度不超过可用宽度 ==========
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			wrappedLines.push(...this.wrapLine(line, width));
		}

		// 保存渲染历史，供下次 render 时计算 changed
		this.previousLines = this.lines;
		this.lines = wrappedLines;

		// ========== 变化检测：行数不同或任一行内容不同即视为已变化 ==========
		const changed =
			this.lines.length !== this.previousLines.length ||
			this.lines.some((line, i) => line !== this.previousLines[i]);

		return {
			lines: this.lines,
			changed,
		};
	}

	/**
	 * 将单个块级 token 渲染为若干带样式的终端行。
	 * 针对 marked 产生的每种块级 token 类型（heading/paragraph/code/list/blockquote/hr 等）
	 * 分别应用不同的 chalk 样式与间距策略。
	 * @param token 待渲染的块级 token
	 * @param width 可用宽度（仅 hr 分隔线需要，用于限制线长）
	 * @param nextTokenType 下一个 token 的类型，用于决定段落后的间距（避免重复空行）
	 * @returns 渲染出的文本行数组
	 */
	private renderToken(token: Token, width: number, nextTokenType?: string): string[] {
		const lines: string[] = [];

		switch (token.type) {
			// ========== 标题：按层级应用不同样式 ==========
			case "heading": {
				const headingLevel = token.depth;
				// 三级及以上标题保留 "### " 形式的前缀，一二级直接用颜色区分
				const headingPrefix = "#".repeat(headingLevel) + " ";
				const headingText = this.renderInlineTokens(token.tokens || []);
				if (headingLevel === 1) {
					// 一级标题：加粗 + 下划线 + 黄色，最醒目
					lines.push(chalk.bold.underline.yellow(headingText));
				} else if (headingLevel === 2) {
					// 二级标题：加粗 + 黄色
					lines.push(chalk.bold.yellow(headingText));
				} else {
					// 三级及以上：仅加粗，并保留 "#" 前缀以示层级
					lines.push(chalk.bold(headingPrefix + headingText));
				}
				lines.push(""); // 标题后追加空行，形成视觉间距
				break;
			}

			// ========== 段落：渲染行内内容并按需追加间距 ==========
			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || []);
				lines.push(paragraphText);
				// 若下一个 token 是列表或空行，则由它们自行处理间距，避免出现连续空行
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			// ========== 代码块：围栏 + 缩进的绿色代码行 ==========
			case "code": {
				// 起始围栏带上语言标识（如 ```ts）
				lines.push(chalk.gray("```" + (token.lang || "")));
				// 按换行符拆分代码内容，每行统一加两个空格缩进并着色
				const codeLines = token.text.split("\n");
				for (const codeLine of codeLines) {
					lines.push(chalk.dim("  ") + chalk.green(codeLine));
				}
				lines.push(chalk.gray("```"));
				lines.push(""); // 代码块后追加空行
				break;
			}

			// ========== 列表：有序/无序两种项目符号 ==========
			case "list":
				for (let i = 0; i < token.items.length; i++) {
					const item = token.items[i];
					// 有序列表用 "1. "，无序列表用 "- "
					const bullet = token.ordered ? `${i + 1}. ` : "- ";
					const itemText = this.renderInlineTokens(item.tokens || []);

					// 检查项目文本是否包含多行（如内含 <br> 的嵌套内容）
					const itemLines = itemText.split("\n").filter((line) => line.trim());
					if (itemLines.length > 1) {
						// 首行作为带项目符号的列表项
						lines.push(chalk.cyan(bullet) + itemLines[0]);
						// 其余行视为独立内容块，前面加空行分隔
						for (let j = 1; j < itemLines.length; j++) {
							lines.push(""); // 追加间距
							lines.push(itemLines[j]);
						}
					} else {
						lines.push(chalk.cyan(bullet) + itemText);
					}
				}
				// 若列表后紧跟 space token，则由该 token 负责间距
				// （避免重复空行）
				break;

			// ========== 引用块：左侧灰色竖线 + 斜体 ==========
			case "blockquote": {
				const quoteText = this.renderInlineTokens(token.tokens || []);
				const quoteLines = quoteText.split("\n");
				for (const quoteLine of quoteLines) {
					lines.push(chalk.gray("│ ") + chalk.italic(quoteLine));
				}
				lines.push(""); // 引用块后追加空行
				break;
			}

			// ========== 水平分隔线：用 "─" 铺满宽度（上限 80 列） ==========
			case "hr":
				// Math.min(width, 80)：避免在超宽终端中分隔线过长
				lines.push(chalk.gray("─".repeat(Math.min(width, 80))));
				lines.push(""); // 分隔线后追加空行
				break;

			// ========== HTML 块：终端输出直接跳过 ==========
			case "html":
				// 终端环境无法渲染 HTML，忽略之
				break;

			// ========== 空行 token：对应 Markdown 源码中的空行 ==========
			case "space":
				// space token 表示 Markdown 中的空行
				lines.push("");
				break;

			default:
				// 其余未特殊处理的 token 类型：若含 text 字段则按纯文本输出
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	/**
	 * 递归渲染行内 token 序列为带样式的字符串。
	 * 处理粗体、斜体、行内代码、链接、换行、删除线等行内语法元素；
	 * 嵌套结构（如粗体中包含斜体）通过递归调用本方法自然展开。
	 * @param tokens 行内 token 数组（可能为空）
	 * @returns 拼接后的带 ANSI 样式的字符串（可能含换行符 "\n"）
	 */
	private renderInlineTokens(tokens: Token[]): string {
		let result = "";

		for (const token of tokens) {
			switch (token.type) {
				// ========== 纯文本：可能仍嵌套行内格式 token ==========
				case "text":
					// 列表项等场景下的 text token 内部还会再嵌套行内格式 token，
					// 需递归渲染而非直接取原始文本
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens);
					} else {
						result += token.text;
					}
					break;

				// ========== 粗体 **text** ==========
				case "strong":
					result += chalk.bold(this.renderInlineTokens(token.tokens || []));
					break;

				// ========== 斜体 *text* ==========
				case "em":
					result += chalk.italic(this.renderInlineTokens(token.tokens || []));
					break;

				// ========== 行内代码 `code`：青色内容 + 灰色反引号 ==========
				case "codespan":
					result += chalk.gray("`") + chalk.cyan(token.text) + chalk.gray("`");
					break;

				// ========== 链接 [text](href)：蓝色下划线文本 + 灰色裸链接 ==========
				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || []);
					// 终端无法点击链接，因此在链接文本后以灰色附带原始 href
					result += chalk.underline.blue(linkText) + chalk.gray(` (${token.href})`);
					break;
				}

				// ========== 硬换行 <br>：输出真实换行符 ==========
				case "br":
					result += "\n";
					break;

				// ========== 删除线 ~~text~~ ==========
				case "del":
					result += chalk.strikethrough(this.renderInlineTokens(token.tokens || []));
					break;

				default:
					// 其余未特殊处理的行内 token：若含 text 字段则按纯文本输出
					if ("text" in token && typeof token.text === "string") {
						result += token.text;
					}
			}
		}

		return result;
	}

	/**
	 * 将单行文本按可用宽度折行为多行。
	 * 关键点：行内混有 ANSI 转义序列（颜色/样式码），它们不占显示宽度，
	 * 折行时必须原样保留且不计入列数，否则会导致终端中行宽错乱。
	 * @param line 待折行的文本行（可能包含 ANSI 转义序列）
	 * @param width 可用宽度（可见字符数上限）
	 * @returns 折行后的行数组；空行返回 [""]，保证调用方始终拿到非空数组
	 */
	private wrapLine(line: string, width: number): string[] {
		// 折行时需正确处理 ANSI 转义序列
		const wrapped: string[] = [];

		// 边界情况：空行/未定义行直接返回单条空行
		if (!line) {
			return [""];
		}

		// 若可见宽度未超限，无需折行，原样返回（完整保留样式）
		const visibleLength = this.getVisibleLength(line);
		if (visibleLength <= width) {
			return [line];
		}

		// ========== 超宽折行：逐字符扫描，跳过 ANSI 序列 ==========
		// 注意：带 ANSI 码的折行实现较复杂，这里采用简化方案，
		// 折行点处可能丢失样式（新行不会重新输出前一行遗留的颜色状态）
		let currentLine = "";
		let currentLength = 0; // 当前行的可见字符数（不含 ANSI 码）
		let i = 0;

		while (i < line.length) {
			if (line[i] === "\x1b" && line[i + 1] === "[") {
				// ANSI 转义序列（ESC [ ... 终止符）：原样追加，不计入可见长度
				let j = i + 2;
				// 向后扫描直到遇到终止符（m=SGR 颜色，G/K/H/J=光标/清屏类操作）
				while (j < line.length && line[j] && !/[mGKHJ]/.test(line[j]!)) {
					j++;
				}
				if (j < line.length) {
					currentLine += line.substring(i, j + 1);
					i = j + 1;
				} else {
					// 序列不完整（无终止符），终止扫描避免死循环
					break;
				}
			} else {
				// 普通可见字符：先检查是否已达宽度上限，达到则切出新行
				if (currentLength >= width) {
					wrapped.push(currentLine);
					currentLine = "";
					currentLength = 0;
				}
				currentLine += line[i];
				currentLength++;
				i++;
			}
		}

		// 收尾：把最后一行（不足 width）也压入结果
		if (currentLine) {
			wrapped.push(currentLine);
		}

		// 兜底：任何情况下都至少返回一行，避免调用方拿到空数组
		return wrapped.length > 0 ? wrapped : [""];
	}

	/**
	 * 计算字符串在终端中的可见长度。
	 * 通过正则剔除 SGR 类 ANSI 转义序列（如 \x1b[1m、\x1b[31;1m）后统计字符数。
	 * @param str 待测量的字符串（可能为空）
	 * @returns 去除 ANSI 码后的字符数
	 */
	private getVisibleLength(str: string): number {
		// 剔除 ANSI 转义序列后统计可见字符数
		return (str || "").replace(/\x1b\[[0-9;]*m/g, "").length;
	}
}
