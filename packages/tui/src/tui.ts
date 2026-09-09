/**
 * @file tui.ts —— TUI 框架核心运行时
 *
 * @description
 * 本文件实现了 pi monorepo 终端 UI 框架的核心运行时,包含三大部分:
 *
 * 1. `Component` / `ComponentRenderResult`:所有 UI 组件必须实现的渲染接口,
 *    组件以「按行输出的字符串数组」形式描述自身内容。
 * 2. `Container`:通用容器组件,负责组织和管理子组件树(增删、查询、逐个渲染),
 *    并将「请求重绘」事件向上冒泡到根 TUI 实例。
 * 3. `TUI`:根容器 + 智能差分渲染引擎。它接管真实终端(隐藏光标、监听按键与
 *    尺寸变化),并把组件树的整体渲染结果与上一帧做行级 diff,尽量只重绘发生
 *    变化的行,从而把终端输出量降到最低。
 *
 * 渲染流程概览:
 *   requestRender() → (nextTick 合并) → renderToScreen()
 *     ├─ collectRenderCommands():递归收集组件树的渲染结果
 *     ├─ renderInitial():首帧 / resize 后全量输出
 *     └─ renderLineBased():行级差分,定位首个变化行后做「手术式」局部更新
 *
 * 依赖关系:
 *   - ./terminal.js:`Terminal` 接口与 `ProcessTerminal` 默认实现(封装
 *     process.stdout/stdin 的原始读写、raw mode 切换)。
 *   - Node.js 内置 `process`:仅用于 `process.nextTick` 做渲染请求的合并调度。
 *
 * @see terminal.ts 终端抽象层的实现
 */

import process from "process";
import { ProcessTerminal, type Terminal } from "./terminal.js";

/**
 * 组件单次渲染的结果
 */
export interface ComponentRenderResult {
	/** 本次渲染产出的所有文本行(不含换行符,宽度已适配给定的 width) */
	lines: string[];
	/** 相比组件内部上一次渲染,内容是否发生变化(用于差分渲染的快速跳过) */
	changed: boolean;
}

/**
 * 组件接口 —— TUI 中所有可渲染元素的最小契约
 */
export interface Component {
	/** 组件唯一 ID,由 getNextComponentId() 全局分配,用于差分追踪 */
	readonly id: number;
	/**
	 * 渲染组件内容
	 * @param width 可用宽度(通常为终端列数),组件应自行做换行/截断适配
	 */
	render(width: number): ComponentRenderResult;
	/** 可选:接收原始按键数据(仅当组件获得焦点时才会被调用) */
	handleInput?(keyData: string): void;
}

// 全局组件 ID 计数器(单调递增,保证每个组件 ID 唯一)
let nextComponentId = 1;

/**
 * 获取下一个组件 ID(全局自增)
 * @returns 分配出的唯一组件 ID
 */
export function getNextComponentId(): number {
	return nextComponentId++;
}

/**
 * 组件的内边距(Padding)类型,四个方向均可选
 */
export interface Padding {
	/** 顶部内边距(行数) */
	top?: number;
	/** 底部内边距(行数) */
	bottom?: number;
	/** 左侧内边距(字符数) */
	left?: number;
	/** 右侧内边距(字符数) */
	right?: number;
}

/**
 * 容器组件 —— 管理一组子组件的父节点
 *
 * 容器本身不产生可视内容,它的 render() 只是把所有子组件的渲染行按顺序拼接;
 * 同时负责维护子组件对根 TUI 的引用(setTui),使任意层级的子组件都能触发
 * 全局重绘请求。
 */
export class Container implements Component {
	readonly id: number;
	/** 子组件列表(允许嵌套 Container) */
	public children: (Component | Container)[] = [];
	/** 所属的根 TUI 实例;未挂载到 TUI 时为 undefined */
	private tui?: TUI;
	/** 上一次 render() 时的子组件数量,用于检测子组件增删(尤其是 clear 操作) */
	private previousChildCount: number = 0;

