/**
 * @file usage-totals.ts —— token 用量与费用统计
 *
 * @description
 * 提供会话级用量累计（输入/输出/缓存读写 token 与费用），
 * 以及按模型维度汇总费用明细的工具，供会话统计与界面展示使用。
 */
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "./session-manager.ts";

/** 用量累计结构（token 数与费用） */
export interface UsageTotals {
	/** 输入 token */
	input: number;
	/** 输出 token */
	output: number;
	/** 缓存读 token */
	cacheRead: number;
	/** 缓存写 token */
	cacheWrite: number;
	/** 费用合计 */
	cost: number;
}

/** 创建一个全零的用量累计对象 */
export function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
}

/** 把一次 LLM 调用的 usage 累加进 totals（原地修改） */
export function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/** 费用明细条目：按分组 key 汇总的费用与 token 总数 */
export interface UsageCostBreakdownEntry {
	/** 分组键：`provider/model` 或 "Tools/summaries" */
	key: string;
	/** 该分组的费用 */
	cost: number;
	/** 该分组的总 token 数（输入+输出+缓存读写） */
	tokens: number;
}

/**
 * 把可归因的助手用量按模型分组，其余用量（工具结果、分支摘要、压缩）
 * 统一归入单独的 "Tools/summaries" 桶。
 */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
	// 分组 key → 该分组的用量累计
	const totalsByKey = new Map<string, UsageTotals>();

	for (const entry of entries) {
		let key: string | undefined;
		let usage: Usage | undefined;
		// 助手消息：按「provider/实际响应模型」归组（无响应模型时退回请求模型）
		if (entry.type === "message" && entry.message.role === "assistant") {
			key = `${entry.message.provider}/${entry.message.responseModel ?? entry.message.model}`;
			usage = entry.message.usage;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			// 工具结果携带的用量无法归因到具体模型，统一进 Tools/summaries
			key = "Tools/summaries";
			usage = entry.message.usage;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			// 分支摘要 / 上下文压缩产生的用量同样进 Tools/summaries
			key = "Tools/summaries";
			usage = entry.usage;
		}
		if (!key || !usage) continue;

		let totals = totalsByKey.get(key);
		if (!totals) {
			totals = createUsageTotals();
			totalsByKey.set(key, totals);
		}
		addUsageToTotals(totals, usage);
	}

	// 展开为明细条目：剔除零用量分组，再按费用从高到低排序
	return Array.from(totalsByKey, ([key, totals]) => ({
		key,
		cost: totals.cost,
		tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
	}))
		.filter((entry) => entry.cost > 0 || entry.tokens > 0)
		.sort((a, b) => b.cost - a.cost);
}
