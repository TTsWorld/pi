/**
 * @file OpenCode Go provider 定义
 * @description 接入 OpenCode Zen 的 Go 模型分组：与 opencode.ts 同一
 * 账号体系（共用 OPENCODE_API_KEY），但目录为独立的 OPENCODE_GO_MODELS。
 * 不设统一 baseUrl，目录中各模型自带端点；三种线协议通过 api 映射表
 * 按 model.api 键控分派。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENCODE_GO_MODELS } from "./opencode-go.models.ts";

/** 创建 OpenCode Go provider，暴露 OPENCODE_GO_MODELS 目录中的全部模型。 */
export function opencodeGoProvider(): Provider<"anthropic-messages" | "openai-completions" | "openai-responses"> {
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "opencode-go",
		name: "OpenCode Go",
		// 认证：环境变量 OPENCODE_API_KEY（与 OpenCode Zen provider 共用）
		auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
		// 模型目录来自生成的 opencode-go.models.ts
		models: Object.values(OPENCODE_GO_MODELS),
		// api 映射表：混合 API provider，按模型自带的 api 字段选择线协议实现
		api: {
			"anthropic-messages": anthropicMessagesApi(),
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
		},
	});
}
