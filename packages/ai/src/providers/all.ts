/**
 * @file 内置 provider 聚合入口
 * @description 汇总 packages/ai 内置的全部模型 provider 与图像生成 provider。
 * 从生成的模型目录（models.generated.ts）派生静态类型，提供按字面量
 * provider/modelId 的类型化读取函数（getBuiltinModel / getBuiltinModels），
 * 以及一次性构造/注册全部内置 provider 的工厂函数
 * （builtinProviders / builtinModels 及其图像版本）。
 */
import { createImagesModels, type ImagesProvider, type MutableImagesModels } from "../images-models.ts";
import { MODELS } from "../models.generated.ts";
import { type CreateModelsOptions, createModels, type MutableModels, type Provider } from "../models.ts";
import type { Api, Model } from "../types.ts";
import { amazonBedrockProvider } from "./amazon-bedrock.ts";
import { antLingProvider } from "./ant-ling.ts";
import { anthropicProvider } from "./anthropic.ts";
import { azureOpenAIResponsesProvider } from "./azure-openai-responses.ts";
import { basetenProvider } from "./baseten.ts";
import { cerebrasProvider } from "./cerebras.ts";
import { cloudflareAIGatewayProvider } from "./cloudflare-ai-gateway.ts";
import { cloudflareWorkersAIProvider } from "./cloudflare-workers-ai.ts";
import modelDataManifest from "./data/.manifest.json" with { type: "json" };
import { deepseekProvider } from "./deepseek.ts";
import { fireworksProvider } from "./fireworks.ts";
import { githubCopilotProvider } from "./github-copilot.ts";
import { googleProvider } from "./google.ts";
import { googleVertexProvider } from "./google-vertex.ts";
import { groqProvider } from "./groq.ts";
import { huggingfaceProvider } from "./huggingface.ts";
import { kimiCodingProvider } from "./kimi-coding.ts";
import { minimaxProvider } from "./minimax.ts";
import { minimaxCnProvider } from "./minimax-cn.ts";
import { mistralProvider } from "./mistral.ts";
import { moonshotaiProvider } from "./moonshotai.ts";
import { moonshotaiCnProvider } from "./moonshotai-cn.ts";
import { nvidiaProvider } from "./nvidia.ts";
import { openaiProvider } from "./openai.ts";
import { openaiCodexProvider } from "./openai-codex.ts";
import { opencodeProvider } from "./opencode.ts";
import { opencodeGoProvider } from "./opencode-go.ts";
import { openrouterProvider } from "./openrouter.ts";
import { openrouterImagesProvider } from "./openrouter-images.ts";
import { qwenTokenPlanProvider } from "./qwen-token-plan.ts";
import { qwenTokenPlanCnProvider } from "./qwen-token-plan-cn.ts";
import { qwenTokenPlanIndividualProvider } from "./qwen-token-plan-individual.ts";
import { radiusProvider } from "./radius.ts";
import { togetherProvider } from "./together.ts";
import { vercelAIGatewayProvider } from "./vercel-ai-gateway.ts";
import { xaiProvider } from "./xai.ts";
import { xiaomiProvider } from "./xiaomi.ts";
import { xiaomiTokenPlanAmsProvider } from "./xiaomi-token-plan-ams.ts";
import { xiaomiTokenPlanCnProvider } from "./xiaomi-token-plan-cn.ts";
import { xiaomiTokenPlanSgpProvider } from "./xiaomi-token-plan-sgp.ts";
import { zaiProvider } from "./zai.ts";
import { zaiCodingCnProvider } from "./zai-coding-cn.ts";

// 重新导出 radius provider：它是纯动态 provider，没有静态目录条目
export { radiusProvider };

/** 出现在生成目录（models.generated.ts）中的 provider 集合。
 * `KnownProvider` 额外包含没有静态目录条目的纯动态 provider（如 "radius"）。 */
export type BuiltinProvider = keyof typeof MODELS;

/**
 * 从生成目录中提取某个模型条目对应的 API 类型。
 *
 * 类型魔法：通过条件类型推断——若目录条目形如 { api: TApi } 且 TApi 满足
 * Api 约束则返回 TApi，否则退化为 never。借助字面量参数（如
 * getBuiltinModel("openai", "gpt-4o-mini")）即可静态推出精确的 Model<TApi>，
 * 让返回值的 API 类型与目录数据保持同步。
 */
type BuiltinModelApi<
	TProvider extends BuiltinProvider,
	TModelId extends keyof (typeof MODELS)[TProvider],
