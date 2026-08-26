/**
 * @file edit 工具的 diff/patch 算法支撑模块（edit 及类似工具共用的 diff 计算工具集）。
 *
 * @description 为 {@link ./edit.ts} 中的 edit 工具提供文本替换与 diff 计算的核心算法：
 *
 * 1. 行尾处理：detectLineEnding 检测文件的主导行尾（CRLF/LF），normalizeToLF 在编辑前
 *    把内容归一化到 LF 空间（所有匹配/替换只在 LF 空间进行），restoreLineEndings 在
 *    写回前还原原行尾，避免污染文件。
 * 2. 文本定位：fuzzyFindText 精确匹配优先，失败后在模糊归一化空间重试（去行尾空白 +
 *    Unicode 引号/破折号/空格归一化为 ASCII，见 normalizeForFuzzyMatch）。
 * 3. 批量替换：applyEditsToNormalizedContent 把所有 edits 对同一份原始内容匹配、
 *    倒序应用以保持偏移稳定；任一 edit 走模糊匹配时，按行级 overlay 把改动叠回原文，
 *    未触及的行保留原始字节（applyReplacementsPreservingUnchangedLines）。
 * 4. diff 生成：generateUnifiedPatch 产出标准 unified patch（供外部工具应用），
 *    generateDiffString 产出带行号、上下文裁剪的展示用 diff。
 *
 * edit 工具的调用链：stripBom → detectLineEnding → normalizeToLF →
 * applyEditsToNormalizedContent → restoreLineEndings → generateDiffString / generateUnifiedPatch。
 */

import * as Diff from "diff";

/**
 * 检测文本的主导行尾风格（CRLF 或 LF）。
 *
 * 规则：比较 "\r\n" 与 "\n" 首次出现的先后——"\r\n" 更早出现则判 CRLF，否则判 LF；
 * 只有 LF 或完全不含换行符（单行/空文件）时按 LF 处理。注意 "\r\n" 内部也包含 "\n"，
 * 因此比较的是两种序列首次出现下标的先后，而不是简单计数。
 */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

/**
 * 把所有行尾归一化为 LF：CRLF（\r\n）→ LF，孤立的 CR（\r，旧 Mac 风格）→ LF。
 * edit 工具在读入文件后、匹配/替换前调用，使后续算法只需处理一种行尾。
 */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * normalizeToLF 的逆操作：把 LF 统一还原为指定行尾（ending 为 "\r\n" 时全部替换，为 "\n" 时原样返回）。
 * 用于写回文件前恢复该文件原有的行尾风格。
 */
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * 对文本做模糊匹配前的归一化，按顺序应用以下渐进变换：
 * - 剥掉每行的行尾空白
 * - 智能引号（弯引号）归一化为对应的 ASCII 引号
 * - Unicode 各种破折号/连字符归一化为 ASCII 连字符 "-"
 * - 特殊 Unicode 空白归一化为普通空格
 *
 * 目的：让 LLM 提供的 oldText 在「语义等价但字节不同」的差异（行尾空白、花引号、
 * 长破折号、不换行空格等）下仍能命中原文。
 */
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// 按行剥掉行尾空白
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// 智能单引号 → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// 智能双引号 → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// 各种破折号/连字符 → -
			// U+2010 连字符、U+2011 不换行连字符、U+2012 图表破折号、
			// U+2013 en-dash、U+2014 em-dash、U+2015 水平横线、U+2212 减号
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// 特殊空白 → 普通空格
			// U+00A0 不换行空格、U+2002-U+200A 各种宽度的空格、U+202F 窄不换行空格、
			// U+205F 中等数学空格、U+3000 表意文字空格（全角空格）
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

/**
 * 按行切分文本，每行保留自身的行尾符（含结尾的 "\n"；末行无换行符时也保留为独立一段）。
 * 正则含义：优先匹配「不含 \n 的任意字符 + \n」，退而匹配「不含 \n 的末尾残余」。
 * 空字符串返回 []；join("") 可无损还原原文——这是行级 overlay 能按字节还原原文的前提。
 */
