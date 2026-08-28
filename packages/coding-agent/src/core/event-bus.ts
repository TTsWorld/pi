/**
 * @file event-bus.ts —— 轻量事件总线
 *
 * @description
 * 基于 EventEmitter 的进程内发布/订阅总线：按 channel 名分发事件，
 * 订阅返回取消函数；处理器抛错会被捕获并打印，不影响其他订阅者。
 */
import { EventEmitter } from "node:events";

/** 事件总线的订阅侧接口 */
export interface EventBus {
	/** 向指定 channel 发出事件 */
	emit(channel: string, data: unknown): void;
	/** 订阅 channel，返回取消订阅函数 */
	on(channel: string, handler: (data: unknown) => void): () => void;
}

/** 事件总线的控制侧接口：额外支持清空全部订阅 */
export interface EventBusController extends EventBus {
	clear(): void;
}

/** 创建一个事件总线实例 */
export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			// 包装处理器：吞掉异常，避免单个订阅者搞崩事件分发
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		// 清空所有订阅（多用于会话重置或测试）
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
