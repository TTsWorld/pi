/**
 * @file create-harness.ts —— 组装本包的 AgentHarness（编码代理装配层）
 *
 * @description
 * 把 coding-agent 的默认工具集（read / bash / edit / write）、系统提示词
 * 构建逻辑与运行环境（ExecutionEnv）组装成 pi-agent-core 的 `AgentHarness`，
 * 供 server 包托管为可远程访问的编码会话。
 *
 * 主要功能点：
 * - createCodingAgentHarnessTool：给 pi-agent-core 工具补上系统提示词贡献与
 *   实验性采样配置，并把 ExecutionToolContext 绑定进 execute 闭包；
 * - buildCodingAgentHarnessSystemPrompt：按激活工具动态生成系统提示词
 *   （snippet 压成单行 + 指南汇总）；
 * - createCodingAgentHarness：默认工具装配 + 懒生成提示词 + 委托 AgentHarness.create。
 *
 * 依赖关系：pi-agent-core（AgentHarness 与内置执行类工具）、
 * ../core/system-prompt.ts（提示词模板）、../core/tools/*（各工具的提示词片段）。
 */

import {
	AgentHarness,
	type AgentHarnessOptions,
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionEnv,
	type ExecutionToolContext,
	type HarnessTool,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import { getExperimentalToolSampling } from "../core/experimental.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../core/system-prompt.ts";
import { bashToolSystemPromptContribution } from "../core/tools/bash.ts";
import { editToolSystemPromptContribution } from "../core/tools/edit.ts";
import { readToolSystemPromptContribution } from "../core/tools/read.ts";
import { writeToolSystemPromptContribution } from "../core/tools/write.ts";

/** 在 pi-agent-core 的 HarnessTool 之上扩展两个可选的系统提示词贡献字段。 */
export interface CodingAgentHarnessTool extends HarnessTool {
	// 工具用法说明片段，会以工具名为 key 进入系统提示词的工具段落
	promptSnippet?: string;
	// 使用该工具的行为准则列表，汇总进系统提示词的 guidelines 部分
	promptGuidelines?: readonly string[];
}

/**
 * 把 pi-agent-core 的原始工具适配为 CodingAgentHarnessTool：附加提示词字段、
 * 注入实验性采样配置，并包装 execute 把工具上下文（含 env 等执行环境）
 * 固化进闭包，调用方此后无需再显式传递上下文。
 */
function createCodingAgentHarnessTool<TParameters extends TSchema, TDetails>(
	tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
	context: ExecutionToolContext,
	prompt: Required<Pick<CodingAgentHarnessTool, "promptSnippet" | "promptGuidelines">>,
): CodingAgentHarnessTool {
	return {
		...tool,
		...prompt,
		constrainedSampling: getExperimentalToolSampling(),
		execute: (toolCallId, params, signal, onUpdate) =>
			tool.execute(toolCallId, params as Static<TParameters>, signal, onUpdate, context),
	};
}

/**
 * createCodingAgentHarness 的选项：在 AgentHarnessOptions 基础上收窄
 * toolContext / tools（由本函数内部构造），并增加本包专属的运行环境与
 * 提示词构建选项。
 */
export interface CreateCodingAgentHarnessOptions extends Omit<AgentHarnessOptions, "toolContext" | "tools"> {
	// 工具执行环境（cwd 等），同时作为 ExecutionToolContext 传给各工具
	env: ExecutionEnv;
	// bash 工具的命令前缀（如沙箱包装命令）
	bashCommandPrefix?: string;
	/** 暴露给默认 bash 命令的 JSONL 会话文件路径（作为 PI_SESSION_FILE 注入）。 */
	sessionFile?: string;
	// 自定义工具集；缺省时装配 read / bash / edit / write 四个默认工具
	tools?: CodingAgentHarnessTool[];
	// 系统提示词构建选项（cwd / 指南 / 工具选择由本函数内部决定）
	systemPromptOptions?: Omit<BuildSystemPromptOptions, "cwd" | "promptGuidelines" | "selectedTools" | "toolSnippets">;
}

/** 独立构建系统提示词的参数：显式传入 cwd、完整工具表与激活工具名。 */
export interface BuildCodingAgentHarnessSystemPromptOptions {
	cwd: string;
	tools: readonly CodingAgentHarnessTool[];
	// 实际启用的工具名列表（tools 的子集），决定提示词中出现的内容
	activeToolNames: readonly string[];
	systemPromptOptions?: CreateCodingAgentHarnessOptions["systemPromptOptions"];
}

/**
 * 根据激活工具构建编码代理的系统提示词。
 * 工具的 promptSnippet 会被压成单行（去换行、合并空白）并以工具名为 key
 * 传给 buildSystemPrompt；各工具的 promptGuidelines 则汇总为统一行为准则。
 */
export function buildCodingAgentHarnessSystemPrompt(options: BuildCodingAgentHarnessSystemPromptOptions): string {
	// 按 activeToolNames 的顺序从完整工具表中筛出激活工具（找不到的名称跳过）
	const activeTools = options.activeToolNames.flatMap((name) => {
		const tool = options.tools.find((candidate) => candidate.name === name);
		return tool ? [tool] : [];
	});
	const toolSnippets = Object.fromEntries(
		activeTools.flatMap((tool) => {
			// snippet 压成单行：系统提示词模板对每个工具只保留一个段落
			const promptSnippet = tool.promptSnippet
				?.replace(/[\r\n]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			return promptSnippet ? [[tool.name, promptSnippet]] : [];
		}),
	);
	const promptGuidelines = activeTools.flatMap((tool) => tool.promptGuidelines ?? []);
	return buildSystemPrompt({
		...options.systemPromptOptions,
		cwd: options.cwd,
		selectedTools: activeTools.map((tool) => tool.name),
		toolSnippets,
		promptGuidelines,
	});
}

/**
 * 创建装配好的 AgentHarness（本文件入口函数）。
 *
 * 工作流程：
 * 1. 未显式提供工具时装配默认四件套（read / bash / edit / write），每个
 *    工具都带各自的系统提示词贡献；
 * 2. 系统提示词默认懒生成：每次请求时从 harness 读取「当前」工具表与激活
 *    列表，因此运行期间动态增删工具后提示词会自动跟随变化；
 * 3. 委托 AgentHarness.create 完成构建，并回填本地 harness 引用供工具闭包使用。
 */
export async function createCodingAgentHarness(options: CreateCodingAgentHarnessOptions) {
	const {
		env,
		bashCommandPrefix,
		sessionFile,
		systemPromptOptions,
		tools: providedTools,
		activeToolNames: providedActiveToolNames,
		systemPrompt: providedSystemPrompt,
		...harnessOptions
	} = options;
	let harness: AgentHarness | undefined;
	// 延迟解引用：bash 的 prepare 闭包构造时 harness 尚未创建，只能在执行时再取
	const getHarness = (): AgentHarness => {
		if (!harness) throw new Error("Coding-agent Harness callback ran before Harness initialization");
		return harness;
	};
	let tools = providedTools;
	// 未显式提供工具时装配默认工具集
	if (tools === undefined) {
		// 会话元数据只取一次：bash 每次执行注入的 PI_SESSION_ID 来自这里
		const metadata = await options.session.getMetadata();
		const toolContext = { env } satisfies ExecutionToolContext;
		tools = [
			createCodingAgentHarnessTool(createReadTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: readToolSystemPromptContribution.snippet,
				promptGuidelines: readToolSystemPromptContribution.guidelines,
			}),
			createCodingAgentHarnessTool(
				createBashTool<ExecutionToolContext>({
					commandPrefix: bashCommandPrefix,
					prepare: async (execution) => {
						const currentHarness = getHarness();
						const [model, thinkingLevel] = await Promise.all([
							currentHarness.getModel(),
							currentHarness.getThinkingLevel(),
						]);
						// 每条 bash 命令执行前注入会话与模型上下文：
						// PI_SESSION_ID / PI_SESSION_FILE 供脚本定位当前会话，
						// PI_PROVIDER / PI_MODEL / PI_REASONING_LEVEL 供脚本感知当前模型配置
						execution.env.PI_SESSION_ID = metadata.id;
						execution.env.PI_SESSION_FILE = sessionFile ?? "";
						execution.env.PI_PROVIDER = model.provider;
						execution.env.PI_MODEL = model.id;
						execution.env.PI_REASONING_LEVEL = thinkingLevel;
					},
				}),
				toolContext,
				{
					promptSnippet: bashToolSystemPromptContribution.snippet,
					promptGuidelines: bashToolSystemPromptContribution.guidelines,
				},
			),
			createCodingAgentHarnessTool(createEditTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: editToolSystemPromptContribution.snippet,
				promptGuidelines: editToolSystemPromptContribution.guidelines,
			}),
			createCodingAgentHarnessTool(createWriteTool<ExecutionToolContext>(), toolContext, {
				promptSnippet: writeToolSystemPromptContribution.snippet,
				promptGuidelines: writeToolSystemPromptContribution.guidelines,
			}),
		];
	}
	// 未指定激活工具时默认全部启用
	const activeToolNames = [...(providedActiveToolNames ?? tools.map((tool) => tool.name))];
	const systemPrompt =
		providedSystemPrompt ??
		// 懒生成系统提示词：每次调用时读取 harness 的最新工具状态，而非创建时的快照
		(async () => {
			const currentHarness = getHarness();
			const [currentTools, currentActiveToolNames] = await Promise.all([
				currentHarness.getTools(),
				currentHarness.getActiveTools(),
			]);
			return buildCodingAgentHarnessSystemPrompt({
				cwd: env.cwd,
				tools: currentTools,
				activeToolNames: currentActiveToolNames,
				systemPromptOptions,
			});
		});
	const created = await AgentHarness.create({
		...harnessOptions,
		tools,
		activeToolNames,
		systemPrompt,
	});
	harness = created.harness;
	return created;
}
