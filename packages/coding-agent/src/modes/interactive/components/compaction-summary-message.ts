/**
 * @file compaction-summary-message.ts —— 上下文压缩摘要消息组件
 *
 * @description
 * 渲染一次上下文压缩（compaction）产生的摘要消息：默认折叠为单行
 * 「Compacted from N tokens」提示，展开后显示完整 Markdown 摘要。
 * 背景色与自定义消息一致，保持视觉统一。
 */
import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * 渲染压缩摘要消息的组件，支持折叠/展开两种状态。
 * 背景色与自定义消息相同，保持视觉一致性。
 * 展开状态由宿主通过 setExpanded 控制。
 */
export class CompactionSummaryMessageComponent extends Box {
	/** 当前是否展开完整摘要 */
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;

	constructor(message: CompactionSummaryMessage, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.updateDisplay();
	}

	/** 切换展开/折叠状态并刷新显示 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/** 继承自 Box：失效时连带重建内容（适配宽度变化等场景） */
	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/** 按当前展开状态重建内容：标签行 + 折叠提示或完整摘要 */
	private updateDisplay(): void {
		this.clear();

		// 压缩前的 token 数（本地化千分位格式）
		const tokenStr = this.message.tokensBefore.toLocaleString();
		// 加粗的 [compaction] 标签行
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			// 展开：完整 Markdown 摘要，头部标注压缩前 token 数
			const header = `**Compacted from ${tokenStr} tokens**\n\n`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// 折叠：单行提示，附带「按键展开」的键位说明
			this.addChild(
				new Text(
					theme.fg("customMessageText", `Compacted from ${tokenStr} tokens (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)"),
					0,
					0,
				),
			);
		}
	}
}
