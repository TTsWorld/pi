/**
 * @file Cerebras 推理服务 provider
 * @description Cerebras 基于晶圆级引擎（WSE）的推理服务，主打极高吞吐与
 * 极低延迟，wire protocol 为 OpenAI 兼容的 openai-completions；认证从
 * CEREBRAS_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { CEREBRAS_MODELS } from "./cerebras.models.ts";

/**
 * 构造 Cerebras provider 实例。
 *
 * @returns 绑定 openai-completions API 与 CEREBRAS_MODELS 目录的 Provider
 */
export function cerebrasProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cerebras",
		name: "Cerebras",
		// Cerebras Cloud API 的 OpenAI 兼容端点
		baseUrl: "https://api.cerebras.ai/v1",
		auth: { apiKey: envApiKeyAuth("Cerebras API key", ["CEREBRAS_API_KEY"]) },
		models: Object.values(CEREBRAS_MODELS),
		api: openAICompletionsApi(),
	});
}
