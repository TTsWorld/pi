/**
 * @file pi-user-agent.ts —— pi 的 User-Agent 构造
 *
 * @description
 * 生成形如 `pi/<version> (<platform>; node/<ver> 或 bun/<ver>; <arch>)` 的 UA 字符串，
 * 用于版本检查等发往 pi.dev 的管理请求。
 */

/** 构造携带 pi 版本、平台、运行时（Node/Bun）与 CPU 架构的 User-Agent 字符串。 */
export function getPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `pi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}
