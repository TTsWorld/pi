/**
 * @file 内置 read 工具工厂。
 *
 * @description 产出符合 {@link AgentHarnessTool} 契约的 "read" 工具，供 LLM 读取本地文件：
 * - 图片（jpg/png/gif/webp/bmp）：经 ./image.ts 的魔数检测识别 MIME 后，以 base64
 *   image 内容块作为附件发给 LLM（可注入 imageProcessor 做缩放/格式转换）；
 * - 文本：支持 offset/limit 行范围读取，输出经 ../utils/truncate.ts 的 truncateHead
 *   双上限截断（默认 2000 行 / 50KB，先命中者胜），截断时提示 LLM 用下一个 offset 续读。
 * 文件读取依赖 {@link ExecutionToolContext} 暴露的 ExecutionEnv 能力接口，
 * 不直接依赖 node:fs，从而保持执行环境可替换。
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
	truncateHead,
} from "../utils/truncate.ts";
import { detectSupportedImageMimeType, encodeBase64 } from "./image.ts";
import { resolveReadToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/** read 工具的输入参数 schema（typebox）：path 必填；offset（1 起始行号）与 limit（行数）可选 */
const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/** 由 {@link readSchema} 静态推导的工具输入类型 */
export type ReadToolInput = Static<typeof readSchema>;

/** read 工具结果中的 details 负载：仅文本读取触发截断时携带，供 UI 展示截断元数据 */
export interface ReadToolDetails {
	/** 截断统计信息（发生截断或首行超限时存在），见 {@link TruncationResult} */
	truncation?: TruncationResult;
}

/**
 * 图片处理器的返回结果：
 * - ok: true —— 处理成功，携带 base64 数据、MIME 类型与附加提示（hints）；
 * - ok: false —— 处理失败，携带展示给 LLM 的错误消息
 */
export type ReadImageProcessorResult =
	| { ok: true; data: string; mimeType: string; hints: string[] }
	| { ok: false; message: string };

/** 外部注入的图片转换/缩放处理器：输入原始字节与 MIME，输出可发给 LLM 的 base64 图片或错误 */
export type ReadImageProcessor = (
	bytes: Uint8Array,
	mimeType: string,
	options: { autoResizeImages: boolean },
) => Promise<ReadImageProcessorResult>;

export interface ReadToolOptions {
	/** 注入的图片处理器是否应缩放图片。默认：true。 */
	autoResizeImages?: boolean;
	/** 可选的图片转换/缩放实现。 */
	imageProcessor?: ReadImageProcessor;
}

/**
 * 创建内置的 read 工具。
 *
 * 文件不存在等预期内错误由 env.readBinaryFile 以 Result 形式返回，经 getOrThrow 抛出，
 * 由上层统一反馈给 LLM；文本输出的截断策略见 ../utils/truncate.ts。
 *
 * @param options 可选配置：注入的图片处理器及是否缩放图片
 * @returns 符合 {@link AgentHarnessTool} 契约的 read 工具
 */
export function createReadTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: ReadToolOptions,
): AgentHarnessTool<TContext, typeof readSchema, ReadToolDetails | undefined> {
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		async execute(_toolCallId, { path, offset, limit }, signal, _onUpdate, { env }) {
			// ========== 路径解析、读取文件与 MIME 魔数检测 ==========
			// resolveReadToolPath 会把路径规范化为绝对路径，并尝试若干 Unicode 变体
			// （窄不换行空格、NFD、弯引号等），容错模型写出的文件名；
			// 文件不存在等错误由 readBinaryFile 以 Result 返回，getOrThrow 直接抛出，
			// 让 LLM 收到明确的报错而非静默的空内容。
			const absolutePath = await resolveReadToolPath(env, path, signal);
			const bytes = getOrThrow(await env.readBinaryFile(absolutePath, signal));
			// 通过魔数（而非扩展名）判断是否为受支持的图片格式
			const mimeType = detectSupportedImageMimeType(bytes);
			if (mimeType) {
				// ========== 图片分支：优先交给注入的图片处理器 ==========
				// 处理器可做缩放/格式转换（如把 BMP 转为 LLM 可读格式），失败时把原因以文本返回
				if (options?.imageProcessor) {
					const processed = await options.imageProcessor(bytes, mimeType, {
						autoResizeImages: options.autoResizeImages ?? true,
					});
					if (!processed.ok) {
						return {
							content: [{ type: "text", text: `Read image file [${mimeType}]\n${processed.message}` }],
							details: undefined,
						};
					}
					const hints = processed.hints.length > 0 ? `\n${processed.hints.join("\n")}` : "";
					return {
						content: [
							{ type: "text", text: `Read image file [${processed.mimeType}]${hints}` },
							{ type: "image", data: processed.data, mimeType: processed.mimeType },
						] satisfies Array<TextContent | ImageContent>,
						details: undefined,
					};
				}
				// 未注入处理器时 BMP 无法被多数 LLM 直接识别，明确提示需配置 imageProcessor
				if (mimeType === "image/bmp") {
					return {
						content: [
							{
								type: "text",
								text: "Read image file [image/bmp]\n[Image omitted: configure an imageProcessor to convert BMP images.]",
							},
						],
						details: undefined,
					};
				}
				// 其余格式：直接 base64 编码后作为 image 内容块附给 LLM
				return {
					content: [
						{ type: "text", text: `Read image file [${mimeType}]` },
						{ type: "image", data: encodeBase64(bytes), mimeType },
					] satisfies Array<TextContent | ImageContent>,
					details: undefined,
				};
			}

			// ========== 文本分支：offset/limit 行范围选取 ==========
			// offset 是 1 起始的行号，内部换算为 0 起始下标（未传或传 0 都从首行读起，负值归一到 0）
			const textContent = new TextDecoder().decode(bytes);
			const allLines = textContent.split("\n");
			const totalFileLines = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			// offset 超出文件末尾直接报错并告知总行数，避免 LLM 误以为读到了空文件
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}

			let selectedContent: string;
			let userLimitedLines: number | undefined;
			if (limit !== undefined) {
				// 显式指定 limit：只取 [startLine, startLine+limit) 区间，endLine 封顶到文件末尾
				const endLine = Math.min(startLine + limit, allLines.length);
				selectedContent = allLines.slice(startLine, endLine).join("\n");
				userLimitedLines = endLine - startLine;
			} else {
				// 未指定 limit：从 startLine 读到文件末尾，超量与否交给截断层决定
				selectedContent = allLines.slice(startLine).join("\n");
			}

			// ========== 截断与续读提示 ==========
			// 即使带了 limit，仍要过 truncateHead 的硬上限（默认 2000 行 / 50KB，先命中者胜），
			// 防止单次调用把超长内容塞爆上下文；按优先级分四种情况给出输出与续读指引
			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				// 情况 1：首行单独超字节上限，连一行都放不下——提示改用 bash 截取该行片段
				const firstLineSize = formatSize(new TextEncoder().encode(allLines[startLine]).byteLength);
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				// 情况 2：命中硬上限被截断——附上已显示的行范围与下一个 offset，引导 LLM 续读
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
				// 情况 3：未触发硬截断，但用户 limit 小于剩余行数——提示剩余行数与续读 offset
				const remaining = allLines.length - (startLine + userLimitedLines);
				const nextOffset = startLine + userLimitedLines + 1;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
			} else {
				// 情况 4：请求范围内已读到文件末尾，原样返回
				outputText = truncation.content;
			}

			return { content: [{ type: "text", text: outputText }], details };
		},
	};
}
