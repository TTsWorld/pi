/**
 * @file 扫描式会话搜索实现（线性扫描器）
 *
 * @description
 * 定义把「类会话存储」的只读视图适配为可搜索条目流的全部构件：
 * - `ScanningReadable`：被扫描对象只需具备 getMetadata / findEntries / getLabel
 *   三个只读方法（SessionStorage 的子集），因此已打开的会话与只读加载的存储
 *   （如 JSONL 只读加载结果）都能直接被扫描；
 * - `scanReadableEntries` / `scanningEntries`：按 seq 游标分页拉取条目并投影为
 *   可搜索文本，产出 `SessionSearchCandidate` 候选流；
 * - `createScanningSessionSearch`：把一个（或惰性产出的多个）可读视图包装成
 *   {@link SessionSearch} 契约实现，对候选做线性匹配并产出带 snippet 的命中。
 *
 * 定位是「无需索引的兜底实现」：对任意存储都可搜索，代价是每次查询
 * 需要 O(全部条目) 的线性扫描。模块设计详见 docs/search.md。
 */
import type { Entry, SessionMetadata, SessionStorage } from "../harness/session/types.ts";
import type { SessionSearch, SessionSearchHit, SessionSearchOptions } from "./index.ts";

// ========== 匹配候选：条目投影后的可搜索形态 ==========

/**
 * 扫描器的匹配前输入：一条条目经文本投影后的候选形态。
 *
 * 扫描器对候选执行匹配，命中后再由 createHit 转成对外公开的命中类型；
 * 该类型属于扫描器的中间产物，也可单独用于向索引后端喂数据。
 */
export interface SessionSearchCandidate {
	/** 条目在其会话内的逻辑标识。 */
	readonly entryId: string;
	/** 条目的单调递增序号（会话日志中的位置），同时充当分页游标。 */
	readonly seq: number;
	/** canonical 条目类型。 */
	readonly type: Entry["type"];
	/** 条目时间戳。 */
	readonly timestamp: number;
	/** 由 projectText 投影出的可搜索文本（默认为条目的 JSON 序列化，可能拼接 label）。 */
	readonly text: string;
	/** 可选附加字段：默认在条目存在 label 时为 { label }，供索引后端随文档存储。 */
	readonly fields?: Record<string, unknown>;
}

// ========== 可读视图与扫描源 ==========

/**
 * 被扫描的「类会话存储」只读视图：从 {@link SessionStorage} 中 Pick 出的三个只读方法
 * （getMetadata 取会话元数据、findEntries 分页拉取条目、getLabel 取条目标签）。
 *
 * 只依赖读取能力，使完整 SessionStorage 与只读加载的轻量存储都能被同一扫描器处理，
 * 也避免扫描路径触发可能抢占 writer lease 的会话打开操作。
 */
export type ScanningReadable<TMetadata extends SessionMetadata = SessionMetadata> = Pick<
	SessionStorage<TMetadata>,
	"getMetadata" | "findEntries" | "getLabel"
>;

/**
 * 扫描源工厂：每次搜索时调用一次，惰性产出待扫描的可读视图序列。
 *
 * 相比静态数组，函数形式的源可以依据传入的 options（如由
 * ScanningSessionSearchOptions.sourceOptions 推导出的查询参数）先做会话发现 / 过滤，
 * 再逐个加载会话，而不必一次性载入全部会话。
 */
export type ScanningReadableSource<TMetadata extends SessionMetadata = SessionMetadata, TOptions = unknown> = (
	options?: TOptions,
) => AsyncIterable<ScanningReadable<TMetadata>>;

/**
 * 文本投影函数：把（会话元数据, 条目, 条目标签）投影为用于匹配的可搜索文本。
 * 默认实现见 defaultSearchText。
 */
export type ScanningSearchTextProjector<TMetadata extends SessionMetadata = SessionMetadata> = (
	metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
) => string;

/** 扫描单个可读视图时的配置。 */
export interface ScanningReadableOptions<TMetadata extends SessionMetadata = SessionMetadata> {
	/** 自定义文本投影；缺省用 defaultSearchText（JSON 序列化整个条目，可拼接 label）。 */
	projectText?: ScanningSearchTextProjector<TMetadata>;
	/** findEntries 每页拉取的条目数，缺省 100。 */
	pageSize?: number;
}

/**
 * 扫描式搜索的默认命中：在基础身份 (sessionId, entryId) 之上追加时间戳与
 * snippet 高亮片段（默认直接取候选的完整投影文本，不做截断）。
 */
export interface ScanningSessionSearchHit extends SessionSearchHit {
	/** 条目时间戳。 */
	readonly timestamp: number;
	/** 命中片段：即候选的可搜索文本。 */
	readonly snippet: string;
}

/**
 * 构造扫描式搜索（createScanningSessionSearch）的全量配置：
 * 继承单视图扫描选项，并补充扫描源参数推导与匹配 / 命中构造的定制点。
 */
export interface ScanningSessionSearchOptions<
	TMetadata extends SessionMetadata = SessionMetadata,
	TSourceOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