	constructor() {
		this.id = getNextComponentId();
	}

	/**
	 * 设置/清除本容器(及所有嵌套子容器)所属的 TUI 引用
	 * @param tui 根 TUI 实例;从树中移除时传 undefined 以断开引用
	 */
	setTui(tui: TUI | undefined): void {
		this.tui = tui;
		// 递归传播给嵌套容器,保证整棵子树都指向同一个根 TUI
		for (const child of this.children) {
			if (child instanceof Container) {
				child.setTui(tui);
			}
		}
	}

	/**
	 * 追加一个子组件
	 * @param component 要添加的组件或容器
	 */
	addChild(component: Component | Container): void {
		this.children.push(component);
		// 若新增的是容器,需要把它及其子树挂到当前 TUI 上
		if (component instanceof Container) {
			component.setTui(this.tui);
		}
		this.tui?.requestRender();
	}

	/**
	 * 按引用移除一个子组件(找不到则静默忽略)
	 * @param component 要移除的组件或容器
	 */
	removeChild(component: Component | Container): void {
		const index = this.children.indexOf(component);
		if (index >= 0) {
			this.children.splice(index, 1);
			// 断开被移除容器与根 TUI 的关联,避免其后续再触发无效重绘
			if (component instanceof Container) {
				component.setTui(undefined);
			}
			this.tui?.requestRender();
		}
	}

	/**
	 * 按索引移除子组件(索引越界则静默忽略)
	 * @param index 子组件下标(从 0 开始)
	 */
	removeChildAt(index: number): void {
		if (index >= 0 && index < this.children.length) {
			const component = this.children[index];
			this.children.splice(index, 1);
			if (component instanceof Container) {
				component.setTui(undefined);
			}
			this.tui?.requestRender();
		}
	}

	/**
	 * 清空所有子组件
	 */
	clear(): void {
		// 先逐个断开嵌套容器与 TUI 的关联,再整体清空
		for (const child of this.children) {
			if (child instanceof Container) {
				child.setTui(undefined);
			}
		}
		this.children = [];
		this.tui?.requestRender();
	}

	/**
	 * 获取指定下标的子组件
	 * @param index 子组件下标
	 * @returns 子组件;越界时返回 undefined
	 */
	getChild(index: number): (Component | Container) | undefined {
		return this.children[index];
	}

	/**
	 * 获取子组件数量
	 */
	getChildCount(): number {
		return this.children.length;
	}

	/**
	 * 渲染容器:按顺序拼接所有子组件的渲染行
	 * @param width 可用宽度
	 * @returns 拼接后的行数组;任一子组件(或子组件数量)发生变化时 changed 为 true
	 */
	render(width: number): ComponentRenderResult {
		const lines: string[] = [];
		let changed = false;

		// 子组件数量发生变化意味着结构改变(对检测 clear 尤为重要),
		// 此时即使每个子组件内容未变,也必须视为「已变化」
		if (this.children.length !== this.previousChildCount) {
			changed = true;
			this.previousChildCount = this.children.length;
		}

		for (const child of this.children) {
			const result = child.render(width);
			lines.push(...result.lines);
			if (result.changed) {
				changed = true;
			}
		}

		return { lines, changed };
	}
}

/**
 * 渲染指令 —— 记录单个组件一次渲染的输出,用于差分比较与性能统计
 */
interface RenderCommand {
	/** 产生该输出的组件 ID */
	id: number;
	/** 组件渲染出的文本行 */
	lines: string[];
	/** 组件内容相比其上一次渲染是否变化 */
	changed: boolean;
}

/**
 * TUI —— 智能差分渲染的终端 UI 根容器。
 *
 * 继承 Container(自身即是组件树的根),额外负责:
 * - 终端生命周期管理(start/stop、光标显隐、按键与 resize 事件接入);
 * - 渲染调度(把同一 tick 内的多次重绘请求合并为一次);
 * - 行级差分渲染(首帧全量输出,之后只重写发生变化的行,降低闪烁与 IO 量);
 * - 焦点路由(把按键转发给获得焦点的组件)与全局按键拦截。
 */
