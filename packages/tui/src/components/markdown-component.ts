/**
 * @file Markdown 渲染组件
 * @description pi monorepo 终端 UI 框架（tui）的 Markdown 渲染组件。
 *              将 Markdown 文本解析为带 chalk 样式的多行终端输出：
 *              1. 用 marked 的 lexer 将 Markdown 文本解析为 token 树；
 *              2. 将各类 token（标题/段落/代码块/列表/引用等）映射为
 *                 带 ANSI 颜色与样式的字符串行（renderToken / renderInlineTokens）；
 *              3. 对超宽行做 ANSI 感知的自动换行（wrapLine），换行时保留
 *                 样式转义序列，避免颜色在折行处丢失或泄漏到行尾。
 * @dependencies chalk（终端着色）、marked（Markdown lexer）、../tui.js（Component 接口与组件 ID 分配）
 */
import chalk from "chalk";
import { marked, type Token } from "marked";
import { type Component, type ComponentRenderResult, getNextComponentId } from "../tui.js";

/**
 * Markdown 渲染组件：把 Markdown 文本渲染为可直接绘制到终端的样式化行数组。
 *
 * 实现 Component 接口，供 TUI 框架调用 render(width) 逐帧渲染。
 */
export class MarkdownComponent implements Component {
	/** 框架分配的唯一组件 ID */
	readonly id = getNextComponentId();
	/** 当前要渲染的 Markdown 原始文本 */
	private text: string;
	/** 最近一次渲染产出的行（已换行、带 ANSI 样式） */
	private lines: string[] = [];
	/** 上一次渲染的行，用于变更检测（帧间 diff） */
	private previousLines: string[] = [];

	/**
	 * 创建 Markdown 组件。
	 * @param text 初始 Markdown 文本，默认为空字符串
	 */
	constructor(text: string = "") {
		this.text = text;
	}

	/**
	 * 更新要渲染的 Markdown 文本（不触发渲染，渲染发生在下一次 render 调用）。
	 * @param text 新的 Markdown 文本
	 */
	setText(text: string): void {
		this.text = text;
	}

