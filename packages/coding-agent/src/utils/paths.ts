/**
 * @file paths.ts \u2014\u2014 \u8DEF\u5F84\u89C4\u8303\u5316\u4E0E\u89E3\u6790\u5DE5\u5177\u96C6
 *
 * @description
 * \u9762\u5411\u7528\u6237\u8F93\u5165\u7684\u8DEF\u5F84\u5904\u7406\uFF1A`~` \u5C55\u5F00\u3001`file://` URL \u8F6C\u6362\u3001Unicode \u7A7A\u683C\u5F52\u4E00\u5316\u3001
 * Windows \u4E0B Git Bash/MSYS/Cygwin/WSL \u8DEF\u5F84\u4FEE\u6B63\uFF0C\u4EE5\u53CA\u628A\u7EDD\u5BF9\u8DEF\u5F84\u663E\u793A\u4E3A
 * \u76F8\u5BF9\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\u7684\u77ED\u8DEF\u5F84\u7B49\u3002\u6B64\u5916\u63D0\u4F9B\u6587\u4EF6\u4FEE\u8BA2\u6807\u8BC6\uFF08\u7528\u4E8E\u53D8\u66F4\u68C0\u6D4B\uFF09\u4E0E
 * \u4E91\u540C\u6B65\u5FFD\u7565\u6807\u8BB0\uFF08\u907F\u514D\u4F1A\u8BDD\u6587\u4EF6\u88AB Dropbox/iCloud \u540C\u6B65\uFF09\u3002
 *
 * \u4F9D\u8D56\u5173\u7CFB\uFF1A
 * - `node:fs` / `node:os` / `node:path` / `node:url`\uFF1A\u57FA\u7840\u8DEF\u5F84\u4E0E\u6587\u4EF6\u7CFB\u7EDF\u80FD\u529B\uFF1B
 * - `./child-process.ts`\uFF1A\u8C03\u7528 xattr / setfattr \u8BBE\u7F6E\u6269\u5C55\u5C5E\u6027\u3002
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as nodeResolvePath, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./child-process.ts";

// \u5404\u7C7B Unicode \u7A7A\u767D\u53D8\u4F53\uFF08\u4E0D\u95F4\u65AD\u7A7A\u683C\u3001\u5404\u79CD\u5BBD\u5EA6\u7684\u7A7A\u683C\u7B49\uFF09\u2192 \u666E\u901A\u7A7A\u683C
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** normalizePath / resolvePath \u7684\u884C\u4E3A\u5F00\u5173\uFF08\u6309\u9700\u7EC4\u5408\uFF0C\u9ED8\u8BA4\u4EC5\u5C55\u5F00 `~`\uFF09 */
export interface PathInputOptions {
	/** \u89C4\u8303\u5316\u524D\u5148\u53BB\u6389\u9996\u5C3E\u7A7A\u767D\u3002 */
	trim?: boolean;
	/** \u628A\u5F00\u5934\u7684 `~` \u5C55\u5F00\u4E3A\u7528\u6237\u4E3B\u76EE\u5F55\u3002\u9ED8\u8BA4 true\u3002 */
	expandTilde?: boolean;
	/** `~` \u5C55\u5F00\u6240\u7528\u7684\u4E3B\u76EE\u5F55\u3002\u9ED8\u8BA4 `os.homedir()`\u3002 */
	homeDir?: string;
	/** \u53BB\u6389\u5F00\u5934\u7684 `@`\uFF08\u7528\u4E8E CLI \u7684 @file \u8DEF\u5F84\uFF09\u3002 */
	stripAtPrefix?: boolean;
	/** \u628A Unicode \u7A7A\u683C\u53D8\u4F53\u5F52\u4E00\u5316\u4E3A\u666E\u901A\u7A7A\u683C\u3002 */
	normalizeUnicodeSpaces?: boolean;
}

/**
 * \u628A\u8DEF\u5F84\u89E3\u6790\u4E3A\u89C4\u8303\uFF08\u771F\u5B9E\uFF09\u5F62\u5F0F\uFF0C\u8DDF\u968F\u7B26\u53F7\u94FE\u63A5\u3002
 * \u89E3\u6790\u5931\u8D25\uFF08\u5982\u76EE\u6807\u5C1A\u4E0D\u5B58\u5728\uFF09\u65F6\u9000\u56DE\u539F\u59CB\u8DEF\u5F84\uFF0C
 * \u4FDD\u8BC1\u8C03\u7528\u65B9\u4E0D\u4F1A\u56E0\u4E3A\u6587\u4EF6\u7CFB\u7EDF\u6761\u76EE\u7F3A\u5931\u800C\u5D29\u6E83\u3002
 */
export function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * \u751F\u6210\u6587\u4EF6\u7684\u4FEE\u8BA2\u6807\u8BC6\uFF1A\u8BBE\u5907\u53F7:inode:\u5927\u5C0F:mtime:ctime\uFF08\u7EB3\u79D2\u7EA7\uFF09\u3002
 * \u4EFB\u610F\u4E00\u9879\u53D8\u5316\u90FD\u4F1A\u5F97\u5230\u4E0D\u540C\u7684\u5B57\u7B26\u4E32\uFF0C\u53EF\u7528\u4E8E\u68C0\u6D4B\u6587\u4EF6\u5185\u5BB9/\u5143\u6570\u636E\u662F\u5426\u53D8\u52A8\uFF1B
 * \u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u8BFB\u53D6\u5931\u8D25\u8FD4\u56DE undefined\u3002
 */
