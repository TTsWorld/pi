/**
 * @file 纯文本组件（TextComponent）
 * @description
 * pi monorepo 终端 UI 框架（tui 包）中的基础文本渲染组件。
 *
 * 主要功能：
 * - 在给定宽度内渲染多行文本，支持四方向 padding（上/下/左/右）
 * - 按空格分词做词级折行（word wrapping），折行时以「可见长度」而非字符串长度
 *   计算，因此能正确处理内嵌的 ANSI 转义序列（颜色/样式码不占显示宽度）
 * - 缓存上一次渲染的行数组，通过与本次渲染结果逐行比对来判断内容是否变化，
 *   避免下游重复重绘相同内容
 *
 * 依赖关系：
 * - 从 `../tui.js` 引入 Component 接口、ComponentRenderResult 渲染结果类型、
 *   getNextComponentId 组件 ID 生成器，以及 Padding（四边内边距，均可省略）。
 * 组件遵循 tui 框架的 render(width) 契约：输入可用宽度，输出行数组 + changed 标记。
 */
import { type Component, type ComponentRenderResult, getNextComponentId, type Padding } from "../tui.js";

/**
 * 终端纯文本组件。
 *
 * 实现 Component 接口，负责把一段文本（可含换行与 ANSI 转义）在指定宽度内
 * 渲染为带 padding 的行数组，并通过缓存比对报告内容是否发生变化。
 */
export class TextComponent implements Component {
	/** 组件唯一 ID，由 tui 框架的全局计数器分配，用于渲染器区分各组件 */
	readonly id = getNextComponentId();
	/** 当前待渲染的文本内容（可含换行符与 ANSI 转义序列） */
	private text: string;
	/** 上一次 render() 输出的行数组快照，用于 changed 判定（浅拷贝缓存） */
	private lastRenderedLines: string[] = [];
	/** 四方向内边距（top/bottom/left/right），构造时已把可选项填充为具体数值 */
	private padding: Required<Padding>;

	/**
	 * 创建文本组件。
	 *
	 * @param text - 初始文本内容，可包含换行符与 ANSI 转义序列
	 * @param padding - 可选的四方向内边距；任一方向未指定时默认为 0
	 */
	constructor(text: string, padding?: Padding) {
		this.text = text;
		// 用 ?? 0 把可选的 Padding 补全为 Required<Padding>，后续逻辑无需再判空
		this.padding = {
			top: padding?.top ?? 0,
			bottom: padding?.bottom ?? 0,
			left: padding?.left ?? 0,
			right: padding?.right ?? 0,
		};
	}

