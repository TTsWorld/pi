/**
 * @file external-editor.ts —— 呼出外部编辑器编辑多行输入
 *
 * @description
 * 交互模式下触发外部编辑时，把当前输入写入临时文件并启动用户配置的
 * $EDITOR（可带参数）；编辑器退出后读回内容作为新输入。全程异步 spawn，
 * finally 中尽力清理临时目录。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";

/** 外部编辑器调用参数 */
export interface ExternalEditorOptions {
	/** 编辑器命令行（可带参数，如 "code --wait"），按空格拆分 */
	command: string;
	/** 写入临时文件的初始内容，即输入框当前文本 */
	content: string;
}

/**
 * 编辑结果：编辑器以退出码 0 结束时为 complete（携带读回的内容）；
 * 启动失败或非零退出码则为 failed（不携带内容，调用方应保留原输入）。
 */
export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

/**
 * 在外部编辑器中编辑一段文本，返回编辑后的内容。
 *
 * 流程：写入临时目录中的 prompt.md → 启动编辑器并等待退出 → 退出码 0 时
 * 读回内容（去 BOM 与末尾换行）；启动失败或非零退出码一律返回 failed。
 */
export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	// .md 后缀让编辑器启用 Markdown 语法高亮
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		// 命令按空格拆分为可执行文件与参数（"code --wait" → ["code", "--wait"]）
		const [editor, ...editorArgs] = options.command.split(" ");
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// 此处绝不能改用 spawnSync：在 Windows 上，同步的 child_process 调用会在
		// 父进程暂停 stdin 后仍保持 Node/libuv 的控制台输入读取，与 vim/nvim
		// 争夺控制台输入缓冲，直到用户按 Ctrl+C 取消挂起的读取。
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				// Windows 上编辑器可能是 .cmd/.bat，需经 shell 解析才能命中可执行文件
				shell: process.platform === "win32",
			});
			// spawn 失败（如命令不存在）以 null 退出码兜底，统一走 failed 分支
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		// stripBom 去 BOM；末尾仅去掉一个换行：编辑器保存时自动补的不算用户输入
		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// 清理是尽力而为：删除失败不影响编辑结果
		}
	}
}
