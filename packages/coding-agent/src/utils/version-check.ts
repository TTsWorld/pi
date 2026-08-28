/**
 * @file version-check.ts —— pi 新版本检查
 *
 * @description
 * 通过 pi.dev 的 latest-version 接口查询最新发布版本，与当前版本做 semver 比较，
 * 判断是否存在可用更新；并负责把版本检查失败整理为对用户友好的错误文本。
 */

import { compare, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

/** 最新 pi 发布信息：版本号、可选的包名与附加说明。 */
export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** 把 Node 通用 "fetch failed" 错误背后隐藏的 errno 细节（如 ENOTFOUND、ETIMEDOUT）拼进错误文本。 */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

/**
 * 按 semver 比较两个版本字符串。
 *
 * @returns 负数表示 left 更旧、0 表示相等、正数表示 left 更新；任一版本不合法时返回 undefined
 */
export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

/** 判断候选版本是否比当前版本更新；semver 无法比较时退化为字符串不等判断。 */
export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

/**
 * 请求 pi.dev 的 latest-version 接口，获取最新发布信息。
 * 离线模式（PI_OFFLINE）直接跳过；接口返回不合法时静默返回 undefined。
 *
 * @param currentVersion - 当前 pi 版本，用于拼 User-Agent
 * @param options - 超时与重试配置
 * @returns 最新发布信息；离线、请求失败或响应非法时返回 undefined
 */
export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

/** 获取最新 pi 版本号（{@link getLatestPiRelease} 的便捷封装）。 */
export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

/**
 * 检查是否存在比当前版本更新的 pi 发布（版本检查入口）。
 * 设置 PI_SKIP_VERSION_CHECK 可完全跳过；任何异常都吞掉并返回 undefined，
 * 保证版本检查绝不干扰主流程。
 */
export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	// 用户显式关闭版本检查
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
