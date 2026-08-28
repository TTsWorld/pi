/**
 * @file session-export.ts —— 会话导出为 JSONL
 *
 * @description
 * 把当前会话分支（含会话头与可选的导出专属尾部条目）
 * 逐行序列化为 JSONL 文件写入磁盘，用于会话备份与再导入。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionManager } from "./session-manager.ts";

/**
 * 把当前会话分支与可选的「仅导出」尾部条目写为 JSONL 文件。
 *
 * @param sessionManager - 会话管理器（提供会话 id、cwd 与当前分支）
 * @param outputPath - 输出路径；缺省为 `session-<时间戳>.jsonl`
 * @param createTrailingEntries - 追加导出专属尾部条目的工厂（如分享提示）
 * @returns 实际写入的文件路径
 */
export function exportSessionToJsonl(
	sessionManager: SessionManager,
	outputPath?: string,
	createTrailingEntries?: (parentId: string | null, timestamp: string) => readonly object[],
): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	// 组装会话头：带版本号、会话 id 与导出时刻的 cwd
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: sessionManager.getSessionId(),
		timestamp,
		cwd: sessionManager.getCwd(),
	};
	const lines = [JSON.stringify(header)];

	// 逐条写出当前分支，为每条补上 parentId 形成链式结构
	let parentId: string | null = null;
	for (const entry of sessionManager.getBranch()) {
		lines.push(JSON.stringify({ ...entry, parentId }));
		parentId = entry.id;
	}
	// 追加仅出现在导出文件里的尾部条目（不进入会话历史）
	for (const entry of createTrailingEntries?.(parentId, timestamp) ?? []) {
		lines.push(JSON.stringify(entry));
	}

	writeFileSync(filePath, `${lines.join("\n")}\n`);
	return filePath;
}
