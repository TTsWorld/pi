/**
 * @file bash-executor.ts —— bash 命令执行封装（流式输出 + 可取消）
 *
 * @description
 * 提供统一的 bash 执行实现，被以下调用方共用：
 * - AgentSession.executeBash()：交互模式与 RPC 模式的 `!` 命令；
 * - 其他需要直接执行 bash 的模式。
 *
 * 输出处理策略：边流式接收边净化（去 ANSI 转义、替换二进制乱码、统一换行），
 * 内存中只保留约 2 倍截断阈值的滚动缓冲，超出部分落盘到临时文件，
 * 最终按阈值截断尾部并在结果中给出完整输出的临时文件路径。
 *
 * 依赖关系：
 * - `./tools/bash.ts`：BashOperations 抽象（本地/SSH/容器等不同执行后端）；
 * - `./tools/truncate.ts`：DEFAULT_MAX_BYTES 阈值与 truncateTail 截断；
 * - `../utils/ansi.ts` / `../utils/shell.ts`：输出净化。
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// 类型
// ============================================================================

/** 执行的可选配置：流式回调与取消信号。 */
export interface BashExecutorOptions {
	/** 流式输出回调，逐块收到已净化的文本 */
	onChunk?: (chunk: string) => void;
	/** 用于取消执行的 AbortSignal */
	signal?: AbortSignal;
}

/** 一次 bash 执行的结果快照。 */
export interface BashResult {
	/** 合并后的 stdout + stderr 输出（已净化、可能被截断） */
	output: string;
	/** 进程退出码（被杀死/取消时为 undefined） */
	exitCode: number | undefined;
	/** 命令是否经由 signal 被取消 */
	cancelled: boolean;
	/** 输出是否被截断 */
	truncated: boolean;
	/** 存放完整输出的临时文件路径（仅当输出超过截断阈值时存在） */
	fullOutputPath?: string;
}

// ============================================================================
// 实现
// ============================================================================

/**
 * 使用自定义 BashOperations 执行 bash 命令。
 * 用于远程执行场景（SSH、容器等）。
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	// ===== 输出累积状态 =====
	const outputChunks: string[] = [];
	let outputBytes = 0;
	// 滚动缓冲上限 = 截断阈值的 2 倍：保证截断后仍留有完整「尾部」可展示
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;

	// 惰性创建临时文件：只在输出超过阈值时才落盘；
	// 创建时把内存中已缓冲的块补写进去，保证文件内容完整
	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath);
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	// 增量解码器：配合 stream 选项正确处理跨块的多字节 UTF-8 字符
	const decoder = new TextDecoder();

	// 每个 stdout/stderr 数据块的统一处理入口（净化 → 落盘 → 滚动缓冲 → 转发）
	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// 净化：去 ANSI 转义、替换二进制乱码、统一换行（\r 归一为 \n 前先剥掉）
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// 累计字节超过阈值时开始写入临时文件
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// 维护内存滚动缓冲：超限后从头丢弃最旧的块（至少保留 1 块）
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// 同步流式转发给回调（UI 实时显示）
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	// 真正执行命令；exec 后端负责把 onData 绑定到进程输出、并响应 signal 取消
	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		// 内存缓冲被滚动丢弃过（totalBytes 超限）但临时文件尚未创建时，补建并落盘
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
		}
		// exec 正常返回也可能是因为 signal 已触发，此处再核对一次
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			// 取消时不报退出码：进程是被杀掉的，退出码无意义
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// 先判断是否为用户主动取消（abort），取消走正常返回而非抛错
		if (options?.signal?.aborted) {
			// 取消路径也要产出与正常路径一致的截断/落盘结果
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			if (tempFileStream) {
				tempFileStream.end();
			}
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		// 非取消的真实错误：收尾文件流后原样抛出，交给调用方处理
		if (tempFileStream) {
			tempFileStream.end();
		}

		throw err;
	}
}
