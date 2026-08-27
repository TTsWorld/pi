/**
 * @file OpenAI prompt cache key 的长度截断工具。
 * @description OpenAI 限制 prompt cache key 最长 64 个字符；这里按 Unicode 码点
 * （而非 UTF-16 码元）截断，避免把代理对字符（如 emoji）从中间切坏。
 */

/** OpenAI 对 prompt cache key 的最大长度限制（64 个字符）。 */
export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** 把 key 截断到上限长度以内；未传 key 时原样返回 undefined。 */
export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	// Array.from 按码点切分，再 slice 就不会截断代理对
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
