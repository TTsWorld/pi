/**
 * @file bash 工具工厂。
 *
 * @description 提供 {@link createBashTool}：构造一个符合 {@link AgentHarnessTool}
 * 契约的 bash 工具（typebox 参数 schema + execute + 流式 onUpdate 进度）。本文件
 * 自身不直接调用 node API——命令执行、stdout/stderr 捕获、超限输出落盘全部委托给
 * {@link executeShellWithCapture}（../utils/shell-output.ts），截断上限来自
 * ../utils/truncate.ts（默认 2000 行 / 50KB）；shell 与文件系统能力则通过
 * {@link ExecutionToolContext} 注入的 ExecutionEnv 获得，因此执行环境可整体替换
 * （如沙箱或远程环境）。
 */
import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import { getOrThrow } from "../types.ts";
import { executeShellWithCapture, type ShellCaptureProgress } from "../utils/shell-output.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "../utils/truncate.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/** timeout 参数允许的最大秒数。Why：底层实现会把秒换算成毫秒传给定时器，而定时器上限为 2^31-1 毫秒（约 24.8 天），换算回秒即得此值，再大会溢出。 */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
/** 流式进度更新（onUpdate）的最小间隔毫秒数：chatty 输出也至多每 100ms 上报一次，避免刷爆 UI 与事件流。 */
const BASH_UPDATE_THROTTLE_MS = 100;

/**
 * bash 工具的参数 schema（typebox）。
 *
 * 字段的 description 会原样暴露给 LLM，是模型理解如何调用的唯一线索：
 * - command：必填，要执行的 bash 命令；
 * - timeout：可选的超时秒数；刻意不设默认值——不传即不超时，把超时策略交给调用方。
 */
const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

/** 从参数 schema 推导出的工具输入类型：`{ command: string; timeout?: number }`。 */
export type BashToolInput = Static<typeof bashSchema>;

/** 工具结果中的结构化详情（供日志与 UI 渲染使用，不进入 LLM 上下文）。 */
export interface BashToolDetails {
	/** 输出截断统计；仅在确实发生截断时携带。 */
	truncation?: TruncationResult;
	/** 完整输出临时文件的路径；仅在输出超限并触发落盘后存在，供事后查看全文。 */
	fullOutputPath?: string;
}

/**
 * 一次 bash 执行的「执行计划」：可变对象。先由工具按选项组装出默认值，
 * 再交给 {@link BashPrepare} 钩子按需改写（切换 cwd、注入环境变量、追加命令等），
 * 最后整体交给底层 shell 执行。
 */
export interface BashExecution {
	/** 要执行的完整命令（可能已拼上 commandPrefix 及 prepare 追加的内容）。 */
	command: string;
	/** 命令的工作目录。 */
	cwd: string;
	/** 额外环境变量（叠加在继承的环境之上，同名键覆盖）。 */
	env: Record<string, string>;
	/** 是否继承执行环境的默认环境变量。 */
	inheritEnv: boolean;
}

/**
 * 执行前钩子：收到可变的 {@link BashExecution}，可直接修改其字段来定制本次执行；
 * 同时拿到当前 turn 的 context 与 abort signal。
 *
 * @param execution 待改写的执行计划（原地修改）。
 * @param context 当前 turn 的执行上下文（含 ExecutionEnv 等应用附加信息）。
 * @param signal 中止信号，透传自本次工具调用。
 * @returns 无返回值；可同步或异步（Promise）。
 */
export type BashPrepare<TContext extends ExecutionToolContext = ExecutionToolContext> = (
	execution: BashExecution,
	context: TContext,
	signal?: AbortSignal,
) => void | Promise<void>;

/** {@link createBashTool} 的选项。 */
export interface BashToolOptions<TContext extends ExecutionToolContext = ExecutionToolContext> {
	/**
	 * 命令前缀：以独立一行拼在 LLM 给出的命令之前，在同一次 shell 调用内先后执行，
	 * 因此前缀中 export 的变量、cd 切换的目录对后续命令可见。
	 */
	commandPrefix?: string;
	/** 执行前钩子，见 {@link BashPrepare}。 */
	prepare?: BashPrepare<TContext>;
}

