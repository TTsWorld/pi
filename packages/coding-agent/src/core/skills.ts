/**
 * @file skills.ts —— Skills（技能包）系统：发现、解析与加载
 *
 * @description
 * 本文件实现终端编码助手的 Agent Skills 子系统：从全局用户目录、项目目录
 * 以及显式指定的路径中扫描 SKILL.md / 散装 .md 技能文件，解析其 YAML
 * frontmatter（name、description、disable-model-invocation 等），按
 * Agent Skills 规范校验字段合法性，处理同名冲突与符号链接去重，最终产出：
 * - `Skill[]`：可用技能列表（附带 SourceInfo 来源信息，供诊断与展示）；
 * - `ResourceDiagnostic[]`：加载过程中的警告 / 冲突等诊断信息。
 * 另提供 `formatSkillsForPrompt`，把技能清单渲染为 XML 片段注入系统提示词，
 * 引导模型在任务匹配时用 read 工具加载对应技能文件。
 *
 * 发现规则（与 Claude Code 的 skills 约定一致）：
 * - 目录下若存在 SKILL.md，则整个目录视为一个技能包，不再继续下探；
 * - 否则递归扫描子目录寻找 SKILL.md，并（可选）加载根目录下的散装 .md；
 * - 扫描遵循 .gitignore / .ignore / .fdignore 规则，并跳过 node_modules。
 *
 * 依赖关系：
 * - `../config.ts`：agent 配置目录（CONFIG_DIR_NAME / getAgentDir）；
 * - `../utils/frontmatter.ts`：YAML frontmatter 解析；
 * - `../utils/paths.ts`：路径解析与符号链接规范化（用于文件级去重）；
 * - `./diagnostics.ts` / `./source-info.ts`：诊断信息与来源描述。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

/** 规范规定的技能名最大长度 */
const MAX_NAME_LENGTH = 64;

/** 规范规定的 description 最大长度 */
const MAX_DESCRIPTION_LENGTH = 1024;

/** 扫描时需要遵循的 ignore 文件名（与 git/fd 等工具保持兼容） */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** ignore 库的匹配器类型：规则可跨目录逐层叠加 */
type IgnoreMatcher = ReturnType<typeof ignore>;

/** 把平台路径分隔符统一为 `/`（Windows 下 `\` → `/`），与 gitignore 风格的 POSIX 匹配规则对齐 */
function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/**
 * 给单条 ignore 规则加上目录前缀，使其相对于扫描根目录生效。
 *
 * gitignore 语义中规则相对于 ignore 文件所在目录，而这里的匹配器统一以
 * 扫描根目录为基准，因此子目录里的规则需改写为 `<子目录相对路径>/<原模式>`。
 *
 * 返回 null 表示该行应被丢弃（空行或注释行）。
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	// 空行与未转义的 # 注释行直接丢弃；`\#` 表示字面量井号，需保留
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	// `!` 前缀为否定规则（「不忽略」），改写后要补回；转义的 `\!` 去掉反斜杠按字面量处理
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	// 去掉仅锚定 ignore 文件所在目录的前导 `/`（加前缀后由 prefix 隐式锚定）
	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * 读取 dir 下的 ignore 文件，把规则（改写为相对 rootDir）追加进匹配器。
 * 递归扫描时逐层调用，即可模拟 git 级联 ignore 的「父目录 + 子目录规则叠加」语义。
 */
function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	// 计算 dir 相对扫描根的 POSIX 路径前缀；扫描根本身（相对路径为空）无需前缀
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {} // ignore 文件不可读不致命：跳过该文件即可，不影响技能扫描
	}
}

/** SKILL.md frontmatter 的松散结构：只声明本模块关心的字段，其余键通过索引签名透传 */
export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/**
 * 一个成功加载的技能。
 * - `filePath`：技能文件（SKILL.md / .md）的绝对路径，会写入系统提示词供模型读取；
 * - `baseDir`：技能所在目录，技能内容引用的相对资源以此为基准解析；
 * - `disableModelInvocation`：为 true 时对模型隐藏，仅能通过 /skill:name 显式调用。
 */
export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

/** 目录/路径加载结果：解析成功的技能 + 过程中产生的诊断（警告不会阻断加载） */
export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * 按 Agent Skills 规范校验技能名。
 * 返回错误信息数组（为空即合法）。
 */
function validateName(name: string): string[] {
	const errors: string[] = [];

	// 长度上限：MAX_NAME_LENGTH（64）
	if (name.length > MAX_NAME_LENGTH) {
		errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	}

	// 字符集：仅允许小写字母、数字、连字符
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	}

	// 连字符不得出现在首尾
	if (name.startsWith("-") || name.endsWith("-")) {
		errors.push(`name must not start or end with a hyphen`);
	}

	// 也不得连续出现
	if (name.includes("--")) {
		errors.push(`name must not contain consecutive hyphens`);
	}

	return errors;
}

