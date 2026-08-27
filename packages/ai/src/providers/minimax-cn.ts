/**
 * @file MiniMax 国内站 provider
 * @description MiniMax 中国大陆端点（minimaxi.com），同样通过 Anthropic
 * Messages 兼容端点接入（anthropic-messages 协议）；与国际站不同，使用独立的
 * MINIMAX_CN_API_KEY 环境变量。
 */
import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MINIMAX_CN_MODELS } from "./minimax-cn.models.ts";

/**
 * 构造 MiniMax（国内站）provider 实例。
 *
 * @returns 绑定 anthropic-messages API 与 MINIMAX_CN_MODELS 目录的 Provider
 */
export function minimaxCnProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "minimax-cn",
		name: "MiniMax CN",
		// 国内站域名（minimaxi.com）的 Anthropic 兼容路径
		baseUrl: "https://api.minimaxi.com/anthropic",
		auth: { apiKey: envApiKeyAuth("MiniMax CN API key", ["MINIMAX_CN_API_KEY"]) },
		models: Object.values(MINIMAX_CN_MODELS),
		api: anthropicMessagesApi(),
	});
}
