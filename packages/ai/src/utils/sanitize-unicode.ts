/**
 * @file Unicode 代理项清洗工具。
 * 移除文本中未配对的代理项字符，避免众多 LLM provider 在 JSON 序列化时报错，供发送消息前预处理文本使用。
 */

/**
 * 移除字符串中未配对的 Unicode 代理项字符。
 *
 * 未配对的代理项（高代理项 0xD800-0xDBFF 后没有匹配的低代理项 0xDC00-0xDFFF，
 * 或相反情况）会导致许多 API provider 的 JSON 序列化报错。
 *
 * 合法的 emoji 及其他基本多文种平面（BMP）之外的字符使用的是正确配对的
 * 代理项，不会受本函数影响。
 *
 * @param text - 待清洗的文本
 * @returns 移除未配对代理项后的文本
 *
 * @example
 * // 合法 emoji（正确配对的代理项）会被保留
 * sanitizeSurrogates("Hello 🙈 World") // => "Hello 🙈 World"
 *
 * // 未配对的高代理项会被移除
 * const unpaired = String.fromCharCode(0xD83D); // 高代理项，缺少低代理项
 * sanitizeSurrogates(`Text ${unpaired} here`) // => "Text  here"
 */
export function sanitizeSurrogates(text: string): string {
	// 替换未配对的高代理项（0xD800-0xDBFF 且后面不是低代理项）
	// 替换未配对的低代理项（0xDC00-0xDFFF 且前面不是高代理项）
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
