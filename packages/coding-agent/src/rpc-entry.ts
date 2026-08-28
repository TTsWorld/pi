#!/usr/bin/env node
/**
 * @file rpc-entry.ts —— RPC（headless）模式的独立入口
 *
 * @description
 * 与 cli.ts 共用同一套 main 启动流程与进程级初始化，但自动附加
 * `--mode rpc`，让 agent 以 JSON-RPC 服务方式运行（供 IDE 等外部
 * 程序驱动），而不是进入交互式 TUI。
 */
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

// 进程名带 -rpc 后缀以区分交互模式；其余初始化原因同 cli.ts
process.title = `${APP_NAME}-rpc`;
process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = (() => {}) as typeof process.emitWarning;

configureHttpDispatcher();

// 在用户参数之前注入 --mode rpc，其余参数原样透传给主流程
main(["--mode", "rpc", ...process.argv.slice(2)]);
