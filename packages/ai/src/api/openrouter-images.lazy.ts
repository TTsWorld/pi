/**
 * @file OpenRouter 图像生成的懒加载 shim。
 * @description 与其它 .lazy.ts 不同，这里不经过 lazyApi（图像生成不是流式接口），
 * 而是在 generateImages 内部直接动态 import 完整实现 openrouter-images.ts。
 */
import type { ImagesModel, ProviderImages } from "../types.ts";

/** 工厂函数：返回懒加载版 OpenRouter 图像生成 API（generateImages，调用时才加载实现）。 */
export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: async (model, context, options) =>
		(await import("./openrouter-images.ts")).generateImages(
			model as ImagesModel<"openrouter-images">,
			context,
			options,
		),
});
