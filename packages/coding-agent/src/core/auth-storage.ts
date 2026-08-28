/**
 * @file auth-storage.ts —— 基于 auth.json 的认证凭据持久化存储
 *
 * @description
 * 实现 pi-ai 的 CredentialStore 接口，负责各 provider 凭据（API key / OAuth token）
 * 的读取、修改与删除，落盘到 agent 目录下的 auth.json（路径可注入以便测试）。
 *
 * 主要组成部分：
 * - AuthStorageBackend：读写 + 文件锁抽象（同步 / 异步两个入口）；
 * - FileAuthStorageBackend：生产实现，基于 proper-lockfile 对 auth.json 加锁，
 *   以 0o600 权限写文件，保证多进程并发下的安全读改写；
 * - InMemoryAuthStorageBackend：内存实现，供测试与一次性场景使用；
 * - ReadOnlyAuthStorage / AuthStorage：面向使用方的 CredentialStore 实现，
 *   前者只读且严格校验文件结构，后者支持修改 / 删除并维护跨实例共享的读缓存；
 * - readStoredCredential：不实例化 store 的一次性同步读取工具函数。
 *
 * Provider 鉴权编排（何时刷新 OAuth 等）属于 ModelRuntime 与 pi-ai Models 的职责，
 * 本文件只负责「安全地存取凭据」。
 */

import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "timers/promises";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "../utils/abort.ts";
import { getFileRevision, normalizePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.ts";

/** auth.json 的内存表示：providerId → 凭据 的纯映射。 */
type AuthStorageData = Record<string, Credential>;

/**
 * withLock 回调的返回结构：result 为业务计算结果；
 * next 为要写回文件的新内容（undefined 表示本次不写盘）。
 */
type LockResult<T> = {
	result: T;
	next?: string;
};

// mode 只在文件创建时生效，已存在文件不改动——保留管理员设置的权限与 ACL。
const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

/** 一次进行中的异步重载：readers 记录并发读者数，controller 供最后一个读者离开时取消。 */
type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

/** 文件读缓存状态：最近一次解析的数据、对应文件修订号、以及进行中的重载任务。 */
type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: AuthFileReload;
};

// 同一路径（auth.json）的读缓存在进程内所有 AuthStorage 实例间共享，
// 避免多个实例各自重读文件、revision 判断相互失效。
let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

/**
 * 存储后端抽象：在独占锁保护下执行「读当前内容 → 计算 → 写回」的临界区操作。
 *
 * fn 收到文件当前字符串内容，返回 { result, next }；next 非 undefined 时写回。
 * 同步（withLock）与异步（withLockAsync）两个入口分别服务不同的调用方。
 */
export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T>;
}

/**
 * 基于文件 + proper-lockfile 的生产存储后端。
 *
 * 每次操作都遵循：确保目录/文件存在 → 加锁 → 读 → 计算 → 写回 → 解锁；
 * 写入统一使用 0o600 权限（仅创建时生效），目录以 0o700 递归创建，
 * 确保凭据文件仅当前用户可读。
 */
