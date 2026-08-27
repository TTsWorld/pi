/**
 * @file Xiaomi provider 定义（小米 MiMo）
 * @description 通过 openai-completions 线协议接入小米 MiMo 模型服务，
 * 是小米的通用（按量）入口；另有按 token 套餐计费的区域变体
 * xiaomi-token-plan-{cn,sgp,ams}.ts。认证为环境变量 XIAOMI_API_KEY。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XIAOMI_MODELS } from "./xiaomi.models.ts";

/** 创建 Xiaomi provider，暴露 XIAOMI_MODELS 目录中的全部模型。 */
export function xiaomiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "xiaomi",
		name: "Xiaomi",
		// 小米 MiMo 开放平台端点（OpenAI 兼容）
		baseUrl: "https://api.xiaomimimo.com/v1",
		// 认证：环境变量 XIAOMI_API_KEY
		auth: { apiKey: envApiKeyAuth("Xiaomi API key", ["XIAOMI_API_KEY"]) },
		// 模型目录来自生成的 xiaomi.models.ts
		models: Object.values(XIAOMI_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
