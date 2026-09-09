/**
 * @file terminal.ts
 * @description TUI 框架的终端底层抽象。定义统一的 Terminal 接口（输入、输出、
 *              尺寸查询、启动/停止生命周期），并提供基于 process.stdin/stdout
 *              的默认实现 ProcessTerminal。上层的渲染与输入组件只依赖此接口，
 *              便于在测试中注入 Mock 终端。仅依赖 Node.js 内置的 process 全局对象。
 */

/**
 * TUI 所需的最小终端接口
 *
 * 抽象出 TUI 框架运行所需的四个最小能力：启动/停止生命周期、
 * 读取用户输入、写入输出、查询终端行列尺寸。
 * 通过接口解耦，上层组件无需绑定真实 tty（测试时可注入 Mock 实现）。
 */
export interface Terminal {
	/**
	 * 启动终端，接管输入并注册回调
	 * @param onInput 收到用户按键输入（已按 UTF-8 解码的字符串）时的回调
	 * @param onResize 终端窗口尺寸发生变化时的回调
	 */
	start(onInput: (data: string) => void, onResize: () => void): void;

	/** 停止终端，恢复进入前的原始状态（如 raw mode、事件监听） */
	stop(): void;

	/**
	 * 向终端写入输出（通常为带 ANSI 转义序列的字符串）
	 * @param data 要写入的文本内容
	 */
	write(data: string): void;

	/** 终端列数（宽度，以字符为单位） */
	get columns(): number;

	/** 终端行数（高度，以字符为单位） */
	get rows(): number;
}

/**
 * 基于 process.stdin / process.stdout 的真实终端实现
 *
 * 直接操作 Node.js 进程的标准输入输出：
 * - 输入侧：开启 raw mode，使按键立即送达（不经过行缓冲、不回显），
 *   这是实现快捷键、方向键移动光标等 TUI 交互的前提
 * - 输出侧：原样写入 stdout，由上层组件负责拼装 ANSI 转义序列
 */
export class ProcessTerminal implements Terminal {
	/** 记录 start 之前 stdin 是否已处于 raw mode，stop 时据此还原 */
	private wasRaw = false;
	/** start 时注册的输入回调，保存引用以便 stop 时精确移除监听 */
	private inputHandler?: (data: string) => void;
	/** start 时注册的 resize 回调，保存引用以便 stop 时精确移除监听 */
	private resizeHandler?: () => void;

	/**
	 * 启动终端：保存回调、开启 raw mode 并挂载事件监听
	 * @param onInput 用户输入回调
	 * @param onResize 尺寸变化回调
	 */
	start(onInput: (data: string) => void, onResize: () => void): void {
		// ========== 保存回调引用 ==========
		// 保存引用而非在 stop 时用匿名函数移除，确保能精确 removeListener
		this.inputHandler = onInput;
		this.resizeHandler = onResize;

		// ========== 保存旧状态并开启 raw mode ==========
		// raw mode 下按键不经行缓冲、不回显，TUI 才能逐键响应；
		// 若 stdin 不支持 setRawMode（如被重定向到管道），则跳过而不报错
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		// 按 UTF-8 解码输入字节流，保证中文等多字节字符也能正确传给回调
		process.stdin.setEncoding("utf8");
		// 恢复 stdin 数据流（默认可能处于暂停状态），开始接收数据
		process.stdin.resume();

		// ========== 挂载事件监听 ==========
		process.stdin.on("data", this.inputHandler);
		process.stdout.on("resize", this.resizeHandler);
	}

	/** 停止终端：移除事件监听并还原 raw mode 到进入前的状态 */
	stop(): void {
		// ========== 移除事件监听 ==========
		if (this.inputHandler) {
			process.stdin.removeListener("data", this.inputHandler);
			this.inputHandler = undefined;
		}
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// ========== 还原 raw mode ==========
		// 使用启动前保存的 wasRaw 恢复，避免污染外层调用方的终端状态
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	/**
	 * 向标准输出写入数据
	 * @param data 要写入的文本（可包含 ANSI 转义序列）
	 */
	write(data: string): void {
		process.stdout.write(data);
	}

	/** 获取终端列数；无法获取时回退到 80（传统终端默认宽度） */
	get columns(): number {
		// 魔法数字 80：非 tty 场景下 columns 为 undefined 时的兜底默认值
		return process.stdout.columns || 80;
	}

	/** 获取终端行数；无法获取时回退到 24（传统终端默认高度） */
	get rows(): number {
		// 魔法数字 24：非 tty 场景下 rows 为 undefined 时的兜底默认值
		return process.stdout.rows || 24;
	}
}
