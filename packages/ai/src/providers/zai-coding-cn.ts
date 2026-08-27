/**
 * @file Z.AI Coding CN provider 定义（智谱国内端）
 * @description 与 zai.ts 同构，仅切换为智谱国内端点 open.bigmodel.cn
 * （Coding 套餐），便于国内网络直连。认证用独立的
 * ZAI_CODING_CN_API_KEY，与海外端互不共享。
 */
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZAI_CODING_CN_MODELS } from "./zai-coding-cn.models.ts";

/** 创建 Z.AI Coding CN provider，暴露 ZAI_CODING_CN_MODELS 目录中的全部模型。 */
export function zaiCodingCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zai-coding-cn",
		name: "Z.AI Coding CN",
		// 智谱国内 Coding 套餐端点（open.bigmodel.cn，OpenAI 兼容）
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		// 认证：环境变量 ZAI_CODING_CN_API_KEY（独立于海外端）
		auth: { apiKey: envApiKeyAuth("Z.AI Coding CN API key", ["ZAI_CODING_CN_API_KEY"]) },
		// 模型目录来自生成的 zai-coding-cn.models.ts
		models: Object.values(ZAI_CODING_CN_MODELS),
		// 单一线协议：OpenAI Chat Completions 兼容
		api: openAICompletionsApi(),
	});
}
