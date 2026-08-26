/**
 * @file 技能（Skill）加载器
 * @description 递归扫描目录，加载 agentskills.io 风格的 SKILL.md 文件：每个文件由
 * YAML frontmatter 元数据（name / description / disable-model-invocation 等）加 markdown
 * 正文组成。扫描过程尊重 .gitignore / .ignore / .fdignore 规则（基于 ignore 包实现），
 * 无效文件只产生警告诊断（SkillDiagnostic）而不会中断整体加载。
 * 加载出的技能由 system-prompt.ts 的 formatSkillsForSystemPrompt 组装成
 * `<available_skills>` 块拼入系统提示词。
 */
import ignore from "ignore";
import { parse } from "yaml";
import { type ExecutionEnv, type FileInfo, type Result, type Skill, toError } from "./types.ts";

/** 技能名称允许的最大长度（agentskills.io 规范）。 */
const MAX_NAME_LENGTH = 64;
/** 技能描述允许的最大长度。 */
const MAX_DESCRIPTION_LENGTH = 1024;
/** 扫描各目录时识别并应用的 ignore 文件名（均为 gitignore 语法）。 */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** ignore 包的 gitignore 匹配器实例类型（沿扫描树共享、逐层累加规则）。 */
type IgnoreMatcher = ReturnType<typeof ignore>;

/**
 * 技能加载诊断的错误码。
 *
 * - `file_info_failed`：获取文件/目录信息失败（not_found 除外，属正常跳过）
 * - `list_failed`：列目录失败
 * - `read_failed`：读取文件内容失败
 * - `parse_failed`：frontmatter 解析失败（仅对 SKILL.md 报告）
 * - `invalid_metadata`：name / description 未通过规范校验
 */
export type SkillDiagnosticCode =
	| "file_info_failed"
	| "list_failed"
	| "read_failed"
	| "parse_failed"
	| "invalid_metadata";

/** 技能加载过程中产生的警告。 */
export interface SkillDiagnostic {
	/** 诊断严重级别。当前只会产生 warning。 */
	type: "warning";
	/** 稳定的诊断码。 */
	code: SkillDiagnosticCode;
	/** 人类可读的诊断消息。 */
	message: string;
	/** 与该诊断关联的路径。 */
	path: string;
}

/** SKILL.md 的 YAML frontmatter 元数据结构（未知字段原样保留，宽松解析）。 */
interface SkillFrontmatter {
	/** 技能名；缺省时回退为父目录名。 */
	name?: string;
	/** 技能描述；散装 .md 文件必须提供非空 description 才会被视为技能。 */
	description?: string;
	/** 为 true 时该技能不进入模型可见列表，但仍可被应用显式调用。 */
	"disable-model-invocation"?: boolean;
	/** 允许任意扩展字段。 */
	[key: string]: unknown;
}

/**
 * 格式化技能调用提示词，可选地在末尾追加额外的用户指令。
 *
 * @param skill 要调用的技能
 * @param additionalInstructions 追加在技能块之后的额外用户指令
 * @returns 包含 `<skill>` XML 块（name / location / 正文）的提示词文本
 */
