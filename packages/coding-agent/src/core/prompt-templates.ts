/**
 * @file prompt-templates.ts —— 提示词模板的发现、解析与展开
 *
 * @description
 * 提示词模板是 Markdown 文件（.md），文件名即模板名，正文即提示词内容，
 * 可选 YAML frontmatter 提供 description / argument-hint 元数据。
 * 用户在输入框敲 "/模板名 参数..." 时，由 expandPromptTemplate 把模板正文
 * 中的参数占位符（$1、$@、${N:-default} 等 bash 风格语法）替换为实参后展开。
 *
 * 主要功能点：
 * - `loadPromptTemplates`：从全局目录、项目目录与显式路径三类来源发现模板；
 * - `parseCommandArgs`：bash 风格的参数切分（支持引号包裹含空格的参数）；
 * - `substituteArgs`：占位符替换（位置参数、全量参数、默认值、切片语法）；
 * - `expandPromptTemplate`：识别 "/名字 参数" 形式的输入并完成整个展开流程。
 *
 * 依赖关系：
 * - `./source-info.ts`：为本地文件合成来源信息（user/project 作用域）；
 * - `../utils/frontmatter.ts`：解析 Markdown 头部的 YAML frontmatter。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/**
 * 表示一个从 Markdown 文件加载的提示词模板。
 */
export interface PromptTemplate {
	/** 模板名（即文件名去掉 .md 后缀），用户以 "/名字" 调用 */
	name: string;
	/** 模板描述（来自 frontmatter，缺省时取正文首个非空行） */
	description: string;
	/** 参数提示（来自 frontmatter 的 argument-hint，用于输入框补全提示） */
	argumentHint?: string;
	/** 模板正文（frontmatter 之后的全部内容，含占位符） */
	content: string;
	sourceInfo: SourceInfo;
	filePath: string; // 模板文件的绝对路径
}

/**
 * 解析命令参数字符串，支持 bash 风格的引号包裹（"..." 或 '...'），
 * 引号内的空白不作为分隔符、引号本身不进入参数值。
 * 返回切分后的参数数组。
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i];

		if (inQuote) {
			if (char === inQuote) {
				// 遇到与开头相同的引号：闭合引号，引号字符不进参数
				inQuote = null;
			} else {
				current += char;
			}
		} else if (char === '"' || char === "'") {
			// 进入引号模式；注意不同引号不互嵌（"a'b" 中 ' 视为普通字符）
			inQuote = char;
		} else if (/\s/.test(char)) {
			// 引号外空白：结束当前参数
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}

	// 末尾未跟空格的最后一个参数（未闭合引号按普通字符处理，不报错）
	if (current) {
		args.push(current);
	}

	return args;
}

/**
 * 替换模板正文中的参数占位符。
 * 支持以下语法：
 * - $1、$2、…：位置参数
 * - $@ 与 $ARGUMENTS：全部参数（以空格连接）
 * - ${N:-default}：位置参数 N，缺失或为空时用 default
 * - ${@:-default} 与 ${ARGUMENTS:-default}：全部参数，为空时用 default
 * - ${@:N}：从第 N 个参数起的后缀切片（bash 风格）
 * - ${@:N:L}：从第 N 个参数起取 L 个
 *
 * Note: 替换只作用于模板字符串本身。参数值或默认值里再出现 $1、$@、
 * $ARGUMENTS 等模式也不会被递归替换。
 */
export function substituteArgs(content: string, args: string[]): string {
	// $@ / $ARGUMENTS 的展开形式：全部参数以空格连接成单个字符串
	const allArgs = args.join(" ");

	// 一个正则按序匹配三种形式：${X:-default} / ${@:N[:L]} / $X（X 为 ARGUMENTS、@ 或数字）
	return content.replace(
		/\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
		(_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
			if (defaultTarget) {
				// 带默认值的形式：目标为 @/ARGUMENTS 取全量参数，否则取对应位置参数；为空则回退默认值
				const value =
					defaultTarget === "@" || defaultTarget === "ARGUMENTS" ? allArgs : args[parseInt(defaultTarget, 10) - 1];
				return value ? value : defaultValue;
			}

			if (sliceStart) {
				let start = parseInt(sliceStart, 10) - 1; // 转为 0 起始下标（用户写的是 1 起始）
				// 把 0 当作 1 处理（bash 惯例：参数从 1 开始）
				if (start < 0) start = 0;

				if (sliceLength) {
					const length = parseInt(sliceLength, 10);
					return args.slice(start, start + length).join(" ");
				}
				return args.slice(start).join(" ");
			}

			// 简单形式：$@ / $ARGUMENTS 为全量参数
			if (simple === "ARGUMENTS" || simple === "@") {
				return allArgs;
			}

			// 简单位置参数：越界（不存在的编号）替换为空串
			const index = parseInt(simple, 10) - 1;
			return args[index] ?? "";
		},
	);
}

/**
 * 从单个 Markdown 文件加载模板：解析 frontmatter 与正文，推导 name/description。
 * 读取或解析失败（权限、编码等）返回 null，由调用方跳过该文件。
 */
