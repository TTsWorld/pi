#!/usr/bin/env node
/**
 * @file Bun 编译单文件二进制的 CLI 入口。
 *
 * @description
 * 在加载主 CLI 之前完成 Bun 运行时适配：设置进程标题、静默 emitWarning、
 * 注册 OAuth 流程并还原沙箱环境变量。import 顺序有意为之——这些副作用
 * 必须先于 ./register-bedrock.ts 与 ../cli.ts 的顶层初始化执行。
 */
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
// 静默 emitWarning：Bun 会把 warning 写到 stdout，破坏终端 UI 渲染
process.emitWarning = (() => {}) as typeof process.emitWarning;

// 注册 Bun 原生 OAuth 流程（必须先于依赖 OAuth 的模块加载）
registerBunOAuthFlows();

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

// 沙箱场景下从 /proc/self/environ 还原被 Bun 清空的 process.env
restoreSandboxEnv();

// 动态加载：确保上述副作用先于这两个模块的顶层初始化执行
await import("./register-bedrock.ts");
await import("../cli.ts");
