/**
 * @file session/jsonl/repo.ts —— JSONL 会话后端的仓库层：磁盘布局规则与会话生命周期管理。
 *
 * @description
 * 本文件实现 {@link SessionRepo} 接口（create / open / list / delete / fork，
 * 见 ../types.ts），是 jsonl 后端的最外层。职责分工：
 * - **本文件（repo 层）**：只管「会话放在磁盘哪里」与「会话的生灭」——目录按
 *   cwd 编码、文件按「创建时间戳_会话 id」命名、创建查重与并发占位、列表
 *   扫描、fork 编排（确定源与目标后把实际复制交给存储层）；
 * - **./storage.ts（存储层）**：单个会话文件的读写实现（追加 mutation、加载
 *   重放、torn-tail 修复、fork 的 .tmp 暂存 + 原子 rename）；
 * - **./codec.ts（编解码层）**：header / mutation 行的 JSON 编解码。
 *
 * 磁盘布局与命名规则：
 * - 目录：`<sessionsRoot>/--<cwd 编码>--/`——cwd 去掉开头分隔符后把 `/`、`\`、
 *   `:` 统一替换为 `-`（见 jsonlSessionDirectoryName），与 coding-agent 的既有
 *   布局兼容，例：`/Users/foo/proj` → `--Users-foo-proj--`；
 * - 文件：`<ISO 创建时间戳（: 与 . 替换为 -）>_<会话 id>.jsonl`（见
 *   sessionFileName），时间戳前缀使目录内文件天然按创建时间排序；
 * - 文件内容：首行 v4 header + 逐行 mutation，由存储层 / 编解码层负责。
 */
import { uuidv7 } from "@earendil-works/pi-ai";
import { assertJsonSerializable, Session } from "../session.ts";
import { type ForkOptions, SessionError, type SessionRepo } from "../types.ts";
import { metadataFromHeader, parseHeader } from "./codec.ts";
import { fileResult } from "./errors.ts";
import { JsonlSessionStorage } from "./storage.ts";
import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoFileSystem,
	JsonlSessionRepoOptions,
	JsonlV4Header,
} from "./types.ts";

/**
 * 会话 id 的合法字符集：首尾必须是字母 / 数字，中间可含 `.`、`_`、`-`。
 * Why 限制字符集：id 会直接拼进会话文件名（`<时间戳>_<id>.jsonl`）与目录
 * 扫描的后缀匹配中，收紧字符集可避免路径分隔符等危险 / 非法字符进入文件名。
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * 校验会话 id 是否符合 {@link SESSION_ID_PATTERN} 命名规约。
 *
 * @param id 待校验的会话 id。
 * @throws id 为空或含非法字符时抛出 SessionError（code: "invalid_payload"）。
 */
function validateSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new SessionError(
			"invalid_payload",
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/**
 * 把 cwd 编码成 sessionsRoot 下的会话目录名：去掉开头路径分隔符后，把剩余的
 * `/`、`\`、`:`（Windows 盘符）统一替换为 `-`，再以 `--` 前后包裹。
 * 例：`/Users/foo/proj` → `--Users-foo-proj--`。该规则与 coding-agent 的既有
 * 磁盘布局保持一致，使两者共享同一份会话存储。
 */
function jsonlSessionDirectoryName(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * 把仓库选项中的 sessionsRoot 解析为绝对路径，作为目录定位与列表扫描的起点。
 *
 * @param options 仓库选项（fs + sessionsRoot）。
 * @returns sessionsRoot 的绝对路径。
 * @throws 解析失败时抛出 SessionError（code: "storage"）。
 */
async function jsonlSessionsRoot(options: JsonlSessionRepoOptions): Promise<string> {
	return fileResult(
		await options.fs.absolutePath(options.sessionsRoot),
		`Failed to resolve sessions root ${options.sessionsRoot}`,
	);
}

/**
 * 定位某个 cwd 对应的会话目录：sessionsRoot + 按 {@link jsonlSessionDirectoryName}
 * 编码的目录名。只做路径拼接，不保证目录已存在（创建会话时才补建）。
 *
 * @param fs 文件系统抽象。
 * @param sessionsRoot 已解析为绝对路径的会话根目录。
 * @param cwd 会话工作目录（应为绝对路径）。
 * @returns 该 cwd 的会话目录绝对路径。
 * @throws 路径拼接失败时抛出 SessionError。
 */
async function jsonlSessionDirectory(
	fs: JsonlSessionRepoFileSystem,
	sessionsRoot: string,
	cwd: string,
): Promise<string> {
	return fileResult(
		await fs.joinPath([sessionsRoot, jsonlSessionDirectoryName(cwd)]),
		`Failed to resolve sessions directory for ${cwd}`,
	);
}

/**
 * 枚举列表扫描要遍历的会话目录集合：
 * - 给定 cwd：只返回该 cwd 编码出的那一个目录（目录不存在则返回空数组，视为
 *   该项目还没有会话，不报错）；
 * - 未给定 cwd：返回 sessionsRoot 下全部子目录与符号链接，覆盖所有工作目录
 *   的会话（用于跨项目列出全部会话）。
 *
 * @param options 仓库选项。
 * @param cwd 可选的工作目录过滤。
 * @returns 待扫描的会话目录绝对路径数组（可能为空）。
 * @throws exists / listDir / 路径解析等文件系统调用失败时抛出 SessionError。
 */
async function jsonlSessionDirectories(options: JsonlSessionRepoOptions, cwd?: string): Promise<string[]> {
	const sessionsRoot = await jsonlSessionsRoot(options);
	// 给定 cwd：定向到单个目录；不存在即无会话。
	if (cwd !== undefined) {
		const resolvedCwd = fileResult(await options.fs.absolutePath(cwd), `Failed to resolve session cwd ${cwd}`);
		const directory = await jsonlSessionDirectory(options.fs, sessionsRoot, resolvedCwd);
		return fileResult(await options.fs.exists(directory), `Failed to check sessions directory ${directory}`)
			? [directory]
			: [];
	}
	// 未给定 cwd：枚举根目录下全部目录 / 符号链接，覆盖所有工作目录。
	if (!fileResult(await options.fs.exists(sessionsRoot), `Failed to check sessions directory ${sessionsRoot}`))
		return [];
	return fileResult(await options.fs.listDir(sessionsRoot), `Failed to list sessions directory ${sessionsRoot}`)
		.filter((entry) => entry.kind === "directory" || entry.kind === "symlink")
		.map((entry) => entry.path);
}

/**
 * 扫描会话目录并解析出全部会话元数据：list 的核心实现（被
 * {@link JsonlSessionRepo}.list 复用，也独立导出供测试 / 外部直接扫描）。
 *
 * Why 只读每个文件的首行 header：列表只需要 id / 时间戳等元数据，无需加载
 * 整个会话文件重放 mutation；首行为空或 header 解析失败的文件（外来文件、
 * 半写残留）直接跳过而非报错，保证单个坏文件不拖垮整份列表。
 *
 * @param options 仓库选项。
 * @param query 列表过滤（cwd：限定工作目录；缺省扫描全部）。
 * @returns 会话元数据数组，按修改时间（mtime）从新到旧排序。
 * @throws 目录列举 / 首行读取等文件系统调用失败时抛出 SessionError。
 */
export async function listJsonlSessionMetadata(
	options: JsonlSessionRepoOptions,
	query: JsonlSessionListOptions = {},
): Promise<JsonlSessionMetadata[]> {
	const metadata: JsonlSessionMetadata[] = [];
	// ========== 逐目录扫描：收集 .jsonl 文件，只解析首行 header ==========
	// 只认非目录且以 .jsonl 结尾的条目（`.tmp` 暂存文件等自然被排除）。
	for (const directory of await jsonlSessionDirectories(options, query.cwd)) {
		const files = fileResult(
			await options.fs.listDir(directory),
			`Failed to list sessions directory ${directory}`,
		).filter((entry) => entry.kind !== "directory" && entry.name.endsWith(".jsonl"));
		for (const file of files) {
			const [firstLine] = fileResult(
				await options.fs.readTextLines(file.path, { maxLines: 1 }),
				`Failed to read session header ${file.path}`,
			);
			// 首行为空或 header 解析失败：跳过该文件（可能不是会话文件，或为
			// 崩溃半写残留），不中断扫描。
			if (!firstLine) continue;
			const headerResult = parseHeader(firstLine);
			if (!headerResult.ok) continue;
			metadata.push(metadataFromHeader(headerResult.value, file.path, file.mtimeMs));
		}
	}
	// 按修改时间（mtime）从新到旧排序，最近的会话排最前。
	return metadata.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

/**
 * 加载并校验既有会话文件，返回就绪的存储实例（open 与 fork 加载源会话的公共
 * 路径）。语义要点：
 * - **open 不隐式新建**：目标文件不存在时抛出 not_found，由调用方决定是否
 *   转为 create；
 * - **id 防错位校验**：加载完成后比对文件 header 的 id 与传入元数据的 id，
 *   不一致说明 path 上实际是另一个会话（元数据过期或被外部改动），抛
 *   invalid_entry，避免把 B 会话当成 A 会话继续写入。
 *
 * @param options 仓库选项。
 * @param metadata 定位会话的元数据（至少需要 id 与 path）。
 * @returns 从磁盘完整加载（含 torn-tail 修复，见 ./storage.ts）的存储实例。
 * @throws 会话不存在、文件损坏或 id 不匹配时抛出 SessionError。
 */
export async function loadJsonlSessionStorage(
	options: JsonlSessionRepoOptions,
	metadata: JsonlSessionMetadata,
): Promise<JsonlSessionStorage> {
	// ========== 存在性检查：不存在即失败，绝不隐式新建 ==========
	if (!fileResult(await options.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)) {
		throw new SessionError("not_found", `Session not found: ${metadata.id}`);
	}
	// ========== 加载并校验文件身份 ==========
	// header id 与传入元数据 id 不一致：path 上实为另一个会话，宁可报错也不允许继续写入。
	const storage = await JsonlSessionStorage.load(options.fs, metadata.path);
	const loadedMetadata = await storage.getMetadata();
	if (loadedMetadata.id !== metadata.id) {
		throw new SessionError("invalid_entry", `Session id does not match header: ${metadata.id}`);
	}
	return storage;
}

/**
 * 生成会话文件名：`<ISO 创建时间戳>_<会话 id>.jsonl`。
 * Why：时间戳前缀让目录内文件天然按创建时间排序；ISO 时间戳中的 `:` 与 `.`
 * 替换为 `-`，以兼容不允许这些字符的文件系统。
 */
function sessionFileName(createdAt: number, id: string): string {
	const timestamp = new Date(createdAt).toISOString().replace(/[:.]/g, "-");
	return `${timestamp}_${id}.jsonl`;
}

/**
 * JSONL 后端的 {@link SessionRepo} 实现：管理 sessionsRoot 下按 cwd 编码的
 * 会话文件集合。各生命周期方法的实现路径：
 * - **create**：解析目标 {id, cwd} → 进程内占位防并发 → 磁盘查重 + 组装
 *   header / 建目录 → 写入 v4 header 首行（具体落盘见 ./storage.ts）；
 * - **open**：按元数据 path 加载既有文件；不存在则 not_found，绝不隐式新建；
 * - **list**：扫描目录、只读各文件首行 header 汇总元数据，不加载会话内容；
 * - **delete**：只删除会话文件本身（force 使其幂等）；
 * - **fork**：先加载源会话，再走与 create 相同的目标准备路径，实际复制由
 *   {@link JsonlSessionStorage}.fork（.tmp 暂存 + 原子 rename）完成。
 */
export class JsonlSessionRepo
	implements SessionRepo<JsonlSessionMetadata, JsonlSessionCreateOptions, JsonlSessionListOptions>
{
	/** 注入的文件系统抽象（./types.ts 的 JsonlSessionRepoFileSystem）。 */
	private readonly fs: JsonlSessionRepoFileSystem;
	/** 构造时传入的 sessionsRoot 原始值（可能是相对路径；绝对化在 {@link root} 中惰性完成并缓存）。 */
	private readonly sessionsRootInput: string;
	/** 进程内「正在创建同一目标」的占位集合（键为 `cwd\0id`），见 {@link claimCreateDestination}。 */
	private readonly activeCreateDestinations = new Set<string>();
	/** sessionsRoot 绝对路径的惰性缓存（复用同一 Promise，避免每次操作重复解析）。 */
	private rootPromise: Promise<string> | undefined;

	/**
	 * @param options 仓库选项：fs 文件系统抽象 + sessionsRoot 会话根目录。
	 */
	constructor(options: JsonlSessionRepoOptions) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	/**
	 * 新建会话：解析目标 {id, cwd} → 进程内占位（防并发撞车）→ 查重 / 组装
	 * header / 建目录 → 写入 v4 header 首行，最后包成可写的 {@link Session}。
	 *
	 * @param options 创建选项（cwd 必填，决定目录归属；id 缺省生成 uuidv7）。
	 * @returns 就绪的新会话。
	 * @throws id 非法（invalid_payload）、同 id 会话已存在（already_exists）
	 *   或文件系统失败（storage）时抛出。
	 */
	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const destination = await this.resolveCreateDestination(options);
		// 先占位再执行：占位与查重 / 落盘的分工见 claimCreateDestination。
		return this.claimCreateDestination(destination, async () => {
			const { header, path } = await this.prepareCreate(destination, options);
			return new Session(await JsonlSessionStorage.create(this.fs, path, header));
		});
	}

	/**
	 * 打开既有会话以供写入。open 不做任何隐式创建：目标文件不存在时由
	 * {@link loadJsonlSessionStorage} 抛出 not_found，是否转为 create 由调用方
	 * 决定。返回时会话文件已完成加载与 torn-tail 修复，处于一致可写状态。
	 *
	 * @param metadata 定位会话的元数据（直接沿用 list 的返回即可）。
	 * @returns 加载完成的可写会话。
	 * @throws 会话不存在（not_found）、文件损坏或 header id 与元数据不符时抛出。
	 */
	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		return new Session(await this.loadStorage(metadata));
	}

	/**
	 * 列出会话元数据：只读各文件首行 header，不打开会话、不获取写者声明；
	 * 按 mtime 从新到旧排序。
	 *
	 * @param options 过滤选项（cwd：限定工作目录；缺省扫描全部）。
	 * @returns 会话元数据数组。
	 * @throws 目录扫描等文件系统调用失败时抛出 SessionError。
	 */
	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		return this.listDirect(options);
	}

	/**
	 * 删除会话。清理范围：仅移除该会话自己的 .jsonl 文件；`force: true` 使目标
	 * 不存在时也静默成功（幂等删除，重复删不报错）。不清理同目录下的其他会话
	 * 文件，也不删除（可能仍被其他会话使用的）会话目录本身。
	 *
	 * @param metadata 定位会话的元数据。
	 * @throws 文件系统删除失败时抛出 SessionError（storage）。
	 */
	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		fileResult(await this.fs.remove(metadata.path, { force: true }), `Failed to delete session ${metadata.path}`);
	}

	/**
	 * 从源会话派生新会话。实现路径：加载源会话（校验存在且完好）→ 在创建
	 * 选项上补默认 parentSessionId（取源会话 id，使新 header 可溯源）→ 走与
	 * create 完全相同的目标占位 / 查重 / header / 目录准备 → 委托
	 * {@link JsonlSessionStorage}.fork 把复制范围内的 mutation 逐条重放进
	 * `.tmp` 暂存文件并原子 rename 发布 → 包成 {@link Session} 返回。
	 *
	 * @param source 源会话元数据。
	 * @param options 复制范围（branch / tree，见 ../types.ts 的 ForkOptions）
	 *   与新会话创建选项（cwd 必填；id 缺省生成新的 uuidv7）。
	 * @returns 就绪的派生会话（从磁盘重新加载，内存态与文件严格一致）。
	 * @throws 源会话不存在 / 损坏（not_found 等）、目标已存在
	 *   （already_exists）或文件系统失败时抛出。
	 */
	async fork(
		source: JsonlSessionMetadata,
		options: ForkOptions & JsonlSessionCreateOptions,
	): Promise<Session<JsonlSessionMetadata>> {
		const sourceStorage = await this.loadStorage(source);
		// 补默认 parentSessionId：新会话 header 记录派生来源，除非调用方显式指定。
		const createOptions = {
			...options,
			parentSessionId: options.parentSessionId ?? source.id,
		};
		const destination = await this.resolveCreateDestination(createOptions);
		// 与 create 共用「占位 → 准备」路径；差别仅在最后一步由源存储把
		// fork 范围内的内容复制进新文件（而非只写 header）。
		return this.claimCreateDestination(destination, async () => {
			const { header, path } = await this.prepareCreate(destination, createOptions);
			return new Session(await sourceStorage.fork(path, header, options));
		});
	}

	/** 加载既有会话存储（open 与 fork 加载源会话的共用入口），语义见 {@link loadJsonlSessionStorage}。 */
	private async loadStorage(metadata: JsonlSessionMetadata): Promise<JsonlSessionStorage> {
		return loadJsonlSessionStorage({ fs: this.fs, sessionsRoot: this.sessionsRootInput }, metadata);
	}

	/**
	 * 解析创建目标：确定会话 id（缺省生成 uuidv7——时间有序，与文件名的时间戳
	 * 前缀排序方向一致）并校验命名规约，再把 cwd 规范化为绝对路径（它决定会话
	 * 文件的目录归属）。
	 *
	 * @param options 创建选项。
	 * @returns 目标二元组 { id, cwd }（cwd 为绝对路径）。
	 * @throws id 非法或 cwd 解析失败时抛出 SessionError。
	 */
	private async resolveCreateDestination(options: JsonlSessionCreateOptions): Promise<{ id: string; cwd: string }> {
		const id = options.id ?? uuidv7();
		validateSessionId(id);
		const cwd = fileResult(await this.fs.absolutePath(options.cwd), `Failed to resolve session cwd ${options.cwd}`);
		return { id, cwd };
	}

	/**
	 * 防止同进程内 create / fork 针对同一逻辑目标的并发竞态。落盘文件名包含
	 * 创建时间戳，因此仅靠异步的文件系统存在性检查，可能让两个并发调用都
	 * 判定同一个 {cwd, id} 可用，从而各自发布一个重复会话——本方法以进程内
	 * Set 占位（键为 `cwd\0id`）补上这层互斥：占位冲突即抛 already_exists，
	 * 操作结束（无论成败）后在 finally 中释放占位。
	 */
	private async claimCreateDestination<T>(
		destination: { id: string; cwd: string },
		operation: () => Promise<T>,
	): Promise<T> {
		const key = `${destination.cwd}\0${destination.id}`;
		if (this.activeCreateDestinations.has(key)) {
			throw new SessionError("already_exists", `Session already exists: ${destination.id}`);
		}
		this.activeCreateDestinations.add(key);
		try {
			return await operation();
		} finally {
			this.activeCreateDestinations.delete(key);
		}
	}

	/**
	 * 创建前的全部准备（在占位保护下执行）：磁盘查重、生成创建时间与目标文件
	 * 路径、校验应用元数据、组装 v4 header，并递归创建会话目录。
	 *
	 * @param destination 已解析的目标（id + 绝对 cwd）。
	 * @param options 创建选项（parentSessionId / metadata 写入 header）。
	 * @returns 待写入的 v4 header 与目标文件绝对路径（尚未落盘）。
	 * @throws 同 {cwd, id} 会话已存在（already_exists）、metadata 不可 JSON
	 *   序列化或文件系统失败时抛出。
	 */
	private async prepareCreate(
		destination: { id: string; cwd: string },
		options: JsonlSessionCreateOptions,
	): Promise<{
		header: JsonlV4Header;
		path: string;
	}> {
		const { id, cwd } = destination;
		// ========== 磁盘查重（进程内占位之外的第二道防线） ==========
		if (await this.sessionIdExists(id, cwd)) {
			throw new SessionError("already_exists", `Session already exists: ${id}`);
		}

		// ========== 组装 header 与目标路径 ==========
		const createdAt = Date.now();
		const sessionDirectory = await this.sessionDirectory(cwd);
		const path = fileResult(
			await this.fs.joinPath([sessionDirectory, sessionFileName(createdAt, id)]),
			`Failed to resolve path for session ${id}`,
		);
		// 应用自带元数据必须严格 JSON 可序列化（header 要作为 JSON 行写入文件）。
		if (options.metadata !== undefined) assertJsonSerializable(options.metadata);
		const header: JsonlV4Header = {
			kind: "header",
			version: 4,
			id,
			createdAt,
			cwd,
			parentSessionId: options.parentSessionId,
			metadata: options.metadata,
		};
		fileResult(await this.fs.createDir(sessionDirectory, { recursive: true }), `Failed to create sessions directory`);
		return { header, path };
	}

	/** list 的直接实现：委托给模块级 {@link listJsonlSessionMetadata}（与独立导出共用同一逻辑）。 */
	private async listDirect(options: JsonlSessionListOptions): Promise<JsonlSessionMetadata[]> {
		return listJsonlSessionMetadata({ fs: this.fs, sessionsRoot: this.sessionsRootInput }, options);
	}

	/**
	 * 检查同 {cwd, id} 的会话文件是否已存在。
	 * Why 按后缀 `_${id}.jsonl` 扫描而非精确文件名：文件名前缀是创建时间戳，
	 * 查重发生在创建之前、无法预知它；后缀中 id 以 `_` 精确衔接且首尾为字母
	 * 数字，不会误匹配包含该 id 的更长文件名。
	 *
	 * @param id 会话 id。
	 * @param cwd 会话工作目录（绝对路径）。
	 * @returns 已存在返回 true；目录尚不存在视为没有会话。
	 * @throws exists / listDir 文件系统调用失败时抛出 SessionError。
	 */
	private async sessionIdExists(id: string, cwd: string): Promise<boolean> {
		const suffix = `_${id}.jsonl`;
		const directory = await this.sessionDirectory(cwd);
		if (!fileResult(await this.fs.exists(directory), `Failed to check sessions directory ${directory}`)) return false;
		const files = fileResult(await this.fs.listDir(directory), `Failed to list sessions directory ${directory}`);
		return files.some((entry) => entry.kind !== "directory" && entry.name.endsWith(suffix));
	}

	/** 定位 cwd 对应的会话目录（缓存后的 root + 编码目录名）；目录可能尚不存在，由创建方补建。 */
	private async sessionDirectory(cwd: string): Promise<string> {
		return fileResult(
			await this.fs.joinPath([await this.root(), jsonlSessionDirectoryName(cwd)]),
			`Failed to resolve sessions directory for ${cwd}`,
		);
	}

	/**
	 * 惰性解析并缓存 sessionsRoot 的绝对路径：首次调用发起解析，之后复用同一
	 * Promise，避免每次目录定位都重复文件系统调用。
	 */
	private root(): Promise<string> {
		this.rootPromise ??= this.fs
			.absolutePath(this.sessionsRootInput)
			.then((result) => fileResult(result, `Failed to resolve sessions root ${this.sessionsRootInput}`));
		return this.rootPromise;
	}
}
