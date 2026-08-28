/**
 * @file diagnostics.ts —— 资源加载诊断类型
 *
 * @description
 * 描述资源（扩展 / skill / prompt / 主题）加载过程中的
 * 告警、错误与命名冲突，供诊断界面统一展示。
 */

/** 资源命名冲突：两个资源注册了同名项，loser 被 winner 压制 */
export interface ResourceCollision {
	resourceType: "extension" | "skill" | "prompt" | "theme";
	name: string; // 冲突名称：skill 名 / 命令、工具或 flag 名 / prompt 名 / 主题名
	winnerPath: string;
	loserPath: string;
	winnerSource?: string; // 来源描述，如 "npm:foo"、"git:..."、"local"
	loserSource?: string;
}

/** 单条资源诊断信息 */
export interface ResourceDiagnostic {
	type: "warning" | "error" | "collision";
	message: string;
	path?: string;
	collision?: ResourceCollision;
}
