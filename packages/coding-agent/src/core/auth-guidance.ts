/**
 * @file auth-guidance.ts —— 认证（登录）引导文案
 *
 * @description
 * 集中生成「未登录 / 无模型可用 / 缺 API key」等场景的
 * 用户引导文案，统一指向 /login 命令与相关文档。
 */
import { join } from "node:path";
import { getDocsPath } from "../config.ts";

// provider 未知的占位值
const UNKNOWN_PROVIDER = "unknown";

/** 通用的登录指引文案（/login 命令 + providers/models 文档路径） */
export function getProviderLoginHelp(): string {
	return [
		"Use /login to log into a provider via OAuth or API key. See:",
		`  ${join(getDocsPath(), "providers.md")}`,
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

/** 「没有任何可用模型」的提示文案 */
export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

/** 「尚未选择模型」的提示文案（登录后再用 /model 选择） */
export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

/** 「某 provider 缺少 API key」的提示文案；provider 未知时改指代所选模型 */
export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
