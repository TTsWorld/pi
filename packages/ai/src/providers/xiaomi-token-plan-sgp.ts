/**
 * @file Xiaomi Token Plan SGP provider 定义（小米 token 套餐 · 新加坡区）
 * @description 与 xiaomi.ts 同构，接入小米 token 包月套餐的新加坡区域
 * 端点（token-plan-sgp）。套餐凭据只在对应区域有效，因此每个区域独立
 * 一个 provider 和一把 API key。认证为环境变量 XIAOMI_TOKEN_PLAN_SGP_API_KEY。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from "./xiaomi-token-plan-sgp.models.ts";

/** 创建 Xiaomi Token Plan SGP provider，暴露 XIAOMI_TOKEN_PLAN_SGP_MODELS 目录中的全部模型。 */
export function xiaomiTokenPlanSgpProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "xiaomi-token-plan-sgp",
		name: "Xiaomi Token Plan SGP",
		// 小米 token 套餐新加坡区域端点（OpenAI 兼容）
		baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		// 认证：环境变量 XIAOMI_TOKEN_PLAN_SGP_API_KEY（仅新加坡区有效）
		auth: { apiKey: envApiKeyAuth("Xiaomi Token Plan SGP API key", ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"]) },
		// 模型目录来自生成的 xiaomi-token-plan-sgp.models.ts
		models: Object.values(XIAOMI_TOKEN_PLAN_SGP_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
