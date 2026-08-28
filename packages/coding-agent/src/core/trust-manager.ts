/**
 * @file trust-manager.ts —— 项目信任（Project Trust）持久化存储
 *
 * @description
 * 管理用户对各个项目目录（cwd）的信任决定，持久化为 agentDir 下的 trust.json。
 * 只有被「信任」的项目，其项目内资源（.pi/settings.json、.pi/skills、
 * .agents/skills 等）才会被加载，防止在不可信目录中被恶意配置注入。
 *
 * 主要功能点：
 * - 信任判定沿目录树向上冒泡：任意祖先目录的信任决定同样覆盖当前目录；
 * - 提供信任提示选项枚举（Trust / Trust parent folder / Do not trust），
 *   支持「仅本会话生效」（不落盘）的变体；
 * - 通过 proper-lockfile 文件锁保证多进程并发读-改-写 trust.json 的一致性；
 * - 读取时对文件内容做严格校验，损坏数据直接抛错而非静默重置。
 *
 * 依赖关系：
 * - `../config.ts`：项目内配置目录名（CONFIG_DIR_NAME，即 .pi）；
 * - `../utils/paths.ts`：路径规整（canonicalizePath / resolvePath）；
 * - `../utils/text.ts`：stripBom，容忍带 BOM 的 trust.json；
 * - `proper-lockfile`：跨进程互斥锁。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";

/** 单个目录的信任决定：true=信任，false=不信任，null=未记录（无条目或已清除）。 */
export type ProjectTrustDecision = boolean | null;

/** 命中的一条信任记录：目录路径 + 该目录自身的信任决定。 */
export interface ProjectTrustStoreEntry {
	/** 已规整（canonicalize）的绝对目录路径，即 trust.json 中的键。 */
	path: string;
	/** 信任决定；能成为记录的只有 true/false（null 不会落盘为条目）。 */
	decision: boolean;
}

/** 一次待写入的信任更新：path 为原始目录，decision 为 null 表示删除该条目。 */
export interface ProjectTrustUpdate {
	path: string;
	decision: ProjectTrustDecision;
}

/** 信任提示界面展示的一个选项。 */
export interface ProjectTrustOption {
	/** 展示给用户的选项文案。 */
	label: string;
	/** 选择该项后是否视为信任（决定项目内资源是否被加载）。 */
	trusted: boolean;
	/** 选择该项时需要写入 trust.json 的批量更新。 */
	updates: ProjectTrustUpdate[];
	/** 实际记录进 trust.json 的目录；「仅本会话」选项不落盘，故无此字段。 */
	savedPath?: string;
}

/** trust.json 的内存形态：规整后的目录路径 → 信任决定（undefined 表示已删除）。 */
type TrustFile = Record<string, boolean | null | undefined>;

/** .pi 目录下出现这些条目之一时，项目资源必须经过信任门禁才会被加载。 */
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

/** 把任意形式的路径规整为 canonical 绝对路径，保证与 trust.json 中的键可比。 */
function normalizeCwd(cwd: string): string {
	return canonicalizePath(resolvePath(cwd));
}

/**
 * 从 cwd 开始沿目录树向上查找最近的信任记录。
 * 祖先目录的信任决定覆盖其下所有子目录（例如信任 ~/code 即信任其中全部项目），
 * 直到命中第一条 true/false 记录；遍历到文件系统根仍无记录则返回 null。
 */
function findNearestTrustEntry(data: TrustFile, cwd: string): ProjectTrustStoreEntry | null {
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false) {
			return { path: currentDir, decision: value };
		}

		// dirname(根目录) === 根目录：说明已向上遍历到顶仍无记录
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}
		currentDir = parentDir;
	}
}

/** 返回父目录路径；cwd 已是文件系统根目录（无父目录）时返回 undefined。 */
export function getProjectTrustParentPath(cwd: string): string | undefined {
	const trustPath = normalizeCwd(cwd);
	const parentDir = dirname(trustPath);
	return parentDir === trustPath ? undefined : parentDir;
}

/**
 * 构造信任提示的可选项列表，顺序为：
 * Trust（当前目录）→ Trust parent folder（父目录）→ [仅本会话信任] →
 * Do not trust → [仅本会话不信任]。
 * 「信任父目录」会同时把当前目录的记录置为 null（删除），
 * 避免子目录的旧记录遮蔽父目录的新决定；「仅本会话」选项 updates 为空数组，
 * 本会话内生效但不写入 trust.json。
 */
export function getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): ProjectTrustOption[] {
	const trustPath = normalizeCwd(cwd);
	const trustOptions: ProjectTrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: trustPath, decision: true }], savedPath: trustPath },
	];
	const parentPath = getProjectTrustParentPath(cwd);
	if (parentPath !== undefined) {
		trustOptions.push({
			label: `Trust parent folder (${parentPath})`,
			trusted: true,
			updates: [
				{ path: parentPath, decision: true },
				{ path: trustPath, decision: null },
			],
			savedPath: parentPath,
		});
	}
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Trust (this session only)", trusted: true, updates: [] });
	}
	trustOptions.push({
		label: "Do not trust",
		trusted: false,
		updates: [{ path: trustPath, decision: false }],
		savedPath: trustPath,
	});
	if (options?.includeSessionOnly) {
		trustOptions.push({ label: "Do not trust (this session only)", trusted: false, updates: [] });
	}
	return trustOptions;
}

/**
 * 读取并校验 trust.json，返回内存形态的信任表。
 * 任何结构性损坏（非法 JSON / 非对象 / 值类型不符）都直接抛错而非静默重置：
 * 静默丢失信任记录既可能放开本应受门禁的资源，也可能误伤已信任项目。
 */
