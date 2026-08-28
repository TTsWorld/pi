/**
 * @file credential-print.ts —— `auth print-api-key` / `print-bearer-token` 的实现
 *
 * @description
 * 根据命令类型解析出一个可直接使用的凭据并返回（由调用方负责打印）：
 * api_key 只认静态 key，bearer_token 只认 OAuth；可按 --provider 精确指定，
 * 或只给 --model 时在所有已配置凭据的供应商中自动找出能解析该模型者。
 */

import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, type AuthCommandKind, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

// 未指定 --min-expiry 时的默认值：要求 OAuth token 至少还剩 30 分钟，避免拿到马上就过期的 token
const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

/** 可打印凭据的子命令种类（从 AuthCommandKind 中排除 check） */
type CredentialPrintKind = Exclude<AuthCommandKind, "check">;

/**
 * 解析并返回一个已配置供应商的凭据。
 *
 * NOTE: 此处刻意走 ModelRuntime.getAuth()——它会沿正常的请求认证路径，
 * 刷新并持久化剩余有效期不足五分钟的 OAuth 凭据。
 *
 * @param kind 凭据类型：api_key 或 bearer_token
 * @param minExpiryMs bearer token 要求的最小剩余有效期（毫秒）
 * @returns 唯一匹配的凭据字符串；无匹配或有多个匹配时抛 AuthCommandError
 */
export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	kind: CredentialPrintKind,
	minExpiryMs?: number,
	signal?: AbortSignal,
): Promise<string> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, kind);
	// 已配置凭据的供应商 → 凭据类型（api_key / oauth），后面按类型过滤
	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		(await modelRuntime.listCredentials({ signal })).map((credential) => [credential.providerId, credential.type]),
	);
	const providers: Array<{ id: string; model?: Model<Api> }> = [];
	// 指定了 --provider：只考虑这一个供应商（可再用 --model 顺带校验模型存在）
	if (cliProvider) {
		const provider = modelRuntime.getProvider(cliProvider);
		if (!provider) {
			throw new AuthCommandError(`Unknown provider "${cliProvider}". Use --list-models to see available providers.`);
		}
		if (cliModel) {
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel, modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new AuthCommandError(resolved.error ?? "Unable to resolve the requested provider/model");
			}
			providers.push({ id: provider.id, model: resolved.model });
		} else {
			providers.push({ id: provider.id });
		}
	} else {
		// 只给了 --model：遍历所有已配置凭据的供应商，收集能解析出该模型者
		for (const provider of modelRuntime.getProviders()) {
			if (!credentialTypes.has(provider.id)) continue;
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel: cliModel!, modelRuntime });
			// 解析失败、或只是「自定义模型 id 兜底匹配」（warning）的供应商不算命中
			if (resolved.model && !resolved.error && !resolved.warning?.includes("Using custom model id")) {
				providers.push({ id: provider.id, model: resolved.model });
			}
		}
		if (providers.length === 0) {
			throw new AuthCommandError(`Model "${cliModel}" not found. Use --list-models to see available models.`);
		}
	}

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const provider of providers) {
		const type = credentialTypes.get(provider.id);
		// 按命令类型过滤凭据：api_key 只取静态 key，bearer_token 只取 OAuth
		if (kind === "api_key" && type === "oauth") continue;
		if (kind === "bearer_token" && type !== "oauth") continue;
		const authOptions = {
			...(kind === "bearer_token" ? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS } : {}),
			signal,
		};
		const auth = provider.model
			? await modelRuntime.getAuth(provider.model, authOptions)
			: await modelRuntime.getAuth(provider.id, authOptions);
		const value = getAuthCredential(auth);
		if (value) credentials.push({ providerId: provider.id, value });
	}

	// 恰好一个匹配：直接返回其凭据
	if (credentials.length === 1) return credentials[0].value;
	if (credentials.length === 0) {
		// 一个都没有：按最常见的配置错误给出尽可能精确的提示
		const providerId = providers[0]?.id;
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		if (cliProvider && kind === "api_key" && type === "oauth") {
			throw new AuthCommandError(`Provider "${providerId}" is configured with OAuth, not an API key`);
		}
		if (cliProvider && kind === "bearer_token" && type !== "oauth") {
			throw new AuthCommandError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
		}
		throw new AuthCommandError(`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`);
	}
	// 多个供应商都匹配：无法替用户做选择，要求显式指定 --provider
	throw new AuthCommandError(
		`Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
	);
}
