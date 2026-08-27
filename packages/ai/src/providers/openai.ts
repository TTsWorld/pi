/**
 * @file OpenAI 官方 API provider
 * @description OpenAI 本尊，使用自家 Responses API（openai-responses 协议）
 * 而非 Chat Completions；认证从 OPENAI_API_KEY 环境变量取 key。
 */
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_MODELS } from "./openai.models.ts";

/**
 * 构造 OpenAI provider 实例。
 *
 * @returns 绑定 openai-responses API 与 OPENAI_MODELS 目录的 Provider
 */
export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: Object.values(OPENAI_MODELS),
		// 注意走的是新版 Responses API，而非 openai-completions（Chat Completions）
		api: openAIResponsesApi(),
	});
}
