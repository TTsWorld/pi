#!/usr/bin/env node
/**
 * @file 图像模型目录生成脚本:拉取 OpenRouter 图像模型并生成代码目录。
 *
 * 构建期代码生成流水线的一员(generate-models.ts 管文本模型,本脚本管图像模型):
 * 从 OpenRouter /models 接口筛出支持图像输出的模型,归一化成 Pi 的
 * ImagesModel 结构,生成 src/image-models.generated.ts(导出 IMAGE_MODELS 常量,
 * 文件头标注 auto-generated,不要手改)。
 *
 * 运行方式:node scripts/generate-image-models.ts --strict
 * (或 npm run generate-image-models,默认带 --strict,失败直接报错退出;
 * 不带 --strict 时拉取失败仅返回空列表,生成空目录文件。)
 */

import { writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ImagesModel } from "../src/types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");
// OpenRouter API 基地址,既用于拼拉取接口,也作为生成模型的 baseUrl 写入目录
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * 解析命令行参数,返回是否启用 --strict(严格模式)。
 * 出现任何未知参数直接抛错,避免拼写错误被静默忽略。
 */
function readStrictOption(args: string[]): boolean {
	for (const arg of args) {
		if (arg !== "--strict") throw new Error(`Unknown argument: ${arg}`);
	}
	return args.includes("--strict");
}

/** OpenRouter /models 接口返回的单条模型记录(只声明本脚本用到的字段) */
interface OpenRouterModelRecord {
	id: string;
	name: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

/**
 * 把 OpenRouter /models 的响应载荷解析为 Pi 的图像模型列表。
 * 独立导出为纯函数,便于 test/image-model-data.test.ts 用样例数据直接测试。
 * strict 为 true 时,载荷缺失/为空、或过滤后一个可用模型都没有都会抛错
 * (防止上游数据异常时静默生成空目录);非 strict 则返回空数组。
 */
export function parseOpenRouterImageModels(
	payload: unknown,
	strict: boolean,
): ImagesModel<"openrouter-images">[] {
	const data =
		typeof payload === "object" && payload !== null
			? (payload as { data?: OpenRouterModelRecord[] }).data
			: undefined;
	if (!Array.isArray(data) || data.length === 0) {
		if (strict) throw new Error("OpenRouter API returned a missing or empty image model list");
		return [];
	}

	const models: ImagesModel<"openrouter-images">[] = [];
	for (const model of data) {
		// 数据清洗:输入模态只保留 Pi 认识的 "text" | "image",并用 Set 去重
		const input = Array.from(
			new Set(
				(model.architecture?.input_modalities ?? []).filter(
					(modality): modality is "text" | "image" => modality === "text" || modality === "image",
				),
			),
		);
		// 输出模态做同样的清洗(只要 "text"/"image",去重)
		const output = Array.from(
			new Set(
				(model.architecture?.output_modalities ?? []).filter(
					(modality): modality is "text" | "image" => modality === "text" || modality === "image",
				),
			),
		);

		// 只要能输出图像的模型(这是进入"图像模型目录"的入选标准)
		if (!output.includes("image")) continue;
		// 上游漏标输入模态时兜底为纯文本输入(图像模型至少要能接收文本提示词)
		if (input.length === 0) input.push("text");

		models.push({
			id: model.id,
			name: model.name,
			api: "openrouter-images",
			provider: "openrouter",
			baseUrl: OPENROUTER_BASE_URL,
			input,
			output,
			cost: {
				// OpenRouter 定价是"每 token 美元"的字符串,Pi 的 cost 口径是"每百万 token",
				// 这里乘 1e6 换算;字段缺失时按 0 处理
				input: parseFloat(model.pricing?.prompt || "0") * 1_000_000,
				output: parseFloat(model.pricing?.completion || "0") * 1_000_000,
				cacheRead: parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
				cacheWrite: parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
			},
		});
	}

	if (strict && models.length === 0) {
		throw new Error("OpenRouter API returned no usable image models");
	}
	return models;
}

/**
 * 请求 OpenRouter /models(服务端已按 output_modalities=image 预过滤)并解析。
 * strict 模式下网络失败/非 2xx 会向上抛错终止流水线;
 * 非 strict 只打印错误并返回空列表,让脚本继续生成一份空目录。
 */
async function fetchOpenRouterImageModels(strict: boolean): Promise<ImagesModel<"openrouter-images">[]> {
	try {
		console.log("Fetching image models from OpenRouter API...");
		const response = await fetch(`${OPENROUTER_BASE_URL}/models?output_modalities=image`);
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		const models = parseOpenRouterImageModels(await response.json(), strict);
		console.log(`Fetched ${models.length} image models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter image models:", error);
		if (strict) throw error;
		return [];
	}
}

/**
 * 把模型列表序列化为 src/image-models.generated.ts 的文件内容。
 * 手工拼对象字面量而非整体 JSON.stringify,是为了让每个模型都带上
 * `satisfies ImagesModel<...>` 局部类型校验;cost 用 JSON.stringify
 * 缩进后再整体补一个 Tab,保证生成文件缩进统一、diff 友好。
 */
function generateImageModelsFile(models: ImagesModel<"openrouter-images">[]): string {
	// 目录结构:provider → (modelId → 序列化后的模型字面量);目前只有 openrouter 一个 provider
	const imageModelsByProvider = {
		openrouter: Object.fromEntries(
			models
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => [
					model.id,
					`{
			id: ${JSON.stringify(model.id)},
			name: ${JSON.stringify(model.name)},
			api: ${JSON.stringify(model.api)},
			provider: ${JSON.stringify(model.provider)},
			baseUrl: ${JSON.stringify(model.baseUrl)},
			input: ${JSON.stringify(model.input)},
			output: ${JSON.stringify(model.output)},
			cost: ${JSON.stringify(model.cost, null, 2).replace(/^/gm, "\t")}
		} satisfies ImagesModel<${JSON.stringify(model.api)}>`,
				]),
		),
	};

	// 逐层拼出带 Tab 缩进的嵌套字面量(外层 provider 条目、内层模型条目)
	const providerEntries = Object.entries(imageModelsByProvider)
		.map(([provider, providerModels]) => {
			const modelEntries = Object.entries(providerModels)
				.map(([id, serialized]) => `\t\t${JSON.stringify(id)}: ${serialized},`)
				.join("\n");
			return `\t${JSON.stringify(provider)}: {\n${modelEntries}\n\t},`;
		})
		.join("\n");

	// 生成文件的固定头部:声明自动生成、禁止手改,并给出更新命令
	return `// This file is auto-generated by scripts/generate-image-models.ts
// Do not edit manually - run 'npm run generate-image-models' to update

import type { ImagesApi, ImagesModel } from "./types.ts";

export const IMAGE_MODELS = {
${providerEntries}
} as const satisfies Record<string, Record<string, ImagesModel<ImagesApi>>>;
`;
}

/** 主流程:解析参数 → 拉取图像模型 → 序列化并写出 src/image-models.generated.ts。 */
async function main(): Promise<void> {
	const strict = readStrictOption(process.argv.slice(2));
	const models = await fetchOpenRouterImageModels(strict);
	const output = generateImageModelsFile(models);
	const outputPath = join(packageRoot, "src", "image-models.generated.ts");
	writeFileSync(outputPath, output, "utf-8");
	console.log(`Generated ${outputPath}`);
}

// 仅当作为脚本直接执行时运行 main;被测试等模块 import 时跳过(避免误写文件)
if (process.argv[1] && resolve(process.argv[1]) === __filename) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
