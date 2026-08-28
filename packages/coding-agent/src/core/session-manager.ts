/**
 * @file session-manager.ts —— 会话管理器：追加式 JSONL 树状会话持久化
 *
 * @description
 * 本文件实现 `SessionManager` 及配套的纯函数工具集，负责把一次编码会话
 * （用户/助手消息、模型切换、思考级别切换、压缩摘要、分支摘要、书签等）
 * 以 JSONL（每行一个 JSON entry）的形式追加写入磁盘文件。
 *
 * 核心设计：
 * - 树状结构：每个 entry 带 `id` / `parentId`，首个 entry 的 parentId 为 null（根）；
 *   "leaf 指针"（leafId）标记当前位置，追加 entry 即成为当前 leaf 的子节点；
 * - 只追加不改写：`branch()` 只把 leaf 指针移回历史 entry，旧分支原样保留，
 *   因此天然支持 fork / clone / 树导航；
 * - 上下文解析：`buildSessionContext()` 沿 root→leaf 路径收集消息，
 *   并处理压缩（compaction）摘要对旧消息的替换；
 * - 版本迁移：读取旧版本文件时按 v1→v2→v3 链式就地迁移；
 * - 会话发现：`SessionManager.list()/listAll()` 并发扫描目录，
 *   只做有界的文件头扫描即可恢复会话元信息。
 *
 * 依赖关系：
 * - `@earendil-works/pi-agent-core`：AgentMessage 消息类型；
 * - `@earendil-works/pi-ai`：Message / TextContent / ImageContent / Usage 及 uuidv7；
 * - `../config.ts`：默认 agent 目录与会话目录位置；
 * - `./messages.ts`：构造压缩/分支摘要等运行时消息的工厂函数。
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ImageContent, type Message, type TextContent, type Usage, uuidv7 } from "@earendil-works/pi-ai";
import { randomUUID } from "crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { StringDecoder } from "string_decoder";
import { APP_NAME, getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	type BashExecutionMessage,
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "./messages.ts";

/** 当前会话文件格式版本；读到更低版本时触发链式迁移 */
export const CURRENT_SESSION_VERSION = 3;

/** 会话文件头：JSONL 首行，描述会话身份与来源（fork 时 parentSession 指向父会话文件） */
export interface SessionHeader {
	type: "session";
	version?: number; // v1 会话没有该字段（按 version 1 处理）
	/** 会话唯一 id（同时用于 --session 定位） */
	id: string;
	/** 会话创建时间（ISO 字符串） */
	timestamp: string;
	/** 会话启动时的工作目录 */
	cwd: string;
	/** 父会话文件路径；仅 fork/分支产生的新会话才有 */
	parentSession?: string;
}

/** 新建会话选项：自定义会话 id / 记录父会话路径 */
export interface NewSessionOptions {
	/** 用户指定的会话 id（须通过 assertValidSessionId 校验） */
	id?: string;
	/** 父会话文件路径（fork 场景记录来源） */
	parentSession?: string;
}

/**
 * 会话 entry 公共基础字段。
 * id/parentId 构成树状结构的父子链，timestamp 用于排序与展示。
 */
export interface SessionEntryBase {
	/** entry 类型判别字段 */
	type: string;
	/** 本 entry 的短 id（会话内唯一） */
	id: string;
	/** 父 entry 的 id；null 表示根节点 */
	parentId: string | null;
	/** 追加时间（ISO 字符串） */
	timestamp: string;
}

/** 消息 entry：承载一条 AgentMessage（user / assistant / toolResult / custom 等） */
export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
}

/** 思考级别切换 entry：记录用户切换 thinking level 的历史 */
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

/** 模型切换 entry：记录 provider + modelId，沿路径重放可还原当前模型 */
export interface ModelChangeEntry extends SessionEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

/**
 * 压缩 entry：上下文过长时把旧消息摘要成一段 summary。
 * firstKeptEntryId 起的 entry 原样保留，之前的被摘要替换（见 buildContextEntries）。
 */
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
	type: "compaction";
	/** 压缩生成的摘要文本（作为一条摘要消息注入上下文） */
	summary: string;
	/** 压缩后保留的首个 entry id；它之前的 entry 被摘要替换 */
	firstKeptEntryId: string;
	/** 压缩前的 token 用量（用于展示/统计） */
	tokensBefore: number;
	/** 扩展专有数据（如 ArtifactIndex、结构化压缩的版本标记） */
	details?: T;
	/** 生成该摘要的 LLM 调用的用量信息（如有） */
	usage?: Usage;
	/** 为 true 表示由扩展生成；undefined/false 表示 pi 自身生成（向后兼容） */
	fromHook?: boolean;
}

/**
 * 分支摘要 entry：branchWithSummary() 丢弃旧分支前，
 * 把被放弃路径（自 fromId 起）的内容总结成一条摘要挂在树上。
 */
export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
	type: "branch_summary";
	/** 被放弃路径的起点（放弃前的 leaf） */
	fromId: string;
	/** 被放弃对话的摘要文本 */
	summary: string;
	/** 扩展专有数据（不发送给 LLM） */
	details?: T;
	/** 生成该摘要的 LLM 调用的用量信息（如有） */
	usage?: Usage;
	/** 为 true 表示由扩展生成，false 表示 pi 自身生成 */
	fromHook?: boolean;
}

/**
 * 扩展自定义 entry：供扩展把自身专有数据存进会话。
 * 用 customType 标识属于你扩展的 entry。
 *
 * 用途：跨会话重载持久化扩展状态。重载时扩展可按 customType 扫描 entry
 * 并重建内部状态。
 *
 * 不参与 LLM 上下文（buildSessionContext 会忽略它）。
 * 若要向上下文注入内容，请使用 CustomMessageEntry。
 */
export interface CustomEntry<T = unknown> extends SessionEntryBase {
	type: "custom";
	/** 扩展自定义的类型标识 */
	customType: string;
	/** 扩展自定义数据（自由结构） */
	data?: T;
}

