/**
 * @file 提示词模板的磁盘加载与解析
 * @description 从磁盘把 `.md` 提示词模板加载为 {@link PromptTemplate}，供 AgentHarness 的
 * promptFromTemplate 显式调用。支持两种输入：目录（非递归加载其直接的 `.md` 子文件）与单个
 * `.md` 文件；文件可携带 YAML frontmatter 元数据（description / argument-hint 等）。
 * 所有文件系统访问均经由 {@link ExecutionEnv} 能力抽象完成；读取与解析失败不抛出异常，
 * 而是以 {@link PromptTemplateDiagnostic} 警告的形式随结果返回。此外还提供模板调用辅助：
 * `parseCommandArgs`（shell 风格参数切分）、`substituteArgs` / `formatPromptTemplateInvocation`
 * （把位置参数替换进模板占位符）。
 */
import { parse } from "yaml";
import { type ExecutionEnv, type FileInfo, type PromptTemplate, type Result, toError } from "./types.ts";

/** 模板加载失败诊断码，标识失败发生在哪个阶段（取元信息 / 列目录 / 读文件 / 解析 frontmatter）。 */
export type PromptTemplateDiagnosticCode = "file_info_failed" | "list_failed" | "read_failed" | "parse_failed";

/** 加载提示词模板时产生的警告。 */
export interface PromptTemplateDiagnostic {
	/** 诊断严重级别。目前只会产生 warning。 */
	type: "warning";
	/** 稳定的诊断码，见 {@link PromptTemplateDiagnosticCode}。 */
	code: PromptTemplateDiagnosticCode;
	/** 人类可读的诊断消息。 */
	message: string;
	/** 与该诊断关联的路径。 */
	path: string;
}

/** 模板 `.md` 文件头部 frontmatter 的已知字段；结构宽松，未知字段原样保留不作解释。 */
interface PromptTemplateFrontmatter {
	/** 模板描述，用于命令列表 / 自动补全展示；缺失时回退取正文首行（截断到 60 字符）。 */
	description?: string;
	/** 参数提示（如 `<file> [line]`）。本包只负责解析、不做消费，由应用层自行取用。 */
	"argument-hint"?: string;
	/** 允许携带任意未知字段。 */
	[key: string]: unknown;
}

/**
 * 从一个或多个路径加载提示词模板。
 *
 * 目录输入：非递归加载其直接的 `.md` 子文件；文件输入：加载显式指定的 `.md` 文件。
 * 不存在的路径与非 markdown 文件会被静默跳过（属于预期内情况，不算错误）；
 * 读取与解析失败则以诊断（diagnostics）形式返回。
 *
 * @param env 执行环境抽象，所有文件系统操作经由它完成（便于替换为沙箱 / 远程环境）
 * @param paths 单个路径或路径数组
 * @returns 加载成功的模板列表与过程中产生的警告列表
 */
export async function loadPromptTemplates(
	env: ExecutionEnv,
	paths: string | string[],
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	// ========== 路径遍历与分派 ==========
	// 逐个路径处理（顺序加载而非并发，保证模板在结果中的顺序与输入一致）；
	// 单个路径失败只记录诊断，不中断其余路径的加载。
	for (const path of Array.isArray(paths) ? paths : [paths]) {
		const infoResult = await env.fileInfo(path);
		if (!infoResult.ok) {
			// not_found 视为「路径不存在」，静默跳过；其他错误（权限等）记为诊断。
			if (infoResult.error.code !== "not_found") {
				diagnostics.push({
					type: "warning",
					code: "file_info_failed",
					message: infoResult.error.message,
					path,
				});
			}
			continue;
		}
		const info = infoResult.value;
		// 先解析真实类型（fileInfo 的 kind 不跟随符号链接，需经 canonicalPath 二次确认）
		const kind = await resolveKind(env, info, diagnostics);
		if (kind === "directory") {
			const result = await loadTemplatesFromDir(env, info.path);
			promptTemplates.push(...result.promptTemplates);
			diagnostics.push(...result.diagnostics);
		} else if (kind === "file" && info.name.endsWith(".md")) {
			// 非 .md 文件（以及无法识别的类型）不产生诊断，直接跳过
			const result = await loadTemplateFromFile(env, info.path, info.name);
			if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
			diagnostics.push(...result.diagnostics);
		}
	}
	return { promptTemplates, diagnostics };
}

