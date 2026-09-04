/**
 * @file tui.ts
 * @description TUI 核心运行时 —— 终端组件容器、渲染循环与输入事件分发
 * @module pi-tui
 *
 * 主要功能：
 * - 定义组件契约：Component 接口（render 渲染 + 可选 handleInput 接收按键）及 Padding、渲染结果等类型
 * - Container 容器类：管理子组件树（增删、清理哨兵、递归渲染），并通过 keepLines 机制支持增量渲染
 * - SentinelComponent 哨兵组件：标记被移除的组件，触发级联重渲染而不破坏数组结构
 * - TUI 根容器类：接管终端（隐藏光标、raw 模式）、批处理渲染循环、尺寸变化处理与按键事件分发（全局钩子 + 焦点组件）
 * - 增量渲染优化：仅重绘发生变化的行（基于 keepLines 与光标上移 ANSI 转义序列），避免整屏闪烁
 *
 * 依赖关系：
 * - node:fs 的 writeSync：同步写入 stdout，防止异步写导致的渲染竞态
 * - node:process：stdin/stdout 流操作（raw 模式、事件监听、终端尺寸）
 * - ./logger.js：结构化调试日志（渲染周期、按键输入、组件生命周期）
 */

import { writeSync } from "fs";
import process from "process";
import { logger } from "./logger.js";

/**
 * 内边距配置（单位：字符行/列）。
 * 各方向均为可选，缺省视为 0。
 */
export interface Padding {
	/** 顶部内边距（行数） */
	top?: number;
	/** 底部内边距（行数） */
	bottom?: number;
	/** 左侧内边距（列数） */
	left?: number;
	/** 右侧内边距（列数） */
	right?: number;
}

/**
 * 单个组件的渲染结果。
 */
export interface ComponentRenderResult {
	/** 本次渲染产生的所有文本行（每行代表终端上的一行） */
	lines: string[];
	/** 内容是否发生了变化；为 false 时渲染循环可跳过重绘以节省开销 */
	changed: boolean;
}

/**
 * 容器组件的渲染结果。
 * 在普通组件结果的基础上增加 keepLines，用于增量渲染。
 */
export interface ContainerRenderResult extends ComponentRenderResult {
	/**
	 * 自顶部的无需重绘的行数（这些行与上次渲染完全一致）。
	 * 渲染循环只会重绘 keepLines 之后的所有行。
	 */
	keepLines: number;
}

/**
 * TUI 组件契约。
 * 所有可渲染单元（文本框、输入框、容器等）均需实现本接口。
 */
export interface Component {
	/**
	 * 渲染组件为若干文本行。
	 * @param width 可用宽度（终端列数），组件应据此自行换行
	 * @returns 渲染出的文本行及是否发生变化
	 */
	render(width: number): ComponentRenderResult;
	/**
	 * 可选：接收原始按键输入（终端 raw 模式下的转义序列或 UTF-8 字符）。
	 * 只有获得焦点的组件才会收到按键。
	 * @param keyData 原始按键数据
	 */
	handleInput?(keyData: string): void;
}

/**
 * 哨兵组件 —— 用于标记已被移除的组件，触发级联重渲染。
 * 以"占位替换"代替"数组剔除"，保持 children 数组结构稳定，
 * 避免渲染过程中因索引变动引发错位。
 */
class SentinelComponent implements Component {
	/**
	 * 始终渲染为空且报告"已变化"，
	 * 从而强制后续渲染把被删组件占用的行清空并触发级联更新。
	 */
	render(): ComponentRenderResult {
		return {
			lines: [],
			changed: true, // 始终触发级联渲染
		};
	}
}

/**
 * 容器基类 —— 管理子组件的树形结构并负责递归渲染。
 * 组件树节点可能是普通组件（Component）也可能是嵌套容器（Container），
 * 见 {@link Element} 类型定义。
 */
export class Container {
	/** 子组件列表；被移除的子项会被哨兵组件占位，直到下次渲染后清理 */
	protected children: Element[] = [];
	/** 最近一次渲染输出的行缓存 */
	protected lines: string[] = [];
	/** 指向根 TUI 的引用，用于子树变更时触发重渲染 */
	protected parentTui: TUI | undefined;

	/**
	 * @param parentTui 可选的根 TUI 引用；设置后子树变更会自动请求重渲染
	 */
	constructor(parentTui?: TUI | undefined) {
		this.parentTui = parentTui;
	}

	/**
	 * 设置/更新所属的根 TUI 引用。
	 * @param tui 根 TUI；传 undefined 表示脱离 TUI（如组件被移除时）
	 */
	setParentTui(tui: TUI | undefined): void {
		this.parentTui = tui;
	}