/** 标签 entry：用户在某个 entry 上打的标签/书签（label 为空表示清除）。 */
export interface LabelEntry extends SessionEntryBase {
	type: "label";
	/** 被打标签的目标 entry id */
	targetId: string;
	/** 标签名；undefined/空串表示清除该标签 */
	label: string | undefined;
}

/** 会话元信息 entry（如用户自定义的会话显示名）。 */
export interface SessionInfoEntry extends SessionEntryBase {
	type: "session_info";
	/** 会话显示名 */
	name?: string;
}

/**
 * 扩展自定义消息 entry：供扩展向 LLM 上下文注入消息。
 * 用 customType 标识属于你扩展的 entry。
 *
 * 与 CustomEntry 不同，它【会】参与 LLM 上下文：
 * content 在 buildSessionContext() 中被转换为一条用户消息；
 * 扩展专有元数据放 details（不发送给 LLM）。
 *
 * display 控制 TUI 渲染方式：
 * - false：完全隐藏
 * - true：以区别于用户消息的样式渲染
 */
export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
	type: "custom_message";
	/** 扩展自定义的类型标识 */
	customType: string;
	/** 注入上下文的消息内容（构建时转为用户消息） */
	content: string | (TextContent | ImageContent)[];
	details?: T;
	/** TUI 是否渲染 */
	display: boolean;
}

/** 会话 entry 联合类型——带 id/parentId 树结构（由 SessionManager 的"读"方法返回） */
export type SessionEntry =
	| SessionMessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry;

/** 文件中的原始 entry（含 session 头） */
export type FileEntry = SessionHeader | SessionEntry;

/** getTree() 返回的树节点——会话结构的防御性拷贝 */
export interface SessionTreeNode {
	/** 对应的会话 entry */
	entry: SessionEntry;
	/** 子节点（getTree 返回时已按时间戳升序排列） */
	children: SessionTreeNode[];
	/** 该 entry 当前生效的标签（若有） */
	label?: string;
	/** 该 entry 最近一次标签变更的时间戳（若有） */
	labelTimestamp?: string;
}

/** 解析后的 LLM 上下文：沿 root→leaf 路径重放得到的消息与设置快照 */
export interface SessionContext {
	/** 发送给 LLM 的消息序列（含压缩/分支摘要消息） */
	messages: AgentMessage[];
	/** 路径上最后一次生效的思考级别（默认 "off"） */
	thinkingLevel: string;
	/** 路径上最后一次生效的模型；null 表示无记录 */
	model: { provider: string; modelId: string } | null;
}

/** 会话列表项：list/listAll 返回的摘要信息（供会话选择器展示） */
export interface SessionInfo {
	path: string;
	id: string;
	/** 会话启动时的工作目录；旧版会话为空字符串 */
	cwd: string;
	/** 从 session_info entry 读取的用户自定义显示名 */
	name?: string;
	/** 父会话文件路径（若本会话是 fork 出来的） */
	parentSessionPath?: string;
	/** 创建时间（取头部 timestamp） */
	created: Date;
	/** 最近活跃时间（见 buildSessionInfo 的三级回退策略） */
	modified: Date;
	/** 消息 entry 总数 */
	messageCount: number;
	/** 首条用户消息文本（无消息时为占位符） */
	firstMessage: string;
	/** 全部用户/助手消息文本拼接（供会话搜索/模糊匹配） */
	allMessagesText: string;
}

/**
 * SessionManager 的只读子集类型：仅暴露"读"方法，
 * 供扩展等外部代码安全地查询会话而不产生副作用。
 */
export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

/** 生成会话 id：uuidv7（时间有序，文件名可按创建时间自然排序） */
function createSessionId(): string {
	return uuidv7();
}

/**
 * 校验用户显式指定的会话 id（--session 选项）：
 * 只允许字母/数字及 '-'、'_'、'.'，且首尾必须是字母数字，
 * 防止 id 逸出为路径（如包含 '/' 或 '..'）。
 */
export function assertValidSessionId(id: string): void {
	// 正则语义：首尾必须是字母数字，中间允许 . _ -；拒绝空串与含路径分隔符的输入
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** 生成 8 位十六进制短 id（随机截取并做冲突检查：与 byId 中现有 id 比对） */
function generateId(byId: { has(id: string): boolean }): string {
	// 最多尝试 100 次；8 个十六进制位（32 bit）随机串的碰撞概率极低
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// 极端情况下连续冲突 100 次时，退化为使用完整 UUID
	return randomUUID();
}

/** 迁移 v1 → v2：补上 id/parentId 树结构（v1 是纯线性列表，按顺序串成链）。就地修改。 */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		// v1 没有树概念：按文件行序给每个 entry 生成 id，并串成单链（父 = 前一个）
		entry.id = generateId(ids);
		entry.parentId = prevId;
		prevId = entry.id;

		// 把 compaction 的 firstKeptEntryIndex（数组下标）改写为 firstKeptEntryId（entry id），
		// 迁移补出的 id 让下标定位不再可靠
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** 迁移 v2 → v3：把 hookMessage 角色改名为 custom。就地修改。 */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// 改写带 hookMessage 角色的消息 entry
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/**
 * 把 entry 序列逐步迁移到当前版本（按版本链依次应用）。
 * 就地修改；若有任一迁移被实际执行则返回 true（调用方据此重写文件）。
 */
function migrateToCurrentVersion(entries: FileEntry[]): boolean {
	const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
	// v1 会话头部没有 version 字段，缺失时按 1 处理
	const version = header?.version ?? 1;

	if (version >= CURRENT_SESSION_VERSION) return false;

	// 版本链式应用：v1 → v2 → v3，跨多版本一次迁移到位
	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);

	return true;
}

/** 仅供测试使用而导出 */
export function migrateSessionEntries(entries: FileEntry[]): void {
	migrateToCurrentVersion(entries);
}

/** 仅供 compaction.test.ts 使用而导出：按行解析会话文件内容为 entry 数组 */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// 跳过无法解析的坏行（保持容错，不中断加载）
		}
	}

	return entries;
}

/** 取 entry 序列中最后一个（最新的）compaction entry；没有则返回 null */
export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	// 逆序扫描：压缩 entry 通常在尾部，第一个命中的即最新
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/** 建立 id → entry 的索引 Map；传入 byId 时直接复用（避免重复建索引） */
function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

