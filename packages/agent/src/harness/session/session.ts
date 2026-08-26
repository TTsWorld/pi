/**
 * @file session/session.ts —— Session：会话持久化的类型化门面。
 *
 * @description
 * 会话持久化三层接口中的第 2 层：Session 包装最底层的 {@link SessionStorage}
 * （./types.ts：追加 entry / record + 各类查询 + lane / facts 管理），对上实现
 * {@link SessionTree}（单 lane 视图的读写门面）。Session 自身即 "main" lane 的
 * 视图，view(lane) 派生其他 lane 的视图。门面层在三处加固存储后端：
 * 1. **严格 JSON 校验**：所有树写入（commitEntry / commitRecord）落盘前必须通过
 *    {@link assertJsonSerializable}，杜绝循环引用 / 非纯对象等坏载荷污染会话文件；
 * 2. **id 分配**：entry / record 的 id 由 {@link IdGenerator}（默认 UUIDv7）在
 *    提交前预置，而非存储后端分配；
 * 3. **查询参数防御**：limit / cursor / operationKind 组合等先经本地断言
 *    （invalid_query），不存在的 lane 抛 invalid_lane，后端可信任输入形状。
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import type { AgentMessage } from "../../types.ts";
import type {
	BranchBounds,
	Entry,
	EntryQuery,
	IdGenerator,
	LanePointer,
	LaneRecord,
	LogItem,
	LogOptions,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	RecordBase,
	RecordQuery,
	SessionMetadata,
	SessionStats,
	SessionStorage,
	SessionTree,
} from "./types.ts";
import { SessionError } from "./types.ts";

/** {@link assertJsonSerializable} 显式校验栈的帧：待校验的值，或某对象子树校验完毕的「退出」标记。 */
type JsonValidationFrame = { value: unknown } | { exit: object };

/** 抛出 code 为 "invalid_payload" 的 {@link SessionError}；返回 never，便于在表达式中间内联失败。 */
function invalidPayload(reason: string): never {
	throw new SessionError("invalid_payload", `Durable payload ${reason}`);
}

/** 断言 limit 为正整数，否则抛 invalid_query。 */
function assertValidLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

/** 断言游标 seq 为非负整数，否则抛 invalid_query。 */
function assertValidCursor(afterSeq: number | undefined): void {
	if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
		throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
	}
}

/**
 * 校验 value 是「严格 JSON」可序列化的纯值：经 JSON.stringify → parse 往返后
 * 不丢失结构、且不携带任何 JSON 之外的形态。
 *
 * Why：entry / record 一经落盘就是长期保存的会话事实，若混入循环引用、symbol
 * 键、getter / setter 访问器、稀疏数组、非纯对象（类实例 / Map 等）或非有限
 * 数字（NaN / Infinity），轻则序列化结果悄悄丢信息，重则各存储后端行为不一
 * 致——因此在写入前快速失败（invalid_payload）远好于坏载荷污染会话文件。
 *
 * 实现为显式栈的迭代遍历（避免大载荷递归爆栈）：
 * - `active`（WeakSet）登记当前路径上「在途」的对象，再次命中即循环引用；
 * - 进入对象前先压入配对的 { exit } 帧，子树遍历完弹出时将其移出 active。
 *
 * @param value 待校验的任意值
 * @throws SessionError（code: "invalid_payload"）当 value 含任何上述非法形态
 */
