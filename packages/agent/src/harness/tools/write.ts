/**
 * @file write 工具：整文件写入工具
 * @description `createWriteTool` 工厂产出符合 {@link AgentHarnessTool} 契约（typebox schema +
 * execute，见 ../types.ts）的 "write" 工具：将 content 全量写入 path 指向的文件（不存在则
 * 创建、已存在则覆盖，并自动创建父目录）。文件操作经由 {@link ExecutionToolContext} 的
 * ExecutionEnv 能力接口完成，不直接依赖 node:fs；写入由 ./file-mutation-queue.ts 按
 * canonical path 串行化，避免与并发的 edit/write 对同一文件的读改写互相覆盖。
 */
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/** write 工具的参数 schema：目标文件路径 + 要写入的完整内容。 */
const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** 由 {@link writeSchema} 推导出的 write 工具输入类型。 */
export type WriteToolInput = Static<typeof writeSchema>;

/**
 * 创建 "write" 工具：将内容整文件写入指定路径。
 *
 * 文件不存在时创建、已存在时整体覆盖（ExecutionEnv.writeFile 会自动创建父目录）。
 * 写入在 ./file-mutation-queue.ts 的写队列内按 canonical path 串行执行，与 edit 的
 * 「读取→匹配→写回」临界区互斥，避免同一文件被并发写坏。
 *
 * @template TContext 工具执行时接收的 context 类型，须兼容 {@link ExecutionToolContext}
 * @returns write 工具实例（details 恒为 undefined）
 */
export function createWriteTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof writeSchema,
	undefined
> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, signal, _onUpdate, { env }) {
			// 解析为绝对路径（归一化 Unicode 空格、剥离 "@" 前缀），同时作为写队列的排队键来源
			const absolutePath = await resolveToolPath(env, path, signal);
			// 写队列串行化（Why）：排队键为 canonical path，同一文件的并发写互斥，
			// 避免与 edit 的读改写临界区交错导致内容被过期版本覆盖
			return withFileMutationQueue(env, absolutePath, async () => {
				// 写盘前后都检查中止信号：排队等待期间被取消则不再落盘
				if (signal?.aborted) throw new Error("Operation aborted");
				// getOrThrow：失败时直接抛出 FileError（工具契约要求以异常方式报错）
				getOrThrow(await env.writeFile(absolutePath, content, signal));
				if (signal?.aborted) throw new Error("Operation aborted");
				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: undefined,
				};
			});
		},
	};
}