/**
 * 计算从根到 leaf 的 entry 路径（树主干）。
 * - leafId 为 null → 空路径（leaf 指向"根之前"，会话尚无内容）；
 * - 未指定 leafId → 默认取 entries 最后一项（旧文件没有 leaf 指针时的兼容行为）；
 * - 沿 parentId 逐级回溯到根后 reverse，得到 root→leaf 顺序。
 */
function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	// 显式 null：路径为空
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	// 兜底：未给 leafId 时用最后一个 entry 当 leaf
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	// 从 leaf 沿 parentId 逐级回溯收集（此时顺序为 leaf→root），再反转成 root→leaf
	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

/** 沿路径重放设置类 entry，得到当前生效的 thinkingLevel 与 model（以路径上最后一次为准） */
function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	// 默认思考级别为 off；model 为 null 表示路径上无记录（沿用外部默认）
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			// 旧会话没有 model_change entry，用 assistant 消息自带的模型信息兜底
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * 把选中的会话 entry 投影为发送给 LLM/运行时的消息。
 * 普通 custom entry 只用于展示/状态，不参与上下文（返回空数组）。
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = entry.message;
		// 会话文件解析时不做 schema 校验；旧版本、fork 或手工编辑过的文件
		// 可能包含 content 为 null/缺失的消息，这里统一补成空数组
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	// 扩展消息：转换为运行时 CustomMessage 参与上下文
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	// 分支摘要 / 压缩摘要：各自转换为一条摘要消息注入上下文
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	// 其余类型（label / session_info / custom 等）不产生上下文消息
	return [];
}

/**
 * 构建当前生效的、感知压缩（compaction-aware）的 entry 列表。
 *
 * 先沿当前 leaf 路径取主干；若路径上存在压缩 entry，则结果为：
 * 压缩 entry 本身（其 summary 即被摘要掉的旧消息）+ 从 firstKeptEntryId
 * 起保留的 entry + 压缩点之后的全部 entry。更早的被摘要 entry 全部省略。
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	// 取路径上最后一个（最新的）压缩 entry
	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	// 无压缩：整条路径直接作为上下文
	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	// 压缩 entry 自身放在最前，代表被摘要掉的历史
	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	// 收集压缩点之前、自 firstKeptEntryId 开始的保留段
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	// 压缩点之后的 entry 原样接上
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

/**
 * 用树遍历构建会话上下文（messages + thinkingLevel + model）。
 * 给定 leafId 时从该 entry 回溯到根；沿途处理压缩与分支摘要。
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const messages = buildContextEntries(entries, leafId, byId).flatMap(sessionEntryToContextMessages);
	return { messages, thinkingLevel, model };
}

/**
 * 计算某个 cwd 对应的默认会话目录。
 * 把 cwd 编码成安全的目录名（路径分隔符等替换为 '-'），
 * 形如 ~/.pi/agent/sessions/--Users-foo-project--。
 */
function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	// 首尾以 "--" 包裹、内部路径分隔符替换为 '-'，得到无歧义的安全目录名
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolvedAgentDir, "sessions", safePath);
}

/** 同 getDefaultSessionDirPath，但目录不存在时会递归创建（对外默认入口） */
export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	// 首次在某个 cwd 启动时目录尚不存在，这里负责创建
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
	}
	return sessionDir;
}

/** 同步全量读文件的块大小（1 MiB，会话文件通常不大，足够用） */
const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
/** 只读文件头时的块大小（4 KiB，头部一般一行即可读完） */
const SESSION_HEADER_READ_BUFFER_SIZE = 4096;
/** 给同步头部扫描设上界（1 MiB）：既容忍超长 cwd / 自定义元数据，又不会卡死在异常大文件上。 */
const MAX_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;

/** 头部扫描超过 MAX_SESSION_HEADER_SCAN_BYTES 上限时抛出（open() 会捕获并降级为全量加载） */
class SessionHeaderScanLimitError extends Error {
	constructor(filePath: string) {
		super(`Session header exceeds ${MAX_SESSION_HEADER_SCAN_BYTES}-byte scan limit: ${filePath}`);
		this.name = "SessionHeaderScanLimitError";
	}
}

/** 解析单行 JSON entry；空行或坏行返回 null */
function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// 跳过坏行（会话文件必须能容忍手工编辑造成的局部损坏）
		return null;
	}
}

/** 仅供测试使用而导出：从文件同步加载全部 entry */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		// 手写分块读取而非 readline：会话加载是同步热路径；
		// StringDecoder 负责处理跨块的 UTF-8 多字节字符边界
		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			// 读到 0 字节即 EOF
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		// flush 解码器残余字节；文件末段没有换行符的内容也要尝试解析
		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// 校验会话头：首行必须是带字符串 id 的 session 头，否则视为非法文件返回空
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

/**
 * 在搜索首个可解析 entry 的过程中检查一行物理文本。
 * 跳过空行/坏行，与 loadEntriesFromFile() 行为保持一致。
 * 返回值三态：undefined = 继续扫描；null = 解析成功但不是会话头；头对象 = 找到头部。
 */
function parseSessionHeaderCandidate(line: string): SessionHeader | null | undefined {
	if (!line.trim()) return undefined;
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof (entry as { id?: unknown }).id !== "string") return null;
	return entry;
}

/**
 * 只读文件头部（首行 session 头），最多扫描 MAX_SESSION_HEADER_SCAN_BYTES 字节。
 * 找到头部即提前返回——发现（discovery）阶段无需读完整个大文件。
 * 超限时抛 SessionHeaderScanLimitError。
 */