function readTrustFile(path: string): TrustFile {
	// 首次使用尚无 trust.json：视为空表
	if (!existsSync(path)) {
		return {};
	}

	let parsed: unknown;
	try {
		// stripBom：某些编辑器写入的 BOM 会让 JSON.parse 直接解析失败
		parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}

	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		// 逐条校验：值只能是 true/false/null，其余一律拒绝
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

/**
 * 以键排序、2 空格缩进、末尾换行的稳定格式写入 trust.json，
 * 使文件内容只随真实数据变化，避免无意义的 diff 噪音。
 */
function writeTrustFile(path: string, data: TrustFile): void {
	const sorted: TrustFile = {};
	for (const key of Object.keys(data).sort()) {
		const value = data[key];
		// 只写合法值，防御内存中出现 undefined 等脏数据
		if (value === true || value === false || value === null) {
			sorted[key] = value;
		}
	}
	// agentDir 可能尚不存在（首次运行），递归创建父目录
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

/**
 * 同步获取 trust.json 的互斥锁。
 * 只对 ELOCKED（其他进程持锁）重试，其余错误立即抛出；
 * 魔法数字：最多尝试 10 次、每次退避 20ms（约 200ms 的等锁窗口）。
 * @returns 释放锁的回调
 */
function acquireTrustLockSync(path: string): () => void {
	const trustDir = dirname(path);
	mkdirSync(trustDir, { recursive: true });
	const maxAttempts = 10;
	const delayMs = 20;
	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			// realpath: false —— 锁路径不解析符号链接，避免 /tmp 等软链导致锁文件路径漂移
			return lockfile.lockSync(trustDir, { realpath: false, lockfilePath: `${path}.lock` });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			// 非争锁错误或已到重试上限：直接抛出
			if (code !== "ELOCKED" || attempt === maxAttempts) {
				throw error;
			}
			lastError = error;
			const start = Date.now();
			while (Date.now() - start < delayMs) {
				// 同步休眠（忙等），避免把信任存储的调用方改成异步。
			}
		}
	}

	// 理论上不可达：循环要么返回锁、要么在最后一次 attempt 抛出；仅作兜底满足类型收窄
	if (lastError instanceof Error) {
		throw lastError;
	}
	throw new Error("Failed to acquire trust store lock");
}

/**
 * 在文件锁保护下执行 fn：让「读 → 改 → 写」整个过程对其他进程原子可见。
 * 无论 fn 成功与否都在 finally 中释放锁，防止异常路径造成死锁。
 */
function withTrustFileLock<T>(path: string, fn: () => T): T {
	const release = acquireTrustLockSync(path);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * 判断 cwd 是否存在必须经过项目信任门禁的项目内资源：
 * cwd/.pi 下存在任一「信任门禁资源」（settings.json、skills、extensions 等），
 * 或 cwd 及其任一祖先目录下存在 .agents/skills 目录。
 * 都不存在时返回 false（无需弹出信任提示）。
 * 注意：用户级 ~/.agents/skills 永远视为可信的用户资源，
 * 即便 cwd 恰好是 $HOME 也不会因此触发门禁。
 */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const homeDir = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	// 用户级 skills 目录：始终可信，需从后续向上扫描中排除
	const userAgentsSkillsDir = join(homeDir, ".agents", "skills");
	let currentDir = canonicalizePath(resolvePath(cwd));

	// 先检查 cwd/.pi 下的门禁资源（仅检查当前目录，不向上冒泡）
	const configDir = join(currentDir, CONFIG_DIR_NAME);
	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
		return true;
	}

	// 再沿目录树向上查找项目级 .agents/skills（祖先目录的 skills 同样会注入当前会话）
	while (true) {
		const agentsSkillsDir = join(currentDir, ".agents", "skills");
		if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
			return true;
		}

		// dirname(根目录) === 根目录：已遍历到顶仍未命中
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return false;
		}
		currentDir = parentDir;
	}
}

/**
 * 项目信任存储：封装 trust.json 的读取与更新。
 * 所有读写都在文件锁内完成，多进程（多个 pi 实例）并发安全。
 */
export class ProjectTrustStore {
	/** trust.json 的绝对路径（agentDir/trust.json）。 */
	private trustPath: string;

	constructor(agentDir: string) {
		this.trustPath = join(resolvePath(agentDir), "trust.json");
	}

	/** 查询 cwd 的生效信任决定（含祖先目录继承）；无任何记录时返回 null。 */
	get(cwd: string): ProjectTrustDecision {
		return this.getEntry(cwd)?.decision ?? null;
	}

	/** 同 {@link get}，但额外返回命中的记录所在的目录（可能是祖先目录）。 */
	getEntry(cwd: string): ProjectTrustStoreEntry | null {
		return withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			return findNearestTrustEntry(data, cwd);
		});
	}

	/** 写入单个目录的信任决定；decision 为 null 表示清除该目录的记录。 */
	set(cwd: string, decision: ProjectTrustDecision): void {
		this.setMany([{ path: cwd, decision }]);
	}

	/**
	 * 批量写入多条信任更新，在单次锁内完成「读 → 应用全部更新 → 写回」，
	 * 保证多目录更新（如信任父目录时清除子目录记录）的原子性。
	 */
	setMany(decisions: ProjectTrustUpdate[]): void {
		withTrustFileLock(this.trustPath, () => {
			const data = readTrustFile(this.trustPath);
			for (const { path, decision } of decisions) {
				const key = normalizeCwd(path);
				if (decision === null) {
					// null 的语义是「删除条目」，而不是把 null 存进文件
					delete data[key];
				} else {
					data[key] = decision;
				}
			}
			writeTrustFile(this.trustPath, data);
		});
	}
}
