/**
 * @file OpenAI Codex provider 定义
 * @description 通过 openai-codex-responses 线协议接入 ChatGPT 后端
 * （chatgpt.com/backend-api），即 Codex CLI 使用的同款通道。仅支持
 * ChatGPT Plus / Pro 订阅账号的 OAuth 登录，不提供 API key 方式。
 */
import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

/** 创建 OpenAI Codex provider，暴露 OPENAI_CODEX_MODELS 目录中的全部模型。 */
export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex",
		// ChatGPT 后端 API：不走 platform 端点，因此没有 API key 认证
		baseUrl: "https://chatgpt.com/backend-api",
		// 仅订阅 OAuth 一种认证：凭据由 ChatGPT Plus / Pro 订阅支撑
		auth: {
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT Plus/Pro)",
				isSubscription: true,
				load: loadOpenAICodexOAuth,
			}),
		},
		// 模型目录来自生成的 openai-codex.models.ts
		models: Object.values(OPENAI_CODEX_MODELS),
		// 单一线协议：Codex 定制的 Responses API
		api: openAICodexResponsesApi(),
	});
}
