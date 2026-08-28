/**
 * @file write.ts —— write 内置工具：创建或覆写文件
 *
 * @description
 * 实现终端 AI 编码助手的 `write` 工具：把整段内容写入指定文件
 * （不存在则创建，存在则整体覆盖），并自动递归创建父目录。
 * 适合新建文件或完整重写；局部修改应走 edit 工具。
 *
 * 主要功能点：
 * - 写入经 withFileMutationQueue 串行化，保证同一文件的并发写入不交错；
 * - TUI 渲染亮点是对流式参数做增量语法高亮：模型边生成 content 边渲染时，
 *   WriteHighlightCache 只对新增增量做单行高亮，并定期用「多行整体高亮」
 *   修正前缀（多行上下文会让高亮更准确），避免每帧全文重算；
 * - 文件读写通过 WriteOperations 抽象，便于沙箱或远程（如 SSH）替换实现。
 *
 * 依赖关系：
 * - `./file-mutation-queue.ts`：按文件路径串行化写操作；
 * - `./path-utils.ts` / `./render-utils.ts`：路径解析与渲染辅助；
 * - `./tool-definition-wrapper.ts`：把 ToolDefinition 包装为 AgentTool。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { normalizeDisplayText, renderToolPath, replaceTabs, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** write 工具的输入参数 schema（typebox 定义） */
const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** write 工具对系统提示词的贡献片段（snippet 一句话 + 使用守则列表） */
export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

/** 由 writeSchema 推导出的工具输入类型 */
export type WriteToolInput = Static<typeof writeSchema>;

/**
 * write 工具的可插拔文件操作集。
 * 覆盖这些方法即可把文件写入委托给远程系统（例如 SSH）。
 */
export interface WriteOperations {
	/** 把内容写入文件 */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** 递归创建目录 */
	mkdir: (dir: string) => Promise<void>;
}

/** 默认实现：直接写本地文件系统（utf-8 编码，目录递归创建） */
const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

/** write 工具的可配置项 */
export interface WriteToolOptions {
	/** 自定义文件写入操作。默认：本地文件系统 */
	operations?: WriteOperations;
}

/**
 * 流式渲染期间复用的语法高亮缓存：
 * 保存原始 content、归一化后的行数组与已高亮的行数组，
 * 每帧只需对「新增增量」做单行高亮，避免全文重算。
 */
type WriteHighlightCache = {
	rawPath: string | null;
	lang: string;
	rawContent: string;
	normalizedLines: string[];
	highlightedLines: string[];
};

/** 携带高亮缓存的 TUI 组件：复用 lastComponent 时缓存可跨帧保留 */
class WriteCallRenderComponent extends Text {
	cache?: WriteHighlightCache;

	constructor() {
		super("", 0, 0);
	}
}

/** 增量高亮时，前缀部分定期用「多行整体高亮」重算的行数窗口 */
const WRITE_PARTIAL_FULL_HIGHLIGHT_LINES = 50;

/** 对单行做语法高亮，取返回结果的第一行（忽略折行） */
function highlightSingleLine(line: string, lang: string): string {
	const highlighted = highlightCode(line, lang);
	return highlighted[0] ?? "";
}

/**
 * 用整体（多行）高亮重算缓存前缀的最多 50 行。
 * 多行上下文能让高亮器看到跨行结构（模板串、块注释等），
 * 从而修正增量单行高亮可能产生的偏差。
 */
function refreshWriteHighlightPrefix(cache: WriteHighlightCache): void {
	const prefixCount = Math.min(WRITE_PARTIAL_FULL_HIGHLIGHT_LINES, cache.normalizedLines.length);
	if (prefixCount === 0) return;
	const prefixSource = cache.normalizedLines.slice(0, prefixCount).join("\n");
	const prefixHighlighted = highlightCode(prefixSource, cache.lang);
	for (let i = 0; i < prefixCount; i++) {
		cache.highlightedLines[i] =
			prefixHighlighted[i] ?? highlightSingleLine(cache.normalizedLines[i] ?? "", cache.lang);
	}
}

/**
 * 全量重建高亮缓存：归一化（控制字符、Tab 替换）后整体高亮。
 * 无语言可识别时返回 undefined（调用方退化为纯文本渲染）。
 */
function rebuildWriteHighlightCacheFull(rawPath: string | null, fileContent: string): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	const displayContent = normalizeDisplayText(fileContent);
	const normalized = replaceTabs(displayContent);
	return {
		rawPath,
		lang,
		rawContent: fileContent,
		normalizedLines: normalized.split("\n"),
		highlightedLines: highlightCode(normalized, lang),
	};
}

/**
 * 增量更新高亮缓存（流式渲染热路径）。
 *
 * 工作原理：模型逐字生成 content，每帧新内容几乎总是旧内容的前缀扩展
 * （`fileContent.startsWith(cache.rawContent)`），此时只高亮「新增增量」：
 * 拼接到最后一行 + 逐行追加；再用 refreshWriteHighlightPrefix 修正前缀高亮。
 * 不满足前缀扩展或路径/语言变化时，退回全量重建。
 */
