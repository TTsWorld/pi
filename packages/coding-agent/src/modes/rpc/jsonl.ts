/**
 * @file jsonl.ts —— JSONL（JSON Lines）帧读写辅助
 *
 * @description
 * 为 RPC 模式提供最底层的传输分帧能力：
 * - `serializeJsonLine`：把任意值序列化为「单行 JSON + \n」；
 * - `attachJsonlLineReader`：以严格 LF 分帧方式从可读流中逐行读取记录。
 *
 * RPC 进程的 stdin（命令流）与 stdout（响应/事件流）共用同一套分帧语义，
 * 本模块保证两侧对「什么算一行」的判定完全一致。
 */

import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * 将单个值序列化为一条严格的 JSONL 记录（单行 JSON + 换行符）。
 *
 * 分帧只认 LF：负载字符串里可能出现其他 Unicode 行分隔符
 * （如 U+2028、U+2029，它们在 JSON 字符串内是合法字符），
 * 因此客户端切分记录时必须且只能按 `\n` 拆行。
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * 为可读流挂接一个「只按 LF 分帧」的 JSONL 逐行读取器。
 *
 * 这里刻意不用 Node 内置 readline：readline 还会按若干额外的 Unicode
 * 分隔符切行，而这些字符在 JSON 字符串里是合法的，
 * 因此 readline 并不实现严格的 JSONL 分帧。
 */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	// 发出前剥掉行尾可能残留的 \r，以兼容 CRLF 客户端
	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	// 数据块到达时先入缓冲区；Buffer 一律经 StringDecoder 解码，
	// 避免多字节 UTF-8 字符恰好被 chunk 边界截断而产生乱码
	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		// 把缓冲区中所有已完整的行逐条发出；没有 \n 就等下一个 chunk
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	// 流结束：先冲出 decoder 里缓存的残留字节；
	// 若缓冲区还剩一段未以换行结尾的尾巴，也作为最后一行发出
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	// 返回卸载函数：移除两个监听器，停止读行
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
