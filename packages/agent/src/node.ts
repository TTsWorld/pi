/**
 * @file Node 环境专用入口
 * @description 在通用入口的基础上，额外导出 Node.js 的执行环境实现 (NodeExecutionEnv)，
 *   供在 Node 宿主中初始化 AgentHarness（提供文件系统、Shell 等执行能力）时使用。
 */

// Node.js 的执行环境 (ExecutionEnv) 实现，基于 Node API 提供文件系统与 Shell 等能力
export { NodeExecutionEnv } from "./harness/env/nodejs.ts";
// 转售通用入口的全部导出，保证从本子入口也能拿到完整 API
export * from "./index.ts";
