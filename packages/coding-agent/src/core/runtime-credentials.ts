/**
 * @file runtime-credentials.ts —— 运行时 API Key 凭据覆盖层
 *
 * @description
 * 在持久化凭据存储之上叠加一层仅存内存的 API Key 覆盖
 * （如命令行临时传入的 key），不落盘、进程退出即失效。
 */
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/**
 * 异步凭据存储的覆盖层实现：读取时优先返回运行时（非持久化）API Key，
 * 其余操作透传给底层存储。
 */
export class RuntimeCredentials implements CredentialStore {
	/** 底层持久化凭据存储 */
	private readonly store: CredentialStore;
	/** providerId → 运行时 API Key（仅存内存） */
	private readonly overrides = new Map<string, string>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	/** 设置某 provider 的运行时 API Key */
	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	/** 移除某 provider 的运行时 API Key（不影响底层存储） */
	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	/** 是否存在某 provider 的运行时 API Key */
	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	/** 读取凭据：命中运行时覆盖则包装成 api_key 凭据返回，否则读底层存储 */
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	/** 列出凭据：在底层列表之上，用运行时 key 的条目覆盖同 provider 项 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	/** 原子修改凭据：直接透传底层存储（运行时 key 不参与修改流程） */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.store.modify(providerId, fn, options);
	}

	/** 删除凭据：先删底层存储，再清掉运行时覆盖 */
	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
