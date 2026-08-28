/**
 * @file pi.ts —— 实验性 `pi` 子命令定义
 *
 * @description
 * `pi` 是实验性命令体系中的默认命令：进入本地交互式 Agent（与不带子命令
 * 直接运行 `pi` 等价），但额外允许通过 --listen 监听 RPC 地址、通过
 * --auth-token/--auth-token-file 提供鉴权，以兼容旧版顶层用法。
 * 未被识别的剩余参数仍按旧版 CLI 规则解析并透传。
 */
import type { Args } from "../../args.ts";
import type { AuthInput } from "../auth.ts";
import { Command } from "../command.ts";
import {
	authTokenFileOption,
	authTokenOption,
	parseAuth,
	parseLegacyOptions,
	transportOption,
} from "../command-options.ts";
import type { TransportAddress } from "../transport-address.ts";

/** `pi` 命令的解析结果：透传的旧版选项、可选鉴权信息与监听地址列表。 */
export interface PiCommand {
	readonly command: "pi";
	readonly auth?: AuthInput;
	readonly options: Args;
	readonly listen?: readonly TransportAddress[];
}

/** 命令执行上下文：由宿主注入的 `pi` 命令执行回调。 */
export interface PiCommandContext {
	runPi(command: PiCommand): void | Promise<void>;
}

/** --listen 选项：可重复出现，每个值都是一个 RPC 传输地址（目前仅 unix socket）。 */
const listenOption = transportOption("--listen");

/** `pi` 子命令：选项定义 → build 阶段解析校验 → action 阶段分发执行。 */
export const piCommand = new Command<PiCommand, PiCommandContext>("pi")
	.option(listenOption)
	.option(authTokenOption)
	.option(authTokenFileOption)
	.build((input) => {
		// 分别解析鉴权信息、--listen 地址列表与按旧版规则透传的选项，并汇总各自的错误
		const { auth, errors: authErrors } = parseAuth(input);
		const listen = input.values(listenOption);
		const { options, errors: optionErrors } = parseLegacyOptions(input);
		const errors = [...authErrors, ...optionErrors];
		// --connect 只在 client 子命令下有意义；这里显式报错，避免被静默当成未知 flag
		if (options.unknownFlags.has("connect")) errors.push("--connect is only valid for client mode");
		// 出现任何解析错误都整体失败，由命令框架统一打印错误列表
		if (errors.length > 0) return { ok: false, errors };
		return {
			ok: true,
			command: {
				command: "pi",
				options,
				// 条件展开：未提供的可选字段不出现在命令对象上，便于下游用 undefined 判断
				...(auth === undefined ? {} : { auth }),
				...(listen.length === 0 ? {} : { listen }),
			},
		};
	})
	// 执行阶段只做分发：把解析出的命令交给宿主上下文注入的 runPi 回调
	.action((command, context) => context.runPi(command));
