/**
 * @file Xiaomi Token Plan AMS provider 定义（小米 token 套餐 · 阿姆斯特丹区）
 * @description 与 xiaomi.ts 同构，接入小米 token 包月套餐的阿姆斯特丹
 * （欧洲）区域端点（token-plan-ams）。套餐凭据只在对应区域有效，
 * 因此每个区域独立一个 provider 和一把 API key。
 * 认证为环境变量 XIAOMI_TOKEN_PLAN_AMS_API_KEY。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { XIAOMI_TOKEN_PLAN_AMS_MODELS } from "./xiaomi-token-plan-ams.models.ts";

/** 创建 Xiaomi Token Plan AMS provider，暴露 XIAOMI_TOKEN_PLAN_AMS_MODELS 目录中的全部模型。 */
export function xiaomiTokenPlanAmsProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "xiaomi-token-plan-ams",
		name: "Xiaomi Token Plan AMS",
		// 小米 token 套餐阿姆斯特丹（欧洲）区域端点（OpenAI 兼容）
		baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		// 认证：环境变量 XIAOMI_TOKEN_PLAN_AMS_API_KEY（仅欧洲区有效）
		auth: { apiKey: envApiKeyAuth("Xiaomi Token Plan AMS API key", ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"]) },
		// 模型目录来自生成的 xiaomi-token-plan-ams.models.ts
		models: Object.values(XIAOMI_TOKEN_PLAN_AMS_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