> extends ScanningReadableOptions<TMetadata> {
	/** 依据（已归一化为小写的）查询文本与搜索选项，推导传给扫描源工厂的参数。 */
	sourceOptions?: (text: string, options: SessionSearchOptions) => TSourceOptions | undefined;
	/** 自定义匹配谓词；缺省为不区分大小写的子串匹配（defaultMatch）。 */
	match?: (queryText: string, candidate: SessionSearchCandidate, metadata: TMetadata) => boolean;
	/** 自定义命中构造；缺省用 createDefaultScanningHit。 */
	createHit?: (metadata: TMetadata, candidate: SessionSearchCandidate) => THit;
}

// ========== 默认实现与内部工具 ==========

/**
 * 默认文本投影：JSON 序列化整个条目，存在 label 时拼接在末尾。
 *
 * 选择 JSON.stringify 是为了不依赖任何条目结构知识——条目的全部字段
 * （消息内容、工具调用等）都自然成为可搜索文本。
 */
function defaultSearchText<TMetadata extends SessionMetadata>(
	_metadata: TMetadata,
	entry: Entry,
	label: string | undefined,
): string {
	return label === undefined ? JSON.stringify(entry) : `${JSON.stringify(entry)} ${label}`;
}

/**
 * 核心扫描器：按 seq 游标分页拉取单个可读视图的条目，逐条投影为候选并产出。
 *
 * @param readable 被扫描的只读视图
 * @param metadata 该视图对应的会话元数据（作为文本投影的入参）
 * @param options 扫描配置（文本投影 / 页大小）
 * @param query 扫描范围控制：起始游标、条数上限与类型过滤
 */
async function* scanReadableEntries<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	metadata: TMetadata,
	options: ScanningReadableOptions<TMetadata>,
	query: { afterSeq?: number; limit?: number; entryTypes?: readonly Entry["type"][] } = {},
): AsyncIterable<SessionSearchCandidate> {
	const projectText = options.projectText ?? defaultSearchText;
	// 页大小优先级：调用方显式 limit > 配置 pageSize > 缺省 100。
	// 把 limit 直接当页大小，是为了「只要 N 条」时不必按整页翻页
	const pageSize = query.limit ?? options.pageSize ?? 100;
	let afterSeq = query.afterSeq ?? 0;
	// EntryQuery.type 只接受单个类型：仅当恰好过滤一个类型时才下推给存储层，
	// 多类型过滤退化为拉取后在内存中按 Set 过滤
	const entryTypes = query.entryTypes === undefined ? undefined : new Set(query.entryTypes);
	while (true) {
		// 按 oldestFirst 正序翻页：cursor.afterSeq 为排他下界（只返回 seq > afterSeq 的条目）
		const entries = await readable.findEntries({
			order: "oldestFirst",
			limit: pageSize,
			cursor: { afterSeq },
			type: query.entryTypes?.length === 1 ? query.entryTypes[0] : undefined,
		});
		if (entries.length === 0) break;
		for (const entry of entries) {
			// 内存类型过滤：类型未下推（多类型）或存储层未过滤时在此兜底
			if (entryTypes !== undefined && !entryTypes.has(entry.type)) continue;
			const label = await readable.getLabel(entry.id);
			// 产出候选：text 为投影后的可搜索文本；fields 附带 label 供索引后端使用
			yield {
				entryId: entry.id,
				seq: entry.seq,
				type: entry.type,
				timestamp: entry.timestamp,
				text: projectText(metadata, entry, label),
				fields: label === undefined ? undefined : { label },
			};
		}
		// 推进游标到本页最后一条的 seq，下一页从这里继续
		afterSeq = entries[entries.length - 1]?.seq ?? afterSeq;
		// 不满一页说明已到末尾，提前结束，避免多余一次空查询
		if (entries.length < pageSize) break;
	}
}

/**
 * 公共便捷入口：扫描单个可读视图的全部条目，产出候选流。
 *
 * 典型用途是把候选喂给外部索引后端（如 docs/search.md 中的 Elasticsearch
 * 重建索引任务）——此时只需要投影候选，不需要做匹配。
 */
export async function* scanningEntries<TMetadata extends SessionMetadata>(
	readable: ScanningReadable<TMetadata>,
	options: ScanningReadableOptions<TMetadata> = {},
): AsyncIterable<SessionSearchCandidate> {
	yield* scanReadableEntries(readable, await readable.getMetadata(), options);
}

// 把静态数组源包装成异步序列，统一两种 source 形态
async function* arraySource<TMetadata extends SessionMetadata>(
	readables: readonly ScanningReadable<TMetadata>[],
): AsyncIterable<ScanningReadable<TMetadata>> {
	yield* readables;
}

// source 既可以是静态数组，也可以是惰性工厂函数；此处归一化为 AsyncIterable
function readablesFor<TMetadata extends SessionMetadata, TSourceOptions>(
	source: readonly ScanningReadable<TMetadata>[] | ScanningReadableSource<TMetadata, TSourceOptions>,
	options: TSourceOptions | undefined,
): AsyncIterable<ScanningReadable<TMetadata>> {
	return typeof source === "function" ? source(options) : arraySource(source);
}

