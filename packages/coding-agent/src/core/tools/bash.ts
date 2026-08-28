/**
 * @file bash.ts —— bash（及通用 shell）工具：命令执行、超时与输出截断
 *
 * @description
 * 本文件实现编码助手的 bash 工具，自底向上分四层：
 * 1. 执行后端（BashOperations）：把「真正跑命令」抽象为可插拔接口，
 *    默认实现 createLocalShellOperations 负责本地 spawn 子进程、超时杀进程树、
 *    abort 处理与 stdout/stderr 流式转发；扩展可将其替换为 SSH 等远程执行；
 * 2. 工具定义工厂（createShellToolDefinition / createBashToolDefinition）：
 *    组装参数 schema、命令前缀、会话环境变量（PI_* 注入）与 spawn 钩子，
 *    并在 execute 中完成输出累积、节流增量推送、截断落盘与错误包装；
 * 3. 渲染层（renderCall / renderResult）：负责终端 UI——命令标题行、
 *    输出折叠预览/展开、截断警告与耗时统计；
 * 4. Agent 适配（createBashTool）：把 ToolDefinition 包装为可直接挂载的 AgentTool。
 *
 * 依赖关系：
 * - `./output-accumulator.ts`：输出累积与截断时的临时文件落盘；
 * - `./truncate.ts`：按行数/字节数的双限制截断；
 * - `../../utils/shell.ts`：shell 配置发现、环境变量构造、进程树终止
 *   与分离后台进程的 PID 跟踪；
 * - `../../utils/child-process.ts`：等待子进程退出（不被分离后代句柄卡住）；
 * - `@earendil-works/pi-tui`：终端 UI 组件（Container/Text/按宽度截断）。
 */
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ExtensionContext, ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

// setTimeout 的毫秒上限（32 位有符号整数最大值），超过会导致定时器立即触发
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * 把秒级超时换算为毫秒并做合法性校验。
 *
 * @param timeout 超时秒数；undefined 表示不设置超时，原样返回
 * @returns 毫秒数；未提供超时时返回 undefined
 * @throws 超时非有限正数，或换算成毫秒后超过 Node 定时器上限时抛出 Error
 */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

