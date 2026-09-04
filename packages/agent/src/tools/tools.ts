/**
 * @file tools.ts
 * @description Agent 工具系统 —— read/list/bash/glob/rg 五个工具的定义与执行
 * @module pi-agent
 *
 * 主要功能：
 * - 以双格式导出工具定义：toolsForResponses（OpenAI Responses API 的原生函数定义）
 *   与 toolsForChat（Chat Completions API 的 ChatCompletionTool 映射）
 * - executeTool() 按工具名统一分发执行：read（1MB 截断保护）、list、bash（spawn + shell）、
 *   glob（glob 库模式匹配）、rg（拼接 ripgrep 命令行）
 * - execWithAbort() 提供子进程执行基建：stdout/stderr 各 1MB 输出上限、AbortSignal 中断（SIGTERM）
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { glob } from "glob";
import type { ChatCompletionTool } from "openai/resources";

/**
 * Responses API 格式的工具定义数组（原生函数定义，供 GPT-OSS 等模型经 Responses API 使用）。
 *
 * 双格式差异说明：OpenAI Responses API 采用扁平结构（name/description/parameters
 * 直接平铺在顶层）；而 Chat Completions API 要求嵌套结构（见 toolsForChat 的映射）。
 * 本数组是工具定义的"单一数据源"，toolsForChat 由它映射派生。
 */
