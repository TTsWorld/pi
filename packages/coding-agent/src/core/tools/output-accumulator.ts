/**
 * @file output-accumulator.ts —— 有界内存的流式输出累积器
 *
 * @description
 * 长时间运行命令（如 Bash / PowerShell 工具）的输出可能无限长，
 * 全部驻留内存既危险也没必要。OutputAccumulator 的应对策略：
 * 1. 原始 chunk 先攒在内存，总量超过任一上限后切换为「完整输出落盘临时文件」；
 * 2. 内存中始终只保留一个受限大小的解码尾部窗口（rolling tail），
 *    用于随时生成展示快照；
 * 3. 全量统计（字节数 / 行数）持续累加，快照时据此计算截断信息，
 *    并可在截断发生时持久化完整输出供用户查看。
 *
 * 依赖关系：
 * - `./truncate.ts`：尾部截断（truncateTail）与默认上限常量；
 * - `node:fs` / `node:crypto` / `node:os`：临时文件写入与随机命名。
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

/** OutputAccumulator 构造选项（均可选，未提供时使用 truncate.ts 的默认上限） */
export interface OutputAccumulatorOptions {
	/** 快照保留的最大行数 */
	maxLines?: number;
	/** 快照保留的最大字节数（同时作为触发落盘的阈值之一） */
	maxBytes?: number;
	/** 溢出临时文件名的固定前缀 */
	tempFilePrefix?: string;
}

/** 累积输出在某一时刻的展示快照 */
export interface OutputSnapshot {
	/** 经尾部截断后可直接展示的内容 */
	content: string;
	/** 截断元信息（是否截断、总量、上限等） */
	truncation: TruncationResult;
	/** 完整输出落盘后的临时文件路径（未落盘时为 undefined） */
	fullOutputPath?: string;
}

/** 生成临时文件路径：<系统 tmpdir>/<prefix>-<8 字节随机 hex>.log，随机后缀避免并发冲突 */
function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

/** 计算字符串的 UTF-8 字节数（各处字节上限均按 UTF-8 字节而非字符数计算） */
function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * 以有界内存增量追踪流式输出。
 *
 * 用流式 UTF-8 解码器逐块解码追加；内存里只保留解码后的尾部文本
 * 用于展示快照；当需要保留完整输出时改写入临时文件。
 */
export class OutputAccumulator {
	// ===== 配置 =====
	private readonly maxLines: number;
	private readonly maxBytes: number;
	/** 尾部滚动窗口的字节上限（取 2×maxBytes，见构造函数中的说明） */
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	/** 流式 UTF-8 解码器：跨 chunk 被拆开的多字节字符也能正确解码 */
	private readonly decoder = new TextDecoder();

	// ===== 运行状态 =====
	// 落盘前缓存在内存的原始（未解码）chunk；首次落盘时一次性补写进临时文件
	private rawChunks: Buffer[] = [];
	// 仅为快照保留的解码尾部文本及其字节数（内存有界的关键）
	private tailText = "";
	private tailBytes = 0;
	// 尾窗起点是否在行边界上；若不是，快照需丢弃首个残行，避免展示半行
	private tailStartsAtLineBoundary = true;
	// 以下为全量统计：无论内存中保留多少，总字节数 / 总行数始终累加
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	// 当前未完结行（尚未遇到换行符）已累计的字节数
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		// 滚动尾窗取 2×maxBytes：既足够覆盖快照截断所需，又把常驻内存限制在线性倍数；
		// maxBytes 可能为 0，用 Math.max(..., 1) 兜底防止后续比较失效
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	/**
	 * 追加一段原始输出 chunk。
	 *
	 * @throws 在 finish() 之后再次追加时抛错，防止静默丢失数据
	 */
	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		// stream: true 让解码器暂存不完整的多字节序列，等下一个 chunk 到齐再拼出字符
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		// 已在落盘，或本块导致总量越限 → 全量写临时文件；否则继续在内存里攒原始 chunk
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	/** 结束累积：冲刷解码器残留并标记完成；幂等，重复调用无副作用 */
	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		// 无参 decode() 冲刷流式解码器中残留的不完整多字节序列
		this.appendDecodedText(this.decoder.decode());
		// 若最终总量已越限，此刻也要保证临时文件存在（此前内容已在 append 时写入）
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	/**
	 * 生成当前时刻的展示快照：对尾部文本做截断，并附上全量统计与截断元信息。
	 *
	 * @param options.persistIfTruncated - 为 true 且确有截断时，强制把完整输出落盘，
	 *   保证返回的 fullOutputPath 可供用户查看全部内容
	 */
	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		// 快照文本只是尾部，不能单靠它判断整体是否被截断，需对照全量统计；
		// tailTruncation 也可能没标 truncatedBy，此处按「哪个总量越限」补算
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	/** 关闭临时文件流并等待数据全部刷盘；未开启过时为 no-op */
	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		// 先取引用并立即清空字段：使本方法幂等，等待期间的新调用直接返回
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			// finish 与 error 互斥触发：先到者摘掉另一方的监听，避免悬挂回调
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	/** 当前未完结行（还没等到换行符的那一行）已累计的字节数 */
	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	/**
	 * 处理一段已解码文本：累加全量统计、追加尾窗，并扫描换行符更新行级统计。
	 * 仅做单趟扫描，不缓存行数组。
	 */
	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		// 迟滞修剪：超过 2×滚动上限才修剪，避免每个 chunk 都触发一次字符串重建
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		// 单趟扫描：统计换行符个数，并记下最后一个换行符的位置
		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			// 本段没有换行：说明还在累积当前未完结行
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			// 最后一个换行符之后的部分成为新的未完结行
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	/**
	 * 把尾窗裁剪到 maxRollingBytes 以内：在字节层面从后往前保留，
	 * 并对齐到 UTF-8 字符边界与行边界。
	 */
	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			// 无需裁剪，仅把字节数计数校正为真实值
			this.tailBytes = buffer.length;
			return;
		}

		// 从目标起点向后跳过 UTF-8 连续字节（0b10xxxxxx），避免把多字节字符拦腰截断
		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		// 0x0a 即 "\n"：检查保留部分的前一个字节，判断新起点是否恰好落在行首
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	/**
	 * 取用于快照的文本：若尾窗起点不在行边界，丢弃首个残行
	 * （它的开头已在早前修剪时丢失，展示半行只会造成误导）；否则原样返回。
	 */
	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	/** 原始字节 / 解码字节 / 总行数任一越限，即认为需要把完整输出落盘保存 */
	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	/** 幂等地打开临时文件：首次调用时把此前攒在内存的原始 chunk 补写进去，再清空缓冲 */
	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		// 落盘前留在内存里的 chunk 也要补写，保证临时文件内容完整
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		// 补写完成，释放内存占用
		this.rawChunks = [];
	}
}
