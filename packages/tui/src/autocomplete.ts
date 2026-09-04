/**
 * @file autocomplete.ts
 * @description 自动补全组件 —— 补全建议的生成、前缀匹配过滤与选择交互
 * @module pi-tui
 *
 * 主要功能：
 * - 定义补全数据模型（AutocompleteItem、SlashCommand）与补全提供者接口（AutocompleteProvider）
 * - CombinedAutocompleteProvider：同时支持斜杠命令（/command）与文件路径（含 @ 文件附件、~/ 家目录）两类补全
 * - 路径前缀提取、家目录展开、目录扫描与前缀过滤（不区分大小写）；目录优先 + 字母序排序，最多返回 10 条建议
 * - applyCompletion 将选中项写回文本并计算新光标位置；Tab 键可强制触发文件路径补全
 *
 * 依赖关系：
 * - node:fs / node:path —— readdirSync / statSync 扫描目录并判断文件类型，basename / dirname / join / extname 处理路径
 * - mime-types —— 依据扩展名推断 MIME 类型，用于判断文件是否可附加
 * - node:os 的 homedir —— 展开 ~/ 家目录路径
 * - ./logger.js —— 记录补全过程的调试与错误日志
 */
import { readdirSync, statSync } from "fs";
import mimeTypes from "mime-types";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";
import { logger } from "./logger.js";

/**
 * 判断文件是否可作为附件附加（文本类或图片类文件）
 *
 * 判定顺序：先按文本扩展名白名单匹配（避免常见代码/配置文件被 MIME 库误判），
 * 再回退到 MIME 类型判断（image/*、text/* 或常见文本型 application/*）。
 *
 * @param filePath 文件完整路径（用于提取扩展名并查询 MIME 类型）
 * @returns 可附加返回 true，否则返回 false
 */
