import type { Context, Tool } from "../types.ts";

/**
 * @file 延迟工具（deferred tools）拆分助手。
 *
 * 部分提供方（如 Anthropic 的 tool references / deferred tool use）支持工具不随请求完整下发，
 * 而是在对话中途通过 tool_reference 按需「加载」进上下文，以节省 token。
 * 本文件把 Context 的当前工具列表拆成两组：
 * - immediate：随本次请求完整定义下发的工具；
 * - deferred：历史上已被 tool_reference 加载过、继续以延迟形式声明的工具。
 */

/** 工具名归一化函数：让「历史消息里的名字」与「当前工具名」可对齐（如 OAuth 模式下的名字映射） */
type ToolNameNormalizer = (name: string) => string;

/** 默认归一化：原样返回名字 */
const identityToolName: ToolNameNormalizer = (name) => name;

/**
 * 将当前工具拆分为「立即完整下发」与「已被历史消息延迟加载」两组定义。
 *
 * 判定规则：按顺序扫描对话历史，出现在 toolResult.addedToolNames（该消息点延迟加载的工具名）
 * 且截至该消息尚未被 assistant 实际调用过的名字，继续归入延迟组；其余工具全部立即下发。
 *
 * @param context - 当前请求上下文（tools 与 messages）
 * @param enabled - 提供方是否支持延迟工具（tool references）；关闭时所有工具立即下发
 * @param normalizeName - 工具名归一化函数，默认恒等映射
 * @returns immediate 为立即下发的工具数组；deferred 为以归一化名字为键的延迟工具表
 */
export function splitDeferredTools(
	context: Context,
	enabled: boolean,
	normalizeName: ToolNameNormalizer = identityToolName,
): { immediate: Tool[]; deferred: Map<string, Tool> } {
	// 按归一化名字去重，同名时后出现的定义覆盖先出现的
	const uniqueTools = new Map<string, Tool>();
	for (const tool of context.tools ?? []) uniqueTools.set(normalizeName(tool.name), tool);
	// 未启用延迟模式：全部立即下发
	if (!enabled) return { immediate: [...uniqueTools.values()], deferred: new Map() };

	// 扫描历史：assistant 实际调用过的名字记入 usedNames；
	// toolResult 中延迟加载（addedToolNames）且截至该消息尚未被调用过的名字记入 deferredNames
	const deferredNames = new Set<string>();
	const usedNames = new Set<string>();
	for (const message of context.messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") usedNames.add(normalizeName(block.name));
			}
		} else if (message.role === "toolResult") {
			for (const name of message.addedToolNames ?? []) {
				const normalizedName = normalizeName(name);
				if (!usedNames.has(normalizedName)) deferredNames.add(normalizedName);
			}
		}
	}

	// 名字落在 deferredNames 里的继续走延迟声明，其余立即下发
	const immediate: Tool[] = [];
	const deferred = new Map<string, Tool>();
	for (const [name, tool] of uniqueTools) {
		if (deferredNames.has(name)) deferred.set(name, tool);
		else immediate.push(tool);
	}
	return { immediate, deferred };
}
