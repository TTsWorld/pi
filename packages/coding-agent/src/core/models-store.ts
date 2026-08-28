/**
 * @file models-store.ts —— 模型目录持久化存储
 *
 * @description
 * 提供 ModelsStore 接口的两种实现：纯内存版（InMemoryCodingAgentModelsStore）与
 * JSON 文件版（FileModelsStore）。文件版基于带文件锁的 AuthStorageBackend 读写
 * `~/.pi/models-store.json`，并通过「文件 revision + 单飞（in-flight）reload 合并）」
 * 缓存机制避免重复读盘，用于保存动态刷新的供应商模型目录。
 */
import { join } from "node:path";
import type { ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "./auth-storage.ts";

/** 存储文件的整体结构：供应商 ID → 目录条目。 */
type StoredModels = Record<string, ModelsStoreEntry>;

/** 一次进行中的重载任务：控制器、Promise 与当前等待该任务的读请求数。 */
type ModelsFileReload = {
	controller: AbortController;
	promise: Promise<StoredModels>;
	readers: number;
};

/** 某个存储文件的读缓存状态：已解析数据、对应文件 revision 及进行中的重载任务。 */
type ModelsFileReadState = {
	data: StoredModels;
	revision?: string;
	reload?: ModelsFileReload;
};

// 优化常见路径的共享缓存，同时避免为任意多的自定义路径无限保留状态。
let sharedModelsFileReadState: { path: string; readState: ModelsFileReadState } | undefined;

/**
 * 纯内存实现的 ModelsStore：读写只作用于进程内的 Map，不落盘。
 * 适合测试或显式不需要持久化的场景；所有读出的条目都经 structuredClone 深拷贝，防止外部修改污染内部状态。
 */
export class InMemoryCodingAgentModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}

/**
 * 基于 JSON 文件（带锁）的 ModelsStore，用于持久化动态刷新的供应商模型目录。
 *
 * 读取走 revision 缓存：文件 mtime+size 未变化时直接命中内存数据；
 * 变化时并发读请求会合并到同一次重载任务（single-flight），全部写操作在
 * 文件锁保护下进行 read-modify-write，避免并发写相互覆盖。
 */
export class FileModelsStore implements ModelsStore {
	private readonly storage: AuthStorageBackend;
	private readonly path: string;
	private readonly readState: ModelsFileReadState;

	/**
	 * @param path - 存储文件路径，默认 `~/.pi/models-store.json`
	 */
	constructor(path: string = join(getAgentDir(), "models-store.json")) {
		this.path = normalizePath(path);
		this.storage = new FileAuthStorageBackend(this.path);
		// 同一路径复用全局共享的读缓存（默认路径常见，自定义路径则各自独立）
		this.readState =
			sharedModelsFileReadState?.path === this.path ? sharedModelsFileReadState.readState : { data: {} };
		if (!sharedModelsFileReadState) {
			sharedModelsFileReadState = { path: this.path, readState: this.readState };
		}
	}

	/** 解析文件内容（容忍 BOM），空内容视为空对象。 */
	private parse(content: string | undefined): StoredModels {
		return content ? (JSON.parse(stripBom(content)) as StoredModels) : {};
	}

	private updateReadState(readState: ModelsFileReadState, data: StoredModels, revision?: string): void {
		readState.data = data;
		readState.revision = revision;
	}

	private reloadFromStorage(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		return this.storage.withLockAsync(async (content) => {
			const data = this.parse(content);
			this.updateReadState(readState, data, getFileRevision(this.path));
			return { result: data };
		}, options);
	}

	/**
	 * 读取该存储文件的最新数据：
	 * 1. 先比对文件 revision（mtime+size），未变化则直接返回缓存；
	 * 2. 已有进行中的重载任务时直接搭车（single-flight 合并并发读）；
	 * 3. 否则在文件锁保护下重新读取并更新缓存。
	 * 等待期间支持 abort；最后一个读者离开时中止底层重载任务。
	 */
	private async readLatest(
		readState: ModelsFileReadState,
		options?: ModelsStoreOperationOptions,
	): Promise<StoredModels> {
		options?.signal?.throwIfAborted();
		const revision = getFileRevision(this.path);
		// revision 未变化：命中缓存，无需读盘
		if (revision !== undefined && revision === readState.revision) return readState.data;
		// 尚无进行中的重载任务：创建一个，成功/失败后都自动清理
		if (!readState.reload) {
			const controller = new AbortController();
			const reload: ModelsFileReload = {
				controller,
				promise: this.reloadFromStorage(readState, { signal: controller.signal }),
				readers: 0,
			};
			readState.reload = reload;
			void reload.promise.then(
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
				() => {
					if (readState.reload === reload) readState.reload = undefined;
				},
			);
		}

		// 搭车当前的重载任务，并登记为一名读者
		const reload = readState.reload;
		reload.readers++;
		try {
			return await raceWithAbortSignal(reload.promise, options?.signal);
		} finally {
			reload.readers--;
			// 最后一名读者离开且任务仍是当前任务时：清空引用并中止底层读取
			if (reload.readers === 0 && readState.reload === reload) {
				readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	/** 读取指定供应商的目录条目（深拷贝），不存在时返回 undefined。 */
	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		const entry = (await this.readLatest(this.readState, options))[providerId];
		options?.signal?.throwIfAborted();
		return entry ? structuredClone(entry) : undefined;
	}

	/** 在文件锁内做 read-modify-write 写入条目，并同步更新读缓存。 */
	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			current[providerId] = structuredClone(entry);
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		if (latest) this.updateReadState(this.readState, latest);
	}

	/** 在文件锁内做 read-modify-write 删除条目，并同步更新读缓存。 */
	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		let latest: StoredModels | undefined;
		await this.storage.withLockAsync(async (content) => {
			const current = this.parse(content);
			delete current[providerId];
			latest = current;
			return { result: undefined, next: JSON.stringify(current, null, 2) };
		}, options);
		if (latest) this.updateReadState(this.readState, latest);
	}
}
