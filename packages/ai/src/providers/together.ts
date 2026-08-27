/**
 * @file Together AI provider 定义
 * @description 通过 openai-completions 线协议接入 Together AI 推理平台。
 * 认证为环境变量 TOGETHER_API_KEY，无 OAuth。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { TOGETHER_MODELS } from "./together.models.ts";

/** 创建 Together provider，暴露 TOGETHER_MODELS 目录中的全部模型。 */
export function togetherProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "together",
		name: "Together",
		// Together AI 官方的 OpenAI 兼容端点
		baseUrl: "https://api.together.ai/v1",
		// 认证：环境变量 TOGETHER_API_KEY
		auth: { apiKey: envApiKeyAuth("Together API key", ["TOGETHER_API_KEY"]) },
		// 模型目录来自生成的 together.models.ts
		models: Object.values(TOGETHER_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
