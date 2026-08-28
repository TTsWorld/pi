/**
 * @file git.ts —— git 仓库 URL 的解析与安全校验
 *
 * @description
 * 用于「从 git URL 安装」类功能：把用户提供的各式 git 地址
 * （scp 风格、https/ssh/git 协议、简写形式，可附带 @ref 后缀）
 * 解析为结构化的 GitSource，并拒绝可能触发路径穿越等
 * 安全问题的 host/path 组合。
 *
 * 主要功能点：
 * - `splitRef`：从 URL 中剥离 `user/repo@ref` 形式的 ref 后缀；
 * - `parseGitUrl`：主入口，先借助 hosted-git-info 识别主流托管平台
 *   的历史简写形式，失败后再走通用解析；
 * - `hasUnsafeGitInstallPart`：对 host/path 做安全校验
 *  （null 字节、反斜杠、绝对路径、`..` 穿越，且需同时检查
 *   URL 编码前后的两种形态）；
 * - 无 `git:` 前缀的输入只接受显式协议 URL，防止把任意字符串
 *   误当作 git 源。
 *
 * 依赖关系：
 * - `hosted-git-info`：识别 GitHub/GitLab/Bitbucket 等平台的 URL 变体。
 */

import hostedGitInfo from "hosted-git-info";

/** 解析后的 git URL 结构化信息 */
export type GitSource = {
	/** git 源固定为 "git" */
	type: "git";
	/** 克隆用 URL（已去掉 ref 后缀，可直接用于 git clone） */
	repo: string;
	/** git 托管域名（如 "github.com"） */
	host: string;
	/** 仓库路径（如 "user/repo"） */
	path: string;
	/** 指定时携带的 git ref（分支、标签或 commit） */
	ref?: string;
	/** 是否显式指定了 ref（为 true 时包不会被自动更新） */
	pinned: boolean;
};

/**
 * 从 URL 中分离出仓库地址与可选的 `@ref` 后缀。
 * 依次处理三种形态：scp 风格（git@host:path）、带协议的 URL、
 * 以及 host/path 简写。任何不合法的情况（如 ref 为空）都原样返回，
 * 交由后续解析兜底。
 */
function splitRef(url: string): { repo: string; ref?: string } {
	// ===== 形态一：scp 风格 git@host:path（可选 @ref） =====
	const scpLikeMatch = url.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		const pathWithMaybeRef = scpLikeMatch[2] ?? "";
		// 路径中第一个 "@" 之后的内容视为 ref（路径本身不会含 @）
		const refSeparator = pathWithMaybeRef.indexOf("@");
		if (refSeparator < 0) return { repo: url };
		const repoPath = pathWithMaybeRef.slice(0, refSeparator);
		const ref = pathWithMaybeRef.slice(refSeparator + 1);
		if (!repoPath || !ref) return { repo: url };
		return {
			repo: `git@${scpLikeMatch[1] ?? ""}:${repoPath}`,
			ref,
		};
	}

	// ===== 形态二：带协议的 URL（https:// 等） =====
	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			const pathWithMaybeRef = parsed.pathname.replace(/^\/+/, "");
			const refSeparator = pathWithMaybeRef.indexOf("@");
			if (refSeparator < 0) return { repo: url };
			const repoPath = pathWithMaybeRef.slice(0, refSeparator);
			const ref = pathWithMaybeRef.slice(refSeparator + 1);
			if (!repoPath || !ref) return { repo: url };
			// 回写去掉 ref 后的路径，并去掉 URL 序列化产生的尾部斜杠
			parsed.pathname = `/${repoPath}`;
			return {
				repo: parsed.toString().replace(/\/$/, ""),
				ref,
			};
		} catch {
			// URL 解析失败（非法地址）：按无 ref 处理
			return { repo: url };
		}
	}

	// ===== 形态三：host/path 简写（可选 @ref） =====
	const slashIndex = url.indexOf("/");
	if (slashIndex < 0) {
		return { repo: url };
	}
	const host = url.slice(0, slashIndex);
	const pathWithMaybeRef = url.slice(slashIndex + 1);
	const refSeparator = pathWithMaybeRef.indexOf("@");
	if (refSeparator < 0) {
		return { repo: url };
	}
	const repoPath = pathWithMaybeRef.slice(0, refSeparator);
	const ref = pathWithMaybeRef.slice(refSeparator + 1);
	if (!repoPath || !ref) {
		return { repo: url };
	}
	return {
		repo: `${host}/${repoPath}`,
		ref,
	};
}

/**
 * 尝试对值做 URL 解码，仅用于校验目的。
 * 解码失败（如非法百分号序列）返回 null——视为不安全。
 */
