/**
 * @file bash-execution.ts —— bash 命令执行组件（流式输出显示）
 *
 * @description
 * bash 模式下执行单条命令时使用的 TUI 组件：在上下边框之间显示命令头、
 * 流式追加的输出、运行中的加载动画，以及结束后的状态行（退出码、
 * 折叠隐藏的行数、上下文截断提示等）。输出先按 LLM 上下文上限截断
 * （与 bash 工具同一套限额），折叠态再只保留最后 N 行预览。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：容器、加载动画、文本等基础组件；
 * - `../../../core/tools/truncate.ts`：按行数/字节数的尾部截断（对齐 LLM 上下文限额）；
 * - `./visual-truncate.ts`：按渲染宽度做可视行截断（折叠态预览）；
 * - `./keybinding-hints.ts` / `../theme/theme.ts`：按键提示与主题配色。
 */

import { Container, Loader, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { truncateToVisualLines } from "./visual-truncate.ts";

// 折叠态下的预览行数上限（与工具执行组件的预览行为保持一致）
const PREVIEW_LINES = 20;

/**
 * bash 命令执行组件：命令运行期间流式显示输出，结束后展示状态摘要。
 * 由 tui-renderer 的 executeBashCommand 创建，通过 appendOutput / setComplete
 * 驱动界面更新；getOutput / getCommand 供构造会话消息使用。
 */
export class BashExecutionComponent extends Container {
	/** 要执行的命令原文（命令头与状态展示复用） */
	private command: string;
	/** 已积累的输出行（按逻辑行拆分，支持跨 chunk 的不完整行拼接） */
	private outputLines: string[] = [];
	/** 执行状态：running 进行中 / complete 正常结束 / cancelled 被取消 / error 非零退出码 */
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	/** 进程退出码；undefined 表示拿不到（如无法采集） */
	private exitCode: number | undefined = undefined;
	/** 运行中的加载动画（spinner） */
	private loader: Loader;
	/** LLM 上下文层面的截断结果（发生截断时提示完整输出的文件路径） */
	private truncationResult?: TruncationResult;
	/** 输出被截断时保存完整输出的文件路径 */
	private fullOutputPath?: string;
	/** 是否展开显示全部输出（折叠时只显示预览行） */
	private expanded = false;
	/** 两条边框之间的动态内容区 */
	private contentContainer: Container;

	/**
	 * @param command - 要执行的命令原文
	 * @param ui - 宿主 TUI 实例（驱动 Loader 动画）
	 * @param excludeFromContext - 是否排除出 LLM 上下文（!! 前缀命令），仅影响配色
	 */
	constructor(command: string, ui: TUI, excludeFromContext = false) {
		super();
		this.command = command;

		// 排除出上下文的命令（!! 前缀）用 dim 边框，普通命令用 bashMode 色
		const colorKey = excludeFromContext ? "dim" : "bashMode";
		const borderColor = (str: string) => theme.fg(colorKey, str);

		// 顶部留白
		this.addChild(new Spacer(1));

		// 顶部边框
		this.addChild(new DynamicBorder(borderColor));

		// 内容容器（承载两条边框之间的动态内容）
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// 命令头
		const header = new Text(theme.fg(colorKey, theme.bold(`$ ${command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// 加载动画
		this.loader = new Loader(
			ui,
			(spinner) => theme.fg(colorKey, spinner),
			(text) => theme.fg("muted", text),
			`Running... (${keyText("tui.select.cancel")} to cancel)`, // loader 不解析样式，传纯文本
		);
		this.contentContainer.addChild(this.loader);

		// 底部边框
		this.addChild(new DynamicBorder(borderColor));
	}

	/**
	 * 设置输出为展开（显示全部输出）还是折叠（仅显示预览行）。
	 */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/** 缓存失效时重建显示（在父类失效处理之后顺带刷新内容区）。 */
	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/**
	 * 追加一段流式输出：去除 ANSI 转义、统一换行符后并入已有行。
	 * 上一个 chunk 若以不完整行结尾，本次的首行会拼接到该行尾部。
	 */
	appendOutput(chunk: string): void {
		// 去除 ANSI 转义码并统一各平台换行符
		// NOTE: 二进制数据已在 tui-renderer.ts 的 executeBashCommand 中预先净化
		const clean = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

		// 并入已有输出行
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// 首行拼接到上一 chunk 的未完结行（处理跨 chunk 的不完整行）
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.updateDisplay();
	}

	/**
	 * 标记命令执行结束：记录退出码与截断信息，停掉加载动画并刷新显示。
	 * 被取消时一律算 cancelled；否则退出码非 0 视为 error，退出码为 0 或未知算 complete。
	 */
	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		// 停止加载动画
		this.loader.stop();

		this.updateDisplay();
	}

	/**
	 * 重建内容区：按「LLM 上下文截断 → 预览折叠 → 着色渲染」的顺序刷新；
	 * 折叠态下通过带宽度缓存的动态组件按渲染宽度做可视行截断。
	 */
	private updateDisplay(): void {
		// 先按 LLM 上下文上限截断（与 bash 工具的限额一致）
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		// 上下文截断后可用于显示的行
		const availableLines = contextTruncation.content ? contextTruncation.content.split("\n") : [];

		// 折叠态只保留最后 PREVIEW_LINES 行（输出尾部通常最有信息量）
		const previewLogicalLines = availableLines.slice(-PREVIEW_LINES);
		const hiddenLineCount = availableLines.length - previewLogicalLines.length;

		// 重建内容容器
		this.contentContainer.clear();

		// 命令头
		const header = new Text(theme.fg("bashMode", theme.bold(`$ ${this.command}`)), 1, 0);
		this.contentContainer.addChild(header);

		// 输出内容
		if (availableLines.length > 0) {
			if (this.expanded) {
				// 展开态显示全部剩余行
				const displayText = availableLines.map((line) => theme.fg("muted", line)).join("\n");
				this.contentContainer.addChild(new Text(`\n${displayText}`, 1, 0));
			} else {
				// 折叠态用共享的可视行截断工具，并按渲染宽度缓存结果
				const styledOutput = previewLogicalLines.map((line) => theme.fg("muted", line)).join("\n");
				const styledInput = `\n${styledOutput}`;
				let cachedWidth: number | undefined;
				let cachedLines: string[] | undefined;
				this.contentContainer.addChild({
					render: (width: number) => {
						// 宽度没变就复用上次截断结果，避免每帧重复计算
						if (cachedLines === undefined || cachedWidth !== width) {
							const result = truncateToVisualLines(styledInput, PREVIEW_LINES, width, 1);
							cachedLines = result.visualLines;
							cachedWidth = width;
						}
						return cachedLines ?? [];
					},
					invalidate: () => {
						cachedWidth = undefined;
						cachedLines = undefined;
					},
				});
			}
		}

		// 加载动画或结束状态
		if (this.status === "running") {
			this.contentContainer.addChild(this.loader);
		} else {
			const statusParts: string[] = [];

			// 显示被折叠隐藏的行数
			if (hiddenLineCount > 0) {
				if (this.expanded) {
					statusParts.push(
						`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to collapse")}${theme.fg("muted", ")")}`,
					);
				} else {
					statusParts.push(
						`${theme.fg("muted", `... ${hiddenLineCount} more lines (`)}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
					);
				}
			}

			// 取消用警告色、非零退出码用错误色标注
			if (this.status === "cancelled") {
				statusParts.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusParts.push(theme.fg("error", `(exit ${this.exitCode})`));
			}

			// 追加截断警告（指 LLM 上下文截断，而非折叠预览造成的隐藏）
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusParts.push(theme.fg("warning", `Output truncated. Full output: ${this.fullOutputPath}`));
			}

			if (statusParts.length > 0) {
				this.contentContainer.addChild(new Text(`\n${statusParts.join("\n")}`, 1, 0));
			}
		}
	}

	/**
	 * 获取原始输出（未经上下文截断），用于构造 BashExecutionMessage。
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * 获取实际执行的命令原文。
	 */
	getCommand(): string {
		return this.command;
	}
}
