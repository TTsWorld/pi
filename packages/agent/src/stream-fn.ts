/**
 * @file 默认 streamFn 的全局配置
 * @description 维护 Agent 与底层循环在调用方未显式传入 streamFn 时使用的兜底流式函数，
 *   通过 setDefaultStreamFn 注册、getDefaultStreamFn 读取。
 */

import type { StreamFn } from "./types.ts";

// 全局兜底的流式函数；尚未注册时为 undefined
let defaultStreamFn: StreamFn | undefined;

/**
 * 配置 Agent 与底层循环在调用方省略 streamFn 时使用的兜底实现。
 *
 * 提供默认模型运行时的宿主层 (harness) 可以在此安装其流式函数，
 * 而无需让 pi-agent-core 依赖任何 provider 目录或兼容层。
 */
export function setDefaultStreamFn(streamFn: StreamFn | undefined): void {
	defaultStreamFn = streamFn;
}

// 获取全局兜底的流式函数；尚未配置则抛错，提示调用方显式传入 streamFn 或先调用 setDefaultStreamFn()
export function getDefaultStreamFn(): StreamFn {
	if (!defaultStreamFn) {
		throw new Error("No default stream function configured. Pass streamFn explicitly or call setDefaultStreamFn().");
	}
	return defaultStreamFn;
}
