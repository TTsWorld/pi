/**
 * @file Azure OpenAI（Responses API 版）provider
 * @description Azure 托管的 OpenAI Responses API（azure-openai-responses 协议）。
 * 特殊点：这里不配置 baseUrl——请求地址由 API 层按 Azure 资源名 + deployment
 * 名称动态拼装（deployment 映射可经 AZURE_OPENAI_DEPLOYMENT_NAME_MAP 等
 * 环境变量提供）；认证从 AZURE_OPENAI_API_KEY 环境变量取 key。
 */
import { azureOpenAIResponsesApi } from "../api/azure-openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { AZURE_OPENAI_RESPONSES_MODELS } from "./azure-openai-responses.models.ts";

/**
 * 构造 Azure OpenAI（Responses API）provider 实例。
 *
 * @returns 绑定 azure-openai-responses API 与 AZURE_OPENAI_RESPONSES_MODELS 目录的 Provider
 */
export function azureOpenAIResponsesProvider(): Provider<"azure-openai-responses"> {
	return createProvider({
		id: "azure-openai-responses",
		name: "Azure OpenAI",
		// 不设 baseUrl：实际端点由 Azure 资源名 + deployment 名在 API 层解析
		auth: { apiKey: envApiKeyAuth("Azure OpenAI API key", ["AZURE_OPENAI_API_KEY"]) },
		models: Object.values(AZURE_OPENAI_RESPONSES_MODELS),
		// Azure 版 Responses API（基于 openai SDK 的 AzureOpenAI 客户端实现）
		api: azureOpenAIResponsesApi(),
	});
}
