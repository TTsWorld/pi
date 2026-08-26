/**
 * @file 宿主（harness）级事件总线：run_start / run_end 事件与 watch 快照订阅。
 * @description 区别于 Agent 层的 AgentEvent 消息流，这里只发布宿主粒度的事件——
 *   哪条 lane 上的哪次 run 开始或结束。HarnessEventBus 按 type 分发订阅；
 *   watch() 则提供"状态快照 + start() 前缓冲事件"的订阅模式，保证不丢事件且顺序一致。
 */

/** 一次 run 开始时发布的宿主事件。 */
export interface RunStartEvent {
	type: "run_start";
	/** 事件所属的 lane（运行车道）名称。 */
	lane: string;
	/** 本次 run 的唯一 ID。 */
	runId: string;
}

/** 一次 run 结束时发布的宿主事件。 */
export interface RunEndEvent {
	type: "run_end";
	/** 事件所属的 lane（运行车道）名称。 */
	lane: string;
	/** 本次 run 的唯一 ID。 */
	runId: string;
	/** 结局：completed=正常完成，aborted=被中止，failed=失败。 */
	outcome: "completed" | "aborted" | "failed";
	/** run 结束后 lane 所在的叶子条目 ID（会话树的当前末梢）。 */
	leafId: string;
}

/** 宿主事件联合类型。 */
export type HarnessEvent = RunStartEvent | RunEndEvent;
/** 所有宿主事件的 type 字面量联合。 */
export type HarnessEventType = HarnessEvent["type"];
/** 按 type 字面量提取对应的具体宿主事件类型。 */
export type HarnessEventOfType<TType extends HarnessEventType> = Extract<HarnessEvent, { type: TType }>;
/** 宿主事件监听器；可返回 Promise，但 emit() 不会等待其完成。 */
export type HarnessEventListener<TEvent extends HarnessEvent = HarnessEvent> = (event: TEvent) => void | Promise<void>;

/** 事件订阅的最小接口，由 {@link HarnessEventBus} 实现。 */
export interface Events {
	/**
	 * 注册被动监听器以接收未来的事件，并返回其取消订阅函数。
	 * 更早的事件不会重放，也不提供当前状态快照；若两者都需要，请改用 lane 或 session 级的 watch。
	 */
	on<TType extends HarnessEventType>(
		type: TType,
		listener: HarnessEventListener<HarnessEventOfType<TType>>,
	): () => void;
}

/**
 * watch 订阅返回的句柄：携带订阅时刻的状态快照，并在 start() 之前缓冲事件。
 * @template TSnapshot 快照类型（如 LaneSnapshot、SessionSnapshot）。
 */
export interface WatchHandle<TSnapshot> {
	/** 订阅时捕获的状态快照，与随后投递的事件流首尾衔接、互不重叠。 */
	snapshot: TSnapshot;
	/** 开始投递：先按序 flush 已缓冲的事件，再持续接收后续事件。 */
	start(listener: HarnessEventListener): void;
	/** 取消订阅，并丢弃尚未投递的缓冲事件。 */
	unsubscribe(): void;
}

/** 宿主事件总线的同步实现：on() 按 type 分发订阅，watch() 提供快照 + 缓冲式订阅。 */
export class HarnessEventBus implements Events {
	/** 按事件类型分组的 on() 订阅（值为包装后的通用监听器集合）。 */
	private readonly listeners = new Map<HarnessEventType, Set<HarnessEventListener>>();
	/** 所有 watch 订阅的统一入口；缓冲逻辑由各 watch 自己的闭包处理。 */
	private readonly watchListeners = new Set<(event: HarnessEvent) => void>();

	/**
	 * 为某一类型的未来事件注册监听器，并返回其取消订阅函数。
	 * 更早的事件不会重放，也不提供快照或事件缓冲。
	 */
	on<TType extends HarnessEventType>(
		type: TType,
		listener: HarnessEventListener<HarnessEventOfType<TType>>,
	): () => void {
		// 复用该事件类型已有的监听器集合，否则为其创建第一个。
		const listeners = this.listeners.get(type) ?? new Set<HarnessEventListener>();
		this.listeners.set(type, listeners);

		// 把针对特定事件类型的回调包装成通用的 HarnessEvent 监听器，
		// 并保留该包装函数的引用，取消订阅时才能从集合中精确移除它。
		const receive: HarnessEventListener = (event) => {
			if (event.type === type) return listener(event as HarnessEventOfType<TType>);
		};
		listeners.add(receive);
		return () => {
			listeners.delete(receive);
			if (listeners.size === 0) this.listeners.delete(type);
		};
	}

	/** 将事件发布给当前的普通订阅（on）与 watch 订阅。 */
	emit(event: HarnessEvent): void {
		// 只投递给注册了该事件类型的直接监听器。
		// emit() 是同步的，因此不等待异步监听器（返回的 Promise）完成。
		for (const listener of this.listeners.get(event.type) ?? []) void listener(event);

		// 所有事件都投递给每个 watcher；start() 之前的缓冲由 watch() 自己处理。
		for (const listener of this.watchListeners) listener(event);
	}

	/**
	 * 注册一个 watch 订阅：立即捕获状态快照并开始缓冲事件，
	 * 直到调用返回句柄的 start() 后才向监听器投递，保证快照与事件序列不重叠且不丢事件。
	 * @param captureSnapshot 捕获状态快照的函数。在加入监听集合之后才调用：
	 *   采集快照期间新产生的事件会被缓冲，使快照与事件流无缝衔接。
	 * @returns 带 snapshot / start / unsubscribe 的 {@link WatchHandle}。
	 */
	watch<TSnapshot>(captureSnapshot: () => TSnapshot): WatchHandle<TSnapshot> {
		let listener: HarnessEventListener | undefined;
		let buffered: HarnessEvent[] = [];
		const receive = (event: HarnessEvent): void => {
			if (listener) void listener(event);
			else buffered.push(event);
		};
		this.watchListeners.add(receive);
		const snapshot = captureSnapshot();

		return {
			snapshot,
			start: (nextListener) => {
				// flush 期间保持缓冲模式（listener 尚未就位），重入的 emit 会进入新缓冲数组，从而保证事件顺序。
				while (buffered.length > 0) {
					const pending = buffered;
					buffered = [];
					for (const event of pending) void nextListener(event);
				}
				listener = nextListener;
			},
			unsubscribe: () => {
				this.watchListeners.delete(receive);
				buffered = [];
			},
		};
	}
}
