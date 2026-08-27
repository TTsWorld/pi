import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";
import { getEffortThinkingLevelMap } from "./models-dev-reasoning-options.ts";

/**
 * @file OpenRouter reasoning 元数据 → Pi 思维等级映射。
 *
 * OpenRouter 在模型元数据里标注了推理能力:是否强制开启(mandatory)、
 * 默认是否开启(default_enabled)、支持哪些 effort 档位等。
 * 本模块把这些元数据转换成 Pi 统一的 ThinkingLevelMap,
 * 供 generate-models.ts 生成 OpenRouter 模型数据时使用。
 * 由于 supported_efforts 与 models.dev 的 reasoning_options 词表一致,
 * 档位转换直接复用 models-dev-reasoning-options.ts。
 */

/** OpenRouter 模型元数据中的 reasoning 字段结构(字段均可缺省) */
export interface OpenRouterReasoningMetadata {
	mandatory?: boolean;
	default_enabled?: boolean;
	supported_efforts?: Array<ThinkingLevel | "none">;
	default_effort?: ThinkingLevel | "none";
}

/** 把 OpenRouter 的 reasoning 元数据转换成 Pi 的模型能力(thinkingLevelMap)。 */
export function getOpenRouterThinkingLevelMap(
	reasoning: OpenRouterReasoningMetadata | undefined,
): ThinkingLevelMap | undefined {
	// 完全没有 reasoning 元数据:视为不支持可控推理
	if (!reasoning) return undefined;
	// 未声明 effort 档位时只剩 mandatory 一个信息可表达:
	// 强制推理的模型映射为 { off: null }(无法关闭),否则视为不支持
	if (!reasoning.supported_efforts?.length) return reasoning.mandatory === true ? { off: null } : undefined;

	// OpenRouter 的 supported_efforts 与 models.dev 的 reasoning_options 使用同一套 effort 取值,
	// 因此两个数据源可以共用同一个 Pi 思维等级转换。
	const map = getEffortThinkingLevelMap([{ type: "effort", values: reasoning.supported_efforts }]);
	// 档位转换失败(无法映射成 Pi 等级)时,仍保留 mandatory 信息:强制推理模型记为不可关闭
	if (!map) return reasoning.mandatory === true ? { off: null } : undefined;
	// 覆盖 off 的取值:强制推理的模型不能关(null),其余模型可以显式关到 "none"
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}
