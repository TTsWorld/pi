#!/usr/bin/env node

/**
 * @file agent 包的 CLI 入口文件
 * @description 作为命令行程序的可执行入口：通过 shebang 声明由 Node.js 直接运行，
 *              剥离掉 node 与脚本路径参数后将剩余命令行参数传给 main()，
 *              并统一捕获未处理的异常（打印错误后以退出码 1 结束进程）。
 */

import { main } from "./main.js";

// 以 CLI 方式运行 —— 本文件只应被直接执行，而不应被其他模块 import
main(process.argv.slice(2)).catch((err) => {
	console.error(err);
	process.exit(1);
});
