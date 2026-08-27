/**
 * @file Moonshot AI（Kimi）国际站 provider
 * @description 月之暗面 Kimi 的国际端点（moonshot.ai），wire protocol 为
 * OpenAI 兼容的 openai-completions；认证从 MOONSHOT_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOTAI_MODELS } from "./moonshotai.models.ts";

/**
 * 构造 Moonshot AI（国际站）provider 实例。
 *
 * @returns 绑定 openai-completions API 与 MOONSHOTAI_MODELS 目录的 Provider
 */
export function moonshotaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "moonshotai",
		name: "Moonshot AI",
		// 国际站端点；国内站见 moonshotai-cn.ts
		baseUrl: "https://api.moonshot.ai/v1",
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		models: Object.values(MOONSHOTAI_MODELS),
		api: openAICompletionsApi(),
	});
}
