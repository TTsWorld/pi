/**
 * @file 文本编辑器组件（TextEditor）
 * @description
 * pi monorepo 终端 UI 框架（tui）中的多行文本编辑器组件。
 * 负责在终端中渲染一个带圆角边框的编辑框，并处理各类键盘输入：
 * 普通字符插入、退格/删除、方向键移动光标、Home/End 跳转、
 * 换行（Shift/Ctrl+Enter）、提交（Enter）、粘贴、以及 Tab 自动补全。
 *
 * 主要功能：
 * - 维护编辑器状态（行数组 + 光标行列位置）
 * - 将逻辑行按内容宽度做软换行布局（layoutText），并计算光标在展示行中的位置
 * - 用 ANSI 反色转义序列（\x1b[7m）渲染光标（覆盖字符或行尾空格）
 * - 与 AutocompleteProvider 协作，支持斜杠命令（/command）与文件路径补全
 *
 * 依赖关系：
 * - chalk：边框字符着色
 * - ../autocomplete.js：AutocompleteProvider / CombinedAutocompleteProvider 补全提供者接口
 * - ../tui.js：Component 组件接口、ComponentRenderResult 渲染结果、getNextComponentId 组件 ID 生成
 * - ./select-list.js：SelectList 补全候选项下拉列表组件
 */

import chalk from "chalk";
import type { AutocompleteProvider, CombinedAutocompleteProvider } from "../autocomplete.js";
import { type Component, type ComponentRenderResult, getNextComponentId } from "../tui.js";
import { SelectList } from "./select-list.js";

/**
 * 编辑器内部状态。
 * lines：逻辑行数组（不含换行符）；cursorLine/cursorCol：光标所在的行号与列号（0 起始）。
 */
interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

/**
 * 布局行（软换行后的展示行）。
 * text：该展示行的文本（已含 "> " / "  " 前缀）；
 * hasCursor：光标是否落在本行；cursorPos：光标在本行中的列位置（仅在 hasCursor 时有意义）。
 */
interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface TextEditorConfig {
	// 文本编辑器的配置项（当前暂无任何配置项）
}

/**
 * 多行文本编辑器组件。
 *
 * 实现 tui 框架的 Component 接口（render + handleInput），
 * 通过 onSubmit / onChange 回调与外部交互：
 * - onSubmit：按下 Enter 提交时触发，参数为编辑器全文（已 trim）
 * - onChange：文本内容变化时触发
 */
export class TextEditor implements Component {
	/** 组件唯一 ID，由 tui 框架分配，用于渲染 diff 对比 */
	readonly id = getNextComponentId();

	/** 编辑器核心状态：初始为单空行、光标在 (0, 0) */
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** 组件配置（当前为空对象，预留给未来扩展） */
	private config: TextEditorConfig = {};

	// 自动补全相关状态
	/** 补全提供者（斜杠命令 / 文件路径等策略的组合），未设置则禁用补全 */
	private autocompleteProvider?: AutocompleteProvider;
	/** 补全候选下拉列表组件，仅在补全激活期间存在 */
	private autocompleteList?: SelectList;
	/** 是否正处于补全激活状态 */
	private isAutocompleting: boolean = false;
	/** 触发补全时的前缀（如已输入的 "/he"），用于选中后做文本替换 */
	private autocompletePrefix: string = "";

	/** 提交回调：Enter 提交时触发，参数为全文（trim 后） */
	public onSubmit?: (text: string) => void;
	/** 变更回调：任何文本变化时触发 */
	public onChange?: (text: string) => void;
	/** 禁用提交（true 时按 Enter 不触发 onSubmit，用于纯编辑场景） */
	public disableSubmit: boolean = false;

	/**
	 * 构造函数。
	 * @param config 可选的初始配置，与默认配置浅合并
	 */
	constructor(config?: TextEditorConfig) {
		if (config) {
			this.config = { ...this.config, ...config };
		}
	}

	/**
	 * 更新组件配置（浅合并到现有配置上）。
	 * @param config 部分配置项
	 */
	configure(config: Partial<TextEditorConfig>): void {
		this.config = { ...this.config, ...config };
	}

