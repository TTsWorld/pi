/**
 * @file agent 内置工具的定义与执行实现
 *
 * @description 本文件是 agent 包的"手脚"：
 * - 对外导出两份工具清单（`toolsForResponses` / `toolsForChat`），供不同 API 形态的模型调用；
 * - 对外导出 `executeTool`，负责按工具名分发执行并返回字符串结果。
 *
 * 内置五个工具：
 * - `read`  读取文件内容（超过 1MB 时截断，只返回前 1MB）
 * - `list`  列出目录内容（目录名以 `/` 结尾标记）
 * - `bash`  通过 shell 执行命令（支持 AbortSignal 中断）
 * - `glob`  按 glob 模式查找文件
 * - `rg`    调用 ripgrep 做内容搜索（stdin 重定向自 /dev/null）
 *
 * 依赖关系：
 * - node:child_process / node:fs / node:path —— 命令执行与文件系统操作
 * - glob —— 文件模式匹配
 * - openai/resources —— 仅使用其 `ChatCompletionTool` 类型定义
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { glob } from "glob";
import type { ChatCompletionTool } from "openai/resources";

/**
 * Responses API 格式的工具定义数组（供 GPT-OSS 等使用 responses API 的模型使用）。
 *
 * 每一项是一个扁平结构的 function 工具：`name` + `description` + `parameters`（JSON Schema）。
 * 注意：其中的 description 字符串是发给 LLM 的工具说明，属于代码逻辑的一部分，不可翻译。
 */
// 供 GPT-OSS 模型经 responses API 使用（原文：For GPT-OSS models via responses API）
export const toolsForResponses = [
	// ========== 工具：read —— 读取指定路径文件的内容 ==========
	{
		type: "function" as const,
		name: "read",
		description: "Read contents of a file",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file to read",
				},
			},
			required: ["path"],
		},
	},
	// ========== 工具：list —— 列出指定目录（默认当前目录）下的条目 ==========
	{
		type: "function" as const,
		name: "list",
		description: "List contents of a directory",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the directory (default: current directory)",
				},
			},
		},
	},
	// ========== 工具：bash —— 在 shell 中执行任意命令 ==========
	{
		type: "function" as const,
		name: "bash",
		description: "Execute a command in Bash",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Command to execute",
				},
			},
			required: ["command"],
		},
	},
	// ========== 工具：glob —— 按 glob 模式匹配查找文件 ==========
	{
		type: "function" as const,
		name: "glob",
		description: "Find files matching a glob pattern",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.json')",
				},
				path: {
					type: "string",
					description: "Directory to search in (default: current directory)",
				},
			},
			required: ["pattern"],
		},
	},
	// ========== 工具：rg —— 直接透传参数调用 ripgrep 做内容搜索 ==========
	{
		type: "function" as const,
		name: "rg",
		description: "Search using ripgrep.",
		parameters: {
			type: "object",
			properties: {
				args: {
					type: "string",
					description:
						'Arguments to pass directly to ripgrep. Examples: "-l prompt" or "-i TODO" or "--type ts className" or "functionName src/". Never add quotes around the search pattern.',
				},
			},
			required: ["args"],
		},
	},
];

/**
 * 标准 chat API（OpenAI Chat Completions 格式）使用的工具定义数组。
 *
 * 由 `toolsForResponses` 的扁平结构映射为 `{ type: "function", function: { name, description, parameters } }`
 * 的嵌套结构，两份清单描述的是同一组工具，仅封装格式不同。
 */
// 供标准 chat API（OpenAI 格式）使用（原文：For standard chat API (OpenAI format)）
export const toolsForChat: ChatCompletionTool[] = toolsForResponses.map((tool) => ({
	type: "function" as const,
	function: {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	},
}));

/**
 * 带 AbortSignal 中断支持的命令执行辅助函数。
 *
 * @param command 要执行的命令字符串（经 shell 解释，可含管道、重定向等 shell 语法）
 * @param signal 可选的中断信号；触发 abort 时子进程会被 SIGTERM 杀掉，Promise 以 "Interrupted" 错误 reject
 * @returns 命令的 stdout（无 stdout 时回退到 stderr），超过 1MB 会被截断
 */