> = (typeof MODELS)[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

/**
 * 按字面量 provider 与 modelId 读取生成的内置模型目录（类型化读取）。
 *
 * @param provider provider 的字面量 id（如 "openai"）
 * @param modelId 模型的字面量 id（如 "gpt-4o-mini"）
 * @returns 目录中对应的模型定义；provider 或 modelId 不存在时为 undefined
 */
export function getBuiltinModel<TProvider extends BuiltinProvider, TModelId extends keyof (typeof MODELS)[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<BuiltinModelApi<TProvider, TModelId>> {
	// 运行时只是普通的属性查找；精确的返回类型由 BuiltinModelApi 的条件推断
	// 在类型层面保证，因此这里用 as 断言把宽类型收窄回静态推导的结果
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	return models?.[modelId as string] as Model<BuiltinModelApi<TProvider, TModelId>>;
}

/**
 * 列出生成目录中存在的全部内置 provider id。
 *
 * @returns 内置 provider id 的字面量数组
 */
export function getBuiltinProviders(): BuiltinProvider[] {
	return Object.keys(MODELS) as BuiltinProvider[];
}

/**
 * 获取所有内置 provider 目录共享的数据生成时间戳。
 *
 * @returns 生成的 Unix 毫秒时间戳；无法解析时返回 undefined
 */
export function getBuiltinModelDataGeneratedAt(): number | undefined {
	const generatedAt = Date.parse(modelDataManifest.generatedAt);
	// manifest 中的 generatedAt 解析失败（NaN）时返回 undefined，表示未知生成时间
	return Number.isNaN(generatedAt) ? undefined : generatedAt;
}

/**
 * 读取某个内置 provider 在生成目录中的全部模型。
 *
 * @param provider provider 的字面量 id
 * @returns 该 provider 的模型数组；目录中没有该 provider 时返回空数组
 */
export function getBuiltinModels<TProvider extends BuiltinProvider>(
	provider: TProvider,
): Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[] {
	const models = MODELS[provider] as Record<string, Model<Api>> | undefined;
	// 目录中不存在该 provider 时返回空数组，而不是 undefined
	return models
		? (Object.values(models) as Model<BuiltinModelApi<TProvider, keyof (typeof MODELS)[TProvider]>>[])
		: [];
}

/** 构造并返回全部内置模型 provider 的新实例（每次调用都重新构造，无共享状态）。 */
export function builtinProviders(): Provider[] {
	return [
		amazonBedrockProvider(),
		antLingProvider(),
		anthropicProvider(),
		azureOpenAIResponsesProvider(),
		basetenProvider(),
		cerebrasProvider(),
		cloudflareAIGatewayProvider(),
		cloudflareWorkersAIProvider(),
		deepseekProvider(),
		fireworksProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		moonshotaiProvider(),
		moonshotaiCnProvider(),
		nvidiaProvider(),
		openaiProvider(),
		openaiCodexProvider(),
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		qwenTokenPlanProvider(),
		qwenTokenPlanCnProvider(),
		qwenTokenPlanIndividualProvider(),
		radiusProvider(),
		togetherProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		xiaomiProvider(),
		xiaomiTokenPlanAmsProvider(),
		xiaomiTokenPlanCnProvider(),
		xiaomiTokenPlanSgpProvider(),
		zaiProvider(),
		zaiCodingCnProvider(),
	];
}

/**
 * 创建一个注册了全部内置 provider 的 `Models` 集合。
 *
 * @param options 透传给 createModels 的初始化选项
 * @returns 已注册全部内置 provider 的可变 Models 集合
 */
export function builtinModels(options?: CreateModelsOptions): MutableModels {
	const models = createModels(options);
	for (const provider of builtinProviders()) {
		models.setProvider(provider);
	}
	return models;
}

/** 构造并返回全部内置图像生成 provider 的新实例。 */
export function builtinImagesProviders(): ImagesProvider[] {
	return [openrouterImagesProvider()];
}

/**
 * 创建一个注册了全部内置图像生成 provider 的 `ImagesModels` 集合。
 *
 * @param options 透传给 createImagesModels 的初始化选项
 * @returns 已注册全部内置图像 provider 的可变 ImagesModels 集合
 */
export function builtinImagesModels(options?: CreateModelsOptions): MutableImagesModels {
	const models = createImagesModels(options);
	for (const provider of builtinImagesProviders()) {
		models.setProvider(provider);
	}
	return models;
}
