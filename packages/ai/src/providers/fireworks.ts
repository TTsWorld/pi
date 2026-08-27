/**
 * @file Fireworks AI provider 定义
 * @description 接入 Fireworks 推理平台。模型目录中混合了两种 api 类型，
 * 通过 api 映射表分别提供 anthropic-messages 与 openai-completions 两套
 * 线协议实现，运行时按 model.api 键控分派。
 * 认证为环境变量 FIREWORKS_API_KEY，无 OAuth。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FIREWORKS_MODELS } from "./fireworks.models.ts";

/** 创建 Fireworks provider，暴露 FIREWORKS_MODELS 目录中的全部模型。 */
export function fireworksProvider(): Provider<"anthropic-messages" | "openai-completions"> {
	return createProvider({
		id: "fireworks",
		name: "Fireworks",
		// Fireworks 推理端点（/inference 前缀）
		baseUrl: "https://api.fireworks.ai/inference",
		// 认证：环境变量 FIREWORKS_API_KEY
		auth: { apiKey: envApiKeyAuth("Fireworks API key", ["FIREWORKS_API_KEY"]) },
		// 模型目录来自生成的 fireworks.models.ts
		models: Object.values(FIREWORKS_MODELS),
		// api 映射表：混合 API provider，按模型自带的 api 字段选择线协议实现
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}
