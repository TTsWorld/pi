/**
 * @file command-options.ts —— 实验性命令的公共选项定义与解析工具
 *
 * @description
 * 汇总 client/server/pi 三个子命令共用的选项与解析逻辑：鉴权令牌选项、
 * 传输地址选项（--listen/--connect）、旧版顶层 CLI 选项的透传解析，
 * 以及「暂不支持旧版选项」的错误提示生成。
 */
import { type Args, parseArgs } from "../args.ts";
import { type AuthInput, parseAuthInput } from "./auth.ts";
import { type CommandOption, type ParsedCommandInput, stringOption, valueOption } from "./command.ts";
import { parseTransportAddress, type TransportAddress } from "./transport-address.ts";

/** 鉴权令牌选项对：--auth-token 直接传值，--auth-token-file 从文件读取。 */
export const authTokenOption = stringOption("--auth-token");
export const authTokenFileOption = stringOption("--auth-token-file");

/** 构造 --listen/--connect 选项：取值经 parseTransportAddress 严格校验，失败转为选项级错误。 */
export function transportOption(name: "--listen" | "--connect"): CommandOption<TransportAddress> {
	return valueOption(name, (value) => {
		const result = parseTransportAddress(value, name);
		return result.address
			? { ok: true, value: result.address }
			: { ok: false, error: result.error ?? `Invalid ${name} address "${value}"` };
	});
}

/** 从命令输入中读取两个鉴权选项，交给 parseAuthInput 统一校验（互斥等规则在那边处理）。 */
export function parseAuth(input: ParsedCommandInput): { auth?: AuthInput; errors: string[] } {
	return parseAuthInput({
		authToken: input.value(authTokenOption),
		authTokenFile: input.value(authTokenFileOption),
	});
}

/**
 * 把命令行剩余参数按旧版顶层 CLI 规则解析为 Args。
 *
 * 这样实验性子命令可以原样复用已有的全部选项定义；
 * 诊断里的 error 项被提取为字符串错误列表。
 */
export function parseLegacyOptions(input: ParsedCommandInput): { options: Args; errors: string[] } {
	// remainingArgs 是未被子命令选项消费的位置参数与 flag，全部交给旧版解析器
	const options = parseArgs([...input.remainingArgs]);
	return {
		options,
		errors: options.diagnostics
			.filter((diagnostic) => diagnostic.type === "error")
			.map((diagnostic) => diagnostic.message),
	};
}

/** 生成「实验性命令暂不支持旧版 CLI 选项」的错误提示（存在剩余参数时）。 */
export function unsupportedLegacyOptions(command: string, input: ParsedCommandInput): string[] {
	// 只要有剩余参数就说明用户传了旧版选项，统一给一条提示而非逐个列错
	if (input.remainingArgs.length === 0) return [];
	return [`The experimental ${command} command does not support existing CLI options yet`];
}
