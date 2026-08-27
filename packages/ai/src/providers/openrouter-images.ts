/**
 * @file OpenRouter 图像 provider 定义
 * @description OpenRouter 的图像生成入口，与文本 provider（openrouter.ts）
 * 共用同一个 id 与认证（OPENROUTER_API_KEY 或 OpenRouter OAuth）。图像
 * provider 走 createImagesProvider 工厂（images-models.ts），模型目录取自
 * 全局生成的 IMAGE_MODELS.openrouter。
 */
import { openrouterImagesApi } from "../api/openrouter-images.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenRouterOAuth } from "../auth/oauth/load.ts";
import { IMAGE_MODELS } from "../image-models.generated.ts";
import { createImagesProvider, type ImagesProvider } from "../images-models.ts";

/** 创建 OpenRouter 图像 provider，暴露 IMAGE_MODELS.openrouter 中的图像模型。 */
export function openrouterImagesProvider(): ImagesProvider {
	return createImagesProvider({
		// 与文本 provider 共用 "openrouter" id：同一账号体系下的两个入口
		id: "openrouter",
		name: "OpenRouter",
		// 认证与文本 provider 完全一致：API key 或 OAuth 二选一
		auth: {
			apiKey: envApiKeyAuth("OpenRouter API key", ["OPENROUTER_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenRouter OAuth",
				loginLabel: "Sign in with OpenRouter",
				load: loadOpenRouterOAuth,
			}),
		},
		// 图像模型目录来自生成的 image-models.generated.ts 中 openrouter 一组
		models: Object.values(IMAGE_MODELS.openrouter),
		// OpenRouter 图像生成线协议
		api: openrouterImagesApi(),
	});
}
