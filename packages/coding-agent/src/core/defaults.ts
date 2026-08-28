/**
 * @file defaults.ts —— 默认值定义
 *
 * @description
 * 集中定义思考级别（thinking level）的默认档位与全部可选档位，
 * 供模型设置界面与配置解析共用。
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** 默认思考级别 */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
/** 可选的思考级别（从关闭到最大，按强度递增） */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
