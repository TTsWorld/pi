/**
 * @file text.ts —— UTF-8 BOM（字节顺序标记）处理
 *
 * @description
 * 识别并剥离解码后文本开头的 UTF-8 BOM（U+FEFF）。
 */

/** 拆出解码文本开头的 UTF-8 字节顺序标记（BOM），分别返回 BOM 与其余正文。 */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** 移除解码文本开头的 UTF-8 字节顺序标记（BOM），返回其余正文。 */
export function stripBom(content: string): string {
	return splitBom(content).text;
}
