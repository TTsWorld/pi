import type { ThinkingLevel, ThinkingLevelMap } from "../src/types.ts";

/**
 * @file models.dev reasoning_options 元数据 → Pi 思维等级映射的共享工具。
 *
 * models.dev 为每个模型维护"已验证的推理选项"(reasoning_options),
 * 有开关(toggle)、强度档位(effort)、token 预算(budget_tokens)三种形态。
 * 本模块把其中的 effort 档位转换成 Pi 统一的 ThinkingLevelMap:
 * - generate-models.ts 生成各厂商模型数据时直接调用;
 * - openrouter-reasoning-options.ts 因词表相同也复用这里的转换。
 * 仅被构建脚本引用,不进入运行时产物。
 */

/**
 * models.dev 记录的单个"已验证推理选项",共三种形态:
 * - toggle:推理只能整体开/关;
 * - effort:支持一组推理强度档位,取值与 Pi 的 ThinkingLevel 同词表,
 *   另含 "default" 与 null 这两个无法映射到 Pi 等级的特殊值;
 * - budget_tokens:用 token 预算区间控制推理力度。
 */
export type ModelsDevReasoningOption =
	| { type: "toggle" }
	| {
			type: "effort";
			values: Array<"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default" | null>;
	  }
	| { type: "budget_tokens"; min?: number; max?: number };

/** Pi 的全部思维等级(minimal → max),同时充当映射结果的遍历顺序 */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 把 models.dev 已验证的 effort 档位转换成 Pi 可选的思维等级映射。
 * 没有 Pi 对应档位的值("default" 和 JSON null)会被有意忽略;
 * 当档位里既不含任何 Pi 等级、也不含 "none" 时返回 undefined
 * (表示该模型的 effort 数据无法映射成 Pi 能力,而非生成全 null 的空映射)。
 */
export function getEffortThinkingLevelMap(options: readonly ModelsDevReasoningOption[]): ThinkingLevelMap | undefined {
	// 只挑出 effort 型选项,汇总全部档位值(toggle / budget_tokens 不参与映射)
	const effortValues = options.flatMap((option) => (option.type === "effort" ? option.values : []));
	if (effortValues.length === 0) return undefined;

	const supported = new Set(effortValues);
	// 档位里若没有任何一个 Pi 等级、也没有 "none",说明全是无法映射的值,直接放弃
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return undefined;

	// "off" 的映射:模型声明支持 "none" 档才能映射为 "none"(可显式关到最低),否则 null(不支持关闭)
	const map: ThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	for (const level of THINKING_LEVELS) {
		// 出现在已验证档位里的等级原样透传(models.dev 与 Pi 同词表),未出现的记为 null(不支持)
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}
