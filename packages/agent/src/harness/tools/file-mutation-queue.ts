/**
 * 文件变更串行队列。
 *
 * 按 canonical path 对同一环境内的文件变更排队，保证同一文件的写入串行执行，
 * 避免并发的 write/edit 工具调用相互覆盖或读到中间状态。
 */

import type { ExecutionEnv } from "../types.ts";
import { getOrThrow } from "../types.ts";

/** 每个 ExecutionEnv 独立维护的队列状态。 */
type MutationQueueState = {
	/** canonical path -> 该文件变更链当前的队尾 Promise。 */
	queues: Map<string, Promise<void>>;
	/** 注册链：串行化「计算 key + 接入队列」阶段，避免并发注册交错。 */
	registration: Promise<void>;
};

// 按 ExecutionEnv 隔离状态；用 WeakMap 避免强引用环境对象、妨碍其被 GC。
const states = new WeakMap<ExecutionEnv, MutationQueueState>();

// 懒创建并返回指定环境的队列状态。
function getState(env: ExecutionEnv): MutationQueueState {
	let state = states.get(env);
	if (!state) {
		state = { queues: new Map(), registration: Promise.resolve() };
		states.set(env, state);
	}
	return state;
}

/**
 * 计算文件变更的队列 key：先转为绝对路径，再做 canonical 化（解析符号链接等），
 * 让同一文件的不同写法收敛到同一队列；文件尚不存在（not_found）或环境不支持
 * canonical 化（not_supported）时退回绝对路径。
 */
async function getMutationQueueKey(env: ExecutionEnv, path: string): Promise<string> {
	const absolutePath = getOrThrow(await env.absolutePath(path));
	const canonicalPath = await env.canonicalPath(absolutePath);
	if (canonicalPath.ok) return canonicalPath.value;
	if (canonicalPath.error.code === "not_found" || canonicalPath.error.code === "not_supported") return absolutePath;
	throw canonicalPath.error;
}

/**
 * 串行执行文件变更：同一环境下指向同一 canonical path 的变更按到达顺序排队运行。
 * fn 的返回值原样透传。
 */
export async function withFileMutationQueue<T>(env: ExecutionEnv, path: string, fn: () => Promise<T>): Promise<T> {
	const state = getState(env);
	// 注册阶段本身也串行化：计算 key 并把本次变更接入对应文件的队列尾部，
	// 防止并发调用同时读到同一个队尾而丢失一次排队。
	const registration = state.registration.then(async () => {
		const key = await getMutationQueueKey(env, path);
		const currentQueue = state.queues.get(key) ?? Promise.resolve();

		let releaseNext = () => {};
		const nextQueue = new Promise<void>((resolve) => {
			releaseNext = resolve;
		});
		// 新队尾 = 前序队列完成后，再等待本次变更显式放行（releaseNext）。
		const chainedQueue = currentQueue.then(() => nextQueue);
		state.queues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	// 注册链吞掉异常：单次注册失败不应阻断后续注册。
	state.registration = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	// 等待该文件之前的变更全部完成。
	await currentQueue;
	try {
		return await fn();
	} finally {
		// 无论成败都放行链上的下一个变更；仅当本链仍是队尾时才清理 Map 条目，避免泄漏。
		releaseNext();
		if (state.queues.get(key) === chainedQueue) state.queues.delete(key);
	}
}
