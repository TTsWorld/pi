/**
 * @file text-editor.ts
 * @description 终端文本编辑器组件 —— 多行文本编辑、光标管理、软换行布局、粘贴处理与自动补全
 * @module pi-tui
 *
 * 主要功能：
 * - 多行文本编辑：字符插入、拆行换行、退格/前向删除、整行删除（Ctrl+K）
 * - 光标管理：方向键移动、行首/行尾跳转（Home/End/Ctrl+A/Ctrl+E），跨行移动时列自动钳制
 * - 软换行布局：逻辑行按内容宽度切分为布局行渲染，光标位置同步换算到所在布局行
 * - 边框渲染：Box Drawing 字符绘制圆角边框，光标经 ANSI 反色序列（\x1b[7m）高亮
 * - 粘贴处理：换行符归一、Tab 转 4 空格、过滤不可打印字符，单行/多行分别处理
 * - 自动补全：斜杠命令（/command）与文件路径补全（Tab 触发），选中项经 provider 应用回文本
 *
 * 依赖关系：
 * - ./tui.js —— Component / ComponentRenderResult 组件接口
 * - ./select-list.js —— SelectList 补全候选列表组件
 * - ./autocomplete.js —— AutocompleteProvider / CombinedAutocompleteProvider 补全提供者
 * - ./logger.js —— 调试日志
 * - chalk —— 边框字符着色
 */
import chalk from "chalk";
import type { AutocompleteProvider, CombinedAutocompleteProvider } from "./autocomplete.js";
import { logger } from "./logger.js";
import { SelectList } from "./select-list.js";
import type { Component, ComponentRenderResult } from "./tui.js";

/** 编辑器核心状态：按行存储的文本 + 光标位置（行、列均为 0 起始索引） */
interface EditorState {
	/** 文本内容，每行为一个字符串；空编辑器也保持至少一行（[""]） */
	lines: string[];
	/** 光标所在行索引（0 起始） */
	cursorLine: number;
	/** 光标所在列（0 起始，即行内字符偏移；等于行长时表示行尾） */
	cursorCol: number;
}

/**
 * 布局行：逻辑行经软换行切分后的一条显示行，是渲染的最小单位
 * （光标的"逻辑列"需换算为布局行内的"显示列"）
 */
interface LayoutLine {
	/** 该显示行的文本（已含 "> " / "  " 行前缀） */
	text: string;
	/** 光标是否落在该显示行上 */
	hasCursor: boolean;
	/** 光标在该显示行内的列位置（仅 hasCursor 为 true 时有意义） */
	cursorPos?: number;
}

export interface TextEditorConfig {
	// 文本编辑器的配置项（当前暂无，预留扩展）
}

/**
 * 终端文本编辑器组件
 *
 * 以「逻辑行数组 + 光标行列」为唯一状态源：编辑操作直接修改逻辑行与光标，
 * 渲染时再把逻辑行按内容宽度软换行为布局行并绘制圆角边框。
 *
 * 实现 Component 接口：
 * - render(width)：按可用宽度生成带边框的显示行（恒标记 changed 以刷新光标）
 * - handleInput(data)：解析原始终端输入序列并分发到对应的编辑操作
 */
export class TextEditor implements Component {
	/** 编辑器状态：逻辑行 + 光标位置；空编辑器初始化为单个空行 */
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** 组件配置（当前无配置项） */
	private config: TextEditorConfig = {};

	// ========== 自动补全相关状态 ==========
	/** 补全提供者：负责按上下文给出候选并应用选中的补全项 */
	private autocompleteProvider?: AutocompleteProvider;
	/** 补全候选下拉列表（SelectList 实例），仅在补全会话期间存在 */
	private autocompleteList?: SelectList;
	/** 是否正处于补全会话中（候选列表正在显示） */
	private isAutocompleting: boolean = false;
	/** 触发补全时的前缀（如 "/he"），应用补全时交还 provider 定位替换范围 */
	private autocompletePrefix: string = "";

	/** 提交回调：按下 Enter（CR）时以 trim 后的全文调用 */
	public onSubmit?: (text: string) => void;
	/** 文本变更回调：任何增删改操作后以当前全文调用 */
	public onChange?: (text: string) => void;
	/** 为 true 时按下 Enter 不做任何处理（既不提交也不换行） */
	public disableSubmit: boolean = false;

