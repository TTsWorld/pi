/**
 * @file agent-session-runtime.ts —— Agent 会话运行时（当前 session + cwd 绑定服务的持有者）
 *
 * @description
 * 本文件实现 `AgentSessionRuntime`：持有当前 `AgentSession` 及与其 cwd（工作目录）
 * 绑定的一整套服务（`AgentSessionServices`），并负责会话的整体替换——新建（/new）、
 * 恢复（/resume）、分叉（/fork）、导入（/import）时都会先拆解旧运行时，
 * 再通过工厂函数按新的 cwd 重建全套服务并落位新 session。
 *
 * 主要功能点：
 * - 通过 `CreateAgentSessionRuntimeFactory` 工厂创建运行时：工厂闭包了进程级固定输入，
 *   针对实际生效的 cwd 重建绑定服务、解析 session 选项，最后创建 AgentSession；
 * - 替换前先发出 `session_before_switch` / `session_before_fork` 扩展事件，
 *   扩展可通过 cancel 阻止本次切换（返回 cancelled: true，运行时保持原状）；
 * - 拆解顺序固定：abort 进行中的响应（保证被中止轮次落盘）→ `session_shutdown` 事件 →
 *   beforeSessionInvalidate 回调（宿主 UI 同步收尾）→ session.dispose；
 * - 每次替换都会向新 session 发出 `session_start` 事件，携带 reason
 *   （new/resume/fork/quit）与上一会话文件路径，便于扩展追踪会话链路。
 *
 * 依赖关系：
 * - `./agent-session.ts` / `./agent-session-services.ts`：会话本身与其 cwd 绑定服务；
 * - `./session-manager.ts`：JSONL 会话文件的打开/创建/分叉；
 * - `./session-cwd.ts`：校验会话 cwd 真实存在；
 * - `./extensions/*`：会话生命周期扩展事件（shutdown / start / before_switch 等）。
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

/**
 * 运行时创建的结果类型。
 *
 * 调用方由此拿到创建好的 session、与其 cwd 绑定的服务，
 * 以及创建（setup）过程中收集到的全部诊断信息。
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * 运行时工厂类型：为指定 cwd 与 SessionManager 创建完整运行时。
 *
 * 工厂闭包了进程级的固定输入（模型配置等全局状态），会针对实际生效的 cwd
 * 重建与之绑定的服务，基于这些服务解析 session 选项，最后创建 AgentSession。
 * 工厂在运行时生命周期内被反复复用（/new、/resume、/fork、导入均走它）。
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * 当 /import 引用的 JSONL 文件路径不存在时抛出此错误。
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

/**
 * 从用户消息的 content 中提取纯文本。
 * content 为字符串时直接返回；为分块数组时拼接所有 text 块
 * （跳过无 text 字段或 text 非字符串的块，如图片块）。
 */
function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * 持有当前 AgentSession 及其 cwd 绑定服务的运行时。
 *
 * 各会话替换方法（newSession / switchSession / fork / importFromJsonl）都会
 * 先拆解当前运行时，再创建并应用下一个运行时；若创建过程失败，错误会直接
 * 抛给调用方——面向用户的错误提示由调用方（宿主层）负责。
 */
