/**
 * @file DeepSeek 官方 API provider
 * @description DeepSeek 官方推理 API，原生采用 OpenAI 兼容格式，wire
 * protocol 为 openai-completions；认证从 DEEPSEEK_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { DEEPSEEK_MODELS } from "./deepseek.models.ts";

/**
 * 构造 DeepSeek provider 实例。
 *
 * @returns 绑定 openai-completions API 与 DEEPSEEK_MODELS 目录的 Provider
 */
export function deepseekProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "deepseek",
		name: "DeepSeek",
		// DeepSeek 官方 API 根地址，直接兼容 OpenAI 请求格式
		baseUrl: "https://api.deepseek.com",
		auth: { apiKey: envApiKeyAuth("DeepSeek API key", ["DEEPSEEK_API_KEY"]) },
		models: Object.values(DEEPSEEK_MODELS),
		api: openAICompletionsApi(),
	});
}
