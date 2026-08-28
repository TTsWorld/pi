/**
 * @file tool-execution.ts —— 工具调用执行过程的 TUI 渲染组件
 *
 * @description
 * 交互模式下每次工具调用的可视化外壳：负责把「工具调用（renderCall）」与
 * 「工具结果（renderResult）」两个阶段渲染到终端，并按执行状态切换底色：
 * - 参数仍在流式接收 / 执行中（isPartial）→ toolPendingBg（待定底色）；
 * - 结果返回且 isError → toolErrorBg（错误底色）；
 * - 结果返回且成功 → toolSuccessBg（成功底色）。
 *
 * 渲染策略分三层：
 * 1. 工具自定义渲染器（ToolDefinition.renderCall / renderResult）——优先用宿主注册
 *    的 toolDefinition，其未提供时回退到内置工具定义（createAllToolDefinitions）；
 * 2. renderShell === "self" 时工具自己画完整边框，本组件只提供透明容器；
 * 3. 完全没有渲染定义时，退化为「工具名 + JSON 参数 + 文本输出」的通用展示。
 *
 * 其他职责：结果中图片块的渲染（含 kitty 协议下的 PNG 异步转换）、
 * 折叠 / 展开的预览行数控制、自定义渲染器抛异常时的兜底降级。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：Container / Box / Text / Image 等 TUI 基础组件；
 * - `../../../core/extensions/types.ts`：ToolDefinition / ToolRenderContext 类型；
 * - `../../../core/tools/index.ts`：内置工具定义表（渲染器回退来源）；
 * - `../../../core/tools/render-utils.ts`：兜底文本输出抽取；
 * - `../theme/theme.ts`：主题配色。
 */
import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

// 无自定义渲染器时的默认预览行数：折叠状态下结果文本只显示前 N 行
const FALLBACK_PREVIEW_LINES = 10;

/** ToolExecutionComponent 的可选配置。 */
export interface ToolExecutionOptions {
	/** 是否在结果中渲染图片块，默认 true。 */
	showImages?: boolean;
	/** 图片最大显示宽度（终端单元格数），默认 60。 */
	imageWidthCells?: number;
}

/**
 * 单次工具调用的终端渲染组件，覆盖「参数流式接收 → 执行 → 结果返回」整个生命周期。
 *
 * 状态由外部事件驱动：宿主收到参数增量 / 执行开始 / 结果等事件时调用
 * updateArgs、markExecutionStarted、setArgsComplete、updateResult 等方法，
 * 组件随即重建展示内容并请求 TUI 重绘。
 *
 * 使用场景：交互模式的会话视图为每次工具调用创建一个实例并加入消息流；
 * 展开 / 收起、图片开关等用户操作通过对应 setter 传入。
 */
export class ToolExecutionComponent extends Container {
	// ----- 三种渲染外壳变体：默认盒（带边框底色）、自渲染容器、纯文本回退 -----
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	// 最近一次 call / result 渲染器返回的组件，作为 lastComponent 传回渲染器供增量更新
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	// 供渲染器自由读写的状态对象，跨多次渲染保留（组件本身不解释其内容）
	private rendererState: any = {};
	// 结果图片对应的 Image 组件与其前置 Spacer，每次 updateDisplay 全量重建
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	// 工具参数（流式接收期间会被多次整体覆盖）
	private args: any;
	// 是否展开完整输出（折叠时预览 FALLBACK_PREVIEW_LINES 行）
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	// 是否尚未收到最终结果（参数接收中或执行中）
	private isPartial = true;
	// 宿主（扩展）注册的工具定义与同名内置定义，可只存在其一
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	// 执行阶段标志：参数已接收完 / 已真正开始执行，供渲染器区分展示
	private executionStarted = false;
	private argsComplete = false;
	// 工具结果；到达后仍可能以 isPartial 形式被持续更新
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	// kitty 协议下非 PNG → PNG 的转换缓存（按图片块下标索引），避免重复转换
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	// 渲染器未产出任何内容且没有图片时整体隐藏本组件（render 输出空行）
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		// 从内置工具表取同名定义；非内置工具得到 undefined（渲染器走回退链）
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		// 顶部留一个空行，与上一条消息隔开
		this.addChild(new Spacer(1));