export function assertJsonSerializable(value: unknown): void {
	const active = new WeakSet<object>();
	const stack: JsonValidationFrame[] = [{ value }];
	while (stack.length > 0) {
		const frame = stack.pop()!;
		// exit 帧：某对象的子树已全部校验完，把它移出「在途」集合
		if ("exit" in frame) {
			active.delete(frame.exit);
			continue;
		}
		const candidate = frame.value;
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
			continue;
		}
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate)) invalidPayload("contains a non-finite number");
			continue;
		}
		if (typeof candidate !== "object") invalidPayload(`contains ${typeof candidate}`);
		// 候选是数组/对象：登记进「在途」集合并压入配对 exit 帧，随后逐一校验子属性
		if (active.has(candidate)) invalidPayload("contains a cycle");
		active.add(candidate);
		stack.push({ exit: candidate });

		// 数组：必须是标准 Array 原型、无附加属性（自身属性名恰为各下标 + "length"）、无空洞、无访问器下标
		if (Array.isArray(candidate)) {
			if (Object.getPrototypeOf(candidate) !== Array.prototype) {
				invalidPayload("contains a non-standard array");
			}
			if (
				Object.getOwnPropertySymbols(candidate).length > 0 ||
				Object.getOwnPropertyNames(candidate).length !== candidate.length + 1
			) {
				invalidPayload("contains an array with unsupported properties");
			}
			// 逆序压栈，使出栈（即遍历）顺序与数组下标顺序一致
			for (let index = candidate.length - 1; index >= 0; index--) {
				if (!Object.hasOwn(candidate, index)) invalidPayload("contains a sparse array");
				const descriptor = Object.getOwnPropertyDescriptor(candidate, index)!;
				if (!("value" in descriptor)) invalidPayload("contains an array accessor");
				stack.push({ value: descriptor.value });
			}
			continue;
		}

		// 普通对象：仅接受 Object.prototype 或 null 原型；拒绝 symbol 键、非枚举属性与访问器
		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) {
			invalidPayload("contains a non-plain object");
		}
		if (Object.getOwnPropertySymbols(candidate).length > 0) {
			invalidPayload("contains a symbol-keyed property");
		}
		const keys = Object.keys(candidate);
		if (Object.getOwnPropertyNames(candidate).length !== keys.length) {
			invalidPayload("contains a non-enumerable property");
		}
		for (let index = keys.length - 1; index >= 0; index--) {
			const descriptor = Object.getOwnPropertyDescriptor(candidate, keys[index]!)!;
			if (!("value" in descriptor)) invalidPayload("contains an accessor");
			stack.push({ value: descriptor.value });
		}
	}
}

/**
 * 会话门面：包装一个 {@link SessionStorage} 后端，同时自身实现 "main" lane 的
 * {@link SessionTree} 视图（view(lane) 派生其余 lane 的视图）。写入统一走
 * commitEntry / commitRecord 两个关口（严格 JSON 校验），查询参数先经本地断言
 * 再透传存储。
 */
export class Session<TMetadata extends SessionMetadata = SessionMetadata> implements SessionTree {
	/** 被包装的底层存储：lane / entry / record / facts 的真正实现。 */
	private readonly storage: SessionStorage<TMetadata>;
	/** entry / record id 生成器；默认 UUIDv7（时间有序：天然按创建先后排序，且利于存储索引局部性）。 */
	readonly idGenerator: IdGenerator;

	/**
	 * @param storage 底层存储后端
	 * @param options.idGenerator 可选 id 生成器（测试等场景可注入确定性序列）
	 */
	constructor(storage: SessionStorage<TMetadata>, options: { idGenerator?: IdGenerator } = {}) {
		this.storage = storage;
		this.idGenerator = options.idGenerator ?? { next: () => uuidv7() };
	}

	/** 读取会话元数据（透传存储）。 */
	async getMetadata(): Promise<TMetadata> {
		return this.storage.getMetadata();
	}

	/**
	 * 返回指定 lane 的 {@link SessionTree} 视图。
	 *
	 * lane 只是 Entry 树上的命名游标，视图无需独立状态：所有方法都委托回本
	 * Session 的对应实现，lane 名以闭包参数固定（该视图的分支查询以该 lane 的
	 * 当前叶子为默认起点）。"main" 直接返回 this——Session 自身就是 main 视图。
	 *
	 * @param lane 目标 lane 名
	 */
	view(lane: string): SessionTree {
		if (lane === "main") return this;
		return {
			getLeafId: () => this.getLeafIdForLane(lane),
			getEntry: (id) => this.getEntry(id),
			getStats: () => this.getStats(),
			getName: () => this.getName(),
			setName: (name) => this.setName(name),
			getLabel: (targetId) => this.getLabel(targetId),
			setLabel: (targetId, label) => this.setLabel(targetId, label),
			findEntries: (query) => this.queryEntries(query),
			findEntry: async (query = {}) => (await this.queryEntries(query, 1))[0],
			findEntriesOnBranch: (query) => this.queryBranchEntries(lane, query),
			findEntryOnBranch: async (query = {}) => (await this.queryBranchEntries(lane, query, 1))[0],
			appendMessage: (message) => this.appendMessageToLane(lane, message),
			appendCustomEntry: (customType, data) => this.appendCustomEntryToLane(lane, customType, data),
		};
	}

