/**
 * @file changelog.ts —— CHANGELOG.md 解析与链接规范化
 *
 * @description
 * 负责两件事：
 * 1. 解析 CHANGELOG.md 中的版本条目（`parseChangelog`），按 `## [x.y.z]`
 *    标题切分，供 CLI 在升级后展示「新版本更新了什么」；
 * 2. 把条目正文中的相对链接重写为指向 GitHub 仓库对应 tag 的绝对链接
 *    （`normalizeChangelogLinks`），避免发布后相对链接失效或指向漂移。
 *
 * 依赖关系：
 * - `node:path` / `node:fs`：路径拼接与文件读取；
 * - `../config.ts`：重新导出 `getChangelogPath`，方便调用方一站式导入。
 */
import path from "node:path";
import { existsSync, readFileSync } from "fs";

/** CHANGELOG 中的一条版本记录：语义化版本号 + 该版本的正文内容（Markdown） */
export interface ChangelogEntry {
	/** 主版本号 */
	major: number;
	/** 次版本号 */
	minor: number;
	/** 修订号 */
	patch: number;
	/** 该版本条目的正文（以版本标题行开头，已 trim） */
	content: string;
}

// 链接重写的目标仓库（GitHub 组织/仓库名）
const GITHUB_REPO = "earendil-works/pi";
// CHANGELOG 相对链接的基准目录：本包在 monorepo 中的路径
const CHANGELOG_LINK_BASE_PATH = "packages/coding-agent";
// 旧仓库地址（badlogic 或 earendil-works 名下的 pi-mono）→ 新仓库的重写规则
const LEGACY_REPO_RE = /^https:\/\/github\.com\/(?:badlogic|earendil-works)\/pi-mono(?=\/|$)/;
// 匹配带 scheme 的 URL（https:、mailto: 等），这类目标不参与相对路径重写
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// 匹配行内 Markdown 链接/图片，捕获组：1 = 前缀 `[文字](`，2 = 链接目标，3 = 可选标题与右括号
const INLINE_MARKDOWN_LINK_RE = /(!?\[[^\]\n]+\]\()([^\s)]+)((?:\s+[^)]*)?\))/g;

/** 把条目的三段版本号拼成 `x.y.z` 字符串 */
function entryVersion(entry: ChangelogEntry): string {
	return `${entry.major}.${entry.minor}.${entry.patch}`;
}

/** 统一 tag 形式：确保以 `v` 开头（`1.2.3` → `v1.2.3`），已带 `v` 则原样返回 */
function normalizeTag(version: string | ChangelogEntry): string {
	const versionString = typeof version === "string" ? version : entryVersion(version);
	return versionString.startsWith("v") ? versionString : `v${versionString}`;
}

/**
 * 把链接目标拆成三部分：路径、查询串、锚点。
 * 形如 `docs/foo.md?a=1#section` → `{ pathPart: "docs/foo.md", query: "?a=1", fragment: "#section" }`，
 * 缺失的部分为空字符串，随后按原顺序拼回，保证非链接信息不丢失。
 */
function splitLocalTarget(target: string): { fragment: string; pathPart: string; query: string } {
	const hashIndex = target.indexOf("#");
	const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const fragment = hashIndex === -1 ? "" : target.slice(hashIndex);
	const queryIndex = beforeHash.indexOf("?");

	if (queryIndex === -1) {
		return { fragment, pathPart: beforeHash, query: "" };
	}

	return {
		fragment,
		pathPart: beforeHash.slice(0, queryIndex),
		query: beforeHash.slice(queryIndex),
	};
}

/** 统一分隔符：Windows 反斜杠转 `/`，便于后续按 POSIX 规则处理 */
function normalizePathPart(value: string): string {
	return value.replaceAll("\\", "/");
}

/**
 * 把 CHANGELOG 里的相对路径解析为 monorepo 仓库内的相对路径：
 * - 普通相对路径以 `CHANGELOG_LINK_BASE_PATH` 为基准拼接；
 * - 以 `/` 开头则视为仓库根下的绝对路径；
 * - 解析结果若逃逸出仓库根（`..`、`../...`）或为空（`.`），返回 undefined 表示放弃重写。
 */
function resolveRepositoryPath(targetPath: string): string | undefined {
	const normalizedTarget = normalizePathPart(targetPath);
	const joined = normalizedTarget.startsWith("/")
		? path.posix.normalize(normalizedTarget.replace(/^\/+/, ""))
		: path.posix.normalize(path.posix.join(CHANGELOG_LINK_BASE_PATH, normalizedTarget));

	if (joined === "." || joined.startsWith("../") || joined === "..") {
		return undefined;
	}

	return joined;
}

/**
 * 判断链接目标是否指向目录：以 `/` 结尾、或文件名不含 `.`（无扩展名）视为目录。
 * 目录对应 GitHub 的 `tree` 路由，文件对应 `blob` 路由。
 */
function isDirectoryTarget(originalPath: string, repositoryPath: string): boolean {
	if (originalPath.endsWith("/")) {
		return true;
	}

	const basename = path.posix.basename(repositoryPath);
	return !basename.includes(".");
}

/**
 * 把单个链接目标规范化为指向指定 tag 的 GitHub 绝对链接，处理顺序：
 * 1. 旧仓库地址重写到新仓库；
 * 2. `blob|tree/main|master/` 这类「浮动分支引用」改写为具体 tag，把链接钉在该版本；
 * 3. 锚点（`#...`）、协议相对（`//...`）、带 scheme 的 URL 原样返回；
 * 4. 其余按仓库内相对路径处理，拼成 `{blob|tree}/{tag}/{路径}` 形式。
 */
