/**
 * @file 阿里云 Qwen「Token 套餐」中国大陆版 provider
 * @description Token 套餐的国内变体：端点位于北京（cn-beijing）区域，wire
 * protocol 同样走 OpenAI 兼容的 openai-completions；认证使用独立的
 * QWEN_TOKEN_PLAN_CN_API_KEY 环境变量（与个人国际版变量互不通用）。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_CN_MODELS } from "./qwen-token-plan-cn.models.ts";

/**
 * 构造 Qwen Token 套餐（国内版）provider 实例。
 *
 * @returns 绑定 openai-completions API 与 QWEN_TOKEN_PLAN_CN_MODELS 目录的 Provider
 */
export function qwenTokenPlanCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan-cn",
		name: "Qwen Token Plan CN",
		// 国内版端点位于北京区域的 Maas OpenAI 兼容地址
		baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan CN API key", ["QWEN_TOKEN_PLAN_CN_API_KEY"]) },
		models: Object.values(QWEN_TOKEN_PLAN_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