/**
 * 按 Agent Skills 规范校验描述：必填、非空白，且不超过最大长度。
 * 入参为 unknown 是因为值直接来自 frontmatter 解析结果，需先做类型收窄。
 */
function validateDescription(description: unknown): string[] {
	const errors: string[] = [];

	if (typeof description !== "string" || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}

	return errors;
}

export interface LoadSkillsFromDirOptions {
	/** 要扫描的技能目录 */
	dir: string;
	/** 这批技能的来源标识（user / project / path，或插件名等外部来源） */
	source: string;
}

/**
 * 为技能构造来源信息（SourceInfo）。
 * 内置的 user / project / path 三种来源都归一化为 local 来源并附上对应
 * scope（path 不带 scope）；其余值（如插件名）视为外部来源原样透传，
 * 供 UI 与诊断系统展示「技能来自哪里」。
 */
function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "user",
				baseDir,
			});
		case "project":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				scope: "project",
				baseDir,
			});
		case "path":
			return createSyntheticSourceInfo(filePath, {
				source: "local",
				baseDir,
			});
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

/**
 * 从目录加载技能（对外入口）。
 *
 * 发现规则：
 * - 目录下存在 SKILL.md 时，把该目录视为一个技能包，加载后不再递归下探；
 * - 否则加载根目录下直接的 .md 子文件（散装技能）；
 * - 递归进入子目录寻找 SKILL.md。
 */
export function loadSkillsFromDir(options: LoadSkillsFromDirOptions): LoadSkillsResult {
	const { dir, source } = options;
	return loadSkillsFromDirInternal(dir, source, true);
}

/**
 * loadSkillsFromDir 的递归实现。
 *
 * @param includeRootFiles - 是否加载当前目录下的散装 .md 文件：
 *   仅在扫描顶层时为 true；递归进入的子目录只认 SKILL.md，
 *   避免把技能包目录里的普通文档误识别为技能
 * @param ignoreMatcher - 跨目录复用的 ignore 匹配器（规则逐层累积）
 * @param rootDir - 扫描根目录，ignore 匹配所需的相对路径以其为基准
 */
function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	// 目录不存在不算错误，安静返回空结果
	if (!existsSync(dir)) {
		return { skills, diagnostics };
	}

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	// 逐层叠加当前目录的 ignore 规则，模拟 git 的级联 ignore
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		// ===== 第一遍：检查当前目录是否就是技能包（含 SKILL.md）=====
		for (const entry of entries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// 符号链接的 Dirent 描述的是链接本身，需 stat 实际目标判断文件类型
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					// 链接目标不可访问（如断链）：放弃该候选
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
			// 命中 SKILL.md 即返回：技能包目录不再继续下探
			return { skills, diagnostics };
		}

		// ===== 第二遍：递归子目录 + 加载根目录散装 .md =====
		for (const entry of entries) {
			// 跳过隐藏文件/目录（.git、.agent 等）
			if (entry.name.startsWith(".")) {
				continue;
			}

			// 跳过 node_modules，避免扫描依赖目录
			if (entry.name === "node_modules") {
				continue;
			}

			const fullPath = join(dir, entry.name);

			// 对符号链接 stat 实际目标：目录则跟随进入，文件则按普通文件处理
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					// 断链（目标不存在），跳过
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			// 目录匹配时需补尾部 `/`，以命中 `dir/` 形式的 ignore 规则
			const ignorePath = isDirectory ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) {
				continue;
			}

			if (isDirectory) {
				// 子目录递归下探；includeRootFiles 传 false，子目录只认 SKILL.md
				const subResult = loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}

			// 非文件 / 当前层不加载散装文件 / 非 .md 后缀，均跳过
			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) {
				continue;
			}

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) {
				skills.push(result.skill);
			}
			diagnostics.push(...result.diagnostics);
		}
	} catch {} // 单个目录读取异常整体吞掉：不应让一处损坏阻断其余技能的发现

	return { skills, diagnostics };
}

/**
 * 解析单个技能文件（SKILL.md 或散装 .md）。
 *
 * 读取失败、frontmatter 解析失败或缺 description 时返回 `skill: null`；
 * 而 name 不规范、description 超长等校验问题只记录 warning 诊断，不阻断加载。
 */
