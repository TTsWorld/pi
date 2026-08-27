/**
 * @file xAI（Grok）provider 定义
 * @description 通过 openai-responses 线协议接入 xAI 官方 API。支持两种
 * 认证：环境变量 XAI_API_KEY 的 API key，或 SuperGrok / X Premium 订阅
 * 账号的 OAuth 登录（OAuth 实现惰性加载，仅在首次使用时引入）。
 */
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadXaiOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { XAI_MODELS } from "./xai.models.ts";

/** 创建 xAI provider，对外暴露 XAI_MODELS 目录中的全部模型。 */
export function xaiProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "xai",
		name: "xAI",
		// xAI 官方的 OpenAI 兼容端点
		baseUrl: "https://api.x.ai/v1",
		// 双认证并存：API key 与订阅 OAuth 是两种并列的登录方式
		auth: {
			apiKey: envApiKeyAuth("xAI API key", ["XAI_API_KEY"]),
			// Grok / X 订阅登录；isSubscription 标记凭据由订阅支撑而非按量计费
			oauth: lazyOAuth({
				name: "xAI (Grok/X subscription)",
				isSubscription: true,
				loginLabel: "Sign in with SuperGrok or X Premium",
				load: loadXaiOAuth,
			}),
		},
		// 模型目录来自生成的 xai.models.ts
		models: Object.values(XAI_MODELS),
		// 单一线协议：所有模型统一走 OpenAI Responses API
		api: openAIResponsesApi(),
	});
}
