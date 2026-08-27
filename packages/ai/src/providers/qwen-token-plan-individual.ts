/**
 * @file 阿里云 Qwen「Token 套餐」个人版 provider
 * @description Qwen Token 套餐是按订阅计费的变体（区别于按量付费的百炼默认
 * 模式），本文件对应个人版：端点位于新加坡区域，wire protocol 走 OpenAI 兼容
 * 的 openai-completions，认证从 QWEN_TOKEN_PLAN_API_KEY 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS } from "./qwen-token-plan-individual.models.ts";

/**
 * 构造 Qwen Token 套餐（个人版）provider 实例。
 *
 * @returns 绑定 openai-completions API 与 QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS 目录的 Provider
 */
export function qwenTokenPlanIndividualProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan-individual",
		name: "Qwen Token Plan Individual",
		// 个人版套餐部署在新加坡（ap-southeast-1）Maas 的 OpenAI 兼容端点
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan Individual API key", ["QWEN_TOKEN_PLAN_API_KEY"]) },
		models: Object.values(QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS),
		api: openAICompletionsApi(),
	});
}
