/**
 * @file output-guard.ts —— 非交互模式下对 stdout 的接管与还原
 *
 * @description
 * 非交互（JSON 流输出）模式下，把 process.stdout 劫持为重定向到 stderr，
 * 保证 stdout 上只剩 CLI 自己写出的纯净 JSON 事件流；
 * 同时提供一套带排队与背压重试的 writeRawStdout，用于绕过劫持直接写 stdout。
 */
interface StdoutTakeoverState {
	/** 接管前绑定的原始 stdout.write（绕过劫持直接写 stdout 用） */
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	/** 接管前绑定的原始 stderr.write */
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	/** 未被劫持的原始 stdout.write，用于还原 */
	originalStdoutWrite: typeof process.stdout.write;
}

let stdoutTakeoverState: StdoutTakeoverState | undefined;

/** stdout 缓冲区不足（ENOBUFS 等）时的重试间隔 */
const RAW_STDOUT_RETRY_DELAY_MS = 10;

/** raw stdout 写入任务的串行队列尾部：保证多次 writeRawStdout 严格按序落盘 */
let rawStdoutWriteTail: Promise<void> = Promise.resolve();

/** 取「当前可用的原始 stdout.write」：已接管时取状态里保存的，否则绑定当前实现 */
function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (stdoutTakeoverState) {
		return stdoutTakeoverState.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

/**
 * 向原始 stdout 写入一块文本；遇到 ENOBUFS / EAGAIN / EWOULDBLOCK 这类
 * 「缓冲区暂时不可写」错误时等待一小段时间后重试，其余错误直接抛出。
 */
async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

/**
 * 接管 stdout：把 process.stdout.write 重定向到 stderr 写出，
 * 防止扩展/工具的日志污染非交互模式下的 JSON 输出流。重复调用幂等。
 */
export function takeOverStdout(): void {
	if (stdoutTakeoverState) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	stdoutTakeoverState = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

/** 还原被接管的 stdout.write；未接管时为空操作 */
export function restoreStdout(): void {
	if (!stdoutTakeoverState) {
		return;
	}

	process.stdout.write = stdoutTakeoverState.originalStdoutWrite;
	stdoutTakeoverState = undefined;
}

/** 当前是否处于 stdout 接管状态 */
export function isStdoutTakenOver(): boolean {
	return stdoutTakeoverState !== undefined;
}

/**
 * 异步写入一段文本到原始 stdout（是否已接管皆可）。
 *
 * 写入被追加到串行队列尾部以保证顺序；一旦写入失败则以退出码 1 结束进程
 * （stdout 已损坏时继续运行没有意义）。
 */
export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}

/**
 * 等待串行队列中的所有写入完成（等待背压排空）。
 * 等待期间若有新写入追加进来，会继续等新的队列尾部，直到追平为止。
 */
export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = rawStdoutWriteTail;
		await tail;
		if (tail === rawStdoutWriteTail) {
			return;
		}
	}
}

/** 刷净 raw stdout：先等队列排空，再写一个空串确认底层写入链路已通畅 */
export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
