/**
 * @file visual-truncate.ts —— 按可视行截断文本的共享工具
 *
 * @description
 * 把文本按终端宽度换行后截取最后 N 个「可视行」（考虑自动折行，
 * 而非按换行符切分）。tool-execution.ts 与 bash-execution.ts
 * 共用它来保证截断行为一致。返回的行已按宽度折好，
 * 可直接作为已渲染的行使用。
 */

import { Text } from "@earendil-works/pi-tui";

/** 截断结果的返回结构 */
export interface VisualTruncateResult {
	/** 要显示的可视行 */
	visualLines: string[];
	/** 被跳过（隐藏）的可视行数 */
	skippedCount: number;
}

/**
 * 把文本截断到最多指定数量的可视行（从末尾截取，保留最后 N 行）。
 * 会根据终端宽度正确处理自动折行，而不是简单按换行符切分。
 *
 * 保留末尾是因为工具输出通常「越靠后越新」——尾部才是最新进展。
 *
 * @param text - 文本内容（可含换行符）
 * @param maxVisualLines - 最多显示的可视行数
 * @param width - 终端/渲染宽度
 * @param paddingX - Text 组件的水平留白（默认 0）。
 *                   结果要放进 Box 时用 0（Box 自带留白）；
 *                   放进普通 Container 时用 1。
 * @returns 截断后的可视行与被跳过的行数
 */
export function truncateToVisualLines(
	text: string,
	maxVisualLines: number,
	width: number,
	paddingX: number = 0,
): VisualTruncateResult {
	// 空文本直接返回，避免无谓渲染
	if (!text) {
		return { visualLines: [], skippedCount: 0 };
	}

	// 借助临时 Text 组件完成实际换行，拿到全部可视行。
	// 这样折行规则与真正渲染时完全一致。
	// 注意 paddingX 必须与最终渲染时的留白一致，否则折行宽度会算错。
	const tempText = new Text(text, paddingX, 0);
	const allVisualLines = tempText.render(width);

	// 未超限时原样返回
	if (allVisualLines.length <= maxVisualLines) {
		return { visualLines: allVisualLines, skippedCount: 0 };
	}

	// 取最后 N 个可视行，前面的计入跳过数
	// 跳过数供宿主显示「已省略 N 行」之类的提示
	const truncatedLines = allVisualLines.slice(-maxVisualLines);
	const skippedCount = allVisualLines.length - maxVisualLines;

	return { visualLines: truncatedLines, skippedCount };
}
