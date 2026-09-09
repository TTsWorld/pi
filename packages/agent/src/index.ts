/**
 * @file pi-agent 包的主导出入口文件
 * @description 集中 re-export 包内各模块的公开 API，包括 Agent 核心、
 *              CLI 参数解析、CLI 主入口函数、渲染器（Console/Json/Tui）
 *              以及会话管理器，供外部使用者统一从这里导入。
 */

// 导出 Agent 核心类型：配置、事件、事件接收器
export type { AgentConfig, AgentEvent, AgentEventReceiver } from "./agent.js";
// 导出 Agent 核心类
export { Agent } from "./agent.js";
// 导出 CLI 参数定义相关类型：参数定义、参数定义集合、解析结果
export type { ArgDef, ArgDefs, ParsedArgs } from "./args.js";
// CLI 工具函数
// 导出 CLI 参数解析与帮助信息打印函数
export { parseArgs, printHelp } from "./args.js";
// CLI 主函数
// 导出 CLI 主入口函数
export { main } from "./main.js";
// 渲染器
// 导出控制台渲染器
export { ConsoleRenderer } from "./renderers/console-renderer.js";
// 导出 JSON 渲染器
export { JsonRenderer } from "./renderers/json-renderer.js";
// 导出 TUI 渲染器
export { TuiRenderer } from "./renderers/tui-renderer.js";
// 导出会话数据相关类型：会话数据、会话事件、会话头信息
export type { SessionData, SessionEvent, SessionHeader } from "./session-manager.js";
// 导出会话管理器
export { SessionManager } from "./session-manager.js";
