/**
 * @file frontmatter.ts —— Markdown frontmatter（YAML 头部）解析
 *
 * @description
 * 识别并拆出 `---\n...\n---` 包裹的 YAML 头部，解析为对象并返回剩余正文；
 * 无 frontmatter 时正文原样返回、frontmatter 为空对象。
 */

import { parse } from "yaml";
import { stripBom } from "./text.ts";

/** 解析结果：frontmatter 对象 + 去掉头部后的正文。 */
type ParsedFrontmatter<T extends Record<string, unknown>> = {
	frontmatter: T;
	body: string;
};

/** 把 CRLF / CR 统一为 LF，避免换行差异影响分隔符匹配。 */
const normalizeNewlines = (value: string): string => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

/** 从内容中提取 YAML 头部字符串与正文；没有合法头部时 yamlString 为 null。 */
const extractFrontmatter = (content: string): { yamlString: string | null; body: string } => {
	const normalized = normalizeNewlines(stripBom(content));

	// 不以 --- 开头则没有 frontmatter
	if (!normalized.startsWith("---")) {
		return { yamlString: null, body: normalized };
	}

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return { yamlString: null, body: normalized };
	}

	return {
		yamlString: normalized.slice(4, endIndex),
		body: normalized.slice(endIndex + 4).trim(),
	};
};

/**
 * 解析带 frontmatter 的内容。
 *
 * @param content - 原始 Markdown 文本（可含 BOM 与 CRLF 换行）
 * @returns frontmatter 对象（YAML 非法或缺失时为空对象）与正文
 */
export const parseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
	content: string,
): ParsedFrontmatter<T> => {
	const { yamlString, body } = extractFrontmatter(content);
	if (!yamlString) {
		return { frontmatter: {} as T, body };
	}
	const parsed = parse(yamlString);
	return { frontmatter: (parsed ?? {}) as T, body };
};

/** 去掉 frontmatter，仅返回正文。 */
export const stripFrontmatter = (content: string): string => parseFrontmatter(content).body;