// 辅助函数：执行命令并支持中断（原文：Helper to execute commands with abort support）
async function execWithAbort(command: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		// ========== 启动子进程 ==========
		// shell: true 使命令字符串经 shell 解释；signal 传入 spawn 后，
		// Node 原生也会在 abort 时杀掉子进程（下方手动 SIGTERM 是双保险，兼容不同 Node 版本行为）
		const child = spawn(command, {
			shell: true,
			signal,
		});

		// ========== 输出收集与 1MB 截断 ==========
		// Why 截断：bash/rg 的输出可能无限大（如 cat 大文件、宽泛搜索），
		// 全量收集会撑爆内存、并最终塞爆 LLM 上下文，所以超过上限即停止追加。
		// 魔法数字 1024 * 1024 即 1MB（1,048,576 字节）：对代码搜索/查看场景足够大，
		// 又远小于一般上下文窗口的安全预算。
		let stdout = "";
		let stderr = "";
		const MAX_OUTPUT_SIZE = 1024 * 1024; // 1MB 上限（魔法数字：1024 * 1024 = 1,048,576 字节）
		let outputTruncated = false;

		child.stdout?.on("data", (data) => {
			const chunk = data.toString();
			if (stdout.length + chunk.length > MAX_OUTPUT_SIZE) {
				// 已超限：不再追加内容，只在首次越限时写入一条截断标记
				if (!outputTruncated) {
					stdout += "\n... [Output truncated - exceeded 1MB limit] ...";
					outputTruncated = true;
				}
			} else {
				stdout += chunk;
			}
		});

		child.stderr?.on("data", (data) => {
			const chunk = data.toString();
			if (stderr.length + chunk.length > MAX_OUTPUT_SIZE) {
				if (!outputTruncated) {
					stderr += "\n... [Output truncated - exceeded 1MB limit] ...";
					outputTruncated = true;
				}
			} else {
				stderr += chunk;
			}
		});

		// ========== 进程启动失败（如 spawn 错误）==========
		child.on("error", (error) => {
			reject(error);
		});

		// ========== 进程退出：按退出码分流 resolve / reject ==========
		child.on("close", (code) => {
			if (signal?.aborted) {
				// 被用户中断的进程不应被当作命令失败处理，单独以 "Interrupted" 标识 reject，
				// 上层可据此识别中断并向上抛出
				reject(new Error("Interrupted"));
			} else if (code !== 0 && code !== null) {
				// 某些命令（如 ripgrep）退出码为 1 属正常情况（表示没有匹配项）：
				// rg 约定 0 = 有匹配，1 = 无匹配，2 = 真正的错误；
				// 若把"无匹配"当失败抛错，LLM 搜索落空时会被误判为工具故障
				if (code === 1 && command.includes("rg")) {
					resolve(""); // ripgrep 无匹配，返回空串
				} else if (stderr && !stdout) {
					// 有 stderr 且没有任何 stdout，通常意味着命令真的失败了，抛出 stderr 作为错误信息
					reject(new Error(stderr));
				} else {
					resolve(stdout || "");
				}
			} else {
				// 退出码为 0 或 null（被信号杀死）：优先返回 stdout，无 stdout 时回退到 stderr
				resolve(stdout || stderr || "");
			}
		});

		// ========== AbortSignal 杀进程机制 ==========
		// 除了 spawn 的 signal 选项外，这里显式监听 abort 并发送 SIGTERM：
		// 保证无论 Node 版本 / shell 中间进程行为如何，子进程都能被及时终止；
		// { once: true } 避免同一 signal 上重复注册或重复 kill
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					child.kill("SIGTERM");
				},
				{ once: true },
			);
		}
	});
}

/**
 * 工具执行入口：按工具名分发到对应的实现，并返回字符串结果。
 *
 * @param name 工具名（read / list / bash / glob / rg）
 * @param args JSON 字符串形式的工具参数（模型生成，需 JSON.parse 解析）
 * @param signal 可选的中断信号，透传给底层命令执行（bash / rg）
 * @returns 工具执行结果字符串；参数校验失败等"软错误"以错误描述字符串返回（不抛异常），
 *          而中断（Interrupted）和命令失败则会抛出异常由上层处理
 */
