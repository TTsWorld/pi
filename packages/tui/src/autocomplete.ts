/**
 * @file 自动补全模块（autocomplete.ts）
 * @description
 * pi monorepo 终端 UI 框架（@pi/tui）的自动补全核心实现。
 * 提供三类补全能力，统一由 CombinedAutocompleteProvider 调度：
 *   1. 斜杠命令（SlashCommand）补全：用户输入 "/" 开头时补全命令名；
 *   2. 命令参数补全：命令名后跟空格时，调用命令自带的 getArgumentCompletions；
 *   3. 文件路径补全：识别 ~/、./、../、@附件 等路径模式，
 *      支持按目录列出条目、目录优先排序、@ 前缀下仅展示可附加文件。
 * 依赖关系：
 *   - node:fs / node:os / node:path —— 同步读取目录、展开家目录、路径拆解；
 *   - mime-types —— 根据扩展名推断 MIME 类型，判断文件是否可附加（attachable）。
 */
import { readdirSync, statSync } from "fs";
import mimeTypes from "mime-types";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";

/**
 * 判断给定文件是否为"可附加文件"（可作为附件发送给对话）。
 *
 * 判定顺序：先按扩展名白名单（覆盖常见的可能被 MIME 库误判的文本类型），
 * 再按 MIME 类型判断（image/* 与 text/* 均可附加），
 * 最后核对一组容易被识别为 application/* 但实为纯文本的常见类型。
 *
 * @param filePath 文件的（相对或绝对）路径，扩展名不区分大小写
 * @returns 可附加返回 true，否则 false
 */
function isAttachableFile(filePath: string): boolean {
	const mimeType = mimeTypes.lookup(filePath);

	// ========== 扩展名白名单 ==========
	// 先按扩展名检查常见的文本文件——这些类型可能被 MIME 库误判为非文本
	const textExtensions = [
		".txt",
		".md",
		".markdown",
		".js",
		".ts",
		".tsx",
		".jsx",
		".py",
		".java",
		".c",
		".cpp",
		".h",
		".hpp",
		".cs",
		".php",
		".rb",
		".go",
		".rs",
		".swift",
		".kt",
		".scala",
		".sh",
		".bash",
		".zsh",
		".fish",
		".html",
		".htm",
		".css",
		".scss",
		".sass",
		".less",
		".xml",
		".json",
		".yaml",
		".yml",
		".toml",
		".ini",
		".cfg",
		".conf",
		".log",
		".sql",
		".r",
		".R",
		".m",
		".pl",
		".lua",
		".vim",
		".dockerfile",
		".makefile",
		".cmake",
		".gradle",
		".maven",
		".properties",
		".env",
	];

	// 统一转小写再比对，兼容 .R 这类大写扩展名被转小写的情况
	const ext = extname(filePath).toLowerCase();
	if (textExtensions.includes(ext)) return true;

	// 无法识别 MIME 类型（未知扩展名）则视为不可附加
	if (!mimeType) return false;

	// 图片类（image/*）一律可附加
	if (mimeType.startsWith("image/")) return true;
	// 文本类（text/*）一律可附加
	if (mimeType.startsWith("text/")) return true;

	// ========== 特例 MIME 白名单 ==========
	// 这些常见的文本类型在 MIME 体系中归为 application/*，不会被 text/ 前缀命中
	const commonTextTypes = [
		"application/json",
		"application/javascript",
		"application/typescript",
		"application/xml",
		"application/yaml",
		"application/x-yaml",
	];

	return commonTextTypes.includes(mimeType);
}

/** 一条自动补全候选项：value 为实际替换进文本的值，label 为界面展示名 */
export interface AutocompleteItem {
	/** 补全后实际写入输入框的值（如命令名或相对路径） */
	value: string;
	/** 补全菜单中展示的标签 */
	label: string;
	/** 可选的附加说明（如 "directory" / "file"），也用于排序时区分目录 */
	description?: string;
}

/** 一条斜杠命令定义（"/" 触发的命令） */
export interface SlashCommand {
	/** 命令名（不含前导 "/"） */
	name: string;
	/** 命令用途说明，展示在补全菜单中 */
	description?: string;
	// 获取该命令参数的补全候选
	// 若该命令不提供参数补全则返回 null
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

/** 自动补全提供者接口：输入框通过此接口获取候选并应用选中项 */
export interface AutocompleteProvider {
	// 获取当前文本/光标位置下的补全建议
	// 无可用建议时返回 null
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): {
		items: AutocompleteItem[];
		prefix: string; // 当前正在匹配的前缀（如 "/" 或 "src/"）
	} | null;