	/**
	 * 追加一个子组件到容器末尾。
	 * 若子组件本身是容器，会把 parentTui 引用向下传播，
	 * 保证嵌套容器中的变更也能通知到根 TUI。
	 * @param component 待添加的组件或容器
	 */
	addChild(component: Element): void {
		this.children.push(component);

		// 为嵌套容器传播 parent TUI 引用
		if (component instanceof Container && this.parentTui) {
			component.setParentTui(this.parentTui);
		}

		// 结构变化，请求重渲染
		if (this.parentTui) {
			this.parentTui.requestRender();
		}
	}

	/**
	 * 移除指定的子组件。
	 * 先在本容器中查找；找不到则递归在嵌套容器中查找并移除。
	 * 移除采用"哨兵占位"而非直接 splice，以维持数组结构稳定。
	 * @param component 待移除的组件
	 */
	removeChild(component: Element): void {
		const index = this.children.indexOf(component);
		if (index >= 0) {
			// 用哨兵替换而非 splice，保持数组结构不变（避免渲染期间索引错位）
			this.children[index] = new SentinelComponent();
			// 保留原位置占位 —— 哨兵渲染为 0 行，后续行自然上移补位

			// 解除嵌套容器的 parent TUI 引用
			if (component instanceof Container) {
				component.setParentTui(undefined);
			}

			// 走正常渲染流程 —— 哨兵自身会自然触发级联更新
			if (this.parentTui) {
				this.parentTui.requestRender();
			}
		} else {
			// 本层未命中，递归在嵌套容器中查找
			for (const child of this.children) {
				if (child instanceof Container) {
					child.removeChild(component);
				}
			}
		}
	}

	/**
	 * 按索引移除子组件。
	 * 与 {@link removeChild} 一样采用哨兵占位策略。
	 * @param index 子组件索引；越界时静默忽略
	 */
	removeChildAt(index: number): void {
		if (index >= 0 && index < this.children.length) {
			const component = this.children[index];

			// 用哨兵替换而非 splice，保持数组结构不变
			this.children[index] = new SentinelComponent();

			// 解除嵌套容器的 parent TUI 引用
			if (component instanceof Container) {
				component.setParentTui(undefined);
			}

			// 走正常渲染流程 —— 哨兵自身会自然触发级联更新
			if (this.parentTui) {
				this.parentTui.requestRender();
			}
		}
	}

	/**
	 * 递归渲染所有子组件，并把结果合并为连续的行集合。
	 *
	 * 增量渲染核心：从顶部开始累计未变化的行数（keepLines）。
	 * 一旦遇到第一个发生变化的子组件，其后的所有行都视为"需要重绘"，
	 * 不再累计 keepLines —— 因为即使后面的子组件自身未变，
	 * 其行位置也可能因前面的增删而整体偏移。
	 *
	 * @param width 可用宽度（终端列数）
	 * @returns 合并后的行、是否发生变化、以及可保留的行数 keepLines
	 */
	render(width: number): ContainerRenderResult {
		let keepLines = 0;
		let changed = false;
		const newLines: string[] = [];

		for (let i = 0; i < this.children.length; i++) {
			const child = this.children[i];
			if (!child) continue;

			if (child instanceof Container) {
				// 子容器：递归渲染并摊平其行
				const result = child.render(width);
				newLines.push(...result.lines);
				if (!changed && !result.changed) {
					// 尚未遇到变化 —— 整个子容器都未变，全部计入 keepLines
					keepLines += result.lines.length;
				} else {
					if (!changed) {
						// 首个变化点 —— 采用该子容器自报的 keepLines
						// （子容器内部顶部的未变行仍可保留）
						changed = true;
						keepLines += result.keepLines;
					}
					// 首个变化点之后，不再累计任何 keepLines
				}
			} else {
				// 普通组件：直接渲染
				const result = child.render(width);
				newLines.push(...result.lines);
				if (!changed && !result.changed) {
					// 尚未遇到变化 —— 未变行全部计入 keepLines
					keepLines += result.lines.length;
				} else {
					if (!changed) {
						// 非容器组件的首个变化点（普通组件无内部 keepLines 可用）
						changed = true;
					}
					// 首个变化点之后，不再累计任何 keepLines
				}
			}
		}

		this.lines = newLines;
		return {
			lines: this.lines,
			changed,
			keepLines,
		};
	}

