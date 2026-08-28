/**
 * @file footer.ts —— 交互模式 TUI 底栏组件
 *
 * @description
 * 渲染终端底部两到三行状态信息：
 * 第一行是工作目录（home 缩写为 ~，可附 git 分支与会话名）；
 * 第二行左侧汇总会话累计的 token 用量、费用与上下文占用率，
 * 右侧对齐显示当前模型名（及思考级别）；扩展状态额外占第三行。
 *
 * 主要功能点：
 * - 用量统计遍历会话「全部」条目（含压缩前的历史），不因上下文压缩而丢失总额；
 * - 上下文占用率优先取最近一次 LLM 响应的实测值，压缩刚发生、数值未知时显示 "?"；
 * - 宽度自适应：统计行过宽先截断自身，右侧模型名与统计行之间至少保留 2 个空格；
 * - 着色时对各段分别包 dim，避免内部彩色段的 reset 转义码抹掉外层 dim。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：Component 接口与按可视宽度截断/测量的工具；
 * - `../../../core/agent-session.ts`：会话状态与用量数据来源；
 * - `../../../core/footer-data-provider.ts`：git 分支、可用 provider 数、扩展状态等外部数据；
 * - `../theme/theme.ts`：主题配色。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * 净化文本以便在单行状态栏中显示。
 * 去除换行符、制表符、回车符等控制字符，防止扩展状态把底栏撑成多行。
 */
function sanitizeStatusText(text: string): string {
	// 先把换行/制表/回车替换为空格，再把连续空格折叠成一个，保证结果仍是单行
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * 将 token 数量格式化为底栏用的紧凑显示形式（如 4.5k、1.2M）。
 * 分档取舍精度：数值越大保留的有效位越少，以节省横向宽度。
 */
export function formatTokens(count: number): string {
	// <1000 直接显示原值，避免出现 "0.0k" 这类噪音
	if (count < 1000) return count.toString();
	// 1k~10k 档保留一位小数；10k~1M 档只取整，进一步节省宽度
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * 将工作目录格式化为底栏显示形式：若 cwd 位于 home 目录内，则把 home 前缀缩写为 `~`。
 * 通过 `relative` 的结果判断包含关系（以 `..` 开头或为绝对路径即在 home 之外）；
 * 恰好等于 home 时只显示 `~`，home 缺失或不在其内时原样返回 cwd。
 */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/**
 * 底栏组件：显示当前工作目录、token 用量统计与上下文占用情况。
 * token/上下文统计从 session 中自行计算，git 分支与扩展状态则来自注入的 provider。
 */
export class FooterComponent implements Component {
	/** 是否启用自动压缩，决定上下文占用率后面是否附 "(auto)" 标记 */
	private autoCompactEnabled = true;
	/** 当前会话：用量、模型、上下文占用等数据来源 */
	private session: AgentSession;
	/** 只读底栏数据 provider：git 分支、可用 provider 数、扩展状态等外部信息 */
	private footerData: ReadonlyFooterDataProvider;

	/**
	 * @param session - 会话数据来源
	 * @param footerData - 外部底栏数据 provider
	 */
	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	/** 替换当前会话引用（切换会话或重置会话时调用）。 */
	setSession(session: AgentSession): void {
		this.session = session;
	}

	/** 更新自动压缩开关，仅影响占用率显示中的 "(auto)" 后缀。 */
	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * 空操作：git 分支的缓存现已由 provider 负责。
	 * 仅为兼容 interactive-mode 中既有的调用点而保留。
	 */
	invalidate(): void {
		// 空操作：git 分支的缓存与失效均由 provider 管理
	}

	/**
	 * 清理资源。
	 * git watcher 的清理现已由 provider 负责。
	 */
	dispose(): void {
		// git watcher 的清理由 provider 处理
	}

	/**
	 * 渲染底栏各行，由 TUI 每帧调用。
	 * @param width - 终端可用宽度，用于截断与右对齐模型名
	 * @returns 2~3 行字符串：工作目录行、统计+模型名行（如有扩展状态再加一行）
	 */
	render(width: number): string[] {
		const state = this.session.state;

		// 累计用量统计遍历会话「全部」条目（而不只是压缩后剩余的消息），压缩前的历史也不会丢
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of this.session.sessionManager.getEntries()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				// 缓存命中率取最近一条 assistant 消息：分母 = input + cacheRead + cacheWrite
				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// 从 session 计算上下文占用（内部已正确处理压缩场景）。
		// 压缩刚发生后、下一次 LLM 响应到来前 token 数未知，此时显示 "?"。
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// 把 home 目录前缀缩写为 ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// 有 git 分支信息时追加到目录后
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// 设置了会话名时继续追加
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// 组装统计行：各分段以空格拼接，非零才显示
		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		// Kimi Coding 虽然走 API-key 认证，但实际按订阅计费（显示 "(sub)" 而非金额）
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;
			statsParts.push(costStr);
		}

		// 按占用率给上下文百分比着色：>90% 红色、>70% 黄色，其余不着色
		let contextPercentStr: string;
		// 自动压缩开启时在占用率后附 "(auto)" 标记
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);
		if (areExperimentalFeaturesEnabled()) {
			statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
		}

		let statsLeft = statsParts.join(" ");

		// 右侧放模型名；模型支持推理时再附上思考级别
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// 统计行超出终端宽度时先截断自身
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// 计算可用于填充的空格（统计行与模型名之间至少保留 2 个空格）
		const minPadding = 2;

		// 模型支持推理时附加思考级别指示（off 也显式标注）
		let rightSideWithoutProvider = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSideWithoutProvider =
				thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// 有多个可用 provider 且宽度放得下时，在模型名前加 "(provider)" 前缀
		let rightSide = rightSideWithoutProvider;
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			rightSide = `(${state.model!.provider}) ${rightSideWithoutProvider}`;
			if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
				// 放不下则回退为不带 provider 的形式
				rightSide = rightSideWithoutProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// 两侧都放得下——用空格填充把模型名推到右边界对齐
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// 放不下时截断右侧
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// 连右侧的最小空间都没有，只显示统计行
				statsLine = statsLeft;
			}
		}

		// 分段分别套 dim：statsLeft 内部可能含有带颜色码的段落（上下文百分比），
		// 其结尾的 reset 转义码会清掉外层的 dim 包裹。因此对彩色段前、后的部分各自 dim。
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // 即 padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// 扩展状态单独占一行，按 key 字母序排列
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const sortedStatuses = Array.from(extensionStatuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			const statusLine = sortedStatuses.join(" ");
			// 超宽时按终端宽度截断并附 dim 省略号，与底栏其余部分风格一致
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
		}

		return lines;
	}
}