export function getFileRevision(path: string): string | undefined {
	try {
		const stats = statSync(path, { bigint: true });
		return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return undefined;
	}
}

/**
 * 判断值是否为本地路径：非包来源（npm:、git: 等）且非远程 URL 协议时返回 true。
 * 裸名称、相对路径与 file: URL 都视为本地。
 */
export function isLocalPath(value: string): boolean {
	const trimmed = value.trim();
	// 已知的非本地前缀。file: URL 属于本地路径，特意留给 resolvePath() 解析。
	if (
		trimmed.startsWith("npm:") ||
		trimmed.startsWith("git:") ||
		trimmed.startsWith("github:") ||
		trimmed.startsWith("http:") ||
		trimmed.startsWith("https:") ||
		trimmed.startsWith("ssh:")
	) {
		return false;
	}
	return true;
}

/** 把 Git Bash、MSYS、Cygwin、WSL 的盘符路径转换为 Windows 原生 API 接受的形式（如 /c/foo → C:\foo）。 */
export function normalizeWindowsShellPath(filePath: string): string {
	// 非 `/` 开头（已是 Windows 形式）、UNC 路径（//开头）或已含反斜杠的都不处理
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	// 匹配 /c、/c/...、/mnt/c、/cygdrive/c 及其子路径
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!match) return filePath;
	const suffix = match[2]?.replaceAll("/", "\\");
	return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * 规范化用户输入的单条路径（不解析为绝对路径）。
 * 处理顺序：可选 trim → Unicode 空格归一化 → 去除 `@` 前缀 →
 * Windows shell 路径修正 → 展开 `~` → 转换 `file://` URL。
 */
export function normalizePath(input: string, options: PathInputOptions = {}): string {
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}
	if (process.platform === "win32") {
		normalized = normalizeWindowsShellPath(normalized);
	}

	if (options.expandTilde ?? true) {
		const home = options.homeDir ?? homedir();
		// 单独的 "~" 即主目录本身
		if (normalized === "~") return home;
		// "~/..."（Windows 上还接受 "~\..."）展开为主目录下的子路径
		if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
			return join(home, normalized.slice(2));
		}
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized);
	}

	return normalized;
}

/**
 * 把用户输入解析为绝对路径：先各自规范化，再相对 baseDir 解析。
 * @param input - 用户输入的路径（可为相对路径、`~` 路径或 file: URL）
 * @param baseDir - 相对路径的基准目录，默认当前工作目录
 */
export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	const normalizedBaseDir = normalizePath(baseDir);
	return isAbsolute(normalized) ? nodeResolvePath(normalized) : nodeResolvePath(normalizedBaseDir, normalized);
}

/**
 * 把路径转为相对 cwd 的显示形式；路径不在 cwd 之内时返回 undefined。
 * 判定方式：relative() 的结果不是 `..` 开头、也非绝对路径（跨盘符时会得到绝对路径）。
 */
export function getCwdRelativePath(filePath: string, cwd: string): string | undefined {
	const resolvedCwd = resolvePath(cwd);
	const resolvedPath = resolvePath(filePath, resolvedCwd);
	const relativePath = relative(resolvedCwd, resolvedPath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));

	// 相对路径为空说明正是 cwd 本身，显示为 "."
	return isInsideCwd ? relativePath || "." : undefined;
}

/**
 * 面向展示的路径格式化：优先显示为相对 cwd 的短路径，否则退回绝对路径；
 * 统一把平台分隔符换成 `/`，便于日志与 UI 呈现。
 */
export function formatPathRelativeToCwdOrAbsolute(filePath: string, cwd: string): string {
	const absolutePath = resolvePath(filePath, cwd);
	return (getCwdRelativePath(absolutePath, cwd) ?? absolutePath).split(sep).join("/");
}

/**
 * 给文件打上云同步忽略标记（macOS：Dropbox 与 iCloud/fileprovider；
 * Linux：Dropbox 的 user.xattr），避免会话数据被云端同步搅乱。
 * 命令失败静默忽略——这只是尽力而为的优化。
 */
export function markPathIgnoredByCloudSync(path: string): void {
	// 各平台对应的扩展属性名；Windows 无对应机制，为空数组
	const attrs =
		process.platform === "darwin"
			? ["com.dropbox.ignored", "com.apple.fileprovider.ignore#P"]
			: process.platform === "linux"
				? ["user.com.dropbox.ignored"]
				: [];

	for (const attr of attrs) {
		// macOS 用 xattr、Linux 用 setfattr 写入扩展属性
		if (process.platform === "darwin") {
			spawnProcessSync("xattr", ["-w", attr, "1", path], { encoding: "utf-8", stdio: "ignore" });
		} else {
			spawnProcessSync("setfattr", ["-n", attr, "-v", "1", path], { encoding: "utf-8", stdio: "ignore" });
		}
	}
}
