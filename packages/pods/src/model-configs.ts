/**
 * @file model-configs.ts
 * @description 预置模型配置库 —— models.json 加载与按 GPU 条件匹配最佳 vLLM 启动配置
 * @module pi-pods
 *
 * 主要功能：
 * - 加载同目录的 models.json 预置模型库（Qwen2.5/Qwen3-Coder 系列、GPT-OSS、GLM-4.5、Kimi-K2 等）
 * - getModelConfig() 按 GPU 数量与型号为指定模型匹配最佳 vLLM 启动配置
 *   （args 中含 --tool-call-parser hermes/qwen3_coder/glm4_moe、--enable-auto-tool-choice 等 agent 工具调用关键参数）
 * - 提供模型查询辅助函数：isKnownModel / getKnownModels / getModelName
 */

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { GPU } from "./types.js";

// ESM 环境下没有 CJS 的 __filename/__dirname 全局变量，这里通过 import.meta.url 手动还原
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 单条模型启动配置 —— 描述在特定 GPU 条件（数量 + 型号）下以何种参数启动 vLLM
 */
interface ModelConfig {
	/** 该配置所需的 GPU 数量（决定张量并行度与显存预算） */
	gpuCount: number;
	/** 适用的 GPU 型号列表（如 ["H100", "H200"]）；省略表示不限型号 */
	gpuTypes?: string[];
	/** vLLM 启动参数（含 --tool-call-parser、--enable-auto-tool-choice 等 agent 工具调用关键参数） */
	args: string[];
	/** 需额外注入的环境变量（如 VLLM_USE_DEEP_GEMM） */
	env?: Record<string, string>;
	/** 该配置的适用场景说明（如显存占用、吞吐特点） */
	notes?: string;
}

/**
 * 单个模型的完整信息 —— 同一模型按 GPU 规模提供多套配置：
 * 单卡配置省资源、多卡配置提吞吐/支持更长上下文，故 configs 以 gpuCount 区分多种取值
 */
interface ModelInfo {
	/** 模型展示名（如 "Qwen3-Coder-30B"） */
	name: string;
	/** 按 GPU 条件区分的多套启动配置 */
	configs: ModelConfig[];
	/** 模型级通用说明（配置级 notes 缺省时作为兜底） */
	notes?: string;
}

/**
 * models.json 的顶层结构：以模型 ID（如 "Qwen/Qwen3-Coder-30B-A3B-Instruct"）为键的模型表
 */
interface ModelsData {
	models: Record<string, ModelInfo>;
}

// 模块加载时即读取 models.json —— 相对本文件路径解析（而非进程 cwd），保证在任意工作目录下都能定位到配置文件
const modelsJsonPath = join(__dirname, "models.json");
const modelsData: ModelsData = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));

/**
 * 根据可用 GPU 条件获取指定模型的最佳启动配置
 *
 * 匹配策略（按优先级）：
 * 1. 优先取 GPU 数量一致且型号兼容的配置；
 * 2. 未命中则兜底取仅 GPU 数量一致、忽略型号的配置；
 * 3. 仍未命中（或模型未知）返回 null，由调用方决定回退行为。
 */
export const getModelConfig = (
	modelId: string,
	gpus: GPU[],
	requestedGpuCount: number,
): { args: string[]; env?: Record<string, string>; notes?: string } | null => {
	const modelInfo = modelsData.models[modelId];
	if (!modelInfo) {
		// 边界情况：未知模型，没有默认配置可用
		return null;
	}

	// 从第一块 GPU 的名称中提取型号简称（例如 "NVIDIA H200" -> "H200"），供后续型号匹配使用
	const gpuType = gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

	// 第一轮：查找最佳匹配配置（GPU 数量 + 型号双条件）
	let bestConfig: ModelConfig | null = null;

	for (const config of modelInfo.configs) {
		// 条件一：GPU 数量必须与请求值一致，否则跳过
		if (config.gpuCount !== requestedGpuCount) {
			continue;
		}

		// 条件二：若配置声明了 gpuTypes，则要求 GPU 型号兼容；
		// 采用双向 includes 匹配（gpuType 包含 type，或 type 包含 gpuType），以兼容 "H200" 与 "H200NVL" 之类的命名差异
		if (config.gpuTypes && config.gpuTypes.length > 0) {
			const typeMatches = config.gpuTypes.some((type) => gpuType.includes(type) || type.includes(gpuType));
			if (!typeMatches) {
				continue;
			}
		}

		// 两个条件均满足：命中该配置（configs 中首个匹配者胜出）
		bestConfig = config;
		break;
	}

	// 第二轮兜底：无精确匹配时退而求其次——只要 GPU 数量一致即可（忽略型号限制）
	if (!bestConfig) {
		for (const config of modelInfo.configs) {
			if (config.gpuCount === requestedGpuCount) {
				bestConfig = config;
				break;
			}
		}
	}

	if (!bestConfig) {
		// 边界情况：没有任何适配当前 GPU 条件的配置
		return null;
	}

	// 浅拷贝后返回，避免调用方修改 args/env 污染内存中的预置配置数据；
	// notes 优先取配置级说明，缺省时回退到模型级说明
	return {
		args: [...bestConfig.args],
		env: bestConfig.env ? { ...bestConfig.env } : undefined,
		notes: bestConfig.notes || modelInfo.notes,
	};
};

/**
 * 判断指定模型是否在预置模型库中（未知模型没有默认 vLLM 启动配置）
 */
export const isKnownModel = (modelId: string): boolean => {
	return modelId in modelsData.models;
};

/**
 * 获取预置模型库中所有已知模型的 ID 列表
 */
export const getKnownModels = (): string[] => {
	return Object.keys(modelsData.models);
};

/**
 * 获取模型展示名；未知模型则原样返回 modelId 作为兜底
 */
export const getModelName = (modelId: string): string => {
	return modelsData.models[modelId]?.name || modelId;
};