function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	// 是否为「声明式」技能（SKILL.md）；散装 .md 对 frontmatter 的要求更宽松
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		// 读取失败：记 warning 后放弃该文件
		const message = error instanceof Error ? error.message : "failed to read skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}

	let frontmatter: SkillFrontmatter;
	try {
		({ frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent));
	} catch (error) {
		// 仅 SKILL.md 才报告解析错误；散装 .md 没有 frontmatter 属正常情况，静默跳过
		if (isDeclaredSkill) {
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		return { skill: null, diagnostics };
	}

	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	// 散装 .md 必须自带 description 才会被当作技能；SKILL.md 走下方统一校验
	if (!isDeclaredSkill && !hasDescription) {
		return { skill: null, diagnostics };
	}

	const skillDir = dirname(filePath);
	const parentDirName = basename(skillDir);

	// 校验 description
	const descErrors = validateDescription(description);
	for (const error of descErrors) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// name 优先取 frontmatter，缺省回退为父目录名
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;

	// 校验 name
	const nameErrors = validateName(name);
	for (const error of nameErrors) {
		diagnostics.push({ type: "warning", message: error, path: filePath });
	}

	// 即便有警告也照样加载；唯一硬性要求是 description 存在且非空
	if (!hasDescription) {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description,
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * 把技能列表格式化为可注入系统提示词的 XML 片段（遵循 Agent Skills 标准，
 * 见 https://agentskills.io/integrate-skills）。
 *
 * disableModelInvocation=true 的技能不会出现在提示词中
 * （它们只能通过 /skill:name 命令显式调用）。
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	// 先过滤掉对模型隐藏的技能；一个可见技能都没有时无需注入任何内容
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	// 引导语 + XML 技能清单：模型据此在任务匹配时自行读取对应技能文件
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

/** 转义 XML 五个特殊字符，防止技能名/描述破坏提示词中的 XML 结构 */
function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface LoadSkillsOptions {
	/** 项目级技能的工作目录（用于定位 <CONFIG_DIR_NAME>/skills） */
	cwd: string;
	/** 全局技能所在的 agent 配置目录 */
	agentDir: string;
	/** 显式指定的技能路径（文件或目录） */
	skillPaths: string[];
	/** 是否包含默认技能目录（全局 + 项目） */
	includeDefaults: boolean;
}

/**
 * 从所有已配置位置加载技能：默认目录（agent 全局 skills + 项目配置目录下的
 * skills）与显式 skillPaths（文件或目录均可）。
 * 返回按名字去重后的技能列表及全部诊断信息；加载顺序即优先级——
 * 先加载者胜出，后到的同名技能记入 collision 诊断。
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const { agentDir, skillPaths, includeDefaults } = options;

	// 解析 agentDir——未提供时使用 config 中的默认值
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());

	// name → skill 映射，用于同名冲突检测与最终去重输出
	const skillMap = new Map<string, Skill>();
	// 已加载文件的物理路径集合（canonicalizePath 已解引用符号链接），用于文件级去重
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	// 冲突诊断单独收集、最后合并：保证普通警告先于 collision 出现
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	/** 归并一批加载结果：先做文件级去重，再做同名冲突检测 */
	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			// 解引用符号链接，识别「同一物理文件」
			const realPath = canonicalizePath(skill.filePath);

			// 同一文件（可能经符号链接重复出现）已加载过则静默跳过
			if (realPathSet.has(realPath)) {
				continue;
			}

			const existing = skillMap.get(skill.name);
			if (existing) {
				// 同名冲突：先到先得，后来者记入 collision 诊断
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	if (includeDefaults) {
		// 默认目录：先用户全局 skills，再项目 CONFIG_DIR_NAME/skills（全局优先于项目）
		addSkills(loadSkillsFromDirInternal(join(resolvedAgentDir, "skills"), "user", true));
		addSkills(loadSkillsFromDirInternal(resolve(resolvedCwd, CONFIG_DIR_NAME, "skills"), "project", true));
	}

	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");

	/** 判断 target 是否位于 root 目录内（含恰好等于 root 的情况） */
	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		if (target === normalizedRoot) {
			return true;
		}
		// 补上路径分隔符再比对前缀，避免 /foo/bar2 误命中 /foo/bar
		const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
		return target.startsWith(prefix);
	};

	/**
	 * 为显式路径推断来源：仅当未加载默认目录时，位于默认目录内的路径才按
	 * user / project 归类（保持 SourceInfo 语义准确）；默认目录已加载时，
	 * 指向其中的重复路径会经 realPathSet 去重，统一标为 "path" 即可。
	 */
	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};

	// 逐个处理显式 skillPaths：目录递归扫描，单个 .md 文件直接加载
	for (const rawPath of skillPaths) {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!existsSync(resolvedPath)) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}

		try {
			const stats = statSync(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = loadSkillFromFile(resolvedPath, source);
				if (result.skill) {
					addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				} else {
					allDiagnostics.push(...result.diagnostics);
				}
			} else {
				// 既非目录也非 .md 文件：无法作为技能来源
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			// stat 失败（如权限问题）：记 warning 后继续处理下一个路径
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}

	// 普通警告在前、collision 诊断在后
	return {
		skills: Array.from(skillMap.values()),
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}
