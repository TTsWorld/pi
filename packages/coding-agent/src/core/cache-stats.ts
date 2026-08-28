/**
 * @file cache-stats.ts —— 提示词缓存命中率统计
 *
 * @description
 * 分析会话条目中各 assistant 消息的 usage，识别「本应命中缓存却被重新计费」
 * 的 token（浪费），计算浪费总量、单条 miss 明细，并支持对刚完成的消息做
 * 实时 miss 检测。用于向用户解释缓存未命中的原因（空闲超时、模型切换等）。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：AssistantMessage（usage 中的 cacheRead/cacheWrite）；
 * - `./session-manager.ts`：SessionEntry（扫描的会话条目序列）。
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * 提示词缓存的 TTL：空闲间隔超过该值时，值得作为 miss 的可能原因向用户提示。
 * Anthropic 默认缓存 TTL 为 5 分钟（魔法数字 5 * 60 * 1000 的出处）。
 */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** 噪声下限：单轮 miss 不超过该 token 数时属于缓存断点粒度噪声，不计数。 */
const NOISE_FLOOR_TOKENS = 1024;

/** 单条 assistant 消息上被计入的一次缓存 miss。 */
export interface CacheMiss {
	/** 上一轮提示词中已有、但本轮未从缓存读取的 token 数。 */
	missedTokens: number;
	/** 相比完全命中多付的美元数；定价未知时为 0。 */
	missedCost: number;
	/** 距上一次请求（即缓存最后刷新时刻）的毫秒数。 */
	idleMs: number;
	/** 相对上一次请求是否更换了模型。 */
	modelChanged: boolean;
}

/** 整个会话的缓存浪费累计值。 */
export interface CacheWasteTotals {
	/** 累计浪费的 token 数。 */
	missedTokens: number;
	/** 累计多付的美元数。 */
	missedCost: number;
	/** 被计入的 miss 次数（超过噪声下限的轮次）。 */
	missCount: number;
}

/** 最小定价查询接口（ModelRuntime 即满足）；cost 单位为美元/百万 token。 */
export interface ModelPriceSource {
	getModel(provider: string, modelId: string): { cost: { cacheRead: number } } | undefined;
}

/** 扫描过程中看到的上一次请求；其提示词内容理论上应全部命中缓存。 */
interface PreviousRequest {
	/** 上一次请求的提示词总 token 数。 */
	promptTokens: number;
	/** `provider/model` 形式的模型键，用于检测模型切换。 */
	modelKey: string;
	/** 上一次请求的时间戳（毫秒）。 */
	timestamp: number;
	/**
	 * 粘性标记：本扫描片段中更早的某次请求曾上报过缓存活动。
	 * 用于区分「只上报 cacheRead 的供应商（OpenAI 风格，不报写入）
	 * 上的整体 miss」与「完全不报告缓存信息的供应商」。
	 */
	reportedCache: boolean;
}

/**
 * 相对上一次请求，计算单条 assistant 消息的缓存 miss。
 * 以下情况不计数、返回 undefined：首轮（无 prev）、重置后、供应商从未上报过
 * 缓存活动（不支持缓存）、或 miss 量在噪声下限以内。
 */