export class TUI extends Container {
	/** 当前获得焦点的组件(按键只会转发给它);无焦点时为 null */
	private focusedComponent: Component | null = null;
	/** 是否有待处理的渲染请求(用于合并同一 tick 内的多次 requestRender) */
	private needsRender = false;
	/** 是否尚未进行过首帧渲染(首帧走全量输出路径) */
	private isFirstRender = true;
	/** TUI 是否已 start(未启动时 requestRender 直接忽略) */
	private isStarted = false;
	/**
	 * 全局按键拦截钩子:返回 false 表示事件已消费、不再转发给焦点组件;
	 * 返回 true 则继续走默认的焦点组件分发流程。
	 */
	public onGlobalKeyPress?: (data: string) => boolean;
	/** 底层终端抽象(默认为封装真实 stdout/stdin 的 ProcessTerminal) */
	private terminal: Terminal;
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used in renderToScreen method on lines 260 and 276
	private previousRenderCommands: RenderCommand[] = [];
	/** 上一次实际写到屏幕的行内容(行级差分的「旧帧」基准) */
	private previousLines: string[] = [];

	// ========== 性能统计 ==========
	private totalLinesRedrawn = 0;
	private renderCount = 0;
	/** 获取累计重绘的总行数 */
	public getLinesRedrawn(): number {
		return this.totalLinesRedrawn;
	}
	/** 获取平均每次渲染重绘的行数(无渲染记录时为 0) */
	public getAverageLinesRedrawn(): number {
		return this.renderCount > 0 ? this.totalLinesRedrawn / this.renderCount : 0;
	}

	/**
	 * @param terminal 可选的终端实现;不传则默认使用真实进程终端 ProcessTerminal
	 */
	constructor(terminal?: Terminal) {
		super();
		// 根容器把 TUI 指向自身,使后续 addChild 的组件都能冒泡重绘请求
		this.setTui(this);
		// 提前绑定事件处理器,保证作为回调传递时不丢失 this 指向
		this.handleResize = this.handleResize.bind(this);
		this.handleKeypress = this.handleKeypress.bind(this);

		// 使用调用方提供的终端,否则回退到默认的进程终端
		this.terminal = terminal || new ProcessTerminal();
	}

	/**
	 * 将焦点设置到某个组件(仅当该组件确实存在于当前组件树中才生效)
	 * @param component 要获得焦点的组件
	 */
	setFocus(component: Component): void {
		if (this.findComponent(component)) {
			this.focusedComponent = component;
		}
	}