/**
 * 从带来源（source）标记的路径加载提示词模板。
 *
 * source 值被原样保留，并附加到每个加载出的模板与诊断上。agent 包本身不解释 source
 * 的含义（溯源形状由应用自行定义），便于上层知道「这个模板是从哪儿来的」。
 *
 * @param env 执行环境抽象
 * @param inputs 输入列表：每项包含一个路径与对应的 source 标记
 * @param mapPromptTemplate 可选映射函数，把基础模板转换为应用自定义的模板类型（如补充来源信息）
 * @returns 每个模板 / 诊断均携带其所属输入的 source 标记
 */
export async function loadSourcedPromptTemplates<TSource, TPromptTemplate extends PromptTemplate = PromptTemplate>(
	env: ExecutionEnv,
	inputs: Array<{ path: string; source: TSource }>,
	mapPromptTemplate?: (promptTemplate: PromptTemplate, source: TSource) => TPromptTemplate,
): Promise<{
	promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }>;
	diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }>;
}> {
	const promptTemplates: Array<{ promptTemplate: TPromptTemplate; source: TSource }> = [];
	const diagnostics: Array<PromptTemplateDiagnostic & { source: TSource }> = [];
	for (const input of inputs) {
		// 复用 loadPromptTemplates 完成实际加载，再把 source 标记贴回每条结果上
		const result = await loadPromptTemplates(env, input.path);
		for (const promptTemplate of result.promptTemplates) {
			promptTemplates.push({
				promptTemplate: mapPromptTemplate
					? mapPromptTemplate(promptTemplate, input.source)
					: (promptTemplate as TPromptTemplate),
				source: input.source,
			});
		}
		for (const diagnostic of result.diagnostics) diagnostics.push({ ...diagnostic, source: input.source });
	}
	return { promptTemplates, diagnostics };
}

/**
 * 从目录加载提示词模板（非递归，只取直接的 `.md` 子文件）。
 *
 * @param env 执行环境抽象
 * @param dir 目标目录路径
 * @returns 加载出的模板列表与过程中产生的警告列表
 */
async function loadTemplatesFromDir(
	env: ExecutionEnv,
	dir: string,
): Promise<{ promptTemplates: PromptTemplate[]; diagnostics: PromptTemplateDiagnostic[] }> {
	const promptTemplates: PromptTemplate[] = [];
	const diagnostics: PromptTemplateDiagnostic[] = [];
	// ========== 列目录失败处理 ==========
	// 目录本身列不出来（权限被拒等）时，整目录记一条 list_failed 警告并提前返回。
	const entriesResult = await env.listDir(dir);
	if (!entriesResult.ok) {
		diagnostics.push({
			type: "warning",
			code: "list_failed",
			message: entriesResult.error.message,
			path: dir,
		});
		return { promptTemplates, diagnostics };
	}
	const entries = entriesResult.value;

	// ========== 排序后遍历 ==========
	// 按文件名 localeCompare 排序：文件系统不保证 listDir 的返回顺序，排序可让
	// 模板加载顺序确定（下游按序展示 / 查找时行为稳定，不受平台差异影响）。
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		// 仍需逐项 resolveKind：目录项本身也可能是符号链接，且要过滤掉子目录与非 .md 文件
		const kind = await resolveKind(env, entry, diagnostics);
		if (kind !== "file" || !entry.name.endsWith(".md")) continue;
		const result = await loadTemplateFromFile(env, entry.path, entry.name);
		if (result.promptTemplate) promptTemplates.push(result.promptTemplate);
		diagnostics.push(...result.diagnostics);
	}
	return { promptTemplates, diagnostics };
}

/**
 * 加载单个 `.md` 文件为提示词模板：读取 → 解析 frontmatter → 组装模板对象。
 *
 * 模板名取自文件名（去掉 `.md` 后缀）；描述优先取 frontmatter 的 `description`，
 * 缺失时回退取正文首个非空行（超 60 字符截断并加省略号），保证命令列表始终有可展示的描述。
 *
 * @param env 执行环境抽象
 * @param filePath 文件路径
 * @param fileName 文件名（用于派生模板名）
 * @returns 成功时返回模板；读取或解析失败返回 `null` 并附带对应的警告
 */
