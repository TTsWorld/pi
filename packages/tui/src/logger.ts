/**
 * @file logger.ts
 * @description 文件日志调试器 —— 可配置输出到文件的全局 logger 单例
 * @module pi-tui
 *
 * 主要功能：
 * - 提供全局 logger 单例，通过 configureLogging 风格的 configure() 按需开启/关闭文件日志
 * - 支持 debug/info/warn/error 四级日志级别过滤（低于配置级别的日志被丢弃）
 * - 提供针对 TUI 场景的语义化日志方法：keyInput（按键输入）、render（渲染结果）、
 *   focus（焦点变化）、componentLifecycle（组件生命周期）、stateChange（状态变更）
 * - 所有日志以「时间戳 + 级别 + 组件名 + 消息 + 可选数据」的格式追加写入本地文件
 *
 * 依赖关系：
 * - node:fs（appendFileSync/writeFileSync）—— 以同步方式写入/清空日志文件
 * - node:path（join）—— 拼接默认日志文件路径（process.cwd() 下的 tui-debug.log）
 * - 无外部依赖，可被包内任意模块直接引入
 */

import { appendFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * 日志配置接口
 *
 * 定义文件日志调试器的可配置项，通过 logger.configure() 以 Partial 形式局部覆盖。
 */
export interface LoggerConfig {
	/** 是否启用文件日志（默认关闭，避免在生产环境意外写文件） */
	enabled: boolean;
	/** 日志文件的完整路径（默认为当前工作目录下的 tui-debug.log） */
	logFile: string;
	/** 日志级别阈值：debug | info | warn | error，只记录 >= 该级别的日志 */
	logLevel: "debug" | "info" | "warn" | "error";
}

/**
 * 文件日志类
 *
 * TUI 专用的调试日志器：把日志写入文件而非 stdout/stderr，
 * 因为 TUI 运行时终端输出被全屏渲染内容占用，往 stdout 打日志会破坏画面；
 * 写入独立文件既能排查问题，又不干扰终端 UI 显示。
 *
 * 日志被设计为「尽力而为」：任何写入失败都被静默吞掉，绝不影响主程序运行。
 */
class Logger {
	/** 当前生效的日志配置（默认关闭，日志写到 cwd 下的 tui-debug.log，级别 debug） */
	private config: LoggerConfig = {
		enabled: false,
		logFile: join(process.cwd(), "tui-debug.log"),
		logLevel: "debug",
	};

	/**
	 * 更新日志配置（可只传部分字段，其余保持原值）
	 *
	 * 惯用姿势：`logger.configure({ enabled: true })` 即可一键开启调试日志。
	 * 首次启用时会清空旧日志文件并写入带时间戳的头部，保证每次会话的日志干净独立。
	 *
	 * @param config - 部分配置项，与现有配置浅合并后整体替换
	 */
	configure(config: Partial<LoggerConfig>): void {
		// 浅合并：未传入的字段沿用旧值
		this.config = { ...this.config, ...config };

		if (this.config.enabled) {
			// 启动时清空日志文件，写入带时间戳的起始标记（覆盖写，避免残留上次会话的日志）
			try {
				writeFileSync(this.config.logFile, `=== TUI Debug Log Started ${new Date().toISOString()} ===\n`);
			} catch (error) {
				// 写文件失败时静默忽略 —— 调试日志不应让程序崩溃
			}
		}
	}

	/**
	 * 判断某条日志是否应该被记录（级别过滤）
	 *
	 * 级别按 debug < info < warn < error 的顺序定义在数组中，
	 * 用数组下标比较：仅当消息级别 >= 配置的阈值级别时才记录。
	 *
	 * @param level - 日志级别字符串（debug/info/warn/error）
	 * @returns 未启用日志或级别低于阈值时返回 false
	 */
	private shouldLog(level: string): boolean {
		// 未启用时直接短路，任何日志都不记录
		if (!this.config.enabled) return false;

		// 级别顺序数组：下标越大级别越高
		const levels = ["debug", "info", "warn", "error"];
		const currentLevel = levels.indexOf(this.config.logLevel);
		const messageLevel = levels.indexOf(level);

		return messageLevel >= currentLevel;
	}

	/**
	 * 日志写入的核心实现：格式化一行日志并同步追加到日志文件
	 *
	 * 格式为 `[ISO 时间戳] 级别 [组件名] 消息 | Data: {JSON 数据}`。
	 * 采用 appendFileSync 同步追加（调试日志量小，优先简单可靠）；
	 * 写入失败时静默忽略，保证日志绝不影响主流程。
	 *
	 * @param level - 日志级别字符串（debug/info/warn/error）
	 * @param component - 产生日志的组件名（如具体的 TUI 组件/模块名）
	 * @param message - 日志消息文本
	 * @param data - 可选的附加数据，会被 JSON 序列化后拼接到行尾
	 */
	private log(level: string, component: string, message: string, data?: any): void {
		// 先做级别过滤，低级别日志直接丢弃
		if (!this.shouldLog(level)) return;

		try {
			const timestamp = new Date().toISOString();
			// 有附加数据时序列化为 JSON 拼在行尾，否则留空
			const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : "";
			const logLine = `[${timestamp}] ${level.toUpperCase()} [${component}] ${message}${dataStr}\n`;

			// 同步追加写入日志文件
			appendFileSync(this.config.logFile, logLine);
		} catch (error) {
			// 写文件失败时静默忽略 —— 调试日志不应让程序崩溃
		}
	}

	/**
	 * 记录 debug 级别日志（最详细的调试信息）
	 *
	 * @param component - 组件名
	 * @param message - 消息文本
	 * @param data - 可选的附加数据
	 */
	debug(component: string, message: string, data?: any): void {
		this.log("debug", component, message, data);
	}

	/**
	 * 记录 info 级别日志（一般性流程信息）
	 *
	 * @param component - 组件名
	 * @param message - 消息文本
	 * @param data - 可选的附加数据
	 */
	info(component: string, message: string, data?: any): void {
		this.log("info", component, message, data);
	}

	/**
	 * 记录 warn 级别日志（警告信息）
	 *
	 * @param component - 组件名
	 * @param message - 消息文本
	 * @param data - 可选的附加数据
	 */
	warn(component: string, message: string, data?: any): void {
		this.log("warn", component, message, data);
	}

	/**
	 * 记录 error 级别日志（错误信息）
	 *
	 * @param component - 组件名
	 * @param message - 消息文本
	 * @param data - 可选的附加数据
	 */
	error(component: string, message: string, data?: any): void {
		this.log("error", component, message, data);
	}

	// ---- TUI 专用语义化日志方法：在通用级别方法之上封装常见调试场景 ----

	/**
	 * 记录按键输入事件（debug 级别）
	 *
	 * 除原始按键数据外，还附带每个字符的 charCode 数组，
	 * 便于排查转义序列、控制字符等不可见按键的输入问题。
	 *
	 * @param component - 组件名
	 * @param keyData - 原始按键字符串（可能包含转义序列）
	 */
	keyInput(component: string, keyData: string): void {
		this.debug(component, "Key input received", {
			keyData,
			charCodes: Array.from(keyData).map((c) => c.charCodeAt(0)),
		});
	}

	/**
	 * 记录渲染结果（debug 级别），用于排查组件输出内容
	 *
	 * @param component - 组件名
	 * @param renderResult - 渲染产物（任意结构，会被 JSON 序列化）
	 */
	render(component: string, renderResult: any): void {
		this.debug(component, "Render result", renderResult);
	}

	/**
	 * 记录焦点变化（info 级别），消息自动区分「获得/失去」焦点
	 *
	 * @param component - 组件名
	 * @param focused - true 表示获得焦点，false 表示失去焦点
	 */
	focus(component: string, focused: boolean): void {
		this.info(component, `Focus ${focused ? "gained" : "lost"}`);
	}

	/**
	 * 记录组件生命周期动作（info 级别），如 mount、unmount 等
	 *
	 * @param component - 组件名
	 * @param action - 生命周期动作名称（直接拼入消息文本）
	 * @param details - 可选的附加详情
	 */
	componentLifecycle(component: string, action: string, details?: any): void {
		this.info(component, `Component ${action}`, details);
	}

	/**
	 * 记录组件状态属性变更（debug 级别），以 {oldValue, newValue} 形式记录变更前后值
	 *
	 * @param component - 组件名
	 * @param property - 发生变更的状态属性名
	 * @param oldValue - 变更前的值
	 * @param newValue - 变更后的值
	 */
	stateChange(component: string, property: string, oldValue: any, newValue: any): void {
		this.debug(component, `State change: ${property}`, { oldValue, newValue });
	}
}

/**
 * 全局 logger 单例
 *
 * 包内所有模块共享这一个实例；默认关闭日志输出，
 * 调用 `logger.configure({ enabled: true, ... })` 即可开启文件调试日志。
 */
export const logger = new Logger();