function readSessionHeader(filePath: string): SessionHeader | null {
	const fd = openSync(filePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_SIZE);
		// 头部那一行可能横跨多个读块：片段先累积进 lineChunks，遇到换行再整体判定
		const lineChunks: string[] = [];
		let scannedBytes = 0;

		// 有界扫描循环：最多读 MAX_SESSION_HEADER_SCAN_BYTES 字节
		while (scannedBytes < MAX_SESSION_HEADER_SCAN_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_SCAN_BYTES - scannedBytes);
			const bytesRead = readSync(fd, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				// 文件读完仍没遇到换行：把残余内容当最后一行判定
				lineChunks.push(decoder.end());
				return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
			}
			scannedBytes += bytesRead;

			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = chunk.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				lineChunks.push(chunk.slice(lineStart, newlineIndex));
				const header = parseSessionHeaderCandidate(lineChunks.join(""));
				// 找到头部（或确认首个 entry 不是头部）即可立即返回，无需读完文件
				if (header !== undefined) return header;
				lineChunks.length = 0;
				lineStart = newlineIndex + 1;
				newlineIndex = chunk.indexOf("\n", lineStart);
			}
			lineChunks.push(chunk.slice(lineStart));
		}

		// 探测 EOF：若头部恰好在扫描上限处结束且无换行符，仍允许接受；
		// 只要还有一个多余字节就视为超出有界扫描，抛错
		const probe = Buffer.allocUnsafe(1);
		if (readSync(fd, probe, 0, probe.length, null) === 0) {
			lineChunks.push(decoder.end());
			return parseSessionHeaderCandidate(lineChunks.join("")) ?? null;
		}
		throw new SessionHeaderScanLimitError(filePath);
	} finally {
		closeSync(fd);
	}
}

/** readSessionHeader 的容错包装：任何异常都返回 null（仅用于目录发现） */
function readSessionHeaderForDiscovery(filePath: string): SessionHeader | null {
	try {
		return readSessionHeader(filePath);
	} catch {
		// 发现流程尽力而为：不可读或超限的文件不算会话，
		// 且单个损坏文件不能影响其他会话被发现
		return null;
	}
}

/** 安全读取头部 cwd 字段（历史文件可能缺失或类型不符） */
function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

/** 判断头部记录的 cwd 是否与给定目录解析后一致（空/缺失视为不匹配） */
function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** 仅供测试使用而导出：找目录中 mtime 最新的会话文件 */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		// 流水线：过滤 .jsonl → 只读头部 → 按 cwd 过滤 → stat mtime → 按最新排序
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, header: readSessionHeaderForDiscovery(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		// 取 mtime 最新的一个；目录为空或全不匹配时返回 null
		return files[0]?.path || null;
	} catch {
		// 目录访问失败或 stat 竞态（文件被并发删除）时，最近会话发现不可用
		return null;
	}
}

/** 类型守卫：消息是否带 content 字段（老版本消息可能缺失，需先 narrowing 再取 content） */
function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

/** 提取消息中的纯文本：字符串直取；分块数组只取 text 块并拼接 */
function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

/**
 * 计算 entry 的"活跃时间"（毫秒时间戳）：优先用消息自带的 timestamp，
 * 否则回退到 entry.timestamp；无法解析时返回 undefined。
 */
function getMessageActivityTime(entry: SessionMessageEntry): number | undefined {
	const message = entry.message;
	// 只统计用户/助手消息的活跃时间（工具结果等不算一次交互）
	if (!isMessageWithContent(message)) return undefined;
	if (message.role !== "user" && message.role !== "assistant") return undefined;

	// 消息自带的毫秒时间戳优先（比 entry 时间更贴近真实交互时刻）
	const msgTimestamp = (message as { timestamp?: number }).timestamp;
	if (typeof msgTimestamp === "number") {
		return msgTimestamp;
	}

	// 回退到 entry.timestamp；无法解析（NaN）则返回 undefined
	const t = new Date(entry.timestamp).getTime();
	return Number.isNaN(t) ? undefined : t;
}

/**
 * 流式读取单个会话文件，构建列表用的 SessionInfo 摘要
 * （消息数、首条用户消息、全部消息文本、最近活跃时间等）。
 * 任何异常返回 null——会话列表对坏文件必须容错。
 */
async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const stats = await stat(filePath);
		let header: SessionHeader | null = null;
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let lastActivityTime: number | undefined;

		// 逐行流式读取：会话文件可能很大，列表场景只需边读边统计摘要信息
		const rl = createInterface({
			input: createReadStream(filePath, { encoding: "utf8" }),
			crlfDelay: Infinity,
		});

		for await (const line of rl) {
			const entry = parseSessionEntryLine(line);
			if (!entry) continue;

			// 首个有效 entry 必须是 session 头，否则该文件不是合法会话
			if (!header) {
				if (entry.type !== "session") return null;
				header = entry;
				continue;
			}

			// 提取会话名：取最后一次设置；显式设空即清除名字
			if (entry.type === "session_info") {
				name = entry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const activityTime = getMessageActivityTime(entry);
			if (typeof activityTime === "number") {
				lastActivityTime = Math.max(lastActivityTime ?? 0, activityTime);
			}

			const message = entry.message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			// 首条用户消息用作会话列表的预览
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		if (!header) return null;

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		// "修改时间"取最近一条消息的活跃时间，缺省退到头部时间，再退到文件 mtime
		const modified =
			typeof lastActivityTime === "number" && lastActivityTime > 0
				? new Date(lastActivityTime)
				: !Number.isNaN(headerTime)
					? new Date(headerTime)
					: stats.mtime;

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

/** 会话列表加载进度回调：(已加载数, 总数) */
export type SessionListProgress = (loaded: number, total: number) => void;

/** 并发加载会话摘要的上限（防止一次性打开过多文件句柄） */
const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

/**
 * 以固定并发（≤ MAX_CONCURRENT_SESSION_INFO_LOADS）加载一批会话文件的摘要。
 * 结果按下标写回保持原始顺序；单个文件失败记为 null，不中断整批。
 */
async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	// 结果按下标存放，保证与输入文件顺序一致（与并发完成顺序无关）
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	// 手写并发池：每完成一个任务就补位启动下一个，而不是一次性 Promise.all
	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				// 单个文件失败不传染：记为 null，整批继续
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		// 持续补位直到全部启动；用 Promise.race 等待任意一个完成后继续补位
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

/**
 * 列出某目录下全部 .jsonl 会话的摘要信息。
 * progressOffset/progressTotal 供多目录聚合场景合并进度。
 */
async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		// 多目录聚合时用外部传入的 total，保证进度分母覆盖所有目录
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// 出错时返回空列表（目录读取失败等不影响调用方）
	}

	return sessions;
}

