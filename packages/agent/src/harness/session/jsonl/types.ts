/**
 * @file session/jsonl/types.ts —— JSONL 会话后端的支撑类型：文件系统抽象子集、
 * 仓库选项 / 会话元数据 / 创建与列表选项，以及 v4 header 行结构。
 *
 * @description
 * JSONL 后端把会话持久化为「一个会话一个 .jsonl 文件」：首行 header +
 * 逐行 mutation，行格式编解码见 ./codec.ts。版本兼容策略：本包只写 v4
 * 格式；{@link JsonlSessionMetadata}.sourceFormat 记录文件来源（3 = 由旧
 * v3 会话迁移而来，4 = 原生 v4），v3 的派生父路径无法解析成会话 id 时以
 * legacyParentSessionPath 原样保留（见 {@link JsonlV4Header} 的对应字段）。
 */
import type { FileSystem } from "../../types.ts";
import type { JsonValue, SessionCreateOptions, SessionMetadata } from "../types.ts";

/**
 * JSONL 仓库所需的文件系统操作子集：从 {@link FileSystem} 挑出读写 / 目录 /
 * 原子改名等能力。Why 用 Pick 而非全量接口：依赖最小化，便于注入内存实现
 * （测试）或不同运行时的适配层。
 */
export type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "renameFile"
	| "fileInfo"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

/** JSONL 仓库的构造选项。 */
export interface JsonlSessionRepoOptions {
	/** 注入的文件系统适配层（见 {@link JsonlSessionRepoFileSystem}）。 */
	fs: JsonlSessionRepoFileSystem;
	/** 会话根目录：其下是按 cwd 编码命名的会话目录（与 coding-agent 兼容，如 `--Users-foo-proj--`），每个会话一个 .jsonl 文件。 */
	sessionsRoot: string;
}

/**
 * JSONL 后端特化的会话元数据：在基础 {@link SessionMetadata} 之上补充文件
 * 定位信息与格式来源标记。
 */
export interface JsonlSessionMetadata extends SessionMetadata {
	/** 会话创建时的工作目录（决定其在 sessionsRoot 下的目录归属）。 */
	cwd: string;
	/** 会话 .jsonl 文件的路径。 */
	path: string;
	/** 文件修改时间（Unix 毫秒时间戳）。 */
	modifiedAt: number;
	/** 文件格式来源：3 = 由旧 v3 会话迁移而来，4 = 原生 v4（本包只产出 4）。 */
	sourceFormat: 3 | 4;
	/** 仅当 v3 的父会话路径无法解析出会话 id 时存在。 */
	legacyParentSessionPath?: string;
	/** 不透明的应用自有元数据（codec 只透传、不解释）。 */
	metadata?: Record<string, JsonValue>;
}

/** JSONL 后端特化的创建选项：须指定 cwd（用于目录编码）并可携带应用元数据。 */
export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	/** 会话所属的工作目录：决定会话文件在 sessionsRoot 下的目录归属。 */
	cwd: string;
	/** 不透明的应用自有元数据，创建时写入 header。 */
	metadata?: Record<string, JsonValue>;
}

/** 列表过滤选项：给定 cwd 时只列出该工作目录下的会话，缺省列出全部。 */
export interface JsonlSessionListOptions {
	/** 按工作目录过滤。 */
	cwd?: string;
}

/**
 * v4 会话文件的首行 header 结构（编码 / 解码见 ./codec.ts）。header 是文件
 * 唯一的「元数据行」，version 字段是整份文件格式的判别锚点。
 */
export interface JsonlV4Header {
	/** 行判别字段：标识本行是 header 而非 mutation。 */
	kind: "header";
	/** 格式版本号；codec 仅接受 4，其余版本整体拒读。 */
	version: 4;
	/** 会话 id。 */
	id: string;
	/** 创建时间（Unix 毫秒）。 */
	createdAt: number;
	/** 会话创建时的工作目录。 */
	cwd: string;
	/** 派生父会话 id（fork 来源；v3 父路径已成功解析时记录于此）。 */
	parentSessionId?: string;
	/** 仅当 v3 的父会话路径无法解析出会话 id 时原样保留。 */
	legacyParentSessionPath?: string;
	/** 不透明的应用自有元数据。 */
	metadata?: Record<string, JsonValue>;
}
