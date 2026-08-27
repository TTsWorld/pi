/**
 * @file Vercel AI Gateway provider 定义
 * @description 通过 anthropic-messages 线协议接入 Vercel AI Gateway
 * （统一代理多家上游模型的网关）。认证为环境变量 AI_GATEWAY_API_KEY，
 * 注意环境变量名不带 VERCEL_ 前缀。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { VERCEL_AI_GATEWAY_MODELS } from "./vercel-ai-gateway.models.ts";

/** 创建 Vercel AI Gateway provider，暴露 VERCEL_AI_GATEWAY_MODELS 目录中的全部模型。 */
export function vercelAIGatewayProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		// Vercel AI Gateway 官方端点（Anthropic Messages 兼容协议）
		baseUrl: "https://ai-gateway.vercel.sh",
		// 认证：环境变量 AI_GATEWAY_API_KEY（无 VERCEL_ 前缀）
		auth: { apiKey: envApiKeyAuth("Vercel AI Gateway API key", ["AI_GATEWAY_API_KEY"]) },
		// 模型目录来自生成的 vercel-ai-gateway.models.ts
		models: Object.values(VERCEL_AI_GATEWAY_MODELS),
		// 单一线协议：Anthropic Messages API
		api: anthropicMessagesApi(),
	});
}
