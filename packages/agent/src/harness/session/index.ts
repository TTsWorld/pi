/**
 * @file session/index.ts —— 会话持久化模块（session/）的统一出口。
 *
 * @description
 * 汇总导出本目录各层实现的公共面：types.ts（类型基石与 SessionError）、
 * session.ts（Session 门面 + assertJsonSerializable）、context.ts（由 entry
 * 分支构建 LLM 上下文）、memory.ts（内存版 SessionStorage）、jsonl.ts（JSONL
 * 文件后端仓库）。
 */

// 上下文构建：由 entry 树分支派生 messages 与生效配置
export * from "./context.ts";

// JSONL 文件后端：仅显式导出以下类型与仓库实现
export type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoFileSystem,
	JsonlSessionRepoOptions,
	JsonlV4Header,
} from "./jsonl.ts";
export { JsonlSessionRepo } from "./jsonl.ts";

// 内存实现（InMemorySessionStorage 等），供测试与临时会话使用
export * from "./memory.ts";

// Session 门面（含 assertJsonSerializable）
export * from "./session.ts";

// 类型基石：Entry / LaneRecord / SessionStorage / SessionTree / SessionRepo / SessionError
export * from "./types.ts";
