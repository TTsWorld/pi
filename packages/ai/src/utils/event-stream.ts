/**
 * @file 通用异步事件流原语
 * @description EventStream 是整个包的核心流式基础设施：生产端通过 push()/end()
 * 写入事件，消费端既能以 for await-of 逐个消费事件，又能通过 await result()
 * 获取最终的聚合结果 R，两种消费方式互不干扰（双消费模型）。
 * AssistantMessageEventStream 是它在「助手消息」场景下的具体化：
 * 事件类型为 AssistantMessageEvent，最终结果为 AssistantMessage，
 * 即 types.ts 中各 provider API 适配器统一返回的流类型。
 */
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/**
 * 支持异步迭代（AsyncIterable）与最终结果双消费的通用事件流。
 *
 * 核心数据结构：
 * - queue：暂存尚无消费者认领的事件（生产快于消费时的缓冲队列）
 * - waiting：挂起等待下一个事件的消费者回调（消费快于生产时的等待队列）
 * - finalResultPromise：由完成事件或 end(result) 触发解决的最终结果 Promise
 *
 * @typeParam T 流中事件的类型
 * @typeParam R 最终聚合结果的类型（默认与 T 相同）
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	// 待消费的事件缓冲队列：无消费者认领时先入队，迭代器优先排空它
	private queue: T[] = [];
	// 挂起中的消费者回调：调用 resolve 即唤醒一个等待 for await 的消费者
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	// 流是否已终结（收到完成事件或调用过 end）
	private done = false;
	// 最终结果的 Promise，暴露给 result()
	private finalResultPromise: Promise<R>;
	// finalResultPromise 的 resolve 句柄，保存下来以便完成时调用
	private resolveFinalResult!: (result: R) => void;
	// 判断某事件是否为本流的「完成事件」
	private isComplete: (event: T) => boolean;
	// 从完成事件中提取最终结果 R
	private extractResult: (event: T) => R;

	/**
	 * @param isComplete 判断传入事件是否为完成事件（收到后流即终结）
	 * @param extractResult 从完成事件中提取最终结果（供 result() 解决 Promise）
	 */
	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	/**
	 * 写入一个事件。
	 * 若该事件是完成事件，同时终结流并解决最终结果；完成事件本身仍会投递给消费者。
	 * @param event 要写入的事件
	 */
	push(event: T): void {
		// 流已终结：忽略后续事件，保证终结后不再泄漏新事件
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			// 完成事件到达：立即解决最终结果，等待 result() 的一方无需消费完事件流
			this.resolveFinalResult(this.extractResult(event));
		}

		// 优先直接投递给已在等待的消费者，否则入队缓冲
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * 主动终结流（未收到完成事件时的兜底，如上游异常中断）。
	 * @param result 可选的最终结果；省略时若最终结果尚未解决，result() 的 Promise 将保持 pending
	 */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// 唤醒所有等待中的消费者，以 done: true 通知流已结束
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as any, done: true });
		}
	}

	/**
	 * 异步迭代器：先排空缓冲队列，队列为空且已终结时结束迭代，
	 * 否则挂起等待 push()/end() 唤醒。
	 */
	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				// 缓冲区有积压事件：直接取出，无需挂起
				yield this.queue.shift()!;
			} else if (this.done) {
				// 已终结且无积压：正常结束迭代
				return;
			} else {
				// 无事件且未终结：把 resolve 回调挂到 waiting 上等待唤醒
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/**
	 * 获取流的最终聚合结果。
	 * 与 for await 消费互不干扰：即使事件尚未被迭代消费，也可以先 await 此结果。
	 * @returns 最终结果的 Promise（完成事件到达或 end(result) 调用后解决）
	 */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/**
 * 助手消息事件流：EventStream 在消息场景下的具体化。
 * 完成事件为 type 为 "done"（正常完成）或 "error"（出错）的事件；
 * 最终结果即完整的 AssistantMessage，或错误事件携带的 error。
 * 注意：错误也是通过 resolve（而非 reject）交付给 result() 的，
 * 调用方拿到结果后需自行区分消息与错误。
 */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
		);
	}
}

/** AssistantMessageEventStream 的工厂函数（供扩展使用） */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