// 默认匹配：查询文本已归一化为小写，对候选 text 做不区分大小写的子串包含判断
function defaultMatch(queryText: string, candidate: SessionSearchCandidate): boolean {
	return candidate.text.toLowerCase().includes(queryText);
}

/**
 * 取消检查：signal 已中止则抛出。
 *
 * 优先透传 signal.reason 本身；reason 不是 Error 时构造一个 name 为
 * "AbortError" 的错误，与 DOM AbortController 约定保持一致，
 * 便于调用方通过 error.name 识别取消。
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	if (signal.reason instanceof Error) throw signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	throw error;
}

// 默认命中构造：sessionId 取自会话元数据，snippet 直接复用候选投影文本
function createDefaultScanningHit<TMetadata extends SessionMetadata>(
	metadata: TMetadata,
	candidate: SessionSearchCandidate,
): ScanningSessionSearchHit {
	return {
		sessionId: metadata.id,
		entryId: candidate.entryId,
		timestamp: candidate.timestamp,
		snippet: candidate.text,
	};
}

// ========== 对外工厂：组装 SessionSearch 实现 ==========

/**
 * 把一个或多个扫描源包装成 {@link SessionSearch} 契约实现。
 *
 * 每次搜索会遍历源产出的每个可读视图，线性扫描其全部条目并逐个产出命中；
 * 可通过 options 定制文本投影、匹配谓词与命中构造。
 *
 * @param source 待扫描的可读视图数组，或按需惰性产出可读视图的源工厂
 * @param options 扫描配置（投影 / 匹配 / 命中构造 / 源参数推导 / 页大小）
 * @returns 满足 SessionSearch 契约的搜索实例
 * @throws 源产出重复 sessionId 的可读视图时抛错——命中身份是 (sessionId, entryId)，
 *   重复会话会使同一命中身份出现多次，因此必须 fail fast；
 *   searchOptions.signal 中止时抛出 AbortError（或 signal.reason）
 */
export function createScanningSessionSearch<
	TMetadata extends SessionMetadata,
	TSourceOptions = unknown,
	THit extends SessionSearchHit = ScanningSessionSearchHit,
>(
	source: readonly ScanningReadable<TMetadata>[] | ScanningReadableSource<TMetadata, TSourceOptions>,
	options: ScanningSessionSearchOptions<TMetadata, TSourceOptions, THit> = {},
): SessionSearch<THit> {
	// 命中构造兜底：未定制 createHit 时用默认构造，再断言为 THit
	// （默认命中结构与 THit 的对应关系由调用方的类型参数负责）
	const createHit =
		options.createHit ??
		((metadata: TMetadata, candidate: SessionSearchCandidate) =>
			createDefaultScanningHit(metadata, candidate) as unknown as THit);
	return {
		async *search(text: string, searchOptions: SessionSearchOptions = {}): AsyncIterable<THit> {
			// ========== 查询归一化与短路 ==========
			// 查询统一为小写并去首尾空白；空查询、非正 limit、空类型白名单均无结果，直接返回
			const normalizedText = text.trim().toLowerCase();
			if (!normalizedText || (searchOptions.limit !== undefined && searchOptions.limit <= 0)) return;
			if (searchOptions.entryTypes?.length === 0) return;
			let hitCount = 0;
			// 会话去重表：同一 sessionId 出现两次即视为源错误，立即失败
			const seenSessionIds = new Set<string>();
			const entryTypes = searchOptions.entryTypes === undefined ? undefined : new Set(searchOptions.entryTypes);
			// 先依据归一化后的查询推导源参数（如把关键词传给会话发现接口做粗筛），再打开源
			const sourceOptions = options.sourceOptions?.(normalizedText, searchOptions);
			// ========== 逐会话扫描 ==========
			for await (const readable of readablesFor(source, sourceOptions)) {
				// 每取到一个新会话先检查取消，避免中止后还继续加载会话
				throwIfAborted(searchOptions.signal);
				const metadata = await readable.getMetadata();
				if (seenSessionIds.has(metadata.id)) throw new Error(`Duplicate sessionId: ${metadata.id}`);
				seenSessionIds.add(metadata.id);
				for await (const candidate of scanReadableEntries(readable, metadata, options, {
					entryTypes: searchOptions.entryTypes,
				})) {
					// ========== 逐条目匹配 ==========
					// 每个候选产出前检查取消，保证 search-as-you-type 能及时中断
					throwIfAborted(searchOptions.signal);
					// 类型过滤已在扫描层尽量下推，这里再校验一次，确保结果严格符合 entryTypes
					if (entryTypes !== undefined && !entryTypes.has(candidate.type)) continue;
					const matches =
						options.match?.(normalizedText, candidate, metadata) ?? defaultMatch(normalizedText, candidate);
					if (!matches) continue;
					yield createHit(metadata, candidate);
					hitCount += 1;
					// 达到 limit 即整体返回：满足「返回不多于 limit」的契约，剩余会话不再扫描
					if (searchOptions.limit !== undefined && hitCount >= searchOptions.limit) return;
				}
			}
		},
	};
}