export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	/** 默认落在 agent 目录下的 auth.json；路径可注入用于测试。 */
	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	/** 确保父目录存在（递归创建，权限 0o700，仅创建时生效）。 */
	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	/** 文件不存在时初始化为空对象 "{}"，让后续锁 / 读写逻辑无需处理 ENOENT。 */
	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
		}
	}

	/**
	 * 同步加锁并自带重试：锁被占用（ELOCKED）时最多尝试 10 次、每次自旋等待 20ms；
	 * 其余错误或重试耗尽则抛出。成功返回解锁函数。
	 */
	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// 同步自旋等待（忙等）：避免把同步调用方改成异步。
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	/**
	 * 同步版临界区操作：加锁 → 读文件 → fn 计算 → next 写回 → 解锁。
	 * 解锁放在 finally 中，异常路径也保证锁被释放。
	 */
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	/**
	 * 异步加锁：锁被占用（ELOCKED）时按指数退避重试——基数 10ms、每次翻倍、
	 * 上限 1s，并附加 0~100% 随机抖动避免多进程同步重试；总等待不超过 30s
	 * （与锁的 stale 时长一致）。全程响应 AbortSignal；拿到锁后发现已 abort
	 * 则先释放再抛出，避免留下孤儿锁。
	 */
	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		// stale=30s：持有者超过该时长未更新锁即视为已死，允许被抢占
		const staleMs = 30_000;
		const maxDelayMs = 2_000;
		const deadline = Date.now() + staleMs;
		let retry = 0;
		while (true) {
			signal?.throwIfAborted();
			let release: (() => Promise<void>) | undefined;
			try {
				release = await lockfile.lock(this.authPath, {
					realpath: false,
					retries: 0,
					stale: staleMs,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				const remainingMs = deadline - Date.now();
				if (code !== "ELOCKED" || remainingMs <= 0) throw error;
				// 退避延迟 = min(10*2^retry, 1s) * (1 + 随机抖动)，再截断到剩余期限
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				if (signal) await sleep(delayMs, undefined, { signal });
				else await sleep(delayMs);
				continue;
			}
			// 竞态兜底：等待锁期间被 abort，拿到锁后立即释放再抛出
			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}
			return release;
		}
	}

	/**
	 * 异步版临界区操作。与同步版的差异在于全程感知 AbortSignal 与锁被抢占
	 * （onCompromised 回调置位标记）：在读取、fn 计算、写盘各环节前后都检查，
	 * 一旦锁失效或被 abort 立即抛错，绝不基于失效的临界区继续写文件。
	 */
	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		// 锁被抢占后由后续各检查点统一抛错（带上 onCompromised 给出的原始错误）
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// 锁已失效时解锁报错可以忽略：锁本身已不可信。
				}
			}
		}
	}
}

/**
 * 只读凭据存储：一次性读取 auth.json 并做严格结构校验，之后全部走内存缓存。
 *
 * 适用于不希望 / 不需要写凭据的调用方（如受限子进程）；
 * modify / delete 一律抛错。api_key 凭据中的 `${VAR}` 引用会在 read 时解析。
 */