	/**
	 * 检查组件是否存在于当前组件树中(含多层嵌套容器)
	 * @param component 目标组件
	 * @returns 是否找到
	 */
	private findComponent(component: Component): boolean {
		// 先查直接子级
		if (this.children.includes(component)) {
			return true;
		}

		// 再递归深入每个嵌套容器
		for (const child of this.children) {
			if (child instanceof Container) {
				if (this.findInContainer(child, component)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * 在指定容器内递归查找目标组件(深度优先)
	 * @param container 起始容器
	 * @param component 目标组件
	 * @returns 是否找到
	 */
	private findInContainer(container: Container, component: Component): boolean {
		const childCount = container.getChildCount();

		for (let i = 0; i < childCount; i++) {
			const child = container.getChild(i);
			if (child === component) {
				return true;
			}
			if (child instanceof Container) {
				if (this.findInContainer(child, component)) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * 请求重绘:同一轮事件循环内多次调用只会安排一次实际渲染
	 *
	 * Why 用 process.nextTick:组件状态常常在同一个 tick 内被连续修改多次,
	 * 立即渲染会重复绘制;推迟到 nextTick 并以 needsRender 去重,可把 N 次
	 * 请求合并为 1 次渲染。
	 */
	requestRender(): void {
		// TUI 未启动时没有可写的目标,直接忽略
		if (!this.isStarted) return;

		// 仅在尚无待处理渲染时才入队,避免重复调度
		if (!this.needsRender) {
			this.needsRender = true;
			process.nextTick(() => {
				if (this.needsRender) {
					this.renderToScreen();
					this.needsRender = false;
				}
			});
		}
	}

	/**
	 * 启动 TUI:隐藏光标、接管终端输入,并在已有组件时触发首帧渲染
	 */
	start(): void {
		this.isStarted = true;

		// 隐藏光标(ANSI 转义序列 DECSET 25),差分重绘时光标闪烁会干扰画面
		this.terminal.write("\x1b[?25l");

		// 启动终端并注册按键 / resize 处理器;
		// 捕获异常避免个别终端环境下 raw mode 不可用导致整个程序崩溃
		try {
			this.terminal.start(this.handleKeypress, this.handleResize);
		} catch (error) {
			console.error("Error starting terminal:", error);
		}

		// 已有组件时立即触发首次渲染
		if (this.children.length > 0) {
			this.requestRender();
		}
	}

	/**
	 * 停止 TUI:恢复光标显示并释放终端(raw mode 等)
	 */
	stop(): void {
		// 恢复光标显示(DECRST 25)
		this.terminal.write("\x1b[?25h");

		// 停止终端
		this.terminal.stop();

		this.isStarted = false;
	}

	/**
	 * 渲染到屏幕的核心入口
	 * @param resize 是否因终端尺寸变化触发;为 true 时清空旧帧缓存,
	 *               强制走「首帧」全量重绘路径
	 */
	private renderToScreen(resize = false): void {
		const termWidth = this.terminal.columns;
		const termHeight = this.terminal.rows;

		// resize 后行宽可能变化,旧的差分基准已失效,必须丢弃
		if (resize) {
			this.isFirstRender = true;
			this.previousRenderCommands = [];
			this.previousLines = [];
		}

		// ========== 收集渲染指令 ==========
		// 递归遍历组件树,得到每个顶层子组件的渲染结果
		const currentRenderCommands: RenderCommand[] = [];
		this.collectRenderCommands(this, termWidth, currentRenderCommands);

		// 首帧全量输出;后续帧走行级差分
		if (this.isFirstRender) {
			this.renderInitial(currentRenderCommands);
			this.isFirstRender = false;
		} else {
			this.renderLineBased(currentRenderCommands, termHeight);
		}

		// 保存本帧结果,作为下一帧差分的旧帧基准
		this.previousRenderCommands = currentRenderCommands;
		this.renderCount++;
	}

	/**
	 * 递归收集容器下所有(顶层)子组件的渲染指令
	 * @param container 待遍历的容器
	 * @param width 渲染可用宽度
	 * @param commands 输出参数:收集结果依次追加到此数组
	 */
	private collectRenderCommands(container: Container, width: number, commands: RenderCommand[]): void {
		const childCount = container.getChildCount();

		for (let i = 0; i < childCount; i++) {
			const child = container.getChild(i);
			if (!child) continue;

			const result = child.render(width);
			commands.push({
				id: child.id,
				lines: result.lines,
				changed: result.changed,
			});
		}
	}

	/**
	 * 首帧渲染:一次性输出所有行
	 * @param commands 本帧收集到的全部渲染指令
	 */
	private renderInitial(commands: RenderCommand[]): void {
		let output = "";
		const lines: string[] = [];

		// 先把所有组件的行按顺序拼接成一个完整帧
		for (const command of commands) {
			lines.push(...command.lines);
		}

		// 输出所有行(行间用 \r\n,保证在 raw mode 下也强制回到行首)
		for (let i = 0; i < lines.length; i++) {
			if (i > 0) output += "\r\n";
			output += lines[i];
		}

		// 末尾补一个换行,把光标定位到内容下方一行
		if (lines.length > 0) output += "\r\n";

		this.terminal.write(output);

		// 记录本帧内容,供后续差分比较与性能统计
		this.previousLines = lines;
		this.totalLinesRedrawn += lines.length;
	}

	/**
	 * 行级差分渲染:只重写发生变化的行(非首帧的常规路径)
	 *
	 * 算法分三步:
	 * 1. 与上一帧逐行比较,定位「首个变化行」firstChangedLine;
	 * 2. 若变化位于滚动缓冲区(光标移不回去的区域)→ 清屏全量重绘;
	 * 3. 否则用 ANSI 光标移动 + 行清除做局部「手术式」更新。
	 *
	 * @param currentCommands 本帧的渲染指令
	 * @param termHeight 终端总行数
	 */
	private renderLineBased(currentCommands: RenderCommand[], termHeight: number): void {
		// 视口高度 = 终端行数 - 1:预留一行给光标,避免内容贴到最底行
		const viewportHeight = termHeight - 1;

		// 拼接本帧完整行数组
		const newLines: string[] = [];
		for (const command of currentCommands) {
			newLines.push(...command.lines);
		}

		const totalNewLines = newLines.length;
		const totalOldLines = this.previousLines.length;

		// ========== 定位首个变化行 ==========
		// 在新旧帧的共同前缀范围内逐行比较,找到第一处差异
		let firstChangedLine = -1;
		const minLines = Math.min(totalOldLines, totalNewLines);

		for (let i = 0; i < minLines; i++) {
			if (this.previousLines[i] !== newLines[i]) {
				firstChangedLine = i;
				break;
			}
		}

		// 共同部分完全一致时,若总行数不同,则变化起点就是公共长度处
		if (firstChangedLine === -1 && totalOldLines !== totalNewLines) {
			firstChangedLine = minLines;
		}

		// 完全没有变化:仅更新基准,直接返回,不产生任何终端输出
		if (firstChangedLine === -1) {
			this.previousLines = newLines;
			return;
		}

		// ========== 计算视口边界 ==========
		// 旧帧中视口的起始行:超出视口高度的部分已被顶入滚动缓冲区
		const oldViewportStart = Math.max(0, totalOldLines - viewportHeight);
		// 光标当前位于最后一行内容的下一行(首帧渲染时末尾补过换行)
		const cursorPosition = totalOldLines;

		let output = "";
		let linesRedrawn = 0;

		if (firstChangedLine < oldViewportStart) {
			// ========== 情形 A:变化位于滚动缓冲区(光标无法上移到达) ==========
			// 只能清除滚动缓冲区和整个屏幕,再全量重绘
			output = "\x1b[3J\x1b[H"; // \x1b[3J 清滚动缓冲区,\x1b[H 光标归位到左上角

			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) output += "\r\n";
				output += newLines[i];
			}

			if (newLines.length > 0) output += "\r\n";
			linesRedrawn = newLines.length;
		} else {
			// ========== 情形 B:变化位于视口内,可通过移动光标精准到达 ==========
			// 计算变化行在视口中的相对位置
			const viewportChangePosition = firstChangedLine - oldViewportStart;

			// 把光标上移到变化行:从当前位置(末尾内容下一行)倒推出需要上移的行数
			const linesToMoveUp = cursorPosition - oldViewportStart - viewportChangePosition;
			if (linesToMoveUp > 0) {
				output += `\x1b[${linesToMoveUp}A`; // ANSI CUU:光标上移 N 行
			}

			// 接下来按「变化规模」二选一:结构大改 → 局部清屏重绘;
			// 小改 → 逐行手术式更新
			let currentLine = firstChangedLine;
			const currentViewportLine = viewportChangePosition;

			// 结构性变化的判定:总行数改变,或变化波及的行数超过阈值。
			// 阈值 10 为经验值(arbitrary threshold):超过它之后逐行更新的
			// 转义序列开销反而高于一次清屏重绘
			const hasSignificantChanges = totalNewLines !== totalOldLines || totalNewLines - firstChangedLine > 10;

			if (hasSignificantChanges) {
				// 从光标处清到屏幕末尾,然后重写所有剩余行
				output += "\r\x1b[0J"; // \r 回行首,\x1b[0J 清除从光标到屏幕末尾

				for (let i = firstChangedLine; i < newLines.length; i++) {
					if (i > firstChangedLine) output += "\r\n";
					output += newLines[i];
					linesRedrawn++;
				}

				if (newLines.length > firstChangedLine) output += "\r\n";
			} else {
				// 手术式逐行更新:只重写有差异的行,其余行保持原样
				for (let i = firstChangedLine; i < minLines; i++) {
					if (this.previousLines[i] !== newLines[i]) {
						// 需要时下移光标到该行(ANSI CUD)
						const moveLines = i - currentLine;
						if (moveLines > 0) {
							output += `\x1b[${moveLines}B`;
						}

						// 清除整行后重写:\r 回行首,\x1b[2K 清除整行
						output += "\r\x1b[2K" + newLines[i];
						currentLine = i;
						linesRedrawn++;
					}
				}

				// ========== 处理末尾的行数增减 ==========
				if (totalNewLines > totalOldLines) {
					// 新帧更长:移动到旧内容末尾,追加多出来的行
					const moveToEnd = totalOldLines - 1 - currentLine;
					if (moveToEnd > 0) {
						output += `\x1b[${moveToEnd}B`;
					}
					output += "\r\n";

					for (let i = totalOldLines; i < totalNewLines; i++) {
						if (i > totalOldLines) output += "\r\n";
						output += newLines[i];
						linesRedrawn++;
					}
					output += "\r\n";
				} else if (totalNewLines < totalOldLines) {
					// 新帧更短:移动到新内容末尾,清除其后的残留行
					// (moveToEnd 为负说明光标已在目标行下方,需上移)
					const moveToEnd = totalNewLines - 1 - currentLine;
					if (moveToEnd > 0) {
						output += `\x1b[${moveToEnd}B`;
					} else if (moveToEnd < 0) {
						output += `\x1b[${-moveToEnd}A`;
					}
					output += "\r\n\x1b[0J"; // 清除从光标到屏幕末尾的残留内容
				} else {
					// 行数相同:只需把光标定位回内容末尾,恢复标准位置
					const moveToEnd = totalNewLines - 1 - currentLine;
					if (moveToEnd > 0) {
						output += `\x1b[${moveToEnd}B`;
					} else if (moveToEnd < 0) {
						output += `\x1b[${-moveToEnd}A`;
					}
					output += "\r\n";
				}
			}
		}

		this.terminal.write(output);
		this.previousLines = newLines;
		this.totalLinesRedrawn += linesRedrawn;
	}

	/**
	 * 终端尺寸变化处理器:清屏并强制全量重绘
	 *
	 * Why 清屏:resize 后行宽改变,旧帧内容的折行情况已不可信,
	 * 必须丢弃差分基准重新全量输出。
	 */
	private handleResize(): void {
		// 清屏 + 光标归位 + 再次隐藏光标(resize 时部分终端会恢复光标)
		this.terminal.write("\x1b[2J\x1b[H\x1b[?25l");
		this.renderToScreen(true);
	}

	/**
	 * 按键事件处理器:先经过全局拦截钩子,再分发给焦点组件
	 * @param data 原始按键数据(未解析的转义序列字符串)
	 */
	private handleKeypress(data: string): void {
		// 全局钩子返回 false 表示事件已被消费,不再向焦点组件转发
		if (this.onGlobalKeyPress) {
			const shouldForward = this.onGlobalKeyPress(data);
			if (!shouldForward) {
				this.requestRender();
				return;
			}
		}

		// 转发给获得焦点且实现了 handleInput 的组件
		if (this.focusedComponent?.handleInput) {
			this.focusedComponent.handleInput(data);
			this.requestRender();
		}
	}
}
