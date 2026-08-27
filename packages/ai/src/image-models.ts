/**
 * @file 旧全局图像模型目录的同步读取层。
 * @description
 * 从 image-models.generated.ts 的 IMAGE_MODELS（脚本自动生成，勿手改）出发，
 * 在模块加载时构建「provider -> 模型」两级 Map，并提供带精确类型的同步查询：
 * getImageModel / getImageModels / getImageProviders。
 *
 * 属于图像体系「旧全局面」的一环：模型目录在这里，执行实现在
 * images-api-registry.ts（按 api 注册的全局表），images.ts 的 generateImages()
 * 组合两者完成生成。新版见 images-models.ts 的 ImagesProvider / ImagesModels
 * （显式集合、自带 auth 解析、无全局状态），是迁移方向；新代码优先使用后者。
 */
import { IMAGE_MODELS } from "./image-models.generated.ts";
import type { ImagesApi, ImagesModel, KnownImagesProvider } from "./types.ts";

// 全局注册表：provider id -> (模型 id -> 模型定义)。
// 模块加载时一次性建好、此后只读，因此所有查询都是同步的，
// 查不到只返回 undefined / 空数组，不会抛错。
const imageModelRegistry: Map<string, Map<string, ImagesModel<ImagesApi>>> = new Map();

// 把生成文件里的普通对象目录转成 Map，换取按 id 的 O(1) 查询。
// 生成目录类型较宽，这里统一 cast 成 ImagesModel<ImagesApi>，
// 返回类型的精确化交给下面的 ImageModelApi 类型工具在编译期完成。
for (const [provider, models] of Object.entries(IMAGE_MODELS)) {
	const providerModels = new Map<string, ImagesModel<ImagesApi>>();
	for (const [id, model] of Object.entries(models)) {
		providerModels.set(id, model as ImagesModel<ImagesApi>);
	}
	imageModelRegistry.set(provider, providerModels);
}

/**
 * 从生成目录中提取「某 provider 下某模型声明的 api」类型。
 *
 * Why：IMAGE_MODELS 是宽泛的生成对象，每个模型的 api 字面量类型埋在对象
 * 类型深处；这里用条件类型 + infer 把它挖出来，让 getImageModel() 的返回值
 * 精确到 ImagesModel<该模型的真实 api>，而不是笼统的 ImagesModel<ImagesApi>。
 * 提取失败（模型无 api 字段或不是合法 ImagesApi）时折叠为 never，
 * 把「模型声明不合法」的问题提前暴露到编译期。
 *
 * @template TProvider - provider 标识（须是 KnownImagesProvider 中的一员）
 * @template TModelId  - 该 provider 下的模型 id 字面量类型
 */
type ImageModelApi<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
> = (typeof IMAGE_MODELS)[TProvider][TModelId] extends { api: infer TApi }
	? TApi extends ImagesApi
		? TApi
		: never
	: never;

/**
 * 按 provider 与模型 id 同步查询单个图像模型（旧全局目录读取）。
 *
 * 运行时只是查 Map，命中与否与类型无关：未命中时返回 undefined
 * （类型层面不体现，调用方需自行判空）。
 * 新轨等价物：ImagesModels.getModel()（images-models.ts）。
 *
 * @param provider - provider 标识，如 "openrouter"
 * @param modelId  - 模型 id
 * @returns api 类型已收窄的模型定义；目录中不存在时为 undefined
 */
export function getImageModel<
	TProvider extends KnownImagesProvider,
	TModelId extends keyof (typeof IMAGE_MODELS)[TProvider],
>(provider: TProvider, modelId: TModelId): ImagesModel<ImageModelApi<TProvider, TModelId>> {
	const providerModels = imageModelRegistry.get(provider);
	return providerModels?.get(modelId as string) as ImagesModel<ImageModelApi<TProvider, TModelId>>;
}

/**
 * 列出旧全局目录里的全部图像 provider 标识。
 *
 * @returns provider id 数组（保持目录键顺序）
 */
export function getImageProviders(): KnownImagesProvider[] {
	return Array.from(imageModelRegistry.keys()) as KnownImagesProvider[];
}

/**
 * 列出某 provider 下的全部图像模型（旧全局目录读取）。
 *
 * @param provider - provider 标识
 * @returns 模型定义数组；provider 不存在时为空数组
 */
export function getImageModels<TProvider extends KnownImagesProvider>(
	provider: TProvider,
): ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[] {
	const models = imageModelRegistry.get(provider);
	return models
		? (Array.from(models.values()) as ImagesModel<ImageModelApi<TProvider, keyof (typeof IMAGE_MODELS)[TProvider]>>[])
		: [];
}
