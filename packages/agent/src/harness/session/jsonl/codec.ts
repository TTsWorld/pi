/**
 * @file session/jsonl/codec.ts —— JSONL v4 行格式编解码器：会话数据结构 ↔ 逐行 JSON。
 *
 * @description
 * 磁盘格式由两类物理行组成（每行以 \n 结尾、恰好一个 JSON 对象）：
 * - **header 行**：文件首行，`{ kind: "header", version: 4, ... }`，承载会话
 *   id / 创建时间 / cwd / 派生来源等元数据（结构见 {@link JsonlV4Header}）；
 * - **mutation 行**：header 之后的每一行，对应一个 {@link SessionMutation}——
 *   entry（树写入）/ record（操作日志）/ lane（泳道指针迁移）/ fact（会话名、
 *   entry 标签），一级判别字段为 `kind`，全局 seq 在各行内自增。
 *
 * 版本兼容策略：codec 只产出并接受 v4；header 的 version !== 4 直接判 schema
 * 错误。旧 v3 会话须先迁移为 v4 文件再进入本模块，迁移痕迹由两个互斥的留痕
 * 字段表达——parentSessionId（v3 父路径已成功解析出的派生父会话 id）与
 * legacyParentSessionPath（无法解析出会话 id 时原样保留的 v3 父路径）。
 *
 * 解码采取「字段白名单 + 严格校验」：未知 entry / record 类型、未知 operation
 * kind、未知 fact 类型、未知 mutation kind 一律报 schema 错误——宁可拒读也不
 * 静默丢行（任何一行被跳过都会破坏 seq 连续性）。所有解码失败统一折叠为
 * {@link JsonlDecodeError}（syntax / schema 两类），由 parseHeader /
 * parseMutation 入口包装成 {@link Result} 返回，而非向调用方抛出。
 */
import { err, ok, type Result } from "../../types.ts";
import type { SessionMutation } from "../state.ts";
import type { Entry, LaneRecord } from "../types.ts";
import { JsonlDecodeError } from "./errors.ts";
import type { JsonlSessionMetadata, JsonlV4Header } from "./types.ts";

/** entry 行允许的 type 判别值白名单；行内 type 不在其中即报「未知 entry 类型」。 */
const ENTRY_TYPES = new Set<Entry["type"]>([
	"message",
	"model_change",
	"thinking_level_change",
	"active_tools_change",
	"compaction",
	"branch_summary",
	"custom",
]);
/** record 行允许的 type 判别值白名单；行内 type 不在其中即报「未知 record 类型」。 */
const RECORD_TYPES = new Set<LaneRecord["type"]>([
	"operation_started",
	"abort_requested",
	"operation_finished",
	"step_attempt",
	"tool_started",
	"queue_enqueued",
	"queue_cancelled",
	"write_deferred",
	"usage",
]);
/** operation_started 的 intent.kind 白名单（run / compaction / navigation）；未知值报错。 */
const OPERATION_KINDS = new Set(["run", "compaction", "navigation"]);

/**
 * 类型守卫：值为「纯对象」（非 null、非数组）。
 * Why：所有合法行的顶层都是 JSON 对象；数组 / 标量行没有信封字段可言。
 */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析一行 JSON 并要求顶层是对象。
 *
 * @param line 不含换行符的单行文本
 * @returns 解析出的行对象
 * @throws JsonlDecodeError JSON 语法非法 → kind "syntax"；顶层非对象 → kind "schema"。
 *   Why 区分两类：storage 层仅对「文件末行 syntax 错误」做撕裂尾行（torn tail）
 *   修复，schema 错误则说明文件结构被破坏，必须整体拒读。
 */
function parseObject(line: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch (error) {
		throw new JsonlDecodeError("syntax", "is not valid JSON", error instanceof Error ? error : undefined);
	}
	if (!isObject(value)) throw new JsonlDecodeError("schema", "is not a JSON object");
	return value;
}

