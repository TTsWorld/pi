/**
 * @file settings-diagnostics.ts —— 设置加载错误诊断
 *
 * @description
 * 把 SettingsManager 攒下的设置加载/解析错误转成运行时诊断项，
 * 并提供诊断去重（启动与运行期的设置管理器可能报告同一处错误）。
 */
import type { AgentSessionRuntimeDiagnostic } from "./agent-session-services.ts";
import type { SettingsManager } from "./settings-manager.ts";

/** 收集设置管理器中积压的全部错误，映射为 warning 级诊断项 */
export function collectSettingsDiagnostics(settingsManager: SettingsManager): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, path, error }) => ({
		type: "warning",
		message: path ? `Invalid settings file ${path}: ${error.message}` : `Invalid ${scope} settings: ${error.message}`,
	}));
}

/**
 * 按 type + message 去重诊断项，保留首次出现的位置。
 * 启动与运行期的设置管理器可能对同一个文件的错误重复报告，需在此合并。
 */
export function deduplicateDiagnostics(
	diagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter((diagnostic) => {
		const key = `${diagnostic.type}\0${diagnostic.message}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
