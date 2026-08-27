/**
 * @file 图像 API 全局注册表：按 api 标识分发 generateImages 实现。
 * @description
 * 「旧全局面」的运行时执行端：模型定义（image-models.ts）只携带 api 字符串，
 * 真正的生成函数在这里按 api 注册与查找。provider 适配器（如
 * providers/images/register-builtins.ts 里的 openrouter-images）在 import 时
 * 调用 registerImagesApiProvider 完成注册；images.ts 的 generateImages() 再用
 * getImagesApiProvider(api) 取回实现执行。
 *
 * 与新轨的关系：images-models.ts 的 ImagesProvider / ImagesModels 把 provider、
 * auth、模型列表与生成函数收拢为显式集合，不再依赖 import 副作用注册，
 * 是迁移方向；本文件主要服务旧入口 images.ts 的存量调用方。
 */
import type { AssistantImages, ImagesApi, ImagesContext, ImagesFunction, ImagesModel, ImagesOptions } from "./types.ts";

/**
 * 注册表内部统一存放的生成函数形态：参数为擦除泛型后的宽类型。
 *
 * Why：不同 provider 实现的 ImagesFunction 泛型参数（TApi/TOptions）各不相同，
 * Map 只能存同一种签名；因此存这个「公共父类型」，调用时的类型回转
 * 由 wrapGenerateImages() 负责并做运行时校验。
 *
 * @param model   - 要使用的图像模型（api 为宽类型 ImagesApi）
 * @param context - 生成上下文（提示词等）
 * @param options - 可选请求选项（尺寸、数量、apiKey 等）
 * @returns 生成的 AssistantImages 结果
 */
export type ImagesApiFunction = (
	model: ImagesModel<ImagesApi>,
	context: ImagesContext,
	options?: ImagesOptions,
) => Promise<AssistantImages>;

/**
 * 注册一个图像 API 实现所需的全部信息：api 标识 + 生成函数。
 *
 * @template TApi     - 具体的 api 标识（如 "openrouter-images"）
 * @template TOptions - 该实现接受的选项类型
 */
export interface ImagesApiProvider<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> {
	api: TApi;
	generateImages: ImagesFunction<TApi, TOptions>;
}

/**
 * 注册表内部实际存储的形态：字段与 ImagesApiProvider 一致，但生成函数
 * 已被 wrapGenerateImages() 包装成统一的宽签名 ImagesApiFunction，
 * 以便不同泛型参数的实现能放进同一个 Map。
 */
interface ImagesApiProviderInternal {
	api: ImagesApi;
	generateImages: ImagesApiFunction;
}

/**
 * 注册表条目：包装后的 provider 实现 + 可选的 sourceId。
 * sourceId 用于标识注册来源，便于排查「谁注册的 / 是否重复注册」。
 */
type RegisteredImagesApiProvider = {
	provider: ImagesApiProviderInternal;
	sourceId?: string;
};

// 全局单例注册表：api 标识 -> 注册条目。模块级状态，import 即存在；
// 这是旧轨「全局」二字的由来，也是与新版显式集合（images-models.ts）最大的差异。
const imagesApiProviderRegistry = new Map<string, RegisteredImagesApiProvider>();

/**
 * 把带泛型的 ImagesFunction 包装成统一的宽签名，并加一道运行时防线：
 * 模型自带的 api 与注册时的 api 不一致时立即抛错。
 *
 * Why：擦除泛型后类型系统不再保证 model.api 与实现匹配；这道检查把
 * 「路由到错误实现的模型」暴露在调用入口，而不是让 provider 内部
 * 产生难以追踪的诡异行为。
 *
 * @param api            - 注册时声明的 api 标识
 * @param generateImages - 具体实现（窄类型）
 * @returns 可存入注册表的宽签名函数
 */
function wrapGenerateImages<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	api: TApi,
	generateImages: ImagesFunction<TApi, TOptions>,
): ImagesApiFunction {
	return (model, context, options) => {
		// 防线：模型 api 与注册 api 不符说明路由错了，直接抛错而不是勉强执行。
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return generateImages(model as ImagesModel<TApi>, context, options as TOptions);
	};
}

/**
 * 向全局注册表注册（或按 api 覆盖）一个图像 API 实现。
 *
 * 通常由 provider 的 register-builtins 模块在 import 时调用；
 * 同一 api 重复注册时后注册者胜出（Map.set 的覆盖语义）。
 *
 * @param provider - 含 api 标识与生成函数的实现对象
 * @param sourceId - 可选来源标识，记录「谁注册的」，便于排查
 */
export function registerImagesApiProvider<TApi extends ImagesApi, TOptions extends ImagesOptions>(
	provider: ImagesApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	imagesApiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			generateImages: wrapGenerateImages(provider.api, provider.generateImages),
		},
		sourceId,
	});
}

/**
 * 按 api 标识取出注册的实现（内部宽类型）。
 * 旧入口 images.ts 的 generateImages() 用它完成「模型 -> 实现」的分发。
 *
 * @param api - api 标识，即模型上的 model.api
 * @returns 已注册的实现；未注册时返回 undefined，由调用方决定如何报错
 */
export function getImagesApiProvider(api: ImagesApi): ImagesApiProviderInternal | undefined {
	return imagesApiProviderRegistry.get(api)?.provider;
}
