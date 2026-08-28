/**
 * @file truncate.ts —— 工具输出的统一截断工具
 *
 * @description
 * 为各内置工具（read / bash / ls / grep 等）提供共享的输出截断能力，
 * 防止超长输出撑爆模型上下文。截断基于两个相互独立的上限，先命中者生效：
 * - 行数上限（默认 2000 行）；
 * - 字节上限（默认 50KB）。
 *
 * 提供两个方向的截断：
 * - truncateHead：从头截断，保留前 N 行/字节（适合文件读取，想看开头）；
 * - truncateTail：从尾截断，保留后 N 行/字节（适合 bash 输出，想看结尾的
 *   错误与最终结果）。
 *
 * 除 bash 尾部截断的边界情形外，从不返回被拦腰截断的半行。
 * 另提供 truncateLine 对超长单行（grep 匹配行）按字符数截断。
 * 调用方依据 TruncationResult 的统计字段（truncatedBy、firstLineExceedsLimit 等）
 * 生成下一步引导文案；TUI 渲染层则用它们展示截断警告。
 * 被 read / bash / ls / grep 等工具共同引用，是输出体积控制的单一事实来源。
 * 无外部依赖，仅用 Node Buffer 计算字节数。
 */

/** 默认行数上限：2000 行 */
export const DEFAULT_MAX_LINES = 2000;
/** 默认字节上限：50KB（50 * 1024 字节） */
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
/** grep 匹配行的单行最大字符数 */
export const GREP_MAX_LINE_LENGTH = 500; // 每行 grep 匹配结果的最大字符数

/** 截断结果：内容 + 完整的截断统计信息（供工具在结果里生成引导提示、TUI 渲染警告） */
export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 命中的上限类型："lines"、"bytes"，未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断后输出中的完整行数 */
	outputLines: number;
	/** 截断后输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅尾部截断的边界情形） */
	lastLinePartial: boolean;
	/** 首行是否超过字节上限（头部截断专用标记） */
	firstLineExceedsLimit: boolean;
	/** 实际应用的行数上限 */
	maxLines: number;
	/** 实际应用的字节上限 */
	maxBytes: number;
}

/** 截断选项：可分别覆盖行数与字节上限 */
export interface TruncationOptions {
	/** 最大行数（默认：2000） */
	maxLines?: number;
	/** 最大字节数（默认：50KB） */
	maxBytes?: number;
}
// 两项均可独立覆盖；未提供的项回落到 DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES。

/**
 * 按统计口径拆行：与 split("\n") 的区别在于末尾换行不产生多余的空行
 * （"a\n" 记为 1 行而不是 2 行）；空串记为 0 行。
 * 供两个方向的截断共用，保证 head/tail 的行数统计口径一致。
 */
function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	// 末尾的换行符不应多算一行：pop 掉 split 产生的空尾行
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

/**
 * 把字节数格式化为人类可读的大小（B / KB / MB，保留一位小数）。
 * 例：512 → "512B"，2048 → "2.0KB"。
 */
export function formatSize(bytes: number): string {
	// 依次以 1KB、1MB 为界选择单位
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断内容（保留前 N 行/字节）。
 * 适合文件读取等想看到开头的场景。
 * 截断原因通过 truncatedBy / firstLineExceedsLimit 暴露给调用方。
 *
 * 从不返回半行。若首行单独就超过字节上限，
 * 返回空内容并置 firstLineExceedsLimit=true（由调用方引导改用 bash 等手段）。
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// 检查首行单独是否就超过字节上限
	// 此时没有任何完整行可输出，交由调用方（如 read 工具）引导兜底
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// ===== 逐行收集能放得下的完整行 =====
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	// 双重上界：行索引既受 maxLines 约束，循环体内又受 maxBytes 约束
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		// 首行没有前置换行符，其余行 +1 计入换行符字节
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 计入换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			// 再加这一行就会超字节上限：到此为止，且不带入半行
			truncatedBy = "bytes";
			break;
		}

		// 该行可完整放入：纳入输出
		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 若是因为行数上限退出，则改判为按行截断
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	// 以实际拼接结果重算字节数，保证统计与返回内容一致
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 从尾部截断内容（保留后 N 行/字节）。
 * 适合 bash 输出等想看到结尾（错误信息、最终结果）的场景。
 * 与 truncateHead 相对，二者共享同一套 TruncationResult 统计结构。
 *
 * 若原始内容最后一行单独超过字节上限，可能返回被截断的半行
 * （lastLinePartial=true，这是唯一允许半行的情形）。
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// 检查是否无需截断
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			content,
			truncated: false,
			truncatedBy: null,
			totalLines,
			totalBytes,
			outputLines: totalLines,
			outputBytes: totalBytes,
			lastLinePartial: false,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};
	}

	// ===== 从末尾向前逐行收集 =====
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	// 双重上界：行数未满（< maxLines）且还有剩余行（i >= 0）时继续收集
	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		// 已收集过行时，当前行需要前置换行符，+1 计入
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 计入换行符

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// 边界情形：一行都还没收集且这一行就超过 maxBytes，
			// 则取该行的末尾（允许半行，并标记 lastLinePartial）
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		// unshift 保证输出仍按原始行序排列（收集是倒序进行的）
		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 若是因为行数上限退出，则改判为按行截断
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: finalOutputBytes,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * 把字符串截断到字节上限内（保留末尾部分）。
 * 正确处理多字节 UTF-8 字符：必要时向前挪动起点以对齐字符边界，
 * 避免切出乱码。
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// 从末尾算起，回退 maxBytes 字节得到候选起点
	// 起点若落在多字节字符中间，直接 slice 会解出乱码，必须先对齐字符边界
	let start = buf.length - maxBytes;

	// 找到合法的 UTF-8 边界（字符的起始字节）：
	// UTF-8 后续字节形如 10xxxxxx，(byte & 0xc0) === 0x80 即为续字节
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/**
 * 把单行截断到最大字符数，并追加 [truncated] 后缀。
 * 用于 grep 匹配行——超长行常见于压缩后的单行 JSON/JS，
 * 截断以保护终端排版与模型上下文。
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	// 按 UTF-16 码元（line.length）而非字节截断：目的是控制排版而非体积
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