/**
 * 校验必填字符串字段。
 *
 * @throws JsonlDecodeError 字段缺失或不是 string 时抛出（kind "schema"），
 *   错误消息形如 "has invalid <field>"，供 storage 层拼成「文件第 N 行 …」。
 */
function requireString(value: unknown, field: string): string {
	if (typeof value !== "string") throw new JsonlDecodeError("schema", `has invalid ${field}`);
	return value;
}

/**
 * 校验全局序列号：必须是安全整数且 > 0（seq 从 1 起单调递增，0 非法）。
 *
 * @throws JsonlDecodeError 违反上述约束时抛出（kind "schema"）。
 */
function requireSequence(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new JsonlDecodeError("schema", "has invalid seq");
	}
	return value as number;
}

/**
 * 校验 Unix 毫秒时间戳：必须是安全整数且 >= 0（允许极小的合法时钟值，但不允许负数）。
 *
 * @throws JsonlDecodeError 违反上述约束时抛出（kind "schema"）。
 */
function requireTimestamp(value: unknown): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new JsonlDecodeError("schema", "has invalid timestamp");
	}
	return value as number;
}

/**
 * 校验「可为 null 的 entry id」字段（如 parentId / leafId：null 表示根 / 空位）。
 *
 * @throws JsonlDecodeError 既不是 null 也不是 string 时抛出（kind "schema"）。
 */
function requireNullableId(value: unknown, field: string): string | null {
	if (value !== null && typeof value !== "string") {
		throw new JsonlDecodeError("schema", `has invalid ${field}`);
	}
	return value as string | null;
}

/**
 * 解码并校验文件首行（header 行）。
 *
 * @param line 首行文本（不含换行符）
 * @returns 结构完整的 {@link JsonlV4Header}
 * @throws JsonlDecodeError 行不是 header、version 非 4、派生来源字段非法或
 *   metadata 非纯对象时抛出（均为 kind "schema"）。
 */
function decodeHeader(line: string): JsonlV4Header {
	const value = parseObject(line);
	// ========== 信封校验：必须是 v4 header 行 ==========
	// Why：version 是整个文件格式的判别锚点——非 4 的文件不在本 codec 的
	// 词汇表内（v3 会话必须先迁移成 v4 文件），只能整体拒读。
	if (value.kind !== "header") throw new JsonlDecodeError("schema", "is not a header");
	if (value.version !== 4) throw new JsonlDecodeError("schema", "has unsupported session version");
	// ========== v3 → v4 迁移留痕字段 ==========
	// Why：v3 的派生父信息是文件路径；迁移时能解析出会话 id 就改写成
	// parentSessionId，解析不出则把原始路径存入 legacyParentSessionPath。
	// 两者表达同一语义，互斥——同时出现说明文件被手改或损坏，拒绝。
	const parentSessionId = value.parentSessionId;
	if (parentSessionId !== undefined && typeof parentSessionId !== "string") {
		throw new JsonlDecodeError("schema", "has invalid parentSessionId");
	}
	const legacyParentSessionPath = value.legacyParentSessionPath;
	if (legacyParentSessionPath !== undefined && typeof legacyParentSessionPath !== "string") {
		throw new JsonlDecodeError("schema", "has invalid legacyParentSessionPath");
	}
	if (parentSessionId !== undefined && legacyParentSessionPath !== undefined) {
		throw new JsonlDecodeError("schema", "has both parentSessionId and legacyParentSessionPath");
	}
	// ========== metadata：不透明载荷，只验「是纯对象」 ==========
	// Why：metadata 归应用所有（opaque），codec 不理解其内部结构，仅要求可
	// 安全地原样保存与回放，深层校验留给写入方（assertJsonSerializable）。
	const metadataValue = value.metadata;
	if (metadataValue !== undefined && !isObject(metadataValue)) {
		throw new JsonlDecodeError("schema", "has invalid metadata");
	}
	const metadata = metadataValue as JsonlV4Header["metadata"];
	// 汇总构造：必填字段逐个走强校验，可选留痕字段透传前面已验过的值。
	return {
		kind: "header",
		version: 4,
		id: requireString(value.id, "id"),
		createdAt: requireTimestamp(value.createdAt),
		cwd: requireString(value.cwd, "cwd"),
		parentSessionId,
		legacyParentSessionPath,
		metadata,
	};
}

