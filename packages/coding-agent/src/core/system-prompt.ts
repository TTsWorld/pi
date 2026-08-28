/**
 * @file system-prompt.ts —— 系统提示词组装
 *
 * @description
 * 负责构建 coding-agent 的系统提示词：默认提示词（身份说明 + 可用工具清单 +
 * 行为准则 + pi 文档指引）之上，依次叠加追加文本、项目上下文文件
 * （AGENTS.md 等）与 skills 清单；也支持用自定义提示词整体替换默认提示词。
 *
 * 提示词中的工具清单与准则条目会根据实际选用的工具动态裁剪，
 * 避免向模型描述它并不具备的能力。
 *
 * 依赖关系：
 * - `../config.ts`：README / docs / examples 的安装路径；
 * - `./skills.ts`：Skill 类型与 formatSkillsForPrompt（skills 清单格式化）。
 */

import { getDocsPath, getExamplesPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** 自定义系统提示词（提供时将整体替换默认提示词）。 */
	customPrompt?: string;
	/** 要写进提示词的工具列表。默认：[read, bash, edit, write] */
	selectedTools?: string[];
	/** 可选的工具一句话简介，按工具名索引；没有简介的工具不会出现在清单中。 */
	toolSnippets?: Record<string, string>;
	/** 追加到默认提示词 guidelines 之后的额外准则条目。 */
	promptGuidelines?: string[];
	/** 追加到系统提示词末尾的文本。 */
	appendSystemPrompt?: string;
	/** 工作目录。 */
	cwd: string;
	/** 预加载的上下文文件（AGENTS.md / SYSTEM.md 等），省略时不再读盘。 */
	contextFiles?: Array<{ path: string; content: string }>;
	/** 预加载的 skills。 */
	skills?: Skill[];
}

/**
 * 组装系统提示词：默认提示词（或自定义提示词）+ 追加文本 +
 * 项目上下文文件 + skills 清单，最后附上当前工作目录。
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	// 提示词中的路径统一用正斜杠，避免 Windows 反斜杠被模型误解为转义
	const promptCwd = cwd.replace(/\\/g, "/");

	// 追加文本预格式化（带两个空行前缀），自定义/默认两个分支共用
	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	// 未提供时使用空数组：本模块不负责读盘，由调用方预加载后传入
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	// ===== 自定义提示词分支：以 customPrompt 为主体，跳过默认提示词的拼装 =====
	if (customPrompt) {
		let prompt = customPrompt;

		// 自定义提示词同样支持追加文本
		if (appendSection) {
			prompt += appendSection;
		}

		// 追加项目上下文文件（AGENTS.md 等）
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// 追加 skills 清单（仅当 read 工具可用——skills 需要 read 才能被读取）
		const customPromptHasRead = !selectedTools || selectedTools.includes("read");
		if (customPromptHasRead && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// 提示词末尾统一附上当前工作目录（带换行收尾）
		prompt += `\nCurrent working directory: ${promptCwd}\n`;

		return prompt;
	}

	// 取 pi 文档与示例的安装路径（提示词中引导模型按需查阅）
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// ===== 组装工具清单 =====
	// 只有调用方提供了单行简介的工具才会出现在 Available tools 中，
	// 避免「列了却不可用」或「可用却没列」两种误导。
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	// ===== 组装行为准则（按实际可用的工具裁剪 + 去重） =====
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		// Set 去重，保持首次出现的顺序（调用方传入与内置条目可能重复）
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	// 工具可用性探测：后续按这些布尔值裁剪适用的准则条目
	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");

	// 文件探索准则：仅在没有专用 grep/find/ls 工具时，才引导模型用 shell 做文件操作
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
		} else if (hasPowerShell) {
			addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
		} else {
			addGuideline("Use bash for file operations like ls, rg, find");
		}
	}

	// 调用方附加的准则条目（跳过纯空白行）
	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// 内置兜底准则：无论如何始终包含
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	// 准则条目格式化为 Markdown 无序列表
	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	// ===== 默认提示词模板：身份 + 工具清单 + 准则 + pi 文档指引 =====
	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

	if (appendSection) {
		prompt += appendSection;
	}

	// 追加项目上下文文件（AGENTS.md 等），以 <project_instructions> 逐个包裹
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// 追加 skills 清单（仅当 read 工具可用——模型需要 read 才能读取 skill 文件）
	if (hasRead && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
