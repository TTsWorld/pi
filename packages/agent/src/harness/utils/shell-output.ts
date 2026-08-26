/**
 * @file shell 输出的流式捕获工具。
 *
 * @description 提供 {@link executeShellWithCapture}：在 shell 命令执行过程中流式捕获
 * stdout/stderr，实时维护「尾部缓冲」与行/字节统计，并在输出超出限制时把完整输出落盘到
 * 临时文件。bash 工具借助它实现「边执行边产出输出」，而不是等命令跑完后一次性返回。
 */
import { type ExecutionEnv, ExecutionError, err, ok, type Result, type ShellExecOptions, toError } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

/** 捕获过程中的瞬时进度快照，每收到一段输出（或命令结束）都会生成一份，供调用方增量展示。 */
export interface ShellCaptureProgress {
	/** 展示用输出：未超限时为尾部缓冲原文，超限时为截断后的尾部内容（保尾部——错误与最终结果通常在末尾）。 */
	output: string;
	/** 截断详情（是否截断、依据什么截断、总行数/总字节数等）。 */
	truncation: TruncationResult;
	/** 完整输出临时文件的路径；仅在输出超限并触发落盘后存在。 */
	fullOutputPath?: string;
	/** 当前「尚未换行的半开行」已累计的字节数，可用于检测单行超长输出（如进度条、无换行日志）。 */
	lastLineBytes: number;
}

/**
 * {@link executeShellWithCapture} 的选项。
 *
 * 继承 {@link ShellExecOptions}，但去掉 `onStdout`/`onStderr`——两条流在本模块内部
 * 合并处理，统一通过 `onChunk` 暴露给调用方。
 */
export interface ShellCaptureOptions extends Omit<ShellExecOptions, "onStdout" | "onStderr"> {
	/**
	 * 每收到一段（已清洗的）输出时回调。`getProgress` 惰性生成进度快照，
	 * 调用方需要时再取，避免不消费进度的场景白白支付快照开销。
	 */
	onChunk?: (chunk: string, getProgress: () => ShellCaptureProgress) => void;
	/** 为 true 时，shell 执行失败不再以失败 Result（err）返回，而是连同已捕获的输出一起作为 ok 结果（`executionError` 字段）返回。 */
	returnExecutionErrors?: boolean;
}

/** 捕获的最终结果：末尾进度快照 + 命令执行状态。 */
export interface ShellCaptureResult extends ShellCaptureProgress {
	/** 子进程 exit code；被取消（cancelled）时为 undefined。 */
	exitCode: number | undefined;
	/** 命令是否因 abort signal 被取消。 */
	cancelled: boolean;
	/** 输出是否超限（触发了行数/字节截断或完整输出落盘）。 */
	truncated: boolean;
	/** 仅当 `returnExecutionErrors` 为 true 且执行失败时存在，携带执行错误。 */
	executionError?: ExecutionError;
}

/** 把任意抛出的值归一化为 {@link ExecutionError}：已是该类型则原样透传，其余以 code 为 "unknown" 包装。 */
function toExecutionError(error: unknown): ExecutionError {
	if (error instanceof ExecutionError) return error;
	const cause = toError(error);
	return new ExecutionError("unknown", cause.message, cause);
}

/**
 * 清洗可能混有二进制内容的输出，剔除不适合展示的控制字符。
 *
 * 保留 \t（0x09）、\n（0x0a）、\r（0x0d）——换行与缩进对文本有意义（\r 随后在
 * onChunk 中统一删除）；剔除其余 C0 控制字符（0x00–0x1f）以及 U+FFF9–U+FFFB
 * （interlinear annotation 注释锚点字符）。用 `Array.from` 按码位（而非 UTF-16
 * 码元）遍历，避免把代理对拆开。
 */
export function sanitizeBinaryOutput(str: string): string {
	return Array.from(str)
		.filter((char) => {
			const code = char.codePointAt(0);
			if (code === undefined) return false;
			if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
			if (code <= 0x1f) return false;
			if (code >= 0xfff9 && code <= 0xfffb) return false;
			return true;
		})
		.join("");
}

/**
 * 只保留字符串 UTF-8 编码后的最后 `maxBytes` 个字节。
 *
 * Why：尾部缓冲必须封顶，否则长输出会无限占用内存；保尾部是因为错误信息与命令
 * 最终结果通常在末尾。若切割点恰好落在多字节字符中间，向后跳过所有续字节
 * （UTF-8 续字节均为 `10xxxxxx`，即 `& 0xc0 === 0x80`），避免解码出乱码。
 */
function trimToLastUtf8Bytes(text: string, maxBytes: number, encoder: { encode(input?: string): Uint8Array }): string {
	const bytes = encoder.encode(text);
	if (bytes.byteLength <= maxBytes) return text;
	let start = bytes.byteLength - maxBytes;
	while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
	return new TextDecoder().decode(bytes.subarray(start));
}

