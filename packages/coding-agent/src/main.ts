/**
 * @file main.ts —— 编码助手 CLI 的主入口与启动编排
 *
 * @description
 * 本文件是终端 AI 编码助手（类似 Claude Code）的启动流程中枢：
 * 解析命令行参数，依次完成鉴权子命令分流、配置迁移、首次引导、
 * 会话管理器建立、项目信任判定与 Agent 会话创建等前置工作，
 * 最终把控制权交给三种运行模式之一——交互式 TUI（InteractiveMode）、
 * 一次性打印模式（runPrintMode）或 JSON-RPC 模式（runRpcMode）。
 * 具体的会话/工具/扩展等重活由 SDK（core/sdk.ts 等）承担。
 *
 * 主要流程（按 main() 内的执行顺序）：
 * 1. 离线模式处理与 `pi auth ...` 子命令快捷分流（不进入主流程即返回）；
 * 2. Windows 自更新清理、包管理（handlePackageCommand）与配置（handleConfigCommand）子命令；
 * 3. 参数解析与校验（--fork / --session-id 互斥等）、配置迁移与弃用警告、--version / --export；
 * 4. 首次启动引导（主题选择、统计开关）与会话管理器建立（新建/恢复/分叉/续接）；
 * 5. 项目信任（trust）判定 + 运行时工厂 createRuntime：按最终 cwd 创建设置、
 *    模型运行时、资源加载器（扩展/技能/提示词模板/主题）等服务并组装 Agent 会话；
 * 6. 读取管道 stdin、组装初始消息，按 appMode 分发到对应运行模式。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：多厂商 LLM SDK（模型比较、图片内容类型）；
 * - `./cli/*`：参数解析、auth 子命令、@file 参数处理、会话选择等纯 CLI 逻辑；
 * - `./core/*`：会话管理、设置管理、模型解析、项目信任、HTTP 代理等核心服务；
 * - `./modes/*`：三种运行模式与主题系统；`./extensions/*`：内置扩展。
 */

import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import chalk from "chalk";
import { type Args, type Mode, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup, showStartupSelector } from "./cli/startup-ui.ts";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.ts";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import type { CreateAgentSessionOptions } from "./core/sdk.ts";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { builtInExtensions } from "./extensions/index.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, normalizePath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/** 扩展加载失败时的兜底提示文案：引导用户用 "-ne"（禁用扩展）启动来定位问题 */
const EXTENSION_LOAD_FAILURE_HINT = `Hint: Start without extensions using "${APP_NAME} -ne".`;

/**
 * 读取管道（piped）stdin 中的全部内容。
 * 若 stdin 是 TTY（交互式终端）则返回 undefined，表示没有管道输入。
 *
 * 用途：支持 `cat foo.md | pi ...` 这类用法，把管道内容并入初始消息。
 */