function loadTemplateFromFile(filePath: string, sourceInfo: SourceInfo): PromptTemplate | null {
	try {
		const rawContent = readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);

		// 模板名即文件名（去掉 .md 后缀）
		const name = basename(filePath).replace(/\.md$/, "");

		// 描述优先取 frontmatter；缺失时回退到正文第一个非空行
		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) {
				// 过长则截断（60 字符），保证列表展示紧凑
				description = firstLine.slice(0, 60);
				if (firstLine.length > 60) description += "...";
			}
		}

		// argument-hint 用条件展开：frontmatter 未提供时整个属性不存在（保持 undefined 语义）
		return {
			name,
			description,
			...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
			content: body,
			sourceInfo,
			filePath,
		};
	} catch {
		// 单个文件读取/解析失败：返回 null 让调用方跳过，不影响其余模板
		return null;
	}
}

/**
 * 扫描目录中的 .md 文件（非递归）并加载为模板。
 * 目录不存在或读取失败时返回已收集到的部分（可能是空数组），不抛错。
 */
function loadTemplatesFromDir(dir: string, getSourceInfo: (filePath: string) => SourceInfo): PromptTemplate[] {
	const templates: PromptTemplate[] = [];

	if (!existsSync(dir)) {
		return templates;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			// 符号链接需 stat 目标来判断其是否为普通文件（dirent 本身只会标记为 symlink）
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isFile = stats.isFile();
				} catch {
					// 指向不存在目标的悬空链接：跳过
					continue;
				}
			}

			// 只收集以 .md 结尾的普通文件（目录、其他扩展名一律忽略）
			if (isFile && entry.name.endsWith(".md")) {
				const template = loadTemplateFromFile(fullPath, getSourceInfo(fullPath));
				if (template) {
					templates.push(template);
				}
			}
		}
	} catch {
		// 目录列举中途失败：返回已收集的部分
		return templates;
	}

	return templates;
}

/** loadPromptTemplates 的加载选项。 */
export interface LoadPromptTemplatesOptions {
	/** 工作目录：用于定位项目级模板目录。 */
	cwd: string;
	/** Agent 配置目录：用于定位全局模板目录。 */
	agentDir: string;
	/** 显式指定的模板路径（文件或目录）。 */
	promptPaths: string[];
	/** 是否加载默认模板目录（全局 + 项目）。 */
	includeDefaults: boolean;
}

/**
 * 从三个来源加载全部提示词模板：
 * 1. 全局：agentDir/prompts/
 * 2. 项目：cwd/{CONFIG_DIR_NAME}/prompts/
 * 3. 显式指定的 promptPaths（文件或目录）
 * 同名模板按加载顺序后者覆盖前者（显式路径优先级最高）。
 */
export function loadPromptTemplates(options: LoadPromptTemplatesOptions): PromptTemplate[] {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const promptPaths = options.promptPaths;
	const includeDefaults = options.includeDefaults;

	const templates: PromptTemplate[] = [];

	// 来源 1/2 的默认目录：全局与项目级 prompts 目录
	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");

	// 判断 target 是否位于 root 目录之下（或恰好等于 root）；比较时补路径分隔符，避免 "/ab" 误命中 "/abc"
	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	// ===== 构建 SourceInfo 工厂 =====
	// 按模板所在目录判定来源作用域：全局目录 → user，项目目录 → project，其余（显式路径）不带作用域
	const getSourceInfo = (resolvedPath: string): SourceInfo => {
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "user",
				baseDir: globalPromptsDir,
			});
		}
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};

	// ===== 加载来源 1/2：默认目录（全局在前、项目在后，与文档中编号一致） =====
	if (includeDefaults) {
		templates.push(...loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		templates.push(...loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}

	// 3. 加载显式指定的模板路径
	for (const rawPath of promptPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const template = loadTemplateFromFile(resolvedPath, getSourceInfo(resolvedPath));
				if (template) {
					templates.push(template);
				}
			}
		} catch {
			// 忽略读取失败（单个坏路径不影响其余模板加载）
		}
	}

	return templates;
}

/**
 * 若输入文本是 "/模板名 参数..." 形式且模板名命中已加载模板，
 * 则切分参数、替换占位符并返回展开后的内容；否则原样返回输入。
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
	// 非 "/" 开头一定不是模板调用，直接返回原文
	if (!text.startsWith("/")) return text;

	// 捕获组 1 = 模板名（到首个空白为止），捕获组 2 = 其余全部作为参数串（可含换行）
	const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match) return text;

	const templateName = match[1];
	const argsString = match[2] ?? "";

	// 按名字精确匹配模板（大小写敏感），命中才走展开流程
	const template = templates.find((t) => t.name === templateName);
	if (template) {
		const args = parseCommandArgs(argsString);
		return substituteArgs(template.content, args);
	}

	// "/xxx" 未命中任何模板：当作普通文本交回，由上层按普通命令/消息处理
	return text;
}