export class AgentSessionRuntime {
	// 宿主注入的回调：替换完成后把新 session 重新绑定到宿主 UI
	private rebindSession?: (session: AgentSession) => Promise<void>;
	// 宿主注入的回调：旧 session 失效前的同步 UI 收尾（见 setBeforeSessionInvalidate）
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	// ===== 只读访问器：services / session / cwd / diagnostics / 模型回退提示 =====

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * 设置一个同步回调：在 `session_shutdown` 处理器全部执行完毕之后、
	 * 当前 session 真正失效之前运行。
	 *
	 * 用于宿主自有 UI 的收尾，且期间绝不能让出事件循环——例如在旧扩展上下文
	 * 失效之前，先同步卸载扩展提供的 TUI 组件，避免渲染到已失效的上下文。
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/**
	 * 发出 `session_before_switch` 事件，给扩展一个在会话切换前拦截的机会。
	 * 无任何处理器时直接放行；返回 cancelled: true 表示有扩展要求取消本次切换。
	 */
	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		// 快速路径：没有注册处理器就不必走事件分发
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	/**
	 * 发出 `session_before_fork` 事件（携带分叉目标条目与 position），
	 * 与 emitBeforeSwitch 同理：无处理器放行，有扩展 cancel 则取消分叉。
	 */
	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		// 快速路径：没有注册处理器就不必走事件分发
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	/**
	 * 拆解当前运行时（在创建并应用新运行时之前调用）。
	 * 拆解顺序是刻意的：先落盘、再通知扩展、最后同步收尾并释放。
	 */
	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// 先让进行中的响应收尾（settle），保证被中止的那一轮（含工具结果）
		// 在旧会话被替换之前就已持久化到其 JSONL 文件中。
		await this.session.abort();
		// 通知扩展：会话即将关闭（携带原因与即将切换到的目标会话文件）
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	/** 把新创建的运行时结果整体落位到当前实例（session/服务/诊断/回退提示全部一起换）。 */
	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	/**
	 * 会话替换的统一收尾：先让宿主重新绑定新 session（rebindSession），
	 * 再执行调用方传入的 withSession 回调（ctx 描述本次替换出的新会话）。
	 */
	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	/**
	 * 切换（/resume）到指定的会话文件。
	 *
	 * 流程：`session_before_switch` 事件（可取消）→ 打开目标 SessionManager
	 * 并校验其 cwd 存在 → 拆解当前运行时 → 用工厂重建运行时（reason 为
	 * "resume"，携带旧会话文件路径）→ 统一收尾。目标会话的 cwd 与当前不同时，
	 * 全套 cwd 绑定服务会随之整体重建（这正是"换项目"的实现方式）。
	 *
	 * @param options.cwdOverride - 会话文件中的 cwd 不可信/需要强制指定时的覆盖值
	 * @param options.withSession - 替换完成后在新 session 上下文中执行的回调
	 * @param options.projectTrustContextFactory - 按目标 cwd 构建项目信任上下文的工厂
	 * @returns 被扩展取消时为 `{ cancelled: true }`（运行时保持原状）
	 */
	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			// 扩展取消了切换：什么都不动，直接原样返回
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		// 无 cwdOverride 时以会话文件内记录的 cwd 为准
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		// 切换前先校验目标会话的 cwd 真实存在，避免带着无效目录启动
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	/**
	 * 新建会话（/new），沿用当前 cwd 与 agentDir。
	 *
	 * 仅当当前会话已持久化时才在磁盘上创建新会话文件；此前是内存会话的话，
	 * 新会话继续保持内存态。parentSession 可把新会话挂到某个旧会话之下，
	 * 形成会话树中的父子关系。
	 *
	 * @param options.setup - 落位后在新 session 的 SessionManager 上执行的初始化回调
	 * @param options.withSession - 替换完成后在新 session 上下文中执行的回调
	 */
	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			// 扩展取消了新建：什么都不动，直接原样返回
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		// 当前会话已持久化 → 在同一会话目录下新建会话文件；否则继续用内存会话
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			// 记录父会话，使新会话成为会话树中其子节点
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			// setup 直接操作新 session 的 SessionManager（可写入会话条目）；
			// 随后用会话文件重建的消息上下文覆盖 agent 消息，保证两边一致
			await options.setup(this.session.sessionManager);
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	/**
	 * 从当前会话的某个条目处分叉（/fork）出新会话。
	 *
	 * 分叉点由 position 决定：
	 * - "at"：以选中条目本身为分叉叶子，复制到该条目为止的历史；
	 * - "before"：以选中 user 消息的父节点为分叉叶子（即"从这条消息之前重开"），
	 *   同时把该消息文本提取为 selectedText 返回，供宿主回填到输入框。
	 *
	 * 分叉为会话根（targetLeafId 为 null）时不复制任何历史，仅建立父子关系。
	 * 持久化会话基于 JSONL 文件创建分支会话文件；内存会话走轻量路径，
	 * 直接在原 SessionManager 上分支。两者最后都走统一的
	 * 拆解 → 重建 → 收尾 流程（reason 为 "fork"）。
	 *
	 * @returns selectedText 仅在 position 为 "before" 且分叉成功时存在
	 */
	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		// targetLeafId：分叉后新会话的叶子条目；null 表示从会话根分叉
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		// "at"：分叉点就是选中条目；"before"：分叉点是其父节点，
		// 且仅接受 user 消息（语义是"编辑这条消息后重发"）
		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		// ===== 持久化会话：基于会话文件创建分支 =====
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			// 从会话根分叉：不复制历史，仅以当前会话为父节点创建全新会话文件
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			// 会话尚未写过磁盘（还没有首个助手响应）：没有可复制的文件内容，
			// 此时克隆/分叉无意义，直接报错引导用户等待
			if (!existsSync(currentSessionFile)) {
				throw new Error(
					"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
				);
			}
			// 重新打开当前会话文件，并从目标叶子创建分支会话文件
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		// ===== 内存会话：轻量路径，无需复制文件，直接在原 SessionManager 上分支 =====
		const sessionManager = this.session.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * 导入（/import）一个会话 JSONL 文件，并把运行时状态切换到导入的会话。
	 * 实现方式是把源文件复制到本 agent 的会话目录下，再走与 /resume 相同的切换流程。
	 *
	 * @returns 被 `session_before_switch` 取消时返回 `{ cancelled: true }`，否则返回 `{ cancelled: false }`。
	 * @throws {SessionImportFileNotFoundError} 输入路径不存在时抛出。
	 * @throws {MissingSessionCwdError} 导入会话的 cwd 无法解析且未提供覆盖值时抛出。
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		// 目标位置：当前会话目录下的同名文件（目录不存在则先创建）
		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		// 比较绝对路径避免"自己复制自己"：copyFileSync 源与目标相同时会把文件截断
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	/**
	 * 退出时销毁运行时：发出 reason 为 "quit" 的 `session_shutdown` 事件，
	 * 执行 beforeSessionInvalidate 回调后释放当前 session。
	 * 与 teardownCurrent 不同，这里不 abort 进行中的响应——进程即将退出。
	 */
	async dispose(): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}
}

/**
 * 用运行时工厂与初始会话目标创建初始运行时（进程启动时调用一次）。
 *
 * 同一个工厂会保存在返回的 AgentSessionRuntime 实例上，
 * 供后续 /new、/resume、/fork 及导入流程复用。
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	// 启动前先校验初始会话的 cwd 真实存在，避免带着无效目录启动
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

// 从 agent-session-services.ts 透传导出会话服务的创建入口与相关类型，
// 外部只需依赖本模块即可拿到完整的运行时 API 面
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
