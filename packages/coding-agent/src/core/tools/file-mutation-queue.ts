/**
 * @file file-mutation-queue.ts
 *
 * @description 文件变更串行队列：保证对「同一个文件」的变更操作（edit/write 等）
 * 严格按注册顺序依次执行，避免并发编辑互相覆盖或读到半写状态；
 * 不同文件之间仍然并行，不损失吞吐。
 *
 * 依赖关系：被 edit/write 等内置工具在执行前调用（withFileMutationQueue）。
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

// 每个「真实路径」对应一条 Promise 链：链未走完即表示该文件还有变更在排队/执行中
const fileMutationQueues = new Map<string, Promise<void>>();
// 注册段本身的串行队列：保证「查询并挂到队列尾部」这一步是原子的（见下）
let registrationQueue = Promise.resolve();

/** 判断错误是否为「路径不存在」类（ENOENT/ENOTDIR），此时无法 realpath，退回普通路径作键 */
function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * 计算变更队列的键：优先取 realpath。
 * Why realpath：同一文件可能经符号链接、相对路径、`./` 前缀等多种写法被引用，
 * 只有规范化后的真实路径才能把它们归并到同一条队列上。
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			// 新建文件的场景：目标尚不存在，用 resolve 后的路径当键
			// （写入后后续操作会走 realpath 分支，两者天然一致）
			return resolvedPath;
		}
		throw error;
	}
}

/**
 * 串行化针对同一文件的变更操作；不同文件的变更仍并行执行。
 *
 * 工作原理（两段式）：
 * 1. 注册段（经 registrationQueue 串行）：解析队列键，把「占位 Promise」接到该文件
 *    队列尾部并写回 Map。串行注册是为了保证读-改-写 Map 的原子性，
 *    否则两个并发注册可能都读到同一条旧队列、各自成链，串行化即失效。
 * 2. 执行段：等前面的队列排空（await currentQueue）后运行 fn；
 *    finally 中 resolve 占位 Promise（放行下一个），并在自己仍是队尾时清理 Map 条目
 *    （条件删除防止误删后来者注册的新链）。
 *
 * @param filePath 变更目标文件路径（任意写法，内部会规范化）
 * @param fn 实际的变更操作
 * @returns fn 的返回值
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		// 占位 Promise：由本次操作在 finally 中 resolve，从而放行下一个排队者
		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	// 把注册段也串到全局注册队列上；两个回调都吞掉错误，避免注册失败污染整条链
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	// 等待同文件的前一个操作完成，再真正执行
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		// 仅当自己仍是队尾时才清理，避免删掉后续操作刚注册的新链
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
