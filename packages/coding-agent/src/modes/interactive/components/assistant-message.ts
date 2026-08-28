/**
 * @file assistant-message.ts —— 助手消息渲染组件（markdown / 思考块 / 流式）
 *
 * @description
 * 本文件实现 `AssistantMessageComponent`：把一条完整的助手消息渲染为终端 UI。
 * 主要功能：
 * - 按 content 顺序渲染文本块（Markdown 组件）与思考块（可折叠为静态标签），
 *   连续多个思考块会合并为一段统一渲染；
 * - 支持流式更新（updateContent 增量重入）与流式专属的 markdown transform；
 * - 依据 stopReason 在消息尾部附加错误/中断/截断提示（工具调用的错误由
 *   单独的工具执行组件展示，此处只处理无工具调用的情形）；
 * - 通过 OSC 133 提示序列标记「提示词结束 / 输出开始 / 输出结束」区域边界，
 *   供 shell 集成（如重新执行、块导航）识别。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：AssistantMessage 消息类型；
 * - `@earendil-works/pi-tui`：Container / Markdown / Text / Spacer 基础组件；
 * - `../../../core/extensions/types.ts`：MarkdownTransformer 扩展点类型；
 * - `../theme/theme.ts` 与 `./markdown-transform.ts`：主题与 markdown 变换。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

// OSC 133 shell 集成序列：A = 提示输入结束（输出开始），B = 命令输出开始，C = 输出结束。
// 此处用于把整条助手消息标记为一个可被终端识别的输出区域。
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * 渲染一条完整助手消息的 TUI 组件。
 *
 * 构造时可传入初始消息，也可在流式过程中反复调用 `updateContent` 刷新；
 * 隐藏思考块、标签文案、缩进与 markdown 变换器均可在运行期更新并触发重渲染。
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	/** 是否隐藏思考块（隐藏时仅显示一条静态标签） */
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	/** 隐藏思考块时展示的替代文案 */
	private hiddenThinkingLabel: string;
	/** 内容块的左右缩进列数 */
	private outputPad: number;
	/** 注册的 markdown 变换器（扩展点），渲染时传入 createMarkdownTransform */
	private markdownTransformers: readonly MarkdownTransformer[];
	/** 最近一次渲染的消息；各项 setter 依赖它做全量重渲染 */
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;

	/**
	 * @param message - 可选的初始消息，传入则立即渲染
	 * @param hideThinkingBlock - 是否隐藏思考块（默认 false）
	 * @param markdownTheme - markdown 渲染主题（默认取全局主题）
	 * @param hiddenThinkingLabel - 隐藏思考块时显示的标签文案（默认 "Thinking..."）
	 * @param outputPad - 内容缩进列数（默认 1）
	 * @param markdownTransformers - markdown 变换器扩展列表（默认为空）
	 */
	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// 文本/思考内容的容器（尾部错误提示也放在这里）
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	/**
	 * 失效回调：终端尺寸等变化触发重渲染时，基于最近一条消息整体重建内容。
	 */
	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** 运行期切换是否隐藏思考块，并立即重渲染最近一条消息。 */
	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** 更新隐藏思考块时的标签文案，并立即重渲染。 */
	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** 更新内容缩进列数，并立即重渲染。 */
	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/**
	 * 渲染输出：在纯文本消息的首/末行包上 OSC 133 区域标记。
	 *
	 * 含工具调用的消息不加标记——工具调用块由独立的工具执行组件渲染，
	 * 区域边界应由那边负责，避免嵌套标记干扰终端解析。
	 */
	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	/**
	 * 用新消息内容整体重建组件（流式期间会被高频调用）。
	 *
	 * @param message - 最新的助手消息
	 * @param isStreaming - 是否处于流式输出中（影响 markdown transform 的选择）；
	 *   缺省沿用组件当前状态
	 */
	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// 清空内容容器，整体重建
		this.contentContainer.clear();

		// 是否存在可见内容（非空文本或思考块）——决定顶部是否补一个空行
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// ===== 按原始顺序渲染各内容块 =====
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// 助手文本消息无背景色——先 trim 掉首尾空白
				// paddingY=0：避免工具执行块之前出现多余空行
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				// 贪心收集从当前位置起的一段连续 thinking 块，稍后合并渲染
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				// 整段思考块都为空白（如流式刚开始）则跳过，不渲染任何占位
				if (thinkingBlocks.length === 0) {
					continue;
				}

				// 仅当后面还有可见的助手内容块时才补空行。
				// 避免在单独渲染的工具执行块之前多出一个空行。
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// 隐藏模式：每段连续思考块只显示一条静态标签
					this.contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0),
					);
				} else {
					// 展示模式：每段连续思考块合并为一个 Markdown 区块渲染（斜体 + 专用配色）
					this.contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// ===== 尾部状态提示：未完成/失败时展示在部分内容之后 =====
		// 中止/出错若发生在工具调用上，错误由工具执行组件展示；
		// 但 length 截断可能发生在工具调用尚未完成之前，所以也在此提示。
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				// 优先展示具体错误信息；缺省或通用中止文案时退回 "Operation aborted"
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				// 无具体错误信息时兜底显示 "Unknown error"
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