async function loadTemplateFromFile(
	env: ExecutionEnv,
	filePath: string,
	fileName: string,
): Promise<{ promptTemplate: PromptTemplate | null; diagnostics: PromptTemplateDiagnostic[] }> {
	const diagnostics: PromptTemplateDiagnostic[] = [];
	// ========== 读取文件 ==========
	const rawContent = await env.readTextFile(filePath);
	if (!rawContent.ok) {
		diagnostics.push({
			type: "warning",
			code: "read_failed",
			message: rawContent.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	// ========== 解析 frontmatter ==========
	// 解析失败（如 YAML 语法错误）同样以警告返回并跳过该文件，不影响其他模板加载
	const parsed = parseFrontmatter<PromptTemplateFrontmatter>(rawContent.value);
	if (!parsed.ok) {
		diagnostics.push({
			type: "warning",
			code: "parse_failed",
			message: parsed.error.message,
			path: filePath,
		});
		return { promptTemplate: null, diagnostics };
	}

	// ========== 组装模板：描述回退与命名 ==========
	const { frontmatter, body } = parsed.value;
	// 正文首个非空行，用于无 frontmatter 描述时的回退
	const firstLine = body.split("\n").find((line) => line.trim());
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description && firstLine) {
		// 截断到 60 字符，超出则追加省略号（描述仅用于展示，无需全文）
		description = firstLine.slice(0, 60);
		if (firstLine.length > 60) description += "...";
	}
	return {
		promptTemplate: {
			// 模板名 = 文件名去掉（大小写不敏感的）.md 后缀
			name: fileName.replace(/\.md$/i, ""),
			description,
			content: body,
		},
		diagnostics,
	};
}

/**
 * 解析路径条目的真实类型（file / directory / 无法识别）。
 *
 * Why 二次解析：{@link FileInfo.kind} 本身不跟随符号链接（符号链接项会得到 symlink 之类的
 * kind），因此对非 file/directory 的条目先取 canonicalPath 解引用，再对目标重新做 fileInfo，
 * 从而让指向 `.md` 文件或目录的符号链接也能被正常加载。两类探测中 not_found 均静默跳过
 * （悬空符号链接视为不存在），其余错误记入诊断。
 *
 * @param env 执行环境抽象
 * @param info 待确认类型的路径条目元信息
 * @param diagnostics 输出参数：探测过程中产生的警告会追加到这里
 * @returns "file"、"directory"，或无法识别 / 不存在时返回 undefined
 */
async function resolveKind(
	env: ExecutionEnv,
	info: FileInfo,
	diagnostics: PromptTemplateDiagnostic[],
): Promise<"file" | "directory" | undefined> {
	// 常规情形：kind 本身就是 file / directory，直接采用
	if (info.kind === "file" || info.kind === "directory") return info.kind;
	// ========== 符号链接解析：先取规范化路径 ==========
	const canonicalPath = await env.canonicalPath(info.path);
	if (!canonicalPath.ok) {
		// not_found（悬空链接等）静默跳过；其他错误记为诊断
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
	// ========== 再对链接目标重新取元信息 ==========
	const target = await env.fileInfo(canonicalPath.value);
	if (!target.ok) {
		// 目标在取信息前消失（竞态）同样按不存在处理
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
	// 目标也不是 file / directory（如指向设备、socket 等）时视为不可加载
	return target.value.kind === "file" || target.value.kind === "directory" ? target.value.kind : undefined;
}

/**
 * 手工解析 Markdown 文件头部的 YAML frontmatter，把内容拆为「元数据 + 正文」两部分。
 *
 * 约定格式：文件以 `---` 行开头，随后是 YAML，再以 `---` 行结束。没有 frontmatter
 * 或缺少结束围栏时，整个内容都视为正文（返回空 frontmatter），不视为错误。
 *
 * @param content 文件的原始文本内容
 * @returns 成功时返回 `{ frontmatter, body }`；YAML 解析抛错时返回失败
 */
function parseFrontmatter<T extends Record<string, unknown>>(
	content: string,
): Result<{ frontmatter: T; body: string }, Error> {
	try {
		// ========== 换行符规范化 ==========
		// 统一 CRLF / CR 为 LF：后续围栏定位按「字符位置」硬编码切片（见下），
		// 若不先规范化，Windows 换行会把偏移量算错。
		const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		// ========== 无 frontmatter 的快速路径 ==========
		// 不以 --- 开头，或找不到结束围栏（\n---，从第 3 个字符起找，跳过开头的 --- 本身）：
		// 均按纯正文处理
		if (!normalized.startsWith("---")) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return { ok: true, value: { frontmatter: {} as T, body: normalized } };
		// ========== 切片拆分 ==========
		// 偏移量约定（假定两个围栏各独占一行）：
		//   - 索引 0..2 是开头的 ---，索引 3 是其后的换行符，故 YAML 从索引 4 开始；
		//   - endIndex 指向结束围栏前的换行符，跳过 4 个字符（\n---）即为正文起点。
		const yamlString = normalized.slice(4, endIndex);
		const body = normalized.slice(endIndex + 4).trim();
		// 空 YAML 会 parse 出 null，统一兜底为空对象
		return { ok: true, value: { frontmatter: (parse(yamlString) ?? {}) as T, body } };
	} catch (error) {
		// yaml 库解析失败会 throw，这里转为显式错误返回（由调用方转成 parse_failed 诊断）
		return { ok: false, error: toError(error) };
	}
}

/**
 * 用简单的 shell 风格单引号 / 双引号规则切分参数字符串。
 *
 * 引号内的空白不参与切分，引号本身会被剥掉；连续空白（空格 / Tab）视为单个分隔符；
 * 不支持反斜杠转义。未闭合的引号按「持续到字符串末尾」处理。
 *
 * @param argsString 原始参数字符串（如模板命令后跟的参数部分）
 * @returns 切分后的参数数组
 */
export function parseCommandArgs(argsString: string): string[] {
	const args: string[] = [];
	let current = "";
	let inQuote: string | null = null;

	// ========== 单趟扫描状态机 ==========
	// 三种状态：引号内（只识别配对引号）、引号外遇到引号（进入引号）、
	// 引号外遇到空白（结束当前词）或普通字符（累积）。
	for (let i = 0; i < argsString.length; i++) {
		const char = argsString[i]!;
		if (inQuote) {
			if (char === inQuote) inQuote = null;
			else current += char;
		} else if (char === '"' || char === "'") {
			inQuote = char;
		} else if (char === " " || char === "\t") {
			// current 为空说明是连续空白 / 行首空白，直接跳过（不产生空参数）
			if (current) {
				args.push(current);
				current = "";
			}
		} else {
			current += char;
		}
	}
	// 收尾：字符串结束时若还有未落盘的词（末尾无空白）补上
	if (current) args.push(current);
	return args;
}

/**
 * 把模板内容中的参数占位符替换为命令参数。
 *
 * 支持的占位符：
 * - `$1`、`$2`…：1 起始的位置参数，越界时替换为空串；
 * - `${@:N}`：从第 N 个参数到末尾；`${@:N:L}`：从第 N 个起取 L 个（空格连接）；
 * - `$ARGUMENTS` / `$@`：全部参数以空格连接。
 *
 * @param content 模板原文
 * @param args 已切分的参数列表
 * @returns 完成占位符替换后的文本
 */
export function substituteArgs(content: string, args: string[]): string {
	let result = content;
	// ========== 位置参数：$1、$2… ==========
	result = result.replace(/\$(\d+)/g, (_, num: string) => args[parseInt(num, 10) - 1] ?? "");
	// ========== 切片参数：${@:N} / ${@:N:L} ==========
	result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr: string, lengthStr?: string) => {
		let start = parseInt(startStr, 10) - 1;
		if (start < 0) start = 0;
		if (lengthStr) return args.slice(start, start + parseInt(lengthStr, 10)).join(" ");
		return args.slice(start).join(" ");
	});
	// ========== 全量参数：$ARGUMENTS / $@（放在最后替换） ==========
	const allArgs = args.join(" ");
	result = result.replace(/\$ARGUMENTS/g, allArgs);
	result = result.replace(/\$@/g, allArgs);
	return result;
}

/**
 * 用位置参数格式化一次提示词模板调用：对模板内容做占位符替换并返回最终提示词。
 *
 * @param template 目标模板
 * @param args 调用时传入的位置参数，默认为空数组（占位符替换为空串）
 * @returns 替换后的完整提示词文本
 */
export function formatPromptTemplateInvocation(template: PromptTemplate, args: string[] = []): string {
	return substituteArgs(template.content, args);
}
