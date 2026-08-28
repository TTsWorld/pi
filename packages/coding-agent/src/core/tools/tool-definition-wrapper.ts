/**
 * @file tool-definition-wrapper.ts
 *
 * @description ToolDefinition（扩展系统侧的工具定义，带 prompt 元数据与渲染器）
 * 与 AgentTool（pi-agent-core 运行时侧的最小工具接口）之间的双向适配层：
 * - wrapToolDefinition(s)：把扩展注册的工具定义包装成核心运行时可用的 AgentTool
 * - createToolDefinitionFromAgentTool：反向合成，保证 AgentSession 内部注册表
 *   始终以 definition 为第一公民（即使调用方传入的是裸 AgentTool 覆盖）
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";

/**
 * 把单个 ToolDefinition 包装为核心运行时的 AgentTool。
 *
 * 关键点：execute 时若运行时未传 ExtensionContext，则回落到 ctxFactory()
 * 现场创建一个 —— 让扩展工具无论从哪条路径被调用都能拿到扩展上下文。
 */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctx ?? (ctxFactory?.() as ExtensionContext)),
	};
}

/** 批量版本：把多个 ToolDefinition 逐个包装为 AgentTool 列表。 */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * 从裸 AgentTool 反向合成一个最小化的 ToolDefinition。
 *
 * Why：AgentSession 内部注册表以 definition 为第一公民；当调用方（如 SDK 使用者）
 * 直接传入不含 prompt 元数据与渲染器的 AgentTool 覆盖时，用它补齐 definition 形状，
 * 注册表的统一处理逻辑才不至于分叉。
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		constrainedSampling: tool.constrainedSampling,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
