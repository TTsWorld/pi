/**
 * @file Z.AI provider 定义（智谱 GLM 海外端）
 * @description 通过 openai-completions 线协议接入 Z.AI（智谱海外品牌）
 * 的 Coding 套餐端点（api.z.ai）。国内端点变体见 zai-coding-cn.ts。
 * 认证为环境变量 ZAI_API_KEY，无 OAuth。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_MODELS } from "./zai.models.ts";

/** 创建 Z.AI provider，暴露 ZAI_MODELS 目录中的全部模型。 */
export function zaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai",
		name: "Z.AI",
		// Z.AI 海外 Coding 套餐端点（OpenAI 兼容）
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		// 认证：环境变量 ZAI_API_KEY
		auth: { apiKey: envApiKeyAuth("Z.AI API key", ["ZAI_API_KEY"]) },
		// 模型目录来自生成的 zai.models.ts
		models: Object.values(ZAI_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
