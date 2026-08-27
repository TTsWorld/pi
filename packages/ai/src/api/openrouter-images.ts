/**
 * @file OpenRouter 图像生成 API 实现
 * @description OpenRouter 用「chat completions + modalities: ["image"]」承载图像生成：
 *              把 ImagesContext 的文本/图片输入拼成 chat 消息、声明 image 输出模态，
 *              再从响应的 message.images（data: URL）解出图像块。复用 OpenAI SDK
 *              发请求，错误归一化为「永不 reject」的 AssistantImages 结果。
 *
 * 依赖关系：
 * - openai SDK（chat.completions 通道）
 * - ../utils/error-body.ts（错误归一化）、provider-retry.ts（可中断重试）、
 *   sanitize-unicode.ts（清代理项）、headers.ts（头转换）
 */

import OpenAI from "openai";
import type {
	ChatCompletion,
	ChatCompletionContentPart,
	ChatCompletionContentPartImage,
	ChatCompletionContentPartText,
	ChatCompletionCreateParamsNonStreaming,
} from "openai/resources/chat/completions.js";
import type {
	AssistantImages,
	ImageContent,
	ImagesContext,
	ImagesFunction,
	ImagesModel,
	ImagesOptions,
	ProviderHeaders,
	TextContent,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

/** OpenRouter 在 message 上扩展的图像字段（官方类型未收录） */
interface OpenRouterGeneratedImage {
	image_url?: string | { url?: string };
}

/** OpenRouter 图像生成的 message 形态（chat message + images 扩展） */
type OpenRouterImageGenerationMessage = ChatCompletion["choices"][number]["message"] & {
	images?: OpenRouterGeneratedImage[];
};

type OpenRouterImageGenerationChoice = ChatCompletion["choices"][number] & {
	message: OpenRouterImageGenerationMessage;
};

type OpenRouterImageGenerationResponse = ChatCompletion & {
	choices: OpenRouterImageGenerationChoice[];
};

/**
 * 执行一次 OpenRouter 图像生成：构建参数（可被 onPayload 拦截改写）→
 * 经可中断重试发出请求 → 解析文本与 data: URL 图像 → 按模型单价计算成本。
 * 任何失败都归一化到返回值上（stopReason: "error"/"aborted"），绝不 reject。
 */
export const generateImages: ImagesFunction<"openrouter-images", ImagesOptions> = async (
	model: ImagesModel<"openrouter-images">,
	context: ImagesContext,
	options?: ImagesOptions,
) => {
	// 预构建成功形态的结果对象；失败路径复用它改 stopReason/errorMessage
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};

	try {
		const apiKey = options?.apiKey;
		if (!apiKey) {
			throw new Error(`No API key for provider: ${model.provider}`);
		}
		const client = createClient(model, apiKey, options?.headers, options?.fetch);
		let params = buildParams(model, context);
		// onPayload 钩子：调用方可在发请求前查看/改写载荷（调试、审计）
		const nextParams = await options?.onPayload?.(params, model);
		if (nextParams !== undefined) {
			params = nextParams as typeof params;
		}
		const requestOptions = {
			...(options?.signal ? { signal: options.signal } : {}),
			...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
			// SDK 内建重试关闭：退避统一交给 retryProviderRequest（可被 abort 中断）
			maxRetries: 0,
		};
		const { data: response, response: rawResponse } = await retryProviderRequest(
			() =>
				client.chat.completions
					.create(params as unknown as ChatCompletionCreateParamsNonStreaming, requestOptions)
					.withResponse(),
			{
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			},
		);
		await options?.onResponse?.({ status: rawResponse.status, headers: headersToRecord(rawResponse.headers) }, model);

		const imageResponse = response as OpenRouterImageGenerationResponse;
		output.responseId = imageResponse.id;
		if (imageResponse.usage) {
			output.usage = parseUsage(imageResponse.usage, model);
		}

		// 解析首个 choice：文本内容进 text 块，images 扩展里的 data: URL 解出图像块
		const choice = imageResponse.choices[0];
		if (choice) {
			const content = choice.message.content;
			if (typeof content === "string" && content.length > 0) {
				output.output.push({ type: "text", text: content } satisfies TextContent);
			}

			for (const image of choice.message.images ?? []) {
				const imageUrl = typeof image.image_url === "string" ? image.image_url : image.image_url?.url;
				// 只接受内联的 data: URL（外链无法保证可取回，跳过）
				if (!imageUrl?.startsWith("data:")) continue;
				const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
				if (!matches) continue;
				output.output.push({
					type: "image",
					mimeType: matches[1],
					data: matches[2],
				} satisfies ImageContent);
			}
		}

		return output;
	} catch (error) {
		// 失败归一化：abort 优先判定，其余错误经 SDK 字段探测拼出可读信息
		output.stopReason = options?.signal?.aborted ? "aborted" : "error";
		output.errorMessage = formatProviderError(normalizeProviderError(error));
		return output;
	}
};

