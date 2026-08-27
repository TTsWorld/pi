/**
 * @file abort 信号组合：把多个可选的 AbortSignal 合并为一个信号，
 * 任一来源中止即触发合成信号，并透传首个触发来源的中止原因。
 * 用于「调用方取消 + 请求超时」等多来源取消的汇合场景。
 */

/** combineAbortSignals 的返回结构。 */
export interface CombinedAbortSignal {
	/** 合成后的 AbortSignal；没有任何可组合信号时为 undefined（表示永不中止） */
	signal?: AbortSignal;
	/** 使用完毕后必须调用：摘除挂在各来源信号上的 abort 监听，防止泄漏 */
	cleanup: () => void;
}

/**
 * 将多个可选的 AbortSignal 组合为一个：任一信号中止即触发合成信号，并透传该来源的 reason。
 *
 * 零开销优化：没有活跃信号时不返回 signal；只有 1 个信号时直接复用原信号，不额外挂监听。
 *
 * @param signals - 待组合的信号列表，其中的 undefined 元素会被过滤掉
 * @returns 组合结果；无活跃信号时 signal 为 undefined，cleanup 需在操作结束后调用
 */
export function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
	const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
	if (activeSignals.length === 0) {
		return { cleanup: () => {} };
	}
	if (activeSignals.length === 1) {
		return { signal: activeSignals[0], cleanup: () => {} };
	}

	const controller = new AbortController();
	const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
	const abort = (signal: AbortSignal) => {
		// 只响应第一个中止的来源，并把它的 reason 透传给合成信号
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};

	for (const signal of activeSignals) {
		// 接线阶段就发现已中止：立即触发合成信号，并停止注册其余监听
		if (signal.aborted) {
			abort(signal);
			break;
		}
		const listener = () => abort(signal);
		signal.addEventListener("abort", listener, { once: true });
		listeners.push({ signal, listener });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			// 逐一摘除挂到各来源信号上的监听
			for (const { signal, listener } of listeners) {
				signal.removeEventListener("abort", listener);
			}
		},
	};
}
