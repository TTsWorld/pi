/**
 * @file harness 层核心类型定义
 * @description 定义有状态 LLM Agent 运行时 harness 层所依赖的类型：显式错误返回风格的
 * `Result`/`ok`/`err`（预期失败不靠 throw）、`Skill`/`PromptTemplate` 等资源类型、
 * `AgentHarnessTool`（execute 额外接收按 turn 快照解析的 context）、`ExecutionEnv` 能力
 * 接口（= FileSystem + Shell，工具只依赖它而非直接使用 node:fs，从而使执行环境可替换），
 * 以及 `FileError`/`ExecutionError`/`CompactionError` 等后端无关的错误类型。
 */
import type { SimpleStreamOptions, Transport } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "../types.ts";

/** 可能失败操作的返回结果。预期内的失败以 `ok: false` 形式返回，而不是抛出异常。 */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** 创建一个成功的 {@link Result}。 */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
	return { ok: true, value };
}

/** 创建一个失败的 {@link Result}。 */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
	return { ok: false, error };
}

/** 返回成功值，否则抛出失败错误。用于测试以及显式的适配层边界。 */
export function getOrThrow<TValue, TError>(result: Result<TValue, TError>): TValue {
	if (!result.ok) throw result.error;
	return result.value;
}

/** 返回成功值或 `undefined`。仅允许对象类型的值，以避免对原始值做真值判断（truthiness）引入的 bug。 */
export function getOrUndefined<TValue extends object, TError>(result: Result<TValue, TError>): TValue | undefined {
	return result.ok ? result.value : undefined;
}

/** 把未知的抛出值规范化为 Error 实例，便于后续作为类型化错误的 cause 使用。 */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	// 其余值优先 JSON 序列化（可能因循环引用等抛错），失败时退回 String()
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/**
 * 从 `SKILL.md` 文件加载、或由应用直接提供的技能（Skill）。
 *
 * `name`、`description` 与 `filePath` 会按 agentskills.io 的建议，以 XML 格式块的形式插入系统提示词。
 * 可使用 {@link formatSkillsForSystemPrompt} 生成符合该规范的系统提示词块。
 */
export interface Skill {
	/** 稳定的技能名称，用于查找以及模型可见的技能列表展示。 */
	name: string;
	/** 简短的、模型可见的技能使用时机描述。 */
	description: string;
	/** 完整的技能指令内容。 */
	content: string;
	/** 技能文件的绝对路径。用于模型可见的位置展示以及解析相对路径引用。 */
	filePath: string;
	/** 把该技能从模型可见的技能列表中排除，但仍允许应用显式调用。 */
	disableModelInvocation?: boolean;
}

/** 提示词模板，可被格式化为完整提示词以供显式调用。 */
export interface PromptTemplate {
	/** 稳定的模板名称，用于查找或应用层的命令路由。 */
	name: string;
	/** 可选描述，用于命令列表或自动补全。 */
	description?: string;
	/** 模板内容。其中的参数占位符由 `formatPromptTemplateInvocation` 负责格式化。 */
	content: string;
}

/** 提供给显式调用方法与系统提示词回调使用的资源集合。 */
export interface AgentHarnessResources<
	TSkill extends Skill = Skill,
	TPromptTemplate extends PromptTemplate = PromptTemplate,
> {
	/** 可供显式调用的提示词模板。 */
	promptTemplates?: TPromptTemplate[];
	/** 供模型自动调用以及供显式技能调用的技能列表。 */
	skills?: TSkill[];
}

/**
 * 由 {@link AgentHarness} 执行的工具定义，携带应用自定义的 context。
 *
 * 在 {@link AgentTool} 基础上重写了 `execute` 签名：额外接收一个按当前 turn 快照解析出的 context 参数。
 */
export type AgentHarnessTool<
	TContext extends object | undefined,
	TParameters extends TSchema = TSchema,
	TDetails = unknown,
> = Omit<AgentTool<TParameters, TDetails>, "execute"> & {
	/** 执行工具调用，context 为按当前 turn 快照解析出的上下文。 */
	execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		context: TContext,
	): Promise<AgentToolResult<TDetails>>;
};

/** 静态的工具 context，或按每个 turn 快照解析的无参 provider（支持返回 Promise）。 */
export type AgentHarnessToolContextSource<TContext extends object | undefined> =
	| TContext
	| (() => TContext | Promise<TContext>);