	/** main lane 的当前叶子 entry id（尚无任何 entry 时为 null）。 */
	async getLeafId(): Promise<string | null> {
		return this.getLeafIdForLane("main");
	}

	/** 按 id 取单个 entry；不存在时返回 undefined。 */
	async getEntry(id: string): Promise<Entry | undefined> {
		return this.storage.getEntry(id);
	}

	/** 读取会话累计统计（由 usage record 累加得出）。 */
	async getStats(): Promise<SessionStats> {
		return this.storage.getStats();
	}

	/** 读取会话名（全局 fact，不按分支隔离）。 */
	async getName(): Promise<string | undefined> {
		return this.storage.getName();
	}

	/** 设置/清除会话名（传 undefined 清除）。 */
	async setName(name: string | undefined): Promise<void> {
		await this.storage.setName(name);
	}

	/** 读取 entry 标签（全局 fact）。 */
	async getLabel(targetId: string): Promise<string | undefined> {
		return this.storage.getLabel(targetId);
	}

	/** 设置/清除 entry 标签（传 undefined 清除）。 */
	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.storage.setLabel(targetId, label);
	}

	/** 全会话（所有分支）按条件查询 entry。 */
	async findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.queryEntries(query);
	}

	/** 同 findEntries，但只取首条匹配。 */
	async findEntry(query: EntryQuery = {}): Promise<Entry | undefined> {
		return (await this.queryEntries(query, 1))[0];
	}

	/** 分支范围查询：main lane 从叶子（或指定 start）向根的路径。 */
	async findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]> {
		return this.queryBranchEntries("main", query);
	}

	/** 同 findEntriesOnBranch，但只取首条匹配。 */
	async findEntryOnBranch(query: EntryQuery & BranchBounds = {}): Promise<Entry | undefined> {
		return (await this.queryBranchEntries("main", query, 1))[0];
	}

	/** 向 main lane 追加消息 entry，返回 entry id。 */
	async appendMessage(message: AgentMessage): Promise<string> {
		return this.appendMessageToLane("main", message);
	}

	/** 向 main lane 追加自定义 entry，返回 entry id。 */
	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		return this.appendCustomEntryToLane("main", customType, data);
	}

	/** 列出全部 lane 指针。 */
	async getLanes(): Promise<LanePointer[]> {
		return this.storage.getLanes();
	}

	/** 在指定 entry（null = 根）处创建新 lane。 */
	async createLane(lane: string, at: string | null): Promise<void> {
		await this.storage.createLane(lane, at);
	}

	/** 把 lane 指针移动到指定 entry（树导航；null = 移回根）。 */
	async moveLane(lane: string, to: string | null): Promise<void> {
		await this.storage.moveLane(lane, to);
	}

	/** 向指定 lane 追加已预置 id 的 entry：经严格 JSON 校验后透传存储，返回补全 parentId / seq / timestamp 的完整 entry。 */
	async appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.commitEntry(entry, lane);
	}

	/** 追加 record：经严格 JSON 校验后透传存储，返回补全 seq / timestamp 的完整 record（实现签名按重载收窄）。 */
	async appendRecord<TNewRecord extends NewRecord>(
		record: TNewRecord,
	): Promise<TNewRecord & Pick<RecordBase, "seq" | "timestamp">>;
	async appendRecord(record: NewRecord): Promise<LaneRecord> {
		return this.commitRecord(record);
	}

	/** 按条件查询 record；带 type 的重载把返回类型收窄到该 record 类型。 */
	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]> {
		return this.queryRecords(query);
	}

	/** 返回未收尾的操作起点（最新在前）；恢复方用 limit: 2 判定 lane 空闲 / 操作挂起 / 已损坏。 */
	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		assertValidLimit(options?.limit);
		return this.storage.findOpenOperations(lane, options);
	}

	/** 读取统一日志流（entry / record / lane / fact 按 seq 混编，升序）。 */
	async getLog(options?: LogOptions): Promise<LogItem[]> {
		return this.queryLog(options);
	}

	/** 返回 lane 的当前叶子 entry id；lane 为空时为 null。lane 不存在时抛错。 */
	private async getLeafIdForLane(lane: string): Promise<string | null> {
		const pointer = (await this.getLanes()).find((candidate) => candidate.lane === lane);
		if (!pointer) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return pointer.leafId;
	}

	/** 校验查询参数后透传 storage.findEntries；resultLimit 供 findEntry 等单条查询收窄为 1 而不改动调用方的 query。 */
	private async queryEntries(query: EntryQuery = {}, resultLimit = query.limit): Promise<Entry[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		return this.storage.findEntries(resultLimit === query.limit ? query : { ...query, limit: resultLimit });
	}

	/**
	 * 从 query.start 向根扫描分支，缺省取 lane 的当前叶子。
	 * resultLimit 让单条查询在不改动调用方 query 的情况下限制结果条数。
	 */
	private async queryBranchEntries(
		defaultLane: string,
		query: EntryQuery & BranchBounds = {},
		resultLimit = query.limit,
	): Promise<Entry[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const start = query.start ?? (await this.getLeafIdForLane(defaultLane));
		if (start === null) return [];
		const storageQuery = resultLimit === query.limit ? query : { ...query, limit: resultLimit };
		return this.storage.findEntriesOnBranch({ ...storageQuery, start });
	}

	/** 校验查询参数（含 operationKind 必须搭配 type: "operation_started" 的组合约束）后透传存储。 */
	private async queryRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		assertValidLimit(query.limit);
		assertValidCursor(query.afterSeq);
		if (query.operationKind !== undefined && query.type !== "operation_started") {
			throw new SessionError("invalid_query", 'operationKind requires type "operation_started"');
		}
		return this.storage.findRecords(query);
	}

	/** 校验翻页参数后透传 storage.getLog。 */
	private async queryLog(options: LogOptions = {}): Promise<LogItem[]> {
		assertValidLimit(options.limit);
		assertValidCursor(options.afterSeq);
		return this.storage.getLog(options);
	}

	/** 构造预置 id（idGenerator.next()）的 message entry 并提交到指定 lane，返回 entry id。 */
	private async appendMessageToLane(lane: string, message: AgentMessage): Promise<string> {
		const entry = await this.commitEntry({ type: "message", id: this.idGenerator.next(), message }, lane);
		return entry.id;
	}

	/** 构造预置 id 的 custom entry 并提交到指定 lane；data 缺省时省略该键，保持载荷最小。 */
	private async appendCustomEntryToLane(lane: string, customType: string, data?: unknown): Promise<string> {
		const entry = await this.commitEntry(
			data === undefined
				? { type: "custom", id: this.idGenerator.next(), customType }
				: { type: "custom", id: this.idGenerator.next(), customType, data },
			lane,
		);
		return entry.id;
	}

	/** 树写入的唯一关口：assertJsonSerializable 严格校验通过后才透传 storage.appendEntry。 */
	private async commitEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		assertJsonSerializable(entry);
		return this.storage.appendEntry(entry, lane);
	}

	/** record 写入的唯一关口：assertJsonSerializable 严格校验后透传 storage.appendRecord；存储返回宽类型 LaneRecord，再断言回窄化的泛型返回。 */
	private async commitRecord<TNewRecord extends NewRecord>(
		record: TNewRecord,
	): Promise<TNewRecord & Pick<RecordBase, "seq" | "timestamp">> {
		assertJsonSerializable(record);
		return this.storage.appendRecord<LaneRecord>(record) as unknown as Promise<
			TNewRecord & Pick<RecordBase, "seq" | "timestamp">
		>;
	}
}