/**
 * 解析 header 行的安全入口：把 {@link decodeHeader} 的抛错折叠为 {@link Result}。
 *
 * @param line 首行文本
 * @returns 成功返回 header；失败返回 {@link JsonlDecodeError}。
 *   Why 用 Result：调用方（repo.list / storage.load）需要区分「坏文件跳过」
 *   与「继续读取」两类策略，用返回值表达比 try/catch 更直观。
 *   非解码类异常（理论上不应出现）原样上抛，避免吞掉程序性 bug。
 */
export function parseHeader(line: string): Result<JsonlV4Header, JsonlDecodeError> {
	try {
		return ok<JsonlV4Header, JsonlDecodeError>(decodeHeader(line));
	} catch (error) {
		if (error instanceof JsonlDecodeError) return err<JsonlV4Header, JsonlDecodeError>(error);
		throw error;
	}
}

/** 把 header 序列化为文件首行（JSON + 换行符，行格式约定由所有 encode* 共同遵守）。 */
export function encodeHeader(header: JsonlV4Header): string {
	return `${JSON.stringify(header)}\n`;
}

/**
 * 由 header 行 + 文件系统信息拼出会话元数据（repo 层 list / open 使用）。
 *
 * @param header 已解码的 v4 header
 * @param path 会话 .jsonl 文件绝对路径
 * @param modifiedAt 文件修改时间（Unix 毫秒）
 * @returns 含来源格式的 {@link JsonlSessionMetadata}；sourceFormat 恒为 4
 *   —— 本模块只产出 v4 文件，读取侧才可能见到迁移而来的 3。
 */
export function metadataFromHeader(header: JsonlV4Header, path: string, modifiedAt: number): JsonlSessionMetadata {
	// Why 用条件展开而非直接赋值：避免在对象上留下显式 undefined 键，
	// 使元数据保持「缺省即无键」，方便调用方用键存在性判断可选信息。
	return {
		id: header.id,
		createdAt: header.createdAt,
		cwd: header.cwd,
		path,
		modifiedAt,
		sourceFormat: 4,
		...(header.parentSessionId === undefined ? {} : { parentSessionId: header.parentSessionId }),
		...(header.legacyParentSessionPath === undefined
			? {}
			: { legacyParentSessionPath: header.legacyParentSessionPath }),
		...(header.metadata === undefined ? {} : { metadata: header.metadata }),
	};
}

/**
 * 解析 entry 行为 {@link SessionMutation} 的 entry 变体。
 *
 * @param value 行对象（kind 已判别为 "entry"）
 * @param seq 从行内取出的全局序列号（已通过 {@link requireSequence} 校验）
 * @returns entry mutation（lane 存在与否对应两种语义，见下）
 * @throws JsonlDecodeError type / id / parentId / timestamp 等字段非法、
 *   entry 类型不在白名单、custom entry 缺 customType 时抛出（kind "schema"）。
 */