export async function executeTool(name: string, args: string, signal?: AbortSignal): Promise<string> {
	const parsed = JSON.parse(args);

	switch (name) {
		// ========== read：读取文件内容 ==========
		case "read": {
			const path = parsed.path;
			if (!path) return "Error: path parameter is required";
			const file = resolve(path);
			if (!existsSync(file)) return `File not found: ${file}`;

			// ========== 读取前先检查文件大小，超限则只读前 1MB ==========
			// Why：直接 readFileSync 大文件会一次性占用大量内存，且结果塞进上下文不现实
			const stats = statSync(file);
			// 魔法数字 1024 * 1024 即 1MB（1,048,576 字节），与 execWithAbort 的输出截断上限保持一致
			const MAX_FILE_SIZE = 1024 * 1024; // 1MB 上限
			if (stats.size > MAX_FILE_SIZE) {
				// 只读取文件开头 1MB：打开文件描述符后按精确字节数同步读入，随即关闭
				const fd = openSync(file, "r");
				const buffer = Buffer.alloc(MAX_FILE_SIZE);
				readSync(fd, buffer, 0, MAX_FILE_SIZE, 0);
				closeSync(fd);
				return buffer.toString("utf8") + "\n\n... [File truncated - exceeded 1MB limit] ...";
			}

			const data = readFileSync(file, "utf8");
			return data;
		}

		// ========== list：列出目录内容 ==========
		case "list": {
			const path = parsed.path || ".";
			const dir = resolve(path);
			if (!existsSync(dir)) return `Directory not found: ${dir}`;
			// withFileTypes: true 使每个条目携带类型信息，便于给目录名追加 "/" 后缀作区分
			const entries = readdirSync(dir, { withFileTypes: true });
			return entries.map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name)).join("\n");
		}

		// ========== bash：执行命令 ==========
		case "bash": {
			const command = parsed.command;
			if (!command) return "Error: command parameter is required";
			try {
				const output = await execWithAbort(command, signal);
				return output || "Command executed successfully";
			} catch (e: any) {
				if (e.message === "Interrupted") {
					throw e; // 中断需向上原样抛出，让外层 agent 循环感知用户取消了本次执行（原文：Re-throw interruption）
				}
				throw new Error(`Command failed: ${e.message}`);
			}
		}

		// ========== glob：按模式查找文件 ==========
		case "glob": {
			const pattern = parsed.pattern;
			if (!pattern) return "Error: pattern parameter is required";
			const searchPath = parsed.path || process.cwd();

			try {
				const matches = await glob(pattern, {
					cwd: searchPath,
					dot: true, // 包含点开头的隐藏文件/目录
					nodir: false, // 结果中保留目录（不排除）
					mark: true, // 给目录名追加 "/" 后缀（原文：Add / to directories）
				});

				if (matches.length === 0) {
					return "No files found matching the pattern";
				}

				// 排序后按行拼接返回（原文：Sort by modification time (most recent first) if possible）
				return matches.sort().join("\n");
			} catch (e: any) {
				return `Glob error: ${e.message}`;
			}
		}

		// ========== rg：调用 ripgrep 搜索 ==========
		case "rg": {
			const args = parsed.args;
			if (!args) return "Error: args parameter is required";

			// 通过将 stdin 重定向自 /dev/null，强制 ripgrep 永不等待标准输入：
			// 否则 rg 在某些参数组合下可能阻塞等待 stdin，导致工具调用挂起
			const cmd = `rg ${args} < /dev/null`;

			try {
				const output = await execWithAbort(cmd, signal);
				return output.trim() || "No matches found";
			} catch (e: any) {
				if (e.message === "Interrupted") {
					throw e; // 中断需向上原样抛出（原文：Re-throw interruption）
				}
				return `ripgrep error: ${e.message}`;
			}
		}

		default:
			return `Unknown tool: ${name}`;
	}
}