export const toolsForResponses = [
	/**
	 * 工具 read：读取指定文件的内容。
	 * - 参数：path（必填）—— 要读取的文件路径
	 * - 行为：文件超过 1MB 时只读取前 1MB，并附加截断提示
	 */
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
	/**
	 * 工具 list：列出指定目录的内容。
	 * - 参数：path（可选）—— 目标目录路径，默认为当前目录
	 * - 行为：目录项以 / 后缀标记，便于区分文件与目录
	 */
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
	/**
	 * 工具 bash：在 Bash 中执行命令。
	 * - 参数：command（必填）—— 要执行的命令
	 * - 行为：经 execWithAbort（spawn + shell）执行，stdout/stderr 各 1MB 上限，
	 *   支持 AbortSignal 中断（SIGTERM 终止子进程）
	 */
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
	/**
	 * 工具 glob：按 glob 模式查找匹配的文件。
	 * - 参数：pattern（必填）—— glob 模式，如用 "**" 递归匹配所有 .ts 文件；
	 *   path（可选）—— 搜索目录，默认为当前目录
	 * - 行为：包含隐藏文件（dot: true），目录项带 / 后缀（mark: true）
	 */
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
	/**
	 * 工具 rg：使用 ripgrep 搜索文件内容。
	 * - 参数：args（必填）—— 直接透传给 ripgrep 的参数串（如 "-l prompt"、"-i TODO"、
	 *   "--type ts className"），搜索模式外不要加引号
	 * - 行为：拼接为 "rg <args> < /dev/null" 执行，重定向 stdin 防止 rg 挂起等待输入
	 */
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
 * Chat Completions API 格式的工具定义数组（OpenAI 标准聊天 API 格式）。
 *
 * 双格式差异说明：Chat Completions API 要求工具定义嵌套在 function 字段内
 * （{ type: "function", function: { name, description, parameters } }），
 * 与 Responses API 的扁平结构不同。因此这里直接由 toolsForResponses 映射派生，
 * 保证两份定义内容始终一致，避免手工维护两份。
 */
export const toolsForChat: ChatCompletionTool[] = toolsForResponses.map((tool) => ({
	type: "function" as const,
	function: {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	},
}));

/**
 * 带中断（abort）支持的命令执行辅助函数（bash/rg 工具的底层实现）。
 *
 * 通过 spawn + shell 执行命令，内置三重保护：
 * - 输出上限：stdout/stderr 各 1MB，超出后丢弃后续数据并附加一次截断标记，
 *   防止超长输出（如 cat 大文件）撑爆模型上下文
 * - 中断支持：监听 AbortSignal，触发时向子进程发送 SIGTERM 终止
 * - 退出码容错：ripgrep 等工具退出码 1 表示"无匹配"而非执行错误，特殊处理为正常返回
 *
 * @param command 要执行的完整命令行（经 shell 解释）
 * @param signal 可选的中断信号，触发时终止子进程并以 "Interrupted" 错误拒绝
 * @returns 命令的 stdout（无 stdout 时回退到 stderr）
 */
async function execWithAbort(command: string, signal?: AbortSignal): Promise<string> {
	// 注意：Promise 回调参数 resolve 遮蔽了顶部导入的 node:path 的 resolve，本函数内未用到后者
	return new Promise((resolve, reject) => {
		// 以 shell 模式启动子进程，命令字符串交由 shell 解释执行
		const child = spawn(command, {
			shell: true,
			signal,
		});

		let stdout = "";
		let stderr = "";
		const MAX_OUTPUT_SIZE = 1024 * 1024; // 输出上限 1MB
		let outputTruncated = false; // 截断标记：保证截断提示只追加一次

		child.stdout?.on("data", (data) => {
			// 累积标准输出；超过 1MB 后丢弃后续 chunk，仅追加一次截断提示
			const chunk = data.toString();
			if (stdout.length + chunk.length > MAX_OUTPUT_SIZE) {
				if (!outputTruncated) {
					stdout += "\n... [Output truncated - exceeded 1MB limit] ...";
					outputTruncated = true;
				}
			} else {
				stdout += chunk;
			}
		});

		child.stderr?.on("data", (data) => {
			// 标准错误流同样应用 1MB 上限保护（与 stdout 共用截断标记）
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

		child.on("error", (error) => {
			// 进程本身启动失败（如 shell 不可用）时直接以错误拒绝
			reject(error);
		});

		child.on("close", (code) => {
			if (signal?.aborted) {
				// 被中断的进程统一以 "Interrupted" 拒绝，供上层（executeTool）识别后原样向上抛出
				reject(new Error("Interrupted"));
			} else if (code !== 0 && code !== null) {
				// Why：部分命令（如 ripgrep）退出码 1 属正常语义——"无匹配"，并非执行出错
				if (code === 1 && command.includes("rg")) {
					resolve(""); // ripgrep 无匹配：返回空字符串，由调用方转为 "No matches found"
				} else if (stderr && !stdout) {
					// 无标准输出但有标准错误：把 stderr 内容作为错误信息抛出
					reject(new Error(stderr));
				} else {
					resolve(stdout || "");
				}
			} else {
				// 正常退出（code 为 0 或 null）：优先返回 stdout，无则回退到 stderr
				resolve(stdout || stderr || "");
			}
		});

		// 监听 abort 信号：一旦触发立即向子进程发送 SIGTERM 终止（只监听一次）
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
 * 统一的工具执行入口：按工具名分发到对应的处理分支。
 *
 * 容错设计：参数缺失、路径不存在、未知工具名等可预期问题一律以错误字符串返回
 * （而非抛异常），让模型能读到错误描述并自行调整重试，同时保证 agent 主循环
 * 不被意外输入打断；仅"用户中断"与命令执行失败才向上抛出异常。
 *
 * @param name 工具名称（read/list/bash/glob/rg）
 * @param args JSON 字符串形式的工具参数（内部统一 JSON.parse 解析）
 * @param signal 可选的中断信号，透传给 bash/rg 等基于子进程的工具
 * @returns 工具执行结果字符串（成功内容或错误描述）
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

			// 读取前先检查文件大小
			const stats = statSync(file);
			const MAX_FILE_SIZE = 1024 * 1024; // 文件大小上限 1MB
			if (stats.size > MAX_FILE_SIZE) {
				// Why：超大文件整体读入会撑爆模型上下文，因此只读取前 1MB 并附加截断提示
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
			const path = parsed.path || "."; // 未指定路径时默认为当前目录
			const dir = resolve(path);
			if (!existsSync(dir)) return `Directory not found: ${dir}`;
			const entries = readdirSync(dir, { withFileTypes: true });
			// 目录名追加 / 后缀，便于模型一眼区分目录与文件
			return entries.map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name)).join("\n");
		}

		// ========== bash：执行 Bash 命令 ==========
		case "bash": {
			const command = parsed.command;
			if (!command) return "Error: command parameter is required";
			try {
				const output = await execWithAbort(command, signal);
				// 命令无任何输出时返回明确的成功提示，避免模型误判为失败
				return output || "Command executed successfully";
			} catch (e: any) {
				if (e.message === "Interrupted") {
					throw e; // 中断异常必须原样向上抛出，由 agent 主循环终止当前轮次
				}
				throw new Error(`Command failed: ${e.message}`);
			}
		}

		// ========== glob：按模式查找文件 ==========
		case "glob": {
			const pattern = parsed.pattern;
			if (!pattern) return "Error: pattern parameter is required";
			const searchPath = parsed.path || process.cwd(); // 未指定路径时默认为当前工作目录

			try {
				const matches = await glob(pattern, {
					cwd: searchPath,
					dot: true, // 匹配以 . 开头的隐藏文件/目录
					nodir: false, // 结果中保留目录（不排除）
					mark: true, // 给目录名追加 / 后缀
				});

				if (matches.length === 0) {
					return "No files found matching the pattern";
				}

				// 排序后按行拼接返回（注：sort() 实际为字典序；原英文注释称"按修改时间"与实现不符）
				return matches.sort().join("\n");
			} catch (e: any) {
				// glob 失败返回错误字符串而非抛异常，便于模型调整模式后重试
				return `Glob error: ${e.message}`;
			}
		}

		// ========== rg：ripgrep 内容搜索 ==========
		case "rg": {
			const args = parsed.args;
			if (!args) return "Error: args parameter is required";

			// Why：拼接 "< /dev/null" 将 stdin 重定向到空设备，强制 ripgrep 永不读取
			// 标准输入——否则某些参数组合下 rg 会挂起等待终端输入，导致工具卡死
			const cmd = `rg ${args} < /dev/null`;

			try {
				const output = await execWithAbort(cmd, signal);
				// 退出码 1（无匹配）在 execWithAbort 中被解析为空字符串，这里转为明确提示
				return output.trim() || "No matches found";
			} catch (e: any) {
				if (e.message === "Interrupted") {
					throw e; // 中断异常必须原样向上抛出，由 agent 主循环终止当前轮次
				}
				// rg 执行失败返回错误字符串而非抛异常，便于模型调整参数后重试
				return `ripgrep error: ${e.message}`;
			}
		}

		// 未知工具：返回错误字符串而非抛异常（容错设计），保证主循环不中断
		default:
			return `Unknown tool: ${name}`;
	}
}
