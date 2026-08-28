/**
 * @file skill-invocation-message.ts —— 技能调用消息组件
 *
 * @description
 * 渲染一次技能（skill）调用的消息块：默认折叠为单行「[skill] 名称」，
 * 展开后显示技能名标题与完整内容。背景色与自定义消息一致，保持视觉统一。
 * 展开状态由宿主通过 setExpanded 控制。
 */
import { Box, Markdown, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * 渲染技能调用消息的组件，支持折叠/展开两种状态。
 * 背景色与自定义消息相同，保持视觉一致性。
 * 只渲染技能块本身——用户消息由宿主单独渲染。
 */
export class SkillInvocationMessageComponent extends Box {
	/** 当前是否展开完整内容 */
	private expanded = false;
	/** 解析后的技能块（名称 + 内容） */
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.skillBlock = skillBlock;
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

	/** 按当前展开状态重建内容：完整内容或单行提示 */
	// 折叠/展开两种形态差异较大，切换时整体清空重建
	private updateDisplay(): void {
		this.clear();

		if (this.expanded) {
			// 展开：标签行 + 技能名标题 + 完整内容
			const label = theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m`);
			this.addChild(new Text(label, 0, 0));
			// 技能名作为加粗标题，后接技能正文
			const header = `**${this.skillBlock.name}**\n\n`;
			this.addChild(
				new Markdown(header + this.skillBlock.content, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			// 折叠：单行——[skill] 名称（附展开键位提示）
			const line =
				theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
				theme.fg("customMessageText", this.skillBlock.name) +
				theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.addChild(new Text(line, 0, 0));
		}
	}
}
