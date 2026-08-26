/**
 * @file 系统提示词组装
 * @description 提供 {@link formatSkillsForSystemPrompt}，把技能列表格式化为
 * agentskills.io 风格的 `<available_skills>` XML 块，供拼入系统提示词。
 */
import type { Skill } from "./types.ts";

/**
 * 把技能列表格式化为可嵌入系统提示词的 agentskills.io 风格 XML 块。
 *
 * 会先过滤掉标记了 `disableModelInvocation` 的技能；若没有对模型可见的技能，直接返回空字符串。
 * 输出由一段引导模型使用技能的说明，加上每个技能的 `<skill>` 块（name / description / location）组成。
 *
 * @param skills 全量技能列表
 * @returns 可直接拼入系统提示词的文本；无可见技能时返回空字符串
 */
export function formatSkillsForSystemPrompt(skills: Skill[]): string {
	// 只保留对模型可见的技能（被隐藏的技能仍可被应用显式调用）
	const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	// 引导说明：按描述匹配任务、读取完整技能文件、相对路径以技能目录为基准解析
	const lines = [
		"The following skills provide specialized instructions for specific tasks.",
		"Read the full skill file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];

	// 每个技能输出一个 <skill> 块；name/description/location 均需做 XML 转义
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

/** 转义 XML 特殊字符（& < > " '），避免技能的名称/描述/路径破坏 XML 结构。 */
function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
