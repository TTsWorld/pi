/**
 * @file 工具输出内容的共享截断工具。
 *
 * @description read / bash 等工具用它限制返回给 LLM 的内容量，避免把超长输出
 * （大文件、冗长命令输出）原样塞进上下文。截断基于两个相互独立的上限——
 * 先命中哪个就由哪个生效：
 * - 行数上限（默认：2000 行）
 * - 字节上限（默认：50KB）
 *
 * 除 bash 尾部截断的边界情况外，绝不返回半行（始终保留完整行）。
 */

/** 默认的行数截断上限 */
export const DEFAULT_MAX_LINES = 2000;
/** 默认的字节截断上限 */
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
/** grep 匹配行允许的最大字符数（超长行多为压缩数据等噪音） */
export const GREP_MAX_LINE_LENGTH = 500; // grep 匹配行每行最大字符数

/**
 * 截断结果：除截断后的内容外，还携带原始/输出的行数与字节数等统计信息，
 * 供调用方生成"已省略 N 行 / M 字节"之类的省略提示。
 */
export interface TruncationResult {
	/** 截断后的内容 */
	content: string;
	/** 是否发生了截断 */
	truncated: boolean;
	/** 命中的上限类型："lines"（行数）或 "bytes"（字节）；未截断时为 null */
	truncatedBy: "lines" | "bytes" | null;
	/** 原始内容的总行数 */
	totalLines: number;
	/** 原始内容的总字节数 */
	totalBytes: number;
	/** 截断输出中的完整行数 */
	outputLines: number;
	/** 截断输出的字节数 */
	outputBytes: number;
	/** 最后一行是否被部分截断（仅在 tail 截断的边界情况下为 true） */
	lastLinePartial: boolean;
	/** 第一行是否超出字节上限（用于 head 截断） */
	firstLineExceedsLimit: boolean;
	/** 实际生效的行数上限 */
	maxLines: number;
	/** 实际生效的字节上限 */
	maxBytes: number;
}

/** 截断选项：两个上限相互独立、均为可选 */
export interface TruncationOptions {
	/** 最大行数（默认：2000） */
	maxLines?: number;
	/** 最大字节数（默认：50KB） */
	maxBytes?: number;
}

/** Node Buffer 的最小结构声明：本文件只用到 byteLength，避免引入 Node 类型依赖 */
interface RuntimeBuffer {
	byteLength(content: string, encoding: "utf8"): number;
}

// 优先取运行时自带的 Buffer（Node 环境存在；浏览器等环境为 undefined，走手写实现）
const runtimeBuffer = (globalThis as { Buffer?: RuntimeBuffer }).Buffer;
// 非 ASCII 字符检测：命中说明存在多字节 UTF-8 字符，string.length 不再等于字节数
const nonAsciiPattern = /[^\x00-\x7f]/;

/**
 * 计算字符串按 UTF-8 编码后的字节数。
 *
 * Why：JS 字符串以 UTF-16 code unit 计长，length 并不等于 UTF-8 字节数；
 * 字节截断上限必须按 UTF-8 计算，否则中文等多字节字符内容会被超量返回给 LLM。
 *
 * @param content 待统计的字符串
 * @returns UTF-8 编码后的字节数
 */
