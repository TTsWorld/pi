/**
 * @file Google Gemini provider
 * @description Google 官方 Generative Language API，使用专有的
 * google-generative-ai 协议（非 OpenAI 兼容）；认证从 GEMINI_API_KEY
 * 环境变量取 key（变量名是 Gemini 而非 Google）。
 */
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

/**
 * 构造 Google provider 实例。
 *
 * @returns 绑定 google-generative-ai API 与 GOOGLE_MODELS 目录的 Provider
 */
export function googleProvider(): Provider<"google-generative-ai"> {
	return createProvider({
		id: "google",
		name: "Google",
		// Gemini API 的 v1beta 版本端点
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: { apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]) },
		models: Object.values(GOOGLE_MODELS),
		// Google 专有协议，消息格式需完整转换（非 OpenAI 兼容）
		api: googleGenerativeAIApi(),
	});
}
