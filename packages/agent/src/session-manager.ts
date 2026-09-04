/**
 * @file session-manager.ts
 * @description 会话管理器 —— JSONL 会话文件持久化与恢复
 * @module pi-agent
 *
 * 主要功能：
 * - 计算并创建当前 cwd 对应的会话目录，生成/定位会话 JSONL 文件
 *   （首行为 SessionHeader，其后每个事件追加一行 SessionEvent）
 * - 实现 AgentEventReceiver 接口：记录与渲染共用同一条事件流，事件边产生边落盘
 * - 支持 continueSession 复用当前 cwd 下 mtime 最新的会话文件，
 *   并可通过 getSessionData() 还原配置、事件列表与 token 用量
 */

import { randomBytes } from "crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { AgentConfig, AgentEvent, AgentEventReceiver } from "./agent.js";

/**
 * 简单的 UUID v4 生成器：直接用 crypto 随机字节按 RFC 4122 拼出标准 UUID 字符串，
 * 避免为这一个功能引入第三方依赖
 */
function uuidv4(): string {
	const bytes = randomBytes(16);
	// 第 7 字节高 4 位固定为 0100，即版本号 4（UUID v4）
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	// 第 9 字节高 2 位固定为 10，即 RFC 4122 变体
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 会话文件首行（SessionHeader）：记录会话的元信息（ID、开始时间、工作目录、Agent 配置）
 * 序列化后是 JSONL 文件中 type 为 "session" 的那一行
 */
export interface SessionHeader {
	type: "session";
	id: string;
	timestamp: string;
	cwd: string;
	config: AgentConfig;
}

/**
 * 会话事件条目（SessionEvent）：会话首行之后追加的每一行，type 为 "event"
 * 包裹一个 AgentEvent 以及记录该事件时的时间戳
 */
export interface SessionEvent {
	type: "event";
	timestamp: string;
	event: AgentEvent;
}

/**
 * getSessionData() 的解析结果：从会话文件还原出的完整会话数据
 * - config：会话头中的 AgentConfig
 * - events：按时间顺序收集的全部会话事件
 * - totalUsage：最近一次 token_usage 事件中的 token 用量统计
 */
export interface SessionData {
	config: AgentConfig;
	events: SessionEvent[];
	totalUsage: Extract<AgentEvent, { type: "token_usage" }>;
}

/**
 * 会话管理器 —— 把 Agent 会话持久化为 JSONL 文件，并在之后恢复
 *
 * 实现了 AgentEventReceiver 接口，因此可直接作为事件接收器挂到 Agent 上：
 * 记录与渲染走同一条事件流，Agent 每产生一个事件，on() 就把它追加写入会话文件。
 *
 * 存储格式（JSONL，每行一个独立的 JSON 对象）：
 *   第 1 行：SessionHeader（type: "session"）—— 会话 ID、时间戳、cwd、AgentConfig
 *   后续行：SessionEvent（type: "event"）—— 逐条追加的 AgentEvent
 *
 * 为何用 JSONL 逐行追加而非整体 JSON：
 * - Agent 事件是流式产生的，逐行 append 可实时落盘，无需在内存持有整个会话历史、
 *   也不必每来一个事件就重写整个文件
 * - 追加写的开销极小，进程崩溃时此前已写入的事件不会丢失
 * - 单行损坏只影响该行，解析时可直接跳过坏行；整体 JSON 一处损坏则全文件不可读
 */
export class SessionManager implements AgentEventReceiver {
	private sessionId!: string; // 当前会话的唯一标识（UUID v4）
	private sessionFile!: string; // 会话 JSONL 文件的绝对路径
	private sessionDir: string; // 当前 cwd 对应的会话目录（<配置根>/sessions/<编码后的 cwd>）

	/**
	 * 创建会话管理器
	 *
	 * @param continueSession 是否继续（恢复）最近一次会话：
	 *   - true：在会话目录中找 mtime 最新的 .jsonl 文件复用（后续事件继续追加到同一文件），
	 *     并从文件首行读回原 sessionId；目录下没有会话文件时退化为新建
	 *   - false（默认）：总是新建会话
	 */
	constructor(continueSession: boolean = false) {
		this.sessionDir = this.getSessionDirectory();

		if (continueSession) {
			const mostRecent = this.findMostRecentlyModifiedSession();
			if (mostRecent) {
				this.sessionFile = mostRecent;
				// 复用已有文件：从文件首行读回原会话 ID
				this.loadSessionId();
			} else {
				// 没有可继续的会话，新建一个
				this.initNewSession();
			}
		} else {
			this.initNewSession();
		}
	}

	/**
	 * 计算当前 cwd 对应的会话目录（不存在则递归创建）
	 *
	 * 目录结构：<配置根>/sessions/<safePath>/
	 * - 配置根默认为 ~/.pi，可用环境变量 PI_CONFIG_DIR 覆盖
	 * - safePath 是把 cwd 编码成合法目录名的结果，规则：
	 *   去掉开头的 "/"，其余 "/" 全部替换为 "-"，再首尾包上 "--"，例如：
	 *   "/Users/zhihu/code/m_code/ai/pi" → "--Users-zhihu-code-m_code-ai-pi--"
	 *   由此不同项目的 cwd 互不冲突，同一项目的会话集中在同一目录下
	 */
	private getSessionDirectory(): string {
		const cwd = process.cwd();
		// cwd → 安全目录名：去开头斜杠、其余斜杠替换为 "-"、首尾包 "--"
		const safePath = "--" + cwd.replace(/^\//, "").replace(/\//g, "-") + "--";

		// 配置根目录：优先取 PI_CONFIG_DIR 环境变量，否则默认 ~/.pi
		const piConfigDir = resolve(process.env.PI_CONFIG_DIR || join(homedir(), ".pi"));
		const sessionDir = join(piConfigDir, "sessions", safePath);
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}
		return sessionDir;
	}

	/**
	 * 初始化新会话：生成 UUID v4 作为会话 ID，并按 <timestamp>_<uuid>.jsonl 命名会话文件
	 * 时间戳中的 ":" 和 "." 被替换为 "-"，避免文件名中出现文件系统不允许的字符
	 */
	private initNewSession(): void {
		this.sessionId = uuidv4();
		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.sessionFile = join(this.sessionDir, `${timestamp}_${this.sessionId}.jsonl`);
	}

	/**
	 * 在会话目录中查找 mtime（最后修改时间）最新的 .jsonl 会话文件
	 * 用于 continueSession 场景：取最近一次会话的文件继续追加
	 *
	 * @returns 最新会话文件的路径；目录为空或读取失败时返回 null
	 */
	private findMostRecentlyModifiedSession(): string | null {
		try {
			// 列出目录下全部 .jsonl 文件，按 mtime 从新到旧排序，取第一个
			const files = readdirSync(this.sessionDir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => ({
					name: f,
					path: join(this.sessionDir, f),
					mtime: statSync(join(this.sessionDir, f)).mtime,
				}))
				.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			return files[0]?.path || null;
		} catch {
			// 目录读取失败（如目录不存在）视为没有可继续的会话
			return null;
		}
	}

	/**
	 * 从已有会话文件中读回 sessionId
	 * 逐行解析 JSONL，找到 type 为 "session" 的行（SessionHeader）并取其 id；
	 * 若文件不存在、没有会话头或行解析失败，则兜底重新生成一个 ID
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
				// 跳过无法解析的坏行
			}
		}
		// 整个文件都没找到会话头，兜底生成新 ID
		this.sessionId = uuidv4();
	}

	/**
	 * 开始会话：把 SessionHeader 作为首行写入会话文件
	 * 由 Agent 在会话启动时调用，记录会话 ID、时间、cwd 与完整的 AgentConfig，
	 * 供恢复会话时重建上下文
	 */
	startSession(config: AgentConfig): void {
		const entry: SessionHeader = {
			type: "session",
			id: this.sessionId,
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			config,
		};
		// JSONL 追加写：把对象序列化成一行后加上换行符落盘
		appendFileSync(this.sessionFile, JSON.stringify(entry) + "\n");
	}

	/**
	 * AgentEventReceiver 接口实现：Agent 每产生一个事件就回调本方法
	 * 把事件包装成 SessionEvent 追加到会话文件末尾——与渲染共用同一条事件流，
	 * 实现"边运行边落盘"，无需在内存中累积整个会话历史
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
	 * 解析当前会话文件，还原完整会话数据
	 *
	 * 逐行读取 JSONL：
	 * - "session" 行 → 恢复 config，并同步刷新 sessionId
	 * - "event" 行 → 收集进 events；其中 token_usage 事件会整体覆盖 totalUsage，
	 *   因此最终返回的是最近一次（最新）记录的 token 用量，而非逐条累加
	 * 单行解析失败会被跳过，不影响其余行的解析
	 *
	 * @returns 会话数据；文件不存在或没有会话头（config 缺失）时返回 null
	 */
	getSessionData(): SessionData | null {
		if (!existsSync(this.sessionFile)) return null;

		let config: AgentConfig | null = null;
		const events: SessionEvent[] = [];
		// totalUsage 初始为零值，后续被 token_usage 事件覆盖
		let totalUsage: Extract<AgentEvent, { type: "token_usage" }> = {
			type: "token_usage",
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};

		const lines = readFileSync(this.sessionFile, "utf8").trim().split("\n");
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "session") {
					// 会话头：恢复配置与 sessionId
					config = entry.config;
					this.sessionId = entry.id;
				} else if (entry.type === "event") {
					// 事件行：收集事件；token_usage 直接覆盖（保留最新一次的用量）
					const eventEntry: SessionEvent = entry as SessionEvent;
					events.push(eventEntry);
					if (eventEntry.event.type === "token_usage") {
						totalUsage = entry.event as Extract<AgentEvent, { type: "token_usage" }>;
					}
				}
			} catch {
				// 跳过无法解析的坏行
			}
		}

		return config ? { config, events, totalUsage } : null;
	}

	/**
	 * 获取当前会话 ID
	 */
	getSessionId(): string {
		return this.sessionId;
	}

	/**
	 * 获取当前会话文件（JSONL）的路径
	 */
	getSessionFile(): string {
		return this.sessionFile;
	}
}
