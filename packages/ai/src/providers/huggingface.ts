/**
 * @file Hugging Face 推理路由 provider
 * @description Hugging Face Router：聚合多家厂商/托管模型的统一推理入口，
 * wire protocol 为 OpenAI 兼容的 openai-completions；认证沿用社区惯用的
 * HF_TOKEN 环境变量（而非 HUGGINGFACE_API_KEY 之类的命名）。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { HUGGINGFACE_MODELS } from "./huggingface.models.ts";

/**
 * 构造 Hugging Face provider 实例。
 *
 * @returns 绑定 openai-completions API 与 HUGGINGFACE_MODELS 目录的 Provider
 */
export function huggingfaceProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "huggingface",
		name: "Hugging Face",
		// HF Router 统一推理入口，聚合多厂商模型
		baseUrl: "https://router.huggingface.co/v1",
		auth: { apiKey: envApiKeyAuth("Hugging Face token", ["HF_TOKEN"]) },
		models: Object.values(HUGGINGFACE_MODELS),
		api: openAICompletionsApi(),
	});
}
