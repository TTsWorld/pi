/**
 * @file auth-command.ts —— `pi auth` 子命令的参数解析与校验
 *
 * @description
 * 实现 CLI 层的认证子命令族：
 * - `auth check`：检查指定供应商/模型的认证是否就绪；
 * - `auth print-api-key`：打印已配置的 API key；
 * - `auth print-bearer-token`：打印 OAuth bearer token（可要求最小剩余有效期）。
 * 本文件只负责「识别子命令 + 解析 flag + 校验参数 + 输出帮助」这一层；
 * 凭据的实际解析与打印在 credential-print.ts，认证状态检查在 auth-check.ts。
 */

import type { AuthResult } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import type { Args } from "./args.ts";

/** 认证子命令种类：check（检查认证状态）、api_key（打印 API key）、bearer_token（打印 OAuth token） */
export type AuthCommandKind = "check" | "api_key" | "bearer_token";

/** 从原始 CLI 参数解析出的认证子命令描述 */
export interface AuthCommand {
	kind: AuthCommandKind;
	/** 子命令名与已识别 flag 之外的其余位置参数 */
	args: string[];
	/** 是否以 JSON 输出结果（仅 check 支持） */
	json: boolean;
	/** 是否在输出中携带凭据本身（仅 check 支持） */
	credentials: boolean;
	/** 是否禁止自动刷新过期的 OAuth 凭据（仅 check 支持） */
	noRefresh: boolean;
	/** bearer token 要求的最小剩余有效期（毫秒），仅 print-bearer-token 支持 */
	minExpiryMs?: number;
}

/** 认证子命令解析/校验失败时抛出的错误，消息中自带用法提示 */
export class AuthCommandError extends Error {}

/** 各子命令的用法示例字符串，供帮助输出与错误提示复用 */
const AUTH_COMMAND_USAGE: Record<AuthCommandKind, string> = {
	check: `${APP_NAME} auth check --provider <provider> [--json] [--credentials] [--no-refresh]`,
	api_key: `${APP_NAME} auth print-api-key --provider <provider> [--model <model>]`,
	bearer_token: `${APP_NAME} auth print-bearer-token --provider <provider> [--model <model>] [--min-expiry <duration>]`,
};

/** 返回子命令的完整命令名（如 "auth check"），用于拼装错误消息 */
export function getAuthCommandName(kind: AuthCommandKind): string {
	return kind === "check" ? "auth check" : kind === "api_key" ? "auth print-api-key" : "auth print-bearer-token";
}

/** 返回子命令的用法示例字符串 */
export function getAuthCommandUsage(kind: AuthCommandKind): string {
	return AUTH_COMMAND_USAGE[kind];
}

/** 判断参数是否为 `pi auth help` / `pi auth --help` / `pi auth -h` 等帮助请求 */
export function isAuthCommandHelp(args: string[]): boolean {
	return (
		args[0] === "auth" &&
		(args[1] === undefined || args[1] === "help" || args.includes("--help") || args.includes("-h"))
	);
}

/** 打印 `pi auth` 命令族的用法帮助到标准输出 */
export function printAuthCommandHelp(): void {
	console.log(`Usage:
  pi auth print-api-key [--provider <provider>] [--model <model>]
  pi auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  pi auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

Auth commands require at least one of --provider or --model. Checks refresh expired OAuth credentials by default; --no-refresh prevents this. --credentials emits the credential, or includes it in JSON output.`);
}

/**
 * 解析 `pi auth ...` 参数为 AuthCommand。
 *
 * @param args 完整 CLI 参数数组（args[0] 必须为 "auth"）
 * @returns 非 auth 命令返回 undefined；子命令或 flag 不合法时抛 AuthCommandError
 */
