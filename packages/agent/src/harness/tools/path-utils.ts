/**
 * \u5DE5\u5177\u8DEF\u5F84\u89E3\u6790\u7684 Unicode \u5BB9\u9519\u5904\u7406\u3002
 *
 * LLM \u751F\u6210\u7684\u8DEF\u5F84\u5E38\u6DF7\u5165\u5404\u7C7B Unicode \u7A7A\u683C\u6216\u591A\u4F59\u7684 "@" \u524D\u7F00\uFF1B\u771F\u5B9E\u6587\u4EF6\u540D\uFF08\u5C24\u5176 macOS\uFF09
 * \u8FD8\u53EF\u80FD\u4F7F\u7528 NFD \u53D8\u97F3\u5206\u89E3\u3001\u7A84\u4E0D\u6362\u884C\u7A7A\u683C\uFF08\u5982\u622A\u56FE\u540D\u91CC\u7684 " AM."\uFF09\u6216\u5F2F\u5F15\u53F7 \u2019\u3002
 * \u8FD9\u91CC\u5728\u89E3\u6790\u8DEF\u5F84\u65F6\u505A\u5F52\u4E00\u5316 / \u5019\u9009\u5339\u914D\uFF0C\u63D0\u9AD8\u8BFB\u5199\u5DE5\u5177\u7684\u5BB9\u9519\u6027\u3002
 */

import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

// \u5404\u7C7B Unicode \u7A7A\u683C\u5B57\u7B26\uFF08\u4E0D\u95F4\u65AD\u7A7A\u683C\u3001\u591A\u79CD\u5BBD\u5EA6\u7A7A\u683C\u3001\u5168\u89D2\u7A7A\u683C\u7B49\uFF09\u3002
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
// \u7A84\u4E0D\u6362\u884C\u7A7A\u683C\uFF1AmacOS \u622A\u56FE\u6587\u4EF6\u540D\u4E2D "AM"/"PM" \u524D\u5B9E\u9645\u4F7F\u7528\u7684\u5B57\u7B26\u3002
const NARROW_NO_BREAK_SPACE = "\u202F";

/** 归一化工具入参路径：Unicode 空格统一替换为普通空格，并去掉可能误加的 "@" 前缀。 */
function normalizeToolPath(path: string): string {
	const normalized = path.replace(UNICODE_SPACES, " ");
	return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/** 将工具入参路径归一化后解析为绝对路径。 */
export async function resolveToolPath(env: ExecutionEnv, path: string, signal?: AbortSignal): Promise<string> {
	return getOrThrow(await env.absolutePath(normalizeToolPath(path), signal));
}

/**
 * 解析 read 工具的路径：读取场景对文件名差异更宽容。
 * 依次尝试原路径及若干常见变体，返回第一个实际存在的路径；
 * 都不存在则原样返回，由调用方报「文件不存在」。
 */
export async function resolveReadToolPath(env: ExecutionEnv, path: string, signal?: AbortSignal): Promise<string> {
	const resolved = await resolveToolPath(env, path, signal);
	// 候选变体：覆盖 macOS 截图名的窄不换行空格、NFD 变音分解、直引号/弯引号等差异。
	const variants = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`),
		resolved.normalize("NFD"),
		resolved.replace(/'/g, "\u2019"),
		resolved.normalize("NFD").replace(/'/g, "\u2019"),
	];

	for (const variant of new Set(variants)) {
		if (getOrThrow(await env.exists(variant, signal))) return variant;
	}
	return resolved;
}