/** 由 harness 持有的精选 provider 请求选项，按 turn 做快照。 */
export interface AgentHarnessStreamOptions {
	/** 首选 transport，透传给流式请求函数。 */
	transport?: Transport;
	/** provider 请求超时时间（毫秒）。 */
	timeoutMs?: number;
	/** provider 最大重试次数。 */
	maxRetries?: number;
	/** 可选的 provider 侧重试延迟上限。 */
	maxRetryDelayMs?: number;
	/** 额外的请求头，会与鉴权及生命周期相关的请求头合并。 */
	headers?: Record<string, string>;
	/** 随请求透传的 provider metadata。 */
	metadata?: SimpleStreamOptions["metadata"];
	/** provider 缓存保留策略提示。 */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

/** provider 钩子返回的按请求粒度的流选项补丁（patch）。 */
export interface AgentHarnessStreamOptionsPatch
	extends Omit<Partial<AgentHarnessStreamOptions>, "headers" | "metadata"> {
	/** 请求头补丁。值为 `undefined` 的键会被删除；显式传 `headers: undefined` 则清空全部请求头。 */
	headers?: Record<string, string | undefined>;
	/** metadata 补丁。值为 `undefined` 的键会被删除；显式传 `metadata: undefined` 则清空全部 metadata。 */
	metadata?: Record<string, unknown | undefined>;
}

/** {@link FileSystem} 所寻址的文件系统对象类型。符号链接不会被自动跟随。 */
export type FileKind = "file" | "directory" | "symlink";

/** {@link FileSystem} 文件操作返回的错误码，稳定且与后端实现无关。 */
export type FileErrorCode =
	| "aborted"
	| "not_found"
	| "permission_denied"
	| "not_directory"
	| "is_directory"
	| "invalid"
	| "not_supported"
	| "unknown";

/** {@link FileSystem} 文件操作返回的错误对象。 */
export class FileError extends Error {
	/** 与后端无关的错误码。 */
	public code: FileErrorCode;
	/** 与本次失败关联的绝对寻址路径（如可用）。 */
	public path?: string;

	/**
	 * @param code 后端无关的错误码
	 * @param message 人类可读的错误信息
	 * @param path 关联失败的绝对路径（可选）
	 * @param cause 原始错误，作为 Error cause 传入（可选）
	 */
	constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "FileError";
		this.code = code;
		this.path = path;
	}
}

/** {@link ExecutionEnv.exec} 返回的错误码，稳定且与后端实现无关。 */
export type ExecutionErrorCode =
	| "aborted"
	| "timeout"
	| "shell_unavailable"
	| "spawn_error"
	| "callback_error"
	| "unknown";

/** {@link ExecutionEnv.exec} 返回的错误对象。 */
export class ExecutionError extends Error {
	/** 与后端无关的错误码。 */
	public code: ExecutionErrorCode;

	/**
	 * @param code 后端无关的错误码
	 * @param message 人类可读的错误信息
	 * @param cause 原始错误，作为 Error cause 传入（可选）
	 */
	constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ExecutionError";
		this.code = code;
	}
}

/** 压缩（compaction）辅助函数返回的错误码，稳定且与后端无关。 */
export type CompactionErrorCode = "aborted" | "summarization_failed";

/** 压缩（compaction）辅助函数返回的错误对象。 */
export class CompactionError extends Error {
	/** 与后端无关的错误码。 */
	public code: CompactionErrorCode;

	/**
	 * @param code 后端无关的错误码
	 * @param message 人类可读的错误信息
	 * @param cause 原始错误，作为 Error cause 传入（可选）
	 */
	constructor(code: CompactionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CompactionError";
		this.code = code;
	}
}

/** 分支摘要辅助函数返回的错误码，稳定且与后端无关。 */
export type BranchSummaryErrorCode = "aborted" | "summarization_failed";

/** 分支摘要辅助函数返回的错误对象。 */
export class BranchSummaryError extends Error {
	/** 与后端无关的错误码。 */
	public code: BranchSummaryErrorCode;

	/**
	 * @param code 后端无关的错误码
	 * @param message 人类可读的错误信息
	 * @param cause 原始错误，作为 Error cause 传入（可选）
	 */
	constructor(code: BranchSummaryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "BranchSummaryError";
		this.code = code;
	}
}

/** {@link FileSystem} 中单个文件系统对象的元数据。 */
export interface FileInfo {
	/** {@link path} 的 basename（路径的最后一段名称）。 */
	name: string;
	/** 执行环境中经语法规范化的绝对寻址路径。不跟随符号链接。 */
	path: string;
	/** 对象类型。不跟随符号链接目标；如需解析请显式使用 {@link FileSystem.canonicalPath}。 */
	kind: FileKind;
	/** 所寻址文件系统对象的大小（字节）。 */
	size: number;
	/** 修改时间，距 Unix epoch 的毫秒数。 */
	mtimeMs: number;
}

