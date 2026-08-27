/**
 * @file 简化选项到完整流式选项的统一换算
 * @description 各 API 实现共享的选项预处理：把用户友好的 SimpleStreamOptions
 *              （统一 reasoning 档位、可选 maxTokens）换算成具体协议需要的
 *              StreamOptions 字段——按上下文余量钳制 maxTokens、把思考档位
 *              映射为思考 token 预算、保证思考与回答共享输出上限时的最小回答空间。
 *
 * 依赖关系：
 * - ../types.ts 的选项与思考档位类型；../utils/estimate.ts 的上下文估算
 */

import type {
	Api,
	Context,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
} from "../types.ts";
import { estimateContextTokens } from "../utils/estimate.ts";

// 钳制余量：从上下文窗口里预留的安全 token（换算/协议开销缓冲），确保不太贴着窗口发请求
const CONTEXT_SAFETY_TOKENS = 4096;
// maxTokens 的下限：钳制后至少允许输出 1 个 token
const MIN_MAX_TOKENS = 1;

/**
 * 把期望的 maxTokens 钳制到上下文余量内：
 * 可用空间 = 窗口 − 估算的当前上下文 − 安全余量；窗口未知（<=0）时只保下限。
 */
export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context).tokens - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

/**
 * 把 SimpleStreamOptions 组装为完整 StreamOptions：
 * 采样参数做「模型默认 + 调用方覆盖」浅合并；maxTokens 缺省取模型上限并钳制到
 * 上下文余量；apiKey 显式参数优先于选项里的；其余字段原样透传。
 */
export function buildBaseOptions(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams =
		model.samplingParams || options?.samplingParams
			? { ...model.samplingParams, ...options?.samplingParams }
			: undefined;
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		signal: options?.signal,
		telemetryContext: options?.telemetryContext,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/** 思考预算与回答共享响应上限时，始终为回答保留的最小 token 数。 */
export const MIN_ANSWER_TOKENS = 1024;

/** 各思考档位的默认 token 预算（可被 customBudgets 覆盖单档） */
export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
};

/** 把超出 "high" 的档位（xhigh/max）压回 "high"：多数协议没有更高档可映射 */
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh" | "max"> | undefined {
	return effort === "xhigh" || effort === "max" ? "high" : effort;
}

/** 取思考档位对应的 token 预算：默认表与自定义表合并后查表 */
export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	const level = clampReasoning(reasoningLevel)!;
	return budgets[level]!;
}

/** 钳制思考预算，确保共享响应上限时至少给回答留出 MIN_ANSWER_TOKENS。 */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

/**
 * 根据思考档位换算 { maxTokens, thinkingBudget }。
 *
 * 语义：未显式给 baseMaxTokens 时用模型上限、思考预算包含在内；
 * 显式给了则在其之上加思考预算（回答空间不被思考挤占），仍不超过模型上限。
 * 若上限装不下思考预算（思考把回答挤没了），按「至少留 MIN_ANSWER_TOKENS 给回答」
 * 压缩思考预算。
 *
 * @param baseMaxTokens 调用方显式给的输出上限；undefined 表示未显式限制，
 *                      用模型上限并让思考包含其中
 */
export function adjustMaxTokensForThinking(
	// undefined 表示调用方没有显式上限：用模型上限、思考包含其中
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	// 上限装不下「思考 + 最小回答」：压缩思考预算保回答空间
	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
