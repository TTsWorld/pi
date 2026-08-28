/**
 * @file session-selector-search.ts —— 会话选择器的搜索与排序实现
 *
 * @description
 * 本文件为会话（session）选择器提供纯函数式的搜索能力：
 * - `parseSearchQuery`：把用户输入解析为词元列表（支持引号短语）
 *   或正则模式（`re:` 前缀），引号不配对时自动退回普通空白分词；
 * - `matchSession`：判断单个会话是否命中查询并给出得分（越低越靠前），
 *   模糊词元走 fuzzyMatch，短语走归一化后的精确子串匹配，正则走首处命中位置；
 * - `filterAndSortSessions`：组合「命名过滤 + 查询匹配 + 排序模式」，
 *   recent 模式仅过滤保持原序，其余模式按得分排序（同分按修改时间倒序）。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：fuzzyMatch 模糊匹配算法；
 * - `../../../core/session-manager.ts`：SessionInfo 会话元数据类型。
 */
import { fuzzyMatch } from "@earendil-works/pi-tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

/** 排序模式：threaded（线程分组）/ recent（最近优先）/ relevance（相关度优先） */
export type SortMode = "threaded" | "recent" | "relevance";

/** 名称过滤：all（全部会话）/ named（仅用户命名过的会话） */
export type NameFilter = "all" | "named";

/** 解析后的搜索查询：词元模式或正则模式 */
export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** 若设置该字段，说明解析失败，应将整个查询视为不匹配任何会话。 */
	error?: string;
}

/** 单个会话的匹配结果 */
export interface MatchResult {
	matches: boolean;
	/** 得分越低越靠前；仅当 matches === true 时有意义 */
	score: number;
}

/** 归一化文本：转小写、把任意空白折叠为单个空格并去掉首尾空白，用于短语匹配 */
function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 拼接会话的可搜索文本：ID + 名称 + 全部消息内容 + 工作目录。
 * 所有匹配（模糊/短语/正则）都在这段拼接文本上进行。
 */
function getSessionSearchText(session: SessionInfo): string {
	return `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
}

/** 判断会话是否被用户显式命名过（名称非空即视为已命名） */
export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

/** 名称过滤器：all 直接放行；named 只保留已命名的会话 */
function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

/**
 * 解析用户搜索词为结构化查询。
 *
 * 支持两种语法：`re:<pattern>` 进入正则模式（忽略大小写，非法正则记入 error）；
 * 其余进入词元模式——引号外内容按空白切成 fuzzy 词元（模糊匹配），
 * 引号内内容整体作为 phrase 词元（精确子串匹配）。
 *
 * @param query - 用户原始输入
 * @returns 解析结果；空查询返回空词元（匹配一切），解析失败时带 error 字段
 */
export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	// 空查询：无词元，matchSession 视为匹配一切
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// 正则模式：re:<pattern> 前缀
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			// 统一用 "i" 标志：搜索默认不区分大小写
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			// 非法正则不抛出，而是记录错误——上层会把整个查询视为不匹配
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// 词元模式，支持引号短语。
	// 示例：foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	/** 把 buf 中已累积的内容作为一个词元收尾（空内容直接丢弃） */
	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	// 单趟扫描：buf 累积当前词元，inQuote 记录是否处于引号内
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			// 引号开闭切换：闭合时按 phrase 收尾，开启前先把引号外内容按 fuzzy 收尾
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		// 引号外的空白符作为词元分隔；引号内的空白保留在词元里
		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	// 扫描结束时仍在引号内 → 引号不配对
	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// 引号不配对时，退回为按空白切分的普通分词（保留引号原样参与匹配）。
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush(inQuote ? "phrase" : "fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

/**
 * 判断单个会话是否命中已解析的查询，并计算相关度得分。
 *
 * 得分语义为「越低越靠前」：位置类得分（正则/短语的命中位置 × 0.1 权重）
 * 会与模糊匹配得分直接累加，0.1 的缩放让位置只做轻微的排序偏置。
 *
 * @param session - 待检查的会话
 * @param parsed - 经 parseSearchQuery 解析的查询
 * @returns 匹配结果；任一词元未命中即整体不匹配
 */
export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery): MatchResult {
	const text = getSessionSearchText(session);

	// ===== 正则模式：取首个命中位置作为得分 =====
	if (parsed.mode === "regex") {
		// 正则解析失败（regex 为 null）：视为不匹配
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		const idx = text.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	// 空词元（空查询）匹配一切，得分为 0
	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			// 懒初始化归一化文本：只有存在短语词元时才付出归一化开销
			if (normalizedText === null) {
				normalizedText = normalizeWhitespaceLower(text);
			}
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			// 短语要求归一化后精确子串命中，命中越早得分越低（越优）
			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		// fuzzy 词元走模糊匹配；任一词元不命中即整体不匹配
		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

/**
 * 过滤并排序会话列表：先按名称过滤器筛选，再按查询匹配；
 * 排序行为由 sortMode 决定（recent 仅过滤保持原序，其余按得分排序）。
 *
 * @param sessions - 候选会话列表（假定调用方已按所需默认顺序排好）
 * @param query - 用户原始搜索词；空白时跳过匹配直接返回
 * @param sortMode - 排序模式
 * @param nameFilter - 名称过滤，默认 "all"
 * @returns 过滤排序后的会话列表；查询解析失败时返回空数组
 */
export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	// 第一步：名称过滤（all 时直接复用原数组，避免无谓拷贝）
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	// 空查询：不做匹配，原样返回（顺序即调用方给定的顺序）
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	// 解析失败（如非法正则）：没有任何会话能匹配
	if (parsed.error) return [];

	// recent 模式：仅过滤，保持传入顺序。
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// 其余模式（relevance 等）：按得分升序排序，同分时按修改时间倒序。
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
