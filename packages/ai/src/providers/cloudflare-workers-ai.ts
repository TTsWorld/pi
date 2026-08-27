/**
 * @file Cloudflare Workers AI provider
 * @description Cloudflare Workers AI 推理服务，两处特殊：其一，本文件不配置
 * baseUrl——各模型的 baseUrl 含 {CLOUDFLARE_ACCOUNT_ID} 占位符，因账号而异
 * 无法写死；其二，认证用 cloudflareWorkersAIAuth，除 API key 外还需账号 ID
 * （来自 CLOUDFLARE_API_KEY / CLOUDFLARE_ACCOUNT_ID 环境变量或存储的凭据）。
 * 底层 wire protocol 仍是 OpenAI 兼容的 openai-completions。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { cloudflareWorkersAIAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "./cloudflare-workers-ai.models.ts";

/**
 * 构造 Cloudflare Workers AI provider 实例。
 *
 * @returns 绑定 openai-completions API（经 cloudflareStreams 包装）与
 * CLOUDFLARE_WORKERS_AI_MODELS 目录的 Provider
 */
export function cloudflareWorkersAIProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "cloudflare-workers-ai",
		name: "Cloudflare Workers AI",
		// 认证解析需要 API key + 账号 ID 两个字段，故用 Cloudflare 专用实现
		auth: { apiKey: cloudflareWorkersAIAuth() },
		models: Object.values(CLOUDFLARE_WORKERS_AI_MODELS),
		// 包装 openai-completions 流：请求派发前物化 baseUrl 中的账号 ID 占位符
		api: cloudflareStreams(openAICompletionsApi()),
	});
}