function isAttachableFile(filePath: string): boolean {
	const mimeType = mimeTypes.lookup(filePath);

	// ========== 扩展名白名单判定 ==========
	// 常见文本文件的扩展名列表 —— 优先于 MIME 判定，避免这些文件被误识别为不可附加
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

	// 统一转小写后匹配（列表中的 ".R" 实际由小写 ".r" 覆盖，属冗余项）
	const ext = extname(filePath).toLowerCase();
	if (textExtensions.includes(ext)) return true;

	// 无法识别 MIME 类型且不在白名单中，视为不可附加
	if (!mimeType) return false;

	// 图片类与纯文本类均可直接附加
	if (mimeType.startsWith("image/")) return true;
	if (mimeType.startsWith("text/")) return true;

	// ========== MIME 特例判定 ==========
	// 这些 application/* 类型实际是文本内容，但不会被归入 text/，需单独列举
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

/** 单条补全建议项 —— 补全列表中的最小数据单元 */
export interface AutocompleteItem {
	/** 选中后实际写回文本的值（如完整命令名或补全后的路径） */
	value: string;
	/** 补全列表中展示的简短标签 */
	label: string;
	/** 可选说明文字（如 "directory" / "file"） */
	description?: string;
}

/** 斜杠命令定义（输入 /xxx 触发的命令） */
export interface SlashCommand {
	/** 命令名（不含前导 "/"） */
	name: string;
	/** 可选的命令说明，用于补全列表展示 */
	description?: string;
	// 获取该命令参数的补全建议
	// 若该命令不支持参数补全，则返回 null
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

/**
 * 补全提供者接口 —— 由具体实现负责生成补全建议并把选中项写回文本
 */
export interface AutocompleteProvider {
	// 根据当前文本与光标位置获取补全建议
	// 无可用建议时返回 null
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): {
		items: AutocompleteItem[];
		prefix: string; // 用于前缀匹配的内容（如 "/" 或 "src/"）
	} | null;

	// 应用用户选中的补全项
	// 返回补全后的新文本与新光标位置
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

/**
 * 组合式补全提供者 —— 同时处理斜杠命令与文件路径两类补全场景
 *
 * 触发优先级：
 * 1. 行首以 "/" 开头 → 斜杠命令补全（先补命令名，输入空格后转补命令参数）
 * 2. 检测到路径样式前缀（@ 附件、./、../、~/、含 "/"）→ 文件路径补全
 * 3. Tab 键强制触发 → 无视启发式规则，从当前前缀（可为空）直接列出文件
 */
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	/** 已注册的命令列表（SlashCommand 或普通补全项的联合数组） */
	private commands: (SlashCommand | AutocompleteItem)[];
	/** 文件路径补全的基准目录，相对路径基于此解析 */
	private basePath: string;

	/**
	 * @param commands 命令/补全项列表，默认为空数组
	 * @param basePath 基准目录，默认为当前工作目录 process.cwd()
	 */
	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string = process.cwd()) {
		this.commands = commands;
		this.basePath = basePath;
	}

	/**
	 * 获取当前光标位置的补全建议
	 *
	 * 判定顺序：
	 * 1. 光标前文本以 "/" 开头 → 斜杠命令场景：
	 *    - 还没有空格：按前缀过滤命令名（大小写不敏感）
	 *    - 已有空格：交给命令自身的 getArgumentCompletions 补全参数
	 * 2. 否则尝试提取路径前缀，命中则返回文件/目录建议
	 *
	 * @param lines 当前多行文本内容
	 * @param cursorLine 光标所在行号
	 * @param cursorCol 光标所在列号
	 * @returns 建议列表 + 匹配前缀；无建议时返回 null
	 */
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		logger.debug("CombinedAutocompleteProvider", "getSuggestions called", {
			lines,
			cursorLine,
			cursorCol,
		});

		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// ========== 分支一：斜杠命令补全 ==========
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				// ---------- 尚未输入空格：补全命令名 ----------
				const prefix = textBeforeCursor.slice(1); // 去掉前导 "/"，得到待匹配的命令名前缀
				// 前缀过滤（大小写不敏感），并把命令统一映射为 AutocompleteItem 结构
				const filtered = this.commands
					.filter((cmd) => {
						const name = "name" in cmd ? cmd.name : cmd.value; // 兼容 SlashCommand 与 AutocompleteItem 两种形态
						return name?.toLowerCase().startsWith(prefix.toLowerCase());
					})
					.map((cmd) => ({
						value: "name" in cmd ? cmd.name : cmd.value,
						label: "name" in cmd ? cmd.name : cmd.label,
						...(cmd.description && { description: cmd.description }),
					}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: textBeforeCursor, // 注意：前缀含 "/"，applyCompletion 会整体替换
				};
			} else {
				// ---------- 已输入空格：补全命令参数 ----------
				const commandName = textBeforeCursor.slice(1, spaceIndex); // 命令名（不含 "/"）
				const argumentText = textBeforeCursor.slice(spaceIndex + 1); // 空格之后的参数文本

				const command = this.commands.find((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					return name === commandName;
				});
				if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
					return null; // 该命令未提供参数补全能力
				}

				const argumentSuggestions = command.getArgumentCompletions(argumentText);
				if (!argumentSuggestions || argumentSuggestions.length === 0) {
					return null;
				}

				return {
					items: argumentSuggestions,
					prefix: argumentText, // 前缀为空格后的参数文本
				};
			}
		}

		// ========== 分支二：文件路径补全（自然触发） ==========
		// 仅当文本呈现路径特征（@、./、~/、含 "/" 等）时才提取到前缀；
		// Tab 强制触发的路径走 getForceFileSuggestions
		const pathMatch = this.extractPathPrefix(textBeforeCursor, false);
		logger.debug("CombinedAutocompleteProvider", "Path match check", {
			textBeforeCursor,
			pathMatch,
		});

		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		// 既非命令也非路径 → 不触发补全
		return null;
	}

	/**
	 * 应用用户选中的补全项 —— 把建议值写回文本行并计算新光标位置
	 *
	 * 根据前缀形态分四种情况：
	 * 1. prefix 以 "/" 开头 → 斜杠命令名：写回 "/命令" 并在末尾追加一个空格，方便继续输入参数
	 * 2. prefix 以 "@" 开头 → 文件附件：写回 "@路径" 并追加一个空格
	 * 3. 光标前文本含 "/" 与空格 → 命令参数补全：原样替换，不追加空格
	 * 4. 其余 → 普通文件路径补全：原样替换，不追加空格
	 *
	 * @param lines 补全前的多行文本
	 * @param cursorLine 光标所在行号
	 * @param cursorCol 光标所在列号
	 * @param item 用户选中的建议项
	 * @param prefix 本次补全的匹配前缀（即被建议值替换掉的部分）
	 * @returns 补全后的新文本与新光标位置
	 */
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length); // 前缀之前的文本（保留不动）
		const afterCursor = currentLine.slice(cursorCol); // 光标之后的文本（保留不动）

		// ========== 情况一：斜杠命令名补全（prefix 以 "/" 开头） ==========
		if (prefix.startsWith("/")) {
			// 重新拼上 "/" 与命令名，末尾追加空格以便继续输入参数
			const newLine = beforePrefix + "/" + item.value + " " + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 补偿 "/" 与追加的空格
			};
		}

		// ========== 情况二：文件附件补全（prefix 以 "@" 开头） ==========
		if (prefix.startsWith("@")) {
			// 写回 "@路径"，末尾追加空格
			const newLine = beforePrefix + item.value + " " + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 补偿末尾追加的空格
			};
		}

		// ========== 情况三：命令参数补全（光标前文本形如 "/command "） ==========
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// 只替换参数前缀，不额外追加空格
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		// ========== 情况四：普通文件路径补全 ==========
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
	 * 从光标前的文本中提取"类路径"前缀
	 *
	 * 两级提取策略：
	 * 1. 先匹配 @ 附件语法（@ 后跟非空白字符）—— 命中则直接返回整个 "@xxx" 片段
	 * 2. 再用正则匹配路径词元，是否采纳取决于触发方式：
	 *    - 强制提取（Tab 键）：任何结尾词元都返回（可为空串，表示从当前目录开始补全）
	 *    - 自然触发：仅当词元呈现路径特征（含 "/"、以 "." 或 "~/" 开头）才返回；
	 *      空串只在行首或空格之后返回（即正要开始输入新词的位置），引号等定界符后不触发
	 *
	 * @param text 光标之前的文本
	 * @param forceExtract 是否强制提取（Tab 触发时为 true）
	 * @returns 提取到的路径前缀（可能是空串）；不构成补全场景时返回 null
	 */
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		// ========== @ 附件语法优先 ==========
		const atMatch = text.match(/@([^\s]*)$/);
		if (atMatch) {
			return atMatch[0]; // 返回完整的 "@路径" 片段（含 @，后续逻辑据此识别附件场景）
		}

		// ========== 通用路径词元匹配 ==========
		// 匹配路径 —— 包括以 / 、~/ 结尾的形式，以及供强制提取使用的任意结尾词元
		// 该正则捕获的内容：
		// - 路径须位于行首，或紧跟空格/引号/等号之后
		// - 可选的 ./ 、../ 、~/ 前缀（~/ 情况下含尾部斜杠）
		// - 路径本体（中间可包含 /）
		// - 强制提取时，捕获结尾处的任意词元
		const matches = text.match(/(?:^|[\s"'=])((?:~\/|\.{0,2}\/?)?(?:[^\s"'=]*\/?)*[^\s"'=]*)$/);
		if (!matches) {
			// 强制提取但没匹配到时返回空串，以便从当前目录开始补全
			return forceExtract ? "" : null;
		}

		const pathPrefix = matches[1] || "";

		// 强制提取（Tab 键）：总是返回提取结果
		if (forceExtract) {
			return pathPrefix;
		}

		// 自然触发：仅当看起来像路径（含 /、以 . 或 ~/ 开头）时才返回
		// 空串只在文本像是要开启一个路径上下文时返回
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// 只有位于行首或紧跟空格之后时才返回空串
		// （引号等其他定界符之后不返回，因为那通常不暗示要输入文件路径）
		if (pathPrefix === "" && (text === "" || text.endsWith(" "))) {
			return pathPrefix;
		}

		return null;
	}

	/**
	 * 把家目录前缀（~ 或 ~/…）展开为真实家目录路径
	 *
	 * @param path 原始路径
	 * @returns 展开后的路径；非 ~ 开头则原样返回
	 */
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// join 会规范化路径从而可能丢掉尾部斜杠，这里补回来 ——
			// 后续逻辑依赖"以 / 结尾"来区分"列出目录内容"与"按文件名前缀过滤"
			return path.endsWith("/") && !expandedPath.endsWith("/") ? expandedPath + "/" : expandedPath;
		} else if (path === "~") {
			return homedir(); // 单独的 "~" 直接返回家目录
		}
		return path;
	}

	/**
	 * 根据路径前缀获取文件/目录补全建议
	 *
	 * 流程：
	 * 1. 预处理：剥离 @ 附件标记、展开 ~/ 家目录
	 * 2. 计算搜索目录 searchDir 与目录内过滤前缀 searchPrefix
	 * 3. readdirSync 扫描目录，前缀过滤后构造补全值（目录自动补尾斜杠）
	 * 4. 排序：目录在前、同类型按 label 字母序；最多返回 10 条
	 *
	 * @param prefix 路径前缀（可能带 @ 或 ~ 前缀）
	 * @returns 补全建议列表；目录不存在或读取失败时返回空数组
	 */
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		logger.debug("CombinedAutocompleteProvider", "getFileSuggestions called", {
			prefix,
			basePath: this.basePath,
		});

		try {
			let searchDir: string; // 待扫描的目录
			let searchPrefix: string; // 目录内条目名需匹配的过滤前缀
			let expandedPrefix = prefix;
			let isAtPrefix = false; // 是否为 @ 附件补全（影响结果过滤与路径构造）

			// ========== 前缀预处理 ==========
			// @ 附件前缀：剥离 "@"，仅保留纯路径用于目录扫描
			if (prefix.startsWith("@")) {
				isAtPrefix = true;
				expandedPrefix = prefix.slice(1); // 去掉 "@"
			}

			// 家目录展开（~/ → 真实家目录路径）
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			// ========== 计算搜索目录与过滤前缀 ==========
			// 情况一：前缀指向"目录本身"（空串、./、../、~、~/、单独的 @）
			// → 直接列出该目录全部内容，不做文件名过滤
			if (
				expandedPrefix === "" ||
				expandedPrefix === "./" ||
				expandedPrefix === "../" ||
				expandedPrefix === "~" ||
				expandedPrefix === "~/" ||
				prefix === "@"
			) {
				// ~/ 展开后已是绝对路径则直接使用，否则相对 basePath 解析
				if (prefix.startsWith("~")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				// 情况二：前缀以 / 结尾（如 "src/"）→ 列出该目录内容，同样不做文件名过滤
				// ~/ 开头或 @ + 绝对路径已是绝对路径则直接使用，否则相对 basePath 解析
				if (prefix.startsWith("~") || (isAtPrefix && expandedPrefix.startsWith("/"))) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// 情况三：普通前缀（如 "src/comp"）→ 拆分为目录部分 + 文件名前缀部分
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (prefix.startsWith("~") || (isAtPrefix && expandedPrefix.startsWith("/"))) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			logger.debug("CombinedAutocompleteProvider", "Searching directory", {
				searchDir,
				searchPrefix,
			});

			// ========== 扫描目录并构造建议 ==========
			const entries = readdirSync(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				// 文件名前缀过滤（大小写不敏感）
				if (!entry.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				const fullPath = join(searchDir, entry);
				const isDirectory = statSync(fullPath).isDirectory();

				// @ 附件场景只展示目录与"可附加"文件（文本/图片），其余跳过
				if (isAtPrefix && !isDirectory && !isAttachableFile(fullPath)) {
					continue;
				}

				let relativePath: string;

				// ---------- 构造写回文本用的补全值路径 ----------
				// @ 前缀：结果需保留 "@" 标记，并保持 ~/ 的简洁写法
				if (isAtPrefix) {
					const pathWithoutAt = expandedPrefix;
					if (pathWithoutAt.endsWith("/")) {
						// 前缀以 / 结尾：条目名直接拼在前缀后面
						relativePath = "@" + pathWithoutAt + entry;
					} else if (pathWithoutAt.includes("/")) {
						// 前缀含目录部分：重新拼回 "目录/条目名"
						if (pathWithoutAt.startsWith("~/")) {
							const homeRelativeDir = pathWithoutAt.slice(2); // 去掉 ~/
							const dir = dirname(homeRelativeDir);
							relativePath = "@~/" + (dir === "." ? entry : join(dir, entry));
						} else {
							relativePath = "@" + join(dirname(pathWithoutAt), entry);
						}
					} else {
						// 前缀无目录部分：仅拼 "@条目名"；~ 前缀则展开回 "@~/条目名"
						if (pathWithoutAt.startsWith("~")) {
							relativePath = "@~/" + entry;
						} else {
							relativePath = "@" + entry;
						}
					}
				} else if (prefix.endsWith("/")) {
					// 前缀以 / 结尾：把条目名追加到前缀后面
					relativePath = prefix + entry;
				} else if (prefix.includes("/")) {
					// 前缀含目录：家目录路径保持 ~/ 简写，其余重新拼接
					if (prefix.startsWith("~/")) {
						const homeRelativeDir = prefix.slice(2); // 去掉 ~/
						const dir = dirname(homeRelativeDir);
						relativePath = "~/" + (dir === "." ? entry : join(dir, entry));
					} else {
						relativePath = join(dirname(prefix), entry);
					}
				} else {
					// 单独的条目名：原前缀为 ~ 时保留 ~/ 前缀，否则只返回条目名
					if (prefix.startsWith("~")) {
						relativePath = "~/" + entry;
					} else {
						relativePath = entry;
					}
				}

				suggestions.push({
					// 目录补一个尾斜杠，便于用户继续向下一级补全
					value: isDirectory ? relativePath + "/" : relativePath,
					label: entry,
					description: isDirectory ? "directory" : "file",
				});
			}

			// ========== 排序：目录优先，同类型内按字母序 ==========
			suggestions.sort((a, b) => {
				const aIsDir = a.description === "directory";
				const bIsDir = b.description === "directory";
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			logger.debug("CombinedAutocompleteProvider", "Returning suggestions", {
				count: suggestions.length,
				firstFew: suggestions.slice(0, 3).map((s) => s.label),
			});

			return suggestions.slice(0, 10); // 上限 10 条，避免补全列表过长
		} catch (e) {
			// 目录不存在或不可访问：记录错误并返回空列表（补全静默失败，不打断输入）
			logger.error("CombinedAutocompleteProvider", "Error reading directory", {
				error: e instanceof Error ? e.message : String(e),
			});
			return [];
		}
	}

	/**
	 * 强制触发文件补全（按 Tab 键时调用）—— 尽可能返回建议
	 *
	 * 与 getSuggestions 的区别：这里调用 extractPathPrefix 时传 forceExtract=true，
	 * 不依赖"文本呈现路径特征"的启发式判断，光标前的任何词元（甚至空串）都会
	 * 被当作路径前缀，从当前目录开始列出文件。
	 *
	 * @param lines 当前多行文本
	 * @param cursorLine 光标所在行号
	 * @param cursorCol 光标所在列号
	 * @returns 建议列表 + 匹配前缀；正在输入命令名或无建议时返回 null
	 */
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		logger.debug("CombinedAutocompleteProvider", "getForceFileSuggestions called", {
			lines,
			cursorLine,
			cursorCol,
		});

		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// 正在输入斜杠命令名（以 / 开头且尚无空格）时不触发文件补全
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return null;
		}

		// 强制提取路径前缀 —— 这里总会得到一个值（最差为空串）
		const pathMatch = this.extractPathPrefix(textBeforeCursor, true);
		logger.debug("CombinedAutocompleteProvider", "Forced path match", {
			textBeforeCursor,
			pathMatch,
		});

		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		// forceExtract=true 时 extractPathPrefix 总有返回值，此处属防御性兜底
		return null;
	}

	/**
	 * 判断是否应触发文件补全（按 Tab 键时调用）
	 *
	 * @param lines 当前多行文本
	 * @param cursorLine 光标所在行号
	 * @param cursorCol 光标所在列号
	 * @returns 可触发返回 true；正在输入斜杠命令名（以 / 开头且尚无空格）时返回 false
	 */
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// 正在输入斜杠命令名时不触发文件补全（Tab 留给命令补全使用）
		if (textBeforeCursor.startsWith("/") && !textBeforeCursor.includes(" ")) {
			return false;
		}

		return true;
	}
}