	/**
	 * 在给定宽度内渲染文本为多行结果。
	 *
	 * 处理流程：计算可用宽度 → 顶部 padding → 按换行拆分并对每行做
	 * ANSI 感知的词折行 → 底部 padding → 与上次渲染结果比对得出 changed。
	 *
	 * @param width - 容器分配给该组件的总宽度（含左右 padding）
	 * @returns 渲染结果：行数组 + 本次内容相对上次是否变化的标记
	 */
	render(width: number): ComponentRenderResult {
		// ========== 计算可用宽度 ==========
		// 从总宽度中扣除左右 padding 得到正文可用宽度；
		// Math.max(1, ...) 兜底保证至少为 1，避免 padding 过大时出现 0/负宽度导致死循环或空渲染
		const availableWidth = Math.max(1, width - this.padding.left - this.padding.right);
		// 左侧 padding 预先拼成空格串，后续每行行首直接拼接
		const leftPadding = " ".repeat(this.padding.left);

		// ========== 按换行符拆分 ==========
		// 先按显式换行符拆分以保留用户手动的换行结构，折行只发生在各行内部
		const textLines = this.text.split("\n");
		const lines: string[] = [];

		// ========== 顶部 padding ==========
		// 在正文之前压入 N 个空行（注意：空行不带左侧 padding，终端会裁剪行尾空白）
		for (let i = 0; i < this.padding.top; i++) {
			lines.push("");
		}

		// ========== 逐行词折行（ANSI 感知） ==========
		for (const textLine of textLines) {
			if (textLine.length === 0) {
				// 空行也要保留左侧 padding，保证垂直方向上左对齐位置一致
				lines.push(leftPadding);
			} else {
				// 按空格分词做词级折行；长度计算用「可见长度」（剔除 ANSI 转义后再计数），
				// 否则带颜色的词会被高估宽度而提前折行
				const words = textLine.split(" ");
				let currentLine = "";
				let currentVisibleLength = 0;

				for (const word of words) {
					// 当前词的可见长度（ANSI 转义不计入）
					const wordVisibleLength = this.getVisibleLength(word);
					// 词与词之间的分隔空格占 1 列；首词（currentLine 为空）不需要前导空格
					const spaceLength = currentLine ? 1 : 0;

					if (currentVisibleLength + spaceLength + wordVisibleLength <= availableWidth) {
						// 还能放下：追加到当前行（首词前不加空格），并累加可见长度
						currentLine += (currentLine ? " " : "") + word;
						currentVisibleLength += spaceLength + wordVisibleLength;
					} else {
						// 放不下了：先把已积累的当前行输出（带左侧 padding），再以本词开启新行。
						// 注意：即使单个词本身超过 availableWidth，也不做字符级截断，而是整词换行，
						// 由终端自行处理超宽显示
						if (currentLine) {
							lines.push(leftPadding + currentLine);
						}
						currentLine = word;
						currentVisibleLength = wordVisibleLength;
					}
				}

				// 循环结束后把最后一行（非空时）输出，避免遗漏
				if (currentLine) {
					lines.push(leftPadding + currentLine);
				}
			}
		}

		// ========== 底部 padding ==========
		// 与顶部 padding 对称，正文之后压入 N 个空行
		for (let i = 0; i < this.padding.bottom; i++) {
			lines.push("");
		}

		// 兜底：至少返回一行（空文本/全 padding 被裁掉时保证 lines 非空，符合渲染契约）
		const newLines = lines.length > 0 ? lines : [""];

		// ========== 缓存比对，判定内容是否变化 ==========
		// 与上次渲染快照逐行比较；只有内容真正变化时 changed 才为 true，
		// 下游可据此跳过重复重绘
		const changed = !this.arraysEqual(newLines, this.lastRenderedLines);

		// 无论是否变化都更新缓存快照（拷贝一份，防止外部修改 newLines 影响下次比对）
		this.lastRenderedLines = [...newLines];

		return {
			lines: newLines,
			changed,
		};
	}

	/**
	 * 更新文本内容。
	 *
	 * 只修改内部状态，不触发渲染；变化会在下一次 render() 时通过缓存比对体现。
	 *
	 * @param text - 新的文本内容
	 */
	setText(text: string): void {
		this.text = text;
	}

	/**
	 * 获取当前文本内容。
	 *
	 * @returns 当前存储的文本（原样返回，含 ANSI 转义与换行符）
	 */
	getText(): string {
		return this.text;
	}

	/**
	 * 逐元素比较两个字符串数组是否完全相等。
	 *
	 * 用于 render() 中新旧行数组的比对：长度不同直接判不等，
	 * 否则逐行严格比较（===），任一行不同即返回 false。
	 *
	 * @param a - 第一个数组（通常是本次渲染结果）
	 * @param b - 第二个数组（通常是上次渲染的缓存快照）
	 * @returns 两数组长度及每个元素都相同时返回 true
	 */
	private arraysEqual(a: string[], b: string[]): boolean {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	}

	/**
	 * 计算字符串的「可见长度」。
	 *
	 * 用正则剔除 SGR 类 ANSI 转义序列（如 `\x1b[31m`、`\x1b[0m`，即颜色/加粗等样式码）
	 * 后再取长度，得到的才是该字符串在终端中实际占据的列数。
	 * `str || ""` 兜底处理 null/undefined 输入。
	 *
	 * @param str - 待测量的字符串，可包含 ANSI 转义序列
	 * @returns 剔除 ANSI 转义后的字符数（终端可见宽度，按每字符 1 列估算）
	 */
	private getVisibleLength(str: string): number {
		// 正则匹配 ESC [ 数字/分号 m 形式的 SGR 序列并移除，再统计剩余字符数
		return (str || "").replace(/\x1b\[[0-9;]*m/g, "").length;
	}
}
