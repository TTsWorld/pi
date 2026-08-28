/**
 * @file client.ts —— 实验性 `client` 子命令定义
 *
 * @description
 * `client` 启动纯客户端 REPL：本地不加载任何工具与权限配置，仅通过
 * --connect 指定的传输地址连接到一个已在运行的 pi 服务端，
 * 所有交互经 RPC 转发到远端执行。与旧版顶层 CLI 选项完全不兼容——
 * 出现任何剩余参数都会被拒绝。
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

/** `client` 命令的解析结果：可选鉴权信息与要连接的服务端地址。 */
export interface ClientCommand {
	readonly command: "client";
	readonly auth?: AuthInput;
	readonly connect?: TransportAddress;
}

/** 命令执行上下文：由宿主注入的 `client` 命令执行回调。 */
export interface ClientCommandContext {
	runClient(command: ClientCommand): void | Promise<void>;
}

/** --connect 选项：单个可选值，指定要连接的服务端传输地址。 */
const connectOption = transportOption("--connect");

/** `client` 子命令：选项定义 → build 阶段解析校验 → action 阶段分发执行。 */
export const clientCommand = new Command<ClientCommand, ClientCommandContext>("client")
	.option(connectOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		// 解析鉴权信息与 --connect 地址；剩余参数按旧版规则解析以复用错误提示
		const { auth, errors: authErrors } = parseAuth(input);
		const connect = input.value(connectOption);
		const { errors: optionErrors } = parseLegacyOptions(input);
		// client 模式不接受任何旧版 CLI 选项，存在剩余参数即追加一条不支持提示
		const errors = [...authErrors, ...optionErrors, ...unsupportedLegacyOptions("client", input)];
		// 出现任何解析错误都整体失败，由命令框架统一打印错误列表
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "client",
				// 条件展开：未提供的可选字段不出现在命令对象上，便于下游用 undefined 判断
				...(auth === undefined ? {} : { auth }),
				...(connect === undefined ? {} : { connect }),
			},
		};
	})
	// 执行阶段只做分发：把解析出的命令交给宿主上下文注入的 runClient 回调
	.action((command, context) => context.runClient(command));