export class ReadOnlyAuthStorage implements CredentialStore {
	private readonly authPath: string;
	private data: AuthStorageData | undefined;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	/**
	 * 懒加载并校验 auth.json（结果缓存在 this.data，只解析一次）。
	 * 文件不存在视为空存储；JSON 损坏或凭据结构不合法则直接抛错。
	 */
	private load(): AuthStorageData {
		if (this.data) return this.data;

		let parsed: unknown;
		try {
			parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));
		} catch (error) {
			// 文件缺失按空存储处理；其余解析 / 读取错误包装后上抛
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				this.data = {};
				return this.data;
			}
			throw new Error(`Failed to read auth.json: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Invalid auth.json: expected an object");
		}
		// 逐 provider 校验凭据结构：api_key 要求 key 可选字符串、env 可选字符串映射；
		// oauth 要求 access/refresh 为字符串、expires 为有限数字
		for (const [providerId, credential] of Object.entries(parsed)) {
			if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
				throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
			}
			const value = credential as Record<string, unknown>;
			if (value.type === "api_key") {
				const validKey = value.key === undefined || typeof value.key === "string";
				const validEnv =
					value.env === undefined ||
					(typeof value.env === "object" &&
						value.env !== null &&
						!Array.isArray(value.env) &&
						Object.values(value.env).every((entry) => typeof entry === "string"));
				if (validKey && validEnv) continue;
			} else if (
				value.type === "oauth" &&
				typeof value.access === "string" &&
				typeof value.refresh === "string" &&
				typeof value.expires === "number" &&
				Number.isFinite(value.expires)
			) {
				continue;
			}
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}

		this.data = parsed as AuthStorageData;
		return this.data;
	}

	/** 读取单个 provider 凭据；api_key 的 `${VAR}` 引用按需解析，其余原样返回拷贝。 */
	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const credential = this.load()[providerId];
		options?.signal?.throwIfAborted();
		if (!credential) return undefined;
		// 非 api_key、无 key 或命令式取值：无法 / 无需在此解析，深拷贝返回防止调用方改到缓存
		if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
			return structuredClone(credential);
		}
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	/** 列出凭据元信息（providerId + type），不解析 key 值。 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const credentials = Object.entries(this.load()).map(([providerId, credential]) => ({
			providerId,
			type: credential.type,
		}));
		options?.signal?.throwIfAborted();
		return credentials;
	}

	/** 只读存储不允许修改：直接抛错。 */
	async modify(
		_providerId: string,
		_fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}

	/** 只读存储不允许删除：直接抛错。 */
	async delete(_providerId: string, _options?: AuthOperationOptions): Promise<void> {
		throw new Error("Read-only credential storage cannot modify auth.json");
	}
}

/**
 * 内存存储后端：value 即「文件内容」字符串。
 * 同步版本天然原子；异步版本通过 asyncChain 把所有操作串成单队列，
 * 提供与文件锁等价的互斥语义。
 */
export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
	): Promise<T> {
		// 把本次操作接到 asyncChain 末尾：所有异步操作串行执行，模拟互斥锁
		const previous = this.asyncChain;
		const operation = (async () => {
			// 吞掉前一个操作的错误，保证链条不断、后续操作仍能执行
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options?.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		})();
		// 链条自身吞错（不中断后续），对外返回可被 abort 竞速的 promise
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}

/**
 * 基于 JSON 文件（或注入后端）的凭据存储，实现 pi-ai 的 CredentialStore。
 *
 * 读路径带缓存：通过文件 revision（修订号）判断是否需要重读，同路径的实例
 * 共享读状态，进行中的重载会被并发读者复用（single-flight，避免重复读盘）；
 * 写路径（modify / delete）走后端锁，成功后同步更新读缓存。
 */
export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;

	private constructor(storage: AuthStorageBackend, authPath?: string) {
		this.storage = storage;
		this.authPath = authPath;
		// 同路径复用进程级共享读缓存；首个实例负责登记为共享状态
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath) {
			// revision 未变化则直接沿用缓存，否则重读一次
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	/** 基于文件后端创建（默认 agent 目录下的 auth.json）。 */
	static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath);
	}

	/** 以任意后端（如内存后端）组装 AuthStorage，不启用文件读缓存。 */
	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	/** 创建预置初始数据的内存存储，多用于测试。 */
	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/** 解析文件内容为数据对象（容忍 BOM）；空内容返回空对象。 */
	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(stripBom(content)) as AuthStorageData;
	}

	/** 更新（共享）读缓存的数据与对应 revision。 */
	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	/**
	 * 从存储同步重载凭据。失败时保留最后一次有效的内存快照（不抛错）。
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// 保留最后一次有效的内存快照。
		}
	}

	/** 异步重载：在锁内读取最新内容并更新读缓存，返回最新数据。 */
	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	/**
	 * 读取最新数据。无路径的后端（内存）每次都重载；文件后端先比对 revision，
	 * 未变化直接返回缓存；变化则发起或复用进行中的重载（single-flight：
	 * 并发读者共享同一次 Promise），最后一个读者离开时取消已无人等待的重载。
	 */
	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			// 内存后端无 revision 可比对，总是重载；无 signal 时失败退回当前缓存
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal ? reload : reload.catch(() => this.readState.data);
		}
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			// single-flight：首个读者创建重载任务，无论成败结束后都清掉引用
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			// 有 signal 时让 abort 与重载竞速（abort 立刻抛出）；否则失败退回缓存
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal ? await result : await result.catch(() => this.readState.data);
		} finally {
			reload.readers--;
			// 读者清零且任务未被替换：置空并 abort，不留悬挂的重载任务
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	/** 读取单个凭据；api_key 的 `${VAR}` 引用在返回前解析。 */
	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	/**
	 * 在锁内「读最新内容 → 回调计算新凭据 → 合并写回」。
	 * 回调返回 undefined 表示不修改（仅用锁内最新内容刷新缓存）；
	 * 返回新凭据则整体序列化写盘。成功后同步更新读缓存。
	 */
	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				// 不写盘，但仍更新缓存（读到的是锁内最新内容）并记录 revision
				latestData = currentData;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		return result;
	}

	/** 在锁内删除指定 provider 的凭据并写回，随后刷新读缓存。 */
	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		let latestData = this.readState.data;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
	}

	/** 列出凭据元信息（providerId + type），不解析配置引用的 key 值。 */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = Object.entries(await this.readLatestData(options));
		options?.signal?.throwIfAborted();
		return entries.map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}

/**
 * 一次性同步读取 auth.json 中某个 provider 的已存凭据：
 * 不实例化 store、不做结构校验、不解析配置引用的 key 值。
 * 任何读取 / 解析失败都返回 undefined（尽力而为的便捷读取，不抛错）。
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = JSON.parse(stripBom(readFileSync(normalizePath(authPath), "utf-8"))) as AuthStorageData;
		return data[providerId];
	} catch {
		return undefined;
	}
}
