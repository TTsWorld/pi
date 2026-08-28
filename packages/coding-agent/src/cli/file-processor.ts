/**
 * @file file-processor.ts —— 把 `@file` 参数处理为文本内容与图片附件
 *
 * @description
 * 遍历命令行里的每个 @file 参数：图片文件读取后（可选自动缩放）转为
 * ImageContent 附件，其余按 UTF-8 文本读入并包上 <file name="..."> 标签，
 * 最终汇总为一段文本与一组图片附件，供拼进首轮用户消息。
 */

import { access, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { stripBom } from "../utils/text.ts";

/** @file 参数的处理结果：聚合后的文本内容与图片附件列表 */
export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** 是否把图片自动缩放到最大 2000x2000。默认：true */
	autoResizeImages?: boolean;
}

/**
 * 处理 @file 参数：图片转附件、文本读内容，汇总为可拼入 prompt 的结构。
 *
 * 文件不存在或读取失败时打印错误并 process.exit(1)——这类错误属于
 * 用户输入问题，发生在进入交互循环之前，无需走恢复流程。
 */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	// 默认开启自动缩放：超大图片直接发给模型既慢又浪费 token
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// 展开并解析为绝对路径（处理 ~ 展开与 macOS 截图文件名里的 Unicode 空格）
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// 文件不存在：打印错误并直接退出
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// 检查文件是否为空
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// 空文件直接跳过，不产生任何内容
			continue;
		}

		// 依据文件内容嗅探是否为受支持的图片类型
		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// 图片文件：读入后按需缩放/压缩，成功则挂为附件
			const content = await readFile(absolutePath);
			const processed = await processImage(content, mimeType, { autoResizeImages });

			if (!processed.ok) {
				// 图片处理失败不整体报错，把失败原因写进占位标签让模型可见
				text += `<file name="${absolutePath}">${processed.message}</file>\n`;
				continue;
			}

			const attachment: ImageContent = {
				type: "image",
				mimeType: processed.mimeType,
				data: processed.data,
			};
			images.push(attachment);

			// 在文本里留下同名引用占位；处理提示（如已缩放）一并列出，方便模型对齐图文
			if (processed.hints.length > 0) {
				text += `<file name="${absolutePath}">${processed.hints.join("\n")}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// 文本文件：读取前剥掉 BOM，避免把 \uFEFF 混进模型上下文
			try {
				const content = stripBom(await readFile(absolutePath, "utf-8"));
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