	/**
	 * 按索引获取子组件，供外部操作。
	 * 注意：若子组件已被移除但尚未清理，可能返回哨兵组件。
	 * @param index 子组件索引
	 * @returns 子组件；索引越界时返回 undefined
	 */
	getChild(index: number): Element | undefined {
		return this.children[index];
	}

	/**
	 * 获取子组件数量。
	 * 注意：在下一次渲染清理之前，哨兵组件也会被计入。
	 * @returns 当前 children 数组长度
	 */
	getChildCount(): number {
		return this.children.length;
	}

	/**
	 * 清空所有子组件。
	 * 会先解除嵌套容器的 parentTui 引用，再请求重渲染。
	 */
	clear(): void {
		// 解除嵌套容器的 parent TUI 引用
		for (const child of this.children) {
			if (child instanceof Container) {
				child.setParentTui(undefined);
			}
		}

		// 清空子组件数组
		this.children = [];

		// 若挂载在 TUI 上则请求重渲染
		if (this.parentTui) {
			this.parentTui.requestRender();
		}
	}

	/**
	 * 清理哨兵组件 —— 从 children 中剔除所有 SentinelComponent，
	 * 并递归清理嵌套容器。在每轮渲染完成后由 TUI 调用。
	 */
	cleanupSentinels(): void {
		const originalCount = this.children.length;
		const validChildren: Element[] = [];
		let sentinelCount = 0;

		for (const child of this.children) {
			if (child && !(child instanceof SentinelComponent)) {
				validChildren.push(child);

				// 递归清理嵌套容器
				if (child instanceof Container) {
					child.cleanupSentinels();
				}
			} else if (child instanceof SentinelComponent) {
				sentinelCount++;
			}
		}

		this.children = validChildren;

		// 仅在实际移除了哨兵时输出调试日志，避免噪音
		if (sentinelCount > 0) {
			logger.debug("Container", "Cleaned up sentinels", {
				originalCount,
				newCount: this.children.length,
				sentinelsRemoved: sentinelCount,
			});
		}
	}
}

/**
 * 组件树节点类型 —— 要么是普通组件，要么是嵌套容器。
 */
type Element = Component | Container;

/**
 * TUI 根容器 —— 整个终端 UI 的运行时入口。
 *
 * 职责：
 * - 终端接管：隐藏光标、开启 stdin raw 模式以捕获按键
 * - 渲染循环：requestRender 把多次重绘请求合并到下一个事件循环 tick 批量执行
 * - 增量绘制：基于 keepLines 用 ANSI 光标移动序列只重绘发生变化的行
 * - 事件分发：终端 resize 事件与键盘输入（全局钩子优先，再转发给焦点组件）
 */
export class TUI extends Container {
	/** 当前持有键盘焦点的组件；键盘输入只会转发给它 */
	private focusedComponent: Component | null = null;
	/** 脏标记 —— 为 true 表示有待处理的重渲染 */
	private needsRender: boolean = false;
	/** 记录进入 TUI 前 stdin 是否已处于 raw 模式，stop() 时据此还原 */
	private wasRaw: boolean = false;
	/** 上一轮渲染写到终端的总行数，用于计算光标需要上移的距离 */
	private totalLines: number = 0;
	/** 是否尚未进行过首次渲染；首次渲染直接追加输出而非覆盖旧内容 */
	private isFirstRender: boolean = true;
	/** TUI 是否已 start()；未启动时不响应渲染请求 */
	private isStarted: boolean = false;
	/**
	 * 全局按键钩子 —— 在所有组件之前拦截原始输入。
	 * 返回 false 表示该键已被消费，不再转发给焦点组件。
	 */
	public onGlobalKeyPress?: (data: string) => boolean;

	constructor() {
		super(); // 根容器没有上级 TUI
		// 提前绑定事件处理器，保证 add/remove 时引用一致
		this.handleResize = this.handleResize.bind(this);
		this.handleKeypress = this.handleKeypress.bind(this);
		logger.componentLifecycle("TUI", "created");
	}

	/**
	 * 配置内部日志器。
	 * @param config 日志配置（级别、输出目标等），与 logger.configure 的参数一致
	 */
	configureLogging(config: Parameters<typeof logger.configure>[0]): void {
		logger.configure(config);
		logger.info("TUI", "Logging configured", config);
	}

	/**
	 * 追加顶层子组件（重写版）。
	 * 与普通 Container 不同：根容器会把自身设为子容器的 parentTui，
	 * 并且只在 TUI 已启动后才自动触发渲染。
	 * @param component 待添加的组件或容器
	 */
	override addChild(component: Element): void {
		// 为容器类型的子组件设置 parent TUI 引用
		if (component instanceof Container) {
			component.setParentTui(this);
		}
		super.addChild(component);

		// 仅在 TUI 已启动后才自动渲染
		if (this.isStarted) {
			this.requestRender();
		}
	}

