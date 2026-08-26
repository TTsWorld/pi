/**
 * @file session/state.ts —— 会话的内存权威状态机：以严格连续的全局 seq 回放
 * 统一日志（entry / record / lane / fact 四类变更），维护 Entry 树索引、lane
 * 游标、未收尾操作表与累计统计。
 *
 * @description
 * {@link SessionState} 是 ./types.ts 三层访问接口共同的数据内核：存储后端
 * （memory / jsonl 等）在每次落盘一条变更后调用 applyMutation 增量更新它；
 * 打开已有会话时按 seq 顺序回放全部变更即可完整重建。它承担两类职责：
 * - **写入前校验**：requireLane / validateNewLane / validateTarget /
 *   validateUnusedId 供后端在落盘前确认目标合法；
 * - **不变量维护**：applyMutation 在应用每条变更前做严格校验（seq 恰好接续、
 *   id 不重复、父链 / lane 链完整），并同步更新全部派生索引（entriesById、
 *   openOperationsByLane、stats、统一日志）。
 */
import {
	type BranchBounds,
	type Entry,
	type EntryOrder,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type OperationStartedRecord,
	type RecordQuery,
	SessionError,
	type SessionStats,
} from "./types.ts";

/**
 * 一次会话状态变更：与统一日志 LogItem（见 ./types.ts）的各 kind 一一对应
 * （entry 追加 / record 追加 / lane 指针迁移 / 全局 fact 变更），是回放日志
 * 与 fork 派生的最小单位。
 *
 * entry 变更的 lane 字段可缺省：携带时表示「向该 lane 追加」（应用后游标随
 * 之推进）；缺省时只入树、不动任何游标——fork 回放历史 entry 时正是如此，
 * 游标由随后的 lane 变更统一设置。
 */
export type SessionMutation =
	| { kind: "entry"; lane?: string; entry: Entry }
	| { kind: "record"; record: LaneRecord }
	| { kind: "lane"; seq: number; lane: string; leafId: string | null }
	| { kind: "fact"; seq: number; fact: "name"; name: string | undefined }
	| { kind: "fact"; seq: number; fact: "label"; targetId: string; label: string | undefined };

/** 变更非法时的报告回调：接收错误描述并永不返回（由调用方决定抛错还是收集）。 */
type InvalidMutation = (message: string) => never;

/** 默认报告实现：抛出 invalid_entry 类型的 {@link SessionError}。 */
function invalidMutation(message: string): never {
	throw new SessionError("invalid_entry", `Invalid session mutation: ${message}`);
}

/** 校验查询参数 limit：给定时必须是正整数。 */
function assertValidLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

/** 校验游标参数 afterSeq：给定时必须是非负整数。 */
function assertValidCursor(afterSeq: number | undefined): void {
	if (afterSeq !== undefined && (!Number.isInteger(afterSeq) || afterSeq < 0)) {
		throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
	}
}

/**
 * 按请求顺序遍历的辅助生成器：内部数组均为追加序（旧在前），缺省约定
 * newestFirst 时倒序产出。
 */
function* ordered<T>(items: readonly T[], order: EntryOrder | undefined): IterableIterator<T> {
	if (order === "oldestFirst") {
		yield* items;
		return;
	}
	for (let index = items.length - 1; index >= 0; index--) yield items[index]!;
}

/**
 * 会话在内存中的权威状态：Entry 树 + 操作日志 + lane 游标 + 全局 facts +
 * 累计统计。
 *
 * 由存储后端驱动：每次落盘一条 entry / record / lane / fact 变更后调用
 * applyMutation 同步内存；打开已有会话时按 seq 顺序重放全部变更即可完整
 * 重建。所有派生索引（entriesById、openOperationsByLane、log、stats）都在
 * applyMutation 内维护，保证与变更流严格一致。
 */