function utf8ByteLength(content: string): number {
	// 快速路径：Node 环境下直接用 Buffer 计算，最准确也最快
	if (runtimeBuffer) return runtimeBuffer.byteLength(content, "utf8");

	// ========== 纯 JS 兜底实现（无 Buffer 的环境，如浏览器） ==========
	// 先定位首个非 ASCII 字符：其之前的部分 1 字符 = 1 字节，可直接按字符数计
	const firstNonAscii = content.search(nonAsciiPattern);
	if (firstNonAscii === -1) return content.length;

	// 前缀按字符数计入，其后逐字符按 UTF-8 编码规则累加
	let bytes = firstNonAscii;
	for (let i = firstNonAscii; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code <= 0x7f) {
			// ASCII 字符：1 字节
			bytes += 1;
		} else if (code <= 0x7ff) {
			// U+0080 ~ U+07FF（拉丁扩展、希腊文等）：2 字节
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
			// 高位代理项：尝试与其后一项配对一个完整码点
			const next = content.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				// 合法代理对（如 emoji、生僻字）：UTF-8 占 4 字节，跳过低位代理项
				bytes += 4;
				i++;
			} else {
				// 孤立的高位代理项：按替换字符 U+FFFD 的 3 字节计
				bytes += 3;
			}
		} else {
			// BMP 内其余字符（含常用中文）：3 字节
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * 将内容按 "\n" 拆分为行数组，用于行数统计与逐行截断。
 *
 * @param content 原始内容
 * @returns 行数组；内容以换行符结尾时会去掉末尾多出的空行，
 * 使 "a\nb\n" 与 "a\nb" 统计出的行数一致
 */
function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	// split 会因末尾换行符多产出一个空串，弹掉以免多计一行
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

/**
 * 把字符串中孤立的（未配对的）UTF-16 代理项替换为替换字符 U+FFFD（"�"）。
 *
 * Why：孤立代理项无法编码为合法 UTF-8，而按字节截断可能把代理对从中间切开，
 * 因此输出前需要先消毒。
 *
 * @param content 待消毒的字符串
 * @returns 消毒后的字符串，可安全编码为 UTF-8
 */
function replaceUnpairedSurrogates(content: string): string {
	let output = "";
	for (let i = 0; i < content.length; i++) {
		const code = content.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			// 高位代理项：若后一项是配对的低位代理项，原样保留整个代理对
			if (i + 1 < content.length) {
				const next = content.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					output += content[i] + content[i + 1];
					i++; // 跳过已消费的低位代理项
					continue;
				}
			}
			// 后面没有可配对的低位代理项 → 孤立代理项，替换为 "�"
			output += "�";
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			// 凭空出现的低位代理项（配对的高位项已被截掉）同样替换
			output += "�";
		} else {
			output += content[i];
		}
	}
	return output;
}