function updateWriteHighlightCacheIncremental(
	cache: WriteHighlightCache | undefined,
	rawPath: string | null,
	fileContent: string,
): WriteHighlightCache | undefined {
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (!lang) return undefined;
	// 缓存缺失 / 语言或路径变了：全量重建
	if (!cache) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	if (cache.lang !== lang || cache.rawPath !== rawPath) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	// 内容不是前缀扩展（参数被改写）：全量重建
	if (!fileContent.startsWith(cache.rawContent)) return rebuildWriteHighlightCacheFull(rawPath, fileContent);
	// 内容没有变化：直接复用缓存
	if (fileContent.length === cache.rawContent.length) return cache;

	const deltaRaw = fileContent.slice(cache.rawContent.length);
	const deltaDisplay = normalizeDisplayText(deltaRaw);
	const deltaNormalized = replaceTabs(deltaDisplay);
	cache.rawContent = fileContent;
	// 空文件场景补一个空行，保证下面能按「最后一行」拼接
	if (cache.normalizedLines.length === 0) {
		cache.normalizedLines.push("");
		cache.highlightedLines.push("");
	}

	const segments = deltaNormalized.split("\n");
	// 第一个片段拼接到原最后一行（流式内容常在行中间追加）
	const lastIndex = cache.normalizedLines.length - 1;
	cache.normalizedLines[lastIndex] += segments[0];
	cache.highlightedLines[lastIndex] = highlightSingleLine(cache.normalizedLines[lastIndex], cache.lang);
	// 其余片段是完整的新行，直接追加
	for (let i = 1; i < segments.length; i++) {
		cache.normalizedLines.push(segments[i]);
		cache.highlightedLines.push(highlightSingleLine(segments[i], cache.lang));
	}
	refreshWriteHighlightPrefix(cache);
	return cache;
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
 * 渲染 write 调用：`write <路径>` + 内容预览（带语法高亮）。
 * content 参数非法时显示错误提示；紧凑模式最多预览 10 行并附展开按键提示。
 */
function formatWriteCall(
	args: { path?: string; file_path?: string; content?: string } | undefined,
	options: ToolRenderResultOptions,
	theme: Theme,
	cache: WriteHighlightCache | undefined,
	cwd: string,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const fileContent = str(args?.content);
	const pathDisplay = renderToolPath(rawPath, theme, cwd);
	let text = `${theme.fg("toolTitle", theme.bold("write"))} ${pathDisplay}`;

	if (fileContent === null) {
		// 流式参数解析失败（content 不是字符串）：给出可见的错误提示
		text += `\n\n${theme.fg("error", "[invalid content arg - expected string]")}`;
	} else if (fileContent) {
		const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
		// 优先使用传入的增量高亮缓存；没有缓存时现场全文高亮
		const renderedLines = lang
			? (cache?.highlightedLines ?? highlightCode(replaceTabs(normalizeDisplayText(fileContent)), lang))
			: normalizeDisplayText(fileContent).split("\n");
		const lines = trimTrailingEmptyLines(renderedLines);
		const totalLines = lines.length;
		// 展开时显示全部行；紧凑模式只显示前 10 行
		const maxLines = options.expanded ? lines.length : 10;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n\n${displayLines.map((line) => (lang ? line : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines, ${totalLines} total,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	return text;
}

/**
 * 渲染 write 结果：仅在出错时展示错误文本，成功时返回 undefined
 * （调用方清空组件，紧凑视图只保留调用行）。
 */
function formatWriteResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean },
	theme: Theme,
): string | undefined {
	if (!result.isError) {
		return undefined;
	}
	const output = result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text || "")
		.join("\n");
	if (!output) {
		return undefined;
	}
	return `\n${theme.fg("error", output)}`;
}

/**
 * 创建 write 工具的 ToolDefinition（含执行逻辑与 TUI 渲染）。
 *
 * @param cwd - 工作目录，用于把相对路径解析为绝对路径
 * @param options - 可替换的文件写入操作集
 * @returns 可被 wrapToolDefinition 包装为 AgentTool 的工具定义
 */
export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: writeToolSystemPromptContribution.snippet,
		promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
		parameters: writeSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			// 同一文件的写入串行排队，避免并发写互相交错
			return withFileMutationQueue(absolutePath, async () => {
				// 此处不要在 abort 事件监听器里 reject：那会在一个尚在进行的文件系统
				// 操作可能完成之前就释放 mutation 队列。改为在每个 await 之后检查
				// signal.aborted，能观察到同样的中断，同时保证队列锁定到当前操作落定。
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// 按需创建父目录。
				await ops.mkdir(dir);
				throwIfAborted();

				// 写入文件内容。
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				return {
					content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
					details: undefined,
				};
			});
		},
		// 渲染调用行：流式期间（argsComplete=false）增量更新高亮缓存，
		// 参数收齐后（argsComplete=true）全量重建一次以获得最准确的高亮
		renderCall(args, theme, context) {
			const renderArgs = args as { path?: string; file_path?: string; content?: string } | undefined;
			const rawPath = str(renderArgs?.file_path ?? renderArgs?.path);
			const fileContent = str(renderArgs?.content);
			const component =
				(context.lastComponent as WriteCallRenderComponent | undefined) ?? new WriteCallRenderComponent();
			if (fileContent !== null) {
				component.cache = context.argsComplete
					? rebuildWriteHighlightCacheFull(rawPath, fileContent)
					: updateWriteHighlightCacheIncremental(component.cache, rawPath, fileContent);
			} else {
				// content 参数非法：清掉缓存，formatWriteCall 会显示错误提示
				component.cache = undefined;
			}
			component.setText(
				formatWriteCall(
					renderArgs,
					{ expanded: context.expanded, isPartial: context.isPartial },
					theme,
					component.cache,
					context.cwd,
				),
			);
			return component;
		},
		// 渲染结果：成功时清空组件（只留调用行），出错时显示错误文本
		renderResult(result, _options, theme, context) {
			const output = formatWriteResult({ ...result, isError: context.isError }, theme);
			if (!output) {
				const component = (context.lastComponent as Container | undefined) ?? new Container();
				component.clear();
				return component;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(output);
			return text;
		},
	};
}

/** 便捷封装：直接创建可注册到 Agent 的 write AgentTool */
export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