export function formatSkillInvocation(skill: Skill, additionalInstructions?: string): string {
	const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${dirnameEnvPath(skill.filePath)}.\n\n${skill.content}\n</skill>`;
	return additionalInstructions ? `${skillBlock}\n\n${additionalInstructions}` : skillBlock;
}

/**
 * 从一个或多个目录加载技能。
 *
 * 递归遍历目录，加载 `SKILL.md` 文件以及位于扫描根目录、带技能 frontmatter 的散装 `.md` 文件，
 * 尊重 ignore 文件规则，并为无效的声明式技能文件返回诊断。输入目录不存在时直接跳过。
 *
 * @param env 执行环境（文件系统操作的抽象接口）
 * @param dirs 待扫描的单个目录或目录数组
 * @returns 加载到的技能列表与诊断列表
 */
export async function loadSkills(
	env: ExecutionEnv,
	dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	// ========== 逐个扫描根目录 ==========
	// Why：每个根目录各建一个全新的 ignore 匹配器（ignore()），避免多个根目录的 ignore 规则互相污染。
	for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
		const rootInfoResult = await env.fileInfo(dir);
		if (!rootInfoResult.ok) {
			// 目录不存在属正常情况（调用方可传入可选目录），静默跳过；其余错误（如权限问题）记为警告
			if (rootInfoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: rootInfoResult.error.message,
					path: dir,
				});
			}
			continue;
		}
		const rootInfo = rootInfoResult.value;
		if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") continue;
		// includeRootFiles=true：仅扫描根目录下的散装 .md 文件会参与技能判定；此时 rootDir 即 dir 自身
		const result = await loadSkillsFromDirInternal(env, rootInfo.path, true, ignore(), rootInfo.path);
		skills.push(...result.skills);
		diagnostics.push(...result.diagnostics);
	}
	return { skills, diagnostics };
}

/**
 * 从带来源标签（source）的目录列表加载技能。
 *
 * source 值原样保留并附加到每个加载出的技能与诊断上。agent 包本身不解释 source 的含义，
 * 由应用自行定义其溯源（provenance）结构。
 *
 * @param env 执行环境
 * @param inputs 「目录路径 + 来源标签」组合列表
 * @param mapSkill 可选映射函数，把加载出的技能转换为自定义类型（如携带来源信息）
 * @returns 带 source 标签的技能列表与诊断列表
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapSkill?: (skill: Skill, source: TSource) => TSkill,
): Promise<{
	skills: Array<{ skill: TSkill; source: TSource }>;
	diagnostics: Array<SkillDiagnostic & { source: TSource }>;
}> {
	const skills: Array<{ skill: TSkill; source: TSource }> = [];
	const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
	// 逐目录加载，并把 source 标签附加到每条技能与每条诊断上
	for (const input of inputs) {
		const result = await loadSkills(env, input.path);
		for (const skill of result.skills) {
			skills.push({ skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill), source: input.source });
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { skills, diagnostics };
}

/**
 * 递归扫描单个目录并加载其中的技能（loadSkills 的内部实现）。
 *
 * 每个目录最多产出一个 SKILL.md 技能；散装 `.md` 文件只在扫描根目录
 * （includeRootFiles 为 true 时）参与技能判定。ignore 规则随递归逐层累加进共享匹配器。
 *
 * @param env 执行环境
 * @param dir 待扫描目录
 * @param includeRootFiles 是否把该目录下的散装 .md 文件视为技能候选（仅扫描根目录为 true）
 * @param ignoreMatcher 沿递归共享的 gitignore 匹配器
 * @param rootDir 扫描根目录，用于计算 ignore 匹配所需的相对路径
 * @returns 该目录子树加载到的技能与诊断
 */
async function loadSkillsFromDirInternal(
	env: ExecutionEnv,
	dir: string,
	includeRootFiles: boolean,
	ignoreMatcher: IgnoreMatcher,
	rootDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];

	const dirInfoResult = await env.fileInfo(dir);
	if (!dirInfoResult.ok) {
		if (dirInfoResult.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: dirInfoResult.error.message,
				path: dir,
			});
		}
		return { skills, diagnostics };
	}
	const dirInfo = dirInfoResult.value;
	if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory") return { skills, diagnostics };

	// 进入目录先应用本目录的 ignore 规则，再列目录：保证后续条目过滤用的是最新规则集
	await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);

	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({ type: "warning", code: "list_failed", message: entriesResult.error.message, path: dir });
		return { skills, diagnostics };
	}
	const entries = entriesResult.value;

	// ========== 第一遍：本目录下的 SKILL.md（声明式技能） ==========
	// Why：agentskills.io 约定一个技能目录只放一个 SKILL.md，因此命中第一个
	// （通过 ignore 过滤且确认是普通文件的）SKILL.md 后立即返回，不再遍历其余条目与子目录。
	for (const entry of entries) {
		if (entry.name !== "SKILL.md") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file") continue;
		const relPath = relativeEnvPath(rootDir, fullPath);
		// ignore 过滤：SKILL.md 自身被规则命中时同样跳过
		if (ignoreMatcher.ignores(relPath)) continue;

		const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
		return { skills, diagnostics };
	}

	// ========== 第二遍：按名称排序遍历其余条目 ==========
	// Why：先排序保证不同平台/文件系统的列目录顺序差异不影响加载结果的顺序；
	// 隐藏条目（"." 开头）与 node_modules 一律不进入，避免误扫版本控制与依赖目录。
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = entry.path;
		const kind = await resolveKind(env, entry, diagnostics);
		if (!kind) continue;

		const relPath = relativeEnvPath(rootDir, fullPath);
		// 目录补上尾部 "/"：gitignore 语义下目录模式（如 "build/"）靠斜杠区分目录与文件
		const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
		if (ignoreMatcher.ignores(ignorePath)) continue;

		if (kind === "directory") {
			// 递归子目录时 includeRootFiles 置为 false：散装 .md 只在扫描根目录生效，
			// 嵌套技能必须遵循 SKILL.md 约定
			const result = await loadSkillsFromDirInternal(env, fullPath, false, ignoreMatcher, rootDir);
			skills.push(...result.skills);
			diagnostics.push(...result.diagnostics);
			continue;
		}

		// 散装 .md：要求位于扫描根目录（includeRootFiles）且以 .md 结尾
		if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
		const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
		if (result.skill) skills.push(result.skill);
		diagnostics.push(...result.diagnostics);
	}

	return { skills, diagnostics };
}

/**
 * 读取目录下的 ignore 文件（.gitignore / .ignore / .fdignore），把规则累加进共享匹配器。
 *
 * Why：git 语义中嵌套 ignore 文件的模式相对于其所在目录生效，因此非根目录的规则
 * 需先加上该目录相对根目录的路径前缀再注册，才能与全树统一使用的「相对根目录路径」匹配方式一致。
 *
 * @param env 执行环境
 * @param ig 目标 ignore 匹配器（原地累加规则）
 * @param dir 当前目录
 * @param rootDir 扫描根目录，用于计算路径前缀
 * @param diagnostics 输出诊断列表
 */
async function addIgnoreRules(
	env: ExecutionEnv,
	ig: IgnoreMatcher,
	dir: string,
	rootDir: string,
	diagnostics: SkillDiagnostic[],
): Promise<void> {
	// 根目录自身前缀为空串；子目录前缀形如 "sub/"，用于改写该目录 ignore 文件中的相对模式
	const relativeDir = relativeEnvPath(rootDir, dir);
	const prefix = relativeDir ? `${relativeDir}/` : "";

	// ========== 逐个尝试已知的 ignore 文件名 ==========
	// not_found（文件不存在）属正常情况，静默跳过；读取/解析失败仅记警告，不阻断扫描。
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePathResult = await env.joinPath([dir, filename]);
		if (!ignorePathResult.ok) {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: ignorePathResult.error.message,
				path: dir,
			});
			continue;
		}
		const ignorePath = ignorePathResult.value;
		const info = await env.fileInfo(ignorePath);
		if (!info.ok) {
			if (info.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: info.error.message,
					path: ignorePath,
				});
			}
			continue;
		}
		if (info.value.kind !== "file") continue;
		const content = await env.readTextFile(ignorePath);
		if (!content.ok) {
			diagnostics.push({ type: "warning", code: "read_failed", message: content.error.message, path: ignorePath });
			continue;
		}
		// 逐行改写为带前缀的模式，丢弃空白行与注释行；全部为空则不注册
		const patterns = content.value
			.split(/\r?\n/)
			.map((line) => prefixIgnorePattern(line, prefix))
			.filter((line): line is string => Boolean(line));
		if (patterns.length > 0) ig.add(patterns);
	}
}

/**
 * 把 ignore 文件中的单行模式改写为相对扫描根目录的形式。
 *
 * 处理空白行与注释行（返回 null 表示丢弃）、`!` 取反与 `\!` 转义，
 * 并去掉模式开头的 `/`（锚定语义改由目录前缀承载）。
 *
 * @param line ignore 文件中的原始行
 * @param prefix 所在目录相对根目录的路径前缀（形如 "sub/"，根目录为空串）
 * @returns 改写后的模式；空白行或注释行返回 null
 */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	// 空白行与注释行丢弃；"\#" 是被转义的字面 # 文件名，需要保留
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	// "!pattern" 为取反规则（重新包含被忽略的文件）；"\!pattern" 中的 "\!" 是被转义的字面 !
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	// 去掉开头 "/"：加上目录前缀后仍保持「从该目录锚定」的语义
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

/**
 * 读取单个技能文件（SKILL.md 或根级散装 .md），解析 frontmatter 并构建 Skill。
 *
 * 校验失败不抛异常：只要 description 非空就照常返回技能，name / description 的
 * 规范违规仅以警告诊断形式返回，由调用方决定如何呈现。
 *
 * @param env 执行环境
 * @param filePath 技能文件路径
 * @param parentDirName 父目录名，作为 name 的缺省值并参与一致性校验
 * @returns 构建出的技能（失败为 null）与诊断列表
 */
async function loadSkillFromFile(
	env: ExecutionEnv,
	filePath: string,
	parentDirName: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
	const diagnostics: SkillDiagnostic[] = [];
	// ========== 判定文件类别：声明式技能（SKILL.md）vs 散装 .md ==========
	// Why：两类文件容错策略不同——SKILL.md 是显式声明的技能，任何问题都要报告；
	// 散装 .md 可能只是普通文档，问题发生时静默忽略即可。
	const isDeclaredSkill =
		filePath
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.pop() === "SKILL.md";
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({ type: "warning", code: "read_failed", message: rawContent.error.message, path: filePath });
		return { skill: null, diagnostics };
	}

	// ========== 解析 frontmatter ==========
	// 声明式技能解析失败记 parse_failed 诊断；散装 .md 解析失败则静默放弃（可能只是普通文档）
	const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		if (isDeclaredSkill) {
			diagnostics.push({ type: "warning", code: "parse_failed", message: parsed.error.message, path: filePath });
		}
		return { skill: null, diagnostics };
	}

	const { frontmatter, body } = parsed.value;
	const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
	// 散装 .md 必须带非空 description 才视为技能（以此区分技能与普通文档），否则静默忽略
	if (!isDeclaredSkill && (!description || description.trim() === "")) {
		return { skill: null, diagnostics };
	}

	// ========== 元数据校验（记警告，但尽量不拦截加载） ==========
	// Why：name / description 的轻度违规（超长、字符不规范）不影响技能可用性，仅告警提示；
	// 但 description 缺失时技能无法进入模型可见列表，只能放弃该技能（声明式技能已带上诊断）。
	for (const error of validateDescription(description)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	// name 缺省时回退为父目录名（即 SKILL.md 所在技能目录的目录名）
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || parentDirName;
	for (const error of validateName(name, parentDirName)) {
		diagnostics.push({ type: "warning", code: "invalid_metadata", message: error, path: filePath });
	}

	if (!description || description.trim() === "") {
		return { skill: null, diagnostics };
	}

	return {
		skill: {
			name,
			description,
			content: body,
			filePath,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * 校验技能名称是否符合 agentskills.io 命名规范。
 *
 * @param name 待校验的名称（frontmatter.name 或回退后的父目录名）
 * @param parentDirName 父目录名，用于一致性校验
 * @returns 违规消息列表；为空表示通过
 */
function validateName(name: string, parentDirName: string): string[] {
	const errors: string[] = [];
	// 规范要求 name 与技能目录名一致，避免同一技能出现两套叫法
	if (name !== parentDirName) errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) {
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	}
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

/**
 * 校验技能描述：必填且不超过最大长度。
 *
 * @param description frontmatter 中的 description（可能缺失）
 * @returns 违规消息列表；为空表示通过
 */
function validateDescription(description: string | undefined): string[] {
	const errors: string[] = [];
	if (!description || description.trim() === "") {
		errors.push("description is required");
	} else if (description.length > MAX_DESCRIPTION_LENGTH) {
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	}
	return errors;
}

/**
 * 解析 markdown 内容顶部的 YAML frontmatter（`---` 围栏块）。
 *
 * 围栏不完整（开头不是 `---`，或找不到结束标记）不视为错误：整个内容作为正文、
 * frontmatter 记为空对象；只有 YAML 解析本身抛错才返回失败。
 *
 * @param content 文件的原始文本
 * @returns 成功时返回 `{ frontmatter, body }`；YAML 解析抛错时返回 Error
 */
function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		// 统一换行符，避免 \r\n / \r 干扰围栏标记的匹配
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		// 没有 frontmatter 起始围栏：当作纯正文处理
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		// 找不到结束围栏：同样当作纯正文，而非报错
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const yamlString = normalized.slice(4, endIndex);
		// endIndex 指向结束围栏前的 "\n---"，+4 恰好跳过它；正文去掉首尾空白
		const body = normalized.slice(endIndex + 4).trim();
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		return { ok: false, error: toError(error) };
	}
}

/**
 * 解析条目的实际类型（"file" / "directory"），必要时穿透符号链接。
 *
 * Why：listDir / fileInfo 返回的 kind 可能是 symlink 等其他值；对非 file/directory 的条目
 * 先做 canonicalPath 归一化，再对目标路径取 fileInfo，得到符号链接指向的真实类型。
 *
 * @param env 执行环境
 * @param info 待解析的条目信息
 * @param diagnostics 输出诊断列表
 * @returns "file" 或 "directory"；目标不存在或类型仍不明确时返回 undefined
 */
async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	// kind 已明确是文件或目录：直接返回
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	// 其余类型（如 symlink）：解析真实路径后再判定目标类型
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		// not_found 属正常情况（如悬空符号链接），静默跳过；其余错误记警告
		if (canonicalPath.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: canonicalPath.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		// 目标不存在同样静默跳过，其余错误记警告
		if (target.error.code !== "not_found") {
			diagnostics.push({
				type: "warning",
				code: "file_info_failed",
				message: target.error.message,
				path: info.path,
			});
		}
		return undefined;
	}
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

/**
 * 取路径的父目录部分，同时兼容 `/` 与 `\` 两种分隔符（跨平台执行环境）。
 *
 * @param path 任意格式的路径
 * @returns 父目录路径；Windows 盘符根（如 `C:\`）原样保留，路径中无分隔符时返回 "/"
 */
function dirnameEnvPath(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	// 取两种分隔符中最后出现的位置
	const separatorIndex = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
	// 形如 "C:\x"：分隔符下标为 2 且第 2 个字符是 ":"，说明截到的是盘符根，保留 "C:\"
	if (separatorIndex === 2 && normalized[1] === ":") return normalized.slice(0, 3);
	// 无分隔符（或只在开头有 "/"）：回退为根目录
	return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

/**
 * 计算路径相对扫描根目录的相对路径（统一为 `/` 分隔符），供 gitignore 匹配使用。
 *
 * @param root 扫描根目录
 * @param path 目标路径
 * @returns 相对路径；与根相同返回空串；不在根之下时去掉开头斜杠后原样返回
 */
function relativeEnvPath(root: string, path: string): string {
	// 统一分隔符为 "/"，并去掉尾部斜杠
	const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
	const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
	if (normalizedPath === normalizedRoot) return "";
	// 位于根目录之下：截掉 "根/" 前缀；否则（路径不在根下）仅去掉开头的斜杠
	return normalizedPath.startsWith(`${normalizedRoot}/`)
		? normalizedPath.slice(normalizedRoot.length + 1)
		: normalizedPath.replace(/^\/+/, "");
}
