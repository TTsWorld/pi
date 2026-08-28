/**
 * @file remote-session.ts —— 远程会话客户端封装（RemoteSession 状态机）
 *
 * @description
 * 本文件实现 `RemoteSession`：基于 pi-client 的 `PiClient` 连接，对单个远程
 * 编码会话（SessionLease 租约）做「生命周期 + 快照 + 增量进度」三层封装，
 * 并以可订阅的 `RemoteSessionState` 对外发布统一视图，供 TUI 等宿主渲染。
 *
 * 主要功能点：
 * - 生命周期状态机：unbound（未绑定会话）→ ready（就绪）→ busy（某操作
 *   执行中）→ disposed（已销毁，终态）；所有公开方法先做状态断言再执行，
 *   避免并发操作互相踩踏；
 * - 会话绑定：open/create 以排他（exclusive）模式获取租约后订阅快照与事件
 *   流，借助 ./transcript.ts 的纯函数把「快照 + 流式增量」折叠成有序转录；
 * - 操作互斥：#runOperation 统一进入 busy 并通知订阅者；abort 可抢占进行中
 *   的 submit（preempt），其余操作在 busy 时直接抛错；
 * - dispose 语义：幂等；用只在销毁时 resolve 的 #disposeSignal 参与
 *   Promise.race，让挂起的操作立即失败，并等待所有在途附加操作收尾；
 * - 连接恢复：reconnect 重建底层连接后重新获取原会话的排他租约。
 *
 * 依赖关系：
 * - `@earendil-works/pi-client`：PiClient 连接、SessionLease 租约、订阅原语；
 * - `@earendil-works/pi-protocol`：会话快照 / 事件 / 转录条目等协议类型；
 * - `./transcript.ts`：转录状态的创建、快照合并与增量应用。
 */

import type {
	ConnectionState,
	ConnectionStateChange,
	PiClient,
	SessionLease,
	Unsubscribe,
} from "@earendil-works/pi-client";
import type {
	ModelMetadata,
	ModelRef,
	ServerEvent,
	SessionMetadata,
	SessionPhase,
	SessionSnapshot,
	ThinkingLevel,
	TranscriptItem,
} from "@earendil-works/pi-protocol";
import {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	type TranscriptState,
} from "./transcript.ts";

/** 会话操作类型标识：进入 busy 状态时记录当前正在执行的操作名，供 UI 展示与互斥判断。 */
export type RemoteSessionOperation = "open" | "create" | "submit" | "abort" | "setModel" | "setThinking" | "reconnect";

/**
 * 会话生命周期判别联合（discriminated union）：
 * - `unbound`：尚未绑定任何远程会话（初始态，或 session_removed 之后）；
 * - `ready`：已绑定会话，可接受新操作；
 * - `busy`：某个 {@link RemoteSessionOperation} 正在执行；
 * - `disposed`：已销毁的终态，任何后续操作都会抛错。
 */
export type RemoteSessionLifecycle =
	| { readonly status: "unbound" }
	| { readonly status: "ready" }
	| { readonly status: "busy"; readonly operation: RemoteSessionOperation }
	| { readonly status: "disposed" };

/**
 * 对外发布的会话视图状态（每次通知都生成新对象，便于宿主做引用比较）：
 * - lifecycle：当前生命周期；
 * - snapshot：最近一次采纳的会话快照（未绑定时为 undefined）；
 * - transcript：按「快照 + 流式增量」折叠出的有序转录条目。
 */
export interface RemoteSessionState {
	readonly lifecycle: RemoteSessionLifecycle;
	readonly snapshot?: SessionSnapshot;
	readonly transcript: readonly TranscriptItem[];
}

/** 创建新远程会话的参数：工作目录必填，模型与思考级别可选（缺省用服务端默认）。 */
export interface CreateRemoteSessionOptions {
	cwd: string;
	model?: ModelRef;
	thinkingLevel?: ThinkingLevel;
}

/** RemoteSession 的构造选项：onListenerError 用于兜底接收订阅回调抛出的异常。 */
export interface RemoteSessionOptions {
	onListenerError?: (error: Error) => void;
}

