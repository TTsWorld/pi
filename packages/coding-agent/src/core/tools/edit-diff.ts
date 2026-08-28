/**
 * @file edit-diff.ts —— edit 等文件编辑工具共享的 diff 计算引擎
 *
 * @description
 * 本文件实现编辑工具的底层 diff 能力，围绕两条主线：
 *
 * 1. 文本匹配与替换：
 *    - oldText/newText 精确匹配（要求唯一命中，零个或多个命中都报错）；
 *    - 模糊匹配兜底：对行尾空白、智能引号、Unicode 破折号与特殊空格归一化后再匹配，
 *      模糊命中时按「行级覆盖」把改动叠回原文，未触及的行保留原始字节；
 *    - 多条编辑先统一匹配、再倒序应用替换以保证偏移稳定，并校验区间互不重叠。
 *
 * 2. diff 生成与渲染：
 *    - generateUnifiedPatch：标准 unified patch（供外部程序消费）；
 *    - generateDiffString：带行号、折叠上下文的展示型 diff（供 TUI 红绿 diff 预览），
 *      并返回新文件的首个变更行号，便于界面跳转定位。
 *
 * 典型入口是 computeEditsDiff：读文件 → BOM/LF 归一化 → 应用编辑 → 产出预览 diff，
 * 全程不写盘；编辑工具真正落盘时同样复用此处的匹配逻辑。
 *
 * 依赖关系：
 * - `diff`：第三方库，提供行级 diff 与 unified patch 生成；
 * - `node:fs` / `node:fs/promises`：可读性检查与文件读取；
 * - `../../utils/text.ts`：BOM 拆分（splitBom）；
 * - `./path-utils.ts`：把用户提供的路径解析为基于 cwd 的绝对路径。
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { splitBom } from "../../utils/text.ts";
import { resolveToCwd } from "./path-utils.ts";

/**
 * 检测文本的换行符风格（CRLF 或 LF）。
 *
 * 判定规则：比较第一个 `\r\n` 与第一个 `\n` 谁先出现——
 * CRLF 更早出现则判为 CRLF；否则（包括完全没有换行符的文本）一律按 LF 处理，
 * 保证函数总有确定的返回值。
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	// 没有 LF，或首个 CRLF 出现在首个 LF 之后（说明那个 LF 不属于 CRLF）→ 按 LF
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/** 把 CRLF 与孤立的 CR 统一归一化为 LF；后续所有匹配与 diff 都在纯 LF 空间进行。 */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** normalizeToLF 的逆操作：按原文件的换行风格还原文本（LF 风格时无需处理）。 */
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 为模糊匹配归一化文本。按顺序施加渐进式变换：
 * - 去掉每行的行尾空白；
 * - 智能引号归一化为 ASCII 等价字符；
 * - Unicode 破折号/连字符归一化为 ASCII 连字符；
 * - 特殊 Unicode 空格归一化为普通空格。
 *
 * 注意：归一化可能改变文本长度（如 NFKC 全角转半角），因此归一化空间中的
 * 偏移不能直接用于原文，需配合 applyReplacementsPreservingUnchangedLines 叠回。
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// 逐行去掉行尾空白
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// 智能单引号 → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// 智能双引号 → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// 各类破折号/连字符 → -
			// U+2010 连字符、U+2011 不换行连字符、U+2012 数字连字符、
			// U+2013 en dash、U+2014 em dash、U+2015 水平线、U+2212 减号
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// 特殊空格 → 普通空格
			// U+00A0 不换行空格、U+2002-U+200A 各种宽度的空格、U+202F 窄不换行空格、
			// U+205F 中等数学空格、U+3000 全角空格
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * 按行切分文本，且每行保留自身的换行符（含行尾 `\n`），
 * 因此各段拼接后可无损还原原文；空文本返回空数组。
 */
function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** 一行在全文中的字符区间 [start, end)，end 包含该行的换行符。 */
interface LineSpan {
	start: number;
	end: number;
}

/** 一条匹配成功的编辑：把 baseContent 中从 matchIndex 开始的 matchLength 个字符替换为 newText。 */
interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** 替换三元组：MatchedEdit 中与文本定位/改写相关的子集。 */
type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

/** 计算全文每行的字符偏移区间，用于把「字符偏移」换算为「行号」。 */
function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		// 当前行区间为 [offset, offset + 行长)，随后游标推进到该行结尾
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

