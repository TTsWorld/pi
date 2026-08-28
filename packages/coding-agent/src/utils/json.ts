/**
 * @file json.ts —— 宽松 JSON（JSONC 风格）文本清理
 *
 * @description
 * 去除 JSON 文本中的 `//` 行注释与尾随逗号，使其可被 JSON.parse 接受；
 * 字符串字面量内部的内容始终保持原样。
 */

/** 去除 JSON 中的 `//` 行注释与尾随逗号，字符串字面量内的内容不受影响。 */
export function stripJsonComments(input: string): string {
	// 两遍替换均以「字符串字面量 | 目标内容」交替匹配：落到字符串分支时原样保留，避免误伤字符串内的 // 和逗号
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}
