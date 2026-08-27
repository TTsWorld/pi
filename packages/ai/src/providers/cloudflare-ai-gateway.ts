/**
 * @file Cloudflare AI Gateway provider 定义
 * @description 通过 Cloudflare AI Gateway（租户级网关）代理多家上游模型。
 * 目录中各模型的 baseUrl 含租户占位符（{CLOUDFLARE_ACCOUNT_ID} /
 * {CLOUDFLARE_GATEWAY_ID}），因此不设统一 baseUrl，且每条线协议实现都
 * 用 cloudflareStreams 包一层，在请求派发前把占位符替换为真实值。
 * 认证为 Cloudflare 专用的 key + 账号 ID + 网关 ID 三段式。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

// 本 provider 支持的三种线协议
type CloudflareAIGatewayApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/** 创建 Cloudflare AI Gateway provider，暴露 CLOUDFLARE_AI_GATEWAY_MODELS 目录中的全部模型。 */
export function cloudflareAIGatewayProvider(): Provider<CloudflareAIGatewayApi> {
	return createProvider<CloudflareAIGatewayApi>({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		// 认证：CLOUDFLARE_API_KEY + 账号 ID + 网关 ID 三段式（见 cloudflare-auth.ts）
		auth: { apiKey: cloudflareAIGatewayAuth() },
		// 模型目录来自生成的 cloudflare-ai-gateway.models.ts
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		// api 映射表：混合 API provider；cloudflareStreams 负责替换 baseUrl 占位符
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