function parseEntryMutation(value: Record<string, unknown>, seq: number): Extract<SessionMutation, { kind: "entry" }> {
	// ========== 信封与判别字段 ==========
	// Why：entry 行以 type 判别具体子类型，且必须在白名单内——未知类型宁可
	// 拒读也不静默丢行。lane 可省略：省略表示「只写树、不迁移 lane 指针」
	// （fork 复制 entry 即如此），指针位置由独立的 lane 行表达。
	const lane = value.lane === undefined ? undefined : requireString(value.lane, "lane");
	const id = requireString(value.id, "id");
	const type = requireString(value.type, "entry type");
	if (!ENTRY_TYPES.has(type as Entry["type"])) {
		throw new JsonlDecodeError("schema", `has unknown entry type ${type}`);
	}
	const parentId = requireNullableId(value.parentId, "parentId");
	const timestamp = requireTimestamp(value.timestamp);
	if (type === "custom") requireString(value.customType, "customType");
	// ========== 还原 entry 本体 ==========
	// Why：剥掉行信封字段 kind / lane 后，剩余键即 entry 载荷原样透传——深层
	// 结构（message 内容等）不在 codec 层校验，交给上层 SessionState 按具体
	// 类型解释；已强校验的字段用校验后的值覆盖回填。
	const { kind: _kind, lane: _lane, ...entryFields } = value;
	const entry = { ...entryFields, id, type, parentId, seq, timestamp } as unknown as Entry;
	return lane === undefined ? { kind: "entry", entry } : { kind: "entry", lane, entry };
}

/**
 * 解析 record 行为 {@link SessionMutation} 的 record 变体。
 *
 * @param value 行对象（kind 已判别为 "record"）
 * @param seq 从行内取出的全局序列号
 * @returns record mutation
 * @throws JsonlDecodeError id / lane / type / timestamp 非法、record 类型不在
 *   白名单、operation_started 的 intent 非对象 / kind 未知、operation_finished
 *   缺 runId 时抛出（kind "schema"）。
 */
function parseRecordMutation(
	value: Record<string, unknown>,
	seq: number,
): Extract<SessionMutation, { kind: "record" }> {
	const id = requireString(value.id, "id");
	const lane = requireString(value.lane, "lane");
	const type = requireString(value.type, "record type");
	if (!RECORD_TYPES.has(type as LaneRecord["type"])) {
		throw new JsonlDecodeError("schema", `has unknown record type ${type}`);
	}
	const timestamp = requireTimestamp(value.timestamp);
	// ========== 按类型的附加校验 ==========
	// Why：只做「决定如何解释该行」的最小校验——operation_started 必须带
	// 形状合法且 kind 在白名单内的 intent；operation_finished 必须能定位到
	// 所属操作（runId）。其余字段交给上层按具体 record 类型解释。
	if (type === "operation_started") {
		if (!isObject(value.intent)) throw new JsonlDecodeError("schema", "has invalid intent");
		const operationKind = requireString(value.intent.kind, "operation kind");
		if (!OPERATION_KINDS.has(operationKind)) {
			throw new JsonlDecodeError("schema", `has unknown operation kind ${operationKind}`);
		}
	}
	if (type === "operation_finished") requireString(value.runId, "runId");
	// ========== 还原 record 本体 ==========
	// Why：record 行没有额外信封字段，剥掉 kind 后剩余键即 record 载荷原样
	// 透传；id / lane / type / seq / timestamp 以校验后的值覆盖回填。
	const { kind: _kind, ...recordFields } = value;
	return {
		kind: "record",
		record: { ...recordFields, id, lane, type, seq, timestamp } as unknown as LaneRecord,
	};
}

/**
 * 解析 lane 行：一次泳道指针迁移（新建 lane 或移动到指定叶子）。
 *
 * @throws JsonlDecodeError lane 非字符串或 leafId 非 string/null 时抛出
 *   （kind "schema"）。leafId 为 null 表示该 lane 指回根（尚无任何 entry）。
 */
function parseLaneMutation(value: Record<string, unknown>, seq: number): Extract<SessionMutation, { kind: "lane" }> {
	return {
		kind: "lane",
		seq,
		lane: requireString(value.lane, "lane"),
		leafId: requireNullableId(value.leafId, "leafId"),
	};
}

/**
 * 解析 fact 行：全局事实的设定 / 清除。
 *
 * @throws JsonlDecodeError fact 类型未知、name / label 非 string、label 缺
 *   targetId 时抛出（kind "schema"）。
 */
