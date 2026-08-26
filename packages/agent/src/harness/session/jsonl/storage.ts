/**
 * @file session/jsonl/storage.ts —— JSONL v4 会话的单文件存储实现：追加写 +
 * 原子整文件发布 + 加载即修复。
 *
 * @description
 * 本文件是 {@link SessionStorage} 接口的文件系统后端。仓库层（./repo.ts）负责
 * 「目录按 cwd 编码区分项目」的布局与会话生命周期，这里只面向单个会话文件。
 * v4 磁盘格式：首行 header（encodeHeader / parseHeader），其后每行一条
 * mutation（lane / entry / record / fact，见 ./codec.ts）。
 *
 * 可靠性设计（Why）：
 * - **常规追加**：每条 mutation 直接 appendFile；崩溃时磁盘至多多出一条半写
 *   行（torn tail），由 {@link load} 在下次加载时检测并自动截断修复；
 * - **整文件重写走原子发布**：新建 header、fork、torn-tail 修复都先在目标旁
 *   的 `.tmp` 暂存文件中构建完整内容，再原子 rename 覆盖目标（见
 *   {@link publishFileAtomically}），保证目标文件任意时刻都完整可解析；
 * - **串行写队列**：所有写操作经 {@link enqueue} 排队单飞行执行，避免并发
 *   append 交错破坏 JSONL 行结构；
 * - 解码 / 文件错误统一映射为 {@link SessionError}（见 ./errors.ts）。
 */
import { type SessionMutation, SessionState } from "../state.ts";
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
	SessionError,
	type SessionStats,
	type SessionStorage,
} from "../types.ts";
import { encodeHeader, encodeMutation, metadataFromHeader, parseHeader, parseMutation } from "./codec.ts";
import { fileResult, invalidFile, JsonlDecodeError } from "./errors.ts";
import type { JsonlSessionMetadata, JsonlSessionRepoFileSystem, JsonlV4Header } from "./types.ts";

/**
 * 在目标文件旁先构建一个完整的临时文件，再通过原子 rename 覆盖目标文件。
 * populate 回调必须创建或覆盖 `tempPath`、写入完整文件内容。在 rename 提交
 * 之前目标文件保持原样不动，因此填充过程中进程崩溃最多遗留一个可被忽略的
 * `.tmp` 文件，目标文件绝不会处于半写状态。
 *
 * 填充或 rename 失败时 reject；此时对临时文件的删除是尽力而为（best-effort），
 * 且始终保留并上抛原始错误。调用方必须对发往同一目标的发布做串行化，因为
 * 它们共享该目标那条确定性的 `.tmp` 暂存路径。
 *
 * @param fs 文件系统抽象（见 ./types.ts）。
 * @param destinationPath 目标文件路径；暂存文件固定为 `${destinationPath}.tmp`。
 * @param populate 负责把完整内容写入 tempPath 的回调。
 * @throws 填充或 rename 失败时抛出原始错误（清理暂存文件的失败不会将其掩盖）。
 */
async function publishFileAtomically(
	fs: JsonlSessionRepoFileSystem,
	destinationPath: string,
	populate: (tempPath: string) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		await populate(tempPath);
		fileResult(await fs.renameFile(tempPath, destinationPath), `Failed to publish staged file ${destinationPath}`);
	} catch (error) {
		await fs.remove(tempPath, { force: true });
		throw error;
	}
}

/**
 * 单个 JSONL v4 会话文件的 {@link SessionStorage} 实现。
 *
 * 职责分工：磁盘上的会话文件（首行 header + 逐行 mutation）是唯一事实来源；
 * 内存中的 {@link SessionState} 保存重放得到的会话状态（Entry 树、lane 指针、
 * facts、统计）。每个写方法都遵循「先落盘 append、后应用到内存」的
 * write-ahead 顺序，并经 {@link enqueue} 串行执行。
 */
