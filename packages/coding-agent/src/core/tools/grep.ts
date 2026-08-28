/**
 * @file grep.ts —— grep 内容搜索工具（基于 ripgrep）
 *
 * @description
 * 实现 coding-agent 的 `grep` 工具：按正则或字面字符串搜索文件内容，
 * 返回带文件路径与行号的匹配行，支持 glob 文件过滤、忽略大小写、
 * 上下文行（context）、匹配数上限等参数，遵循 .gitignore 规则。
 *
 * 主要功能点：
 * - 通过 `ensureTool("rg")` 保证 ripgrep 可用（本地缺失时自动下载），以
 *   `--json` 模式 spawn 子进程并逐行流式解析匹配事件；
 * - 命中数达到 limit 后提前 kill 子进程，避免继续无谓扫描；
 * - 输出三重截断保护：匹配数上限（默认 100）、总字节数上限、单行长度上限，
 *   并把截断原因写入 details 供 UI 渲染警告；
 * - TUI 渲染：formatGrepCall 格式化调用行，formatGrepResult 折叠展示结果
 *   并提示展开快捷键。
 *
 * 沙箱化设计：工具定义（definition）与实际 IO（GrepOperations）分离，
 * 默认实现走本地文件系统；宿主可注入自定义 operations 把文件读取/判断
 * 委托给远程系统（例如 SSH），工具逻辑本身保持不变。
 *
 * 依赖关系：
 * - `./path-utils.ts`：相对路径解析到工作目录；
 * - `./truncate.ts`：行/字节截断工具与常量；
 * - `../../utils/tools-manager.ts`：ripgrep 的查找与按需下载；
 * - `./render-utils.ts` / `../../modes/interactive/theme`：TUI 渲染辅助与配色。
 */
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

/** grep 工具的输入参数 schema（typebox 定义），同时用于入参校验与生成 LLM 可见的参数描述 */
const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

/** 注入到系统提示词的 grep 工具简介片段（snippet 一句话，guidelines 预留为空） */
export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
	guidelines: [],
} as const;

/** 由 schema 推导出的 grep 工具入参类型 */
export type GrepToolInput = Static<typeof grepSchema>;
/** 未显式指定 limit 时的默认最大匹配数 */
const DEFAULT_LIMIT = 100;

/**
 * grep 工具结果附带的元数据（不进入模型可见文本，仅供 UI 渲染截断警告）。
 */
export interface GrepToolDetails {
	/** 输出因总字节数超限被截断时的详细信息 */
	truncation?: TruncationResult;
	/** 匹配数达到 limit 上限时记录该上限值 */
	matchLimitReached?: number;
	/** 任一匹配行因超长被截断时置为 true */
	linesTruncated?: boolean;
}

/**
 * grep 工具的可插拔 IO 操作集合（沙箱化边界）。
 * 覆盖这些方法即可把搜索委托给远程系统（例如 SSH 上的文件读取），
 * 而不必改动工具本身的匹配与截断逻辑。
 */
export interface GrepOperations {
	/** 判断路径是否为目录。路径不存在时抛出异常（工具据此报 "Path not found"）。 */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** 读取文件全部内容（utf-8），用于获取匹配行的上下文行 */
	readFile: (absolutePath: string) => Promise<string> | string;
}

/** 默认 operations：直接使用本地文件系统（fs.stat / fs.readFile） */
const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

/** createGrepToolDefinition 的可选项 */
export interface GrepToolOptions {
	/** 自定义 IO 操作。默认：本地文件系统 + ripgrep */
	operations?: GrepOperations;
}

/**
 * 格式化 grep 工具调用在 TUI 中的显示行：`grep /pattern/ in path (glob) limit N`。
 * 参数缺失或非法时以 invalidArg 占位。
 */
function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

/**
 * 格式化 grep 工具结果在 TUI 中的显示：默认最多展示 15 行，超出部分提示
 * 可用展开快捷键查看全部；再根据 details 中的截断信息追加警告行。
 */
function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// ===== 截断警告：根据 details 中的三类截断原因拼出提示行 =====
	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

/**
 * 创建 grep 工具定义（ToolDefinition），包含 execute 执行逻辑与 TUI 渲染两部分。
 *
 * 工作原理：spawn ripgrep 子进程（--json 流式输出），逐行解析 match 事件；
 * 命中数达到 limit 时提前 kill 子进程。需要上下文行（context > 0）时通过
 * operations.readFile 读取文件；无上下文时直接复用 rg 输出的行文本，省一次读盘。
 *
 * @param cwd - 工作目录，相对的 path 参数会解析到该目录下
 * @param options - 可选自定义 operations（默认本地文件系统）
 */
export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			// 整个执行包装为 Promise：内部用 settle() 保证 resolve/reject 只触发一次
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						// ===== 准备阶段：确保 ripgrep 可用（本地缺失时触发下载） =====
						const rgPath = await ensureTool("rg");
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						// 把用户给的 path（缺省 "."）解析为基于 cwd 的绝对路径
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						// 参数归一化：context 非正数一律按 0（不取上下文行）处理；limit 至少为 1
						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						// rg 返回绝对路径；目录搜索时转为相对路径显示（更短、便于模型引用），
						// 相对化越界（".." 开头）或单文件搜索时退回仅保留文件名
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						// ===== 上下文行读取：按文件缓存拆分好的行数组，同一文件只读一次 =====
						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						// ===== 构造 rg 命令行参数 =====
						// --json 输出结构化事件流；--hidden 把隐藏文件纳入搜索（.gitignore 仍生效）；
						// 末尾的 "--" 分隔符防止以 "-" 开头的 pattern 被误认作选项
						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						// ===== 执行 rg 并流式消费输出 =====
						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						const outputLines: string[] = [];

						// cleanup 负责收尾（关 readline、摘除 abort 监听）；stopChild 杀子进程，
						// killedDueToLimit 标记「因命中上限被杀」，让 close 回调不误判为异常退出
						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// 取匹配行前后各 contextValue 行：匹配行用 "path:N:" 前缀，上下文行用 "path-N-"
						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// 截断超长行，保持 grep 输出紧凑。
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// 流式阶段只收集匹配，等 rg 退出后再统一格式化（也便于按 limit 提前停止）。
						const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						// spawn 层面失败（如 rg 无法执行）直接报错
						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						// rg 退出码约定：0=有匹配、1=无匹配，均属正常；其余码才是错误
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// 流式结束后才格式化匹配：自定义 readFile() 后端可能是异步的，不能在 line 回调里 await
							for (const match of matches) {
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = formatPath(match.filePath);
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber);
									outputLines.push(...block);
								}
							}

							const rawOutput = outputLines.join("\n");
							// 只做字节级截断，不限行数——匹配数上限已经控制了行数
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// 构造可操作的提示：引导模型加大 limit / 换用 read 工具查看完整行
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		// TUI：复用上次渲染的 Text 组件原地更新，避免闪烁
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatGrepResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

/**
 * 创建可直接注册到 AgentContext 的 grep AgentTool（对 ToolDefinition 的薄包装）。
 * @param cwd - 工作目录
 * @param options - 可选自定义 operations
 */
export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