function parseFactMutation(value: Record<string, unknown>, seq: number): Extract<SessionMutation, { kind: "fact" }> {
	// Why：fact 行按 fact 字段二次判别——"name"（会话名）与 "label"（entry
	// 标签，须带 targetId）；字段值为 undefined 表示「清除」。未知 fact 类型
	// 直接报错，与未知 entry / record 类型的处理策略一致。
	if (value.fact === "name") {
		if (value.name !== undefined && typeof value.name !== "string") {
			throw new JsonlDecodeError("schema", "has invalid name");
		}
		return { kind: "fact", seq, fact: "name", name: value.name };
	}
	if (value.fact === "label") {
		if (value.label !== undefined && typeof value.label !== "string") {
			throw new JsonlDecodeError("schema", "has invalid label");
		}
		return {
			kind: "fact",
			seq,
			fact: "label",
			targetId: requireString(value.targetId, "targetId"),
			label: value.label,
		};
	}
	throw new JsonlDecodeError("schema", "has unknown fact type");
}

/**
 * 解码一行 mutation（抛错版内部实现，供 {@link parseMutation} 包装）。
 *
 * @param line 单行文本（不含换行符）
 * @returns 对应的 {@link SessionMutation}
 * @throws JsonlDecodeError seq 非法、kind 未知或行内字段校验失败时抛出。
 */
function decodeMutation(line: string): SessionMutation {
	const value = parseObject(line);
	const seq = requireSequence(value.seq);
	// ========== 按 kind 分派到具体解析器 ==========
	// Why：kind 是 mutation 行的一级判别字段。未知 kind 通常意味着「更新
	// 版本写出的行」或「损坏行」——本 codec 无法安全跳过（跳过任何一行都会
	// 破坏 seq 连续性），因此一律报 schema 错误。
	switch (value.kind) {
		case "entry":
			return parseEntryMutation(value, seq);
		case "record":
			return parseRecordMutation(value, seq);
		case "lane":
			return parseLaneMutation(value, seq);
		case "fact":
			return parseFactMutation(value, seq);
		default:
			throw new JsonlDecodeError("schema", "has unknown mutation kind");
	}
}

/**
 * 解析 mutation 行的安全入口：把 {@link decodeMutation} 的抛错折叠为 {@link Result}。
 *
 * @param line 单行文本
 * @returns 成功返回 mutation；失败返回 {@link JsonlDecodeError}（调用方
 *   storage.load 据此区分「末行撕裂可修复」与「结构损坏须拒读」）。
 *   非解码类异常原样上抛，避免吞掉程序性 bug。
 */
export function parseMutation(line: string): Result<SessionMutation, JsonlDecodeError> {
	try {
		return ok<SessionMutation, JsonlDecodeError>(decodeMutation(line));
	} catch (error) {
		if (error instanceof JsonlDecodeError) return err<SessionMutation, JsonlDecodeError>(error);
		throw error;
	}
}

/**
 * 把内存中的 {@link SessionMutation} 序列化为一行（JSON + 换行符）。
 *
 * @param mutation 任一变体的会话变更
 * @returns 恰好一物理行文本，与 parseMutation 严格互逆。
 */
export function encodeMutation(mutation: SessionMutation): string {
	// ========== 逆映射：内存 mutation → 行 ==========
	// Why：entry 行把 lane 提升进行信封（lane 为 undefined 时该键经
	// JSON.stringify 自然丢弃，与解码侧「缺省 lane」语义对称）；其余三种行
	// 的 mutation 对象本身就已是行格式，直接序列化即可。
	switch (mutation.kind) {
		case "entry":
			return `${JSON.stringify({ kind: "entry", lane: mutation.lane, ...mutation.entry })}\n`;
		case "record":
			return `${JSON.stringify({ kind: "record", ...mutation.record })}\n`;
		case "lane":
			return `${JSON.stringify(mutation)}\n`;
		case "fact":
			return `${JSON.stringify(mutation)}\n`;
	}
}
