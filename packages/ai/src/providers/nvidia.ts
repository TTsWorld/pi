/**
 * @file NVIDIA 推理服务 provider
 * @description NVIDIA NIM（build.nvidia.com）托管的开放模型推理 API，wire
 * protocol 为 OpenAI 兼容的 openai-completions；认证从 NVIDIA_API_KEY
 * 环境变量取 key。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { NVIDIA_MODELS } from "./nvidia.models.ts";

/**
 * 构造 NVIDIA provider 实例。
 *
 * @returns 绑定 openai-completions API 与 NVIDIA_MODELS 目录的 Provider
 */
export function nvidiaProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "nvidia",
		name: "NVIDIA",
		// NIM 统一推理端点，聚合 NVIDIA 托管的各家开放模型
		baseUrl: "https://integrate.api.nvidia.com/v1",
		auth: { apiKey: envApiKeyAuth("NVIDIA API key", ["NVIDIA_API_KEY"]) },
		models: Object.values(NVIDIA_MODELS),
		api: openAICompletionsApi(),
	});
}