	// 应用选中的补全项
	// 返回替换后的新文本与新光标位置
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
}

// 组合式补全提供者：同时处理斜杠命令与文件路径两类补全
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	/** 已注册的命令列表，元素既可以是 SlashCommand 也可以是普通 AutocompleteItem */
	private commands: (SlashCommand | AutocompleteItem)[];
	/** 文件路径补全的基准目录（相对路径以此拼接），默认为当前工作目录 */
	private basePath: string;

	/**
	 * @param commands 可选的命令候选列表
	 * @param basePath 可选的文件补全基准目录，默认 process.cwd()
	 */
	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string = process.cwd()) {
		this.commands = commands;
		this.basePath = basePath;
	}

	/**
	 * 根据光标前的文本判断补全类型并返回候选。
	 * 优先级：斜杠命令名 > 命令参数 > @附件/文件路径。
	 *
	 * @param lines 输入框全部行文本
	 * @param cursorLine 光标所在行号
	 * @param cursorCol 光标所在列号
	 * @returns 候选项数组 + 匹配前缀；无候选返回 null
	 */
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// ========== 斜杠命令补全 ==========
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				// 尚未输入空格——补全命令名
				const prefix = textBeforeCursor.slice(1); // 去掉开头的 "/"
				// 过滤出以 prefix 开头（忽略大小写）的命令，并统一映射为 AutocompleteItem
				const filtered = this.commands
					.filter((cmd) => {
						// 通过 "name" 属性区分是 SlashCommand 还是 AutocompleteItem
						const name = "name" in cmd ? cmd.name : cmd.value;
						return name?.toLowerCase().startsWith(prefix.toLowerCase());
					})
					.map((cmd) => ({
						value: "name" in cmd ? cmd.name : cmd.value,
						label: "name" in cmd ? cmd.name : cmd.label,
						...(cmd.description && { description: cmd.description }),
					}));

				// 没有匹配的命令则不弹出补全
				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: textBeforeCursor,
				};
			} else {
				// 已有空格——补全命令参数
				const commandName = textBeforeCursor.slice(1, spaceIndex); // 不含 "/" 的命令名
				const argumentText = textBeforeCursor.slice(spaceIndex + 1); // 空格之后的参数文本

				// 找到当前输入的命令
				const command = this.commands.find((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					return name === commandName;
				});
				if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
					return null; // 该命令不提供参数补全
				}

				const argumentSuggestions = command.getArgumentCompletions(argumentText);
				if (!argumentSuggestions || argumentSuggestions.length === 0) {
					return null;
				}

				return {
					items: argumentSuggestions,
					prefix: argumentText,
				};
			}
		}

		// ========== 文件路径补全 ==========
		// 由 Tab 键触发，或在文本中识别出路径模式时触发
		const pathMatch = this.extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	/**
	 * 将选中的补全项写入文本并计算新光标位置。
	 * 按前缀类型分四种情况处理：
	 *   1. prefix 以 "/" 开头 → 命令名补全，补全后追加一个空格；
	 *   2. prefix 以 "@" 开头 → 文件附件补全，补全后追加一个空格；
	 *   3. 光标前文本含 "/xxx " → 命令参数补全，原地替换不追加空格；
	 *   4. 其余 → 文件路径补全，原地替换。
	 *
	 * @returns 新的行文本数组与光标位置
	 */
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		// prefix 之前的文本（补全的插入点）
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		// 光标之后的文本（补全后需原样保留）
		const afterCursor = currentLine.slice(cursorCol);

		// ========== 情况一：命令名补全（prefix 以 "/" 开头） ==========
		if (prefix.startsWith("/")) {
			// 重建为 "/命令名 " 的形式，命令后自动加空格方便继续输参数
			const newLine = beforePrefix + "/" + item.value + " " + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 对应补上的 "/" 与空格
			};
		}

		// ========== 情况二：文件附件补全（prefix 以 "@" 开头） ==========
		if (prefix.startsWith("@")) {
			// 附件补全：value 已含完整 @path，补全后追加空格
			const newLine = beforePrefix + item.value + " " + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 对应补上的空格
			};
		}

		// ========== 情况三：命令参数补全 ==========
		// 光标前文本同时含 "/" 与空格，说明处于 "/命令 参数" 上下文
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// 命令参数补全：仅替换参数本身，不额外追加空格
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		// ========== 情况四：文件路径补全 ==========
		// 原地替换前缀，不追加空格（便于继续下钻目录）
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	/**
	 * 从光标前的文本中提取"疑似路径"的前缀。
	 *
	 * 两种模式：
	 *   - 自然触发（forceExtract=false）：仅当文本确实像路径（含 /、以 . 或 ~/ 开头、
	 *     或恰好在行首/空格后处于空路径起点）时返回，否则返回 null；
	 *   - 强制触发（forceExtract=true，Tab 键）：总能返回一个字符串
	 *     （最坏返回空串，表示从当前目录开始补全），永不返回 null。
	 *
	 * @param text 光标前的文本
	 * @param forceExtract 是否强制提取（Tab 键触发时为 true）
	 * @returns 提取出的路径前缀（可能含前导 "@"），不匹配时返回 null（强制模式下不返回 null）
	 */
	// 从光标前的文本中提取路径式前缀
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		// 优先检查 @ 文件附件语法（@ 后跟非空白字符直到文本末尾）
		const atMatch = text.match(/@([^\s]*)$/);
		if (atMatch) {
			return atMatch[0]; // 返回完整的 "@path" 匹配串（含 @）
		}

		// 匹配路径——包括以 /、~/ 结尾的路径，以及强制提取时末尾的任意单词
		// 该正则捕获：
		// - 从行首或空格/引号/等号之后开始的路径
		// - 可选的 ./、../ 或 ~/ 前缀（~/ 情形含末尾斜杠）
		// - 路径主体（中间可含 /）
		// - 强制提取模式下，捕获末尾的任意单词
		const matches = text.match(/(?:^|[\s"'=])((?:~\/|\.{0,2}\/?)?(?:[^\s"'=]*\/?)*[^\s"'=]*)$/);
		if (!matches) {
			// 强制提取但没有匹配到时，返回空串以触发"从当前目录开始补全"
			return forceExtract ? "" : null;
		}

		const pathPrefix = matches[1] || "";

		// 强制提取（Tab 键）时，总是返回提取结果
		if (forceExtract) {
			return pathPrefix;
		}

		// 自然触发时：仅当看起来像路径（含 /、以 . 或 ~/ 开头）才返回
		// 仅当文本看起来正要开始一段路径时才返回空串
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// 只有在行首或空格之后（即不在引号等不暗示文件路径的分隔符之后）
		// 且前缀为空串时，才返回空串
		if (pathPrefix === "" && (text === "" || text.endsWith(" "))) {
			return pathPrefix;
		}

		return null;
	}

	/**
	 * 将家目录简写（~/ 或 ~）展开为实际的家目录绝对路径。
	 * 展开后若原路径以 / 结尾则保留结尾斜杠，便于后续按"目录内容"补全。
	 *
	 * @param path 可能含 ~ 前缀的路径
	 * @returns 展开后的路径；不含 ~ 前缀时原样返回
	 */
	// 展开家目录（~/）为实际的家目录路径
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// 若原路径以 / 结尾，展开后也保留结尾斜杠
			return path.endsWith("/") && !expandedPath.endsWith("/") ? expandedPath + "/" : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	/**
	 * 根据路径前缀列出目录内容生成补全候选。
	 *
	 * 处理流程：剥离 @ 前缀 → 展开 ~ → 确定"搜索目录 + 文件名过滤前缀"
	 * → readdirSync 列目录并按前缀过滤 →（@ 模式下仅保留目录与可附加文件）
	 * → 拼装保持用户原始书写风格（~/、./、@）的补全值 → 目录优先、字母序排序 → 截取前 10 条。
	 * 目录不存在或不可读时整体吞掉异常并返回空数组（视为无补全）。
	 *
	 * @param prefix 用户输入的路径前缀（可能含 "@" 或 "~"）
	 * @returns 补全候选列表；目录不可访问时为空数组
	 */
	// 获取给定路径前缀对应的文件/目录补全候选
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			let expandedPrefix = prefix;
			let isAtPrefix = false;

			// ========== 预处理：剥离 @ 前缀并展开 ~ ==========
			// 处理 @ 文件附件前缀
			if (prefix.startsWith("@")) {
				isAtPrefix = true;
				expandedPrefix = prefix.slice(1); // 去掉 @
			}

			// 展开家目录
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			// ========== 确定搜索目录与过滤前缀 ==========
			if (
				expandedPrefix === "" ||
				expandedPrefix === "./" ||
				expandedPrefix === "../" ||
				expandedPrefix === "~" ||
				expandedPrefix === "~/" ||
				prefix === "@"
			) {
				// 前缀是"位置指示"（空、./、../、~、~/、@）——直接列出该位置的完整内容
				if (prefix.startsWith("~")) {
					// ~ 开头的路径已在上面展开为绝对路径，直接使用
					searchDir = expandedPrefix;
				} else {
					// 相对路径需拼接基准目录
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				// 前缀以 / 结尾——列出该目录的内容
				if (prefix.startsWith("~") || (isAtPrefix && expandedPrefix.startsWith("/"))) {
					// ~ 或 @/ 开头的已是绝对路径，无需拼接 basePath
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// 拆分为"目录部分 + 文件名前缀"（如 src/au → 目录 src，前缀 au）
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (prefix.startsWith("~") || (isAtPrefix && expandedPrefix.startsWith("/"))) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			// ========== 列目录并生成候选 ==========
			const entries = readdirSync(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				// 按文件名前缀过滤（忽略大小写）
				if (!entry.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				const fullPath = join(searchDir, entry);
				const isDirectory = statSync(fullPath).isDirectory();

				// @ 前缀模式下只展示目录与"可附加文件"，其余跳过
				if (isAtPrefix && !isDirectory && !isAttachableFile(fullPath)) {
					continue;
				}

				let relativePath: string;

				// ========== 拼装补全值：保持用户原始书写风格（@ 模式） ==========
				// @ 前缀下的路径拼装
				if (isAtPrefix) {
					const pathWithoutAt = expandedPrefix;
					if (pathWithoutAt.endsWith("/")) {
						// 前缀以 / 结尾：直接把条目名接到后面
						relativePath = "@" + pathWithoutAt + entry;
					} else if (pathWithoutAt.includes("/")) {
						if (pathWithoutAt.startsWith("~/")) {
							// ~/ 开头：需还原成 @~/ 相对家目录的形式
							const homeRelativeDir = pathWithoutAt.slice(2); // 去掉 ~/
							const dir = dirname(homeRelativeDir);
							relativePath = "@~/" + (dir === "." ? entry : join(dir, entry));
						} else {
							relativePath = "@" + join(dirname(pathWithoutAt), entry);
						}
					} else {
						// 前缀不含 /：只有一层，直接拼条目名
						if (pathWithoutAt.startsWith("~")) {
							relativePath = "@~/" + entry;
						} else {
							relativePath = "@" + entry;
						}
					}
				} else if (prefix.endsWith("/")) {
					// ========== 拼装补全值：非 @ 模式 ==========
					// 前缀以 / 结尾：把条目名直接接到前缀后面
					relativePath = prefix + entry;
				} else if (prefix.includes("/")) {
					// 家目录路径保持 ~/ 写法（而不是展开成绝对路径）
					if (prefix.startsWith("~/")) {
						const homeRelativeDir = prefix.slice(2); // 去掉 ~/
						const dir = dirname(homeRelativeDir);
						relativePath = "~/" + (dir === "." ? entry : join(dir, entry));
					} else {
						relativePath = join(dirname(prefix), entry);
					}
				} else {
					// 独立条目（无目录层级）：若原前缀是 ~/ 则补全值也保持 ~/ 开头
					if (prefix.startsWith("~")) {
						relativePath = "~/" + entry;
					} else {
						relativePath = entry;
					}
				}

				suggestions.push({
					// 目录补全值追加 / 方便继续下钻
					value: isDirectory ? relativePath + "/" : relativePath,
					label: entry,
					description: isDirectory ? "directory" : "file",
				});
			}

			// ========== 排序：目录优先，其次按字母序 ==========
			suggestions.sort((a, b) => {
				const aIsDir = a.description === "directory";
				const bIsDir = b.description === "directory";
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions.slice(0, 10); // 最多返回 10 条候选，避免菜单过长
		} catch (e) {
			// 目录不存在或不可访问——视为无补全而非报错
			return [];
		}
	}

	/**
	 * 强制文件补全（Tab 键触发）——只要不在斜杠命令上下文中，总是尝试给出路径候选。
	 * 与 getSuggestions 的区别：内部以 forceExtract=true 提取路径前缀，
	 * 即使光标前不像路径（如空行）也会从基准目录列出内容。
	 *
	 * @returns 候选项数组 + 匹配前缀；处于命令名输入阶段或无候选时返回 null
	 */
	// 强制文件补全（Tab 键触发）——总是返回建议
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// 处于斜杠命令（且尚未输入空格）时不触发文件补全
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return null;
		}

		// 强制提取路径前缀——这总能得到结果（最坏为空串）
		const pathMatch = this.extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	/**
	 * 判断是否应触发文件补全（Tab 键按下时调用）。
	 * 规则：处于命令名输入阶段（"/xxx" 且无空格）返回 false，其余情况返回 true。
	 *
	 * @returns 应触发返回 true
	 */
	// 判断是否应触发文件补全（Tab 键调用）
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// 处于斜杠命令（且尚未输入空格）时不触发
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return false;
		}

		return true;
	}
}