/**
 * 求一次替换实际触及的行区间，返回 { startLine, endLine }，
 * 其中 endLine 为开区间（最后一个触及行的下一行），便于按整行块切分与拼接。
 *
 * - 起始行：包含替换起点偏移的那一行（线性扫描，O(行数)）；
 * - 结束行：从起始行向后推进，直到某行结尾到达或越过替换终点。
 * 替换区间超出 baseContent 范围时抛错（理论上不应发生）。
 */
function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	// 找到包含替换起点的那一行
	let startLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (replacementStart >= line.start && replacementStart < line.end) {
			startLine = i;
			break;
		}
	}
	if (startLine === -1) {
		throw new Error("Replacement range is outside the base content.");
	}

	// 从起始行向后推进，直到某行结尾覆盖替换终点
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	return { startLine, endLine: endLine + 1 };
}

/**
 * 把一组（按位置升序的）替换依序应用到 content。
 *
 * Why 倒序应用：从最后一个替换开始改写，前面的替换就不会破坏后面替换的偏移；
 * 每次替换是一次 O(n) 的字符串拼接，总计 O(n × 替换个数)。
 *
 * offset：replacements 的 matchIndex 是相对完整 baseContent 的绝对偏移；
 * 当本函数作用于 baseContent 的某个切片时，需减去切片起点换算为切片内偏移。
 */
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	// 倒序应用：先改后面的替换，尚未应用的替换偏移不受影响
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * 把在 `baseContent` 上匹配到的替换应用回 `originalContent`，同时保留原文中
 * 未被触及的整行内容。
 *
 * 适用场景：baseContent 是原文的归一化视图（行数相同、内容被标准化）。
 * 每个替换先拓宽到它实际触及的完整行；被触及的行从归一化 base 重写，
 * 其余所有行则从 originalContent 原样拷回。保留范围由真实替换区间驱动，
 * 因此即使归一化后出现重复行，也不会被对齐到错误的出现位置。
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	// 原文与归一化 base 必须逐行对齐，否则无法按行号把原文行拷回
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	// ===== 按位置排序，把行区间互相重叠的替换合并成组 =====
	// 同组的替换落在同一个连续行块内，之后按组整体重写
	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		// 与当前组的行区间有交集 → 并入当前组，行范围取并集
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	// ===== 逐组拼接最终结果 =====
	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		// 组之前的未触及行：从原文原样拷回（保留原始字节）
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		// 组内触及的行块：从 base 切出对应片段并应用该组替换（偏移换算为块内相对偏移）
		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	// 最后一组之后的剩余原文行
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

export interface FuzzyMatchResult {
	/** 是否找到了匹配 */
	found: boolean;
	/** 匹配的起始下标（相对「应当用于执行替换的那份内容」，见 contentForReplacement） */
	index: number;
	/** 匹配到的文本长度 */
	matchLength: number;
	/** 是否使用了模糊匹配（false = 精确匹配） */
	usedFuzzyMatch: boolean;
	/**
	 * 执行替换操作时应使用的内容。
	 * 精确匹配时为原始内容；模糊匹配时为归一化后的内容。
	 */
	contentForReplacement: string;
}

/** 一次编辑操作：把 oldText 替换为 newText。 */
export interface Edit {
	oldText: string;
	newText: string;
}

/** 应用编辑的结果：baseContent 为编辑前的基准文本，newContent 为编辑后的完整文本。 */
export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/**
 * 在 content 中查找 oldText：先尝试精确匹配，失败后再降级为模糊匹配。
 * 使用模糊匹配时，返回的 contentForReplacement 是内容经模糊归一化后的版本
 * （已去除行尾空白、Unicode 引号/破折号已归一化为 ASCII）。
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// 先尝试精确匹配
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// 精确匹配失败 → 转入模糊匹配：完全在归一化空间中进行
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		// 精确与模糊都未命中：返回未找到，contentForReplacement 退回原文
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// 模糊匹配时返回归一化空间中的偏移。调用方可以用归一化内容计算替换，
	// 再决定其中多少归一化产物需要写回原文。
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/**
 * 统计 oldText 在 content 中出现的次数（两者先经同一套模糊归一化再计数）。
 * 基于 split 计数：出现 n 次会切出 n+1 段。
 */
