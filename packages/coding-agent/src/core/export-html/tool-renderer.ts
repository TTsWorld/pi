/**
 * @file export-html/tool-renderer.ts —— 自定义工具的 HTML 渲染器
 *
 * @description
 * HTML 导出时渲染「自定义工具」的调用与结果：按名称查找工具定义
 * （ToolDefinition），调用其 TUI 渲染方法（renderCall / renderResult）拿到
 * Component，以固定终端宽度渲染成 ANSI 文本行，再经 ansi-to-html 转成 HTML。
 *
 * 工具的 TUI 渲染器本是面向交互场景设计的（增量渲染、跨调用状态、回调刷新），
 * 这里通过缓存组件与渲染状态来模拟「同一工具调用的连续多次渲染」，
 * 并把 invalidate 等回调置为空实现；任何一步渲染失败都返回 undefined，
 * 让导出端回退到结构化结果渲染，保证导出不因单个工具而中断。
 *
 * 依赖关系：
 * - ../extensions/types.ts：ToolDefinition / ToolRenderContext 类型；
 * - ../../modes/interactive/theme/theme.ts：Theme 类型；
 * - ./ansi-to-html.ts：ANSI 文本行 → HTML 的转换。
 * 被 agent-session.ts 使用（createToolHtmlRenderer）。
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderContext } from "../extensions/types.ts";
import { ansiLinesToHtml } from "./ansi-to-html.ts";

/** 创建工具 HTML 渲染器所需的依赖注入项 */
export interface ToolHtmlRendererDeps {
	/** 按名称查找工具定义的函数 */
	getToolDefinition: (name: string) => ToolDefinition | undefined;
	/** 渲染时使用的终端主题 */
	theme: Theme;
	/** 渲染上下文使用的工作目录 */
	cwd: string;
	/** 渲染用的终端宽度（默认 100，导出的 ANSI 按此宽度折行） */
	width?: number;
}

/**
 * 自定义工具渲染为 HTML 的接口（与 index.ts 导出的同名接口结构一致，
 * 本文件独立声明一份供自身使用）。
 */
export interface ToolHtmlRenderer {
	/** 把一次工具调用渲染为 HTML；工具没有自定义渲染器时返回 undefined。 */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** 把工具结果渲染为折叠态/展开态 HTML；工具没有自定义渲染器时返回 undefined。 */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * 创建工具 HTML 渲染器（见下方 createToolHtmlRenderer 工厂函数）。
 *
 * 渲染器按名称查找工具定义并调用其 renderCall/renderResult 方法，
 * 把 TUI Component 的输出（ANSI 文本行）转换为 HTML。
 */
// 匹配 SGR ANSI 转义序列；用于剥掉转义码后判断某行是否视觉上为空
const ANSI_ESCAPE_REGEX = /\x1b\[[\d;]*m/g;

/** 判断一行渲染文本去掉 ANSI 转义码后是否为空白（空串或纯空白字符）。 */
function isBlankRenderedLine(line: string): boolean {
	return line.replace(ANSI_ESCAPE_REGEX, "").trim().length === 0;
}

/**
 * 去掉渲染结果首尾的空白行（中间的空行保留）。
 * TUI 渲染常在上下留白，HTML 里这些空行只会撑出大片空白，故裁掉。
 */
function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	// 双指针：分别从头、尾向中间推进，跳过视觉空白行
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

/**
 * 创建工具 HTML 渲染器实例。
 *
 * @param deps - 依赖项（工具定义查找、主题、工作目录、渲染宽度）
 * @returns 实现 ToolHtmlRenderer 的对象；单个工具渲染出错时对应方法返回
 *   undefined，由导出端回退到结构化渲染
 */
export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolDefinition, theme, cwd, width = 100 } = deps;

	// ===== 按 toolCallId 缓存的渲染上下文（模拟 TUI 里的连续多次渲染） =====
	// 最近一次调用渲染得到的组件：作为下次渲染的 lastComponent 传入，
	// 供支持增量渲染的工具复用
	const renderedCallComponents = new Map<string, Component>();
	// 最近一次结果渲染得到的组件（折叠态与展开态共用一个槽位）
	const renderedResultComponents = new Map<string, Component>();
	// 各工具调用的可变渲染状态：工具渲染器跨多次渲染共享的 state 对象
	const renderedStates = new Map<string, any>();
	// 各工具调用的参数：renderCall 先记录，供 renderResult 构造上下文时取用
	const renderedArgs = new Map<string, unknown>();

	/** 懒初始化并返回某次工具调用的可变渲染状态对象（同一 ID 恒返回同一对象）。 */
	const getState = (toolCallId: string): any => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	/**
	 * 为一次渲染构造 ToolRenderContext。
	 * 导出是一次性的离线渲染，与 TUI 实时交互场景不同：
	 * - invalidate 置为空函数（没有可触发的重绘循环）；
	 * - executionStarted / argsComplete 恒为 true（导出的必然是已完成的调用）；
	 * - showImages 关闭（ANSI→HTML 管线无法承载图片）。
	 */
	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
		};
	};

	return {
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			try {
				// 先记录参数：后续 renderResult 构造上下文时要用
				renderedArgs.set(toolCallId, args);
				const toolDef = getToolDefinition(toolName);
				// 没有自定义 TUI 渲染器的工具交给模板做结构化渲染
				if (!toolDef?.renderCall) {
					return undefined;
				}

				// lastComponent 传入上次渲染的组件，供支持增量渲染的工具复用
				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				// 以离线宽度渲染出 ANSI 文本行，再转成 HTML
				const lines = component.render(width);
				return ansiLinesToHtml(lines);
			} catch {
				// 出错时返回 undefined，让 HTML 导出回退到结构化结果渲染
				return undefined;
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			try {
				const toolDef = getToolDefinition(toolName);
				if (!toolDef?.renderResult) {
					return undefined;
				}

				// 由内容数组拼装 AgentToolResult；会话存储里的内容是泛型对象类型，
				// 这里做一次类型断言以匹配 TUI 渲染器期望的签名
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// 折叠态：紧凑摘要（expanded: false）
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsed = ansiLinesToHtml(trimRenderedResultLines(collapsedComponent.render(width)));

				// 展开态：完整详情（expanded: true）；lastComponent 传入刚渲染的
				// 折叠态组件，供增量渲染的工具在其基础上更新
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expanded = ansiLinesToHtml(trimRenderedResultLines(expandedComponent.render(width)));

				// 折叠态与展开态内容相同（或没有折叠态）时只输出 expanded，
				// 前端就不展示「展开/收起」切换
				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				// 出错时返回 undefined，让 HTML 导出回退到结构化结果渲染
				return undefined;
			}
		},
	};
}