function splitLinesWithEndings(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** 单行在整段文本中的字符区间。 */
interface LineSpan {
	/** 行首偏移（含） */
	start: number;
	/** 行尾偏移（不含）：等于 start + 该行长度（含行尾符） */
	end: number;
}

/** 一条已完成定位的 edit：在替换基准内容中命中的区间，以及要写入的新文本。 */
interface MatchedEdit {
	/** 对应 edits 数组的原始下标，用于报错时指明是 edits[i] */
	editIndex: number;
	/** 命中区间的起始偏移（基准内容中） */
	matchIndex: number;
	/** 命中区间的长度 */
	matchLength: number;
	/** 替换用的新文本 */
	newText: string;
}

/** 执行替换所需的最小字段集（即 MatchedEdit 去掉 editIndex），供纯替换逻辑复用。 */
type TextReplacement = Pick<MatchedEdit, "matchIndex" | "matchLength" | "newText">;

/**
 * 计算文本中每一行的字符区间表。
 * 时间/空间复杂度均为 O(n)（n 为文本长度）。
 * 前提：content 已是 LF 归一化文本（splitLinesWithEndings 只按 "\n" 切分，
 * 孤立的 "\r" 会残留在行内，导致行区间不准）。
 */
function getLineSpans(content: string): LineSpan[] {
	let offset = 0;
	return splitLinesWithEndings(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

/**
 * 把一个替换的字符区间 [matchIndex, matchIndex + matchLength) 定位为行区间。
 *
 * @param lines 各行区间表（来自 getLineSpans）
 * @param replacement 待定位的替换
 * @returns { startLine, endLine }：起始行与结束行（开区间约定，endLine 为最后一个被触及的行 + 1）
 * @throws 区间起点或终点落在所有行之外时抛错（例如对末尾无换行符的文本给出了越界偏移）
 */
function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
	// ========== 替换区间覆盖的字符范围 ==========
	const replacementStart = replacement.matchIndex;
	const replacementEnd = replacement.matchIndex + replacement.matchLength;

	// ========== 定位起始行：线性扫描找到包含 replacementStart 的行 ==========
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

	// ========== 定位结束行：从起始行向后推进，直到某行能覆盖区间终点 ==========
	// 边界：区间终点恰好落在某行末尾（行尾符之后）时，该行即为结束行、不再推进，
	// 因此终点紧贴换行符的替换不会多吞掉下一行。
	let endLine = startLine;
	while (endLine < lines.length && lines[endLine].end < replacementEnd) {
		endLine++;
	}
	if (endLine >= lines.length) {
		throw new Error("Replacement range is outside the base content.");
	}

	// 转为开区间行号（最后一个被触及的行 + 1），便于上层用 slice(startLine, endLine) 取行
	return { startLine, endLine: endLine + 1 };
}

/**
 * 把一批替换依次拼接应用。调用方需保证 replacements 已按 matchIndex 升序且互不重叠。
 *
 * 时间复杂度 O(k·m)（k 为替换数，m 为内容长度；每次替换都要整串复制拼接）。
 *
 * @param content 待替换的文本（通常是某个行段的切片）
 * @param replacements 已按 matchIndex 升序的替换列表
 * @param offset 各 matchIndex 相对 content 的偏移基数（matchIndex - offset 得到局部偏移）
 * @returns 替换完成后的新文本
 */
function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
	let result = content;
	// ========== 倒序应用：靠后的区间先替换，靠前区间的偏移保持稳定，无需重算 ==========
	for (let i = replacements.length - 1; i >= 0; i--) {
		const replacement = replacements[i];
		const matchIndex = replacement.matchIndex - offset;
		result =
			result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
	}
	return result;
}

/**
 * 把基于 `baseContent` 匹配到的替换应用回 `originalContent`，同时保留原文中未变更的行块。
 *
 * 适用场景：`baseContent` 是原文的归一化视图（例如模糊匹配空间）。做法是把每个替换
 * 扩展（widen）到它真正触及的行；被触及的行从归一化 base 重写，其余行原样拷贝自
 * `originalContent`。以实际替换区间（而非按行号对齐）驱动保留，可避免内容相同的
 * 归一化行被对齐到错误的出现位置。
 *
 * @param originalContent 原始内容（未触及的行保留其原始字节，含行尾空白等）
 * @param baseContent 归一化基准内容（replacements 的偏移基于它）
 * @param replacements 已完成匹配的替换列表
 * @returns 应用替换后的完整文本
 * @throws 二者行数不一致时抛错（归一化不得改变行数，否则无法逐行对齐）
 */
export function applyReplacementsPreservingUnchangedLines(
	originalContent: string,
	baseContent: string,
	replacements: TextReplacement[],
): string {
	// ========== 前置校验：归一化不得改变行数 ==========
	// 归一化只改行内字符、不动行数；行数不同说明二者不是同一份内容的两个视图，无法逐行对齐。
	const originalLines = splitLinesWithEndings(originalContent);
	const baseLines = getLineSpans(baseContent);
	if (originalLines.length !== baseLines.length) {
		throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
	}

	// ========== 分组：把（可能相邻/交叠的）替换合并为互不相交的行级 group ==========
	// 按 matchIndex 升序遍历：若新替换的起始行落在当前 group 的行区间内则并入该 group
	// （行区间取并集），否则新开一个 group。最终 group 序列按行有序且互不相交，可顺序拼接。
	const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
	const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
	for (const replacement of sortedReplacements) {
		const range = getReplacementLineRange(baseLines, replacement);
		const current = groups[groups.length - 1];
		if (current && range.startLine < current.endLine) {
			current.endLine = Math.max(current.endLine, range.endLine);
			current.replacements.push(replacement);
			continue;
		}
		groups.push({ ...range, replacements: [replacement] });
	}

	// ========== 顺序拼装：group 之外的行直接取原文（保留原始字节），group 之内的行从 base 重写 ==========
	let originalLineIndex = 0;
	let result = "";
	for (const group of groups) {
		result += originalLines.slice(originalLineIndex, group.startLine).join("");

		const groupStartOffset = baseLines[group.startLine].start;
		const groupEndOffset = baseLines[group.endLine - 1].end;
		result += applyReplacements(
			baseContent.slice(groupStartOffset, groupEndOffset),
			group.replacements,
			groupStartOffset,
		);
		originalLineIndex = group.endLine;
	}
	result += originalLines.slice(originalLineIndex).join("");

	return result;
}

/** fuzzyFindText 的查找结果。 */
export interface FuzzyMatchResult {
	/** 是否找到匹配 */
	found: boolean;
	/** 匹配起点的下标（位于「应当用于执行替换的内容」中，见 contentForReplacement） */
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

/** 一条文本替换：把 oldText（须在文件中唯一命中）替换为 newText。 */
export interface Edit {
	/** 待查找的旧文本 */
	oldText: string;
	/** 替换后的新文本 */
	newText: string;
}

/** applyEditsToNormalizedContent 的返回值。 */
export interface AppliedEditsResult {
	/** 输入的 LF 归一化内容（作为 diff 的 base） */
	baseContent: string;
	/** 应用全部替换后的新内容（仍为 LF 归一化形式） */
	newContent: string;
}

/**
 * 在 content 中查找 oldText：先尝试精确匹配，失败后再尝试模糊匹配。
 * 使用模糊匹配时，返回的 contentForReplacement 是 content 的模糊归一化版本
 * （已剥行尾空白，Unicode 引号/破折号/空格已归一化为 ASCII）。
 *
 * @param content 待查找的内容
 * @param oldText 待定位的旧文本
 * @returns 查找结果；未找到时 found 为 false，contentForReplacement 仍为原 content
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// 先尝试精确匹配：indexOf 命中即返回原始内容，字节对字节最可靠
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

	// 再尝试模糊匹配——完全在归一化空间中进行（原文与 oldText 都先归一化再查找）
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// 模糊匹配时返回归一化空间中的偏移。调用方可基于归一化内容计算替换，
	// 再决定归一化产物中应有多少写回原文件（见 applyReplacementsPreservingUnchangedLines）。
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

/** 若开头存在 UTF-8 BOM（\uFEFF）则剥掉；返回 BOM（没有则为空串）与去 BOM 后的文本。edit 工具写回时会把 BOM 拼回文件开头。 */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * 统计 oldText 在 content 中的出现次数（在模糊归一化空间中计数，与匹配阶段同一口径）。
 * 实现：split(oldText).length - 1；时间复杂度 O(n)。要求 oldText 非空
 * （空串会按字符切分导致计数失真，调用方已提前拦截空 oldText）。
 */
function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

/** 构造「oldText 未找到」错误。单条 edit 与多条 edits 数组使用不同措辞，提示需逐字符精确匹配。 */
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

/** 构造「oldText 命中多处」错误：oldText 必须唯一命中，提示提供更多上下文使其唯一。 */
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

/** 构造「oldText 为空」错误：空 oldText 可匹配任意位置，因此直接拒绝。 */
function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

/** 构造「替换后内容与原文完全相同」错误：通常意味着特殊字符不一致或文本与预期不符。 */
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
 * 所有 edits 都对同一份原始内容匹配（而非互相基于对方的结果增量应用），
 * 匹配完成后倒序应用替换以保持偏移稳定。若任一 edit 需要模糊匹配，则整个操作
 * 切换到模糊归一化内容空间进行，最后把这些行级改动 overlay 回原始内容，
 * 使未变更的行块保留原始字节。
 *
 * @param normalizedContent 已 normalizeToLF 的文件内容
 * @param edits 待应用的替换列表（各 oldText 须唯一命中且互不重叠）
 * @param path 文件路径（仅用于错误信息）
 * @returns baseContent 为输入内容、newContent 为替换结果（均为 LF 形式）
 * @throws oldText 为空、未找到、命中多处、edits 相互重叠或替换后无变化时抛错
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	// ========== 预处理：把每条 edit 的行尾也归一到 LF，并校验 oldText 非空 ==========
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// ========== 选择替换基准空间：任一 edit 需要模糊匹配则整体切换 ==========
	// 先对每条 edit 试匹配；只要有一条走模糊，所有 edit 都改在同一个模糊归一化空间中
	// 重新匹配与应用，避免不同 edit 作用于不同视图导致偏移错乱。
	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const usedFuzzyMatch = initialMatches.some((match) => match.usedFuzzyMatch);
	const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

	// ========== 在基准空间中逐条匹配，并做唯一性校验（多处命中无法确定改哪一处，必须报错） ==========
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
		if (!matchResult.found) {
			throw getNotFoundError(path, i, normalizedEdits.length);
		}

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

	// ========== 重叠检测：按 matchIndex 升序排序后，检查相邻两个区间是否交叠 ==========
	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	// ========== 应用替换：模糊路径走行级 overlay（未触及行保留原始字节），精确路径直接倒序替换 ==========
	const baseContent = normalizedContent;
	const newContent = usedFuzzyMatch
		? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matchedEdits)
		: applyReplacements(replacementBaseContent, matchedEdits);

	// ========== 兜底校验：替换后内容必须真的发生变化，否则视为编辑失败并提示排查特殊字符 ==========
	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/**
 * 生成标准 unified diff patch（基于 `diff` 包的 createTwoFilesPatch，同一文件前后对比）。
 * 默认保留 4 行上下文（hunk 上下文）；header 只输出文件路径（FILE_HEADERS_ONLY），不含时间戳。
 */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * 生成面向展示的 diff 字符串：每行以 +/-/空格 前缀标记新增/删除/上下文，并附带行号；
 * 变更块两侧的上下文行只保留 contextLines 行，被省略的行用一行 "..." 表示。
 *
 * 边界：空文件、末行无换行符的内容均可正常处理（按 split 后的实际行渲染）。
 *
 * @param oldContent 旧内容（LF 归一化）
 * @param newContent 新内容（LF 归一化）
 * @param contextLines 每侧保留的上下文行数（默认 4）
 * @returns diff 字符串，以及新文件中第一个变更行的行号（从 1 开始；无变更时为 undefined）
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	// ========== 行级对比：得到 added/removed/未变更 的 parts 序列 ==========
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	// ========== 预计算行号列宽度，保证各 part 输出的行号右对齐 ==========
	// 注意 split("\n") 对以 \n 结尾的文本会多出一个空串元素；此处只用于估算
	// 最大行号（决定补齐宽度），多算一行不影响对齐效果。
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	// ========== 逐 part 渲染：变更行带 +/- 前缀，上下文行做裁剪 ==========
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		// part.value 以 \n 结尾时 split 会产生末尾空串，弹出以免多渲染一行
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// 记录第一个变更行（以新文件计，只需记录一次）
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// 输出变更行：added 前缀 "+" 并用新行号，removed 前缀 "-" 并用旧行号
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// 删除行
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// 上下文行——只展示变更前后紧邻的几行（contextLines 行）
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			// 情形一：前后都紧邻变更——两端各保留 contextLines 行，超出部分折叠为 "..."
			if (hasLeadingChange && hasTrailingChange) {
				// 行数不超过两端上下文之和时全部展示，无需折叠
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

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
			// 情形二：仅前面紧邻变更——只保留最前 contextLines 行，其余折叠
			} else if (hasLeadingChange) {
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
			// 情形三：仅后面紧邻变更——只保留最后 contextLines 行，其余折叠
			} else if (hasTrailingChange) {
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
				// 与任何变更都不相邻的上下文行：整段跳过，只推进行号
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}
