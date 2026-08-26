/**
 * @file session/memory.ts —— SessionStorage 的纯内存实现与配套的内存会话仓库。
 *
 * @description
 * InMemorySessionStorage 把单个会话的全部状态（entry 树 / record 日志 / lane
 * 指针 / facts / 统计）保存在进程内的 SessionState（./state.ts）中，不落盘、
 * 随进程消亡，主要用于单元测试与无需持久化的临时会话。行为与 JSONL 等持久化
 * 后端保持一致：由存储分配 seq / parentId / timestamp、执行单写者协议等完整性
 * 校验；此外在输入与输出两侧均做 structuredClone 防御性深拷贝——内存实现中
 * 内外共享引用会直接暴露可变内部状态，深拷贝是其「持久化隔离性」的替代手段。
 * InMemorySessionRepo 在其上以一个 Map 管理多个会话的生命周期
 * （create / open / list / delete / fork）。
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import { Session } from "./session.ts";
import { SessionState } from "./state.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	type SessionCreateOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
} from "./types.ts";

/**
 * {@link SessionStorage} 的内存实现：所有读写都委托给内部 SessionState 完成。
 * 无持久化，进程退出即丢失；接口契约（存储侧字段分配、单写者协议、错误分类）
 * 与持久化后端完全对齐，便于测试中无缝替换。
 */
export class InMemorySessionStorage implements SessionStorage {
	/** 会话元数据；构造时深拷贝保存，防止调用方后续修改波及存储内部状态。 */
	private readonly metadata: SessionMetadata;
	/**
	 * 会话数据的唯一载体：集中维护 entries / records / lanes / 统一日志流 /
	 * stats / facts 及全局 seq。复用这一份结构而非在本类散放多个集合，是为
	 * 了让常规写入与 fork 重放共享同一套 mutation 语义与校验。
	 */
	private readonly state = new SessionState();

	/**
	 * 构造内存存储。
	 * @param metadata 会话元数据；深拷贝后保存以隔离外部修改。
	 */
	constructor(metadata: SessionMetadata) {
		this.metadata = structuredClone(metadata);
	}

	/**
	 * 派生新会话存储：由源会话状态按 {@link ForkOptions} 生成一串 fork
	 * mutation，再逐条重放到新存储的 SessionState 上（seq 要求严格连续递增，
	 * 故必须按序逐个 apply）。
	 * @param metadata 新会话的元数据。
	 * @param options 复制范围（branch / tree）及新会话 id 等创建选项。
	 * @returns 派生出的新存储实例。
	 */
	fork(metadata: SessionMetadata, options: ForkOptions & SessionCreateOptions): InMemorySessionStorage {
		const storage = new InMemorySessionStorage(metadata);
		for (const mutation of this.state.createForkMutations(options)) storage.state.applyMutation(mutation);
		return storage;
	}

	/** 读取会话元数据（返回深拷贝，调用方改动不会影响存储内部）。 */
	async getMetadata(): Promise<SessionMetadata> {
		return structuredClone(this.metadata);
	}

	/** 列出全部 lane 指针（lane 名 → 当前叶子 entry id）。 */
	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	/**
	 * 在指定 entry 处创建新 lane：先校验 lane 名未被占用、锚点 entry 存在
	 * （null = 根），再以一条 lane 迁移 mutation 记录初始指针。
	 */
	async createLane(lane: string, at: string | null): Promise<void> {
		this.state.validateNewLane(lane);
		this.state.validateTarget(at);
		this.state.applyMutation({ kind: "lane", seq: this.state.nextSequence, lane, leafId: at });
	}

	/**
	 * 把 lane 指针移动到指定 entry（树导航；null = 移回根）。先校验 lane
	 * 存在、目标 entry 存在，再以 lane 迁移 mutation 落盘。
	 */
	async moveLane(lane: string, to: string | null): Promise<void> {
		this.state.requireLane(lane);
		this.state.validateTarget(to);
		this.state.applyMutation({ kind: "lane", seq: this.state.nextSequence, lane, leafId: to });
	}

