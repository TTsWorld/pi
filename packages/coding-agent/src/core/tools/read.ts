/**
 * @file read.ts —— read 内置工具：读取文件内容（文本或图片）
 *
 * @description
 * 实现终端 AI 编码助手的 `read` 工具，供模型查看磁盘上的文件：
 * - 文本文件：按行读取，支持 offset（1 起始行号）/ limit（行数）分页；
 *   再经 truncateHead 按「行数（默认 2000 行）与字节（默认 50KB）双上限，
 *   先到先截断」处理，并在被截断时追加「用 offset=N 继续读」的引导提示；
 * - 图片文件：探测 MIME 类型后按二进制读取，经 processImage（默认自动
 *   缩放到 2000x2000 以内）处理后作为 image 类型内容返回给模型；
 *   当前模型不支持视觉输入时仅返回文字说明、不带图片数据；
 * - 交互式 TUI 渲染：renderCall 区分紧凑/展开两种展示（skill、pi 文档、
 *   AGENTS/CLAUDE 等资源文件在紧凑模式下有专用样式），renderResult
 *   对文本做语法高亮并展示截断警告。
 *
 * 依赖关系：
 * - `./truncate.ts`：统一的输出截断（truncateHead）与体积格式化（formatSize）；
 * - `./path-utils.ts`：把模型传入的路径解析为基于 cwd 的绝对路径；
 * - `../../utils/image-process.ts`：图片读取与自动缩放；
 * - `./tool-definition-wrapper.ts`：把 ToolDefinition 包装为 AgentTool。
 * 文件读写通过 ReadOperations 接口抽象，便于沙箱或远程（如 SSH）替换实现。
 */

