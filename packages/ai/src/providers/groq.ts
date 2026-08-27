/**
 * @file Groq 推理服务 provider
 * @description Groq 基于 LPU 的超低延迟推理服务，wire protocol 为 OpenAI
 * 兼容的 openai-completions；认证从 GROQ_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GROQ_MODELS } from "./groq.models.ts";

/**
 * 构造 Groq provider 实例。
 *
 * @returns 绑定 openai-completions API 与 GROQ_MODELS 目录的 Provider
 */
export function groqProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "groq",
		name: "Groq",
		// Groq 的 OpenAI 兼容路径（/openai/v1）
		baseUrl: "https://api.groq.com/openai/v1",
		auth: { apiKey: envApiKeyAuth("Groq API key", ["GROQ_API_KEY"]) },
		models: Object.values(GROQ_MODELS),
		api: openAICompletionsApi(),
	});
}
