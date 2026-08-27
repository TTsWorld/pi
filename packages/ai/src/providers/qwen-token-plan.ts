/**
 * @file Qwen Token Plan provider 定义（阿里云百炼 token 套餐）
 * @description 通过 openai-completions 线协议接入阿里云百炼的 Qwen token
 * 包月套餐端点（compatible-mode 兼容模式，位于 ap-southeast-1 东南亚区）。
 * 套餐 key 只对 token-plan 端点生效，与按量计费的通义入口相互独立。
 * 认证为环境变量 QWEN_TOKEN_PLAN_API_KEY。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { QWEN_TOKEN_PLAN_MODELS } from "./qwen-token-plan.models.ts";

/** 创建 Qwen Token Plan provider，暴露 QWEN_TOKEN_PLAN_MODELS 目录中的全部模型。 */
export function qwenTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qwen-token-plan",
		name: "Qwen Token Plan",
		// 百炼 token 套餐的东南亚区兼容模式端点（OpenAI 兼容）
		baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
		// 认证：环境变量 QWEN_TOKEN_PLAN_API_KEY（仅对套餐端点生效）
		auth: { apiKey: envApiKeyAuth("Qwen Token Plan API key", ["QWEN_TOKEN_PLAN_API_KEY"]) },
		// 模型目录来自生成的 qwen-token-plan.models.ts
		models: Object.values(QWEN_TOKEN_PLAN_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
