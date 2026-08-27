/**
 * @file Kimi For Coding provider 定义（月之暗面 Moonshot）
 * @description 通过 anthropic-messages 线协议接入 Kimi 编程套餐专用端点
 * （api.kimi.com/coding）。支持两种认证：环境变量 KIMI_API_KEY 的
 * API key，或 Kimi Code 订阅账号的 OAuth 登录（惰性加载）。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadKimiCodingOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { KIMI_CODING_MODELS } from "./kimi-coding.models.ts";

/** 创建 Kimi For Coding provider，暴露 KIMI_CODING_MODELS 目录中的全部模型。 */
export function kimiCodingProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "kimi-coding",
		name: "Kimi For Coding",
		// Kimi 编程套餐专用端点（Anthropic Messages 兼容协议）
		baseUrl: "https://api.kimi.com/coding",
		// 双认证并存：API key 与订阅 OAuth 是两种并列的登录方式
		auth: {
			apiKey: envApiKeyAuth("Kimi API key", ["KIMI_API_KEY"]),
			// Kimi Code 订阅登录；isSubscription 标记凭据由订阅支撑而非按量计费
			oauth: lazyOAuth({
				name: "Kimi Code (subscription)",
				isSubscription: true,
				loginLabel: "Sign in with Kimi Code",
				load: loadKimiCodingOAuth,
			}),
		},
		// 模型目录来自生成的 kimi-coding.models.ts
		models: Object.values(KIMI_CODING_MODELS),
		// 单一线协议：Anthropic Messages API
		api: anthropicMessagesApi(),
	});
}
