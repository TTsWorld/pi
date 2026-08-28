/**
 * @file experimental.ts —— 实验性功能开关
 *
 * @description
 * 以环境变量 PI_EXPERIMENTAL=1 统一开启实验性功能；
 * 目前提供实验性的工具参数 strict JSON Schema 采样配置。
 */

// 实验特性：工具参数校验优先使用 strict JSON Schema
const PREFER_STRICT_TOOL_SAMPLING = { type: "json_schema", strict: "prefer" } as const;

/** 实验性功能是否整体开启（PI_EXPERIMENTAL=1） */
export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}

/** 获取实验性的工具采样配置；未开启实验特性时返回 undefined */
export function getExperimentalToolSampling() {
	return areExperimentalFeaturesEnabled() ? PREFER_STRICT_TOOL_SAMPLING : undefined;
}
