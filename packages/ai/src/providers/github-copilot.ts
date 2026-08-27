/**
 * @file GitHub Copilot provider
 * @description 混合 API provider：Copilot 背后同时提供 Anthropic 与 OpenAI 两种
 * 协议的模型，因此不绑定单一 API，而是传入 api 映射表，运行时按每个模型的
 * model.api 字段分发到 anthropic-messages / openai-completions /
 * openai-responses 三套 API 实现之一。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGitHubCopilotOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GITHUB_COPILOT_MODELS } from "./github-copilot.models.ts";

/**
 * 构造 GitHub Copilot provider 实例。
 *
 * @returns 联合 API 类型的 Provider；模型按自身 api 字段路由到对应协议实现
 */
export function githubCopilotProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider({
		id: "github-copilot",
		name: "GitHub Copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		auth: {
			apiKey: envApiKeyAuth("GitHub Copilot token", ["COPILOT_GITHUB_TOKEN"]),
			oauth: lazyOAuth({ name: "GitHub Copilot", isSubscription: true, load: loadGitHubCopilotOAuth }),
		},
		models: Object.values(GITHUB_COPILOT_MODELS),
		// OAuth 凭据会携带服务端下发的可用模型列表，据此过滤掉订阅不可用的模型
		filterModels: (models, credential) => {
			// 非 OAuth 凭据没有可用列表信息，原样返回
			if (credential?.type !== "oauth") return models;
			const availableModelIds = credential.availableModelIds;
			// 列表缺失或格式不合法（非字符串数组）时视为无信息，同样不过滤
			if (!Array.isArray(availableModelIds) || !availableModelIds.every((id) => typeof id === "string")) {
				return models;
			}
			const available = new Set(availableModelIds);
			return models.filter((model) => available.has(model.id));
		},
		// 混合 dispatch：key 为 API 类型，运行时按每个模型的 model.api 选择实现
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
