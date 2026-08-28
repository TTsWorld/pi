/**
 * @file index.ts —— coding-agent 各运行模式的统一出口（barrel）
 *
 * @description
 * 汇总导出 coding-agent 的运行模式，供 CLI 入口按参数选择：
 * - interactive-mode：终端交互 TUI 模式；
 * - print-mode：单发模式（`-p` 文本输出 / `--mode json` 事件流）；
 * - rpc-client / rpc-mode / rpc-types：RPC 模式，
 *   供外部程序经 stdin/stdout 行协议驱动 agent。
 */

export { InteractiveMode, type InteractiveModeOptions } from "./interactive/interactive-mode.ts";
export type { JsonAgentSessionEvent } from "./json-event.ts";
export { type PrintModeOptions, runPrintMode } from "./print-mode.ts";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.ts";
export { runRpcMode } from "./rpc/rpc-mode.ts";
export type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "./rpc/rpc-types.ts";