/**
 * 专用错误类型：标记「操作在 await 期间会话已被 dispose」的竞态。
 * settleRemoteSessionDisposal 会把这类错误视为预期结果过滤掉，不再上抛。
 */
class RemoteSessionDisposedError extends Error {
	constructor() {
		super("Remote session is disposed");
		this.name = "RemoteSessionDisposedError";
	}
}

/**
 * 等待所有清理 Promise 收尾并聚合失败原因（dispose 的收尾阶段调用）。
 * 过滤掉 RemoteSessionDisposedError —— 该错误表示操作因 dispose 而中止，属于
 * 预期结果；剩余错误只有 1 个时原样抛出，多个时打包成 AggregateError 一次性
 * 上报，避免吞掉任何一个失败原因。
 */
async function settleRemoteSessionDisposal(cleanup: readonly Promise<void>[]): Promise<void> {
	const results = await Promise.allSettled(cleanup);
	const errors = results.flatMap((result) =>
		result.status === "rejected" && !(result.reason instanceof RemoteSessionDisposedError) ? [result.reason] : [],
	);
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "Failed to dispose remote session");
}

/**
 * 远程会话客户端：管理单个远程编码会话的完整生命周期——对上提供状态订阅
 * 与一组异步操作，对下持有 PiClient 连接与 SessionLease 租约，并把服务端
 * 快照与流式事件折叠成统一视图。构造函数为 private，请通过静态工厂
 * {@link RemoteSession.open} / {@link RemoteSession.create} 创建实例。
 */