	/**
	 * 移除顶层子组件（重写版）。
	 * @param component 待移除的组件
	 */
	override removeChild(component: Element): void {
		super.removeChild(component);
		this.requestRender();
	}

	/**
	 * 把键盘焦点设置到指定组件。
	 * 仅当该组件确实存在于组件树中时才生效。
	 * @param component 要获得焦点的组件
	 */
	setFocus(component: Component): void {
		// 先确认组件存在于层级中的任意位置
		if (this.findComponent(component)) {
			this.focusedComponent = component;
		}
	}

	/**
	 * 在整棵组件树中查找指定组件是否存在。
	 * @param component 目标组件
	 * @returns 存在返回 true
	 */
	private findComponent(component: Component): boolean {
		// 先检查直接子组件
		if (this.children.includes(component)) {
			return true;
		}

		// 再递归搜索嵌套容器
		for (const comp of this.children) {
			if (comp instanceof Container) {
				if (this.findInContainer(comp, component)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * 在指定容器内递归查找目标组件（供 {@link findComponent} 使用）。
	 * @param container 起始容器
	 * @param component 目标组件
	 * @returns 找到返回 true
	 */
	private findInContainer(container: Container, component: Component): boolean {
		const childCount = container.getChildCount();

		// 先检查该容器的直接子组件
		for (let i = 0; i < childCount; i++) {
			const child = container.getChild(i);
			if (child === component) {
				return true;
			}
		}

		// 再递归搜索嵌套容器
		for (let i = 0; i < childCount; i++) {
			const child = container.getChild(i);
			if (child instanceof Container) {
				if (this.findInContainer(child, component)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * 请求重渲染（脏标记模式）。
	 * 同一 tick 内的多次请求会被合并为一次实际渲染，
	 * 避免高频变更（如连续按键、批量更新）导致的重复绘制。
	 */
	requestRender(): void {
		// TUI 未启动时忽略渲染请求
		if (!this.isStarted) return;
		this.needsRender = true;
		// 延迟到下一个 tick 批量渲染
		process.nextTick(() => {
			if (this.needsRender) {
				this.renderToScreen();
				this.needsRender = false;
			}
		});
	}

	/**
	 * 启动 TUI：接管终端并执行首次渲染。
	 * 包括隐藏光标、开启 stdin raw 模式、注册 resize/keypress 事件监听。
	 */
	start(): void {
		// 标记已启动，允许渲染请求
		this.isStarted = true;

		// 隐藏终端光标（ANSI: DECTCEM Set - 光标不可见）
		process.stdout.write("\x1b[?25l");

		// 设置 raw 模式以捕获按键
		try {
			// 记录原始 raw 状态以便 stop() 时还原
			this.wasRaw = process.stdin.isRaw || false;
			if (process.stdin.setRawMode) {
				process.stdin.setRawMode(true);
			}
			process.stdin.setEncoding("utf8");
			process.stdin.resume();

			// 注册终端事件监听
			process.stdout.on("resize", this.handleResize);
			process.stdin.on("data", this.handleKeypress);
		} catch (error) {
			console.error("Error setting up raw mode:", error);
		}

		// 首次渲染
		this.renderToScreen();
	}

	/**
	 * 停止 TUI：恢复终端到接管前的状态。
	 * 重新显示光标、移除事件监听、还原 stdin raw 模式。
	 */
	stop(): void {
		// 重新显示终端光标（ANSI: DECTCEM Set - 光标可见）
		process.stdout.write("\x1b[?25h");

		process.stdin.removeListener("data", this.handleKeypress);
		process.stdout.removeListener("resize", this.handleResize);
		// 还原到 start() 之前 stdin 的 raw 状态
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	/**
	 * 执行一轮渲染：渲染整棵组件树并把结果写到终端。
	 *
	 * 增量绘制策略：
	 * - 首次渲染：直接把所有行追加输出到当前光标位置
	 * - 后续渲染：光标上移 (totalLines - keepLines) 行，清除下方内容，
	 *   再只写入 keepLines 之后的变化行
	 *
	 * @param resize 是否由终端 resize 触发；为 true 时放弃增量、全量重绘
	 */
	private renderToScreen(resize: boolean = false): void {
		// 终端宽度；非 TTY 环境下 columns 可能为 undefined，回退到 80 列
		const termWidth = process.stdout.columns || 80;

		logger.debug("TUI", "Starting render cycle", {
			termWidth,
			componentCount: this.children.length,
			isFirstRender: this.isFirstRender,
		});

		const result = this.render(termWidth);

		if (resize) {
			// resize 场景：旧内容已被清屏作废，所有行都需重绘
			this.totalLines = result.lines.length;
			result.keepLines = 0;
			this.isFirstRender = true;
		}

		logger.debug("TUI", "Render result", {
			totalLines: result.lines.length,
			keepLines: result.keepLines,
			changed: result.changed,
			previousTotalLines: this.totalLines,
		});

		if (!result.changed) {
			// 没有任何变化 —— 跳过渲染
			return;
		}

		// ========== 光标定位与输出 ==========
		if (this.isFirstRender) {
			// 首次渲染：直接在当前光标位置追加输出
			this.isFirstRender = false;
			// 首次渲染按普通方式逐行输出全部内容
			for (const line of result.lines) {
				console.log(line);
			}
		} else {
			// 后续渲染：光标上移到变化区域的起始行，并清除该行及以下所有内容
			// 需上移的行数 = 上次总行数 - 顶部可保留的行数
			const linesToMoveUp = this.totalLines - result.keepLines;
			let output = "";

			logger.debug("TUI", "Cursor movement", {
				linesToMoveUp,
				totalLines: this.totalLines,
				keepLines: result.keepLines,
				changingLineCount: result.lines.length - result.keepLines,
			});

			if (linesToMoveUp > 0) {
				// \x1b[NA: 光标上移 N 行；\x1b[0J: 从光标处清除到屏幕末尾
				output += `\x1b[${linesToMoveUp}A\x1b[0J`;
			}

			// 拼接所有变化行的输出字符串（跳过顶部 keepLines 行未变内容）
			const changingLines = result.lines.slice(result.keepLines);

			logger.debug("TUI", "Output details", {
				linesToMoveUp,
				changingLinesCount: changingLines.length,
				keepLines: result.keepLines,
				totalLines: result.lines.length,
				previousTotalLines: this.totalLines,
			});
			for (const line of changingLines) {
				output += `${line}\n`;
			}

			// 一次性写出全部内容 —— 用同步写避免异步写带来的竞态（半帧渲染）
			writeSync(process.stdout.fd, output);
		}

		// 记录本轮总行数，供下轮计算光标上移距离
		this.totalLines = result.lines.length;

		// 渲染完成后清理哨兵组件
		this.cleanupSentinels();
	}

	/**
	 * 终端尺寸变化处理器。
	 * 清空屏幕（含滚动回滚缓冲区）后强制全量重绘 —— 宽度变化会使既有换行全部失效。
	 */
	private handleResize(): void {
		// 清屏并重置终端：ESC c 为全屏重置（RIS）、隐藏光标、ESC[3J 清除滚动回滚缓冲区
		process.stdout.write("\u001Bc\x1b[?25l\u001B[3J");

		// 终端尺寸已变化 —— 强制全量重渲染
		this.renderToScreen(true);
	}

	/**
	 * 键盘输入处理器：按"全局钩子 → 焦点组件"的顺序分发按键。
	 * @param data raw 模式下读到的原始输入（可能是 ANSI 转义序列或 UTF-8 字符）
	 */
	private handleKeypress(data: string): void {
		logger.keyInput("TUI", data);

		// 此处不处理 Ctrl+C —— 交给全局按键钩子处理
		// if (data.charCodeAt(0) === 3) {
		// 	logger.info("TUI", "Ctrl+C received");
		// 	return; // 不再继续处理该键
		// }

		// 先调用全局按键钩子（若已设置）
		if (this.onGlobalKeyPress) {
			const shouldForward = this.onGlobalKeyPress(data);
			if (!shouldForward) {
				// 全局钩子已消费该键 —— 不再转发给焦点组件
				this.requestRender();
				return;
			}
		}

		// 把输入转发给焦点组件
		if (this.focusedComponent?.handleInput) {
			logger.debug("TUI", "Forwarding input to focused component", {
				componentType: this.focusedComponent.constructor.name,
			});
			this.focusedComponent.handleInput(data);
			// 输入处理后触发重渲染
			this.requestRender();
		} else {
			// 无焦点组件，或焦点组件未实现 handleInput
			logger.warn("TUI", "No focused component to handle input", {
				focusedComponent: this.focusedComponent?.constructor.name || "none",
				hasHandleInput: this.focusedComponent?.handleInput ? "yes" : "no",
			});
		}
	}
}