export class SessionState {
	/** 已应用的最大全局 seq（尚未应用任何变更时为 0）；entry/record/lane/fact 共享同一序号空间。 */
	private sequence = 0;
	/** 已占用的 id 全集：entry id 与 record id 在同一池中查重。 */
	private readonly usedIds = new Set<string>();
	/** 全部 entry，按追加序（即 seq 升序）排列；含所有分支。 */
	private readonly entries: Entry[] = [];
	/** id → entry 的索引，O(1) 定位树节点。 */
	private readonly entriesById = new Map<string, Entry>();
	/** 全部 record，按追加序排列。 */
	private readonly records: LaneRecord[] = [];
	/** lane → (runId → OperationStartedRecord)：各 lane 尚未收尾的操作表。 */
	private readonly openOperationsByLane = new Map<string, Map<string, OperationStartedRecord>>();
	/** lane 名 → 当前叶子 entry id；创建即含默认的 "main" → null（指向根）。 */
	private readonly lanes = new Map<string, string | null>([["main", null]]);
	/** 统一日志（getLog 的数据源）：entry/record/lane/fact 按 seq 升序混编。 */
	private readonly log: LogItem[] = [];
	/** 累计统计：唯一数据来源是 usage record（见 applyMutation 的 record 分支）。 */
	private readonly stats: SessionStats = {
		messageCount: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	};
	/** 会话名（全局 fact，最新值生效）。 */
	private name: string | undefined;
	/** entry id → 标签（全局 fact，最新值生效）。 */
	private readonly labels = new Map<string, string>();

	/** 下一个待分配的全局 seq：存储后端写入前取它预置到变更上，随后再经 applyMutation 应用。 */
	get nextSequence(): number {
		return this.sequence + 1;
	}

	/** 列出全部 lane 指针（lane 名 + 当前叶子 id）。 */
	getLanes(): LanePointer[] {
		return [...this.lanes].map(([lane, leafId]) => ({ lane, leafId }));
	}

	/**
	 * 取指定 lane 的叶子 id；lane 不存在时抛错。
	 *
	 * @param lane lane 名
	 * @returns 该 lane 当前叶子 entry id（空 lane 指向根，为 null）
	 * @throws invalid_lane lane 不存在
	 */
	requireLane(lane: string): string | null {
		const leafId = this.lanes.get(lane);
		if (leafId === undefined) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		return leafId;
	}

	/**
	 * 校验新 lane 名可用（尚未存在），供后端在 createLane 落盘前调用。
	 *
	 * @throws already_exists lane 已存在
	 */
	validateNewLane(lane: string): void {
		if (this.lanes.has(lane)) throw new SessionError("already_exists", `Lane already exists: ${lane}`);
	}

	/**
	 * 校验目标 entry 存在（null 视为根、合法），供 createLane / moveLane 落盘前调用。
	 *
	 * @throws not_found 目标 entry 不存在
	 */
	validateTarget(targetId: string | null): void {
		if (targetId !== null && !this.entriesById.has(targetId)) {
			throw new SessionError("not_found", `Entry not found: ${targetId}`);
		}
	}

	/**
	 * 校验 id 尚未被占用（entry 与 record 同池），供写入方预置 id 前调用。
	 *
	 * @throws already_exists id 已存在
	 */
	validateUnusedId(id: string): void {
		if (this.usedIds.has(id)) throw new SessionError("already_exists", `Session id already exists: ${id}`);
	}

