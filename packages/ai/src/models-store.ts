/**
 * @file 动态 provider 模型目录的持久化接口（models-store）。
 *
 * @description 与构建期生成的静态目录（*.models.ts）相对，某些 provider 的模型
 * 列表需要运行时从远端拉取。本文件定义这份「动态目录」的持久化抽象
 * ModelsStore（按 provider ID 存取目录快照，附带 ETag / Last-Modified 等
 * 新鲜度信息，用于条件请求避免重复下载），并提供一个进程内的默认实现
 * InMemoryModelsStore。文件系统等其他实现可由使用方自行提供。
 */

import type { Api, Model } from "./types.ts";

/**
 * 单个 provider 的目录快照：模型列表 + 远端新鲜度元数据。
 * lastModified / checkedAt / etag 三者配合实现「过期才重新拉取」的策略。
 */
export interface ModelsStoreEntry {
	/** 该 provider 当前已知的模型列表。 */
	models: readonly Model<Api>[];
	/** 远端目录 Last-Modified 响应头对应的 Unix 时间戳。 */
	lastModified?: number;
	/** 上一次成功完成远端检查的时刻（Unix 时间戳）。 */
	checkedAt?: number;
	/**
	 * 远端目录 ETag 响应头中的不透明校验值。
	 * 原样存储（含引号），下次请求时原样作为 If-None-Match 回传，
	 * 远端未变化即可返回 304、省去完整下载。
	 */
	etag?: string;
}

/** 所有 store 操作通用的可选项。 */
export interface ModelsStoreOperationOptions {
	/** 中止信号：触发后进行中的操作应抛出 AbortError。 */
	signal?: AbortSignal;
}

/** 按 provider ID 键的持久化模型目录存储。 */
export interface ModelsStore {
	/**
	 * 读取某个 provider 的目录快照。
	 *
	 * @param providerId provider ID
	 * @param options 可选操作项（如 AbortSignal）
	 * @returns 目录条目；该 provider 从未写入过则返回 undefined
	 */
	read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined>;
	/**
	 * 写入（整体替换）某个 provider 的目录快照。
	 *
	 * @param providerId provider ID
	 * @param entry 要持久化的目录条目
	 * @param options 可选操作项（如 AbortSignal）
	 */
	write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void>;
	/**
	 * 删除某个 provider 的目录快照（不存在时静默成功）。
	 *
	 * @param providerId provider ID
	 * @param options 可选操作项（如 AbortSignal）
	 */
	delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void>;
}

/**
 * ModelsStore 的进程内实现：用 Map 保存目录条目，进程结束即丢失。
 * 适合测试，或作为真正持久化实现（如写入磁盘/配置目录）之前的默认值。
 */
export class InMemoryModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();

	async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
		// 虽是同步内存操作，仍统一走 Promise 签名并响应中止信号，
		// 保证与其他（可能真正异步的）实现行为一致
		options?.signal?.throwIfAborted();
		const entry = this.entries.get(providerId);
		// structuredClone 做防御性深拷贝：避免调用方修改返回值污染 store 内部状态
		return entry ? structuredClone(entry) : undefined;
	}

	async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		// 同样深拷贝入参，切断与调用方持有对象之间的引用共享
		this.entries.set(providerId, structuredClone(entry));
	}

	async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		this.entries.delete(providerId);
	}
}
