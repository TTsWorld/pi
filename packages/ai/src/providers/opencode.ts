/**
 * @file OpenCode Zen provider 定义
 * @description 接入 OpenCode Zen 模型聚合服务。目录中各模型自带端点与
 * api 类型（anthropic-messages / google-generative-ai / openai-completions /
 * openai-responses 四种），因此不设统一 baseUrl，而是用 api 映射表为每种
 * 线协议各注册一份实现，运行时按 model.api 键控分派。
 * 认证仅支持环境变量 OPENCODE_API_KEY。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_MODELS } from "./opencode.models.ts";

/** 创建 OpenCode Zen provider，暴露 OPENCODE_MODELS 目录中的全部模型。 */
export function opencodeProvider(): Provider<
	"anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses"
> {
	return createProvider({
		id: "opencode",
		name: "OpenCode Zen",
		// 认证：环境变量 OPENCODE_API_KEY（与 opencode-go 共用同一把 key）
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		// 模型目录来自生成的 opencode.models.ts
		models: Object.values(OPENCODE_MODELS),
		// api 映射表：混合 API provider，按模型自带的 api 字段选择线协议实现
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"google-generative-ai": googleGenerativeAIApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