	/**
	 * 应用一条变更并同步维护全部派生索引——状态机的唯一写入入口。
	 *
	 * 先做全局 seq 严格连续性校验，再按变更类别做结构校验，全部通过后才落账
	 * （更新 sequence / 索引 / 统计 / 统一日志），任一校验失败即通过 invalid
	 * 报告并中止，内存状态不被部分污染。
	 *
	 * @param mutation 待应用的变更（entry / record / lane / fact 之一）
	 * @param invalid 校验失败的报告回调，接收错误描述、永不返回；默认抛
	 *   SessionError，可注入自定义实现以在失败时携带更多上下文
	 */
	applyMutation(mutation: SessionMutation, invalid: InvalidMutation = invalidMutation): void {
		// ========== 全局 seq 严格连续性校验 ==========
		// Why：四类变更共享同一全局序号空间，由存储层按「先取 nextSequence 预置、
		// 落盘后再应用」的顺序分配。这里要求 seq 恰好等于 sequence + 1——断档
		// 意味着日志丢失或损坏，重复意味着同一条变更被写了两次；两种情况都说明
		// 内存状态会悄悄偏离落盘历史，必须立即拒绝而非静默接受。正是这份严格，
		// 保证了「按日志顺序重放 = 完整重建同一状态」。
		const seq =
			mutation.kind === "entry"
				? mutation.entry.seq
				: mutation.kind === "record"
					? mutation.record.seq
					: mutation.seq;
		if (seq !== this.sequence + 1) invalid(`has non-consecutive seq ${seq}`);

		switch (mutation.kind) {
			// ========== entry：追加树节点（可选推进 lane 游标） ==========
			case "entry": {
				// id 查重：entry 与 record 同池，重复即拒绝
				if (this.usedIds.has(mutation.entry.id)) invalid(`contains duplicate id ${mutation.entry.id}`);
				if (mutation.lane !== undefined) {
					// 携带 lane = 「向该 lane 追加」：父必须是该 lane 当前叶子，
					// 否则树会在此意外分叉，破坏「lane 是树上游标」的语义
					const leafId = this.lanes.get(mutation.lane);
					if (leafId === undefined) invalid(`references missing lane ${mutation.lane}`);
					if (mutation.entry.parentId !== leafId) invalid("does not chain to the lane leaf");
				}
				// 父链完整性：parentId 必须指向已存在的 entry（null = 根）
				if (mutation.entry.parentId !== null && !this.entriesById.has(mutation.entry.parentId)) {
					invalid(`references missing parent ${mutation.entry.parentId}`);
				}
				// 校验全部通过，落账：推进序号、登记 id、更新索引与统一日志
				this.sequence = seq;
				this.usedIds.add(mutation.entry.id);
				this.entries.push(mutation.entry);
				this.entriesById.set(mutation.entry.id, mutation.entry);
				// lane 游标随之推进到新叶子（未携带 lane 时不动任何游标）
				if (mutation.lane !== undefined) this.lanes.set(mutation.lane, mutation.entry.id);
				this.log.push({ kind: "entry", seq, entry: mutation.entry });
				if (mutation.entry.type === "message") this.stats.messageCount += 1;
				break;
			}
			// ========== record：追加操作日志（维护未收尾操作表与统计） ==========
			case "record": {
				if (!this.lanes.has(mutation.record.lane)) invalid(`references missing lane ${mutation.record.lane}`);
				if (this.usedIds.has(mutation.record.id)) invalid(`contains duplicate id ${mutation.record.id}`);
				this.sequence = seq;
				this.usedIds.add(mutation.record.id);
				this.records.push(mutation.record);
				if (mutation.record.type === "operation_started") {
					// 登记未收尾操作：runId（即 record id）→ 操作起点，供恢复方判定 lane 状态
					let openOperations = this.openOperationsByLane.get(mutation.record.lane);
					if (!openOperations) {
						openOperations = new Map();
						this.openOperationsByLane.set(mutation.record.lane, openOperations);
					}
					openOperations.set(mutation.record.id, mutation.record);
				} else if (mutation.record.type === "operation_finished") {
					// 收尾即从表中移除，表里剩下的就是崩溃恢复要关注的挂起操作
					this.openOperationsByLane.get(mutation.record.lane)?.delete(mutation.record.runId);
				}
				this.log.push({ kind: "record", seq, record: mutation.record });
				if (mutation.record.type === "usage") {
					// usage record 是统计的唯一来源：cached = 缓存读；
					// uncached = 新输入 + 缓存写；重放这些 record 即重建统计
					this.stats.cachedTokens += mutation.record.usage.cacheRead;
					this.stats.uncachedTokens += mutation.record.usage.input + mutation.record.usage.cacheWrite;
					this.stats.totalTokens += mutation.record.usage.totalTokens;
					this.stats.costTotal += mutation.record.usage.cost.total;
				}
				break;
			}
			// ========== lane：迁移 lane 游标（树导航的唯一痕迹） ==========
			case "lane":
				// 游标目标必须已存在（null = 移回根）；只动指针、不追加 entry
				if (mutation.leafId !== null && !this.entriesById.has(mutation.leafId)) {
					invalid(`references missing lane target ${mutation.leafId}`);
				}
				this.sequence = seq;
				this.lanes.set(mutation.lane, mutation.leafId);
				this.log.push({ kind: "lane", seq, lane: mutation.lane, leafId: mutation.leafId });
				break;
			// ========== fact：全局 facts（会话名 / entry 标签） ==========
			case "fact":
				// 标签必须挂在已存在的 entry 上；会话名无目标、无需校验
				if (mutation.fact === "label" && !this.entriesById.has(mutation.targetId)) {
					invalid(`references missing label target ${mutation.targetId}`);
				}
				this.sequence = seq;
				if (mutation.fact === "name") {
					this.name = mutation.name;
					this.log.push({ kind: "fact", seq, fact: "name", name: mutation.name });
				} else {
					// 标签语义为「最新值生效」：undefined 即清除（delete），而非留存空串
					if (mutation.label === undefined) this.labels.delete(mutation.targetId);
					else this.labels.set(mutation.targetId, mutation.label);
					this.log.push({
						kind: "fact",
						seq,
						fact: "label",
						targetId: mutation.targetId,
						label: mutation.label,
					});
				}
				break;
		}
	}