/** 创建 OpenAI SDK 客户端：指向 OpenRouter baseUrl，合并模型与调用方 headers；允许浏览器环境（自担风险） */
function createClient(
	model: ImagesModel<"openrouter-images">,
	apiKey: string,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
): OpenAI {
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders: providerHeadersToRecord({ ...model.headers, ...optionsHeaders }),
	});
}

/** 参数类型：官方类型的 modalities 收窄为 image/text */
type OpenRouterImagesCreateParams = Omit<ChatCompletionCreateParamsNonStreaming, "modalities"> & {
	modalities: Array<"image" | "text">;
};

/** 把 ImagesContext 拼成单条 user 消息：文本清洗代理项、图片转 data: URL 内容块 */
function buildParams(model: ImagesModel<"openrouter-images">, context: ImagesContext): OpenRouterImagesCreateParams {
	const content: ChatCompletionContentPart[] = context.input.map((item): ChatCompletionContentPart => {
		if (item.type === "text") {
			return {
				type: "text",
				// 清掉未配对代理项，避免服务端 JSON 序列化报错
				text: sanitizeSurrogates(item.text),
			} satisfies ChatCompletionContentPartText;
		}
		return {
			type: "image_url",
			image_url: {
				url: `data:${item.mimeType};base64,${item.data}`,
			},
		} satisfies ChatCompletionContentPartImage;
	});

	return {
		model: model.id,
		messages: [
			{
				role: "user" as const,
				content,
			},
		],
		stream: false,
		// 声明输出模态：模型支持文本时同时要 text（附带上模型的说明文字）
		modalities: model.output.includes("text") ? ["image", "text"] : ["image"],
	};
}

/**
 * 解析 usage 并按模型单价计费（单价为每百万 token 美元）。
 * OpenRouter 的 cached_tokens 同时含「读命中」与「本轮写入」，需要用
 * cache_write_tokens 剥离出真正的读命中，input 再扣除两部分缓存 token。
 */
function parseUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
	},
	model: ImagesModel<"openrouter-images">,
) {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const reportedCachedTokens = rawUsage.prompt_tokens_details?.cached_tokens || 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	// 有写入时读命中 = 上报缓存数 − 写入数（不为负）
	const cacheReadTokens =
		cacheWriteTokens > 0 ? Math.max(0, reportedCachedTokens - cacheWriteTokens) : reportedCachedTokens;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const output = rawUsage.completion_tokens || 0;
	const usage = {
		input,
		output,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		totalTokens: input + output + cacheReadTokens + cacheWriteTokens,
		cost: {
			input: (model.cost.input / 1000000) * input,
			output: (model.cost.output / 1000000) * output,
			cacheRead: (model.cost.cacheRead / 1000000) * cacheReadTokens,
			cacheWrite: (model.cost.cacheWrite / 1000000) * cacheWriteTokens,
			total: 0,
		},
	};
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage;
}