/**
 * 将字节数格式化为人类可读的大小（如 512B、1.5KB、2.0MB），用于截断提示信息。
 *
 * @param bytes 字节数
 * @returns 带单位的可读大小字符串
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) {
		// 不足 1KB：直接显示字节数
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		// 1KB ~ 1MB：换算为 KB，保留一位小数
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		// 1MB 及以上：换算为 MB，保留一位小数
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}

/**
 * 从头部截断内容（保留开头 N 行 / N 字节）。
 * 适合读文件等更关心开头部分的场景。
 *
 * 绝不返回半行。若第一行本身就超出字节上限，
 * 返回空内容并置 firstLineExceedsLimit=true（由调用方据此向 LLM 说明）。
 *
 * @param content 原始内容
 * @param options 截断选项（maxLines / maxBytes，可选）
 * @returns 截断结果，见 {@link TruncationResult}
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	// 未指定选项时回退到默认上限（2000 行 / 50KB）
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// ========== 快速路径：行数与字节数均未超限（正好等于上限不算超限），原样返回 ==========
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

	// ========== 边界情况：第一行单独就超过字节上限 ==========
	// 连一行完整内容都放不下：返回空内容并标记 firstLineExceedsLimit
	const firstLineBytes = utf8ByteLength(lines[0]);
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

	// ========== 从头逐行收集：行数与字节双上限同时生效，先命中者胜 ==========
	// 逐行累加字节数，一旦某整行放不下就停止，保证绝不产生半行
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		// 首行不计换行符字节（最终 join("\n") 只在行与行之间插入换行符），保证统计与输出一致
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 计入换行符字节

		if (outputBytesCount + lineBytes > maxBytes) {
			// 连这一行一起放会超字节上限：判定为按字节截断，丢弃该行及其后所有行
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// 若收满 maxLines 行且字节未超限（循环因行数预算耗尽而非 break 结束），
	// 改判为按行数截断
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

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
 * 从尾部截断内容（保留末尾 N 行 / N 字节）。
 * 适合 bash 输出等更关心结尾的场景（错误信息、最终结果通常在末尾）。
 *
 * 若原始内容的最后一行单独超出字节上限，会保留该行的末尾部分（半行），
 * 并置 lastLinePartial=true——这是本模块唯一可能返回半行的地方。
 *
 * @param content 原始内容
 * @param options 截断选项（maxLines / maxBytes，可选）
 * @returns 截断结果，见 {@link TruncationResult}
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	// 未指定选项时回退到默认上限（2000 行 / 50KB）
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const totalBytes = utf8ByteLength(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;

	// ========== 快速路径：行数与字节数均未超限（正好等于上限不算超限），原样返回 ==========
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

	// ========== 从末尾向前逐行收集：行数与字节双上限同时生效，先命中者胜 ==========
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		// 已收集过行时，当前行在最终输出中会带一个前置换行符，故 +1；
		// 最后收集的那行（即输出的第一行）前面没有换行符，不加
		const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 计入换行符字节

		if (outputBytesCount + lineBytes > maxBytes) {
			// 连这一行一起放会超字节上限：判定为按字节截断，停止收集
			truncatedBy = "bytes";
			// 边界情况：一行都还没收集、且当前行本身就超过字节上限——
			// 保留该行末尾的字节（半行），这是唯一允许返回部分行的场景
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// 若收满 maxLines 行且字节未超限（循环因行数预算耗尽而非 break 结束），
	// 改判为按行数截断
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");
	const finalOutputBytes = utf8ByteLength(outputContent);

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
 * 从末尾向前截取字符串，使其 UTF-8 字节数不超过给定上限。
 * 仅在 truncateTail 的"单行超限"边界情况下使用（此时即使半行也要给出内容）。
 *
 * 按字符（而非字节）从后向前累加，正确处理多字节 UTF-8 字符，
 * 绝不会从一个字符的 UTF-8 序列中间切开。
 *
 * @param str 原始字符串
 * @param maxBytes 允许的最大 UTF-8 字节数
 * @returns 截取出的末尾部分；若切出孤立代理项，会被替换为 "�"
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	// 上限非正数：没有可保留的内容
	if (maxBytes <= 0) return "";

	// ========== 从最后一个字符向前逐个尝试放入，直到再放一个就会超限 ==========
	let outputBytes = 0; // 已累计的 UTF-8 字节数
	let start = str.length; // 结果的起始下标，随放入的字符不断前移
	let needsReplacement = false; // 途中是否遇到孤立代理项，结束时需消毒
	for (let i = str.length; i > 0; ) {
		let characterStart = i - 1; // 当前字符首个 code unit 的下标
		const code = str.charCodeAt(characterStart);
		let characterBytes: number; // 当前字符占用的 UTF-8 字节数
		let unpairedSurrogate = false;
		if (code >= 0xdc00 && code <= 0xdfff && characterStart > 0) {
			// 低位代理项：检查前一项是否为配对的高位代理项
			const previous = str.charCodeAt(characterStart - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) {
				// 合法代理对：4 字节，字符起点前移一位以覆盖两个 code unit
				characterStart--;
				characterBytes = 4;
			} else {
				// 孤立的低位代理项：按替换字符 U+FFFD 的 3 字节计
				characterBytes = 3;
				unpairedSurrogate = true;
			}
		} else if (code >= 0xd800 && code <= 0xdfff) {
			// 位于字符串开头、无法再向前配对的高位代理项：同样按 3 字节计
			characterBytes = 3;
			unpairedSurrogate = true;
		} else {
			// 常规字符：ASCII 1 字节；U+0080~U+07FF 2 字节；其余 BMP 字符 3 字节
			characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
		}
		// 再放一个字符就会超限：停在此处，保证不切开任何完整字符
		if (outputBytes + characterBytes > maxBytes) break;
		outputBytes += characterBytes;
		start = characterStart;
		needsReplacement ||= unpairedSurrogate;
		i = characterStart;
	}

	// 从最终起点取到末尾即为结果；含孤立代理项时先消毒再返回
	const output = str.slice(start);
	return needsReplacement ? replaceUnpairedSurrogates(output) : output;
}

/**
 * 将单行截断到最大字符数，截断时追加 "... [truncated]" 后缀作为省略提示。
 * 用于 grep 匹配行：超长行多为压缩数据/静态资源等噪音，截断可避免浪费 token。
 *
 * @param line 原始行
 * @param maxChars 最大字符数（默认取 {@link GREP_MAX_LINE_LENGTH}，即 500）
 * @returns text 为处理后的文本，wasTruncated 表示是否发生了截断
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
): { text: string; wasTruncated: boolean } {
	// 未超限（含正好等于上限的情况）：原样返回
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	// 超限：保留前 maxChars 个字符并追加省略提示后缀
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}
