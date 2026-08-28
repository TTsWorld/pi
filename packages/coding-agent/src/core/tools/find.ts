/**
 * @file find.ts —— find 文件查找工具（基于 fd）
 *
 * @description
 * 实现 coding-agent 的 `find` 工具：按 glob 模式（如 '*.ts'、'src/**\/*.spec.ts'）
 * 查找文件，返回相对搜索目录的路径列表。遵循 .gitignore 规则，默认最多
 * 返回 1000 条结果，超限时提示加大 limit 或收窄 pattern。
 *
 * 主要功能点：
 * - 通过 `ensureTool("fd")` 保证 fd 可用（本地缺失时自动下载），以 --glob
 *   模式 spawn 子进程并逐行收集结果；
 * - 两条执行路径：注入自定义 operations.glob 时走自定义后端（可对接远程
 *   系统），否则走本地 fd 子进程；
 * - 模式修正：含 "/" 的 pattern 自动切换 --full-path 并补 "**\/" 前缀；
 *   Windows 上再把 "/" 放宽为 [/\\] 以兼容原生分隔符；
 * - 结果相对化：统一转为相对搜索根目录的 posix 风格路径，保证输出稳定；
 * - 输出双重截断保护：结果数上限 + 总字节数上限，截断原因写入 details
 *   供 UI 渲染警告。
 *
 * 沙箱化设计：与 grep 相同，工具定义与 IO（FindOperations）分离，
 * 默认实现走本地文件系统 + fd。
 *
 * 依赖关系：
 * - `./path-utils.ts`：路径存在性检查与 cwd 解析；
 * - `./truncate.ts`：字节截断工具与常量；
 * - `../../utils/tools-manager.ts`：fd 的查找与按需下载；
 * - `./render-utils.ts` / `../../modes/interactive/theme`：TUI 渲染辅助与配色。
 */
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
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/**
 * 把 find 结果路径相对化到搜索根目录，并统一为 posix 分隔符（"/"）。
 * 绝对路径转为相对路径；相对路径原样保留；结尾分隔符（目录标记）会被还原，
 * 避免相对化过程中丢失「这是一个目录」的信息。
 *
 * @param resultPath - 待处理的匹配路径，绝对或相对均可
 * @param searchPath - 搜索根目录（绝对路径）
 * @param pathModule - 可注入的 path 实现（默认 node:path），便于测试平台特定行为
 */