/**
 * harness 所依赖的文件系统能力接口。
 *
 * 传给各方法的路径可以是绝对路径，也可以是相对 {@link cwd} 的路径。文件操作返回的路径是文件系统命名空间中的
 * 寻址路径；除非由 {@link canonicalPath} 返回，否则不会经过符号链接规范化。
 *
 * 各操作方法绝不允许 throw 或 reject。所有文件系统失败（包括意料之外的后端失败）都必须编码进返回的
 * {@link Result} 中。实现方必须保持这一不变式。
 */
export interface FileSystem {
	/** 相对路径的基准工作目录。 */
	cwd: string;

	/** 返回绝对寻址路径：不要求路径存在，也不解析符号链接。 */
	absolutePath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 在文件系统命名空间中拼接路径片段，不要求结果存在。 */
	joinPath(parts: string[], abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 读取 UTF-8 文本文件。 */
	readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 按 UTF-8 逐行读取文本。实现应在读满 `maxLines` 行后停止。 */
	readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>>;
	/** 读取二进制文件。 */
	readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>>;
	/** 创建或覆盖文件；支持时自动创建父目录。 */
	writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** 创建文件或向已有文件追加内容；支持时自动创建父目录。 */
	appendFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** 原子地重命名文件，目标存在时会被替换。不支持跨文件系统复制。 */
	renameFile(sourcePath: string, destinationPath: string, abortSignal?: AbortSignal): Promise<Result<void, FileError>>;
	/** 返回所寻址路径的元数据，不跟随符号链接。 */
	fileInfo(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo, FileError>>;
	/** 列出目录的直接子项，不跟随符号链接。 */
	listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>>;
	/** 返回已存在路径的规范（canonical）路径，在支持的实现中解析符号链接。 */
	canonicalPath(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 路径不存在时返回 false；其他错误（如权限失败）以 {@link FileError} 形式返回。 */
	exists(path: string, abortSignal?: AbortSignal): Promise<Result<boolean, FileError>>;
	/** 创建目录。默认值：`recursive: true`、不传 abort signal。 */
	createDir(
		path: string,
		options?: { recursive?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** 删除文件或目录。默认值：`recursive: false`、`force: false`、不传 abort signal。 */
	remove(
		path: string,
		options?: { recursive?: boolean; force?: boolean; abortSignal?: AbortSignal },
	): Promise<Result<void, FileError>>;
	/** 创建临时目录并返回其绝对路径。默认值：`prefix: "tmp-"`、不传 abort signal。 */
	createTempDir(prefix?: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>>;
	/** 创建临时文件并返回其绝对路径。默认值：`prefix: ""`、`suffix: ""`、不传 abort signal。 */
	createTempFile(options?: {
		prefix?: string;
		suffix?: string;
		abortSignal?: AbortSignal;
	}): Promise<Result<string, FileError>>;

	/** 释放文件系统资源。必须尽力而为（best-effort），且不得 throw 或 reject。 */
	cleanup(): Promise<void>;
}

/** {@link Shell.exec} 的选项。 */
export interface ShellExecOptions {
	/** 命令的工作目录。相对路径按 {@link ExecutionEnv.cwd} 解析。默认为 {@link ExecutionEnv.cwd}。 */
	cwd?: string;
	/** 命令的环境变量。当 `inheritEnv` 为 true 时，这些值会覆盖继承到的默认值。 */
	env?: Record<string, string>;
	/** 是否继承执行环境的默认环境变量。默认为 true。 */
	inheritEnv?: boolean;
	/** 超时时间（秒）。命令超过该时长时，实现应返回超时错误。默认不超时。 */
	timeout?: number;
	/** 用于终止命令的 abort signal。默认不传。 */
	abortSignal?: AbortSignal;
	/** 每产生一段 stdout chunk 就会被调用。 */
	onStdout?: (chunk: string) => void;
	/** 每产生一段 stderr chunk 就会被调用。 */
	onStderr?: (chunk: string) => void;
}

/** harness 所依赖的 shell 执行能力接口。 */
export interface Shell {
	/** 执行 shell 命令，工作目录默认为 {@link FileSystem.cwd}，除非提供了 `options.cwd`。 */
	exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>>;
	/** 释放 shell 资源。必须尽力而为（best-effort），且不得 throw 或 reject。 */
	cleanup(): Promise<void>;
}

/**
 * harness 使用的文件系统与进程执行环境：能力接口 = FileSystem + Shell。
 *
 * 工具实现只依赖本接口而不直接使用 node:fs 等平台 API，从而使执行环境可以整体替换
 * （例如换成沙箱或远程环境）。
 */
export interface ExecutionEnv extends FileSystem, Shell {}