	/**
	 * 设置自动补全提供者。
	 * @param provider 补全提供者实例（提供候选项获取与补全应用逻辑）
	 */
	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocompleteProvider = provider;
	}

	/**
	 * 渲染编辑器：绘制圆角边框 + 各布局行 + （激活时的）补全下拉列表。
	 * @param width 终端可用总宽度
	 * @returns 渲染结果（changed 恒为 true，因为编辑器是交互式组件，光标位置需要每次都刷新）
	 */
	render(width: number): ComponentRenderResult {
		// ========== 边框字符准备 ==========
		// 制表符绘制用的圆角框线字符，统一用灰色弱化视觉噪音
		const topLeft = chalk.gray("╭");
		const topRight = chalk.gray("╮");
		const bottomLeft = chalk.gray("╰");
		const bottomRight = chalk.gray("╯");
		const horizontal = chalk.gray("─");
		const vertical = chalk.gray("│");

		// ========== 宽度计算 ==========
		// 预留 1 个字符的右边距，避免内容顶到终端最右侧导致折行错乱
		const boxWidth = width - 1;
		// 再扣除左右两侧的 "│ " 和 " │"（共 4 个字符），得到实际可用的文本宽度
		const contentWidth = boxWidth - 4; // Account for "│ " and " │"

		// 对文本做软换行布局，得到若干展示行
		const layoutLines = this.layoutText(contentWidth);

		const result: string[] = [];

		// 顶边框：左角 + (boxWidth - 2) 个横线 + 右角
		result.push(topLeft + horizontal.repeat(boxWidth - 2) + topRight);

		// ========== 渲染每个布局行 ==========
		for (const layoutLine of layoutLines) {
			let displayText = layoutLine.text;
			// visibleLength 是"终端可见宽度"，用于计算右侧 padding；
			// 光标转义序列本身不可见，不能计入，所以单独维护这个变量
			let visibleLength = layoutLine.text.length;

			// 若光标落在本行，用 ANSI 反色序列将其渲染出来
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				if (after.length > 0) {
					// 光标停在某个字符上 —— 用反色版本"替换"该字符（而不是插入）
					// \x1b[7m 开启反色，\x1b[0m 复位
					const cursor = `\x1b[7m${after[0]}\x1b[0m`;
					const restAfter = after.slice(1);
					displayText = before + cursor + restAfter;
					// 是替换而非新增，可见长度不变
					// visibleLength stays the same - we're replacing, not adding
				} else {
					// 光标在行尾 —— 反色显示一个空格来充当光标
					const cursor = "\x1b[7m \x1b[0m";
					displayText = before + cursor;
					// 额外加了一个空格，可见长度 +1
					// visibleLength increases by 1 - we're adding a space
					visibleLength = layoutLine.text.length + 1;
				}
			}

			// 用空格补齐到内容宽度，保证右边框对齐（防御性 max(0,...) 防止负数）
			const padding = " ".repeat(Math.max(0, contentWidth - visibleLength));

			result.push(`${vertical} ${displayText}${padding} ${vertical}`);
		}

		// 底边框
		result.push(bottomLeft + horizontal.repeat(boxWidth - 2) + bottomRight);

		// 补全激活时，把下拉列表的渲染行追加在编辑框下方
		if (this.isAutocompleting && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(width);
			result.push(...autocompleteResult.lines);
		}

		// ========== 返回渲染结果 ==========
		// 对于文本编辑器这类交互式组件，始终返回 changed: true，
		// 确保光标位置的变化（纯视觉、无文本变化）也能被刷新到终端
		// For interactive components like text editors, always assume changed
		// This ensures cursor position updates are always reflected
		return {
			lines: result,
			changed: true,
		};
	}

	/**
	 * 处理一段原始终端输入（可能是单个按键的转义序列，也可能是粘贴的一大段文本）。
	 * 按优先级依次处理：Ctrl+C → 粘贴检测 → 补全专属按键 → Tab 补全 →
	 * 行编辑快捷键 → 换行/提交 → 删除键 → 方向键 → 普通可打印字符。
	 * @param data 终端原始输入字节序列（以字符串表示）
	 */
	handleInput(data: string): void {
		// ========== 特殊组合键优先处理 ==========

		// Ctrl+C（char code 3）—— 直接忽略，交给外层（父组件/TUI 框架）处理退出逻辑
		if (data.charCodeAt(0) === 3) {
			return;
		}

		// ========== 粘贴检测 ==========
		// 一次性收到超过 10 个字符，或较短但含换行，都视为粘贴（终端不会把多个按键合并成一次输入）
		const isPaste = data.length > 10 || (data.length > 2 && data.includes("\n"));
		if (isPaste) {
			this.handlePaste(data);
			return;
		}

		// ========== 补全激活时的专属按键 ==========
		// 注意：只拦截补全导航/确认键，普通字符输入要继续往下走（实时更新候选列表）
		if (this.isAutocompleting && this.autocompleteList) {
			// Escape —— 取消补全
			if (data === "\x1b") {
				this.cancelAutocomplete();
				return;
			}
			// 上/下方向键、Enter、Tab 由补全逻辑接管
			else if (data === "\x1b[A" || data === "\x1b[B" || data === "\r" || data === "\t") {
				// 只有上下方向键转交给列表组件移动选中项；Enter/Tab 由这里直接处理
				// Only pass arrow keys to the list, not Enter/Tab (we handle those directly)
				if (data === "\x1b[A" || data === "\x1b[B") {
					this.autocompleteList.handleInput(data);
				}

				// Tab —— 应用当前选中的候选项
				if (data === "\t") {
					const selected = this.autocompleteList.getSelectedItem();
					if (selected && this.autocompleteProvider) {
						// 让 provider 根据（行数组 + 光标位置 + 前缀 + 选中项）计算补全后的新状态
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
				// Enter —— 取消补全，但不 return，让 Enter 继续落入下方的提交逻辑
				else if (data === "\r") {
					this.cancelAutocomplete();
					// Don't return here - let Enter fall through to normal submission handling
				} else {
					// 其他情况正常按补全模式处理（消费掉该输入）
					return;
				}
			}
			// 其他按键（如普通字符输入）不要在这里 return，
			// 继续向下落入常规字符处理，以便实时刷新候选列表
			// For other keys (like regular typing), DON'T return here
			// Let them fall through to normal character handling
		}

		// ========== Tab 键 —— 按上下文触发补全（仅在未处于补全状态时） ==========
		if (data === "\t" && !this.isAutocompleting) {
			this.handleTabCompletion();
			return;
		}

		// ========== 常规按键分发 ==========
		// Ctrl+K（char code 11）—— 删除当前行
		if (data.charCodeAt(0) === 11) {
			this.deleteCurrentLine();
		}
		// Ctrl+A（char code 1）—— 跳到行首
		else if (data.charCodeAt(0) === 1) {
			this.moveToLineStart();
		}
		// Ctrl+E（char code 5）—— 跳到行尾
		else if (data.charCodeAt(0) === 5) {
			this.moveToLineEnd();
		}
		// ========== 换行快捷键（注意：裸的 CR/LF 不在此列，它们应触发提交或另行处理） ==========
		else if (
			(data.charCodeAt(0) === 10 && data.length > 1) || // Ctrl+Enter（LF 带修饰符时通常不止 1 字节）
			data === "\x1b\r" || // Option+Enter（部分终端）
			data === "\x1b[13;2~" || // Shift+Enter（部分终端）
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) || // 任意 Alt/ESC + Enter 组合
			(data === "\n" && data.length === 1) || // Shift+Enter（iTerm2 映射为单独的 LF）
			data === "\\\r" // Shift+Enter（VS Code 终端）
		) {
			// 修饰键 + Enter = 插入新行（而非提交）
			this.addNewLine();
		}
		// 裸 Enter（CR，char code 13 且仅 1 字节）—— 提交；只有 CR 表示提交，单独的 LF 走上面的换行分支
		else if (data.charCodeAt(0) === 13 && data.length === 1) {
			// 提交被禁用时直接忽略
			if (this.disableSubmit) {
				return;
			}

			// 拼接全文并去掉首尾空白
			const result = this.state.lines.join("\n").trim();

			// 重置编辑器为初始空状态
			this.state = {
				lines: [""],
				cursorLine: 0,
				cursorCol: 0,
			};

			// 通知外部编辑器已清空
			if (this.onChange) {
				this.onChange("");
			}

			if (this.onSubmit) {
				this.onSubmit(result);
			}
		}
		// 退格：DEL（127）或 BS（8）
		else if (data.charCodeAt(0) === 127 || data.charCodeAt(0) === 8) {
			this.handleBackspace();
		}
		// Home 键的各种转义序列变体（不同终端实现不同）
		else if (data === "\x1b[H" || data === "\x1b[1~" || data === "\x1b[7~") {
			// Home 键 —— 行首
			this.moveToLineStart();
		} else if (data === "\x1b[F" || data === "\x1b[4~" || data === "\x1b[8~") {
			// End 键的各种转义序列变体 —— 行尾
			this.moveToLineEnd();
		}
		// 前向删除（Fn+Backspace 或独立 Delete 键）
		else if (data === "\x1b[3~") {
			// Delete 键
			this.handleForwardDelete();
		}
		// 方向键（\x1b[A/B/C/D 分别为上/下/右/左）
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
		// 普通可打印 ASCII 字符（char code 32~126，即空格到波浪号）
		else if (data.charCodeAt(0) >= 32 && data.charCodeAt(0) <= 126) {
			this.insertCharacter(data);
		}
	}

	/**
	 * 将逻辑行数组转换为软换行后的布局行（展示行）数组。
	 * 第一行带 "> " 前缀模拟提示符，其余行用 "  " 对齐；
	 * 超宽的行按 contentWidth 硬切分（不按单词），并计算光标落在哪个分块内。
	 * @param contentWidth 单行可容纳的文本宽度
	 * @returns 布局行数组（每行带光标标记信息）
	 */
	private layoutText(contentWidth: number): LayoutLine[] {
		const layoutLines: LayoutLine[] = [];

		// ========== 空编辑器特判 ==========
		// 无行或仅一个空行时，显示 "> " 提示符，光标落在第 2 列
		if (this.state.lines.length === 0 || (this.state.lines.length === 1 && this.state.lines[0] === "")) {
			// 空编辑器
			layoutLines.push({
				text: "> ",
				hasCursor: true,
				cursorPos: 2,
			});
			return layoutLines;
		}

		// ========== 逐行处理逻辑行 ==========
		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const isCurrentLine = i === this.state.cursorLine;
			// 首行用 "> "，续行用两个空格保持对齐
			const prefix = i === 0 ? "> " : "  ";
			const prefixedLine = prefix + line;
			const maxLineLength = contentWidth;

			if (prefixedLine.length <= maxLineLength) {
				// 一行放得下 —— 直接作为单个布局行
				if (isCurrentLine) {
					layoutLines.push({
						text: prefixedLine,
						hasCursor: true,
						// 光标列需要加上前缀长度，换算到展示坐标
						cursorPos: prefix.length + this.state.cursorCol,
					});
				} else {
					layoutLines.push({
						text: prefixedLine,
						hasCursor: false,
					});
				}
			} else {
				// 一行放不下 —— 按 maxLineLength 硬切分为若干分块（字符级换行，不按单词）
				const chunks = [];
				for (let pos = 0; pos < prefixedLine.length; pos += maxLineLength) {
					chunks.push(prefixedLine.slice(pos, pos + maxLineLength));
				}

				for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
					const chunk = chunks[chunkIndex];
					if (!chunk) continue;

					// 计算该分块在整行中的起止偏移，用于判断光标是否落在此分块内
					const chunkStart = chunkIndex * maxLineLength;
					const chunkEnd = chunkStart + chunk.length;
					const cursorPos = prefix.length + this.state.cursorCol;
					// 光标在 [chunkStart, chunkEnd) 区间内则本分块持有光标
					// （注意光标恰好在 chunkEnd 边界时归下一个分块）
					const hasCursorInChunk = isCurrentLine && cursorPos >= chunkStart && cursorPos < chunkEnd;

					if (hasCursorInChunk) {
						layoutLines.push({
							text: chunk,
							hasCursor: true,
							// 光标位置换算为分块内的相对列
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
	 * 获取编辑器全文（各行以 \n 连接）。
	 * @returns 当前文本内容
	 */
	getText(): string {
		return this.state.lines.join("\n");
	}

	/**
	 * 以编程方式设置编辑器文本，并把光标移到文本末尾。
	 * @param text 要设置的文本（支持 \r\n / \r / \n 各种换行符）
	 */
	setText(text: string): void {
		// 统一换行符：CRLF / CR 先归一为 LF，再按 LF 拆行
		const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

		// 保证至少有一个空行（split 对空串会得到 [""]，这里是防御性兜底）
		this.state.lines = lines.length === 0 ? [""] : lines;

		// 光标重置到文本末尾
		this.state.cursorLine = this.state.lines.length - 1;
		this.state.cursorCol = this.state.lines[this.state.cursorLine]?.length || 0;

		// 通知外部内容变化
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 在光标处插入一个字符，并按需触发/更新自动补全。
	 * @param char 待插入的字符
	 */
	private insertCharacter(char: string): void {
		const line = this.state.lines[this.state.cursorLine] || "";

		// 在光标列处把行切成前后两段，插入字符后拼回
		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.state.cursorCol += char.length; // 按插入字符串的实际长度推进光标（而非固定 +1）

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// ========== 自动补全触发/更新 ==========
		if (!this.isAutocompleting) {
			// 在行首输入 "/" 时自动触发（斜杠命令场景）
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// 在斜杠命令上下文中继续输入字母/数字时也自动触发（即正在输入命令参数）
			else if (/[a-zA-Z0-9]/.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// 已有 "/" 开头且出现过空格，说明在补命令参数
				if (textBeforeCursor.startsWith("/") && textBeforeCursor.includes(" ")) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			// 补全已激活 —— 增量刷新候选列表
			this.updateAutocomplete();
		}
	}

	/**
	 * 处理粘贴的文本：清洗（统一换行、Tab 转 4 空格、滤掉不可打印字符）后插入光标处。
	 * 单行粘贴逐字符插入；多行粘贴则重构整个行数组，把当前行从光标处一分为二，
	 * 中间填入粘贴的各行。
	 * @param pastedText 粘贴的原始文本
	 */
	private handlePaste(pastedText: string): void {
		// ========== 文本清洗 ==========
		// 统一换行符为 \n
		const cleanText = pastedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// Tab 展开为 4 个空格（终端编辑器里 Tab 无法对齐显示）
		const tabExpandedText = cleanText.replace(/\t/g, "    ");

		// 过滤掉除换行外的所有不可打印字符（char < 空格 或 > "~"）
		const filteredText = tabExpandedText
			.split("")
			.filter((char) => char === "\n" || (char >= " " && char <= "~"))
			.join("");

		// 按行拆分
		const pastedLines = filteredText.split("\n");

		// ========== 单行粘贴 ==========
		// 等价于逐个字符键入，可复用 insertCharacter（含补全触发等副作用）
		if (pastedLines.length === 1) {
			const text = pastedLines[0] || "";
			for (const char of text) {
				this.insertCharacter(char);
			}

			return;
		}

		// ========== 多行粘贴 ==========
		// 数组操作容易出错，这里逐步重建整个行数组
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		// 逐步构建新的行数组
		const newLines: string[] = [];

		// 光标行之前的所有行原样保留
		for (let i = 0; i < this.state.cursorLine; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		// 粘贴首行与光标前半段拼接
		newLines.push(beforeCursor + (pastedLines[0] || ""));

		// 粘贴的中间各行
		for (let i = 1; i < pastedLines.length - 1; i++) {
			newLines.push(pastedLines[i] || "");
		}

		// 粘贴末行与光标后半段拼接
		newLines.push((pastedLines[pastedLines.length - 1] || "") + afterCursor);

		// 光标行之后的所有行原样保留
		for (let i = this.state.cursorLine + 1; i < this.state.lines.length; i++) {
			newLines.push(this.state.lines[i] || "");
		}

		// 一次性替换整个行数组
		this.state.lines = newLines;

		// 光标移到粘贴内容的末尾（最后一行的行尾）
		this.state.cursorLine += pastedLines.length - 1;
		this.state.cursorCol = (pastedLines[pastedLines.length - 1] || "").length;

		// 通知外部内容变化
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 在光标处把当前行一分为二，插入新行（Shift/Ctrl+Enter 换行）。
	 */
	private addNewLine(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// 光标前后两段分别成为原行和新行
		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// 当前行保留光标前半段，紧随其后插入后半段作为新行
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
	 * 退格删除：行内有字符时删除光标前一个字符；
	 * 光标已在行首且不在首行时，把当前行并入上一行（与常规编辑器行为一致）。
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
			// 行首退格 —— 与上一行合并
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			// 当前行拼到上一行末尾，然后删除当前行
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			// 光标落在合并点（原上一行的行尾）
			this.state.cursorLine--;
			this.state.cursorCol = previousLine.length;
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}

		// 退格后若补全仍激活，刷新候选列表
		if (this.isAutocompleting) {
			this.updateAutocomplete();
		}
	}

	/**
	 * 光标移到当前行行首（Ctrl+A / Home）。
	 */
	private moveToLineStart(): void {
		this.state.cursorCol = 0;
	}

	/**
	 * 光标移到当前行行尾（Ctrl+E / End）。
	 */
	private moveToLineEnd(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.state.cursorCol = currentLine.length;
	}

	/**
	 * 前向删除（Delete 键）：删除光标右侧一个字符；
	 * 光标已在行尾且非末行时，把下一行并入当前行。
	 */
	private handleForwardDelete(): void {
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			// 删除光标位置上的字符（保留光标右侧其余部分）
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + 1);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			// 行尾前向删除 —— 与下一行合并
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 删除光标所在的整行（Ctrl+K）。
	 * 仅有一行时只清空该行；多行时移除当前行并把光标收敛到合法位置。
	 */
	private deleteCurrentLine(): void {
		if (this.state.lines.length === 1) {
			// 仅一行 —— 清空内容即可，不删除行（保持至少一行的不变量）
			this.state.lines[0] = "";
			this.state.cursorCol = 0;
		} else {
			// 多行 —— 移除当前行
			this.state.lines.splice(this.state.cursorLine, 1);

			// 调整光标行号：若删的是最后一行，需要移到新的最后一行
			if (this.state.cursorLine >= this.state.lines.length) {
				// 原本在最后一行 —— 移动到新的最后一行
				this.state.cursorLine = this.state.lines.length - 1;
			}

			// 光标列收敛到新行长度以内（避免越界）
			const newLine = this.state.lines[this.state.cursorLine] || "";
			this.state.cursorCol = Math.min(this.state.cursorCol, newLine.length);
		}

		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * 按增量移动光标（方向键处理）。
	 * 纵向移动后列号会收敛到新行长度以内；横向移动被夹取在 [0, 行长] 区间。
	 * @param deltaLine 行增量（上为负、下为正）
	 * @param deltaCol 列增量（左为负、右为正）
	 */
	private moveCursor(deltaLine: number, deltaCol: number): void {
		if (deltaLine !== 0) {
			// 纵向移动：越界（越过首行/末行）时直接忽略本次移动
			const newLine = this.state.cursorLine + deltaLine;
			if (newLine >= 0 && newLine < this.state.lines.length) {
				this.state.cursorLine = newLine;
				// 列号收敛到新行长度以内（光标不能停在行尾之后）
				const line = this.state.lines[this.state.cursorLine] || "";
				this.state.cursorCol = Math.min(this.state.cursorCol, line.length);
			}
		}

		if (deltaCol !== 0) {
			// 横向移动：夹取在 [0, 当前行长度] 区间
			const newCol = this.state.cursorCol + deltaCol;
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const maxCol = currentLine.length;
			this.state.cursorCol = Math.max(0, Math.min(maxCol, newCol));
		}
	}

	/**
	 * 判断光标是否位于消息起始处（用于斜杠命令检测）。
	 * 光标前为空、仅空白或恰好是 "/" 时返回 true。
	 * @returns 是否在消息起始处
	 */
	private isAtStartOfMessage(): boolean {
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// 行首为空、只含空白，或只剩一个 "/"，都视为消息起始
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	// ========== 自动补全相关方法 ==========

	/**
	 * 尝试触发自动补全：向 provider 请求候选列表，非空则激活补全状态。
	 * @param explicitTab 是否由用户显式按 Tab 触发（此时会额外询问 provider 是否应触发文件补全）
	 */
	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		if (!this.autocompleteProvider) return;

		// 显式 Tab 触发时，先检查 provider 是否认为当前适合文件补全
		if (explicitTab) {
			const provider = this.autocompleteProvider as CombinedAutocompleteProvider;
			const shouldTrigger =
				!provider.shouldTriggerFileCompletion ||
				provider.shouldTriggerFileCompletion(this.state.lines, this.state.cursorLine, this.state.cursorCol);
			if (!shouldTrigger) {
				return;
			}
		}

		const suggestions = this.autocompleteProvider.getSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			// SelectList 最多显示 5 个候选项
			this.autocompleteList = new SelectList(suggestions.items, 5);
			this.isAutocompleting = true;
		} else {
			// 无候选则确保补全关闭
			this.cancelAutocomplete();
		}
	}

	/**
	 * Tab 补全入口：按上下文分流。
	 * 光标前以 "/" 开头走斜杠命令补全，否则强制触发文件路径补全。
	 */
	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		// 判断是否处于斜杠命令上下文
		if (beforeCursor.trimStart().startsWith("/")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete();
		}
	}

	/**
	 * 斜杠命令补全处理。
	 * 目前直接复用常规补全；后续可扩展为命令专属的参数补全。
	 */
	private handleSlashCommandCompletion(): void {
		// 暂时退回到常规补全（斜杠命令）
		// 后续可扩展为命令专属的参数补全
		this.tryTriggerAutocomplete(true);
	}

	/**
	 * 强制触发文件路径补全。
	 * 若 provider 实现了 getForceFileSuggestions 则调用之，
	 * 否则退回常规的 tryTriggerAutocomplete。
	 */
	private forceFileAutocomplete(): void {
		if (!this.autocompleteProvider) return;

		// 检查 provider 是否实现了强制文件补全方法（鸭子类型检测）
		const provider = this.autocompleteProvider as any;
		if (!provider.getForceFileSuggestions) {
			this.tryTriggerAutocomplete(true);
			return;
		}

		const suggestions = provider.getForceFileSuggestions(
			this.state.lines,
			this.state.cursorLine,
			this.state.cursorCol,
		);

		if (suggestions && suggestions.items.length > 0) {
			this.autocompletePrefix = suggestions.prefix;
			this.autocompleteList = new SelectList(suggestions.items, 5);
			this.isAutocompleting = true;
		} else {
			this.cancelAutocomplete();
		}
	}

	/**
	 * 取消自动补全：关闭激活标记并清空列表与前缀。
	 */
	private cancelAutocomplete(): void {
		this.isAutocompleting = false;
		this.autocompleteList = undefined as any;
		this.autocompletePrefix = "";
	}

	/**
	 * 补全激活期间增量刷新候选列表；无匹配项时自动取消补全。
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
				// 直接用新候选重建列表（保持最多 5 项的展示上限）
				this.autocompleteList = new SelectList(suggestions.items, 5);
			}
		} else {
			// 无匹配项 —— 取消补全
			this.cancelAutocomplete();
		}
	}
}
