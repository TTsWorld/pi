/**
 * @file index.ts
 * @description pi-agent 包入口 —— 导出 Agent 核心、CLI、渲染器与工具等全部公共 API
 * @module pi-agent
 *
 * 主要功能：
 * - Agent 核心类与事件类型（Agent / AgentConfig / AgentEvent 等）
 * - CLI 参数解析工具（parseArgs / printHelp）与 CLI 主入口（main）
 * - 三种事件渲染器：ConsoleRenderer / JsonRenderer / TuiRenderer
 * - 会话持久化管理（SessionManager 及会话相关类型）
 */

// pi-agent 包的主要导出

/**
 * Agent 核心类型定义
 * - `AgentConfig`：Agent 配置项（API 地址、密钥、模型、系统提示词等）
 * - `AgentEvent`：Agent 运行过程中产生的各类事件（消息、工具调用等）
 * - `AgentEventReceiver`：事件接收器接口，渲染器通过它消费 Agent 事件
 */
export type { AgentConfig, AgentEvent, AgentEventReceiver } from "./agent.js";
/**
 * Agent 核心类 —— 驱动 LLM 对话循环：发送消息、执行工具调用并以事件流形式广播进度
 */
export { Agent } from "./agent.js";
/**
 * CLI 参数定义与解析结果类型
 * - `ArgDef`：单个参数定义（类型、别名、默认值、可选值等）
 * - `ArgDefs`：参数定义集合（参数名到 ArgDef 的映射）
 * - `ParsedArgs`：按 ArgDefs 解析后得到的参数值类型
 */
export type { ArgDef, ArgDefs, ParsedArgs } from "./args.js";
// CLI 工具函数
/**
 * CLI 参数解析与帮助信息
 * - `parseArgs`：根据 ArgDefs 解析命令行参数
 * - `printHelp`：打印 CLI 使用帮助
 */
export { parseArgs, printHelp } from "./args.js";
// CLI 主函数
/**
 * CLI 主入口函数 —— 组装 Agent、渲染器与 SessionManager，启动交互式编码代理
 */
export { main } from "./cli.js";
// 渲染器
/**
 * 控制台渲染器 —— 在终端中以动画（spinner）等形式渲染 Agent 事件
 */
export { ConsoleRenderer } from "./renderers/console-renderer.js";
/**
 * JSON 渲染器 —— 将每个 Agent 事件序列化为一行 JSON 输出，便于管道或程序化处理
 */
export { JsonRenderer } from "./renderers/json-renderer.js";
/**
 * TUI 渲染器 —— 基于 pi-tui 的全屏交互式终端界面，支持输入编辑与 Markdown 渲染
 */
export { TuiRenderer } from "./renderers/tui-renderer.js";
/**
 * 会话相关类型定义
 * - `SessionData`：会话完整数据
 * - `SessionEvent`：会话中记录的单个事件
 * - `SessionHeader`：会话头部元信息（id、时间戳、cwd 等）
 */
export type { SessionData, SessionEvent, SessionHeader } from "./session-manager.js";
/**
 * 会话管理器 —— 负责会话的持久化存储、列出与恢复
 */
export { SessionManager } from "./session-manager.js";