export class RemoteSession {
	// ==================== 内部状态 ====================
	// #pendingAttachmentOperations：进行中的绑定类操作（open/create/reconnect），
	//   dispose 时必须等它们收尾，避免租约泄漏；
	// #activeOperationStates：仍在执行的 busy 状态对象，供 abort 抢占 submit 后
	//   判断是否恢复先前状态；#disposeSignal：只在 dispose 时 resolve 的 Promise，
	//   用于让挂起中的操作通过 Promise.race 立即失败。
	readonly #client: PiClient;
	readonly #onListenerError: ((error: Error) => void) | undefined;
	#lifecycle: RemoteSessionLifecycle = { status: "unbound" };
	#handle: SessionLease | undefined;
	#transcript: TranscriptState | undefined;
	#unsubscribeSnapshot: Unsubscribe | undefined;
	#unsubscribeEvents: Unsubscribe | undefined;
	readonly #listeners = new Set<(state: RemoteSessionState) => void>();
	readonly #pendingAttachmentOperations = new Set<Promise<void>>();
	readonly #activeOperationStates = new Set<RemoteSessionLifecycle>();
	#disposePromise: Promise<void> | undefined;
	#resolveDisposeSignal: () => void = () => {};
	readonly #disposeSignal = new Promise<void>((resolve) => {
		this.#resolveDisposeSignal = resolve;
	});

	private constructor(client: PiClient, options: RemoteSessionOptions = {}) {
		this.#client = client;
		this.#onListenerError = options.onListenerError;
	}

	/** 当前绑定会话的 id（未绑定时为 undefined）。 */
	get id(): string | undefined {
		return this.#handle?.id;
	}

	/** 当前视图状态：生命周期 + 快照 + 折叠后的转录（每次访问重新计算）。 */
	get state(): RemoteSessionState {
		return {
			lifecycle: this.#lifecycle,
			snapshot: this.#transcript?.snapshot,
			transcript: this.#transcript ? selectTranscript(this.#transcript) : [],
		};
	}

	/** 最近一次采纳的会话快照（未绑定时为 undefined）。 */
	get snapshot(): SessionSnapshot | undefined {
		return this.#transcript?.snapshot;
	}

	get phase(): SessionPhase | undefined {
		return this.snapshot?.phase;
	}

	/** busy 状态下正在执行的操作名，否则为 undefined。 */
	get operation(): RemoteSessionOperation | undefined {
		return this.#lifecycle.status === "busy" ? this.#lifecycle.operation : undefined;
	}

	get models(): readonly ModelMetadata[] {
		return this.#client.snapshot?.models ?? [];
	}

	get sessions(): readonly SessionMetadata[] {
		return this.#client.snapshot?.sessions ?? [];
	}

	get connectionState(): ConnectionState {
		return this.#client.connectionState;
	}

	/** 是否已销毁（终态，不可逆）。 */
	get disposed(): boolean {
		return this.#lifecycle.status === "disposed";
	}

	/**
	 * 订阅状态变化；注册时立即用当前状态同步回调一次（保证首帧渲染）。
	 * 回调抛出的异常经 onListenerError 上报，不影响其他订阅者。@returns 取消订阅函数
	 */
	subscribe(listener: (state: RemoteSessionState) => void): Unsubscribe {
		this.#assertNotDisposed();
		this.#listeners.add(listener);
		this.#callListener(listener, this.state);
		return () => this.#listeners.delete(listener);
	}

	onConnectionStateChange(listener: (change: ConnectionStateChange) => void): Unsubscribe {
		this.#assertNotDisposed();
		return this.#client.onConnectionStateChange(listener);
	}

	/** 工厂方法：打开已有会话并返回绑定完成的实例；失败时自动 dispose，避免泄漏租约与订阅。 */
	static async open(client: PiClient, sessionId: string, options: RemoteSessionOptions = {}): Promise<RemoteSession> {
		const session = new RemoteSession(client, options);
		try {
			await session.open(sessionId);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	/**
	 * 打开（绑定到）指定 id 的会话，以排他模式获取租约。已绑定同一会话且
	 * 处于 ready 时为幂等 no-op；当前会话非 idle 时拒绝切换，防止打断进行中的回合。
	 */
	async open(sessionId: string): Promise<void> {
		if (this.#handle?.id === sessionId && this.#lifecycle.status === "ready") return;
		await this.#replace("open", () => this.#client.acquireSession(sessionId, { mode: "exclusive" }));
	}

	/** 工厂方法：在服务端创建新会话并返回绑定完成的实例；失败时自动 dispose。 */
	static async create(
		client: PiClient,
		createOptions: CreateRemoteSessionOptions,
		options: RemoteSessionOptions = {},
	): Promise<RemoteSession> {
		const session = new RemoteSession(client, options);
		try {
			await session.create(createOptions);
			return session;
		} catch (error) {
			await session.dispose();
			throw error;
		}
	}

	/** 创建新会话并绑定；若旧会话仍 attached 会按安全顺序替换（见 #prepareReplacement）。 */
	async create(options: CreateRemoteSessionOptions): Promise<void> {
		await this.#replace("create", () => this.#client.createSession(options));
	}

	/**
	 * 提交用户输入：idle 阶段发起新回合（prompt），turn 阶段注入转向指令（steer）。
	 * 空白输入直接忽略；其余阶段（正在收尾 / 中止中等）不接受输入并抛错。
	 */
	async submit(text: string): Promise<void> {
		// 去除首尾空白；纯空白输入不产生任何请求
		const normalized = text.trim();
		if (!normalized) return;
		this.#assertAvailable();
		const handle = this.#requireHandle();
		// 仅 idle（开新回合）与 turn（中途转向）两个阶段接受输入
		if (this.phase !== "idle" && this.phase !== "turn") {
			throw new Error(`Session cannot accept input during ${this.phase ?? "unknown"} phase`);
		}
		await this.#runOperation("submit", () =>
			// idle → prompt 开新回合；turn → steer 中途修正模型目标
			(this.phase === "idle" ? handle.prompt(normalized) : handle.steer(normalized)).then(() => undefined),
		);
	}

	/**
	 * 中止当前回合。submit 还在途时允许抢占（跳过 busy 断言先记录 abort）；
	 * 已是 idle 且没有可抢占的 submit 时为幂等 no-op。
	 */
	async abort(): Promise<void> {
		// submit 尚未完成时 abort 直接抢占，而不是报 busy 错误
		const preemptingSubmit = this.#lifecycle.status === "busy" && this.#lifecycle.operation === "submit";
		if (preemptingSubmit) this.#assertNotDisposed();
		else this.#assertAvailable();
		const handle = this.#requireHandle();
		// idle 且无在途 submit：没有可中止的内容
		if (this.phase === "idle" && !preemptingSubmit) return;
		await this.#runOperation("abort", () => handle.abort().then(() => undefined), preemptingSubmit);
	}

	/** 切换模型；仅 idle 阶段允许（回合进行中改模型会破坏请求一致性）。 */
	async setModel(model: ModelRef): Promise<void> {
		await this.#runIdleOperation("setModel", "change model", () =>
			this.#requireHandle()
				.setModel(model)
				.then(() => undefined),
		);
	}

	/** 切换思考级别；仅 idle 阶段允许。 */
	async setThinking(thinkingLevel: ThinkingLevel): Promise<void> {
		await this.#runIdleOperation("setThinking", "change thinking level", () =>
			this.#requireHandle()
				.setThinking(thinkingLevel)
				.then(() => undefined),
		);
	}

	/**
	 * 底层连接失效后的恢复流程：重连客户端，再以排他模式重新获取原会话租约
	 * 并重新绑定（重放订阅、重建转录状态）；全程作为附加类操作追踪。
	 */
	async reconnect(): Promise<void> {
		this.#assertAvailable();
		// 先记住会话 id：重连后旧租约句柄已失效，需按 id 重新获取
		const sessionId = this.#requireHandle().id;
		await this.#runOperation("reconnect", () =>
			this.#trackAttachmentOperation(async () => {
				await this.#client.reconnect();
				const handle = await this.#client.acquireSession(sessionId, { mode: "exclusive" });
				await this.#assertNotDisposedAfterAwait(handle);
				this.#bind(handle);
			}),
		);
	}

	/**
	 * 销毁会话客户端（幂等：重复调用返回同一个 Promise）。同步进入 disposed
	 * 终态并触发 #disposeSignal 让挂起操作立即失败；随后等待所有在途附加操作
	 * 与旧租约收尾，失败原因聚合上抛（RemoteSessionDisposedError 除外）。
	 */
	dispose(): Promise<void> {
		if (this.#disposePromise) return this.#disposePromise;
		// 先留引用：下面会清空字段，但收尾阶段仍需释放旧租约
		const handle = this.#handle;
		this.#lifecycle = { status: "disposed" };
		// 触发 dispose 信号：让所有挂起中的操作通过 race 立即以错误收尾
		this.#resolveDisposeSignal();
		this.#clearSubscriptions();
		this.#handle = undefined;
		this.#transcript = undefined;
		// 等待在途的 open/create/reconnect 全部收尾，并把旧租约释放一并纳入清理
		const cleanup = [...this.#pendingAttachmentOperations];
		if (handle) cleanup.push(handle.dispose());
		this.#disposePromise = settleRemoteSessionDisposal(cleanup);
		// 清空监听器前发最后一次通知，让订阅者能感知 disposed 状态
		this.#notify();
		this.#listeners.clear();
		return this.#disposePromise;
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.dispose();
	}

	/**
	 * open/create 的公共入口：先做可用性与阶段校验，
	 * 再以「附加类操作」的形式执行替换流程（#prepareReplacement）。
	 */
	async #replace(operation: "open" | "create", prepare: () => Promise<SessionLease>): Promise<void> {
		this.#assertAvailable();
		// 当前会话正在回合中时不允许被替换，防止丢失进行中的上下文
		if (this.#handle && this.phase !== "idle") {
			throw new Error(`Cannot ${operation} a session while session is ${this.phase ?? "unavailable"}`);
		}
		await this.#runOperation(operation, () =>
			this.#trackAttachmentOperation(() => this.#prepareReplacement(operation, prepare)),
		);
	}

	/**
	 * 把绑定类操作登记到 #pendingAttachmentOperations，保证 dispose 能等待
	 * 其完成（无论成功失败都从集合移除，避免泄漏 Promise）。
	 */
	async #trackAttachmentOperation(run: () => Promise<void>): Promise<void> {
		const pending = run();
		this.#pendingAttachmentOperations.add(pending);
		try {
			await pending;
		} finally {
			this.#pendingAttachmentOperations.delete(pending);
		}
	}

	/**
	 * 替换会话的安全顺序：先拿到并校验新租约，再释放旧租约；任一步失败都
	 * 会回滚（释放新租约），保证旧会话要么完整保留、要么完整切换，
	 * 不出现两边都丢的中间态。
	 */
	async #prepareReplacement(operation: "open" | "create", prepare: () => Promise<SessionLease>): Promise<void> {
		const previous = this.#handle;
		const next = await prepare();
		await this.#assertNotDisposedAfterAwait(next);
		const snapshot = next.snapshot;
		// 新会话必须自带初始快照，否则视为服务端异常，立即回滚
		if (!snapshot) {
			await this.#detach(next);
			throw new Error(`Session ${next.id} did not provide a snapshot`);
		}
		// prepare 是异步的：拿到新租约后需复查旧会话是否已进入新回合
		if (previous && previous.id !== next.id && previous.attached && this.phase !== "idle") {
			await this.#detach(next);
			throw new Error(`Cannot ${operation} a session while session is ${this.phase ?? "unavailable"}`);
		}
		if (previous && previous.id !== next.id && previous.attached) {
			try {
				await previous.detach();
			} catch (error) {
				// 释放旧租约失败也要回滚新租约；两个错误都保留并聚合上报
				try {
					await this.#detach(next);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Failed to replace remote session attachment");
				}
				throw error;
			}
		}
		// 绑定前再查一次 dispose 竞态，避免把新租约挂到已销毁的实例上
		await this.#assertNotDisposedAfterAwait(next);
		this.#bind(next, snapshot);
	}

	/**
	 * setModel/setThinking 的公共入口：要求已绑定会话且处于 idle 阶段。
	 * @param description 报错信息中使用的可读操作描述（如 "change model"）
	 */
	async #runIdleOperation(
		operation: "setModel" | "setThinking",
		description: string,
		run: () => Promise<void>,
	): Promise<void> {
		this.#assertAvailable();
		this.#requireHandle();
		if (this.phase !== "idle") {
			throw new Error(`Cannot ${description} while session is ${this.phase ?? "unavailable"}`);
		}
		await this.#runOperation(operation, run);
	}

	/**
	 * 所有公开操作的统一执行骨架：进入 busy → 通知 → 执行 → 恢复状态 → 再通知。
	 * 执行与 #disposeSignal 竞速，dispose 发生时操作立即以错误收尾而不是干等。
	 *
	 * @param preempt 为 true 时表示抢占式操作（abort 打断 submit）：跳过 busy
	 *   断言直接执行，结束后若被抢占的操作仍在执行则恢复其 busy 状态；
	 *   否则按是否仍绑定会话回到 ready / unbound。
	 */
	async #runOperation(operation: RemoteSessionOperation, run: () => Promise<void>, preempt = false): Promise<void> {
		if (preempt) this.#assertNotDisposed();
		else this.#assertAvailable();
		// 记录进入 busy 前的状态：抢占式操作收尾时可能需要恢复它
		const previous = this.#lifecycle;
		const busy: RemoteSessionLifecycle = { status: "busy", operation };
		this.#lifecycle = busy;
		this.#activeOperationStates.add(busy);
		this.#notify();
		const running = run();
		try {
			// 与 dispose 信号竞速：销毁后在途操作不再等待其自然完成
			await Promise.race([
				running,
				this.#disposeSignal.then(() => {
					throw new Error("Remote session is disposed");
				}),
			]);
		} finally {
			this.#activeOperationStates.delete(busy);
			// 仅当生命周期仍是本操作的 busy 且未被销毁时才恢复，避免覆盖更新的状态
			if (!this.disposed && this.#lifecycle === busy) {
				this.#lifecycle =
					// 抢占结束但被抢占的操作仍在执行：恢复其 busy 状态
					preempt && this.#activeOperationStates.has(previous)
						? previous
						: this.#handle
							? { status: "ready" }
							: { status: "unbound" };
				this.#notify();
			}
		}
	}

	/**
	 * 绑定新租约：先清掉旧订阅，再重建转录状态并订阅快照与事件流。
	 * @param knownSnapshot 已知的初始快照，可省去重复读取 handle.snapshot
	 */
	#bind(handle: SessionLease, knownSnapshot?: SessionSnapshot): void {
		const snapshot = knownSnapshot ?? handle.snapshot;
		if (!snapshot) throw new Error(`Session ${handle.id} did not provide a snapshot`);
		this.#clearSubscriptions();
		this.#handle = handle;
		this.#transcript = createTranscriptState(snapshot);
		this.#unsubscribeSnapshot = handle.subscribe((next) => {
			if (!this.#transcript) return;
			this.#transcript = applyTranscriptSnapshot(this.#transcript, next);
			this.#notify();
		});
		this.#unsubscribeEvents = handle.onEvent((event) => this.#handleEvent(event));
	}

	/**
	 * 服务端事件分发：session_removed 时本地解绑（busy 状态保留，等在途操作
	 * 自行收尾）；session_progress 则把增量折叠进转录状态后通知订阅者。
	 */
	#handleEvent(event: ServerEvent): void {
		// 服务端已删除该会话：清空本地绑定回到 unbound
		if (event.type === "session_removed") {
			this.#clearSubscriptions();
			this.#handle = undefined;
			this.#transcript = undefined;
			if (this.#lifecycle.status !== "busy") this.#lifecycle = { status: "unbound" };
			this.#notify();
			return;
		}
		// 只有 session_progress 且仍持有转录状态时才需要处理
		if (event.type !== "session_progress" || !this.#transcript) return;
		this.#transcript = applyTranscriptProgress(this.#transcript, event.progress);
		this.#notify();
	}

	#notify(): void {
		const state = this.state;
		for (const listener of this.#listeners) this.#callListener(listener, state);
	}

	/** 调用单个监听器并兜底捕获其异常，交给 onListenerError 上报。 */
	#callListener(listener: (state: RemoteSessionState) => void, state: RemoteSessionState): void {
		try {
			listener(state);
		} catch (error) {
			this.#reportListenerError(error);
		}
	}

	#reportListenerError(error: unknown): void {
		if (!this.#onListenerError) return;
		try {
			this.#onListenerError(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// 诊断回调自身的异常必须被吞掉：不能反过来影响会话或传输层状态。
		}
	}

	#clearSubscriptions(): void {
		this.#unsubscribeSnapshot?.();
		this.#unsubscribeEvents?.();
		this.#unsubscribeSnapshot = undefined;
		this.#unsubscribeEvents = undefined;
	}

	#requireHandle(): SessionLease {
		if (!this.#handle) throw new Error("No remote session is attached");
		return this.#handle;
	}

	/** 断言未销毁且不在 busy（大多数公开操作的入口校验）。 */
	#assertAvailable(): void {
		this.#assertNotDisposed();
		if (this.#lifecycle.status === "busy") {
			throw new Error(`Remote session is busy with ${this.#lifecycle.operation}`);
		}
	}

	/** 断言未销毁；dispose 之后一切操作（含抢占式 abort）都非法。 */
	#assertNotDisposed(): void {
		if (this.disposed) throw new Error("Remote session is disposed");
	}

	/**
	 * await 之后的 dispose 竞态检查：若期间实例已销毁，释放刚拿到的新租约
	 * 并抛出 RemoteSessionDisposedError（该错误在 dispose 收尾时被过滤）。
	 */
	async #assertNotDisposedAfterAwait(handle: SessionLease): Promise<void> {
		if (!this.disposed) return;
		await this.#detach(handle);
		throw new RemoteSessionDisposedError();
	}

	async #detach(handle: SessionLease): Promise<void> {
		await handle.dispose();
	}
}