function normalizeChangelogLinkTarget(target: string, tag: string): string {
	let canonicalTarget = target.replace(LEGACY_REPO_RE, `https://github.com/${GITHUB_REPO}`);
	const repoUrl = `https://github.com/${GITHUB_REPO}`;

	// 把指向 main/master 的浮动引用替换为具体 tag，避免后续提交让链接指向漂移
	for (const route of ["blob", "tree"]) {
		for (const branch of ["main", "master"]) {
			const floatingRefPrefix = `${repoUrl}/${route}/${branch}/`;
			if (canonicalTarget.startsWith(floatingRefPrefix)) {
				canonicalTarget = `${repoUrl}/${route}/${tag}/${canonicalTarget.slice(floatingRefPrefix.length)}`;
			}
		}
	}

	if (canonicalTarget.startsWith("#") || canonicalTarget.startsWith("//") || URL_SCHEME_RE.test(canonicalTarget)) {
		return canonicalTarget;
	}

	const { fragment, pathPart, query } = splitLocalTarget(canonicalTarget);
	if (!pathPart) {
		return canonicalTarget;
	}

	const repositoryPath = resolveRepositoryPath(pathPart);
	if (!repositoryPath) {
		return canonicalTarget;
	}

	const route = isDirectoryTarget(pathPart, repositoryPath) ? "tree" : "blob";
	return `https://github.com/${GITHUB_REPO}/${route}/${tag}/${encodeURI(repositoryPath)}${query}${fragment}`;
}

/**
 * 规范化 CHANGELOG 正文中所有行内 Markdown 链接。
 * 对每个链接的目标部分调用 {@link normalizeChangelogLinkTarget}，链接文字等其余部分保持不变。
 *
 * @param markdown - CHANGELOG 条目正文
 * @param version - 用于钉住链接的版本（字符串或条目对象）
 * @returns 链接已重写为 GitHub 绝对地址的 Markdown 文本
 */
export function normalizeChangelogLinks(markdown: string, version: string | ChangelogEntry): string {
	const tag = normalizeTag(version);
	return markdown.replace(INLINE_MARKDOWN_LINK_RE, (_match, prefix, target, suffix) => {
		return `${prefix}${normalizeChangelogLinkTarget(target, tag)}${suffix}`;
	});
}

/**
 * 从 CHANGELOG.md 解析版本条目。
 * 逐行扫描 `## ` 开头的版本标题，收集标题下的内容，直到下一个 `## ` 或文件结尾。
 *
 * @param changelogPath - CHANGELOG.md 文件路径
 * @returns 按文件中出现顺序排列的条目数组；文件不存在或读取失败时返回空数组
 */
export function parseChangelog(changelogPath: string): ChangelogEntry[] {
	// 文件不存在（如开发环境未包含 CHANGELOG）不算错误，直接返回空
	if (!existsSync(changelogPath)) {
		return [];
	}

	try {
		const content = readFileSync(changelogPath, "utf-8");
		const lines = content.split("\n");
		const entries: ChangelogEntry[] = [];

		// 状态机：currentVersion 记录当前小节的版本号，currentLines 累积该小节的正文行
		let currentLines: string[] = [];
		let currentVersion: { major: number; minor: number; patch: number } | null = null;

		for (const line of lines) {
			// 版本标题行（形如 ## [x.y.z] - 日期）
			if (line.startsWith("## ")) {
				// 遇到新标题时，先把上一个版本累积的内容存入结果
				if (currentVersion && currentLines.length > 0) {
					entries.push({
						...currentVersion,
						content: currentLines.join("\n").trim(),
					});
				}

				// 尝试从标题行解析 x.y.z 版本号（方括号可有可无）
				const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
				if (versionMatch) {
					currentVersion = {
						major: Number.parseInt(versionMatch[1], 10),
						minor: Number.parseInt(versionMatch[2], 10),
						patch: Number.parseInt(versionMatch[3], 10),
					};
					currentLines = [line];
				} else {
					// 解析不出版本号：重置状态，跳过这个小节
					currentVersion = null;
					currentLines = [];
				}
			} else if (currentVersion) {
				// 普通正文行，累积到当前版本
				currentLines.push(line);
			}
		}

		// 循环结束后保存最后一条（其后没有下一个 ## 标题来触发保存）
		if (currentVersion && currentLines.length > 0) {
			entries.push({
				...currentVersion,
				content: currentLines.join("\n").trim(),
			});
		}

		return entries;
	} catch (error) {
		console.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * 比较两个版本号的大小（major → minor → patch 逐段比较）。
 * @returns v1 < v2 时为 -1，相等时为 0，v1 > v2 时为 1
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * 筛选出严格晚于 lastVersion 的条目，用于展示「自上次运行以来更新了什么」。
 *
 * @param entries - `parseChangelog` 解析出的全部条目
 * @param lastVersion - 上次记录的版本号字符串（如 "1.2.3"）
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	// 把 "x.y.z" 字符串解析成可比较的条目；缺失或非数字的分段按 0 处理
	const parts = lastVersion.split(".").map(Number);
	const last: ChangelogEntry = {
		major: parts[0] || 0,
		minor: parts[1] || 0,
		patch: parts[2] || 0,
		content: "",
	};

	return entries.filter((entry) => compareVersions(entry, last) > 0);
}

// 为方便调用方，从这里重新导出 getChangelogPath（来自 ../config.ts）
export { getChangelogPath } from "../config.ts";
