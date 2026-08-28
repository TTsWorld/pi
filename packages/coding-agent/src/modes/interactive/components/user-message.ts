/**
 * @file user-message.ts —— 用户消息渲染组件
 *
 * @description
 * 把用户输入渲染成带背景色的 Markdown 气泡（Box + Markdown），
 * 支持扩展注入的 Markdown 转换器，并在首尾行注入 OSC 133 标记，
 * 供终端识别用户输入区的起止（shell integration 协议）。
 */
import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

// OSC 133 标记序列（终端 shell integration 协议）：
// A = 用户输入区起始，B = 输入区结束，C = 后续输出起始
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * 渲染用户消息的组件：带背景色的 Markdown 内容框。
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	/** 更新输出左右留白数并重建内容 */
	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	/**
	 * 重建内容：清空后重新装配一个带背景色的 Box，
	 * 内部用 Markdown 渲染用户文本（含扩展注入的转换器）。
	 */
	private rebuild(): void {
		this.clear();
		// 用户消息背景色 Box，左右留 outputPad、上下留 1
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		contentBox.addChild(
			new Markdown(
				this.text,
				0,
				0,
				this.markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{
					// 保留原始有序列表编号与反斜杠转义，忠实呈现用户输入
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					// 组合扩展注册的 Markdown 转换器（非流式）
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
		this.addChild(contentBox);
	}

	/**
	 * 渲染并注入 OSC 133 标记：
	 * 首行加输入区起始标记（A），末行加输入区结束与输出起始标记（B + C），
	 * 让支持该协议的终端能识别/跳转用户输入区。
	 */
	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		// 标记序列插在行首，不影响可见内容
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
