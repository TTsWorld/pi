/**
 * @file 空白占位组件
 * @description pi 终端 UI 框架的空白占位组件，用于渲染指定数量的空行以在布局中制造间距。
 */
import { type Component, type ComponentRenderResult, getNextComponentId } from "../tui.js";

/**
 * 一个简单的组件，渲染空行用于间距占位
 */
export class WhitespaceComponent implements Component {
	readonly id = getNextComponentId();
	/** 要渲染的空行列表 */
	private lines: string[] = [];
	/** 构造时指定的空行数量 */
	private lineCount: number;
	/** 是否为首次渲染（首次渲染需标记 changed 以触发绘制） */
	private firstRender: boolean = true;

	/**
	 * @param lineCount 需要的空行数量，默认为 1
	 */
	constructor(lineCount: number = 1) {
		this.lineCount = Math.max(0, lineCount); // 保证非负
		this.lines = new Array(this.lineCount).fill("");
	}

	/**
	 * 渲染组件：返回预先生成的空行；仅首次渲染时 changed 为 true
	 * @param _width 可用宽度（空行不依赖宽度，故不使用）
	 */
	render(_width: number): ComponentRenderResult {
		const result = {
			lines: this.lines,
			changed: this.firstRender,
		};
		this.firstRender = false;
		return result;
	}
}
