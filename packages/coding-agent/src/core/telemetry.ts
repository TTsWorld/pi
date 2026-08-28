/**
 * @file telemetry.ts —— 安装遥测开关
 *
 * @description
 * 判断「安装遥测」是否启用：环境变量 PI_TELEMETRY 优先
 * （取 1/true/yes 为开），未设置时回落到设置文件中的开关。
 */
import type { SettingsManager } from "./settings-manager.ts";

/** 判断环境变量值是否为「真」：1 / true / yes（不区分大小写） */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/** 安装遥测是否启用 */
export function isInstallTelemetryEnabled(
	settingsManager: SettingsManager,
	telemetryEnv: string | undefined = process.env.PI_TELEMETRY,
): boolean {
	// 显式设置了 PI_TELEMETRY 时以环境变量为准，否则读用户设置
	return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();
}
