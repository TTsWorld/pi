/**
 * @file MiniMax 国际站 provider
 * @description MiniMax 暴露了 Anthropic Messages 兼容端点（路径 /anthropic），
 * 因此直接复用 anthropic-messages 协议接入；认证从 MINIMAX_API_KEY 环境变量
 * 取 key。国内站见 minimax-cn.ts。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_MODELS } from "./minimax.models.ts";

/**
 * 构造 MiniMax（国际站）provider 实例。
 *
 * @returns 绑定 anthropic-messages API 与 MINIMAX_MODELS 目录的 Provider
 */
export function minimaxProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "minimax",
		name: "MiniMax",
		// Anthropic Messages 兼容路径，故 wire protocol 用 anthropic-messages
		baseUrl: "https://api.minimax.io/anthropic",
		auth: { apiKey: envApiKeyAuth("MiniMax API key", ["MINIMAX_API_KEY"]) },
		models: Object.values(MINIMAX_MODELS),
		api: anthropicMessagesApi(),
	});
}