	/**
	 * 创建文本编辑器实例
	 * @param config 可选配置，与默认配置浅合并
	 */
	constructor(config?: TextEditorConfig) {
		if (config) {
			this.config = { ...this.config, ...config };
		}
		logger.componentLifecycle("TextEditor", "created", { config: this.config });
	}

	/**
	 * 更新组件配置（与现有配置浅合并）
	 * @param config 需要更新的部分配置项
	 */
	configure(config: Partial<TextEditorConfig>): void {
		this.config = { ...this.config, ...config };
		logger.info("TextEditor", "Configuration updated", { config: this.config });
	}

	/**
	 * 设置自动补全提供者（不设置则 Tab 补全与自动触发均不可用）
	 * @param provider 补全提供者实例
	 */
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocompleteProvider = provider;
	}

	/**
	 * 渲染编辑器为带圆角边框的文本块，并高亮光标位置
	 *
	 * 宽度分配（以可用宽度 width 为基准）：
	 * - boxWidth = width - 1：边框盒总宽，右侧留 1 列边距
	 * - contentWidth = boxWidth - 4：内容区宽，扣除左侧 "│ " 与右侧 " │" 各 2 列
	 *
	 * 光标高亮：用 ANSI 反色序列 \x1b[7m 反显光标处字符；光标在行尾时
	 * 反显一个追加的空格，此时可见长度 +1，需在右侧补齐前修正。
	 *
	 * @param width 终端可用渲染宽度（字符数）
	 * @returns 渲染结果；changed 恒为 true —— 交互式组件的光标移动
	 *          不会改变文本内容，必须强制标记已变更才能触发重绘
	 */
	render(width: number): ComponentRenderResult {
		// ========== 边框字符（Box Drawing 制表符，统一灰色） ==========
		const topLeft = chalk.gray("╭");
		const topRight = chalk.gray("╮");
		const bottomLeft = chalk.gray("╰");
		const bottomRight = chalk.gray("╯");
		const horizontal = chalk.gray("─");
		const vertical = chalk.gray("│");

		// ========== 宽度分配与文本布局 ==========
		// 计算边框盒宽度（右侧留 1 列边距）
		const boxWidth = width - 1;
		const contentWidth = boxWidth - 4; // 扣除两侧 "│ " 与 " │" 占用的 4 列

		// 将逻辑行按内容宽度软换行为布局行（超长行自动切分）
		const layoutLines = this.layoutText(contentWidth);

		const result: string[] = [];

		// 顶边框：╭─…─╮（水平线长度 = 盒宽 - 两个角字符）
		result.push(topLeft + horizontal.repeat(boxWidth - 2) + topRight);

		// ========== 逐行渲染布局行 ==========
		for (const layoutLine of layoutLines) {
			let displayText = layoutLine.text;
			// 可见长度不含 ANSI 转义序列，用于计算右侧补齐空格数
			let visibleLength = layoutLine.text.length;

			// 该行含光标 —— 在光标处插入反色高亮
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					// 光标在字符上 —— 用反色版本替换该字符
					const cursor = `\x1b[7m${after[0]}\x1b[0m`;
					const restAfter = after.slice(1);
					displayText = before + cursor + restAfter;
					// 是替换而非追加，可见长度不变
				} else {
					// 光标在行尾 —— 追加一个反色空格占位
					const cursor = "\x1b[7m \x1b[0m";
					displayText = before + cursor;
					// 追加了一个空格，可见长度 +1
					visibleLength = layoutLine.text.length + 1;
				}
			}

			// 按实际可见长度补齐右侧空格，保证右边框对齐（下限 0 防负数）
			const padding = " ".repeat(Math.max(0, contentWidth - visibleLength));

			// 渲染该行：│ 文本 + 补齐空格 │
			result.push(`${vertical} ${displayText}${padding} ${vertical}`);
		}

		// 底边框：╰─…─╯
		result.push(bottomLeft + horizontal.repeat(boxWidth - 2) + bottomRight);

		// 补全激活时，把候选列表渲染在边框下方
		if (this.isAutocompleting && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(width);
			result.push(...autocompleteResult.lines);
		}

		// 交互式组件（如文本编辑器）恒假设已变更，
		// 确保光标位置更新总能反映到屏幕上
		return {
			lines: result,
			changed: true,
		};
	}

	/**
	 * 处理原始终端输入（单个按键或一段粘贴数据）
	 *
	 * 分发优先级（从高到低）：
	 * 1. Ctrl+C（charCode 3）：直接返回，退出交由父组件处理
	 * 2. 粘贴检测：一次收到 >10 字符、或含换行的多字符序列视为粘贴
	 * 3. 补全会话专用键：Esc 取消 / 上下键导航 / Tab 应用选中项 / Enter 结束补全并继续提交
	 * 4. Tab：非补全状态下按上下文触发补全
	 * 5. 行内控制键：Ctrl+K 删行、Ctrl+A 行首、Ctrl+E 行尾
	 * 6. Enter 族：修饰键+Enter 插入新行；裸 CR 提交；裸 LF 插入新行
	 * 7. Backspace / Home / End / Delete / 方向键
	 * 8. 可打印 ASCII（32~126）：插入字符；其余未识别输入仅告警
	 *
	 * @param data 终端原始输入序列（可含 ESC 转义序列，如 "\x1b[A" 表示上方向键）
	 */
	handleInput(data: string): void {
		logger.keyInput("TextEditor", data);
		logger.debug("TextEditor", "Current state before input", {
			lines: this.state.lines,
			cursorLine: this.state.cursorLine,
			cursorCol: this.state.cursorCol,
		});

		// ========== 先处理特殊按键组合 ==========

		// Ctrl+C —— 退出（交由父组件处理，此处直接忽略）
		if (data.charCodeAt(0) === 3) {
			logger.debug("TextEditor", "Ctrl+C received, returning to parent");
			return;
		}

		// ========== 粘贴检测 ==========
		// 一次收到大量文本（>10 字符，或 >2 字符且含换行）视为粘贴
		const isPaste = data.length > 10 || (data.length > 2 && data.includes("\n"));
		logger.debug("TextEditor", "Paste detection", {
			dataLength: data.length,
			includesNewline: data.includes("\n"),
			includesTabs: data.includes("\t"),
			tabCount: (data.match(/\t/g) || []).length,
			isPaste,
			data: JSON.stringify(data),
			charCodes: Array.from(data).map((c) => c.charCodeAt(0)),
		});

		if (isPaste) {
			logger.info("TextEditor", "Handling as paste");
			this.handlePaste(data);
			return;
		}

		// ========== 补全会话中的专用键 ==========
		// 先处理补全激活时的专用键，但不拦截其他输入
		if (this.isAutocompleting && this.autocompleteList) {
			logger.debug("TextEditor", "Autocomplete active, handling input", {
				data,
				charCode: data.charCodeAt(0),
				isEscape: data === "\x1b",
				isArrowOrEnter: data === "\x1b[A" || data === "\x1b[B" || data === "\r",
			});

			// Esc —— 取消补全
			if (data === "\x1b") {
				this.cancelAutocomplete();
				return;
			}
			// 让补全列表处理导航与选择
			else if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\t") {
				// 只把上下方向键交给列表，Enter/Tab 由本组件直接处理
				if (data === "\x1b[A" || data === "\x1b[B") {
					this.autocompleteList.handleInput(data);
				}

				// Tab —— 应用当前选中的补全项
				if (data === "\t") {
					const selected = this.autocompleteList.getSelectedItem();
					if (selected && this.autocompleteProvider) {
						const result = this.autocompleteProvider.applyCompletion(
							this.state.lines,
							this.state.cursorLine,
							this.state.cursorCol,
							selected,
							this.autocompletePrefix,
						);

						this.state.lines = result.lines;
						this.state.cursorLine = result.cursorLine;
						this.state.cursorCol = result.cursorCol;

						this.cancelAutocomplete();

						if (this.onChange) {
							this.onChange(this.getText());
						}
					}
					return;
				}
				// Enter —— 结束补全会话，让 Enter 继续走提交流程
				else if (data === "\r") {
					this.cancelAutocomplete();
					// 此处不 return —— 让 Enter 落入下方正常的提交处理
				} else {
					// 其余键 —— 在补全状态下按常规处理后返回
					return;
				}
			}
			// 其他键（如普通字符输入）此处不 return，
			// 继续落入下方的常规字符处理
			logger.debug("TextEditor", "Autocomplete active but falling through to normal handling");
		}

		// ========== Tab 补全（非补全状态下） ==========
		// Tab —— 按上下文触发补全（已在补全中则跳过，避免重复触发）
		if (data === "\t" && !this.isAutocompleting) {
			logger.debug("TextEditor", "Tab key pressed, determining context", {
				isAutocompleting: this.isAutocompleting,
				hasProvider: !!this.autocompleteProvider,
			});
			this.handleTabCompletion();
			return;
		}

		// ========== 其余按键分发 ==========
		// Ctrl+K —— 删除当前行
		if (data.charCodeAt(0) === 11) {
			this.deleteCurrentLine();
		}
		// Ctrl+A —— 移到行首
		else if (data.charCodeAt(0) === 1) {
			this.moveToLineStart();
		}
		// Ctrl+E —— 移到行尾
		else if (data.charCodeAt(0) === 5) {
			this.moveToLineEnd();
		}
		// 换行快捷键（修饰键 + Enter = 插入新行；注意裸 CR 走提交、裸 LF 走换行，不在本分支）
		else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // 带修饰键的 Ctrl+Enter
			data === "\x1b\r" || // 某些终端下的 Option+Enter
			data === "\x1b[13;2~" || // 某些终端下的 Shift+Enter
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) || // 任意 ESC+CR 组合
			(data === "\n" && data.length === 1) || // iTerm2 映射出的 Shift+Enter（裸 LF）
			data === "\\\r" // VS Code 终端下的 Shift+Enter（\\\r）
		) {
			// 修饰键 + Enter = 插入新行
			this.addNewLine();
		}
		// 裸 Enter（CR，字符码 13）—— 仅 CR 触发提交；LF 已在上面的换行分支处理
		else if (data.charCodeAt(0) === 13 && data.length === 1) {
			// 提交被禁用时直接忽略
			if (this.disableSubmit) {
				return;
			}

			// 裸 Enter = 提交（去除首尾空白后的全文）
			const result = this.state.lines.join("\n").trim();
			logger.info("TextEditor", "Submit triggered", {
				result,
				rawResult: JSON.stringify(this.state.lines.join("\n")),
				lines: this.state.lines,
				resultLines: result.split("\n"),
			});

			// 重置编辑器为空
			this.state = {
				lines: [""],
				cursorLine: 0,
				cursorCol: 0,
			};

			// 通知监听者编辑器已清空
			if (this.onChange) {
				this.onChange("");
			}

			if (this.onSubmit) {
				logger.info("TextEditor", "Calling onSubmit callback", { result });
				this.onSubmit(result);
			} else {
				logger.warn("TextEditor", "No onSubmit callback set");
			}
		}
		// 退格（127 = DEL 主流编码，8 = BS 备选编码，两者都处理）
		else if (data.charCodeAt(0) === 127 || data.charCodeAt(0) === 8) {
			this.handleBackspace();
		}
		// 行导航快捷键（Home/End，兼容多种终端转义序列）
		else if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x1b[7~") {
			// Home 键 —— 移到行首
			this.moveToLineStart();
		} else if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x1b[8~") {
			// End 键 —— 移到行尾
			this.moveToLineEnd();
		}
		// 前向删除（Delete 键 / 笔记本上的 Fn+Backspace）
		else if (data === "\x1b[3~") {
			// Delete 键
			this.handleForwardDelete();
		}
		// 方向键
		else if (data === "\x1b[A") {
			// 上
			this.moveCursor(-1, 0);
		} else if (data === "\x1b[B") {
			// 下
			this.moveCursor(1, 0);
		} else if (data === "\x1b[C") {
			// 右
			this.moveCursor(0, 1);
		} else if (data === "\x1b[D") {
			// 左
			this.moveCursor(0, -1);
		}
		// 普通字符（可打印 ASCII 区间 32~126）
		else if (data.charCodeAt(0) >= 32 && data.charCodeAt(0) <= 126) {
			logger.debug("TextEditor", "Inserting character", { char: data, charCode: data.charCodeAt(0) });
			this.insertCharacter(data);
		} else {
			logger.warn("TextEditor", "Unhandled input", {
				data,
				charCodes: Array.from(data).map((c) => c.charCodeAt(0)),
			});
		}
	}

	/**
	 * 将逻辑行按内容宽度软换行，生成用于渲染的布局行列表
	 *
	 * 布局规则：
	 * - 空编辑器：返回单条 "> " 提示行，光标固定在第 2 列（提示符之后）
	 * - 行前缀：第一行用 "> " 提示符，后续行用两个空格保持对齐
	 * - 未超宽（前缀 + 内容 ≤ contentWidth）：一行占一个布局行，
	 *   光标列 = 前缀长度 + cursorCol，直接落在该行上
	 * - 超宽：按 contentWidth 等长硬切分（不按单词边界断行），
	 *   光标列落在哪个块区间 [chunkStart, chunkEnd) 内就显示在哪个块，
	 *   并换算为块内偏移 cursorPos - chunkStart
	 *
	 * 边界说明：光标恰好位于块边界上的行尾（即带前缀行长为 contentWidth
	 * 整数倍时的行尾）不属于任何块，此时光标不会被渲染 —— 现有实现的已知边界行为
	 *
	 * 时间复杂度 O(总字符数)：每个字符恰好被复制进一个布局块；空间复杂度同
	 *
	 * @param contentWidth 内容区可用宽度（字符数）
	 * @returns 布局行数组，顺序即屏幕上的渲染顺序
	 */
	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		// ========== 空编辑器特判 ==========
		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			// 空编辑器 —— 只渲染 "> " 提示行，光标在其后（第 2 列）
			layoutLines.push({
				text: "> ",
				hasCursor: true,
				cursorPos: 2,
			});
			return layoutLines;
		}

		// ========== 逐条处理逻辑行 ==========
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const isCurrentLine = i === this.state.cursorLine;
			const prefix = i === 0 ? "> " : "  ";
			const prefixedLine = prefix + line;
			const maxLineLength = contentWidth;

			if (prefixedLine.length <= maxLineLength) {
				// 未超宽 —— 整行即一个布局行
				if (isCurrentLine) {
					layoutLines.push({
						text: prefixedLine,
						hasCursor: true,
						// 逻辑列 + 前缀长度 = 布局行内的显示列
						cursorPos: prefix.length + this.state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: prefixedLine,
						hasCursor: false,
					});
				}
			} else {
				// 超宽 —— 按 maxLineLength 等长切分为多个块（软换行）
				const chunks = [];
				for (let pos = 0; pos < prefixedLine.length; pos += maxLineLength) {
					chunks.push(prefixedLine.slice(pos, pos + maxLineLength));
				}

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					// 该块覆盖的原始列区间 [chunkStart, chunkEnd)
					const chunkStart = chunkIndex * maxLineLength;
					const chunkEnd = chunkStart + chunk.length;
					const cursorPos = prefix.length + this.state.cursorCol;
					// 光标列落在该区间内（左闭右开），光标才显示在此块
					const hasCursorInChunk = isCurrentLine && cursorPos >= chunkStart && cursorPos < chunkEnd;

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk,
							hasCursor: true,
							// 换算为块内偏移
							cursorPos: cursorPos - chunkStart,
						});
					} else {
						layoutLines.push({
							text: chunk,
							hasCursor: false,
						});
					}
				}
			}
		}

		return layoutLines;
	}

	/**
	 * 获取编辑器当前全文
	 * @returns 以 \n 连接所有逻辑行得到的文本
	 */
	getText(): string {
		return this.state.lines.join("\n");
	}

	/**
	 * 整体替换编辑器文本，并将光标移到文本末尾
	 * @param text 新文本；\r\n 与 \r 换行符都会归一为 \n
	 */
	setText(text: string): void {
		// 归一换行符（\r\n、\r → \n）后按行拆分
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

		// 保证至少保留一行（防御性兜底）
		this.state.lines = lines.length === 0 ? [""] : lines;

		// 光标重置到末行行尾
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines[this.state.cursorLine]?.length || 0;

		// 触发变更回调
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	// ========== 文本编辑操作 ==========

	/**
	 * 在光标处插入单个字符（不处理换行）
	 *
	 * 插入后按需联动自动补全：
	 * - 未在补全中：行首输入 "/"、或在斜杠命令参数中输入字母数字时自动触发
	 * - 已在补全中：每次插入都刷新候选
	 *
	 * @param char 待插入的字符
	 */
	private insertCharacter(char: string): void {
		const line = this.state.lines[this.state.cursorLine] || "";

		// 在光标处切开原行，拼接出新行内容
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.state.cursorCol += char.length; // Fix: 按插入字符串的实际长度前移光标（而非固定 +1）

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// 判断是否需要触发或更新自动补全
		if (!this.isAutocompleting) {
			// 行首输入 "/" 时自动触发补全（斜杠命令场景）
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// 在斜杠命令上下文中输入字母/数字时也自动触发
			else if (/[a-zA-Z0-9]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// 光标前是带空格的斜杠命令（正在输入参数）才触发
				if (textBeforeCursor.startsWith("/") && textBeforeCursor.includes(" ")) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	/**
	 * 处理粘贴的文本
	 *
	 * 清洗流程：换行符归一 → Tab 展开为 4 空格 → 过滤不可打印字符 → 按行拆分。
	 * - 单行粘贴：退化为逐字符 insertCharacter，保持自动补全等联动逻辑
	 * - 多行粘贴：重构整个 lines 数组 —— 光标前文本与粘贴首行拼接、
	 *   光标后文本与粘贴末行拼接、中间行原样插入，最后光标移到粘贴内容末尾
	 *
	 * 时间复杂度 O(粘贴字符数 + 总行数)
	 * @param pastedText 粘贴的原始文本
	 */
	private handlePaste(pastedText: string): void {
		logger.debug("TextEditor", "Processing paste", {
			pastedText: JSON.stringify(pastedText),
			hasTab: pastedText.includes("\t"),
			tabCount: (pastedText.match(/\t/g) || []).length,
		});

		// 清洗粘贴文本：统一换行符
		const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Tab 转空格（每个 Tab 展开为 4 个空格，编辑器本身不支持制表符）
		const tabExpandedText = cleanText.replace(/\t/g, "    ");

		// 过滤不可打印字符（仅保留换行符与可打印 ASCII " "~"~"）
		const filteredText = tabExpandedText
			.split("")
			.filter((char) => char === "\n" || (char >= " " && char <= "~"))
			.join("");

		// 按行拆分
		const pastedLines = filteredText.split("\n");

		if (pastedLines.length === 1) {
			// 单行 —— 逐字符插入（复用 insertCharacter 的联动逻辑）
			const text = pastedLines[0] || "";
			for (const char of text) {
				this.insertCharacter(char);
			}

			return;
		}

		// 多行粘贴 —— 谨慎重构行数组
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		// 逐步构建新的行数组
		const newLines: string[] = [];

		// 追加光标行之前的所有行
		for (let i = 0; i < this.state.cursorLine; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		// 首个粘贴行与光标前文本拼接
		newLines.push(beforeCursor + (pastedLines[0] || ""));

		// 中间粘贴行原样插入
		for (let i = 1; i < pastedLines.length - 1; i++) {
			newLines.push(pastedLines[i] || "");
		}

		// 末个粘贴行与光标后文本拼接
		newLines.push((pastedLines[pastedLines.length - 1] || "") + afterCursor);

		// 追加光标行之后的所有行
		for (let i = this.state.cursorLine + 1; i < this.state.lines.length; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		// 整体替换行数组
		this.state.lines = newLines;

		// 光标移到粘贴内容末尾（末个粘贴行的行尾）
		this.state.cursorLine += pastedLines.length - 1;
		this.state.cursorCol = (pastedLines[pastedLines.length - 1] || "").length;

		// 触发变更回调
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 在光标处将当前行一分为二，光标移到新行行首（修饰键 + Enter）
	 */
	private addNewLine(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// 拆分当前行：光标前内容留在原行，光标后内容成为新行
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// 光标移到新行行首
		this.state.cursorLine++;
		this.state.cursorCol = 0;

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 退格删除
	 *
	 * 行内（col > 0）：删除光标前一字符；行首且非首行：当前行并入上一行，
	 * 光标落到两行的拼接缝处（即原上一行的行尾）
	 */
	private handleBackspace(): void {
		if (this.state.cursorCol > 0) {
			// 删除当前行内光标前的一个字符
			const line = this.state.lines[this.state.cursorLine] || "";

			const before = line.slice(0, this.state.cursorCol - 1);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.state.cursorCol--;
		} else if (this.state.cursorLine > 0) {
			// 行首 —— 与上一行合并（当前行拼到上一行末尾并移除）
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// 退格后同步刷新补全候选
		if (this.isAutocompleting) {
			this.updateAutocomplete();
		}
	}

	/** 光标移到当前行行首（列清零，行不变） */
	private moveToLineStart(): void {
		this.state.cursorCol = 0;
	}

	/** 光标移到当前行行尾（列 = 当前行长度） */
	private moveToLineEnd(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.state.cursorCol = currentLine.length;
	}

	/**
	 * 前向删除（Delete 键）
	 *
	 * 行内非行尾：删除光标处字符；行尾且非末行：下一行并入当前行
	 */
	private handleForwardDelete(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			// 删除光标处字符（跳过一个字符再拼接）
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + 1);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// 行尾 —— 与下一行合并（下一行拼到当前行末尾并移除）
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 删除光标所在整行（Ctrl+K）
	 *
	 * 仅剩一行时只清空内容不删行（保持至少一行的不变量）；
	 * 删除后若光标行越界则移到新的末行，列钳制到新行长度以内
	 */
	private deleteCurrentLine(): void {
		if (this.state.lines.length === 1) {
			// 只有一行 —— 仅清空内容
			this.state.lines[0] = "";
			this.state.cursorCol = 0;
		} else {
			// 多行 —— 移除当前行
			this.state.lines.splice(this.state.cursorLine, 1);

			// 调整光标位置
			if (this.state.cursorLine >= this.state.lines.length) {
				// 原本在最后一行 —— 移到新的最后一行
				this.state.cursorLine = this.state.lines.length - 1;
			}

			// 列钳制到新行长度以内
			const newLine = this.state.lines[this.state.cursorLine] || "";
			this.state.cursorCol = Math.min(this.state.cursorCol, newLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 按增量移动光标（方向键）
	 *
	 * 行移动：列保持不变但钳制到新行长度（越过短行时贴到行尾）；
	 * 列移动：在 [0, 当前行长] 区间内钳制，不跨行移动
	 *
	 * @param deltaLine 行增量（-1 上移 / +1 下移 / 0 不动）
	 * @param deltaCol 列增量（-1 左移 / +1 右移 / 0 不动）
	 */
	private moveCursor(deltaLine: number, deltaCol: number): void {
		if (deltaLine !== 0) {
			const newLine = this.state.cursorLine + deltaLine;
			// 目标行在有效范围内才移动（首行上移 / 末行下移时保持不动）
			if (newLine >= 0 && newLine < this.state.lines.length) {
				this.state.cursorLine = newLine;
				// 列钳制到新行长度以内
				const line = this.state.lines[this.state.cursorLine] || "";
				this.state.cursorCol = Math.min(this.state.cursorCol, line.length);
			}
		}

		if (deltaCol !== 0) {
			// 列移动，双向钳制防止越出行首/行尾
			const newCol = this.state.cursorCol + deltaCol;
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const maxCol = currentLine.length;
			this.state.cursorCol = Math.max(0, Math.min(maxCol, newCol));
		}
	}

	/**
	 * 判断光标是否位于消息起始处（用于斜杠命令检测）
	 *
	 * 判定较宽松：光标前为空、仅空白、或恰好是单个 "/" 均视为起始 ——
	 * 最后一种情况覆盖刚敲下 "/" 还未输入命令名的瞬间
	 */
	private isAtStartOfMessage(): boolean {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// 光标前为空 / 仅空白 / 恰好是 "/" 时视为处于消息起始
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	// ========== 自动补全相关方法 ==========

	/**
	 * 尝试触发自动补全会话
	 *
	 * 向 provider 请求当前位置的候选：有候选则记录前缀、创建 SelectList
	 * 并进入补全状态；无候选则取消补全。explicitTab（Tab 显式触发）时会先
	 * 询问 provider 是否处于文件补全上下文，避免在不合适的位置弹候选。
	 *
	 * @param explicitTab 是否由 Tab 键显式触发（区别于输入 "/" 的自动触发）
	 */
	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		logger.debug("TextEditor", "tryTriggerAutocomplete called", {
			explicitTab,
			hasProvider: !!this.autocompleteProvider,
		});

		// 未设置 provider 则无从补全
		if (!this.autocompleteProvider) return;

		// Tab 显式触发时先确认 provider 允许文件补全（不在文件补全上下文则放弃）
		if (explicitTab) {
			const provider = this.autocompleteProvider as CombinedAutocompleteProvider;
			const shouldTrigger =
				!provider.shouldTriggerFileCompletion ||
				provider.shouldTriggerFileCompletion(this.state.lines, this.state.cursorLine, this.state.cursorCol);

			logger.debug("TextEditor", "Tab file completion check", {
				hasShouldTriggerMethod: !!provider.shouldTriggerFileCompletion,
				shouldTrigger,
				lines: this.state.lines,
				cursorLine: this.state.cursorLine,
				cursorCol: this.state.cursorCol,
			});

			if (!shouldTrigger) {
				return;
			}
		}

		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		logger.debug("TextEditor", "Autocomplete suggestions", {
			hasSuggestions: !!suggestions,
			itemCount: suggestions?.items.length || 0,
			prefix: suggestions?.prefix,
		});

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5); // 5 = 列表最多同时显示的项数
			this.isAutocompleting = true;
		} else {
			// 无候选 —— 结束补全
			this.cancelAutocomplete();
		}
	}

	/**
	 * Tab 键补全入口：按光标前上下文分发
	 *
	 * 光标前（忽略前导空白）以 "/" 开头走斜杠命令补全，否则强制文件路径补全
	 */
	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// 判断是否处于斜杠命令上下文
		if (beforeCursor.trimStart().startsWith("/")) {
			logger.debug("TextEditor", "Tab in slash command context", { beforeCursor });
			this.handleSlashCommandCompletion();
		} else {
			logger.debug("TextEditor", "Tab in file completion context", { beforeCursor });
			this.forceFileAutocomplete();
		}
	}

	/**
	 * 斜杠命令补全：目前直接复用通用补全流程
	 *
	 * TODO: 可扩展为各命令专属的参数补全
	 */
	private handleSlashCommandCompletion(): void {
		// 暂时回退到常规补全（斜杠命令候选）
		// 后续可在此扩展命令专属的参数补全
		logger.debug("TextEditor", "Handling slash command completion");
		this.tryTriggerAutocomplete(true);
	}

	/**
	 * 强制以文件路径补全模式触发
	 *
	 * provider 若实现 getForceFileSuggestions 则使用强制文件候选，
	 * 否则回退到通用补全流程（能力探测式调用）
	 */
	private forceFileAutocomplete(): void {
		logger.debug("TextEditor", "forceFileAutocomplete called", {
			hasProvider: !!this.autocompleteProvider,
		});

		if (!this.autocompleteProvider) return;

		// 探测 provider 是否实现强制文件补全方法
		const provider = this.autocompleteProvider as any;
		if (!provider.getForceFileSuggestions) {
			logger.debug("TextEditor", "Provider doesn't support forced file completion, falling back to regular");
			this.tryTriggerAutocomplete(true);
			return;
		}

		const suggestions = provider.getForceFileSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		logger.debug("TextEditor", "Forced file autocomplete suggestions", {
			hasSuggestions: !!suggestions,
			itemCount: suggestions?.items.length || 0,
			prefix: suggestions?.prefix,
		});

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5); // 5 = 列表最多同时显示的项数
			this.isAutocompleting = true;
		} else {
			this.cancelAutocomplete();
		}
	}

	/** 结束补全会话：清掉激活标记、候选列表与前缀 */
	private cancelAutocomplete(): void {
		this.isAutocompleting = false;
		this.autocompleteList = undefined as any;
		this.autocompletePrefix = "";
	}

	/**
	 * 补全激活期间在文本变化后同步刷新候选
	 *
	 * 重新向 provider 请求候选：仍有候选则按新候选重建 SelectList；
	 * 候选为空则取消补全
	 */
	private updateAutocomplete(): void {
		if (!this.isAutocompleting || !this.autocompleteProvider) return;

		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			if (this.autocompleteList) {
				// 用新候选重建列表（前缀与候选同步更新）
				this.autocompleteList = new SelectList(suggestions.items, 5);
			}
		} else {
			// 不再有匹配 —— 取消补全
			this.cancelAutocomplete();
		}
	}
}