/** bash 工具的输入参数 schema：command 必填，timeout（秒）可选且无默认值 */
const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** bash 工具注入系统提示词的片段与使用守则 */
export const bashToolSystemPromptContribution = {
	snippet: "Execute bash commands (ls, grep, find, etc.)",
	guidelines: ["You can inspect PI_* environment variables for current model and session details."],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/** bash 工具结果附带的元数据（供渲染层使用，不进入模型上下文） */
export interface BashToolDetails {
	/** 输出截断信息：是否截断、按行还是按字节、展示/总行数等 */
	truncation?: TruncationResult;
	/** 截断时保存完整输出的临时文件路径 */
	fullOutputPath?: string;
}

/**
 * bash 工具的可插拔执行操作。
 * 覆盖这些方法可把命令执行委托给远程系统（例如 SSH）。
 */
export interface BashOperations {
	/**
	 * 执行一条命令并流式回传输出。
	 * @param command 要执行的命令
	 * @param cwd 工作目录
	 * @param options 执行选项
	 * @returns Promise，resolve 为退出码（进程被杀时为 null）
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * 内置 shell 工具共享的本地进程执行实现。
 *
 * @param shellName shell 名称，仅用于报错信息（如 "bash"）
 * @param resolveShellConfig 惰性解析 shell 配置：每次执行时才调用，便于配置热更新
 */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			// 尚未 spawn 就已被 abort：直接抛错，不再启动进程
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			// 先校验工作目录存在，避免 spawn 阶段抛出难以定位的底层错误
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			// 命令传递方式：argv（命令作为最后一个参数拼接）或 stdin（写入后关闭）
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				// 非 Windows 上以独立进程组长方式 detach，便于 killProcessTree 一次杀掉整棵进程树
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				// 吞掉 stdin 写入错误（如管道提前关闭的 EPIPE），避免进程级未处理异常
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			// 登记 PID：CLI 自身被杀时，可据此清理这些分离运行的后台子进程
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// 若提供超时则启动定时器：到期打标记并杀掉整棵进程树。
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// 流式转发 stdout 与 stderr。
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// 响应 abort 信号：杀掉整个进程树。
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// 处理 shell spawn 失败，并等待进程退出——不能直接用 child 的 exit 事件，
				// 因为分离运行的后代会继承 stdio 句柄，导致进程迟迟不退出而挂起。
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				// 无论成败都撤销 PID 登记、清掉定时器与 abort 监听，防止资源泄漏
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * 使用 pi 内置的本地 shell 执行后端创建 bash 操作。
 *
 * 适用于拦截 user_bash、但仍希望在包装或改写命令之余
 * 保留 pi 标准本地 shell 行为的扩展。
 *
 * @param options 可指定显式 shell 路径（来自用户设置）
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

/** spawn 上下文：最终交给执行后端的命令、工作目录与环境变量 */
export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** spawn 钩子：执行前调整 command/cwd/env，返回（可能改写过的）新上下文 */
export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

/**
 * 组装最终 spawn 上下文：构造环境变量并应用 spawn 钩子。
 *
 * 默认先剥离全部 PI_* 会话环境变量——每次执行都会复制基础环境，
 * 不能把上一个命令可能篡改过的值或当前会话信息泄漏给任意命令；
 * 仅当 exposeSessionEnvironment 开启且存在扩展上下文时，才重新注入
 * session id / 会话文件 / 模型等 PI_* 元数据，供脚本读取
 * （与系统提示词中「可检查 PI_* 环境变量」的守则配套）。
 */
function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ExtensionContext | undefined,
): BashSpawnContext {
	// 复制基础环境并剥离 PI_* 变量，得到干净的起点
	const env = { ...getShellEnv() };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	// 按需回填当前会话元数据（会话 id、会话文件、模型、推理级别）
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (model) {
			env.PI_PROVIDER = model.provider;
			env.PI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	// spawn 钩子可在此改写命令/目录/环境（例如注入 cd 或代理设置）
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

/** bash 工具的配置项 */
export interface BashToolOptions {
	/** 自定义命令执行操作。默认：本地 shell */
	operations?: BashOperations;
	/** 拼接在每条命令之前的前缀（例如 shell 初始化命令） */
	commandPrefix?: string;
	/** 来自设置的显式 shell 路径（可选） */
	shellPath?: string;
	/** 是否把当前 Pi 会话元数据暴露为 PI_* 环境变量。默认：true */
	exposeSessionEnvironment?: boolean;
	/** 执行前调整 command、cwd 或 env 的钩子 */
	spawnHook?: BashSpawnHook;
}

/** 折叠视图下展示的输出预览行数 */
const BASH_PREVIEW_LINES = 5;
/** 输出增量更新（onUpdate）的节流间隔：流式输出过快时避免 UI 刷新风暴 */
const BASH_UPDATE_THROTTLE_MS = 100;

/** bash 工具的渲染状态：起止时间戳（用于耗时展示）与局部刷新定时器 */
export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

/** 输出预览缓存：按渲染宽度缓存截断结果，宽度不变时避免重复计算 */
type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

/** 携带预览缓存状态的输出渲染容器 */
class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

/** 毫秒数格式化为 "1.2s" 形式的耗时文本 */
function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 格式化命令调用的标题行：`<prompt> <command> (timeout Ns)`。
 * 命令参数非法时显示占位提示；流式接收参数尚未给出命令时显示 "..."。
 */
function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}

/**
 * （重新）构建命令结果的渲染内容：输出预览或全文、截断警告行与耗时行。
 *
 * @param component 复用的渲染容器（携带按宽度缓存的预览状态）
 * @param result 工具结果（content 文本 + details 中的截断信息）
 * @param options 渲染选项（是否展开、是否为部分结果、是否出错）
 * @param showImages 是否展示图片类内容
 * @param startedAt 开始时间；undefined 表示尚未开始（不显示耗时）
 * @param endedAt 结束时间；执行中为 undefined，耗时随时间实时增长
 */
function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	// ===== 提取输出文本；展开视图下剥掉正文末尾内嵌的截断脚注 =====
	let output = getTextOutput(result as any, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	// 展开时下方会渲染专门的截断警告行，去掉正文里的 "[Showing ... ]" 脚注以免重复；
	// 仅当文本以 "]" 结尾且脚注片段确实包含完整输出路径时才截断，避免误删正常输出
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		// 逐行套用工具输出配色
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			// 展开视图：完整输出直接渲染
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			// 折叠视图：只保留最后 BASH_PREVIEW_LINES 行；
			// 以自定义 render 组件按宽度缓存截断结果，宽度变化或 invalidate 时才重算
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					// 有被折叠的行时，顶部提示省略行数与展开快捷键
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					// 外部失效（如内容更新）时清空缓存，下次 render 重算
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	// ===== 截断警告行：完整输出临时文件路径 + 截断方式（按行数 / 按字节上限） =====
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	// ===== 耗时行：执行中显示 Elapsed（每秒刷新），结束后固定为 Took =====
	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

/** shell 工具（bash / fish 等）的命名与展示配置，具体工具以不同 config 实例化 */
export interface ShellToolConfig {
	/** 工具名（暴露给模型调用，如 "bash"） */
	name: string;
	/** UI 展示标签 */
	label: string;
	/** shell 名称（用于工具描述文案，如 "bash"） */
	shellName: string;
	/** 命令标题行的提示符（如 "$"） */
	prompt: string;
	/** 注入系统提示词的能力片段 */
	promptSnippet: string;
	/** 注入系统提示词的使用守则 */
	promptGuidelines?: readonly string[];
	/** 截断时落盘临时文件的文件名前缀（如 "pi-bash"） */
	tempFilePrefix: string;
}

/**
 * 创建通用 shell 工具定义。
 *
 * execute 主流程：解析 spawn 上下文（命令前缀 / PI_* 环境变量 / 钩子）→
 * 调用执行后端跑命令，期间把输出累积并按 BASH_UPDATE_THROTTLE_MS 节流推送
 * 增量快照 → 结束后取最终快照（截断时落盘）→ 把 abort / 超时 / 非零退出码
 * 包装为带完整输出的错误。renderCall / renderResult 负责标题行、输出预览
 * （折叠/展开）与耗时展示。
 *
 * @param cwd 工作目录
 * @param config 工具命名与展示配置
 * @param options 可选执行配置（自定义 operations、命令前缀、spawn 钩子等）
 */
export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		description: `Execute a ${config.shellName} command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		constrainedSampling: getExperimentalToolSampling(),
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?,
		) {
			// 先解析最终命令（拼接前缀）与 spawn 上下文（环境变量 / 钩子改写）
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook, exposeSessionEnvironment, ctx);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			// 输出收集状态：是否仍在接收数据、节流定时器、脏标记与上次推送时间
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			/** 推送一次增量输出快照（节流到期或收尾时调用） */
			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			/**
			 * 节流调度增量推送：距上次推送不足节流间隔时合并为一次定时推送，
			 * 避免高频输出（如 cat 大文件）触发刷新风暴。
			 */
			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					// 已过节流窗口：取消挂起的定时器，立即推送
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				// 已有挂起的定时器则复用（以首次调度时间为准，避免反复顺延）
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			// 初始空更新：让 UI 立即进入「执行中」状态
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				// 收尾后到达的残余数据直接丢弃
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			/** 收尾：停止接收输出，推送最后一次增量，返回最终快照并关闭临时文件 */
			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			/**
			 * 把快照格式化为模型可见文本：截断时在末尾追加说明脚注
			 * （区分末行截半、按行截断、按字节截断三种情形），
			 * 并把截断详情放进 details 供渲染层使用。
			 */
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					// 保留的是「最后」N 行，换算出对应原始输出的行号区间
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						// 末行只展示了一半：额外说明该行完整大小
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			/** 在已有输出文本后追加状态行（退出码 / 超时等），二者间以空行分隔 */
			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					// 执行失败（abort / 超时 / spawn 错误）：先收尾输出，
					// 再把已产出的输出附进错误信息，便于排查已执行到哪一步
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				// 非零退出码视为错误（null 表示被杀，已在上面分支处理），错误信息附带完整输出
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				// 兜底清理节流定时器，防止异常路径泄漏
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			// 首次确认开始执行时记录开始时间，并清掉上一轮残留的结束时间
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			// 复用同一个 Text 组件、仅更新文本，避免流式接收参数期间反复重建
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args, config.prompt));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			// 执行中（部分结果）：每秒 invalidate 一次，驱动 Elapsed 耗时增长
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			// 结束（或出错）：固定结束时间并停掉刷新定时器
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

/** bash 工具的默认配置实例 */
const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "pi-bash",
};

/**
 * 创建 bash 工具定义（ToolDefinition 形式，供扩展系统直接使用）。
 *
 * @param cwd 工作目录
 * @param options 可选执行配置
 */
export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

/**
 * 创建 bash 工具（AgentTool 形式，可直接挂到 Agent 循环）。
 *
 * 包装后补挂 promptSnippet / promptGuidelines，
 * 供系统提示词组装阶段读取。
 */
export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