export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	/** 注入的文件系统抽象（./types.ts 的 JsonlSessionRepoFileSystem）。 */
	private readonly fs: JsonlSessionRepoFileSystem;
	/** 本会话元数据快照（path / cwd / mtime 等，创建或加载时确定）。 */
	private readonly metadata: JsonlSessionMetadata;
	/** 内存态：重放全部 mutation 后的会话状态（Entry 树 / lane / facts / 统计）。 */
	private readonly state = new SessionState();
	/** 写队列的尾指针：始终指向队尾（已吞错）的写任务，用于串行化所有写操作。 */
	private tail: Promise<void> = Promise.resolve();

	/**
	 * @param fs 文件系统抽象。
	 * @param metadata 会话元数据（structuredClone 深拷贝，与外部隔离）。
	 */
	constructor(fs: JsonlSessionRepoFileSystem, metadata: JsonlSessionMetadata) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
	}

	/**
	 * 新建会话文件：写入编码后的 v4 header 作为首行，再取 mtime 生成元数据。
	 *
	 * Why 直接 writeFile 而不走原子发布：目标是全新路径，没有需要保护的旧
	 * 内容，中途崩溃只会留下一个从未被确认过的半成品文件。
	 *
	 * @param fs 文件系统抽象。
	 * @param path 新会话文件路径（由仓库层按 cwd 编码的目录规则生成）。
	 * @param header v4 会话头（id / cwd / parentSessionId 等）。
	 * @returns 可继续追加 mutation 的存储实例。
	 * @throws 写入 header 或读取文件信息失败时抛出 SessionError。
	 */
	static async create(
		fs: JsonlSessionRepoFileSystem,
		path: string,
		header: JsonlV4Header,
	): Promise<JsonlSessionStorage> {
		// 1) 写入首行 header（新文件直接整体写入即可）。
		fileResult(await fs.writeFile(path, encodeHeader(header)), `Failed to initialize session ${path}`);
		// 2) 读取 mtime，与 header 一起折算成会话元数据。
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		return new JsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
	}

	/**
	 * 从磁盘加载既有会话：读取整个文件，把首行 header 与其后每行 mutation
	 * 依次重放进一个全新的内存态。
	 *
	 * 「加载即修复」语义：
	 * - **torn tail 自动修复**：仅当「最后一行」出现「语法级」错误（崩溃导致的
	 *   半写追加，且从未被任何内存态确认过）时，静默丢弃该行并原子发布有效
	 *   前缀；
	 * - **未闭合换行修复**：末行是合法 JSON 但文件未以 "\n" 结尾时补一个换行，
	 *   避免后续 appendFile 把新行拼到残行末尾；
	 * - **其余一律报损坏**：非末行的语法错误、任意位置的 schema 错误、重放时
	 *   违反树规约，都抛出带文件路径与行号的 SessionError（code:
	 *   "invalid_entry"，见 ./errors.ts 的 invalidFile）。
	 *
	 * @param fs 文件系统抽象。
	 * @param path 会话文件路径。
	 * @returns 重放完成的存储实例；返回时磁盘文件已恢复到完整一致状态。
	 * @throws 读取失败、文件损坏（见上）或重放冲突时抛出。
	 */
	static async load(fs: JsonlSessionRepoFileSystem, path: string): Promise<JsonlSessionStorage> {
		// ========== 读取全文并按物理行切分 ==========
		// split("\n") 在文件以换行结尾时会多出末尾一个空串，先弹出；
		// 空文件或首行为空 => 缺少 header，按第 1 行损坏报错。
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) {
			throw invalidFile(path, 1, new JsonlDecodeError("schema", "is missing a header"));
		}

		// ========== 解析首行 header，建立空会话 ==========
		// header 解析失败同样按第 1 行损坏报错；mtime 供元数据使用。
		const headerResult = parseHeader(physicalLines[0]);
		if (!headerResult.ok) throw invalidFile(path, 1, headerResult.error);
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(fs, metadataFromHeader(headerResult.value, path, fileInfo.mtimeMs));

		// ========== 逐行重放 mutation ==========
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			const mutationResult = parseMutation(line);
			if (!mutationResult.ok) {
				// 仅「最后一行 + 语法错误」判为 torn tail：schema 错误说明该行
				// 已写完整但内容不合法，非末行的语法错误说明中间行损坏——两者
				// 都不能静默丢弃，必须按损坏报错。
				const isTornTail = index === physicalLines.length - 1 && mutationResult.error.kind === "syntax";
				if (isTornTail) {
					// 通过原子发布有效前缀，丢弃这条未被确认的半写追加。
					const validPrefix = `${physicalLines.slice(0, index).join("\n")}\n`;
					await publishFileAtomically(fs, path, async (tempPath) => {
						fileResult(await fs.writeFile(tempPath, validPrefix), `Failed to stage torn-tail repair ${path}`);
					});
					return storage;
				}
				throw invalidFile(path, index + 1, mutationResult.error);
			}
			try {
				storage.applyMutation(mutationResult.value);
			} catch (error) {
				// 行本身可解析，但重放违反树规约（父链断裂、seq 断档等）：
				// 同样按「文件损坏 + 行号」报错；其余异常原样上抛。
				if (error instanceof SessionError && error.code === "invalid_entry") {
					throw invalidFile(path, index + 1, error);
				}
				throw error;
			}
		}

		// ========== 修复未以换行结尾的尾部 ==========
		// 末行是合法 JSON 但缺结尾换行：补一个 "\n"，确保下次追加从新行开始。
		if (!content.endsWith("\n")) {
			fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
		}
		return storage;
	}

	/**
	 * 派生（fork）新会话：在暂存文件中重放「header + fork 所需的全部 mutation」
	 * 构建完整新文件，原子 rename 发布后再从磁盘重新加载。
	 *
	 * Why 走原子发布而不是直接向目标逐条追加：fork 需要写入大量行，中途崩溃
	 * 会留下半成品新会话；先在 `.tmp` 中构建完整文件再 rename，目标路径一旦
	 * 出现就是完整可加载的会话。最后重新 load 而非复用暂存实例，确保返回的
	 * 内存态与磁盘内容严格一致。
	 *
	 * @param path 新会话文件路径。
	 * @param header 新会话的 v4 header（parentSessionId 指向源会话）。
	 * @param options 复制范围（branch / tree，见 ../types.ts 的 ForkOptions）。
	 * @returns 从磁盘重新加载的派生会话存储实例。
	 */
	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<JsonlSessionStorage> {
		const mutations = this.state.createForkMutations(options);
		await publishFileAtomically(this.fs, path, async (tempPath) => {
			const targetStorage = await JsonlSessionStorage.create(this.fs, tempPath, header);
			for (const mutation of mutations) {
				await targetStorage.appendMutation(mutation);
				targetStorage.applyMutation(mutation);
			}
		});
		return JsonlSessionStorage.load(this.fs, path);
	}

	/** 耐久性屏障：等待写队列排空。关闭 / 交出会话前调用，确保此前发起的写全部落盘。 */
	async drain(): Promise<void> {
		await this.tail;
	}

	/** 读取会话元数据（structuredClone 深拷贝，防止调用方篡改内部快照）。 */
	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	/** 列出全部 lane 指针（lane 名 + 当前叶子 entry id）。 */
	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	/**
	 * 在指定 entry（null = 根）处创建新 lane。写路径统一为：排队串行 → 校验 →
	 * 分配 seq 组装 mutation → 先落盘再应用到内存态。
	 */
	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateNewLane(lane);
			this.state.validateTarget(at);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	/** 把既有 lane 指针移动到指定 entry（树导航；null = 移回根），同样走「落盘 → 应用」。 */
	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			this.state.requireLane(lane);
			this.state.validateTarget(to);
			const mutation: SessionMutation = { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	/**
	 * 向指定 lane 追加 entry：存储侧补全 parentId（lane 当前叶子）、seq、
	 * timestamp 后先落盘再应用，返回补全后的完整 entry（深拷贝）。
	 *
	 * @param newEntry 已预置 id、待提交的 entry 载荷。
	 * @param lane 追加目标 lane；其当前叶子成为新 entry 的 parent。
	 * @returns 补全存储分配字段后的完整 entry。
	 */
	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const parentId = this.state.requireLane(lane);
			this.state.validateUnusedId(newEntry.id);
			const entry = {
				...structuredClone(newEntry),
				parentId,
				seq: this.state.nextSequence,
				timestamp: Date.now(),
			} as unknown as TEntry;
			const mutation: SessionMutation = { kind: "entry", lane, entry };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(entry);
		});
	}

	/**
	 * 追加 record（操作日志条目）：存储侧补全 seq / timestamp 后先落盘再应用。
	 * 额外维护单写者规约：同一 lane 同时只允许一个未收尾的操作，重复的
	 * operation_started 直接抛出 SessionError（code: "storage"）。
	 *
	 * @param newRecord 已预置 id、待提交的 record 载荷。
	 * @returns 补全存储分配字段后的完整 record。
	 */
	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			this.state.requireLane(newRecord.lane);
			this.state.validateUnusedId(newRecord.id);
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
			const mutation: SessionMutation = { kind: "record", record };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
			return structuredClone(record);
		});
	}

	/** 按 id 取单个 entry；不存在时返回 undefined（返回深拷贝）。 */
	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	/** 全会话（覆盖所有分支）按条件查询 entry；查询走内存态，返回深拷贝。 */
	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	/** 分支扫描查询：从 start 沿父链向根遍历并过滤（边界含义见 ../types.ts 的 BranchBounds）。 */
	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	/**
	 * 按条件查询 record；带 type 的重载会把返回类型收窄到对应 record 类型。
	 * 查询只读内存态（磁盘内容已在加载 / 写入时同步进来），返回深拷贝。
	 */
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

	/** 读取统一日志流：entry / record / lane / fact 按全局 seq 混编（见 ../types.ts 的 LogItem）。 */
	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	/** 读取会话名。 */
	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	/** 设置/清除会话名（fact mutation：先落盘再应用；传 undefined 清除）。 */
	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const mutation: SessionMutation = { kind: "fact", seq: this.state.nextSequence, fact: "name", name };
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	/** 读取 entry 标签。 */
	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	/** 设置/清除 entry 标签（fact mutation：先校验目标存在，再落盘应用）。 */
	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			this.state.validateTarget(id);
			const mutation: SessionMutation = {
				kind: "fact",
				seq: this.state.nextSequence,
				fact: "label",
				targetId: id,
				label,
			};
			await this.appendMutation(mutation);
			this.applyMutation(mutation);
		});
	}

	/** 读取会话累计统计（token / 费用，由 usage record 累加得出）。 */
	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	/**
	 * 并发写保护：把 operation 排到当前队尾之后执行——同一时刻至多一个写操作
	 * 在飞行，避免并发 appendFile 交错产出损坏的 JSONL 行。队尾指针吞掉结果
	 * 错误以保持链不断裂（后续写不受前一个失败影响）；错误仍经返回的
	 * result 传给发起方。
	 */
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * write-ahead 落盘：把编码后的 mutation 追加到会话文件。必须先于
	 * {@link applyMutation} 调用——追加失败时内存态保持不变，磁盘至多多出
	 * 一条半写行（由 {@link load} 的 torn-tail 修复兜底）。
	 */
	private async appendMutation(mutation: SessionMutation): Promise<void> {
		fileResult(
			await this.fs.appendFile(this.metadata.path, encodeMutation(mutation)),
			`Failed to append session ${this.metadata.path}`,
		);
	}

	/** 把已落盘的 mutation 应用到内存态（由 SessionState 校验树规约并推进状态）。 */
	private applyMutation(mutation: SessionMutation): void {
		this.state.applyMutation(mutation);
	}
}