	/** 按 id 取单个 entry；不存在时返回 undefined。 */
	getEntry(id: string): Entry | undefined {
		return this.entriesById.get(id);
	}

	/**
	 * 全会话 entry 查询：覆盖所有分支，按请求顺序返回匹配项，凑满 limit 即停。
	 *
	 * @param query 查询条件（type / customType / order / limit / cursor 均可选）
	 * @returns 匹配的 entry 数组（缺省 newestFirst）
	 */
	findEntries(query: EntryQuery = {}): Entry[] {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const results: Entry[] = [];
		for (const entry of ordered(this.entries, query.order)) {
			if (!this.matchesEntryQuery(entry, query)) continue;
			results.push(entry);
			if (results.length === query.limit) break;
		}
		return results;
	}

	/**
	 * 分支范围查询：从 start 沿父链向根收集，两种顺序殊途同归——都得到
	 * 「start 到边界（含边界项）」的路径子集。
	 *
	 * - newestFirst（缺省）：直接消费 walkToRoot 生成器（产出方向恰为叶→根），
	 *   边界条件（stopAtId / stopAtType，含命中项）交给生成器内判断；
	 * - oldestFirst：生成器方向与目标相反，故先物化整条路径再反转（根→叶），
	 *   遍历中检测到边界项后停止（同样含边界项）。
	 *
	 * @param query 查询条件 + 分支边界（start 必填）
	 * @returns 匹配的 entry 数组
	 * @throws not_found start 不存在；invalid_entry 父链断裂或成环
	 */
	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Entry[] {
		assertValidLimit(query.limit);
		assertValidCursor(query.cursor?.afterSeq);
		const results: Entry[] = [];
		if (query.order === "oldestFirst") {
			for (const entry of [...this.walkToRoot(query.start)].reverse()) {
				const reachedBound = entry.id === query.stopAtId || entry.type === query.stopAtType;
				if (this.matchesEntryQuery(entry, query)) results.push(entry);
				if (reachedBound || results.length === query.limit) break;
			}
		} else {
			for (const entry of this.walkToRoot(query.start, query)) {
				if (this.matchesEntryQuery(entry, query)) results.push(entry);
				if (results.length === query.limit) break;
			}
		}
		return results;
	}

	/**
	 * 操作日志查询：按请求顺序返回匹配的 record，凑满 limit 即停。
	 *
	 * @param query 查询条件（lane / type / runId / operationKind / afterSeq 等）
	 * @returns 匹配的 record 数组（缺省 newestFirst）
	 */
	findRecords(query: RecordQuery = {}): LaneRecord[] {
		assertValidLimit(query.limit);
		assertValidCursor(query.afterSeq);
		const results: LaneRecord[] = [];
		for (const record of ordered(this.records, query.order)) {
			if (!this.matchesRecordQuery(record, query)) continue;
			results.push(record);
			if (results.length === query.limit) break;
		}
		return results;
	}

