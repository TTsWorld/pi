/**
 * @file footer-data-provider.ts —— TUI 底栏数据提供器
 *
 * @description
 * 为终端 UI 底部状态栏（footer）聚合展示数据：当前 git 分支、扩展状态文本、
 * 可用模型供应商数量等。其中 git 分支是最复杂的部分——需要从磁盘上的 .git
 * 元数据解析分支名，并通过文件监听（fs.watch / watchFile）实时感知分支切换，
 * 同时兼容 worktree、reftable 仓库、WSL 挂载路径等多种边界情形。
 *
 * 主要功能点：
 * - `findGitPaths`：从 cwd 逐级向上查找 .git，兼容普通仓库（.git 为目录）
 *   与 worktree（.git 为文件）两种布局；
 * - `FooterDataProvider`：核心类，持有分支缓存与各类文件 watcher，
 *   支持同步/异步分支解析、去抖刷新、监听失败自动重试、cwd 切换重建；
 * - `ReadonlyFooterDataProvider`：暴露给扩展的只读视图类型，防止外部篡改内部状态。
 *
 * 依赖关系：
 * - `../utils/fs-watch.ts`：带错误处理的 watcher 封装与重试延迟常量；
 * - node 内置 fs / child_process：读取 git 元数据与调用 git 命令。
 */
import { type ExecFileException, execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, readFileSync, type Stats, statSync, unwatchFile, watchFile } from "fs";
import { dirname, join, resolve } from "path";
import { closeWatcher, FS_WATCH_RETRY_DELAY_MS, watchWithErrorHandler } from "../utils/fs-watch.ts";

/**
 * git 仓库元数据的关键路径集合。
 * - repoDir：包含 .git 的工作区根目录；
 * - commonGitDir：共享 git 元数据目录（worktree 场景为主仓库的 git 目录，普通仓库即 .git 本身）；
 * - headPath：HEAD 文件绝对路径，是读取分支名的直接来源。
 */
export type GitPaths = {
	repoDir: string;
	commonGitDir: string;
	headPath: string;
};

/**
 * 从 cwd 开始逐级向上查找 git 元数据路径。
 * 兼容两种仓库布局：普通仓库（.git 是目录）与 worktree（.git 是文件，
 * 内容形如 "gitdir: <主仓库 git 目录>/worktrees/<名称>"）。
 * 找不到 .git 或元数据不完整时返回 null。
 */
export function findGitPaths(cwd: string): GitPaths | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) {
			try {
				const stat = statSync(gitPath);
				if (stat.isFile()) {
					// worktree 场景：.git 是文件，内容为 "gitdir: <路径>"
					const content = readFileSync(gitPath, "utf8").trim();
					if (content.startsWith("gitdir: ")) {
						// 去掉 "gitdir: " 前缀（8 个字符），得到本 worktree 的私有 git 目录
						const gitDir = resolve(dir, content.slice(8).trim());
						const headPath = join(gitDir, "HEAD");
						if (!existsSync(headPath)) return null;
						// commondir 文件指向主仓库共享的 git 目录；没有该文件则自身即完整 git 目录
						const commonDirPath = join(gitDir, "commondir");
						const commonGitDir = existsSync(commonDirPath)
							? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
							: gitDir;
						return { repoDir: dir, commonGitDir, headPath };
					}
				} else if (stat.isDirectory()) {
					// 普通仓库场景：.git 目录内直接有 HEAD
					const headPath = join(gitPath, "HEAD");
					if (!existsSync(headPath)) return null;
					return { repoDir: dir, commonGitDir: gitPath, headPath };
				}
			} catch {
				// 读取/解析元数据失败（如权限问题）一律视为不在 git 仓库中
				return null;
			}
		}
		// 向上一级目录继续查找；parent === dir 说明已到文件系统根目录
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/**
 * 同步调用 git 命令查询当前分支名。
 * 处于 detached HEAD 或 git 不可用时返回 null。
 * --quiet/--short 让输出即为纯分支名；
 * --no-optional-locks 避免后台读取时意外创建 index.lock 干扰用户的并发 git 操作。
 */
