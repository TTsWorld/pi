/**
 * @file 会话管理器（SessionManager）
 * @description
 * 负责将 agent 会话以 JSONL（每行一个 JSON 对象）事件日志的形式追加写入磁盘，
 * 并支持恢复最近一次会话。
 *
 * 核心数据结构：
 * - SessionHeader：会话首行记录（type: "session"），包含会话 ID、时间戳、
 *   启动时的工作目录（cwd）以及 AgentConfig 配置快照。
 * - SessionEvent：会话过程中的每条事件记录（type: "event"），
 *   包裹一个 AgentEvent 及其时间戳。
 * - SessionData：读取会话文件后聚合出的结果（配置 + 全部事件 + token 用量总计）。
 *
 * 存储路径规则：
 * - 根目录取环境变量 PI_CONFIG_DIR，未设置时默认为 ~/.pi
 * - 会话文件存放于 <配置根目录>/sessions/<safePath>/ 下，其中 safePath 是
 *   由当前工作目录转换而来的 "--路径-斜杠-替换-为-连字符--" 形式，
 *   保证不同项目的会话互相隔离。
 * - 文件名格式：`<ISO时间戳(冒号/点替换为-)>_<sessionId>.jsonl`
 *
 * 依赖关系：
 * - 依赖 Node 内置模块 crypto（生成 UUID）、fs（读写会话文件）、os、path
 * - 从 ./agent.js 导入类型 AgentConfig / AgentEvent / AgentEventReceiver，
 *   并通过实现 AgentEventReceiver 接口挂接到 agent 的事件流上
 */

import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { AgentConfig, AgentEvent, AgentEventReceiver } from "./agent.js";

