/**
 * @file OpenRouter provider 定义（文本模型）
 * @description 通过 openai-completions 线协议接入 OpenRouter 模型聚合
 * 网关。支持两种认证：环境变量 OPENROUTER_API_KEY 的 API key，或
 * OpenRouter 账号的 OAuth 登录（惰性加载；非订阅形态，按量计费）。
 * 图像模型入口见同目录 openrouter-images.ts，两者共用 id 与认证。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENROUTER_MODELS } from "./openrouter.models.ts";

/** 创建 OpenRouter 文本 provider，暴露 OPENROUTER_MODELS 目录中的全部模型。 */
export function openrouterProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "openrouter",
		name: "OpenRouter",
		// OpenRouter 官方的 OpenAI 兼容网关
		baseUrl: "https://openrouter.ai/api/v1",
		// 双认证并存：API key 与 OAuth 是两种并列的登录方式
		auth: {
			apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]),
			// 未标记 isSubscription：OAuth 登录后仍按 OpenRouter 用量计费
			oauth: lazyOAuth({
				name: "OpenRouter OAuth",
				loginLabel: "Sign in with OpenRouter",
				load: loadOpenRouterOAuth,
			}),
		},
		// 模型目录来自生成的 openrouter.models.ts
		models: Object.values(OPENROUTER_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