function resolveBranchWithGitSync(repoDir: string): string | null {
	const result = spawnSync("git", ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: repoDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const branch = result.status === 0 ? result.stdout.trim() : "";
	// 空输出（detached HEAD 下 symbolic-ref 静默失败）归一化为 null
	return branch || null;
}

/**
 * 异步调用 git 命令查询当前分支名（resolveBranchWithGitSync 的异步版本）。
 * 处于 detached HEAD 或 git 不可用时 resolve 为 null。
 * 供刷新流程使用，避免同步子进程阻塞 TUI 渲染。
 */
function resolveBranchWithGitAsync(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		execFile(
			"git",
			["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
			{
				cwd: repoDir,
				encoding: "utf8",
			},
			(error: ExecFileException | null, stdout: string) => {
				if (error) {
					// 命令失败（detached HEAD / git 不可用）不抛错，静默返回 null
					resolvePromise(null);
					return;
				}
				const branch = stdout.trim();
				resolvePromise(branch || null);
			},
		);
	});
}

/** 判断是否运行在 WSL（Windows Subsystem for Linux）环境，依据 WSL 特有的环境变量。 */
function isWslEnvironment(): boolean {
	return process.platform === "linux" && !!(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

/** 判断仓库路径是否位于 Windows 盘符挂载点（如 /mnt/c/...）之下。 */
function isWindowsMountedRepoPath(repoDir: string): boolean {
	return /^\/mnt\/[a-z](?:\/|$)/i.test(repoDir);
}

/**
 * 决定是否需要改用轮询（watchFile）方式监听 HEAD：
 * 仅当运行在 WSL 且仓库位于 /mnt/<盘符>/ 挂载路径时才轮询——
 * 这类跨操作系统的挂载路径上 inotify 事件不可靠，必须回退到 stat 轮询。
 */
function shouldPollGitHead(repoDir: string): boolean {
	return isWslEnvironment() && isWindowsMountedRepoPath(repoDir);
}

/**
 * 底栏数据提供器：为 TUI 底部状态栏聚合「扩展自身无法获取」的数据——
 * git 分支、扩展状态文本、可用模型供应商数量。
 * （上下文用量走 ctx.getContextUsage()，token 统计走 ctx.sessionManager.getEntries()，
 * 模型信息走 ctx.model，均不经过本类。）
 *
 * 工作原理：
 * - 分支名优先直接读 HEAD 文件（快、无子进程），结果缓存在 cachedBranch；
 * - 通过 watcher 监听 HEAD / reftable 目录变更，去抖 500ms 后异步刷新缓存，
 *   分支真正变化时回调所有 onBranchChange 注册的监听者（驱动底栏重绘）；
 * - watcher 出错时清空并按固定延迟自动重试重建，保证 git 目录被临时删除/重建后仍能恢复监听。
 */
export class FooterDataProvider {
	private cwd: string;
	/** 文件事件后的刷新去抖间隔（毫秒）：合并短时间内的连续事件，避免频繁读盘 */
	private static readonly WATCH_DEBOUNCE_MS = 500;

	/** 扩展状态文本表（key 为扩展标识，由 ctx.ui.setStatus() 写入） */
	private extensionStatuses = new Map<string, string>();
	/** 分支名缓存：undefined = 尚未解析；null = 不在仓库中；"detached" = detached HEAD */
	private cachedBranch: string | null | undefined = undefined;
	/** 当前 cwd 对应的 git 元数据路径；undefined = 尚未查找；null = 不在 git 仓库中 */
	private gitPaths: GitPaths | null | undefined = undefined;
	private headWatcher: FSWatcher | null = null;
	/** WSL 轮询兜底模式下监听的 HEAD 文件路径（配合下方 listener 成对清理） */
	private headWatchFilePath: string | null = null;
	private headWatchFileListener: ((current: Stats, previous: Stats) => void) | null = null;
	private reftableWatcher: FSWatcher | null = null;
	private reftableTablesListWatcher: FSWatcher | null = null;
	private reftableTablesListPath: string | null = null;
	/** 分支变化回调集合；用 Set 天然去重，注销即删除 */
	private branchChangeCallbacks = new Set<() => void>();
	private availableProviderCount = 0;
	/** 去抖刷新定时器句柄 */
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** watcher 重建的重试定时器句柄 */
	private gitWatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
	/** 异步刷新互斥标记：同一时刻只允许一个刷新在途 */
	private refreshInFlight = false;
	/** 刷新在途期间又来了新事件时置位，待在途刷新结束后补一次 */
	private refreshPending = false;
	private disposed = false;

	constructor(cwd: string) {
		// 构造时即查找 git 路径并建立监听；分支名延迟到首次 getGitBranch() 才解析
		this.cwd = cwd;
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
	}

	/** 当前 git 分支名；不在仓库中返回 null，detached HEAD 时返回 "detached"。首次调用时懒解析并缓存。 */
	getGitBranch(): string | null {
		if (this.cachedBranch === undefined) {
			this.cachedBranch = this.resolveGitBranchSync();
		}
		return this.cachedBranch;
	}

	/** 扩展通过 ctx.ui.setStatus() 设置的状态文本表（key 为扩展标识），供底栏渲染。 */
	getExtensionStatuses(): ReadonlyMap<string, string> {
		return this.extensionStatuses;
	}

	/**
	 * 订阅 git 分支变化；返回取消订阅函数。
	 * watcher 感知到 HEAD/reftable 变更并异步刷新后，若分支与缓存不同即触发全部回调。
	 */
	onBranchChange(callback: () => void): () => void {
		this.branchChangeCallbacks.add(callback);
		return () => this.branchChangeCallbacks.delete(callback);
	}

	/** 内部方法：设置某个扩展的状态文本；text 传 undefined 表示删除该扩展的条目。 */
	setExtensionStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.extensionStatuses.delete(key);
		} else {
			this.extensionStatuses.set(key, text);
		}
	}

	/** 内部方法：清空全部扩展状态文本（会话重置等场景）。 */
	clearExtensionStatuses(): void {
		this.extensionStatuses.clear();
	}

	/** 拥有可用模型的供应商数量（底栏展示用）。 */
	getAvailableProviderCount(): number {
		return this.availableProviderCount;
	}

	/** 内部方法：更新可用供应商数量（由宿主在模型注册表刷新后调用）。 */
	setAvailableProviderCount(count: number): void {
		this.availableProviderCount = count;
	}

	/** 切换工作目录：重置 git 相关状态——清掉旧 watcher 与缓存，重新查找并监听，并立即通知一次分支变化。 */
	setCwd(cwd: string): void {
		if (this.cwd === cwd) {
			return; // 目录未变化则无事可做
		}

		this.cwd = cwd;
		if (this.refreshTimer) {
			// 取消尚未触发的去抖刷新，避免用旧的 gitPaths 状态解析
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.cachedBranch = undefined; // 重置缓存，下次 getGitBranch() 重新解析
		this.gitPaths = findGitPaths(cwd);
		this.setupGitWatcher();
		this.notifyBranchChange();
	}

	/** 内部方法：销毁实例——停掉所有定时器与 watcher、清空回调，确保销毁后不再触发任何刷新。 */
	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.clearGitWatchers();
		this.branchChangeCallbacks.clear();
	}

	/** 逐个调用已注册的分支变化回调。 */
	private notifyBranchChange(): void {
		for (const cb of this.branchChangeCallbacks) cb();
	}

	/**
	 * 安排一次去抖刷新：WATCH_DEBOUNCE_MS 时间窗内的多个文件事件只触发一次真正的异步解析。
	 * 若已有异步刷新在途，则只置 refreshPending 标记，由在途那次结束时补跑。
	 */
	private scheduleRefresh(): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshGitBranchAsync();
		}, FooterDataProvider.WATCH_DEBOUNCE_MS);
	}

	/**
	 * 异步刷新分支缓存。仅在分支「真正变化」时才通知监听者，
	 * 避免重复的 HEAD 写入或无关文件事件导致底栏无谓重绘。
	 */
	private async refreshGitBranchAsync(): Promise<void> {
		if (this.disposed) return;
		if (this.refreshInFlight) {
			// 已有刷新在途：仅标记待刷新，由在途那次在 finally 中补跑
			this.refreshPending = true;
			return;
		}

		this.refreshInFlight = true;
		try {
			const nextBranch = await this.resolveGitBranchAsync();
			if (this.disposed) return; // await 期间可能已被销毁
			if (this.cachedBranch !== undefined && this.cachedBranch !== nextBranch) {
				// 缓存已有值且与新值不同 → 真正的分支切换，通知订阅者
				this.cachedBranch = nextBranch;
				this.notifyBranchChange();
				return;
			}
			// 首次填充缓存或值未变化：静默更新，不触发回调
			this.cachedBranch = nextBranch;
		} finally {
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				// 刷新期间又收到新事件：补一次调度
				this.refreshPending = false;
				this.scheduleRefresh();
			}
		}
	}

	/**
	 * 同步解析当前分支：直接读 HEAD 文件，不派生子进程。
	 * HEAD 内容形如 "ref: refs/heads/<分支>"；若直接是 commit id 则为 detached HEAD。
	 */
	private resolveGitBranchSync(): string | null {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16); // 16 = "ref: refs/heads/".length
				// ".invalid" 是某些工具写入的占位分支名：改用 git 命令二次确认，仍取不到则按 detached 处理
				return branch === ".invalid" ? (resolveBranchWithGitSync(this.gitPaths.repoDir) ?? "detached") : branch;
			}
			// HEAD 直接指向 commit id（非符号引用）→ detached HEAD
			return "detached";
		} catch {
			// 读不到 HEAD（仓库被删除等）→ 视为不在仓库中
			return null;
		}
	}

	/**
	 * 异步解析当前分支：与 resolveGitBranchSync 逻辑相同，
	 * 区别仅在 ".invalid" 占位分支的兜底走异步 git 命令（不阻塞）。
	 */
	private async resolveGitBranchAsync(): Promise<string | null> {
		try {
			if (!this.gitPaths) return null;
			const content = readFileSync(this.gitPaths.headPath, "utf8").trim();
			if (content.startsWith("ref: refs/heads/")) {
				const branch = content.slice(16);
				return branch === ".invalid"
					? ((await resolveBranchWithGitAsync(this.gitPaths.repoDir)) ?? "detached")
					: branch;
			}
			return "detached";
		} catch {
			return null;
		}
	}

	/** 清理全部 git 相关监听资源：fs.watch 句柄、watchFile 轮询与重试定时器。 */
	private clearGitWatchers(): void {
		closeWatcher(this.headWatcher);
		this.headWatcher = null;
		if (this.headWatchFilePath && this.headWatchFileListener) {
			unwatchFile(this.headWatchFilePath, this.headWatchFileListener);
			this.headWatchFilePath = null;
			this.headWatchFileListener = null;
		}
		closeWatcher(this.reftableWatcher);
		this.reftableWatcher = null;
		closeWatcher(this.reftableTablesListWatcher);
		this.reftableTablesListWatcher = null;
		if (this.reftableTablesListPath) {
			// tables.list 的 watchFile 未保存 listener 引用，用无参 unwatchFile 全量取消
			unwatchFile(this.reftableTablesListPath);
			this.reftableTablesListPath = null;
		}
		if (this.gitWatcherRetryTimer) {
			clearTimeout(this.gitWatcherRetryTimer);
			this.gitWatcherRetryTimer = null;
		}
	}

	/** 安排一次 watcher 重建重试；已有重试定时器在途时不重复安排。 */
	private scheduleGitWatcherRetry(): void {
		if (this.disposed || this.gitWatcherRetryTimer) {
			return;
		}

		this.gitWatcherRetryTimer = setTimeout(() => {
			this.gitWatcherRetryTimer = null;
			this.setupGitWatcher();
		}, FS_WATCH_RETRY_DELAY_MS);
	}

	/** watcher 出错（如监听的目录被删除）后的统一处理：先全部清理，再延迟重建。 */
	private handleGitWatcherError(): void {
		this.clearGitWatchers();
		this.scheduleGitWatcherRetry();
	}

	/**
	 * 建立 git 分支监听。三套机制叠加：
	 * 1. fs.watch 监听 HEAD 所在目录（常规路径）；
	 * 2. WSL + /mnt 挂载场景追加 1s 间隔的 stat 轮询兜底；
	 * 3. reftable 仓库额外监听 reftable 目录与 tables.list 文件。
	 */
	private setupGitWatcher(): void {
		this.clearGitWatchers();
		if (!this.gitPaths) return; // 不在 git 仓库中，无需监听

		const pollGitHead = shouldPollGitHead(this.gitPaths.repoDir);

		// 监听 HEAD 所在目录而非 HEAD 文件本身。
		// git 更新 HEAD 采用原子写（先写临时文件再 rename 覆盖），会改变 inode；
		// 而 fs.watch 监听单个文件在 inode 变化后会失效，因此必须监听目录。
		this.headWatcher = watchWithErrorHandler(
			dirname(this.gitPaths.headPath),
			(_eventType, filename) => {
				// 部分 platform 不回传 filename，此时保守起见也视为 HEAD 变化
				if (!filename || filename === "HEAD") {
					this.scheduleRefresh();
				}
			},
			() => this.handleGitWatcherError(),
		);
		if (pollGitHead) {
			// WSL + /mnt 挂载场景：inotify 不可靠，追加 1s 间隔的 stat 轮询兜底
			this.headWatchFilePath = this.gitPaths.headPath;
			this.headWatchFileListener = (current, previous) => {
				// mtime/ctime/size 任一变化即认为 HEAD 被改写
				if (
					current.mtimeMs !== previous.mtimeMs ||
					current.ctimeMs !== previous.ctimeMs ||
					current.size !== previous.size
				) {
					this.scheduleRefresh();
				}
			};
			watchFile(this.headWatchFilePath, { interval: 1000 }, this.headWatchFileListener);
		}
		if (!this.headWatcher && !pollGitHead) {
			// 目录监听建立失败且未启用轮询兜底：无法感知变化，直接放弃后续 reftable 监听
			return;
		}

		// reftable 仓库中，切换分支更新的是 reftable 目录下的文件而非 HEAD。
		// 需要单独监听该目录，底栏才能在这类仓库中感知分支切换。
		const reftableDir = join(this.gitPaths.commonGitDir, "reftable");
		if (existsSync(reftableDir)) {
			this.reftableWatcher = watchWithErrorHandler(
				reftableDir,
				() => {
					this.scheduleRefresh();
				},
				() => this.handleGitWatcherError(),
			);
			if (!this.reftableWatcher) {
				return;
			}

			const tablesListPath = join(reftableDir, "tables.list");
			if (existsSync(tablesListPath)) {
				// tables.list 记录当前激活的 reftable 表，切换分支时会被重写
				this.reftableTablesListPath = tablesListPath;
				this.reftableTablesListWatcher = watchWithErrorHandler(
					tablesListPath,
					() => {
						this.scheduleRefresh();
					},
					() => this.handleGitWatcherError(),
				);
				if (!this.reftableTablesListWatcher) {
					return;
				}
				// 文件级 watcher 在被 rename 覆盖后可能失效，再叠加 250ms 高频轮询双保险
				watchFile(tablesListPath, { interval: 250 }, (current, previous) => {
					if (
						current.mtimeMs !== previous.mtimeMs ||
						current.ctimeMs !== previous.ctimeMs ||
						current.size !== previous.size
					) {
						this.scheduleRefresh();
					}
				});
			}
		}
	}
}

/**
 * 暴露给扩展的只读视图类型：只保留查询与订阅方法，
 * 剔除 setExtensionStatus / setAvailableProviderCount / dispose 等内部写入方法。
 */
export type ReadonlyFooterDataProvider = Pick<
	FooterDataProvider,
	"getGitBranch" | "getExtensionStatuses" | "getAvailableProviderCount" | "onBranchChange"
>;