	/**
	 * 向指定 lane 追加 entry：补全存储侧字段（parentId / seq / timestamp）后
	 * 经 applyMutation 写入树中，返回补全后的完整 entry（深拷贝）。
	 */
	async appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		const parentId = this.state.requireLane(lane);
		this.state.validateUnusedId(newEntry.id);
		// parentId 取 lane 当前叶子，seq 取全局下一序号，timestamp 取当前时间。
		// SessionState.applyMutation 严格要求 seq === 已提交序号 + 1（不空洞、
		// 不回退）：seq 是 entry / record / lane / fact 混编统一日志流的骨架，
		// 一旦断档或乱序，崩溃恢复按日志重放的结果就不可信，故直接拒绝。
		const entry = {
			...structuredClone(newEntry),
			parentId,
			seq: this.state.nextSequence,
			timestamp: Date.now(),
		} as unknown as TEntry;
		this.state.applyMutation({ kind: "entry", lane, entry });
		return structuredClone(entry);
	}

	/**
	 * 追加 record：补全 seq / timestamp 后写入操作日志，返回完整 record（深拷贝）。
	 * @throws SessionError（"storage"）当同 lane 已有未收尾操作时又提交
	 * operation_started（违反单写者协议）。
	 */
	async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		this.state.requireLane(newRecord.lane);
		this.state.validateUnusedId(newRecord.id);
		// 单写者协议：一个 lane 同时至多一个 open 操作。恢复方依赖
		// findOpenOperations「至多一条」来判定续起哪个操作，若放行第二个
		// operation_started，崩溃恢复将无法确定续点，故在此直接拒绝。
		const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
		if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
			throw new SessionError(
				"storage",
				`Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
			);
		}
		const record = {
			...structuredClone(newRecord),
			seq: this.state.nextSequence,
			timestamp: Date.now(),
		} as unknown as TRecord;
		this.state.applyMutation({ kind: "record", record });
		return structuredClone(record);
	}

	/** 按 id 取单个 entry；不存在时返回 undefined。返回值为深拷贝。 */
	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	/** 全会话（所有分支）按条件查询 entry，返回深拷贝结果。 */
	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	/** 分支扫描查询（start 为必填，从 start 沿父链向根），返回深拷贝结果。 */
	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	/** 按条件查询 record；带 type 的重载会把返回类型收窄到该 record 类型。 */
	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	/** 返回指定 lane 未收尾的操作起点（最新在前），供崩溃恢复判定 lane 状态。 */
	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	/** 读取统一日志流（entry / record / lane / fact 按 seq 混编，升序）。 */
	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	/** 读取会话名。 */
	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	/** 设置/清除会话名（传 undefined 清除）；fact 变更同样占用全局 seq。 */
	async setName(name: string | undefined): Promise<void> {
		this.state.applyMutation({ kind: "fact", seq: this.state.nextSequence, fact: "name", name });
	}

	/** 读取 entry 标签。 */
	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	/** 设置/清除 entry 标签（传 undefined 清除）；目标 entry 必须已存在。 */
	async setLabel(id: string, label: string | undefined): Promise<void> {
		this.state.validateTarget(id);
		this.state.applyMutation({
			kind: "fact",
			seq: this.state.nextSequence,
			fact: "label",
			targetId: id,
			label,
		});
	}

	/** 读取会话累计统计（由 usage record 回放累加得出）。 */
	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}
}

/**
 * {@link SessionRepo} 的内存实现：以 Map<会话 id, 存储> 管理全部会话的
 * create / open / list / delete / fork，不持久化，供测试与临时场景使用。
 */
export class InMemorySessionRepo implements SessionRepo {
	/** 会话 id → 对应的内存存储实例。 */
	private readonly sessions = new Map<string, InMemorySessionStorage>();

	/**
	 * 新建会话：id 缺省生成 UUIDv7；id 已存在时抛 SessionError（"already_exists"）。
	 * @param options 可指定新会话 id 及派生来源（parentSessionId）。
	 * @returns 包裹新存储的 {@link Session} 门面。
	 */
	async create(options: SessionCreateOptions = {}): Promise<Session> {
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
		const storage = new InMemorySessionStorage({
			id,
			createdAt: Date.now(),
			parentSessionId: options.parentSessionId,
		});
		this.sessions.set(id, storage);
		return new Session(storage);
	}

	/** 打开已有会话（不存在时抛 "not_found"），返回 Session 门面。 */
	async open(metadata: SessionMetadata): Promise<Session> {
		return new Session(this.requireStorage(metadata.id));
	}

	/** 列出全部会话的元数据。 */
	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((storage) => storage.getMetadata()));
	}

	/** 删除会话（id 不存在时静默成功，与 Map.delete 语义一致）。 */
	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	/**
	 * 从源会话派生新会话：委托源存储的 fork 复制选定范围；新 id 缺省生成
	 * UUIDv7，parentSessionId 缺省记为源会话 id。
	 */
	async fork(source: SessionMetadata, options: ForkOptions & SessionCreateOptions = {}): Promise<Session> {
		const sourceStorage = this.requireStorage(source.id);
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
		const storage = sourceStorage.fork(
			{ id, createdAt: Date.now(), parentSessionId: options.parentSessionId ?? source.id },
			options,
		);
		this.sessions.set(id, storage);
		return new Session(storage);
	}

	/** 按 id 取存储实例；不存在时抛 SessionError（"not_found"）。 */
	private requireStorage(id: string): InMemorySessionStorage {
		const storage = this.sessions.get(id);
		if (!storage) throw new SessionError("not_found", `Session not found: ${id}`);
		return storage;
	}
}