/**
 * 以 JSONL 文件管理"追加式树状"会话。
 *
 * 每个 entry 都有 id 和 parentId，构成一棵树；"leaf" 指针标记当前位置：
 * 追加 entry 即成为当前 leaf 的子节点；branch() 把 leaf 指针移回更早的
 * entry，即可在不修改任何历史记录的情况下开启新分支。
 *
 * 用 buildSessionContext() 获取发给 LLM 的最终消息列表——
 * 它沿 root→当前 leaf 的路径解析，并处理压缩摘要。
 */
export class SessionManager {
	/** 当前会话 id */
	private sessionId: string = "";
	/** 当前会话文件路径；尚未确定时为 undefined */
	private sessionFile: string | undefined;
	/** 会话目录（新建会话/分支文件的落盘位置） */
	private sessionDir: string;
	/** 本会话的工作目录 */
	private cwd: string;
	/** 是否持久化到磁盘（false = 纯内存会话） */
	private persist: boolean;
	/** 文件是否已落盘：首次全量写出后置 true，之后转为纯追加写 */
	private flushed: boolean = false;
	/** 文件内全部 entry（含首行 session 头） */
	private fileEntries: FileEntry[] = [];
	/** id → entry 索引，O(1) 查找 */
	private byId: Map<string, SessionEntry> = new Map();
	/** targetId → 当前生效标签（由 label entry 增量解析而来） */
	private labelsById: Map<string, string> = new Map();
	/** targetId → 最近一次标签变更时间戳 */
	private labelTimestampsById: Map<string, string> = new Map();
	/** leaf 指针：当前分支末端的 entry id；null 表示在根之前（下次追加会创建根） */
	private leafId: string | null = null;

	/** 私有构造器：统一经静态工厂 create/open/continueRecent/inMemory/forkFrom 创建 */
	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = normalizePath(sessionDir);
		this.persist = persist;
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		// 给了文件路径则打开已有会话；否则新建会话
		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	// =========================================================================
	// 会话文件与生命周期
	// =========================================================================

