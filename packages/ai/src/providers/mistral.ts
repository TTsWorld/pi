/**
 * @file Mistral 官方 API provider
 * @description Mistral 使用自家 Conversations API（mistral-conversations 协议），
 * 是少数不走 OpenAI 兼容协议的 provider 之一；认证从 MISTRAL_API_KEY
 * 环境变量取 key。
 */
import { mistralConversationsApi } from "../api/mistral-conversations.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MISTRAL_MODELS } from "./mistral.models.ts";

/**
 * 构造 Mistral provider 实例。
 *
 * @returns 绑定 mistral-conversations API 与 MISTRAL_MODELS 目录的 Provider
 */
export function mistralProvider(): Provider<"mistral-conversations"> {
	return createProvider({
		id: "mistral",
		name: "Mistral",
		// Mistral 官方 API 根地址（无 /v1 等版本前缀，由 API 层自行拼接路径）
		baseUrl: "https://api.mistral.ai",
		auth: { apiKey: envApiKeyAuth("Mistral API key", ["MISTRAL_API_KEY"]) },
		models: Object.values(MISTRAL_MODELS),
		// Mistral 专有 Conversations 协议，而非 OpenAI 兼容
		api: mistralConversationsApi(),
	});
}