	/**
	 * 返回指定 lane 未收尾的操作起点，最新在前。
	 *
	 * 崩溃恢复方约定以 limit: 2 调用：0 条 = lane 空闲；1 条 = 存在挂起操作；
	 * ≥ 2 条 = 至少两个操作未收尾，即日志已损坏。Map 按插入序保存，reverse
	 * 后即得「最新在前」。
	 *
	 * @param lane 目标 lane
	 * @param options 可选 limit
	 */
	findOpenOperations(lane: string, options?: { limit?: number }): OperationStartedRecord[] {
		assertValidLimit(options?.limit);
		const openOperationsById = this.openOperationsByLane.get(lane);
		const openOperations = openOperationsById ? [...openOperationsById.values()].reverse() : [];
		return options?.limit === undefined ? openOperations : openOperations.slice(0, options.limit);
	}

	/**
	 * 读取统一日志：entry / record / lane / fact 按 seq 升序混编；afterSeq 为
	 * 排他下界（只返回 seq 更大的项），供增量拉取。
	 *
	 * @param options 翻页选项（afterSeq / limit）
	 */
	getLog(options: LogOptions = {}): LogItem[] {
		assertValidLimit(options.limit);
		assertValidCursor(options.afterSeq);
		const results: LogItem[] = [];
		for (const item of this.log) {
			if (options.afterSeq !== undefined && item.seq <= options.afterSeq) continue;
			results.push(item);
			if (results.length === options.limit) break;
		}
		return results;
	}

	/** 读取会话名（未设置时为 undefined）。 */
	getName(): string | undefined {
		return this.name;
	}

	/** 读取 entry 标签（未设置时为 undefined）。 */
	getLabel(id: string): string | undefined {
		return this.labels.get(id);
	}

	/** 读取累计统计（随 usage record 的应用实时累加）。 */
	getStats(): SessionStats {
		return this.stats;
	}

	/**
	 * 生成派生（fork）新会话所需的变更序列；只读、不修改当前状态。
	 *
	 * 输出在目标会话的新序号空间里从 seq 1 起连续编号，编排顺序固定为：
	 * 全部 entry 变更（不带 lane、不迁移游标）→ lane 指针变更 → 会话名
	 * fact → 标签 fact。entry 先行、lane 随后，正好满足 applyMutation 的
	 * 校验次序：父 entry 必须先入树，lane 指针与标签才能引用它。
	 *
	 * @param options 复制范围：tree = 整棵树 + 所有 lane；branch（缺省）=
	 *   从目标 entry 到根的一条分支，新会话只有 main lane
	 * @returns 可逐条 applyMutation 到新会话的变更数组
	 * @throws invalid_fork_target branch 模式下目标不是 message entry
	 */
	createForkMutations(options: ForkOptions): SessionMutation[] {
		// ========== 确定复制范围 ==========
		let copiedEntries: Entry[];
		let forkLanes: LanePointer[];
		if (options.scope === "tree") {
			// 整棵树：全部 entry（所有分支）+ 全部 lane 指针原样照搬
			copiedEntries = this.findEntries({ order: "oldestFirst" });
			forkLanes = this.getLanes();
		} else {
			// 单条分支：目标缺省取 main 叶子，且必须是 message entry
			//（fork 点应落在完整的对话回合边界上）
			const selectedEntryId = options.entryId ?? this.requireLane("main");
			let targetId: string | null = null;
			if (selectedEntryId !== null) {
				const entry = this.getEntry(selectedEntryId);
				if (!entry || entry.type !== "message") {
					throw new SessionError("invalid_fork_target", `Fork target is not a message entry: ${selectedEntryId}`);
				}
				// position 缺省：目标取自 main 叶子时含叶子本身（at），显式指定
				// entryId 时不含该 entry、从其父起（before）
				const position = options.position ?? (options.entryId === undefined ? "at" : "before");
				targetId = position === "at" ? entry.id : entry.parentId;
			}
			copiedEntries = targetId === null ? [] : this.findEntriesOnBranch({ start: targetId, order: "oldestFirst" });
			forkLanes = [{ lane: "main", leafId: targetId }];
		}

		// ========== 以新序号空间编排变更流 ==========
		const mutations: SessionMutation[] = [];
		let sequence = 1;
		// 深拷贝（structuredClone）确保新会话与源会话不共享任何对象引用；
		// 不携带 lane：历史 entry 只入树，游标由下面的 lane 变更统一设置
		for (const sourceEntry of copiedEntries) {
			mutations.push({ kind: "entry", entry: { ...structuredClone(sourceEntry), seq: sequence++ } });
		}
		for (const pointer of forkLanes) {
			mutations.push({ kind: "lane", seq: sequence++, lane: pointer.lane, leafId: pointer.leafId });
		}
		if (this.name !== undefined) {
			mutations.push({ kind: "fact", seq: sequence++, fact: "name", name: this.name });
		}
		// 只迁移被复制 entry 上的标签；record 操作日志不随 fork 复制
		for (const entry of copiedEntries) {
			const label = this.labels.get(entry.id);
			if (label !== undefined) {
				mutations.push({ kind: "fact", seq: sequence++, fact: "label", targetId: entry.id, label });
			}
		}
		return mutations;
	}