		// 三种外壳变体总是全部创建：contentBox 用于默认渲染器组合（带边框与底色）；
		// selfRenderContainer 用于工具自带边框的自渲染模式；
		// contentText 保留给没有任何工具定义时的通用回退渲染。
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		// 按渲染外壳类型挂载对应外壳；无渲染定义则直接用纯文本
		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	/**
	 * 解析当前生效的「调用阶段」渲染器。
	 * 优先级：宿主 toolDefinition.renderCall → 内置定义 renderCall → undefined（走兜底）。
	 */
	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		// 无内置定义：只剩宿主定义一条路
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		// 无宿主定义：直接用内置定义
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		// 两者都有：宿主定义优先，其未提供该字段时回退内置
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	/**
	 * 解析当前生效的「结果阶段」渲染器。
	 * 优先级：宿主 toolDefinition.renderResult → 内置定义 renderResult → undefined（走兜底）。
	 */
	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		// 解析逻辑与 getCallRenderer 完全对称
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	/** 是否存在任何工具定义——决定走自定义渲染器路径还是通用文本路径。 */
	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	/**
	 * 解析渲染外壳类型："self" 表示工具自己绘制边框（由 selfRenderContainer 承载），
	 * "default" 表示用本组件提供的带底色 Box。优先级与渲染器解析一致。
	 */
	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	/**
	 * 组装传给渲染器的上下文（ToolRenderContext）。
	 * lastComponent 传入上一次渲染返回的组件，便于渲染器做增量更新；
	 * invalidate 回调供渲染器在异步数据就绪后主动触发重绘。
	 */
	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	/** 无 renderCall 时的兜底展示：仅显示加粗工具名。 */
	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	/**
	 * 无 renderResult 时的兜底展示：渲染工具的纯文本输出。
	 * 折叠状态下只显示前 FALLBACK_PREVIEW_LINES 行，并追加「还有 N 行」与展开按键提示。
	 */
	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		// 无文本输出则不渲染任何内容（返回 undefined 由调用方判断）
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		// 折叠时截取预览行数；expanded 时展示全部
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	/** 参数流式更新：用最新参数整体覆盖并重绘（参数接收阶段会被多次调用）。 */
	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	/** 标记工具已真正开始执行（区别于参数接收阶段）。 */
	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	/** 标记参数已接收完整（渲染器可据此停止「输入中」类展示）。 */
	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	/**
	 * 更新工具结果并重绘。
	 * @param result - 工具结果（content 块数组 + 是否出错，可带 details）
	 * @param isPartial - true 表示这是中间结果，后续还会继续更新
	 */
	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		// 结果里可能带非 PNG 图片，kitty 协议下需要提前转换
		this.maybeConvertImagesForKitty();
	}

	/**
	 * kitty 图形协议只接受 PNG：若结果含非 PNG 图片则异步转成 PNG。
	 * 转换完成后写入 convertedImages 缓存并触发重绘；转换失败则保持原样
	 * （该图片在 kitty 下会被跳过显示）。
	 */
	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		// 仅 kitty 协议需要转换；其他协议（如 sixel）可直接显示原始格式
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			// 缺数据或缺 mimeType 的块无法转换
			if (!img.data || !img.mimeType) continue;
			// 已是 PNG 无需转换；已转换过（或转换中重复触发）的下标直接跳过
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			// 闭包捕获下标，异步回调时写回对应的缓存槽位
			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	/** 设置是否展开完整输出（true 展示全部行，false 只展示预览行数）。 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/** 设置是否显示结果中的图片。 */
	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	/** 设置图片最大显示宽度（向下取整，最小 1 格，防止 0 / 负宽度）。 */
	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	/** 缓存失效时顺带重建展示内容（尺寸 / 主题等外部变化都可能影响渲染结果）。 */
	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/**
	 * 自渲染外壳（renderShell === "self"）需要手工拼接输出：
	 * 内容行之前留一个空行，图片各自带一个前置 Spacer 逐张排布。
	 * 其余外壳直接复用 Container 的默认渲染。
	 */
	override render(width: number): string[] {
		// 整体隐藏时输出空数组，不占用任何屏幕行
		if (this.hideComponent) {
			return [];
		}

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			// 自渲染内容为空且没有图片 → 同样整体不显示
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					lines.push(...spacer.render(width));
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					lines.push(...imageComponent.render(width));
				}
			}
			return lines;
		}

		return super.render(width);
	}

	/**
	 * 依据当前状态全量重建展示内容（每次状态变化都会调用）。
	 * 流程：按执行状态确定底色 → 重建 call 渲染 → 有结果时追加 result 渲染
	 * → 重建图片组件 → 内容与图片均无则整体隐藏。
	 */
	private updateDisplay(): void {
		// ===== 按执行状态确定底色：待定（未完成）/ 错误 / 成功 =====
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			// 按外壳类型取目标容器；仅 Box 外壳支持设置底色函数
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			// 清空旧内容后从头填充（全量重建，不做增量 diff）
			renderContainer.clear();

			// ===== 渲染工具调用（call）部分 =====
			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				// 渲染器缺失：退化为仅显示工具名
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					// 渲染器抛异常时降级为兜底展示，避免拖垮整个 TUI
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			// ===== 已有结果时追加渲染结果（result）部分 =====
			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			// 无任何工具定义：走纯文本外壳，直接填入通用格式化内容
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		// ===== 重建结果图片组件：先卸载旧的 Image / Spacer，再根据最新结果重新挂载 =====
		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				// 终端支持图片协议、用户开启图片显示、且数据完整时才渲染该图片块
				if (caps.images && this.showImages && img.data && img.mimeType) {
					// 优先取 kitty 转换缓存中的 PNG，没有则退回原始数据
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					// kitty 协议只认 PNG：转换未完成或失败的非 PNG 图片直接跳过
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		// 自定义渲染路径下内容与图片全空 → 整体隐藏（通用文本路径恒有内容，不会进这里）
		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	/** 抽取工具结果中的纯文本输出（委托 render-utils；showImages 控制图片块的处理方式）。 */
	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	/**
	 * 纯文本回退路径的完整展示内容：加粗工具名 + JSON 参数 + 文本输出三段拼接。
	 * 仅在没有任何工具定义（contentText 外壳）时使用。
	 */
	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
