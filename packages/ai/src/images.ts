/**
 * @file 旧版全局图像生成入口 generateImages()。
 * @description 顶部对 providers/images/register-builtins.ts 的 import 是一个纯副作用
 * （side-effect）：该模块被加载时会立即把内置图像 API（目前是 openrouter-images，
 * 其真实实现仍按需懒加载）注册进 images-api-registry。因此只要 import 了本文件，
 * generateImages 便开箱即用，无需调用方手工注册 provider——这正是保留该入口的原因。
 * 新代码建议改走模型对象上的 models.generateImages；本入口主要服务存量调用方与测试
 * （test/images.test.ts）。
 */
import "./providers/images/register-builtins.ts";

import { getImagesApiProvider } from "./images-api-registry.ts";
import type { AssistantImages, ImagesApi, ImagesContext, ImagesModel, ProviderImagesOptions } from "./types.ts";

/** 按图像 API 类型（model.api）从注册表解析 provider，未注册时抛出错误。 */
function resolveImagesApiProvider(api: ImagesApi) {
	const provider = getImagesApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

/**
 * 全局图像生成入口：按 model.api 找到对应注册的 provider 并委托其 generateImages。
 * 依赖文件顶部的副作用 import 已完成内置 provider 注册，适合不想感知注册表细节的
 * 简单调用方；若提示 "No API provider registered"，说明未走本入口完成注册。
 */
export async function generateImages<TApi extends ImagesApi>(
	model: ImagesModel<TApi>,
	context: ImagesContext,
	options?: ProviderImagesOptions,
): Promise<AssistantImages> {
	const provider = resolveImagesApiProvider(model.api);
	return provider.generateImages(model, context, options);
}