	/** 切换到另一个会话文件（用于 resume 与分支） */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	/**
	 * 绑定会话文件并加载内容：文件存在则读取（或复用预加载结果）→ 迁移 → 建索引；
	 * 文件不存在则新建会话但保留显式路径。
	 */
	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		this.sessionFile = resolvePath(sessionFile);
		if (existsSync(this.sessionFile)) {
			this.fileEntries = preloadedFileEntries ?? loadEntriesFromFile(this.sessionFile);

			// 文件为空 → 初始化一个合法会话头；
			// 非空但解析不出 pi 会话 → 报错且不改动文件内容
			if (this.fileEntries.length === 0) {
				const explicitPath = this.sessionFile;
				// 非空却解析不出 entry：内容不是合法会话，拒绝且不覆盖
				if (statSync(explicitPath).size > 0) {
					throw new Error(`Session file is not a valid ${APP_NAME} session: ${explicitPath}`);
				}
				this.newSession();
				this.sessionFile = explicitPath;
				this._rewriteFile();
				this.flushed = true;
				return;
			}

			const header = this.fileEntries.find((e) => e.type === "session") as SessionHeader | undefined;
			// 头部缺失（异常文件）时生成新 id 继续用，不阻断加载
			this.sessionId = header?.id ?? createSessionId();

			// 旧版本文件迁移后需要全量重写回盘
			if (migrateToCurrentVersion(this.fileEntries)) {
				this._rewriteFile();
			}

			this._buildIndex();
			this.flushed = true;
		} else {
			const explicitPath = this.sessionFile;
			this.newSession();
			this.sessionFile = explicitPath; // 保留 --session 传入的显式路径（newSession 会生成默认文件名）
		}
	}

	/**
	 * 新建会话：重置内存状态并生成新头部。持久化模式下按
	 * `<时间戳>_<会话id>.jsonl` 生成新文件名（文件暂不写盘，由 _persist 决定落盘时机）。
	 */
	newSession(options?: NewSessionOptions): string | undefined {
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		this.sessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		// 新头部总是以当前版本号写入，cwd 记录本会话的工作目录
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: options?.parentSession,
		};
		// 内存状态整体重置：只剩头部，leaf 回到根之前，待落盘标记清除
		this.fileEntries = [header];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		this.flushed = false;

		if (this.persist) {
			// 把 ISO 时间戳里的 : 和 . 替换成 -，避免文件名非法字符
			const fileTimestamp = timestamp.replace(/[:.]/g, "-");
			this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
		}
		// 返回新会话文件路径（纯内存会话为 undefined）
		return this.sessionFile;
	}

	/** 从 fileEntries 重建全部索引；leaf 取追加顺序的最后一个 entry */
	private _buildIndex(): void {
		// 全量重建：先清空再按文件顺序扫描，保证索引与文件内容一致
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;
		for (const entry of this.fileEntries) {
			if (entry.type === "session") continue;
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			// 标签以最后一条 label entry 为准：非空设置、空值清除
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	/** 全量重写会话文件（仅初始化/迁移时使用；常规写入走 _persist 的追加路径） */
	private _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		// "w" 模式截断重写：仅初始化/迁移时使用，正常流程不会走到这里
		const fd = openSync(this.sessionFile, "w");
		try {
			for (const entry of this.fileEntries) {
				writeFileSync(fd, `${JSON.stringify(entry)}\n`);
			}
		} finally {
			closeSync(fd);
		}
	}

	/** 是否持久化到磁盘 */
	// =========================================================================
	// 基础信息读取
	// =========================================================================

	/** 是否持久化到磁盘 */
	isPersisted(): boolean {
		return this.persist;
	}

	/** 会话的工作目录（已 resolve，记录在头部） */
	getCwd(): string {
		return this.cwd;
	}

	/** 会话文件所在目录 */
	getSessionDir(): string {
		return this.sessionDir;
	}

	/** 是否使用按 cwd 推导的默认会话目录（而非用户自定目录） */
	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	/** 当前会话 id */
	getSessionId(): string {
		return this.sessionId;
	}

	/** 当前会话文件路径；纯内存会话返回 undefined */
	getSessionFile(): string | undefined {
		return this.sessionFile;
	}

	/**
	 * 持久化单个 entry。核心策略：出现第一条 assistant 消息之前不落盘，
	 * 避免产生大量只有一句用户输入的"僵尸"会话文件；
	 * assistant 消息到来后再一次性写出全量内容，之后转为纯追加。
	 */
	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
		// 还没有任何 assistant 消息：延迟落盘
		if (!hasAssistant) {
			if (this.flushed) {
				appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
			} else {
				// 保持未 flush 状态，等 assistant 消息到来时一次性写出全部 entry
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			// 首次落盘：'wx' 独占创建，文件已存在则报错（防意外覆盖）
			const fd = openSync(this.sessionFile, "wx");
			try {
				for (const e of this.fileEntries) {
					writeFileSync(fd, `${JSON.stringify(e)}\n`);
				}
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
		} else {
			// 常规路径：一行 JSON 一条 entry，纯追加
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}

	/** 追加 entry 的统一入口：先更新内存（列表/索引/leaf）再走 _persist 落盘 */
	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}

	// =========================================================================
	// 追加 entry（各类 appendXXX）
	// =========================================================================

	/** 把消息作为当前 leaf 的子节点追加，然后前移 leaf。返回 entry id。
	 * 不允许直接写入 CompactionSummaryMessage / BranchSummaryMessage。
	 * 原因：这两类摘要必须作为会话的顶层 entry（而非 message entry）存在，
	 * 这样查找起来更方便。
	 * 它们需改用 appendCompaction() 与 appendBranchSummary() 方法追加。
	 */
	appendMessage(message: Message | CustomMessage | BashExecutionMessage): string {
		const entry: SessionMessageEntry = {
			type: "message",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			message,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加思考级别切换 entry（挂到当前 leaf 下并前移 leaf）。返回 entry id。 */
	appendThinkingLevelChange(thinkingLevel: string): string {
		const entry: ThinkingLevelChangeEntry = {
			type: "thinking_level_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			thinkingLevel,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加模型切换 entry（挂到当前 leaf 下并前移 leaf）。返回 entry id。 */
	appendModelChange(provider: string, modelId: string): string {
		const entry: ModelChangeEntry = {
			type: "model_change",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			provider,
			modelId,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加压缩摘要 entry（挂到当前 leaf 下并前移 leaf）。返回 entry id。 */
	appendCompaction<T = unknown>(
		summary: string,
		firstKeptEntryId: string,
		tokensBefore: number,
		details?: T,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		const entry: CompactionEntry<T> = {
			type: "compaction",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加扩展自定义 entry（挂到当前 leaf 下并前移 leaf）。返回 entry id。 */
	appendCustomEntry(customType: string, data?: unknown): string {
		const entry: CustomEntry = {
			type: "custom",
			customType,
			data,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 追加会话信息 entry（如显示名；换行会被压成空格）。返回 entry id。 */
	appendSessionInfo(name: string): string {
		// 清掉换行避免名字跨行破坏 JSONL 结构
		const sanitizedName = name.replace(/[\r\n]+/g, " ").trim();
		const entry: SessionInfoEntry = {
			type: "session_info",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			name: sanitizedName,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/** 从最后一条 session_info entry 读取当前会话名（若有）。 */
	getSessionName(): string | undefined {
		// 逆序遍历找最后一条 session_info entry；显式空名表示清除会话标题。
		const entries = this.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "session_info") {
				return entry.name?.trim() || undefined;
			}
		}
		return undefined;
	}

	/**
	 * 追加参与 LLM 上下文的扩展自定义消息 entry。
	 * @param customType 扩展标识符，重载时用于过滤出自己的 entry
	 * @param content 消息内容（字符串或 TextContent/ImageContent 数组）
	 * @param display 是否在 TUI 显示（true = 特殊样式渲染，false = 隐藏）
	 * @param details 可选的扩展专有元数据（不发送给 LLM）
	 * @returns entry id
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: string | (TextContent | ImageContent)[],
		display: boolean,
		details?: T,
	): string {
		const entry: CustomMessageEntry<T> = {
			type: "custom_message",
			customType,
			content,
			display,
			details,
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
		};
		this._appendEntry(entry);
		return entry.id;
	}

	// =========================================================================
	// 树遍历
	// =========================================================================

	/** 当前 leaf entry 的 id；null 表示会话尚无任何 entry */
	getLeafId(): string | null {
		return this.leafId;
	}

	/** 当前 leaf entry（若有） */
	getLeafEntry(): SessionEntry | undefined {
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	/** 按 id 查找 entry */
	getEntry(id: string): SessionEntry | undefined {
		return this.byId.get(id);
	}

	/**
	 * 获取某 entry 的全部直接子节点。
	 */
	getChildren(parentId: string): SessionEntry[] {
		// 线性扫描全部 entry 过滤直接子节点（子节点关系没有单独索引）
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * 获取 entry 上的标签（若有）。
	 */
	getLabel(id: string): string | undefined {
		return this.labelsById.get(id);
	}

	/**
	 * 设置或清除 entry 上的标签。
	 * 标签是用户定义的书签/导航标记（以追加 label entry 的方式实现，不改旧记录）。
	 * 传 undefined 或空字符串即清除标签。
	 */
	appendLabelChange(targetId: string, label: string | undefined): string {
		// 只允许给真实存在的 entry 打标签
		if (!this.byId.has(targetId)) {
			throw new Error(`Entry ${targetId} not found`);
		}
		const entry: LabelEntry = {
			type: "label",
			id: generateId(this.byId),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			targetId,
			label,
		};
		this._appendEntry(entry);
		// 同步更新内存中的标签映射（写入文件的 label entry 才是事件源）
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	/**
	 * 从指定 entry 回溯到根，按路径顺序（root→entry）返回全部 entry。
	 * 包含所有 entry 类型（消息、压缩、模型切换等）；
	 * 要拿发给 LLM 的最终消息请用 buildSessionContext()。
	 */
	getBranch(fromId?: string): SessionEntry[] {
		const path: SessionEntry[] = [];
		// 未指定起点时从当前 leaf 出发
		const startId = fromId ?? this.leafId;
		let current = startId ? this.byId.get(startId) : undefined;
		while (current) {
			path.push(current);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path;
	}

	/**
	 * 构建当前生效的、感知压缩的 entry 列表（供上下文/渲染使用）。
	 * 从当前 leaf 做树遍历。
	 */
	buildContextEntries(): SessionEntry[] {
		return buildContextEntries(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * 构建会话上下文（真正发给 LLM 的内容）。
	 * 从当前 leaf 做树遍历。
	 */
	buildSessionContext(): SessionContext {
		return buildSessionContext(this.getEntries(), this.leafId, this.byId);
	}

	/**
	 * 获取会话头。
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * 获取全部会话 entry（不含头部）。返回浅拷贝。
	 * 会话是追加式的：追加用 appendXXX()，移动 leaf 用 branch()；
	 * entry 一经写入不可修改或删除。
	 */
	getEntries(): SessionEntry[] {
		// 过滤掉首部 header，只返回会话 entry
		return this.fileEntries.filter((e): e is SessionEntry => e.type !== "session");
	}

	/**
	 * 以树结构返回整个会话。返回所有 entry 的浅层防御性拷贝。
	 * 格式良好的会话只有一个根（首个 parentId === null 的 entry）；
	 * 孤儿 entry（父链断裂）也会作为根返回，避免丢失。
	 */
	getTree(): SessionTreeNode[] {
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// 先为每个 entry 建节点，并解析当前生效的标签
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// 建树：挂到父节点 children；找不到父节点的按根处理
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// 孤儿 entry —— 当作根返回
					roots.push(node);
				}
			}
		}

		// 按时间戳排序子节点（旧的在前、新的在后）
		// 用迭代而非递归，避免深树递归栈溢出
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	// =========================================================================
	// 分支操作
	// =========================================================================

	/**
	 * 从更早的 entry 开启新分支：把 leaf 指针移到该 entry。
	 * 下一次 appendXXX() 会创建它的子节点，从而形成新分支；
	 * 既有 entry 一概不修改、不删除。
	 */
	branch(branchFromId: string): void {
		// 分支点必须是已存在的 entry
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}

	/**
	 * 把 leaf 指针重置为 null（所有 entry 之前）。
	 * 下一次 appendXXX() 将创建新的根 entry（parentId = null）；
	 * 导航回去重新编辑首条用户消息时使用。
	 */
	resetLeaf(): void {
		this.leafId = null;
	}

	/**
	 * 开新分支并给被放弃的路径留下摘要。
	 * 与 branch() 相同，但额外追加一条 branch_summary entry，
	 * 记录被放弃对话路径的上下文。
	 */
	branchWithSummary(
		branchFromId: string | null,
		summary: string,
		details?: unknown,
		fromHook?: boolean,
		usage?: Usage,
	): string {
		if (branchFromId !== null && !this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		// 记录放弃前的 leaf（null 时记为 "root"）作为摘要来源
		const fromId = this.leafId ?? "root";
		this.leafId = branchFromId;
		const entry: BranchSummaryEntry = {
			type: "branch_summary",
			id: generateId(this.byId),
			parentId: branchFromId,
			timestamp: new Date().toISOString(),
			fromId,
			summary,
			details,
			usage,
			fromHook,
		};
		this._appendEntry(entry);
		return entry.id;
	}

	/**
	 * 创建只包含 root→指定 leaf 路径的新会话文件。
	 * 适用于从带分支的会话中抽出一条单独的对话路径。
	 * 返回新会话文件路径；非持久化模式返回 undefined。
	 */
	createBranchedSession(leafId: string): string | undefined {
		const previousSessionFile = this.sessionFile;
		const path = this.getBranch(leafId);
		// getBranch 返回空说明找不到该 leaf，视为非法参数
		if (path.length === 0) {
			throw new Error(`Entry ${leafId} not found`);
		}

		// 从路径中剔除 LabelEntry——稍后根据解析好的标签映射重建它们。
		// 标签本身也是树上的真实 entry，后续 entry 可能以 label 为父节点；
		// 剔除时必须把保留路径重新链起来，避免产生孤儿子树。
		const pathWithoutLabels: SessionEntry[] = [];
		let pathParentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			pathWithoutLabels.push({ ...entry, parentId: pathParentId });
			pathParentId = entry.id;
		}

		const newSessionId = createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(this.getSessionDir(), `${fileTimestamp}_${newSessionId}.jsonl`);

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: this.cwd,
			parentSession: this.persist ? previousSessionFile : undefined,
		};

		// 收集路径上 entry 仍生效的标签
		const pathEntryIds = new Set(pathWithoutLabels.map((e) => e.id));
		const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
		for (const [targetId, label] of this.labelsById) {
			if (pathEntryIds.has(targetId)) {
				labelsToWrite.push({ targetId, label, timestamp: this.labelTimestampsById.get(targetId)! });
			}
		}

		if (this.persist) {
			// 重建 label entry（逐条链在保留路径末尾之后）
			const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
			let parentId = lastEntryId;
			const labelEntries: LabelEntry[] = [];
			for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
				const labelEntry: LabelEntry = {
					type: "label",
					// 用 pathEntryIds 做冲突域，避免新生成的 label id 与复制来的 entry id 相撞
					id: generateId(new Set(pathEntryIds)),
					parentId,
					timestamp: labelTimestamp,
					targetId,
					label,
				};
				pathEntryIds.add(labelEntry.id);
				labelEntries.push(labelEntry);
				parentId = labelEntry.id;
			}

			this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
			this.sessionId = newSessionId;
			this.sessionFile = newSessionFile;
			this._buildIndex();

			// 只有路径里已含 assistant 消息才立即写文件；
			// 否则交给 _persist() 在首个 assistant 响应时创建文件——
			// 与 newSession() 的契约保持一致，也避免 _persist() 的
			// 无-assistant 保护后续把 flushed 重置为 false 时出现重复头部 bug。
			const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
			if (hasAssistant) {
				this._rewriteFile();
				this.flushed = true;
			} else {
				this.flushed = false;
			}

			return newSessionFile;
		}

		// 内存模式：直接用"路径 + 标签"替换当前会话内容
		const labelEntries: LabelEntry[] = [];
		let parentId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
		for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
			const labelEntry: LabelEntry = {
				type: "label",
				id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
				parentId,
				timestamp: labelTimestamp,
				targetId,
				label,
			};
			labelEntries.push(labelEntry);
			parentId = labelEntry.id;
		}
		this.fileEntries = [header, ...pathWithoutLabels, ...labelEntries];
		this.sessionId = newSessionId;
		this._buildIndex();
		return undefined;
	}

	// =========================================================================
	// 静态工厂与目录发现
	// =========================================================================

	/**
	 * 新建会话。
	 * @param cwd 工作目录（写入会话头部）
	 * @param sessionDir 可选会话目录；省略时用默认目录（~/.pi/agent/sessions/<编码后的-cwd>/）
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * 打开指定会话文件。
	 * @param path 会话文件路径
	 * @param sessionDir 可选会话目录（供 /new、/branch 使用）；省略时取文件父目录
	 * @param cwdOverride 可选的 cwd 覆盖（优先于会话头部记录的 cwd）
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined && existsSync(resolvedPath)) {
			try {
				header = readSessionHeader(resolvedPath);
			} catch (error) {
				if (!(error instanceof SessionHeaderScanLimitError)) throw error;
				// 有界扫描只是发现阶段的优化手段。对头部/前缀超大的遗留文件，
				// 全量加载仍是权威来源。
				preloadedFileEntries = loadEntriesFromFile(resolvedPath);
				const firstEntry = preloadedFileEntries[0];
				header = firstEntry?.type === "session" ? firstEntry : null;
			}
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		// 未提供 sessionDir 时，从文件父目录推导
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	/**
	 * 继续最近一次会话；没有则新建。
	 * @param cwd 工作目录
	 * @param sessionDir 可选会话目录；省略时用默认目录（~/.pi/agent/sessions/<编码后的-cwd>/）
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		// 仅当用户指定了非默认目录时才按 cwd 过滤（默认目录本身已按 cwd 编码）
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSession(dir, filterCwd ? cwd : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		// 没有可续会话：退化为新建
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** 创建纯内存会话（不落盘） */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options);
	}

	/**
	 * 把其他项目目录下的会话 fork 到当前项目。
	 * 在目标 cwd 下创建新会话，携带源会话的完整历史。
	 * @param sourcePath 源会话文件路径
	 * @param targetCwd 目标工作目录（新会话的存放位置）
	 * @param sessionDir 可选会话目录；省略时用 targetCwd 的默认目录
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
		// 源文件必须能加载出内容且带合法头部，否则拒绝 fork
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		// 默认目录在 getDefaultSessionDir 内已创建；自定义目录需显式创建
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// 新建会话文件：全新 ID，但内容 fork 自源会话
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.jsonl`);

		// 写入新头部：parentSession 指向源文件，cwd 更新为目标目录
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		// 'wx' 独占创建：目标文件已存在则报错，绝不覆盖
		writeFileSync(newSessionFile, `${JSON.stringify(newHeader)}\n`, { flag: "wx" });

		// 原样复制源文件中除头部外的全部 entry
		for (const entry of sourceEntries) {
			if (entry.type !== "session") {
				appendFileSync(newSessionFile, `${JSON.stringify(entry)}\n`);
			}
		}

		return new SessionManager(resolvedTargetCwd, dir, newSessionFile, true);
	}

	/**
	 * 列出某个目录下的全部会话。
	 * @param cwd 工作目录（用于计算默认会话目录）
	 * @param sessionDir 可选会话目录；省略时用默认目录（~/.pi/agent/sessions/<编码后的-cwd>/）
	 * @param onProgress 可选的进度回调（已加载数, 总数）
	 */
	static async list(cwd: string, sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		// 仅当用户指定了非默认目录时才按 cwd 过滤（默认目录本身已按 cwd 编码）
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const sessions = (await listSessionsFromDir(dir, onProgress)).filter(
			(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
		);
		// 按修改时间降序：最近活跃的会话排最前
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	/**
	 * 列出所有项目目录下的全部会话。
	 * @param onProgress 可选的进度回调（已加载数, 总数）
	 */
	static async listAll(onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(sessionDir?: string, onProgress?: SessionListProgress): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgress?: SessionListProgress,
	): Promise<SessionInfo[]> {
		// 兼容两种重载：第一参数既可能是目录字符串，也可能是进度回调
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
		if (customSessionDir) {
			// 指定了目录：只扫描该目录
			const sessions = await listSessionsFromDir(customSessionDir, progress);
			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		}

		const sessionsDir = getSessionsDir();

		try {
			if (!existsSync(sessionsDir)) {
				return [];
			}
			const entries = await readdir(sessionsDir, { withFileTypes: true });
			// 每个项目目录对应 sessions/ 下一个子目录（符号链接也算）
			const dirs = entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => join(sessionsDir, entry.name));

			// 先数清总文件数，进度回调的分母才准确
			let totalFiles = 0;
			const dirFiles: string[][] = [];
			for (const dir of dirs) {
				try {
					const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
					dirFiles.push(files.map((f) => join(dir, f)));
					totalFiles += files.length;
				} catch {
					// 单个目录读失败按空处理，不影响其余目录
					dirFiles.push([]);
				}
			}

			// 带进度地并发处理全部文件
			let loaded = 0;
			const sessions: SessionInfo[] = [];
			// 拍平所有目录下的 .jsonl 文件列表
			const allFiles = dirFiles.flat();

			const results = await buildSessionInfosWithConcurrency(allFiles, () => {
				loaded++;
				progress?.(loaded, totalFiles);
			});

			for (const info of results) {
				if (info) {
					sessions.push(info);
				}
			}

			sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			return sessions;
		} catch {
			// 全局列表失败时返回空数组，不阻断 UI
			return [];
		}
	}
}