	/**
	 * 渲染当前 Markdown 文本为限定宽度的样式化行数组。
	 * @param width 目标终端宽度（可见字符数，不含 ANSI 转义序列）
	 * @returns 渲染结果：行数组 + 相对上一帧是否发生变化（changed 用于增量重绘）
	 */
	render(width: number): ComponentRenderResult {
		// ========== 解析 Markdown 为 token ==========
		// marked.lexer 输出类 HTML 结构的顶层 token 流（heading/paragraph/code/list 等）
		const tokens = marked.lexer(this.text);

		// ========== token → 样式化行 ==========
		// 将 token 流逐个转换为终端输出行
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			// 预取下一个 token 的类型，供段落等元素判断是否需要追加空行
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, width, nextToken?.type);
			renderedLines.push(...tokenLines);
		}

		// ========== ANSI 感知换行 ==========
		// 对每行按 width 折行，超宽行会被拆成多行且保留 ANSI 样式
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			wrappedLines.push(...this.wrapLine(line, width));
		}

		// ========== 变更检测 ==========
		// 先保存上一帧结果，再更新当前结果，供帧间 diff 使用
		this.previousLines = this.lines;
		this.lines = wrappedLines;

		// 行数不同或任一行内容不同，即视为内容发生变化
		const changed =
			this.lines.length !== this.previousLines.length ||
			this.lines.some((line, i) => line !== this.previousLines[i]);

		return {
			lines: this.lines,
			changed,
		};
	}

	/**
	 * 将单个块级 token 渲染为若干终端行。
	 * 负责标题、段落、代码块、列表、引用、分隔线等块级元素到
	 * chalk 样式行的映射，并在合适位置插入空行控制间距。
	 * @param token marked 输出的块级 token
	 * @param width 目标终端宽度（用于 hr 的分隔线长度）
	 * @param nextTokenType 下一个 token 的类型，用于决定是否追加空行（避免与后续空行叠加）
	 * @returns 渲染出的行数组
	 */
	private renderToken(token: Token, width: number, nextTokenType?: string): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				// 3 级及以下标题保留 "# " 前缀；1/2 级靠颜色区分层级
				const headingPrefix = "#".repeat(headingLevel) + " ";
				const headingText = this.renderInlineTokens(token.tokens || []);
				if (headingLevel === 1) {
					lines.push(chalk.bold.underline.yellow(headingText));
				} else if (headingLevel === 2) {
					lines.push(chalk.bold.yellow(headingText));
				} else {
					lines.push(chalk.bold(headingPrefix + headingText));
				}
				lines.push(""); // 标题后追加空行作为间距
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || []);
				lines.push(paragraphText);
				// 若下一个 token 是列表或空行 token，则不再追加空行，
				// 避免段落与后续元素之间的空行叠加（空行 token / 列表自身会处理间距）
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				// 围栏代码块：输出 ``` 语言标记 开头
				lines.push(chalk.gray("```" + (token.lang || "")));
				// 按换行符拆分代码内容，逐行加缩进和绿色样式
				const codeLines = token.text.split("\n");
				for (const codeLine of codeLines) {
					lines.push(chalk.dim("  ") + chalk.green(codeLine));
				}
				lines.push(chalk.gray("```"));
				lines.push(""); // 代码块后追加空行作为间距
				break;
			}

			case "list":
				for (let i = 0; i < token.items.length; i++) {
					const item = token.items[i];
					// 有序列表用 "1. " 编号，无序列表用 "- " 圆点
					const bullet = token.ordered ? `${i + 1}. ` : "- ";
					const itemText = this.renderInlineTokens(item.tokens || []);

					// 检查列表项文本是否包含多行（嵌入了换行等内容）
					// 过滤掉纯空白行，只保留有内容的行
					const itemLines = itemText.split("\n").filter((line) => line.trim());
					if (itemLines.length > 1) {
						// 第一行作为列表项本体（带 bullet 前缀）
						lines.push(chalk.cyan(bullet) + itemLines[0]);
						// 其余行作为独立内容输出（不再带 bullet）
						for (let j = 1; j < itemLines.length; j++) {
							lines.push(""); // 插入空行与列表项隔开
							lines.push(itemLines[j]);
						}
					} else {
						lines.push(chalk.cyan(bullet) + itemText);
					}
				}
				// 若列表后紧跟空行 token，则此处不追加空行
				// （由空行 token 自身负责间距）
				break;

			case "blockquote": {
				// 引用块：每行加灰色竖线前缀 + 斜体文本
				const quoteText = this.renderInlineTokens(token.tokens || []);
				const quoteLines = quoteText.split("\n");
				for (const quoteLine of quoteLines) {
					lines.push(chalk.gray("│ ") + chalk.italic(quoteLine));
				}
				lines.push(""); // 引用块后追加空行作为间距
				break;
			}

			case "hr":
				// 水平分隔线：取终端宽度与 80 的较小值，避免在宽终端上拉出过长横线
				lines.push(chalk.gray("─".repeat(Math.min(width, 80))));
				lines.push(""); // 分隔线后追加空行作为间距
				break;

			case "html":
				// 终端输出不支持 HTML，直接跳过
				break;

			case "space":
				// 空 token 对应 Markdown 源码中的空行
				lines.push("");
				break;

			default:
				// 其他未显式处理的 token 类型降级为纯文本输出
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	/**
	 * 递归渲染内联 token 列表（加粗、斜体、行内代码、链接等）为单个字符串。
	 * 嵌套 token（如 strong 内含 em）通过递归处理，最终拼成一个带 ANSI 样式的字符串。
	 * @param tokens 内联 token 列表
	 * @returns 拼接后的样式化字符串（可能含换行符，如 br token）
	 */
	private renderInlineTokens(tokens: Token[]): string {
		let result = "";

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// 列表项中的 text token 可能带有嵌套的内联格式 token，
					// 有嵌套时必须递归渲染以保留加粗/斜体等样式
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens);
					} else {
						result += token.text;
					}
					break;

				case "strong":
					result += chalk.bold(this.renderInlineTokens(token.tokens || []));
					break;

				case "em":
					result += chalk.italic(this.renderInlineTokens(token.tokens || []));
					break;

				case "codespan":
					// 行内代码：反引号用灰色弱化，代码内容用青色高亮
					result += chalk.gray("`") + chalk.cyan(token.text) + chalk.gray("`");
					break;

				case "link": {
					// 链接：链接文字用蓝色下划线，URL 以灰色括号形式附在后面（终端无法点击）
					const linkText = this.renderInlineTokens(token.tokens || []);
					result += chalk.underline.blue(linkText) + chalk.gray(` (${token.href})`);
					break;
				}

				case "br":
					// 硬换行：直接插入换行符，由上层（列表/引用）按行拆分处理
					result += "\n";
					break;

				case "del":
					result += chalk.strikethrough(this.renderInlineTokens(token.tokens || []));
					break;

				default:
					// 其他未显式处理的内联 token 类型降级为纯文本
					if ("text" in token && typeof token.text === "string") {
						result += token.text;
					}
			}
		}

		return result;
	}

	/**
	 * 将单行文本按目标宽度折行，同时正确处理 ANSI 转义序列。
	 *
	 * 核心难点：ANSI 转义序列（如颜色码）不占显示宽度，但会被 naive 的
	 * 按长度截断逻辑误当作可见字符；且折行处若直接切断，样式会泄漏到
	 * 行尾（后续终端输出被意外着色）或在下一行丢失。本方法：
	 * 1. 逐字符扫描，识别并原样保留 ANSI 序列（不计入可见长度）；
	 * 2. 维护"当前激活的样式码"集合，折行时先补 \x1b[0m 复位再收尾，
	 *    新行开头重放激活的样式码，保证两行样式视觉上连续。
	 *
	 * @param line 待折行的单行文本（可能含 ANSI 转义序列）
	 * @param width 目标可见宽度（可见字符数）
	 * @returns 折行后的行数组；空输入返回 [""]，避免返回空数组导致行数塌缩
	 */
	private wrapLine(line: string, width: number): string[] {
		// 折行时需正确处理 ANSI 转义序列
		const wrapped: string[] = [];

		// 防御：空行/undefined/null 直接返回单空行，保持行数不变
		if (!line) {
			return [""];
		}

		// 短路：可见长度未超宽，无需折行，原样返回
		const visibleLength = this.getVisibleLength(line);
		if (visibleLength <= width) {
			return [line];
		}

		// ========== 状态初始化 ==========
		// activeAnsiCodes：当前仍生效的样式转义序列（颜色/加粗等），
		// 折行时需要在下一行开头重放，才能让样式跨行延续
		const activeAnsiCodes: string[] = [];
		let currentLine = "";
		let currentLength = 0;
		let i = 0;

		while (i < line.length) {
			if (line[i] === "\x1b" && line[i + 1] === "[") {
				// ========== ANSI 转义序列：解析并追踪 ==========
				// 跳过参数部分，直到遇到终止符（m=样式，G/K/H/J=光标/清屏控制）
				let j = i + 2;
				while (j < line.length && line[j] && !/[mGKHJ]/.test(line[j]!)) {
					j++;
				}
				if (j < line.length) {
					// 完整序列：原样附加到当前行（不增加可见长度 currentLength）
					const ansiCode = line.substring(i, j + 1);
					currentLine += ansiCode;

					// 只追踪样式类序列（以 m 结尾），光标控制类不影响样式状态
					if (line[j] === "m") {
						// 复位码：清空所有激活样式
						if (ansiCode === "\x1b[0m" || ansiCode === "\x1b[m") {
							activeAnsiCodes.length = 0;
						} else {
							// 样式码：加入激活集合（换行时需重放）
							activeAnsiCodes.push(ansiCode);
						}
					}

					i = j + 1;
				} else {
					// 序列在字符串末尾不完整：直接丢弃，避免输出悬空转义
					break;
				}
			} else {
				// ========== 普通可见字符 ==========
				if (currentLength >= width) {
					// 已达目标宽度：先收尾当前行再开新行
					if (activeAnsiCodes.length > 0) {
						// 有激活样式：行尾补复位码防止样式泄漏到行尾之后，
						// 新行开头重放激活样式码以延续样式
						wrapped.push(currentLine + "\x1b[0m");
						currentLine = activeAnsiCodes.join("");
					} else {
						wrapped.push(currentLine);
						currentLine = "";
					}
					currentLength = 0;
				}
				currentLine += line[i];
				currentLength++;
				i++;
			}
		}

		// 收尾：输出最后一个未满宽度的残余行
		if (currentLine) {
			wrapped.push(currentLine);
		}

		// 防御：确保至少返回一行（如整行只有不完整 ANSI 序列的场景）
		return wrapped.length > 0 ? wrapped : [""];
	}

	/**
	 * 计算字符串的可见长度：剔除 ANSI 样式转义序列后剩余的字符数。
	 * @param str 输入字符串（可能含 ANSI 序列），null/undefined 按 "" 处理
	 * @returns 可见字符数
	 */
	private getVisibleLength(str: string): number {
		// 移除形如 \x1b[0;1;32m 的样式转义序列后统计长度
		return (str || "").replace(/\x1b\[[0-9;]*m/g, "").length;
	}
}