function detectMiss(
	prev: PreviousRequest | undefined,
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	const usage = message.usage;
	// 提示词总量 = 新输入 + 缓存读 + 缓存写三部分之和
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	// 零缓存轮次只有在之前上报过缓存活动时才计数：
	// 在只上报 cacheRead 的供应商上那是整体 miss；
	// 而在从不报告缓存的供应商上则说明不了任何问题。
	if (!prev || promptTokens <= 0 || (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)) {
		return undefined;
	}

	// 浪费 token = 与上一轮提示词的重叠部分（取小值） − 实际命中的缓存读
	const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
	if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;

	// 额外成本 = 浪费 token 按「实际付费率」（input/cacheWrite，含写入溢价）
	// 而非缓存读费率计费。浪费的 token 只会落入 input 或 cacheWrite 桶，
	// 因此付费率直接取自本条消息自身的成本分解。
	const paidTokens = usage.input + usage.cacheWrite;
	const paidPerToken = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
	// 本轮没有缓存读时，用模型目录价换算缓存读单价（美元/token = 美元/百万 ÷ 1e6）
	const readPerToken =
		usage.cacheRead > 0
			? usage.cost.cacheRead / usage.cacheRead
			: (models.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;

	return {
		missedTokens,
		// max(0, ...) 防御定价异常时算出「负浪费」
		missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
		idleMs: Math.max(0, message.timestamp - prev.timestamp),
		modelChanged: `${message.provider}/${message.model}` !== prev.modelKey,
	};
}

/** 把一条 assistant 消息压缩成下一轮比较用的 PreviousRequest；无有效 usage 时返回 undefined（保留旧 prev）。 */
function asPreviousRequest(message: AssistantMessage, reportedCache: boolean): PreviousRequest | undefined {
	const usage = message.usage;
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens <= 0) return undefined;
	return {
		promptTokens,
		modelKey: `${message.provider}/${message.model}`,
		timestamp: message.timestamp,
		// 粘性传播：只要本片段内出现过缓存上报，就一直保持 true
		reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
	};
}

/**
 * 顺序扫描会话条目：维护 prev 状态、累计浪费总量，
 * 并记录每条被计入 miss 的 assistant 消息 → CacheMiss 的映射。
 */
function scan(
	entries: SessionEntry[],
	models: ModelPriceSource,
): { prev: PreviousRequest | undefined; totals: CacheWasteTotals; misses: Map<AssistantMessage, CacheMiss> } {
	let prev: PreviousRequest | undefined;
	const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
	const misses = new Map<AssistantMessage, CacheMiss>();

	for (const entry of entries) {
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			// 压缩/分支回退后上下文合法地发生了变化：下一轮提示词是新内容而非
			// 重复计费内容，重置 prev 以豁免。模型切换**不**豁免：
			// 它会重新计费整个提示词，理应被计入。
			prev = undefined;
			continue;
		}
		if (entry.type === "message" && entry.message.role === "assistant") {
			const miss = detectMiss(prev, entry.message, models);
			if (miss) {
				totals.missedTokens += miss.missedTokens;
				totals.missedCost += miss.missedCost;
				totals.missCount += 1;
				misses.set(entry.message, miss);
			}
			// 滚动更新 prev；消息缺少有效 usage 时保留原 prev 继续比较
			prev = asPreviousRequest(entry.message, prev?.reportedCache ?? false) ?? prev;
		}
	}
	return { prev, totals, misses };
}

/**
 * 计算整个会话的累计缓存浪费：本应作为缓存读命中（上一轮提示词中已有）
 * 却被重新计费的提示词 token。
 */
export function computeCacheWaste(entries: SessionEntry[], models: ModelPriceSource): CacheWasteTotals {
	return scan(entries, models).totals;
}

/**
 * 收集整个会话中所有被计入的缓存 miss，以承担费用的 assistant 消息对象
 * （引用作键）索引。用于从条目重建聊天时（恢复会话、压缩后重建）
 * 重新推导 transcript 中的缓存提示。
 */
export function collectCacheMisses(
	entries: SessionEntry[],
	models: ModelPriceSource,
): Map<AssistantMessage, CacheMiss> {
	return scan(entries, models).misses;
}

/**
 * 对「刚完成」的 assistant 消息做缓存 miss 检测。
 * 注意 `entries` 中必须尚不包含 `message`（message_end 事件先于持久化触发）。
 */
export function detectCacheMiss(
	entries: SessionEntry[],
	message: AssistantMessage,
	models: ModelPriceSource,
): CacheMiss | undefined {
	return detectMiss(scan(entries, models).prev, message, models);
}
