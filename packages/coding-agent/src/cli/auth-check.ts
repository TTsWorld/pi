/**
 * @file auth-check.ts —— `auth check` 的认证状态检查实现
 *
 * @description
 * 判定某供应商/模型的认证是否就绪：区分「未配置凭据」「供应商不存在」「状态异常」等原因，
 * 并支持可选地走一次真实取凭据路径以刷新快过期的 OAuth token。
 */

import type { CredentialStore } from "@earendil-works/pi-ai";
import { resolveCliModel } from "../core/model-resolver.ts";
import { ModelRuntime } from "../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../core/models-store.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

/** 检查结果状态：ready（就绪）/ not_ready（用户可自行修复）/ invalid（状态异常） */
export type AuthCheckStatus = "ready" | "not_ready" | "invalid";
/** not_ready / invalid 的具体原因，供上层给出针对性提示 */
export type AuthCheckReason =
	| "provider_not_found"
	| "credentials_not_configured"
	| "credential_not_available"
	| "invalid_state";

/** 单个供应商的认证检查结果 */
export interface AuthCheckResult {
	status: AuthCheckStatus;
	provider: string;
	reason?: AuthCheckReason;
	authType?: "api_key" | "oauth";
}

/**
 * 检查某供应商（或某模型所属供应商）的认证状态。
 * @param options.refresh 为 true 时额外走一次 getAuth，顺带刷新快过期的 OAuth 凭据
 * @returns 认证检查结果；参数本身不合法时抛 AuthCommandError
 */
export async function checkProviderAuth(
	args: Args,
	modelRuntime: ModelRuntime,
	options: { refresh: boolean } = { refresh: false },
): Promise<AuthCheckResult> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, "check");
	// 给了 --model 时先解析出模型，用它所属的供应商作为检查目标
	let provider = cliProvider;
	if (cliModel) {
		const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
		if (resolved.error || !resolved.model) {
			throw new AuthCommandError(resolved.error ?? `Unable to resolve model "${cliModel}"`);
		}
		provider = resolved.model.provider;
	}
	if (!provider) throw new AuthCommandError("Unable to resolve an auth provider");
	// models.json 本身加载失败：状态无效，无法做有意义的检查
	if (modelRuntime.getError()) {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
	if (!modelRuntime.getProvider(provider)) {
		return { status: "not_ready", provider, reason: "provider_not_found" };
	}
	try {
		const auth = await modelRuntime.checkAuth(provider);
		if (!auth) return { status: "not_ready", provider, reason: "credentials_not_configured" };
		// 需要刷新时用 getAuth 走真实取凭据路径；取不到说明凭据实际不可用
		if (options.refresh && !(await modelRuntime.getAuth(provider))) {
			return { status: "not_ready", provider, reason: "credentials_not_configured" };
		}
		return { status: "ready", provider, authType: auth.type };
	} catch {
		return { status: "invalid", provider, reason: "invalid_state" };
	}
}

/**
 * 读取某供应商的凭据字符串。
 * 非 refresh 模式优先直接读凭据存储：OAuth 凭据存在则原样返回 access token，
 * 不触发网络刷新；否则走 getAuth（会刷新）再提取。返回 undefined 表示无凭据。
 */
export async function getProviderCredential(
	providerId: string,
	modelRuntime: ModelRuntime,
	credentials: CredentialStore,
	options: { refresh: boolean },
): Promise<string | undefined> {
	const credential = await credentials.read(providerId);
	if (!options.refresh && credential?.type === "oauth") return credential.access;
	return getAuthCredential(await modelRuntime.getAuth(providerId));
}

/**
 * 为认证检查构造一个独立的 ModelRuntime。
 * 使用内存态 models store，并禁用网络与启动时刷新：
 * 检查只关心当前配置/磁盘状态，不应因检查动作产生网络请求或凭据变更。
 */
export async function createAuthCheckModelRuntime(credentials: CredentialStore): Promise<ModelRuntime> {
	return ModelRuntime.create({
		credentials,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
}
