/**
 * @file powershell.ts —— powershell 内置工具：Windows 下的 PowerShell 执行
 *
 * @description
 * 基于 bash.ts 的通用 shell 工具工厂（createShellToolDefinition）搭建的薄适配层：
 * 复用 bash 工具的执行、超时、输出截断等全部能力，仅替换 shell 配置
 * （名称、提示符、临时文件前缀）与本地 operations，并在每条命令前注入
 * UTF-8 输出编码设置以避免非 ASCII 输出乱码。
 */

import { getPowerShellConfig } from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	type createBashTool,
	createLocalShellOperations,
	createShellToolDefinition,
	type ShellToolConfig,
} from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** 注入到每条命令前的 UTF-8 输出编码设置；用 try/catch 包裹以兼容不支持的环境 */
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

/** powershell 工具对系统提示词的贡献片段（snippet 一句话 + 使用守则列表） */
export const powershellToolSystemPromptContribution = {
	snippet: "Execute PowerShell commands",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

// 以下类型直接复用 bash 工具的定义：PowerShell 与 bash 工具结构完全一致，
// 仅 shell 后端不同，没有必要重复声明。
export type PowerShellOperations = BashOperations;
export type PowerShellSpawnContext = BashSpawnContext;
export type PowerShellSpawnHook = BashSpawnHook;
export type PowerShellToolDetails = BashToolDetails;
export type PowerShellToolInput = BashToolInput;

/** powershell 工具的可配置项（从 BashToolOptions 中挑选仍适用的字段） */
export interface PowerShellToolOptions
	extends Pick<BashToolOptions, "operations" | "exposeSessionEnvironment" | "spawnHook"> {}

/**
 * 创建本地 PowerShell 的执行操作集：包装通用 shell operations，
 * 并在实际执行前给每条命令拼上 UTF-8 编码前缀。
 */
export function createLocalPowerShellOperations(): PowerShellOperations {
	const operations = createLocalShellOperations("PowerShell", getPowerShellConfig);
	return {
		exec: (command, cwd, options) => operations.exec(`${UTF8_OUTPUT_PREFIX}${command}`, cwd, options),
	};
}

/** powershell 工具的差异化配置：名称、提示符与临时脚本文件前缀 */
const powershellToolConfig: ShellToolConfig = {
	name: "powershell",
	label: "powershell",
	shellName: "PowerShell",
	prompt: "PS>",
	promptSnippet: powershellToolSystemPromptContribution.snippet,
	promptGuidelines: powershellToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-powershell",
};

/**
 * 创建 powershell 工具的 ToolDefinition：把 PowerShell 配置交给通用
 * shell 工具工厂；未显式传入 operations 时使用本地 PowerShell 实现。
 */
export function createPowerShellToolDefinition(
	cwd: string,
	options?: PowerShellToolOptions,
): ReturnType<typeof createShellToolDefinition> {
	return createShellToolDefinition(cwd, powershellToolConfig, {
		...options,
		operations: options?.operations ?? createLocalPowerShellOperations(),
	});
}

/** 便捷封装：创建可注册到 Agent 的 powershell AgentTool（并挂回提示词贡献字段） */
export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): ReturnType<typeof createBashTool> {
	const definition = createPowerShellToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
