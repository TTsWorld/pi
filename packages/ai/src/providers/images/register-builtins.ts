/**
 * @file 内置图像 API 的副作用注册入口
 * @description import 本模块即自动将内置图像生成 API（openrouter-images）注册到
 * 全局 images-api 注册表。实现本体通过动态 import 懒加载，首次调用才载入；
 * 加载或调用失败时返回结构化的错误应答而不是向上抛异常。
 */
import type { generateImages as generateImagesOpenRouterFunction } from "../../api/openrouter-images.ts";
import { registerImagesApiProvider } from "../../images-api-registry.ts";
import type { AssistantImages, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "../../types.ts";

/** openrouter-images API 实现模块的最小类型描述（懒加载后的模块句柄） */
interface OpenRouterImagesProviderModule {
	generateImages: typeof generateImagesOpenRouterFunction;
}

// 缓存动态 import 的 Promise：首次调用发起加载，之后复用同一个 Promise
let openRouterImagesProviderModulePromise: Promise<OpenRouterImagesProviderModule> | undefined;

/**
 * 构造一个表示"模块懒加载失败"的图像应答对象。
 *
 * @param model 触发本次请求的图像模型
 * @param error 懒加载或调用过程中抛出的异常
 * @returns stopReason 为 "error" 的 AssistantImages，携带错误信息
 */
function createLazyLoadErrorImages(model: ImagesModel<"openrouter-images">, error: unknown): AssistantImages {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/**
 * 懒加载 openrouter-images API 实现模块（结果会被缓存）。
 *
 * @returns 模块句柄的 Promise；注意失败态同样会被缓存（||= 对已赋值的
 * rejected Promise 不会重试）
 */
function loadOpenRouterImagesProviderModule(): Promise<OpenRouterImagesProviderModule> {
	openRouterImagesProviderModulePromise ||= import("../../api/openrouter-images.ts").then(
		(module) => module as OpenRouterImagesProviderModule,
	);
	return openRouterImagesProviderModulePromise;
}

/**
 * openrouter-images 的图像生成入口：先懒加载实现模块再委托调用，
 * 任何加载/调用错误都转换为结构化错误应答。
 *
 * @param model 图像模型定义
 * @param context 调用上下文
 * @param options 可选调用选项
 * @returns 图像生成结果；出错时为 stopReason 为 "error" 的应答
 */
export const generateImagesOpenRouter: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	// 委托真正实现前先完成懒加载；失败不抛出，统一降级为错误应答
	try {
		const module = await loadOpenRouterImagesProviderModule();
		return await module.generateImages(model, context, options);
	} catch (error) {
		return createLazyLoadErrorImages(model, error);
	}
};

/**
 * 将内置图像 API（openrouter-images）注册到全局 images-api 注册表。
 */
export function registerBuiltInImagesApiProviders(): void {
	registerImagesApiProvider({
		api: "openrouter-images",
		generateImages: generateImagesOpenRouter,
	});
}

// 模块副作用：import 本文件即自动完成注册
registerBuiltInImagesApiProviders();