/**
 * 执行 shell 命令并流式捕获 stdout/stderr。
 *
 * 两条流共用同一个 chunk 处理器，按实际到达顺序交织合并（而不是先 stdout 后
 * stderr），更贴近终端里的真实输出顺序。输出保存在两处：内存中的尾部缓冲（上限为
 * 默认截断上限的 2 倍）用于实时展示；一旦超出行数/字节限制，再把完整输出写入
 * 临时文件供事后查看。
 *
 * @param env 执行环境，提供 shell 与文件系统能力（完整输出落盘依赖它）。
 * @param command 要执行的 shell 命令。
 * @param options 捕获选项（进度回调、执行错误的返回方式等），见 {@link ShellCaptureOptions}。
 * @returns 成功时返回捕获结果（含 exit code 与截断信息），失败时返回 {@link ExecutionError}。
 *   注意区分两类失败：「命令执行失败」默认走 err（除非 `returnExecutionErrors` 为 true）；
 *   「捕获过程失败」（如临时文件写入失败、回调抛异常）总是走 err。
 */
export async function executeShellWithCapture(
	env: ExecutionEnv,
	command: string,
	options?: ShellCaptureOptions,
): Promise<Result<ShellCaptureResult, ExecutionError>> {
	// ========== 捕获状态 ==========
	// 内存中的「尾部缓冲」，只保留最近约 maxOutputBytes 字节；展示用输出从这里截取
	let tailOutput = "";
	// 缓冲上限取默认截断上限（DEFAULT_MAX_BYTES）的 2 倍：保证截断时缓冲里也凑得出足额的尾部内容
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;
	const encoder = new TextEncoder();

	let totalBytes = 0; // 累计输出的总字节数（判定超限、生成截断信息用）
	let completedLines = 0; // 已收到的完整行数（以 \n 计）
	let hasOpenLine = false; // 是否存在「已收到但尚未换行」的半开行
	let currentLineBytes = 0; // 当前半开行已累计的字节数（即进度快照里的 lastLineBytes）
	let fullOutputPath: string | undefined; // 完整输出临时文件路径；落盘启动后由写链异步赋值
	let fullOutputRequested = false; // 是否已请求落盘（含文件尚在创建中的窗口期），防止重复创建
	let acceptingOutput = true; // 是否还接受输出 chunk；exec 结束后置 false，阻止迟到的回调再改动状态
	// 串行化临时文件写入的 Promise 链：写入顺序即 chunk 到达顺序，且不会并发写同一文件；
	// 链上任何一步失败，后续步骤都短路返回同一个错误
	let writeChain: Promise<Result<void, ExecutionError>> = Promise.resolve(ok(undefined));
	let captureError: ExecutionError | undefined; // onChunk 处理中抛出的异常，先记下、收尾时统一上报

	// ========== 完整输出落盘与进度快照 ==========
	/** 把新一段输出追加到完整输出文件（经 writeChain 排队，保证写入顺序）。 */
	const appendFullOutput = (text: string): void => {
		// 未启动落盘、或此前已捕获到错误时，不再排队写入
		if (!fullOutputRequested || captureError) return;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous; // 链上已有失败，短路
			if (!fullOutputPath) return err(new ExecutionError("unknown", "Full output path was not created"));
			const appendResult = await env.appendFile(fullOutputPath, text);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	/**
	 * 首次超限时启动落盘：创建临时文件，并把「到目前为止的尾部缓冲」作为初始内容写入；
	 * 之后的 chunk 再增量追加。触发时累计输出刚越过限制，而尾部缓冲上限是它的 2 倍、
	 * 尚未被裁剪，因此初始内容即启动前的完整输出。
	 * 同步置位 fullOutputRequested，避免在文件异步创建完成前重复触发。
	 */
	const ensureFullOutputFile = (initialContent: string): void => {
		if (fullOutputRequested || captureError) return;
		fullOutputRequested = true;
		writeChain = writeChain.then(async (previous) => {
			if (!previous.ok) return previous;
			const tempFile = await env.createTempFile({ prefix: "bash-", suffix: ".log" });
			if (!tempFile.ok) return err(toExecutionError(tempFile.error));
			fullOutputPath = tempFile.value; // 路径在此异步赋值，最终结果须等 writeChain 落定后再生成
			const appendResult = await env.appendFile(tempFile.value, initialContent);
			return appendResult.ok ? ok(undefined) : err(toExecutionError(appendResult.error));
		});
	};

	/** 生成一份进度快照：对尾部缓冲做截断，并结合全局累计统计得出最终截断信息。 */
	const createProgress = (): ShellCaptureProgress => {
		const tailTruncation = truncateTail(tailOutput);
		// 总行数 = 完整行数 + 未闭合的半开行（若有）
		const totalLines = completedLines + (hasOpenLine ? 1 : 0);
		// 是否超限以「全局累计值」判定，而非只看缓冲本身（缓冲被裁剪后可能已小于上限）
		const truncated = totalLines > DEFAULT_MAX_LINES || totalBytes > DEFAULT_MAX_BYTES;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			// 截断原因：优先采用尾部截断给出的原因；否则按累计值推断（先看字节、再看行数）
			truncatedBy: truncated
				? (tailTruncation.truncatedBy ?? (totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines"))
				: null,
			totalLines,
			totalBytes,
		};
		return {
			// 未超限时原样返回尾部缓冲；超限时返回截断后的内容
			output: truncated ? truncation.content : tailOutput,
			truncation,
			fullOutputPath,
			lastLineBytes: currentLineBytes,
		};
	};

	// ========== 输出 chunk 处理（stdout 与 stderr 共用同一个处理器） ==========
	// 由底层 exec 在每段输出到达时同步调用；在此完成清洗、统计、缓冲维护与落盘分流，
	// 最后把「本段文本 + 惰性进度函数」交给调用方的 onChunk——此时状态已更新完毕，
	// 调用方取到的快照一定包含本段输出。
	const onChunk = (chunk: string): void => {
		if (!acceptingOutput) return;
		try {
			// 清洗控制字符，并统一删除 \r（Windows CRLF 换行与终端进度条都会产生它）
			const text = sanitizeBinaryOutput(chunk).replace(/\r/g, "");
			const textBytes = encoder.encode(text).byteLength;
			totalBytes += textBytes;
			const newlineCount = text.split("\n").length - 1;
			completedLines += newlineCount;
			// 维护「半开行」状态：本段含换行时，最后一个换行之后的部分开启新的半开行
			//（字节重新起算）；不含换行时，本段字节数累加到当前半开行上。
			const lastNewline = text.lastIndexOf("\n");
			if (lastNewline >= 0) {
				const trailingText = text.slice(lastNewline + 1);
				currentLineBytes = encoder.encode(trailingText).byteLength;
				hasOpenLine = trailingText.length > 0;
			} else if (text.length > 0) {
				currentLineBytes += textBytes;
				hasOpenLine = true;
			}

			tailOutput += text;
			const totalLines = completedLines + (hasOpenLine ? 1 : 0);
			// 落盘分流：累计输出一旦超限，先启动落盘（初始内容为当前全部缓冲）；
			// 此后每段增量追加到文件
			if ((totalBytes > DEFAULT_MAX_BYTES || totalLines > DEFAULT_MAX_LINES) && !fullOutputRequested) {
				ensureFullOutputFile(tailOutput);
			} else if (fullOutputRequested) {
				appendFullOutput(text);
			}
			// 注意顺序：先落盘再裁剪缓冲，保证落盘的初始内容在被裁剪前已完整带走
			tailOutput = trimToLastUtf8Bytes(tailOutput, maxOutputBytes, encoder);
			options?.onChunk?.(text, createProgress);
		} catch (error) {
			// 这里抛出的异常（如调用方回调 throw）不能打断底层流处理：先记下，
			// 等 exec 结束后作为 err 统一返回
			captureError = toExecutionError(error);
		}
	};

	// ========== 执行命令与收尾 ==========
	try {
		// stdout / stderr 指向同一个处理器：按到达顺序交织合并
		const result = await env.exec(command, {
			cwd: options?.cwd,
			env: options?.env,
			inheritEnv: options?.inheritEnv,
			timeout: options?.timeout,
			abortSignal: options?.abortSignal,
			onStdout: onChunk,
			onStderr: onChunk,
		});
		acceptingOutput = false; // 命令已结束，忽略之后可能迟到的 chunk
		let progress = createProgress();
		// 兜底：若直到命令结束才刚好越限（chunk 处理中没触发过落盘），此时补启落盘
		if (progress.truncation.truncated && !fullOutputRequested) ensureFullOutputFile(tailOutput);
		// 等所有排队写盘完成后再返回：既保证 fullOutputPath 已就绪，也让写失败得以在此上报
		const writeResult = await writeChain;
		if (!writeResult.ok) return err(writeResult.error);
		if (captureError) return err(captureError);
		// 重新生成快照：fullOutputPath 是在写链中异步赋值的，之前的快照可能缺该字段
		progress = createProgress();

		if (!result.ok) {
			// 取消路径：视为「正常结束但被取消」，此时 exit code 无意义（undefined），
			// 仍返回 ok，让调用方拿到已捕获的输出
			if (result.error.code === "aborted" || options?.abortSignal?.aborted) {
				return ok({
					...progress,
					exitCode: undefined,
					cancelled: true,
					truncated: progress.truncation.truncated,
				});
			}
			// 执行失败路径：按选项决定是把失败连同已捕获的输出一起作为 ok 返回
			// （便于向用户展示输出与错误），还是仅返回 err
			if (options?.returnExecutionErrors) {
				return ok({
					...progress,
					exitCode: undefined,
					cancelled: false,
					truncated: progress.truncation.truncated,
					executionError: result.error,
				});
			}
			return err(result.error);
		}
		// 成功路径：若命令结束后 abort signal 才置位，也按取消处理（此时 exit code 不可信）
		const cancelled = options?.abortSignal?.aborted ?? false;
		return ok({
			...progress,
			exitCode: cancelled ? undefined : result.value.exitCode,
			cancelled,
			truncated: progress.truncation.truncated,
		});
	} catch (error) {
		// env.exec 本身抛异常（而非返回 err）的路径：停止接收输出，归一化后返回 err
		acceptingOutput = false;
		return err(toExecutionError(error));
	}
}
