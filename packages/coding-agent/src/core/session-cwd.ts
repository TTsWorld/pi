/**
 * @file session-cwd.ts —— 会话工作目录（cwd）有效性检查
 *
 * @description
 * 恢复会话时校验会话文件里记录的工作目录是否仍存在；
 * 失效时生成错误文案 / 交互确认提示，或抛出 MissingSessionCwdError，
 * 由调用方决定回退到当前目录还是终止。
 */
import { existsSync } from "node:fs";

/** 会话 cwd 失效问题的描述信息 */
export interface SessionCwdIssue {
	/** 会话文件路径（可能缺失） */
	sessionFile?: string;
	/** 会话中记录的工作目录（已不存在） */
	sessionCwd: string;
	/** 回退用的当前工作目录 */
	fallbackCwd: string;
}

/** 会话管理器中与 cwd 相关的最小接口（避免依赖具体实现） */
interface SessionCwdSource {
	getCwd(): string;
	getSessionFile(): string | undefined;
}

/**
 * 检查会话 cwd 是否失效：目录不存在时返回问题描述，否则返回 undefined。
 * 没有会话文件或未记录 cwd 时不视为问题。
 */
export function getMissingSessionCwdIssue(
	sessionManager: SessionCwdSource,
	fallbackCwd: string,
): SessionCwdIssue | undefined {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) {
		return undefined;
	}

	const sessionCwd = sessionManager.getCwd();
	// cwd 存在（或未记录）即无问题
	if (!sessionCwd || existsSync(sessionCwd)) {
		return undefined;
	}

	return {
		sessionFile,
		sessionCwd,
		fallbackCwd,
	};
}

/** 格式化为报错文案（含会话文件与当前目录信息） */
export function formatMissingSessionCwdError(issue: SessionCwdIssue): string {
	const sessionFile = issue.sessionFile ? `\nSession file: ${issue.sessionFile}` : "";
	return `Stored session working directory does not exist: ${issue.sessionCwd}${sessionFile}\nCurrent working directory: ${issue.fallbackCwd}`;
}

/** 格式化为交互确认弹窗的提示文案（询问是否改在当前目录继续） */
export function formatMissingSessionCwdPrompt(issue: SessionCwdIssue): string {
	return `cwd from session file does not exist\n${issue.sessionCwd}\n\ncontinue in current cwd\n${issue.fallbackCwd}`;
}

/** 会话 cwd 不存在时抛出的错误，携带问题描述供调用方展示/决策 */
export class MissingSessionCwdError extends Error {
	readonly issue: SessionCwdIssue;

	constructor(issue: SessionCwdIssue) {
		super(formatMissingSessionCwdError(issue));
		this.name = "MissingSessionCwdError";
		this.issue = issue;
	}
}

/** 断言会话 cwd 仍存在；失效则抛出 MissingSessionCwdError */
export function assertSessionCwdExists(sessionManager: SessionCwdSource, fallbackCwd: string): void {
	const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
	if (issue) {
		throw new MissingSessionCwdError(issue);
	}
}
