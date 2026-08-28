/**
 * @file model-catalog-refresh.ts —— 模型目录刷新的并发去重协调器
 *
 * @description
 * 交互模式下可能同时出现多处「刷新全部模型目录」的请求（如 /model 选择器
 * 反复打开）。本模块用单例协调器按 ModelRuntime 实例去重：同一 runtime
 * 只发起一次底层刷新，多个调用方共享同一个 Promise；同时每个调用方的
 * AbortSignal 相互独立——任一调用方取消只影响自己，最后一个调用方离开时
 * 才真正中止底层请求。
 */

import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";

/** 协调器依赖的最小接口：只用到 ModelRuntime 的 refresh（便于测试打桩） */
type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

/** 某个 runtime 当前进行中的那次刷新（被多个调用方共享） */
interface ActiveModelCatalogRefresh {
	/** 底层刷新实际使用的取消控制器：最后一个等待者离开时被 abort */
	controller: AbortController;
	/** 已用 raceWithAbortSignal 包装的底层刷新结果；waiters 归零后随之被中止 */
	promise: Promise<ModelsRefreshResult>;
	/** 共享本次刷新的调用方数量，归零即触发底层请求中止 */
	waiters: number;
}

/**
 * 按 runtime 去重的刷新协调器：同一时刻每个 ModelRuntime 至多一条进行中的
 * 刷新请求；用 WeakMap 弱引用追踪，runtime 被回收时条目随之释放。
 */
class ModelCatalogRefreshCoordinator {
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>();

	/**
	 * 刷新指定 runtime 的模型目录；已有进行中的刷新则复用其结果。
	 * @param signal 调用方自己的取消信号：只中止本次返回的 Promise，不影响共享的底层请求
	 */
	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		signal.throwIfAborted();
		let active = this.activeByRuntime.get(modelRuntime);
		if (!active) {
			// 该 runtime 尚无进行中的刷新：新建 controller 发起底层请求（由协调器持有，供最后一个等待者离开时中止）
			const controller = new AbortController();
			// 先声明后赋值：下面的 finally 回调需引用 created，而它要到下方才初始化
			let created!: ActiveModelCatalogRefresh;
			const operation = modelRuntime.refresh({ signal: controller.signal });
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				if (this.activeByRuntime.get(modelRuntime) === created) {
					this.activeByRuntime.delete(modelRuntime);
				}
			});
			created = { controller, promise, waiters: 0 };
			active = created;
			this.activeByRuntime.set(modelRuntime, active);
		}

		active.waiters++;
		return raceWithAbortSignal(active.promise, signal).finally(() => {
			active.waiters--;
			// 最后一个等待者离开才真正 abort 底层请求；引用比较防止误杀新一轮刷新
			if (active.waiters === 0 && this.activeByRuntime.get(modelRuntime) === active) {
				active.controller.abort();
			}
		});
	}
}

// 模块级单例：进程内所有调用方共享同一个协调器，跨视图去重才能生效
const modelCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator();

/**
 * 共享并发的交互式全量模型目录刷新，同时保持每个调用方的取消相互独立。
 */
export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	return modelCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}
