/**
 * @file server.ts —— 实验性 `server` 子命令定义
 *
 * @description
 * `server` 启动一个无本地界面的 RPC 服务端：按 --listen 指定的一个或
 * 多个传输地址监听，等待 client 连接并把 agent 能力经 RPC 暴露出去。
 * 与旧版顶层 CLI 选项完全不兼容——出现任何剩余参数都会被拒绝。
 */
import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
	unsupportedLegacyOptions,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

/** `server` 命令的解析结果：可选鉴权信息与监听地址列表。 */
export interface ServerCommand {
	readonly command: "server";
	readonly auth?: AuthInput;
	readonly listen?: readonly TransportAddress[];
}

/** 命令执行上下文：由宿主注入的 `server` 命令执行回调。 */
export interface ServerCommandContext {
	runServer(command: ServerCommand): void | Promise<void>;
}

/** --listen 选项：可重复出现，每个值都是一个 RPC 传输地址（目前仅 unix socket）。 */
const listenOption = transportOption("--listen");

/** `server` 子命令：选项定义 → build 阶段解析校验 → action 阶段分发执行。 */
export const serverCommand = new Command<ServerCommand, ServerCommandContext>("server")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		// 解析鉴权信息与 --listen 地址列表；剩余参数按旧版规则解析以复用错误提示
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		// server 模式不接受任何旧版 CLI 选项，存在剩余参数即追加一条不支持提示
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("server", input)];
		// 出现任何解析错误都整体失败，由命令框架统一打印错误列表
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "server",
				// 条件展开：未提供的可选字段不出现在命令对象上，便于下游用 undefined 判断
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	// 执行阶段只做分发：把解析出的命令交给宿主上下文注入的 runServer 回调
	.action((command, context) => context.runServer(command));
