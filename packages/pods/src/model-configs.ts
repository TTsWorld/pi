/**
 * @file 模型预置配置表与配置匹配逻辑
 * @description pi monorepo pods 包的模型启动配置模块：
 *  - 启动时从同目录的 models.json 加载各模型的预置 vLLM 启动配置（GPU 数量、GPU 型号、启动参数、环境变量等）；
 *  - `getModelConfig` 根据用户请求的 GPU 数量与实际 GPU 型号，为指定模型匹配出最优的 vLLM 启动配置；
 *  - 同时导出模型查询辅助函数（是否已知模型、已知模型列表、模型展示名）。
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { GPU } from "./types.js";

// ESM 环境下没有 CommonJS 的 __filename/__dirname，这里通过 import.meta.url 手动等价实现
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** 单条模型启动配置：描述在特定 GPU 数量/型号下应使用的 vLLM 启动参数 */
interface ModelConfig {
	/** 该配置要求的 GPU 数量（精确匹配） */
	gpuCount: number;
	/** 可选：适用的 GPU 型号列表（如 ["H100", "H200"]），不填表示不限型号 */
	gpuTypes?: string[];
	/** vLLM 启动命令行参数 */
	args: string[];
	/** 需要额外注入的环境变量 */
	env?: Record<string, string>;
	/** 该配置的备注说明 */
	notes?: string;
}

/** 单个模型的完整信息：展示名 + 多条候选启动配置 */
interface ModelInfo {
	/** 模型展示名 */
	name: string;
	/** 该模型的候选配置列表，按优先级排列（越靠前越优先） */
	configs: ModelConfig[];
	/** 模型级别的通用备注（配置自身无备注时兜底使用） */
	notes?: string;
}

/** models.json 的顶层结构：modelId -> 模型信息 的映射 */
interface ModelsData {
	models: Record<string, ModelInfo>;
}

// 加载模型配置 —— 路径相对于本文件解析，保证无论从哪个 cwd 启动都能找到 models.json
const modelsJsonPath = join(__dirname, "models.json");
const modelsData: ModelsData = JSON.parse(readFileSync(modelsJsonPath, "utf-8"));

/**
 * 根据可用 GPU 为模型获取最优启动配置
 *
 * 选型策略（Why）：
 * 1. 优先精确匹配 —— GPU 数量完全相等，且（若配置声明了 gpuTypes）GPU 型号双向模糊匹配；
 * 2. 若无精确匹配，退化为只按 GPU 数量匹配，忽略型号限制，保证尽量给出可用配置；
 * 3. 仍找不到则返回 null，由调用方决定如何降级（如用默认参数启动）。
 */
export const getModelConfig = (
	modelId: string,
	gpus: GPU[],
	requestedGpuCount: number,
): { args: string[]; env?: Record<string, string>; notes?: string } | null => {
	const modelInfo = modelsData.models[modelId];
	if (!modelInfo) {
		// 未知模型，没有预置配置可用
		return null;
	}

	// ========== 提取 GPU 型号 ==========
	// 从第一块 GPU 的名称中解析出型号（如 "NVIDIA H200" -> "H200"），
	// 供后续与配置声明的 gpuTypes 做模糊匹配
	const gpuType = gpus[0]?.name?.replace("NVIDIA", "")?.trim()?.split(" ")[0] || "";

	// ========== 第一轮：精确匹配（GPU 数量 + 型号） ==========
	// 遍历候选配置（按 models.json 中的排列顺序即优先级），
	// GPU 数量必须完全相等；若配置声明了 gpuTypes，则型号需双向包含匹配
	// （"H200" 与 "H200 SXM" 互为包含即可命中），找到即取第一个命中项
	let bestConfig: ModelConfig | null = null;

	for (const config of modelInfo.configs) {
		// 检查 GPU 数量是否一致
		if (config.gpuCount !== requestedGpuCount) {
			continue;
		}

		// 若配置指定了 GPU 型号，则检查型号是否匹配
		if (config.gpuTypes && config.gpuTypes.length > 0) {
			const typeMatches = config.gpuTypes.some((type) => gpuType.includes(type) || type.includes(gpuType));
			if (!typeMatches) {
				continue;
			}
		}

		// 该配置匹配成功
		bestConfig = config;
		break;
	}

	// ========== 第二轮：降级匹配（仅按 GPU 数量） ==========
	// 无精确匹配时，放宽型号限制，只按 GPU 数量找一条可用配置，
	// 避免"型号没覆盖到"就完全无法启动
	if (!bestConfig) {
		for (const config of modelInfo.configs) {
			if (config.gpuCount === requestedGpuCount) {
				bestConfig = config;
				break;
			}
		}
	}

	if (!bestConfig) {
		// 未找到合适的配置
		return null;
	}

	// ========== 返回结果（浅拷贝，防止调用方修改污染预置配置表） ==========
	return {
		args: [...bestConfig.args],
		env: bestConfig.env ? { ...bestConfig.env } : undefined,
		notes: bestConfig.notes || modelInfo.notes,
	};
};

/**
 * 检查模型是否在预置配置表中（即是否为已知模型）
 */
export const isKnownModel = (modelId: string): boolean => {
	return modelId in modelsData.models;
};

/**
 * 获取所有已知模型的 modelId 列表
 */
export const getKnownModels = (): string[] => {
	return Object.keys(modelsData.models);
};

/**
 * 获取模型展示名；未知模型则原样返回 modelId
 */
export const getModelName = (modelId: string): string => {
	return modelsData.models[modelId]?.name || modelId;
};