	/**
	 * 从 start 沿 parentId 链向根逐个产出 entry 的私有生成器。
	 *
	 * 命中 stopAtId / stopAtType（含命中项本身）或到达根后终止。沿途用
	 * visited 集合检测环、逐跳校验父节点存在——两者都意味着树已损坏，宁可
	 * 立即抛错也不产出错误的路径结果。
	 *
	 * @param start 起点 entry id（null 直接结束）
	 * @param bounds 可选边界（stopAtId / stopAtType，含命中项）
	 * @throws not_found 起点或父链上的 entry 不存在
	 * @throws invalid_entry 父链成环
	 */
	private *walkToRoot(
		start: string | null,
		bounds?: Pick<BranchBounds, "stopAtId" | "stopAtType">,
	): IterableIterator<Entry> {
		if (start === null) return;
		const visited = new Set<string>();
		let current = this.entriesById.get(start);
		if (!current) throw new SessionError("not_found", `Entry not found: ${start}`);
		while (current) {
			// 环检测：同一节点二次出现说明 parentId 链绕回，停止遍历并报损坏
			if (visited.has(current.id)) {
				throw new SessionError("invalid_entry", `Session branch contains a cycle at ${current.id}`);
			}
			visited.add(current.id);
			yield current;
			// 到达边界项（含）或根节点即止
			if (current.id === bounds?.stopAtId || current.type === bounds?.stopAtType || current.parentId === null) break;
			const parentId: string = current.parentId;
			current = this.entriesById.get(parentId);
			if (!current) throw new SessionError("invalid_entry", `Entry not found: ${parentId}`);
		}
	}

	/**
	 * 判断 entry 是否满足查询条件（type / customType / 游标）。
	 *
	 * 游标方向随 order 翻转，与「位于 afterSeq 之后一侧」的翻页语义一致：
	 * oldestFirst 取 seq 更大的一侧（继续向新翻页），newestFirst 取 seq
	 * 更小的一侧（继续向旧翻页）。
	 */
	private matchesEntryQuery(entry: Entry, query: EntryQuery): boolean {
		return (
			(query.type === undefined || entry.type === query.type) &&
			(query.customType === undefined || (entry.type === "custom" && entry.customType === query.customType)) &&
			(query.cursor === undefined ||
				(query.order === "oldestFirst" ? entry.seq > query.cursor.afterSeq : entry.seq < query.cursor.afterSeq))
		);
	}

	/**
	 * 判断 record 是否满足查询条件（lane / type / runId / operationKind /
	 * afterSeq）。runId 的匹配规则：operation_started 以自身 id（即 runId）
	 * 匹配，其余隶属操作的 record 以 runId 字段匹配；本身不带 runId 的
	 * record 类型不会匹配该条件。afterSeq 为排他下界（seq > afterSeq）。
	 */
	private matchesRecordQuery(record: LaneRecord, query: RecordQuery): boolean {
		return (
			(query.lane === undefined || record.lane === query.lane) &&
			(query.type === undefined || record.type === query.type) &&
			(query.runId === undefined ||
				(record.type === "operation_started"
					? record.id === query.runId
					: "runId" in record && record.runId === query.runId)) &&
			(query.operationKind === undefined ||
				(record.type === "operation_started" && record.intent.kind === query.operationKind)) &&
			(query.afterSeq === undefined || record.seq > query.afterSeq)
		);
	}
}