export function parseAuthCommand(args: string[]): AuthCommand | undefined {
	if (args[0] !== "auth") return undefined;

	// 从 args[1] 识别子命令种类；不认识则报错并给出正确用法
	const kind =
		args[1] === "check"
			? "check"
			: args[1] === "print-api-key"
				? "api_key"
				: args[1] === "print-bearer-token"
					? "bearer_token"
					: undefined;
	if (!kind) {
		throw new AuthCommandError(
			`Unknown auth command "${args[1] ?? ""}". Use "${APP_NAME} auth print-api-key", "${APP_NAME} auth print-bearer-token", or "${APP_NAME} auth check".`,
		);
	}

	const commandArgs: string[] = [];
	let json = false;
	let credentials = false;
	let noRefresh = false;
	let minExpiryMs: number | undefined;
	// 从第 3 个参数起逐个扫描：识别到的 flag 就地消费，其余原样透传到 commandArgs
	for (let index = 2; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--min-expiry") {
			// 仅 print-bearer-token 支持：把 "30m"/"1h" 这类时长换算成毫秒
			if (kind !== "bearer_token")
				throw new AuthCommandError("--min-expiry is only supported by print-bearer-token");
			const value = args[++index];
			const match = value ? /^(\d+)(ms|s|m|h)$/iu.exec(value) : undefined;
			if (!match) throw new AuthCommandError("--min-expiry must use a duration such as 30m or 1h");
			const amount = Number(match[1]);
			const unit = match[2];
			minExpiryMs = amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
			continue;
		}
		if (arg === "--json" || arg === "--credentials" || arg === "--no-refresh") {
			// 这三个 flag 只对 auth check 有意义，其他子命令使用时直接报错
			if (kind !== "check") throw new AuthCommandError(`${arg} is only supported by auth check`);
			if (arg === "--json") json = true;
			else if (arg === "--credentials") credentials = true;
			else noRefresh = true;
			continue;
		}
		commandArgs.push(arg);
	}

	return minExpiryMs === undefined
		? { kind, args: commandArgs, json, credentials, noRefresh }
		: { kind, args: commandArgs, json, credentials, noRefresh, minExpiryMs };
}

/**
 * 校验 auth 子命令的通用参数并归一化 provider / model。
 *
 * 统一规则：只接受 --provider / --model，出现其他任何输入即报错；
 * provider 与 model 至少提供其一。空字符串视为未提供。
 */
export function validateAuthCommandArgs(args: Args, kind: AuthCommandKind): { provider?: string; model?: string } {
	// 空白字符串归一化为 undefined，避免下游把 "" 当成有效值
	const provider = args.provider?.trim() || undefined;
	const model = args.model?.trim() || undefined;
	// 未知 flag 直接报错，避免静默忽略用户的拼写错误
	if (args.unknownFlags.size > 0) {
		const option = args.unknownFlags.keys().next().value;
		throw new AuthCommandError(`Unknown option --${option} for "${getAuthCommandName(kind)}".`);
	}
	// auth 子命令不接受 --api-key、prompt、@file 等任何其他输入
	if (args.apiKey !== undefined || args.messages.length > 0 || args.fileArgs.length > 0) {
		throw new AuthCommandError("Auth commands only accept --provider and --model");
	}
	if (kind === "check") {
		if (!provider && !model) {
			throw new AuthCommandError("Auth checks require --provider <provider> or --model <model>");
		}
		return { provider, model };
	}
	if (!provider && !model) {
		throw new AuthCommandError("Credential printing requires --provider <provider> or --model <model>");
	}
	return { provider, model };
}

/**
 * 从认证结果中提取可直接使用的凭据字符串。
 *
 * 优先返回 API key；否则在 headers 里查找 Authorization 头（头名大小写不敏感）
 * 并取出 Bearer 后面的 token；两者皆无则返回 undefined。
 */
export function getAuthCredential(auth: AuthResult | undefined): string | undefined {
	if (auth?.auth.apiKey) return auth.auth.apiKey;
	const authorization = Object.entries(auth?.auth.headers ?? {}).find(
		([name]) => name.toLowerCase() === "authorization",
	)?.[1];
	return typeof authorization === "string" ? /^Bearer\s+(.+)$/iu.exec(authorization)?.[1] : undefined;
}
