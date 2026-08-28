/**
 * @file diff.ts —— diff 文本的终端彩色渲染
 *
 * @description
 * 把带行号的 diff 文本渲染为带 ANSI 颜色的字符串：上下文行灰色、删除行红色、
 * 新增行绿色；当连续的「一删一增」构成单行修改时，进一步做词级（intra-line）
 * 比对并用反色高亮行内真正变化的 token，让改动点一目了然。
 *
 * 输入行格式由 parseDiffLine 定义（+/-/空格 前缀 + 行号 + 内容）；
 * 无法识别的行原样透传，因此对 "@@" 头、省略行 "     ..." 等同样安全。
 * 供工具结果展示等场景复用。
 */

import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/**
 * 解析一行 diff 文本，提取出前缀、行号与内容三部分。
 * 支持的格式："+123 content"、"-123 content"、" 123 content" 或 "     ..."。
 *
 * @returns 匹配成功返回三段结构，格式不符返回 null（调用方按纯文本兜底渲染）
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	// 三个捕获组：行前缀（+/-/空格）、行号（可缺省，允许前导空格）、行内容
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * 把 Tab 替换为固定 3 个空格，保证 diff 各行的缩进在终端中对齐一致。
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * 对一删一增的两行内容做词级 diff，并用反色（inverse）标出发生变化的部分。
 *
 * 工作原理：
 * - 使用 diffWords 分词——它会自动把空白与相邻词归为一组，高亮块更干净；
 * - 未变化的词在删除行/新增行中原样输出（作为对照）；
 * - 两行各自的首个片段会剥离前导空白再高亮，避免把缩进也反色导致整行视觉错位。
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	// 标记是否还在处理行首片段：只有首个片段需要剥离前导空白，之后不再重复处理
	let isFirstRemoved = true;
	let isFirstAdded = true;

	// 遍历词级 diff 片段：removed 归入删除行、added 归入新增行、公共片段两行都原样保留
	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// 删除行的首个片段：剥离前导空白，只反色高亮实际内容
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += theme.inverse(value);
			}
		} else if (part.added) {
			let value = part.value;
			// 新增行的首个片段：同样剥离前导空白，避免高亮缩进
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += theme.inverse(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	// 返回的两行已含反色高亮标记，调用方只需再补上行号前缀与整行颜色
	return { removedLine, addedLine };
}

/** renderDiff 的选项。 */
export interface RenderDiffOptions {
	/** 文件路径（当前未使用，仅为保持 API 兼容而保留） */
	filePath?: string;
}

/**
 * 渲染 diff 文本：按行着色，并对单行修改做行内（intra-line）变更高亮。
 * - 上下文行：暗色/灰色；
 * - 删除行：红色，变化的 token 加反色；
 * - 新增行：绿色，变化的 token 加反色。
 *
 * @param diffText - 待渲染的 diff 文本（每行形如 "+123 内容"）
 * @param _options - 预留选项，当前不影响输出
 * @returns 拼接好的带 ANSI 颜色的多行字符串
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = []; // 输出行缓冲：先逐行着色，最后统一以换行拼接

	// 用 while 而非 for：删除块与其后的新增块需要成组消费，i 由各分支自行推进
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		// 解析失败的行（如 hunk 头 @@、文件头等）：按上下文行的暗色原样输出
		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// ===== 收集连续的删除行 =====
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// ===== 紧随其后收集连续的新增行 =====
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// 仅当「恰好一删一增」（即单行被修改）时才做行内 diff 高亮；
			// 多行增删无法建立一一对应关系，直接按原样整行着色展示
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				// 先统一做 Tab→空格替换再比对，保证高亮位置与最终渲染宽度一致
				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				// 整行红/绿底色与行内反色高亮叠加呈现
				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// 多行情形：先输出全部删除行，再输出全部新增行（保持 diff 惯例顺序）
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// 单独出现的新增行（前面没有配对的删除行）
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// 上下文行（前缀为空格）：保持原有行号与内容
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
