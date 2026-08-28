#!/usr/bin/env node
/**
 * @file cli.ts —— 终端 coding agent 的 CLI 入口（默认交互 TUI 模式）
 *
 * @description
 * 重构版 coding agent 的入口：完成进程级初始化后，把命令行参数交给
 * main.ts（基于 AgentSession 与各 mode 模块）启动主流程。
 *
 * 测试：npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

// 设置进程名便于 ps/top 识别；两个环境变量标记让子进程与各 SDK
// 能感知自己运行在 pi coding agent 之内
process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
// 屏蔽 Node 的进程告警（如 ExperimentalWarning）：这些输出会污染全屏 TUI 渲染
process.emitWarning = (() => {}) as typeof process.emitWarning;

// 必须在任何 provider SDK 发起请求之前配置 undici 的全局 dispatcher；
// 运行时设置（代理等）会在 SettingsManager 加载全局/项目设置后再次应用。
configureHttpDispatcher();

// 去掉 node 与脚本路径，仅把用户参数传给主流程
main(process.argv.slice(2));
