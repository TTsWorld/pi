/**
 * @file Moonshot AI（Kimi）国内站 provider
 * @description Kimi 的中国大陆端点（moonshot.cn），wire protocol 为 OpenAI
 * 兼容的 openai-completions。特殊点：与国际站共用同一个 MOONSHOT_API_KEY
 * 环境变量（未设独立的 CN 变量），两者仅靠 baseUrl 区分。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOTAI_CN_MODELS } from "./moonshotai-cn.models.ts";

/**
 * 构造 Moonshot AI（国内站）provider 实例。
 *
 * @returns 绑定 openai-completions API 与 MOONSHOTAI_CN_MODELS 目录的 Provider
 */
export function moonshotaiCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "moonshotai-cn",
		name: "Moonshot AI CN",
		// 国内站端点（.cn 域名）
		baseUrl: "https://api.moonshot.cn/v1",
		// 与国际站共用 MOONSHOT_API_KEY，没有单独的 CN 环境变量
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		models: Object.values(MOONSHOTAI_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