import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { getReadmePath } from "../../config.ts";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { getTextOutput, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** read 工具的输入参数 schema（typebox 定义，供参数校验与 schema 导出） */
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/** read 工具对系统提示词的贡献片段（snippet 一句话 + 使用守则列表） */
export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

/** 由 readSchema 推导出的工具输入类型 */
export type ReadToolInput = Static<typeof readSchema>;

/** read 工具结果附带的元信息（目前仅截断统计，供 TUI 渲染截断警告用） */
export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * 紧凑模式下对 read 调用的归类结果：
 * - docs：pi 自带的 README/docs/examples 文档；
 * - resource：AGENTS/CLAUDE 等项目记忆文件；
 * - skill：SKILL.md（label 取其所在目录名）。
 */
interface CompactReadClassification {
	kind: "docs" | "resource" | "skill";
	label: string;
}

/** 紧凑模式下需要特殊展示的项目记忆/配置文件名集合（大小写两种变体都收录） */
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/**
 * read 工具的可插拔文件操作集。
 * 覆盖这些方法即可把文件读取委托给远程系统（例如 SSH）。
 */
export interface ReadOperations {
	/** 以 Buffer 形式读取文件内容 */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** 检查文件是否可读（不可读则抛错） */
	access: (absolutePath: string) => Promise<void>;
	/** 探测图片 MIME 类型；非图片返回 null 或 undefined */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

/** 默认实现：直接读写本地文件系统 */
const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

/** read 工具的可配置项 */
export interface ReadToolOptions {
	/** 是否自动把图片缩放到最大 2000x2000。默认：true */
	autoResizeImages?: boolean;
	/** 自定义文件读取操作。默认：本地文件系统 */
	operations?: ReadOperations;
}

/** 渲染用的参数视图：file_path 是旧版参数名，path 是新版，两者取其一 */
type ReadRenderArgs = { path?: string; file_path?: string; offset?: number; limit?: number };

/** 生成 `:起始行-结束行` 形式的行范围后缀；未指定 offset/limit 时返回空串 */
function formatReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	if (args?.offset === undefined && args?.limit === undefined) return "";
	const startLine = args.offset ?? 1;
	const endLine = args.limit !== undefined ? startLine + args.limit - 1 : "";
	return theme.fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
}

/** 渲染普通（非紧凑归类）read 调用行：`read <路径><行范围>` */
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${formatReadLineRange(args, theme)}`;
}

/** 去掉末尾的连续空行，避免渲染结果底部出现大片空白 */
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}

/**
 * 当前模型不支持图片输入时的提示文案。
 * 模型缺省（undefined）或支持 image 输入时返回 undefined，不加提示。
 */
function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

/** 把平台路径分隔符统一为 `/`（Windows 下 `\` 也转成 `/`），便于展示 */
function toPosixPath(filePath: string): string {
	return filePath.split(sep).join("/");
}

/**
 * 判断绝对路径是否落在 pi 包自身（README 所在目录）之内；
 * 若是且命中 README.md / docs/ / examples/，归为 docs 类。
 * 路径在包外（relative 结果以 `..` 开头或为绝对路径）时返回 undefined。
 */
function getPiDocsClassification(absolutePath: string): CompactReadClassification | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	// relativePath 为 "" 表示就是包根目录本身；以 .. 开头则在包外，都不算 pi 文档
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}

	const label = toPosixPath(relativePath);
	if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
		return { kind: "docs", label };
	}
	return undefined;
}

/**
 * 紧凑模式下对 read 调用做归类（skill → pi 文档 → 项目记忆文件），
 * 未命中任何类别时返回 undefined，走普通渲染。
 */
function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	// SKILL.md 的 label 用其上级目录名（即 skill 名）；根目录下退化为文件名本身
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	const docsClassification = getPiDocsClassification(absolutePath);
	if (docsClassification) return docsClassification;

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}

/** 按归类结果渲染紧凑模式的 read 调用行，并附「按键展开」提示 */
function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	// skill 用 customMessage 系配色以区别于普通工具调用；\x1b[1m/22m 是粗体开关转义
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			formatReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		formatReadLineRange(args, theme) +
		expandHint
	);
}

/**
 * 渲染 read 的执行结果：文件内容预览（可语法高亮）+ 截断警告。
 * 紧凑模式下成功结果不显示内容（返回空串），只有展开或出错时才渲染。
 */
function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	_cwd: string,
	isError: boolean,
): string {
	// 未展开且非错误：紧凑视图只保留调用行，不展示文件内容
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	// 出错时不做语法高亮（错误文案不是代码）
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	// 展开时显示全部行；紧凑（此处仅错误场景）最多显示 10 行
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	// ===== 截断警告：按截断原因展示不同文案 =====
	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			// 首行单行就超字节上限，内容为空
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

/**
 * 创建 read 工具的 ToolDefinition（含执行逻辑与 TUI 渲染）。
 *
 * @param cwd - 工作目录，用于把相对路径解析为绝对路径
 * @param options - 图片自动缩放开关与可替换的文件操作集
 * @returns 可被 wrapToolDefinition 包装为 AgentTool 的工具定义
 */
export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			// 手写 Promise 而非 async/await 直写：为了在 abort 事件发生时立刻 reject，
			// 同时用 aborted 标志防止「异步主体完成后重复 resolve/reject」的竞态。
			return new Promise<{ content: (TextContent | ImageContent)[]; details: ReadToolDetails | undefined }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath = await resolveReadPathAsync(path, cwd);
							if (aborted) return;
							// 检查文件存在且可读。
							await ops.access(absolutePath);
							if (aborted) return;
							const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							// ===== 分支一：图片文件，读二进制并作为附件返回 =====
							if (mimeType) {
								// 以二进制方式读取图片。
								const buffer = await ops.readFile(absolutePath);
								const processed = await processImage(buffer, mimeType, { autoResizeImages });
								if (!processed.ok) {
									// 处理失败：只返回文字说明，不带图片数据
									let textNote = `Read image file [${mimeType}]\n${processed.message}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [{ type: "text", text: textNote }];
								} else {
									// 处理成功：文字说明 + image 类型内容（data 为 base64）
									let textNote = `Read image file [${processed.mimeType}]`;
									if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: processed.data, mimeType: processed.mimeType },
									];
								}
							} else {
								// ===== 分支二：文本文件，按行分页读取并截断 =====
								// 读取文本内容。
								const buffer = await ops.readFile(absolutePath);
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// 若指定了 offset 则应用。把 1 起始的输入转换为 0 起始的数组下标。
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// 检查 offset 是否越界。
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// 用户显式指定 limit 时优先遵循；否则交给 truncateHead 决定截断。
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// 应用截断，同时遵守行数与字节两个上限。
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// 首行单行就超过字节上限。引导模型改用 bash 兜底方案。
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// 发生了截断。构造可操作的续读提示（告知下一页 offset）。
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// 用户指定的 limit 提前截止，但文件后面还有内容。
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// 未截断，且没有因用户 limit 而剩余未读的内容。
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) return;
							signal?.removeEventListener("abort", onAbort);
							resolve({ content, details });
						} catch (error: any) {
							signal?.removeEventListener("abort", onAbort);
							if (!aborted) reject(error);
						}
					})();
				},
			);
		},
		// 渲染调用行：复用 lastComponent 减少 TUI 组件重建；紧凑模式下先尝试归类
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
			text.setText(
				classification
					? formatCompactReadCall(classification, args, theme)
					: formatReadCall(args, theme, context.cwd),
			);
			return text;
		},
		// 渲染结果：仅在展开或出错时显示文件内容预览
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(
				formatReadResult(context.args, result, options, theme, context.showImages, context.cwd, context.isError),
			);
			return text;
		},
	};
}

/** 便捷封装：直接创建可注册到 Agent 的 read AgentTool */
export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
