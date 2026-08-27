/**
 * @file HTTP 请求头类型转换工具。
 * 在 fetch 的 Headers 对象、provider 自定义头（ProviderHeaders）与普通记录对象之间转换，供各 provider 客户端组装请求头使用。
 */
import type { ProviderHeaders } from "../types.ts";

/**
 * 把 fetch 的 Headers 对象转换为普通键值记录。
 * @param headers 待转换的 Headers 对象
 * @returns 头名到头值的普通对象（Headers 迭代出的键均为小写）
 */
export function headersToRecord(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		result[key] = value;
	}
	return result;
}

/**
 * 把 provider 自定义头转换为普通记录对象，便于合入请求头。
 * 值为 null 的头会被跳过；过滤后若无有效头则返回 undefined。
 * @param headers provider 配置的自定义头，允许字段值为 null 表示不设置
 * @returns 有效头组成的记录对象；输入为空或全被过滤时返回 undefined
 */
export function providerHeadersToRecord(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value !== null) result[key] = value;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}