function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/** 构造「找不到要替换文本」的错误；单条与多条编辑使用不同文案（后者带 edits[i] 下标）。 */
function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

/** 构造「文本出现多次、无法唯一定位」的错误，提示提供更多上下文。 */
function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

/** 构造「oldText 为空」的错误。 */
function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

/** 构造「替换后内容与原文完全相同（没有任何变化）」的错误——常暗示特殊字符问题或文本与预期不符。 */
function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * 对 LF 归一化后的内容应用一条或多条精确文本替换。
 *
 * 所有编辑都基于同一份原始内容匹配；替换随后按倒序应用以保持偏移稳定。
 * 若任一编辑需要模糊匹配，整个操作切换到模糊归一化的内容空间进行，
 * 再把行级改动叠回原文，使未触及的行块保留原始字节。
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	// 编辑文本先做 LF 归一化，屏蔽换行风格差异
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	// 空的 oldText 无法定位，直接报错
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// 预探测一轮：只要有任何一条编辑需要模糊匹配，就整体切换到模糊归一化空间，
	// 保证所有编辑的匹配偏移都基于同一份内容
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	// ===== 逐条匹配并做唯一性校验 =====
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

		// 同一 oldText 出现多次则无法唯一定位，报错
		const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
	}

	// ===== 校验替换区间互不重叠（按起点排序后，检查相邻对即可覆盖全部） =====
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		// 前一个替换的结尾越过当前替换的起点 → 区间交叠
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const baseContent = normalizedContent;
	// 模糊路径：把行级改动叠回原文，未触及的行保留原始字节；
	// 精确路径：直接倒序替换
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	// 应用后内容毫无变化 → 视为失败，避免「成功」的空操作掩盖问题
	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** 生成标准 unified patch（仅文件头、不带时间戳）；contextLines 控制上下文行数，默认 4。 */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * 生成面向展示的 diff 字符串：每行带行号前缀，`+`/`-`/空格 分别标记
 * 新增行、删除行与上下文行，过长的上下文区间折叠为 `...`。
 *
 * @returns diff 字符串，以及新文件中首个变更行的行号（供 TUI 跳转定位）
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	// 行级 diff：得到「相同 / 删除 / 新增」交替出现的片段序列
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	// 预计算最大行号的十进制宽度，让所有行号右对齐
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	// 两个行号游标分别跟踪旧/新文件的当前行；lastWasChange 标记上一个片段是否为变更
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		// 片段末尾换行符 split 出的空串不是真实行，去掉（边界：片段以 \n 结尾时）
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// 记录新文件中的首个变更行号（只记录一次）
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// 输出变更行：+ 行携带新行号，- 行携带旧行号
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// 删除行：使用旧文件行号
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// 相同片段（上下文）：只在紧邻变更的边界处展示少量行
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				// 夹在两个变更块之间：两端各显示 contextLines 行，中间折叠
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					// 行数超过两端的展示配额：保留首尾 contextLines 行，跳过中间
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					// 输出折叠标记 `...`；两侧行号游标仍需推进被跳过的行数
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				// 紧跟在变更之后：只显示前 contextLines 行，其余折叠
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				// 后面紧接着变更：只显示后 contextLines 行，被跳过的行以 `...` 标记在前
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// 与任何变更都不相邻：整块跳过，只推进两侧行号游标
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

/** diff 计算成功的结果：diff 文本 + 新文件中首个变更行的行号。 */
export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

/** diff 计算失败的结果：仅含人类可读的错误信息。 */
export interface EditDiffError {
	error: string;
}

/**
 * 在不真正写入文件的前提下，计算一条或多条编辑操作将产生的 diff。
 * 用于工具真正执行前在 TUI 中渲染预览。
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	// 把用户给的路径解析为基于 cwd 的绝对路径
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// 检查目标文件存在且可读，不可读时直接返回错误（不进入编辑逻辑）
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// 读取文件原始内容
		const rawContent = await readFile(absolutePath, "utf-8");

		// 匹配前剥掉 BOM（LLM 提供的 oldText 不会包含不可见的 BOM 字符）
		const { text: content } = splitBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// 生成展示用 diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		// 匹配/替换过程中的任何错误都转为 error 结果而非抛出，便于调用方直接展示
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 计算单条编辑操作的 diff（不应用）。
 * 保留作为单编辑调用方的便捷包装，内部直接委托 computeEditsDiff。
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
