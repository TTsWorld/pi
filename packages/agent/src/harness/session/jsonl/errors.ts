/**
 * @file session/jsonl/errors.ts —— JSONL 后端专用错误：行级解码错误与错误映射工具。
 *
 * @description
 * 定义 {@link JsonlDecodeError}（行解码失败，按 kind 区分语法 / 模式错误），
 * 并提供两个错误构造工具：{@link fileResult} 把文件系统 Result 失败映射为
 * {@link SessionError}，{@link invalidFile} 生成带路径与行号的「会话文件
 * 损坏」错误。三者是 ./storage.ts 与 ./codec.ts 报错语义的统一出口。
 */
import type { FileError, Result } from "../../types.ts";
import { SessionError } from "../types.ts";

/**
 * JSONL 单行解码错误：kind = "syntax" 表示该行不是合法 JSON（崩溃半写的典型
 * 形态，可能是可修复的 torn tail）；kind = "schema" 表示 JSON 合法但不符合
 * v4 会话模式（header / mutation 的结构或字段不合法）。
 */
export class JsonlDecodeError extends Error {
	/** 错误类别：语法错误 / 模式（schema）错误。 */
	readonly kind: "syntax" | "schema";

	constructor(kind: "syntax" | "schema", message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "JsonlDecodeError";
		this.kind = kind;
	}
}

/**
 * 解包文件系统 Result：失败时把 {@link FileError} 转换为 {@link SessionError}
 * 抛出——"not_found" 原样透传（供上层区分「会话 / 文件不存在」），其余错误码
 * 一律归为 "storage"（底层存储错误）；message 作为前缀与原始信息拼接，原始
 * 错误经 cause 保留。
 *
 * @param result 文件操作的 Result 包装值。
 * @param message 失败时拼接在原始错误信息前的上下文描述（通常含路径）。
 * @returns 成功分支携带的值。
 * @throws result 失败时抛出 SessionError（code 为 "not_found" 或 "storage"）。
 */
export function fileResult<T>(result: Result<T, FileError>, message: string): T {
	if (!result.ok) {
		throw new SessionError(
			result.error.code === "not_found" ? "not_found" : "storage",
			`${message}: ${result.error.message}`,
			result.error,
		);
	}
	return result.value;
}

/**
 * 构造「会话文件损坏」错误：code 固定为 "invalid_entry"，message 内嵌文件
 * 路径、出错行号（1 起始，1 即 header 行）与原因描述，原始错误经 cause 透传。
 *
 * @param path 会话文件路径。
 * @param line 出错物理行号（1 起始）。
 * @param cause 行级解析 / 重放失败的原始错误。
 * @returns 可直接 throw 的 SessionError。
 */
export function invalidFile(path: string, line: number, cause: Error): SessionError {
	return new SessionError("invalid_entry", `Invalid JSONL v4 session ${path}: line ${line} ${cause.message}`, cause);
}
