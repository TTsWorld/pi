/**
 * @file 蚂蚁 Ant Ling（灵）模型服务 provider
 * @description 蚂蚁集团 Ling 系列模型的官方 API 服务，wire protocol 为
 * OpenAI 兼容的 openai-completions；认证从 ANT_LING_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANT_LING_MODELS } from "./ant-ling.models.ts";

/**
 * 构造 Ant Ling provider 实例。
 *
 * @returns 绑定 openai-completions API 与 ANT_LING_MODELS 目录的 Provider
 */
export function antLingProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "ant-ling",
		name: "Ant Ling",
		// Ant Ling 官方 OpenAI 兼容端点
		baseUrl: "https://api.ant-ling.com/v1",
		auth: { apiKey: envApiKeyAuth("Ant Ling API key", ["ANT_LING_API_KEY"]) },
		models: Object.values(ANT_LING_MODELS),
		api: openAICompletionsApi(),
	});
}