export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: path.PlatformPath = path,
): string {
	// 记录结尾是否带分隔符（Windows 下输入里 / 和 \ 都可能出现）
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	// 仅绝对路径需要 relative()；随后把平台分隔符统一成 "/"
	const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(pathModule.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

/** find 工具的输入参数 schema（typebox 定义），同时用于入参校验与生成 LLM 可见的参数描述 */
const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

/** 注入到系统提示词的 find 工具简介片段（snippet 一句话，guidelines 预留为空） */
export const findToolSystemPromptContribution = {
	snippet: "Find files by glob pattern (respects .gitignore)",
	guidelines: [],
} as const;

/** 由 schema 推导出的 find 工具入参类型 */
export type FindToolInput = Static<typeof findSchema>;

/** 未显式指定 limit 时的默认最大结果数（比 grep 宽：单行路径很短） */
const DEFAULT_LIMIT = 1000;

/**
 * find 工具结果附带的元数据（不进入模型可见文本，仅供 UI 渲染截断警告）。
 */
export interface FindToolDetails {
	/** 输出因总字节数超限被截断时的详细信息 */
	truncation?: TruncationResult;
	/** 结果数达到 limit 上限时记录该上限值 */
	resultLimitReached?: number;
}

/**
 * find 工具的可插拔 IO 操作集合（沙箱化边界）。
 * 覆盖这些方法即可把文件查找委托给远程系统（例如 SSH），
 * 而不必改动工具本身的路径修正与截断逻辑。
 */
export interface FindOperations {
	/** 判断路径是否存在 */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** 按 glob 模式查找文件，返回相对或绝对路径 */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

/** 默认 operations：本地文件系统。glob() 只是占位——未注入自定义 glob 时，execute() 里直接跑 fd。 */
const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// 占位实现。真正的 fd 执行发生在 execute() 中（未提供自定义 glob 时）。
	glob: () => [],
};

/** createFindToolDefinition 的可选项 */
export interface FindToolOptions {
	/** 自定义 IO 操作。默认：本地文件系统 + fd */
	operations?: FindOperations;
}

/**
 * 格式化 find 工具调用在 TUI 中的显示行：`find pattern in path (limit N)`。
 * 参数缺失或非法时以 invalidArg 占位。
 */
function formatFindCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("find")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}

/**
 * 格式化 find 工具结果在 TUI 中的显示：默认最多展示 20 行，超出部分提示
 * 可用展开快捷键查看全部；再根据 details 中的截断信息追加警告行。
 */
function formatFindResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: FindToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	// ===== 截断警告：根据 details 中的截断原因拼出提示行 =====
	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

/**
 * 创建 find 工具定义（ToolDefinition），包含 execute 执行逻辑与 TUI 渲染两部分。
 *
 * 工作原理：优先使用注入的 operations.glob（自定义后端）；否则 spawn fd
 * 子进程（--glob 模式）逐行收集结果。两条路径的结果都经
 * relativizeFindResultPath 相对化后输出，并做结果数上限 + 字节数双重截断。
 *
 * @param cwd - 工作目录，相对的 path 参数会解析到该目录下
 * @param options - 可选自定义 operations（默认本地文件系统 + fd）
 */
export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			// 整个执行包装为 Promise：settle() 保证 resolve/reject 只触发一次，并同步摘除 abort 监听
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}

				let settled = false;
				// 由 fd 执行路径赋值：abort 时用来杀掉子进程
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						// 把用户给的 path（缺省 "."）解析为基于 cwd 的绝对路径
						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// ===== 路径一：自定义 operations 提供了 glob() 时，走自定义后端而非 fd =====
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							// 忽略 node_modules 与 .git，与 fd 默认行为保持一致
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							// 结果相对化到搜索根目录，保证输出稳定。
							const relativized = results.map((p) => relativizeFindResultPath(p, searchPath));
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`${effectiveLimit} results limit reached`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						// ===== 路径二：默认实现，spawn fd 子进程 =====
						const fdPath = await ensureTool("fd");
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						const args: string[] = ["--glob", "--color=never", "--hidden"];

						// fd 在 git 仓库之外默认忽略 .gitignore，因此该场景需要 --no-require-git
						// 让其生效。仓库内则保持 fd 默认的 git 感知行为，使父级 .gitignore
						// 规则在嵌套仓库边界处停止作用：
						// https://github.com/earendil-works/pi/issues/5960
						// 自底向上逐级查找 .git，判断搜索路径是否位于某个 git 仓库内
						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await pathExists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						if (!insideGitRepo) args.push("--no-require-git");
						args.push("--max-results", String(effectiveLimit));

						// fd --glob 默认只对文件名（basename）做匹配，设置 --full-path 后才匹配
						// 完整路径；此时像 'src/**\/*.spec.ts' 这类含路径的 pattern 必须补上
						// 前缀 '**\/' 才能匹配到任何结果。
						let effectivePattern = pattern;
						if (pattern.includes("/")) {
							args.push("--full-path");
							if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
								effectivePattern = `**/${pattern}`;
							}
							// Windows 上 fd 用原生分隔符匹配完整路径，故把 "/" 放宽为 [/\\]。
							if (process.platform === "win32")
								effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
						}
						args.push("--", effectivePattern, searchPath);

						// ===== 执行 fd 并逐行收集输出 =====
						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						// 供 onAbort 使用的停止函数：杀掉 fd 子进程
						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run fd: ${error.message}`)));
						});

						// fd 非零退出且无任何输出时视为错误；已有部分输出则继续走正常返回流程
						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							// 去掉行尾 \r、跳过空行后统一相对化
							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								relativized.push(relativizeFindResultPath(line, searchPath));
							}

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(
									`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		// TUI：复用上次渲染的 Text 组件原地更新，避免闪烁
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindCall(args, theme));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatFindResult(result as any, options, theme, context.showImages));
			return text;
		},
	};
}

/**
 * 创建可直接注册到 AgentContext 的 find AgentTool（对 ToolDefinition 的薄包装）。
 * @param cwd - 工作目录
 * @param options - 可选自定义 operations
 */
export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