async function readPipedStdin(): Promise<string | undefined> {
	// stdin 是 TTY 说明用户在交互式终端里直接运行，没有管道输入可读
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			// 全部读完后去掉首尾空白；空字符串归一化为 undefined，方便上层判空
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

/**
 * 把启动阶段收集到的诊断信息（错误/警告/提示）统一渲染到 stderr。
 * 按类型着色并加前缀：error 红色 "Error: "、warning 黄色 "Warning: "、其余灰色无前缀。
 */
function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

/**
 * 判断环境变量取值是否为「真」。
 * 仅 "1"、"true"、"yes"（忽略大小写）视为真，其余取值（含未设置）一律为假。
 */
function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

/**
 * 决定应用的运行模式（AppMode），优先级从高到低：
 * 1. 显式 `--mode rpc` / `--mode json` 指定；
 * 2. `--print`，或 stdin/stdout 任一不是 TTY（被管道/重定向）时降级为 print 模式；
 * 3. 其余情况进入交互式 TUI 模式。
 *
 * @param parsed 已解析的 CLI 参数
 * @param stdinIsTTY stdin 是否为终端
 * @param stdoutIsTTY stdout 是否为终端
 * @returns 本次运行的 AppMode（rpc / json / print / interactive）
 */
function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

/** 把运行模式映射为打印模式的输出格式：json 模式输出 JSON，其余（text）输出纯文本 */
function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

/**
 * 判断是否为「纯运行时元信息命令」（--help / --list-models 且非 print 模式）。
 * 这类命令只输出固定文本、不跑 Agent，因此无需接管 stdout（保持原始输出流）。
 */
function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

/**
 * 处理 `pi auth ...` 鉴权子命令（auth check / print-api-key / print-bearer-token）。
 *
 * 非 check 子命令只负责解析并打印目标凭据；check 子命令完整校验供应商鉴权状态，
 * 支持 --json 结构化输出与 --credentials 附带实际凭据，并按状态设置退出码：
 * ready=0、not_ready=1、invalid=2。
 *
 * @param args 原始命令行参数（内部自行识别是否为 auth 子命令）
 * @returns 是否已按 auth 子命令处理完毕；true 时 main() 直接返回，不再进入主流程
 */
async function runAuthCommand(args: string[]): Promise<boolean> {
	// `pi auth --help`：打印子命令帮助后结束
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		// 解析失败：打印可读错误并置退出码 1，同样不再进入主流程
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		// 拒绝未知 flag，避免拼写错误被静默忽略
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			// 参数诊断（如取值类型错误）统一转为 AuthCommandError 抛出，走下方统一错误处理
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (command.kind !== "check") {
			// 非 check 子命令（print-api-key / print-bearer-token）：解析出目标凭据后直接打印。
			// 15s 超时兜底，避免鉴权网络请求把一次性命令无限挂起
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		// ---- auth check 子命令：完整校验供应商鉴权状态 ----
		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			// --no-refresh 场景使用只读凭据存储，确保校验过程不会触发令牌刷新或写入
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			if (command.credentials && result.status === "ready") {
				// --credentials：鉴权就绪时额外取出实际凭据一并输出
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					// 状态为 ready 却拿不到凭据：降级为 not_ready，避免误导调用方
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			// 校验过程抛异常（凭据存储损坏、网络失败等）统一归为 invalid 状态，而非让进程崩溃
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		// --json 输出结构化结果（有凭据时附加 credentials 字段），否则直接输出凭据或状态字符串
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		// 退出码约定：ready=0，not_ready=1，invalid=2（供脚本判断鉴权状态）
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		// check 失败约定退出码 2（区别于其他子命令的 1）
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

/**
 * 组装本次运行的初始用户消息（文本 + 可选图片）。
 *
 * 若带 @file 参数则先读取并处理文件内容（图片可按设置自动缩放），
 * 再把文件文本/图片、位置参数消息与 stdin 管道内容一并交给 buildInitialMessage 拼装；
 * 无 @file 参数时只拼接参数消息与管道内容。
 *
 * @param parsed 已解析的 CLI 参数
 * @param autoResizeImages 是否对图片做自动缩放（来自用户设置）
 * @param stdinContent 管道 stdin 的内容（若有）
 * @returns 初始消息文本与初始图片列表
 */
async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** 会话参数（--session / --fork 的取值）的解析结果 */
type ResolvedSession =
	| { type: "path"; path: string } // 直接给出的文件路径
	| { type: "local"; path: string } // 在当前项目的会话中找到
	| { type: "global"; path: string; cwd: string } // 在其他项目的会话中找到（附带其工作目录）
	| { type: "not_found"; arg: string }; // 任何地方都未找到

/**
 * 在当前项目（cwd）的会话列表中按「完整会话 ID」精确查找。
 * 供 --session-id 查重、--fork 指定目标 ID 等场景使用（ID 前缀匹配见 resolveSessionPath）。
 *
 * @param sessionId 完整会话 ID
 * @param cwd 当前工作目录
 * @param sessionDir 会话存储目录（可选）
 * @returns 命中时返回 local 类型的解析结果，否则 undefined
 */
async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; path: string } | undefined> {
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch = localSessions.find((s) => s.id === sessionId);
	return localMatch ? { type: "local", path: localMatch.path } : undefined;
}

/**
 * 把会话参数解析为会话文件路径。
 * 看起来像路径（含路径分隔符或 .jsonl 后缀）则原样使用；否则依次按
 * 「当前项目精确 ID → 当前项目 ID 前缀 → 全局（所有项目）精确 ID → 全局 ID 前缀」匹配。
 *
 * @param sessionArg 用户提供的会话参数（路径或会话 ID/ID 前缀）
 * @param cwd 当前工作目录
 * @param sessionDir 会话存储目录（可选）
 * @returns ResolvedSession：命中路径/本地/全局，或明确未找到
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// 看起来像文件路径时，先解析为绝对路径再交给会话管理器
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// 先在当前项目内按会话 ID 精确匹配，找不到再退化为 ID 前缀匹配
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatch =
		localSessions.find((s) => s.id === sessionArg) ?? localSessions.find((s) => s.id.startsWith(sessionArg));

	if (localMatch) {
		return { type: "local", path: localMatch.path };
	}

	// 当前项目没找到，跨所有项目全局搜索（同样先精确后前缀）
	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch =
		allSessions.find((s) => s.id === sessionArg) ?? allSessions.find((s) => s.id.startsWith(sessionArg));

	if (globalMatch) {
		return { type: "global", path: globalMatch.path, cwd: globalMatch.cwd };
	}

	// 到处都找不到
	return { type: "not_found", arg: sessionArg };
}

/** 在终端上向用户发起 [y/N] 是/否确认；仅回答 y/yes（忽略大小写）视为确认 */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

/**
 * 校验 --fork 与其他会话相关 flag 的互斥关系：
 * --fork 不能与 --session / --continue / --resume / --no-session 组合，
 * 冲突时报错并直接退出（exit 1）。
 */
function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	// 收集与 --fork 冲突的会话相关 flag
	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

/**
 * 校验 --session-id：不能与 --session / --continue / --resume 组合，
 * 且会话 ID 本身必须合法（assertValidSessionId），违规即报错退出（exit 1）。
 */
function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

/** 打开已有会话文件；失败（文件不存在/损坏等）则报错并以 exit 1 退出 */
function openSessionOrExit(path: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.open(path, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

/**
 * 从源会话文件分叉（fork）出一个新会话，可选指定新会话 ID；
 * 失败则报错并以 exit 1 退出。
 */
function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string, sessionId?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

/**
 * 根据命令行参数创建 SessionManager（决定本次运行如何获得会话）。
 *
 * 决策顺序（先命中先返回）：
 * 1. --no-session / --help / --list-models：使用内存会话（不落盘，避免产生垃圾文件）；
 * 2. --fork <来源>：从指定会话分叉出新会话（--session-id 可指定目标 ID，但不允许与已有会话撞 ID）；
 * 3. --session <目标>：打开指定会话；若会话属于其他项目，则提示是否 fork 到当前目录继续；
 * 4. --resume：弹出会话选择器，由用户挑选后打开；
 * 5. --continue：续接当前项目最近一次会话；
 * 6. --session-id：打开同 ID 的已有会话，不存在则警告并新建该 ID 的会话；
 * 7. 默认：创建全新会话。
 *
 * @param parsed 已解析的 CLI 参数
 * @param cwd 当前工作目录
 * @param sessionDir 会话存储目录
 * @param settingsManager 启动阶段的设置管理器（供 --resume 的会话选择器读取设置）
 * @returns 就绪的 SessionManager
 */
export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	// 无会话模式或纯元信息命令：用内存会话，不产生落盘文件
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd, parsed.sessionId !== undefined ? { id: parsed.sessionId } : undefined);
	}

	if (parsed.fork) {
		// --session-id 指定了 fork 目标 ID 时，先确认没有同 ID 会话，防止覆盖已有记录
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			// 三种来源（显式路径 / 本项目 / 跨项目）都直接 fork 到当前目录
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			// 路径或本项目会话：直接打开
			case "path":
			case "local":
				return openSessionOrExit(resolved.path, sessionDir);

			case "global": {
				// 会话属于其他项目：询问用户是否把它 fork 到当前目录继续（拒绝则中止）
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		// --resume：弹出交互式会话选择器（本项目会话优先展示，也可看全部项目的会话）
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress) => SessionManager.listAll(sessionDir, onProgress),
				settingsManager,
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir);
		} finally {
			// 无论选择结果如何都要停掉主题文件监听，避免进程悬挂
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		// --continue：直接续接当前项目最近一次会话
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		// --session-id：优先复用同 ID 的已有会话；没有则警告并新建同 ID 会话
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.path, sessionDir);
		}
		console.error(
			chalk.yellow(
				`Warning: No project session found with id '${parsed.sessionId}'; creating a new session with that id.`,
			),
		);
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

/**
 * 把 CLI 参数与解析出的模型作用域（scopedModels）转换为 createAgentSession 所需的选项。
 *
 * 模型选择优先级：CLI 显式 --model/--provider > 设置中保存的默认模型（须在 scoped
 * models 范围内）> scoped models 的第一个；thinking 级别同样按
 * 「显式 --thinking > 模型 pattern 内联的 :thinking 简写 > scoped model 配置」取值。
 * 续接已有会话（hasExistingSession）时不应用新的默认模型，保持会话原模型。
 *
 * @param parsed 已解析的 CLI 参数
 * @param scopedModels --models/设置解析出的候选模型列表（供交互模式 Ctrl+P 循环切换）
 * @param hasExistingSession 是否在续接已有会话
 * @param modelRuntime 模型运行时（查询供应商/模型详情）
 * @param settingsManager 设置管理器（读取保存的默认 provider/model）
 * @returns 会话选项、thinking 是否来自模型 pattern 简写（cliThinkingFromModel）、诊断列表
 */
function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRuntime: ModelRuntime,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// CLI 指定模型
	// - 支持 --provider <name> --model <pattern>
	// - 支持 --model <provider>/<pattern>
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			cliThinking: parsed.thinking,
			modelRuntime,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// 允许 "--model <pattern>:<thinking>" 作为简写形式。
			// 显式 --thinking 优先级更高（在下方统一覆盖）。
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// 检查设置中保存的默认模型是否在 scoped models 范围内——在则用之，否则取第一个 scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// scoped model 配置里显式设置了 thinking 时沿用（未被 --thinking 覆盖的前提下）
			if (!parsed.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// 第一个 scoped model 显式设置了 thinking 时同样沿用
			if (!parsed.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// CLI 显式指定的 --thinking 优先级最高，覆盖上面来自 scoped model 的设置
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
	}

	// 供 Ctrl+P 循环切换的 scoped models。
	// 模型 pattern 中未显式指定 thinking 时保持 undefined——
	// undefined 表示切换时「继承当前会话的 thinking 级别」。
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// 来自 CLI 的 API key —— 作为非持久化的运行时覆盖
	// （由调用方在 createAgentSession 之前处理）

	// 工具开关
	if (parsed.noTools) {
		options.noTools = "all";
	} else if (parsed.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (parsed.tools) {
		options.tools = [...parsed.tools];
	}
	if (parsed.excludeTools) {
		options.excludeTools = [...parsed.excludeTools];
	}

	return { options, cliThinkingFromModel, diagnostics };
}

/**
 * 把 CLI 传入的路径参数批量解析为绝对路径。
 * 只有「本地路径形态」的值才基于 cwd 解析；其余（如 URL、纯名称）原样保留。
 */
function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

/**
 * 会话记录缺失原始工作目录（cwd）时弹出启动选择器：
 * 选「Continue」返回回退 cwd 继续，选「Cancel」返回 undefined（放弃启动）。
 */
async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	return showStartupSelector(settingsManager, formatMissingSessionCwdPrompt(issue), [
		{ label: "Continue", value: issue.fallbackCwd },
		{ label: "Cancel", value: undefined },
	]);
}

/** main() 的可选配置 */
export interface MainOptions {
	/** 宿主额外注入的内联扩展工厂，追加在内置扩展之后加载 */
	extensionFactories?: InlineExtension[];
}

/**
 * CLI 主入口：完成全部启动编排后，把控制权交给对应运行模式。
 *
 * 大致阶段（详见各分节注释）：auth 子命令 → 包管理/配置子命令 → 参数解析与校验 →
 * 迁移与首次引导 → 会话管理器 → 项目信任与运行时创建（createRuntime 工厂）→
 * stdin/初始消息 → 按 appMode 分发到 rpc / interactive / print 模式。
 *
 * @param args 命令行参数（不含可执行名）
 * @param options 可选注入（如宿主提供的额外扩展工厂）
 */
export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	// 合并内置扩展与宿主注入的扩展工厂（内置在前，宿主可补充）
	const extensionFactories = [...builtInExtensions, ...(options?.extensionFactories ?? [])];
	// 离线模式：跳过一切网络请求（模型目录刷新、版本检查等）
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		// 回写环境变量，让后续创建的所有子服务都能感知离线状态
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	// `pi auth ...` 子命令：处理完毕直接返回，不进入主流程
	if (await runAuthCommand(args)) {
		return;
	}

	if (process.platform === "win32") {
		// Windows：清理自更新流程中被隔离的旧版本文件
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	// 清理托管安装（managed install）遗留的临时产物
	cleanupManagedInstall();

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// 引导期设置管理器：项目信任尚未判定，先按「未信任」创建，
	// 只用于尽早拿到全局 HTTP 代理等基础配置
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	// 尽早应用代理设置，确保后续所有网络请求（模型目录、鉴权）都走代理
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	// `pi <package 子命令>`：包的安装/更新/卸载等，处理完直接退出
	if (await handlePackageCommand(args, { extensionFactories })) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// 通常包命令用 process.exit(0) 立即退出，避免行为异常的扩展把一次性命令挂住。
			// 但在 Windows 上，若 process.exit(0) 发生在 teardown 期间，Node 会在
			// fetch() 之后触发断言崩溃；因此让成功的 `pi update` 自然排空事件循环后退出。
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	// `pi config ...` 配置子命令：处理完直接返回
	if (await handleConfigCommand(args, { extensionFactories })) {
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		// 打印参数解析产生的诊断；出现 error 级别时直接退出
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	// --version：打印版本号后退出
	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	// --export <file>：把已有会话导出为 HTML 等格式后退出（不进入任何运行模式）
	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	// 非交互且非纯元信息命令时接管 stdout：统一缓冲/过滤输出，
	// 防止扩展或工具直接 console.log 破坏 JSON-RPC / JSON 输出格式
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		// RPC 模式的 stdin 被 JSON-RPC 占用，@file 参数无处消费，直接拒绝
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	// 会话相关 flag 互斥校验（不通过直接 exit 1）
	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);

	// 执行配置迁移（cwd 用于项目级迁移），收集已迁移的供应商与弃用警告
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// 实验性首次引导：主题选择与统计开关。
	// 必须在创建任何运行时服务之前执行，所选设置才能对所有服务生效。
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	// --theme：仅交互模式下作为一次性覆盖应用（不写回设置）
	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}

	// 在创建与 cwd 绑定的运行时服务之前，先确定最终运行时 cwd。
	// --session 和 --resume 可能选中其他项目的会话，因此项目级设置、资源、
	// 供应商注册和模型都必须等目标会话 cwd 确定后再解析；启动 cwd 的设置
	// 管理器只用于会话选择期间的 sessionDir 查找。
	const envSessionDir = process.env[ENV_SESSION_DIR];
	// sessionDir 优先级：--session-dir 参数 > 环境变量 > 设置中的默认值
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	// 会话记录缺失原始 cwd（如目录被删除/移动）时的兜底处理
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			// 交互模式：让用户选择回退 cwd 继续还是取消
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			// 非交互模式无法询问：直接报错退出
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	// --name：为会话附加可读名称（空值/非法值报错）
	if (parsed.name !== undefined) {
		const name = normalizeSessionName(parsed.name);
		if (name === undefined) {
			console.error(chalk.red("Error: --name requires a non-empty value"));
			process.exit(1);
		}
		sessionManager.appendSessionInfo(name);
	}
	time("createSessionManager");

	// ===== 项目信任与运行时创建准备 =====
	const trustStore = new ProjectTrustStore(agentDir);
	const sessionCwd = sessionManager.getCwd();
	// 重载（/reload 等）时可自动信任的 cwd：仅当用户没有显式信任覆盖、
	// 且当前项目不含「需要信任的资源」时才免提示自动信任
	const autoTrustOnReloadCwd =
		parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(sessionCwd)
			? sessionCwd
			: undefined;
	// 信任提示使用的交互模式：--help / --list-models 场景没有 UI，按 print 处理
	const trustPromptMode: AppMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
	// cwd → 信任结果的缓存：同一进程内多次重建运行时时避免重复弹信任提示
	const projectTrustByCwd = new Map<string, boolean>();

	// 解析 CLI 传入的扩展/技能/提示词模板/主题路径（相对路径基于启动 cwd）
	const resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
	const resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
	const resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
	const resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
	// 运行时工厂：createAgentSessionRuntime 可能在会话重载（/reload、主题切换等）
	// 时多次调用它，按（可能变化的）cwd 重新创建全部服务并组装 Agent 会话
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		projectTrustContext,
	}) => {
		// sessionStartEvent 为空说明是首次创建运行时（而非会话中途重载）
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
		const cachedProjectTrust = projectTrustByCwd.get(cwd);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		// 需要真正解析信任的条件：用户没有显式覆盖、没有缓存结果、且项目确实有需要信任的资源
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined && cachedProjectTrust === undefined && hasTrustRequiringResources;
		// 信任取值优先级：缓存/显式覆盖 > 信任存储记录；需要解析时先按「未信任」创建设置，
		// 等资源加载器回调（下方 resolveProjectTrust）拿到用户决定后再重建
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || trustStore.get(cwd) === true));
		// 注意：这里按运行时 cwd 重建设置管理器（信任状态影响项目级设置与资源的可见性）
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			settingsManager: runtimeSettingsManager,
			// 模型目录解析 15s 超时，避免网络问题拖死启动
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			extensionFlagValues: parsed.unknownFlags,
			// 首次遇到需要信任的项目时，资源加载器会回调此函数弹出信任提示；
			// 结果写入缓存供同一进程内的后续重载复用
			resourceLoaderReloadOptions: shouldResolveProjectTrust
				? {
						resolveProjectTrust: async ({ extensionsResult }) => {
							const trusted = await resolveProjectTrusted({
								cwd,
								trustStore,
								trustOverride: parsed.projectTrustOverride,
								defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
								extensionsResult,
								// 首次运行时才有交互 UI；重载时优先复用外部传入的信任上下文
								projectTrustContext:
									projectTrustContext ??
									createProjectTrustContext({
										cwd,
										mode: isInitialRuntime ? trustPromptMode : appMode,
										settingsManager: startupSettingsManager,
										hasUI: isInitialRuntime && trustPromptMode === "interactive",
									}),
								// 信任检查期间扩展加载出错只记警告，不阻塞启动
								onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
							});
							projectTrustByCwd.set(cwd, trusted);
							return trusted;
						},
					}
				: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories,
			},
		});
		const { settingsManager, modelRuntime, resourceLoader } = services;
		// 汇总各来源诊断：项目信任、服务创建、设置、扩展加载失败
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...projectTrustDiagnostics,
			...services.diagnostics,
			...collectSettingsDiagnostics(settingsManager),
			...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		// 解析候选模型列表：--models 优先，否则用设置中启用的模型
		const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
		const scopedModels =
			modelPatterns && modelPatterns.length > 0
				? await resolveModelScope(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
				: [];
		// 组装会话选项（模型、thinking 级别、工具开关等）
		const {
			options: sessionOptions,
			cliThinkingFromModel,
			diagnostics: sessionOptionDiagnostics,
		} = buildSessionOptions(
			parsed,
			scopedModels,
			sessionManager.buildSessionContext().messages.length > 0,
			modelRuntime,
			settingsManager,
		);
		diagnostics.push(...sessionOptionDiagnostics);

		// --api-key：作为非持久化的运行时覆盖写入模型运行时；
		// 无法确定关联模型时报告错误（API key 必须能对应到具体供应商）
		if (parsed.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				await modelRuntime.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
			}
		}

		// 真正创建 Agent 会话
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			excludeTools: sessionOptions.excludeTools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		// CLI 显式指定了 thinking（--thinking 或模型 pattern 简写）时，
		// 把该级别重新应用到会话，覆盖会话记录中保存的旧值
		const cliThinkingOverride = parsed.thinking !== undefined || cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	// 创建初始运行时（此后 /reload 等场景会复用上面的工厂重建）
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});
	time("createAgentSessionRuntime");
	const { services, session, modelFallbackMessage } = runtime;
	const { settingsManager, modelRuntime, resourceLoader } = services;
	// 运行时已确定最终设置：再次应用代理与 HTTP 空闲超时（可能带上会话项目级设置）
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

	// --help：打印帮助（合并扩展贡献的 flag）后退出
	if (parsed.help) {
		reportDiagnostics(startupSettingsDiagnostics);
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	// --list-models [pattern]：列出可用模型（可按模式过滤）后退出
	if (parsed.listModels !== undefined) {
		reportDiagnostics(startupSettingsDiagnostics);
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRuntime, searchPattern, AbortSignal.timeout(15_000));
		process.exit(0);
	}

	// 读取管道 stdin 内容（若有）——RPC 模式跳过，因为其 stdin 被 JSON-RPC 占用
	let stdinContent: string | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		// 有管道输入时自动从交互模式切换为 print 模式（如 `echo hi | pi`）
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	// 组装初始消息与图片（@file 参数、位置参数、stdin 管道内容在此合并）
	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	// 初始化主题（交互模式下同时启动主题文件监听）
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// 交互模式下展示配置迁移产生的弃用警告
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	time("resolveModelScope");
	// 汇总启动诊断并去重：非交互模式（无法稍后在 TUI 中展示）或有 error 级诊断时立即打印
	const startupDiagnostics = deduplicateDiagnostics([...startupSettingsDiagnostics, ...runtime.diagnostics]);
	const hasRuntimeErrors = runtime.diagnostics.some((diagnostic) => diagnostic.type === "error");
	if (appMode !== "interactive" || hasRuntimeErrors) {
		reportDiagnostics(startupDiagnostics);
	}
	if (hasRuntimeErrors) {
		// 扩展加载失败时补充提示：可用 -ne（禁用扩展）启动来定位问题
		if (runtime.diagnostics.some((diagnostic) => diagnostic.message.includes("Failed to load extension"))) {
			console.error(chalk.yellow(EXTENSION_LOAD_FAILURE_HINT));
		}
		process.exit(1);
	}
	time("createAgentSession");

	// 非交互模式必须有可用模型（不像交互模式可以弹模型选择器让用户挑）
	if (appMode !== "interactive" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	// 启动基准测试（PI_STARTUP_BENCHMARK）：只测初始化耗时，仅支持交互模式
	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	// RPC 模式在此后台刷新模型目录；交互模式则在 TUI 初始化完成后再刷新，避免拖慢首屏。
	if (!offlineMode && appMode === "rpc") {
		const controller = new AbortController();
		// 刷新失败静默忽略（15s 超时中止），不阻塞也不影响主流程
		const timeout = setTimeout(() => controller.abort(), 15_000);
		void modelRuntime
			.refresh({ signal: controller.signal })
			.catch(() => {})
			.finally(() => clearTimeout(timeout));
	}

	if (appMode === "rpc") {
		// ===== JSON-RPC 模式：供编辑器插件等宿主以协议方式驱动 =====
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		// ===== 交互式 TUI 模式 =====
		const interactiveMode = new InteractiveMode(runtime, {
			migratedProviders,
			startupDiagnostics,
			modelFallbackMessage,
			autoTrustOnReloadCwd,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			tuiMode: parsed.tuiMode,
			initialThemeSetting: parsed.useTheme,
		});
		if (startupBenchmark) {
			// 基准测试模式：只完成初始化，不进入主循环
			await interactiveMode.init();
			time("interactiveMode.init");
			// 给 TUI 的 stdin 处理器一点时间消费终端查询应答
			// （Kitty 键盘协议、设备属性、单元格尺寸），再恢复终端状态。
			await new Promise((resolve) => setTimeout(resolve, 150));
			interactiveMode.stop();
			stopThemeWatcher();
			printTimings();
			// 等待 stdout/stderr 排空，确保计时数据完整输出后再退出
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		printTimings();
		await interactiveMode.run();
	} else {
		// ===== 一次性打印模式（--print / 管道输入 / --mode json）=====
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		// 恢复被接管的 stdout（takeOverStdout 缓冲的输出在此释放）
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
