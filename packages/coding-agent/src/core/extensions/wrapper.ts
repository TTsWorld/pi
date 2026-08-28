/**
 * @file wrapper.ts —— 扩展注册工具的包装层
 *
 * @description
 * 把扩展系统注册的工具（RegisteredTool）包装成 agent-core 可直接调度的 AgentTool。
 * 这层包装只负责适配「工具执行」环节——让扩展工具在执行时拿到统一的 runner 上下文；
 * 至于工具调用（tool call）与工具结果（tool result）的拦截改写，
 * 由 AgentSession 通过 agent-core 钩子完成，不在本文件处理。
 *
 * 依赖关系：
 * - `@earendil-works/pi-agent-core`：AgentTool 类型定义；
 * - `../tools/tool-definition-wrapper.ts`：通用工具定义包装器（负责注入执行上下文）；
 * - `./runner.ts`：ExtensionRunner（扩展运行器，提供 createContext 等能力）；
 * - `./types.ts`：RegisteredTool 类型。
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * 把单个 RegisteredTool 包装为 AgentTool。
 * 内部通过 runner.createContext() 创建扩展上下文，
 * 保证工具执行与各事件处理器看到的是同一份上下文视图。
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	const execute = tool.execute;
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			// 记录执行前的活跃工具列表，用于检测工具执行期间是否动态注册了新工具
			const activeBefore = runner.getActiveTools();
			const result = await execute(toolCallId, params, signal, onUpdate);
			const activeAfter = runner.getActiveTools();
			// 执行期间若有工具被停用（前后列表不一致），视为状态已变化，直接返回原结果不做合并
			if (!activeBefore.every((name) => activeAfter.includes(name))) return result;

			// 计算执行期间新增注册的工具名；没有新增则原样返回
			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return result;
			// 有新增工具时，把工具名去重合并进结果的 addedToolNames，
			// 上层据此在下一轮 LLM 请求前把新工具暴露给模型
			return {
				...result,
				addedToolNames: [...new Set([...(result.addedToolNames ?? []), ...addedToolNames])],
			};
		},
	};
}

/**
 * 批量把 RegisteredTool 列表包装为 AgentTool 列表。
 * 与单个包装同理，统一使用 runner.createContext() 创建上下文，
 * 保证所有工具与事件处理器共享一致的上下文。
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((tool) => wrapRegisteredTool(tool, runner));
}
