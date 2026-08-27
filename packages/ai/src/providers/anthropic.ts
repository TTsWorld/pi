/**
 * @file Anthropic（Claude）官方 API provider
 * @description 按统一模板定义 Anthropic provider：使用 anthropic-messages API
 * 与官方 https://api.anthropic.com 端点，支持两种认证方式——API key 与
 * Claude Pro/Max 订阅 OAuth（懒加载）。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadAnthropicOAuth } from "../auth/oauth/load.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { ANTHROPIC_API_KEY_ENV, ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV } from "../env-api-keys.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTHROPIC_MODELS } from "./anthropic.models.ts";

/**
 * 构造 Anthropic 的 API key 认证定义。
 *
 * @returns ApiKeyAuth 认证对象：login 走交互式输入密钥；resolve 按优先级
 * 依次尝试已存储凭据 → ANTHROPIC_AUTH_TOKEN（Bearer 头）→
 * ANTHROPIC_OAUTH_TOKEN → ANTHROPIC_API_KEY 环境变量
 */
function anthropicApiKeyAuth(): ApiKeyAuth {
	return {
		name: "Anthropic API key",
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: "Enter Anthropic API key" });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			// 已存储的凭据优先级最高，直接复用其 key 与 env
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}

			// AUTH_TOKEN 走 Bearer 头而非 x-api-key，兼容网关/代理场景
			const authToken = await ctx.env(ANTHROPIC_AUTH_TOKEN_ENV);
			signal.throwIfAborted();
			if (authToken) {
				return {
					auth: { headers: { Authorization: `Bearer ${authToken}` } },
					source: ANTHROPIC_AUTH_TOKEN_ENV,
				};
			}

			// 依次尝试 OAUTH_TOKEN 与 API_KEY 两个环境变量，命中即返回
			for (const envVar of [ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV]) {
				const apiKey = await ctx.env(envVar);
				signal.throwIfAborted();
				if (apiKey) return { auth: { apiKey }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * 构造 Anthropic provider 实例。
 *
 * @returns 绑定 anthropic-messages API 与 ANTHROPIC_MODELS 目录的 Provider
 */
export function anthropicProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "anthropic",
		name: "Anthropic",
		baseUrl: "https://api.anthropic.com",
		auth: {
			apiKey: anthropicApiKeyAuth(),
			// 订阅式 OAuth（Claude Pro/Max），凭据实现按需懒加载
			oauth: lazyOAuth({
				name: "Anthropic (Claude Pro/Max)",
				isSubscription: true,
				load: loadAnthropicOAuth,
			}),
		},
		models: Object.values(ANTHROPIC_MODELS),
		api: anthropicMessagesApi(),
	});
}
