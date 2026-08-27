/**
 * @file Baseten 模型推理平台 provider
 * @description Baseten 是模型部署/推理托管平台，wire protocol 为 OpenAI
 * 兼容的 openai-completions；认证从 BASETEN_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { BASETEN_MODELS } from "./baseten.models.ts";

/**
 * 构造 Baseten provider 实例。
 *
 * @returns 绑定 openai-completions API 与 BASETEN_MODELS 目录的 Provider
 */
export function basetenProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "baseten",
		name: "Baseten",
		// Baseten 统一推理入口（模型以 deployment 形式托管）
		baseUrl: "https://inference.baseten.co/v1",
		auth: { apiKey: envApiKeyAuth("Baseten API key", ["BASETEN_API_KEY"]) },
		models: Object.values(BASETEN_MODELS),
		api: openAICompletionsApi(),
	});
}
