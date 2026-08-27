/**
 * @file 内存版凭据存储（auth/credential-store.ts）
 * @description
 * CredentialStore 的默认内存实现：以 provider id 为键、每 provider
 * 一条凭据；modify / delete 等写操作经 per-provider 的 promise 链
 * 串行化，保证 read-modify-write 互斥。应用应注入持久化实现替换本类。
 */
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "./types.ts";

/**
 * 默认内存凭据存储。应用注入持久化存储。
 * 以 `Provider.id` 为键、每 provider 一条凭据；见 `CredentialStore`。
 * 写操作按 provider 经 promise 链串行化。
 */
export class InMemoryCredentialStore implements CredentialStore {
	/** provider id -> 已存储凭据 */
	private credentials = new Map<string, Credential>();
	/** provider id -> 写操作队列的队尾 promise（吞错后），用于串行化 */
	private chains = new Map<string, Promise<unknown>>();

	/** 按 provider id 串行化任务；活动任务 settle 前不释放（清理）链条。 */
	private enqueue<T>(providerId: string, task: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
		const signal = operationSignal(options?.signal);
		// 取当前队尾作为前置依赖；队列空时用已完成的 promise 立即执行
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			// 吞掉前置任务的失败：只继承执行顺序，不继承错误
			await previous.catch(() => {});
			signal.throwIfAborted();
			return task();
		})();
		// 队尾必须是吞错后的 promise，避免链上残留 rejected promise 触发 unhandled rejection
		const tail = queued.catch(() => {});
		this.chains.set(providerId, tail);
		// 任务结束后清理链条，避免 Map 无限增长；
		// 引用比较确保只清理「自己仍是队尾」的情形，不误删后来排入的任务
		void tail.then(() => {
			if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
		});
		// 真实结果/错误仍传回调用方；abort 竞速交给 raceWithAbortSignal 处理
		return raceWithAbortSignal(queued, signal);
	}

	/** 读取凭据；条目缺失时返回 undefined。 */
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return this.credentials.get(providerId);
	}

	/** 列出凭据元数据（provider id + 类型），不暴露机密。 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return [...this.credentials].map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	/**
	 * 串行化写入（唯一写路径）：读取当前凭据交给 `fn`，`fn` 返回
	 * undefined 表示保持条目不变，否则写入新凭据；最终返回写入后的凭据。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(
			providerId,
			async () => {
				const current = this.credentials.get(providerId);
				const next = await fn(current);
				options?.signal?.throwIfAborted();
				// fn 返回 undefined = 保持条目不变
				if (next !== undefined) this.credentials.set(providerId, next);
				return next ?? current;
			},
			options,
		);
	}

	/** 移除凭据（登出）；与 modify 同链串行化。 */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.enqueue(
			providerId,
			async () => {
				this.credentials.delete(providerId);
			},
			options,
		);
	}
}
