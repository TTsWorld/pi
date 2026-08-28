/**
 * @file ls.ts —— ls 内置工具：列出目录内容
 *
 * @description
 * 实现终端 AI 编码助手的 `ls` 工具：列出指定目录（默认当前目录）下的
 * 全部条目（含点文件），按字母序（大小写不敏感）排序，目录条目加 `/`
 * 后缀标识。输出受双重限制：条目数上限（默认 500）与字节上限（默认 50KB），
 * 超限时在结果末尾追加引导提示（如「用 limit=1000 获取更多」）。
 *
 * 依赖关系：
 * - `./truncate.ts`：字节截断（truncateHead）与体积格式化（formatSize）；
 * - `./path-utils.ts`：路径存在性检查与基于 cwd 的绝对路径解析；
 * - `./render-utils.ts` / TUI 主题：紧凑/展开两种结果渲染。
 * 目录访问通过 LsOperations 接口抽象，便于沙箱或远程（如 SSH）替换实现。
 */

import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import nodePath from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** ls 工具的输入参数 schema（typebox 定义） */
const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

/** ls 工具对系统提示词的贡献片段（snippet 一句话；ls 无额外守则） */
export const lsToolSystemPromptContribution = {
	snippet: "List directory contents",
	guidelines: [],
} as const;

/** 由 lsSchema 推导出的工具输入类型 */
export type LsToolInput = Static<typeof lsSchema>;

/** 默认返回的目录条目数上限 */
const DEFAULT_LIMIT = 500;

/** ls 工具结果附带的元信息（截断统计与条目数上限，供 TUI 渲染警告用） */
export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * ls 工具的可插拔目录操作集。
 * 覆盖这些方法即可把目录列举委托给远程系统（例如 SSH）。
 */
export interface LsOperations {
	/** 检查路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 获取文件/目录元信息。不存在时抛错。 */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** 读取目录条目名列表 */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

/** 默认实现：直接访问本地文件系统 */
const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

/** ls 工具的可配置项 */
export interface LsToolOptions {
	/** 自定义目录列举操作。默认：本地文件系统 */
	operations?: LsOperations;
}

/** 渲染 ls 调用行：`ls <路径>`，路径为空时显示 `.`，带 limit 时附上限 */
function formatLsCall(args: { path?: string; limit?: number } | undefined, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${pathDisplay}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

/**
 * 渲染 ls 结果：条目列表预览（紧凑模式最多 20 行）+ 截断警告。
 * 警告区分两种原因：条目数上限、字节上限。
 */
function formatLsResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: LsToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		// 展开时显示全部行；紧凑模式只显示前 20 行
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// ===== 截断警告：条目数上限与字节上限可能同时命中 =====
	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation;
	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

/**
 * 创建 ls 工具的 ToolDefinition（含执行逻辑与 TUI 渲染）。
 *
 * @param cwd - 工作目录，path 参数缺省时列出该目录
 * @param options - 可替换的目录操作集
 * @returns 可被 wrapToolDefinition 包装为 AgentTool 的工具定义
 */
export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "ls",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			// 手写 Promise：为了在 abort 事件发生时立刻 reject（与 read 工具同款模式）
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				const onAbort = () => reject(new Error("Operation aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						// path 缺省（空串或 undefined）时列出当前目录
						const dirPath = resolveToCwd(path || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// 检查路径是否存在。
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`Path not found: ${dirPath}`));
							return;
						}

						// 检查路径是否为目录。
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`Not a directory: ${dirPath}`));
							return;
						}

						// 读取目录条目。
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`Cannot read directory: ${e.message}`));
							return;
						}

						// 按字母序排序，大小写不敏感。
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// ===== 逐条格式化：目录加 `/` 后缀，stat 失败的条目直接跳过 =====
						const results: string[] = [];
						let entryLimitReached = false;
						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";
							try {
								const entryStat = await ops.stat(fullPath);
								if (entryStat.isDirectory()) suffix = "/";
							} catch {
								// 跳过无法 stat 的条目（如权限不足或已被并发删除）。
								continue;
							}
							results.push(entry + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "(empty directory)" }], details: undefined });
							return;
						}

						const rawOutput = results.join("\n");
						// 应用字节截断。行数上限设为最大安全整数：条目数已被 limit 封顶，
						// 无需再用行数限制。
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// 构造可操作的截断/条目上限提示。
						const notices: string[] = [];
						if (entryLimitReached) {
							// 引导模型把 limit 翻倍来获取更多条目
							notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
							details.entryLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						// details 为空对象时归一化为 undefined，避免携带无意义元信息
						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		// 渲染调用行：复用 lastComponent 减少 TUI 组件重建
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatLsCall(args, theme, context.cwd));
			return text;
		},
		// 渲染结果：条目列表预览 + 截断警告
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatLsResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

/** 便捷封装：直接创建可注册到 Agent 的 ls AgentTool */
export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