// 简单的 UUID v4 生成器
function uuidv4(): string {
	const bytes = randomBytes(16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40; // 版本号固定为 4（Version 4）
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // 变体位固定为 10（Variant 10）
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 会话文件首行：会话元信息（ID、时间戳、工作目录、配置快照） */
export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	config: AgentConfig;
}

/** 会话事件记录：包裹一条 AgentEvent 并附上时间戳 */
export interface SessionEvent {
	type: "event";
	timestamp: string;
	event: AgentEvent;
}

/** 从会话文件聚合出的会话数据：配置、全部事件、token 总用量 */
export interface SessionData {
	config: AgentConfig;
	events: SessionEvent[];
	totalUsage: Extract<AgentEvent, { type: "token_usage" }>;
}

/**
 * 会话管理器
 *
 * 实现 AgentEventReceiver 接口，作为事件接收器挂到 agent 上，
 * 把会话头和每条事件追加写入 JSONL 文件；也提供读取会话数据、
 * 恢复最近会话等能力。
 */
export class SessionManager implements AgentEventReceiver {
	private sessionId!: string;
	private sessionFile!: string;
	private sessionDir: string;

	/**
	 * 构造函数：确定会话目录，并决定是恢复最近会话还是新建会话
	 * @param continueSession 为 true 时尝试恢复当前目录下最近修改的会话文件，
	 *                        找不到则退回新建；默认 false（始终新建）
	 */
	constructor(continueSession: boolean = false) {
		this.sessionDir = this.getSessionDirectory();

		if (continueSession) {
			const mostRecent = this.findMostRecentlyModifiedSession();
			if (mostRecent) {
				this.sessionFile = mostRecent;
				// 从已有会话文件中加载会话 ID
				this.loadSessionId();
			} else {
				// 没有已存在的会话，新建一个
				this.initNewSession();
			}
		} else {
			this.initNewSession();
		}
	}

	/**
	 * 计算并确保会话目录存在
	 *
	 * 目录规则：<PI_CONFIG_DIR 或 ~/.pi>/sessions/<由 cwd 转换的安全路径>
	 * Why 用 "--xxx--" 包裹：把绝对路径里的 "/" 替换成 "-"，
	 * 避免目录层级嵌套，同时用 "--" 边界防止不同路径转换后产生歧义。
	 * @returns 会话目录的绝对路径
	 */
	private getSessionDirectory(): string {
		const cwd = process.cwd();
		const safePath = "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";

		const piConfigDir = resolve(process.env.PI_CONFIG_DIR || join(homedir(), ".pi"));
		const sessionDir = join(piConfigDir, "sessions", safePath);
		if (!existsSync(sessionDir)) {
			// 目录不存在则递归创建（父目录可能也不存在）
			mkdirSync(sessionDir, { recursive: true });
		}
		return sessionDir;
	}

	/**
	 * 初始化一个全新会话：生成会话 ID 并确定会话文件路径
	 *
	 * Why 时间戳里的 ":" 和 "." 要替换成 "-"：这些字符在部分文件系统中
	 * 不合法或易引起歧义，替换后文件名可安全使用。
	 */
	private initNewSession(): void {
		this.sessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.sessionFile = join(this.sessionDir, `${timestamp}_${this.sessionId}.jsonl`);
	}

	/**
	 * 在会话目录中查找最近被修改过的会话文件
	 * @returns 最近会话文件的路径；目录为空或读取失败时返回 null
	 */
	private findMostRecentlyModifiedSession(): string | null {
		try {
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({
					name: f,
					path: join(this.sessionDir, f),
					mtime: statSync(join(this.sessionDir, f)).mtime,
				}))
				// 按 mtime 降序排序，最新的排在最前
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			// 目录读取失败（如目录不存在）时视为无可恢复会话
			return null;
		}
	}

	/**
	 * 从会话文件中解析出会话 ID
	 *
	 * 逐行扫描 JSONL，找到第一条 type 为 "session" 的记录并取其 id。
	 */
	private loadSessionId(): void {
		if (!existsSync(this.sessionFile)) return;

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					this.sessionId = entry.id;
					return;
				}
			} catch {
				// 跳过格式错误的行
			}
		}
		// 若未找到 session 记录，则生成新 ID
		this.sessionId = uuidv4();
	}

	/**
	 * 写入会话头（SessionHeader）作为会话文件的第一行
	 * @param config 当前 agent 配置快照
	 */
	startSession(config: AgentConfig): void {
		const entry: SessionHeader = {
			type: "session",
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			config,
		};
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
	}

	/**
	 * AgentEventReceiver 接口实现：接收一条 agent 事件并追加写入会话文件
	 * @param event 要持久化的 agent 事件
	 */
	async on(event: AgentEvent): Promise<void> {
		const entry: SessionEvent = {
			type: "event",
			timestamp: new Date().toISOString(),
			event: event,
		};
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
	}

	/**
	 * 读取并聚合当前会话文件的全部数据
	 *
	 * 逐行解析 JSONL，还原会话配置与事件列表，并累加所有 token_usage
	 * 事件的用量得到总计（totalUsage）。
	 * @returns 会话数据；文件不存在或没有 session 头记录时返回 null
	 */
	getSessionData(): SessionData | null {
		if (!existsSync(this.sessionFile)) return null;

		let config: AgentConfig | null = null;
		const events: SessionEvent[] = [];
		// ========== token 用量累计初始化 ==========
		// 从全零开始累加，避免后续判空分支；首条 usage 直接展开拷贝
		let totalUsage: Extract<AgentEvent, { type: "token_usage" }> = {
			type: "token_usage",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
		};

		// ========== 逐行解析 JSONL ==========
		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					// session 头记录：还原配置，并同步会话 ID
					config = entry.config;
					this.sessionId = entry.id;
				} else if (entry.type === "event") {
					const eventEntry: SessionEvent = entry as SessionEvent;
					events.push(eventEntry);
					// ========== token_usage 事件累加 ==========
					if (eventEntry.event.type === "token_usage") {
						const usage = entry.event as Extract<AgentEvent, { type: "token_usage" }>;
						if (!totalUsage) {
							totalUsage = { ...usage };
						} else {
							totalUsage.inputTokens += usage.inputTokens;
							totalUsage.outputTokens += usage.outputTokens;
							totalUsage.totalTokens += usage.totalTokens;
							totalUsage.cacheReadTokens += usage.cacheReadTokens;
							totalUsage.cacheWriteTokens += usage.cacheWriteTokens;
							totalUsage.reasoningTokens += usage.reasoningTokens;
						}
					}
				}
			} catch {
				// 跳过格式错误的行
			}
		}

		// 没有 session 头说明不是有效会话文件，返回 null
		return config ? { config, events, totalUsage } : null;
	}

	/**
	 * 获取当前会话 ID
	 * @returns 会话 ID（UUID v4 字符串）
	 */
	getSessionId(): string {
		return this.sessionId;
	}

	/**
	 * 获取当前会话文件路径
	 * @returns 会话 JSONL 文件的绝对路径
	 */
	getSessionFile(): string {
		return this.sessionFile;
	}
}
