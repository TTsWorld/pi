/**
 * @file deprecation.ts —— 弃用警告（每条消息只提醒一次）
 *
 * @description
 * 以黄色 chalk 输出 Deprecation warning，并用 Set 去重，
 * 同一条警告在整个进程生命周期内只打印一次。
 */

import chalk from "chalk";

/** 已输出过的警告消息集合，用于去重。 */
const emittedDeprecationWarnings = new Set<string>();

/** 输出一条弃用警告；同一消息重复调用时只在首次打印。 */
export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/** 清空弃用警告的去重状态。导出仅供测试使用。 */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
