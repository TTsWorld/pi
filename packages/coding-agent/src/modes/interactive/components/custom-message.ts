/**
 * @file custom-message.ts —— 扩展自定义消息渲染组件
 *
 * @description
 * 渲染扩展通过 addMessage 注入的 CustomMessage 条目。
 * 优先使用扩展提供的自定义渲染器（完全接管样式），
 * 否则回退到默认样式：紫色背景 Box 内展示「[customType] 标签 + Markdown 正文」。
 * 支持外部控制展开状态（setExpanded）与左右留白（setOutputPad），
 * 任一变化都会触发内部重建。
 */
import type { TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * 渲染来自扩展的自定义消息条目的组件。
 * 使用与用户消息不同的独立样式以便区分。
 *
 * 渲染策略：若构造时传入了 customRenderer，则完全委托它生成组件
 * （自带样式）；渲染抛错或未提供时，回退到默认的紫色背景 Box 渲染。
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		// 顶部垫一行空白与上方内容隔开
		// 创建紫色背景的 Box（默认渲染时使用）
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		// 构造时先装配一次内容
		this.rebuild();
	}

	/** 切换展开/折叠状态，状态变化时重建内容 */
	setExpanded(expanded: boolean): void {
		// 仅在状态实际变化时重建，避免无谓刷新
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	/** 更新输出左右留白数，变化时重建内容 */
	setOutputPad(outputPad: number): void {
		// 仅在数值实际变化时重建，避免无谓刷新
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	/** 继承自 Container：失效时连带重建内部内容（适配宽度变化等场景） */
	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	/**
	 * 重建内部内容：先移除旧组件，再按「自定义渲染器 → 默认 Box」的顺序
	 * 重新装配。展开状态或留白变化后都会调用。
	 */
	private rebuild(): void {
		// 移除上一次的内容组件
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);
		// 默认 Box 也先移除，确定渲染路径后再决定是否加回

		// 优先尝试自定义渲染器——它自行处理样式
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// 自定义渲染器返回自带样式的组件
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// 渲染失败则回退到默认渲染
			}
		}

		// 默认渲染使用自带的 Box
		this.addChild(this.box);
		this.box.clear();

		// 默认渲染：标签 + 正文
		// 标签形如 [customType]，加粗显示
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// 提取文本内容
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			// 内容块数组：过滤出文本块后按行拼接
			// 非文本块（如图片）在默认渲染中会被忽略
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		// 正文以 Markdown 渲染，并按主题色着色
		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