/**
 * 校验可选的 timeout 参数。
 *
 * Why：LLM 可能传入 0、负数或 Infinity 等非法值；且底层会把秒换算成毫秒传给
 * 定时器，超过 {@link MAX_TIMEOUT_SECONDS} 会溢出定时器上限。非法即抛错，
 * 由 Agent 循环转成报错的工具结果反馈给模型。
 *
 * @param timeout 超时秒数；undefined 表示不设超时，直接放行。
 * @throws timeout 非有限正数或超过上限时抛出 Error。
 */
function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	if (timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

/**
 * 创建 bash 工具。
 *
 * 返回的工具符合 {@link AgentHarnessTool} 契约：execute 额外接收按当前 turn
 * 解析出的 context（从中取得 ExecutionEnv）；执行期间通过 onUpdate 以不低于
 * {@link BASH_UPDATE_THROTTLE_MS} 的间隔推送输出进度；命令失败（被中止、超时、
 * 非零 exit code）按契约以 throw 上报，且错误信息中带上已捕获的输出，
 * 保证 LLM 在报错时仍能看到 stdout/stderr。
 *
 * @param options 可选配置：命令前缀（commandPrefix）与执行前钩子（prepare），
 *   见 {@link BashToolOptions}。
 * @returns 可注册到 harness 的 bash 工具。
 */
export function createBashTool<TContext extends ExecutionToolContext = ExecutionToolContext>(
	options?: BashToolOptions<TContext>,
): AgentHarnessTool<TContext, typeof bashSchema, BashToolDetails | undefined> {
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
		parameters: bashSchema,
		async execute(_toolCallId, { command, timeout }, signal, onUpdate, context) {
			// ========== 参数校验与执行计划构建 ==========
			// 先校验 timeout（非法直接抛错），再组装默认执行计划：
			// - commandPrefix 以独立一行（\n）拼在命令前：同一次 shell 调用内先后执行，
			//   前缀 export 的变量、cd 的目录对 LLM 给的命令可见；
			// - 工作目录取 env.cwd，即执行环境的当前目录；
			// - 默认不附加额外环境变量（env 为空），但继承执行环境的默认变量。
			validateTimeout(timeout);
			const { env } = context;
			const execution: BashExecution = {
				command: options?.commandPrefix ? `${options.commandPrefix}\n${command}` : command,
				cwd: env.cwd,
				env: {},
				inheritEnv: true,
			};
			// prepare 钩子：应用层可在此改写 cwd / env / inheritEnv，甚至追加命令
			await options?.prepare?.(execution, context, signal);

			// ========== 流式进度更新（100ms 节流） ==========
			// Why：chatty 命令（如循环 echo 数千行）会高频触发 onChunk，逐次回调
			// onUpdate 会刷爆 UI 与事件流。这里把更新合并为「至多每
			// BASH_UPDATE_THROTTLE_MS 一次」：chunk 到达时只标脏并按需补一个定时器，
			// 真正发送时才通过 getLatestProgress 惰性取最新快照，中间状态被自然合并。
			let getLatestProgress: (() => ShellCaptureProgress) | undefined; // 最近一次 onChunk 传入的进度获取器
			let updateTimer: ReturnType<typeof setTimeout> | undefined; // 挂起的节流定时器；至多一个
			let updateDirty = false; // 标脏：有新输出尚未上报
			let lastUpdateAt = 0; // 上次实际发送更新的时间戳，用于计算节流窗口

			/** 发送一次进度更新：取最新快照，把当前输出与截断详情作为部分结果（partial result）上报。 */
			const emitOutputUpdate = (): void => {
				if (!onUpdate || !updateDirty || !getLatestProgress) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const progress = getLatestProgress();
				onUpdate({
					content: [{ type: "text", text: progress.output }],
					details: {
						truncation: progress.truncation.truncated ? progress.truncation : undefined,
						fullOutputPath: progress.fullOutputPath,
					},
				});
			};
			/** 取消挂起的节流定时器（命令结束或出错时调用，防止定时器泄漏）。 */
			const clearUpdateTimer = (): void => {
				if (!updateTimer) return;
				clearTimeout(updateTimer);
				updateTimer = undefined;
			};
			/**
			 * 请求一次更新（标脏 + 节流）：距上次发送不足一个节流窗口时只挂一个定时器
			 * 补发（`??=` 保证同时至多挂一个），窗口已过则清掉定时器立即发送。
			 */
			const scheduleOutputUpdate = (): void => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			// 先发一个空的初始更新：让 UI 立即进入「执行中」状态并清空旧的中间结果
			onUpdate?.({ content: [], details: undefined });
			try {
				// ========== 执行命令并流式捕获输出 ==========
				// 交给 executeShellWithCapture：流式捕获 stdout/stderr、维护尾部缓冲、
				// 超限时把完整输出落盘到临时文件。关键选项：
				// - returnExecutionErrors: true —— shell 执行失败不以 err 返回，而是连同
				//   已捕获的输出一起放进 ok 结果（executionError 字段），这样报错时输出
				//   不丢失，由下方统一转成 throw 反馈给 LLM；
				// - timeout / abortSignal 直接透传调用方参数；
				// - onChunk 只记录「最新进度获取器」并请求一次节流更新。
				// getOrThrow：捕获层失败（如临时文件写入失败）没有可展示的输出，直接抛出。
				const capture = getOrThrow(
					await executeShellWithCapture(env, execution.command, {
						cwd: execution.cwd,
						env: execution.env,
						inheritEnv: execution.inheritEnv,
						timeout,
						abortSignal: signal,
						returnExecutionErrors: true,
						onChunk: (_chunk, getProgress) => {
							getLatestProgress = getProgress;
							scheduleOutputUpdate();
						},
					}),
				);
				// 命令已结束：清掉挂起的定时器，把最终捕获结果当作「最新进度」强制作一次更新
				clearUpdateTimer();
				getLatestProgress = () => capture;
				updateDirty = true;
				emitOutputUpdate();

				// ========== 构造截断提示 ==========
				// 未超限时 capture.output 即完整输出；超限时输出只保留尾部内容，
				// 需在末尾追加一段方括号说明，告诉 LLM 展示的是哪一部分、完整输出在哪。
				let outputText = capture.output;
				let details: BashToolDetails | undefined;
				if (capture.truncation.truncated) {
					// details 记录截断统计与完整输出路径（供 UI / 日志使用）
					details = { truncation: capture.truncation, fullOutputPath: capture.fullOutputPath };
					// 展示的是总共 totalLines 行中的最后 outputLines 行，据此换算出起止行号
					const startLine = capture.truncation.totalLines - capture.truncation.outputLines + 1;
					const endLine = capture.truncation.totalLines;
					// 情形一：最后一行本身超长（如无换行的进度条输出），只保留了该行末尾
					// 50KB——说明该行总大小与实际保留的大小
					if (capture.truncation.lastLinePartial) {
						const lastLineSize = formatSize(capture.lastLineBytes);
						outputText += `\n\n[Showing last ${formatSize(capture.truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${capture.fullOutputPath}]`;
					// 情形二：按行数上限（2000 行）截断
					} else if (capture.truncation.truncatedBy === "lines") {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines}. Full output: ${capture.fullOutputPath}]`;
						// 情形三：按字节上限（50KB）截断
					} else {
						outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${capture.truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${capture.fullOutputPath}]`;
					}
				}

				// ========== 错误如何反馈给 LLM ==========
				// 按 AgentTool 契约，失败必须 throw（Agent 循环会转成 isError 的工具结果）。
				// appendStatus 把已捕获输出与状态行拼在一起（中间空一行），
				// 保证报错的同时 LLM 仍能看到 stdout/stderr。
				const appendStatus = (status: string): string => `${outputText ? `${outputText}\n\n` : ""}${status}`;
				// 被中止（abort signal 触发）：此时 exit code 无意义、输出可能不完整，明确标注
				if (capture.cancelled) throw new Error(appendStatus("Command aborted"));
				// 超时：带上具体秒数，并把底层 ExecutionError 挂到 cause 便于排查
				if (capture.executionError?.code === "timeout") {
					throw new Error(appendStatus(`Command timed out after ${timeout} seconds`), {
						cause: capture.executionError,
					});
				}
				// 其他执行错误（如 shell 不可用、spawn 失败）：原样抛出，保留结构化错误码
				if (capture.executionError) throw capture.executionError;
				// 非零 exit code：命令本身执行失败；错误信息含输出与退出码，LLM 可据此诊断并重试
				if (capture.exitCode !== 0 && capture.exitCode !== undefined) {
					throw new Error(appendStatus(`Command exited with code ${capture.exitCode}`));
				}
				// 成功返回；无输出时给出占位文本 "(no output)"，避免空 content
				return { content: [{ type: "text", text: outputText || "(no output)" }], details };
			} finally {
				// 无论成功失败都清掉挂起的节流定时器，防止泄漏
				clearUpdateTimer();
			}
		},
	};
}
