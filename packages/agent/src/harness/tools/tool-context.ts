/**
 * 内置执行工具（bash/read/write/edit）共享的执行上下文类型。
 * 目前仅是对 ExecutionEnv 的转发包装，供上层扩展工具时按需附加更多上下文。
 */

import type { ExecutionEnv } from "../types.ts";

/** 内置执行工具所需的文件系统与 shell 上下文。 */
export interface ExecutionToolContext {
	/** 底层执行环境：文件系统与 shell 能力的抽象。 */
	env: ExecutionEnv;
}