function decodeForValidation(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

/**
 * 校验 URL 中的 host 或 path 片段是否含有危险内容。
 * 同时检查原始值与其 URL 解码后的形式——攻击者可用编码绕过
 * 只针对原始字符串的检查。命中任一危险特征即返回 true：
 * null 字节、反斜杠、绝对路径、（host 中的）斜杠、`..` 路径穿越。
 *
 * @param value - 待校验的片段
 * @param allowSlash - path 允许含 "/"（user/repo 结构需要），host 不允许
 */
function hasUnsafeGitInstallPart(value: string, allowSlash: boolean): boolean {
	const decoded = decodeForValidation(value);
	if (decoded === null) {
		// 解码失败说明存在非法编码序列，直接判为不安全
		return true;
	}
	const candidates = [value, decoded];
	for (const candidate of candidates) {
		if (candidate.includes("\0") || candidate.includes("\\") || candidate.startsWith("/")) {
			return true;
		}
		if (!allowSlash && candidate.includes("/")) {
			return true;
		}
		if (candidate.split("/").includes("..")) {
			return true;
		}
	}
	return false;
}

/**
 * 组装并最终校验 GitSource：规范化 path（去掉 .git 后缀与前导斜杠）、
 * 要求 host/path 非空且 path 至少含两段（user/repo），并做安全校验。
 * 任一检查不过返回 null。
 */
function buildGitSource(args: { repo: string; host: string; path: string; ref?: string }): GitSource | null {
	if (args.path.startsWith("/")) {
		return null;
	}
	const normalizedPath = args.path.replace(/\.git$/, "").replace(/^\/+/, "");
	// path 少于两段说明缺少 user 或 repo 之一，不是有效的仓库路径
	if (!args.host || !normalizedPath || normalizedPath.split("/").length < 2) {
		return null;
	}
	if (hasUnsafeGitInstallPart(args.host, false) || hasUnsafeGitInstallPart(normalizedPath, true)) {
		return null;
	}

	return {
		type: "git",
		repo: args.repo,
		host: args.host,
		path: normalizedPath,
		ref: args.ref,
		// 指定了 ref 即视为“钉住”固定版本
		pinned: Boolean(args.ref),
	};
}

/**
 * 通用 git URL 解析（不依赖具体托管平台知识）：
 * 支持 scp 风格、协议 URL，以及带点号的 host 简写（如 github.com/user/repo）。
 * 简写形式会补上 https:// 前缀；host 既不含点号也不是 localhost 则拒绝。
 */
function parseGenericGitUrl(url: string): GitSource | null {
	const { repo: repoWithoutRef, ref } = splitRef(url);
	let repo = repoWithoutRef;
	let host = "";
	let path = "";

	const scpLikeMatch = repoWithoutRef.match(/^git@([^:]+):(.+)$/);
	if (scpLikeMatch) {
		// scp 风格：git@host:path
		host = scpLikeMatch[1] ?? "";
		path = scpLikeMatch[2] ?? "";
	} else if (
		repoWithoutRef.startsWith("https://") ||
		repoWithoutRef.startsWith("http://") ||
		repoWithoutRef.startsWith("ssh://") ||
		repoWithoutRef.startsWith("git://")
	) {
		// 显式协议 URL：直接用 URL 解析出 host 与 path
		try {
			const parsed = new URL(repoWithoutRef);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return null;
		}
	} else {
		// host/path 简写：host 必须看起来像域名（含点号）或是 localhost，
		// 防止把任意单词当成主机名
		const slashIndex = repoWithoutRef.indexOf("/");
		if (slashIndex < 0) {
			return null;
		}
		host = repoWithoutRef.slice(0, slashIndex);
		path = repoWithoutRef.slice(slashIndex + 1);
		if (!host.includes(".") && host !== "localhost") {
			return null;
		}
		repo = `https://${repoWithoutRef}`;
	}

	return buildGitSource({ repo, host, path, ref });
}

/**
 * 把 git 源字符串解析为 GitSource（主入口）。
 *
 * 规则：
 * - 带 `git:` 前缀时，接受所有历史遗留的简写形式；
 * - 不带 `git:` 前缀时，只接受显式协议 URL（防止把任意文本当 git 源）。
 *
 * 解析顺序：先用 hosted-git-info 识别「repo#ref」与原始 URL 两种候选，
 * 都不匹配时再给 URL 补 https:// 前缀重试一轮，最后退到通用解析。
 *
 * @param source - 用户输入的 git 源字符串
 * @returns 解析结果；无法识别或校验不通过时返回 null
 */
export function parseGitUrl(source: string): GitSource | null {
	const trimmed = source.trim();
	const hasGitPrefix = trimmed.startsWith("git:");
	const url = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;

	// 无 git: 前缀且不带协议头的输入一律拒绝
	if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(url)) {
		return null;
	}

	const split = splitRef(url);

	// ===== 第一轮：用 hosted-git-info 识别托管平台 URL 变体 =====
	// 候选依次为「repo#ref」（ref 转写成 # 后缀）与原始 URL
	const hostedCandidates = [split.ref ? `${split.repo}#${split.ref}` : undefined, url].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of hostedCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			// project 中出现 "@" 说明 @ref 被误当成了项目名的一部分（如 user/repo@branch
			// 被解析为 project="repo@branch"），该候选不可信，跳过
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			// 简写形式（不带协议、不带 git@）需要补上 https:// 才能用于克隆
			const useHttpsPrefix =
				!split.repo.startsWith("http://") &&
				!split.repo.startsWith("https://") &&
				!split.repo.startsWith("ssh://") &&
				!split.repo.startsWith("git://") &&
				!split.repo.startsWith("git@");
			return buildGitSource({
				repo: useHttpsPrefix ? `https://${split.repo}` : split.repo,
				host: info.domain || "",
				path: `${info.user}/${info.project}`,
				ref: info.committish || split.ref || undefined,
			});
		}
	}

	// ===== 第二轮：补 https:// 前缀后再让 hosted-git-info 试一次 =====
	// 覆盖 "github.com/user/repo" 这类没有显式协议的简写
	const httpsCandidates = [split.ref ? `https://${split.repo}#${split.ref}` : undefined, `https://${url}`].filter(
		(value): value is string => Boolean(value),
	);
	for (const candidate of httpsCandidates) {
		const info = hostedGitInfo.fromUrl(candidate);
		if (info) {
			// 同上：@ref 被误并入项目名时该候选不可信
			if (split.ref && info.project?.includes("@")) {
				continue;
			}
			return buildGitSource({
				repo: `https://${split.repo}`,
				host: info.domain || "",
				path: `${info.user}/${info.project}`,
				ref: info.committish || split.ref || undefined,
			});
		}
	}

	// ===== 第三轮：退化为通用解析（覆盖非主流托管平台） =====
	return parseGenericGitUrl(url);
}
