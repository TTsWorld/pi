/**
 * @file 上下文溢出检测
 * @description 通过错误文本模式匹配 + usage 信号，判定助手消息是否因「输入超出模型上下文窗口」
 *              而失败。覆盖三类形态：显式报错（绝大多数 provider）、静默溢出（z.ai）与
 *              截断后 length 停止（小米 MiMo）。上层据此触发压缩（compaction）或报错。
 *
 * 依赖关系：
 * - ../types.ts 的 AssistantMessage
 */

import type { AssistantMessage } from "../types.ts";

/**
 * 各 provider 上下文溢出错误的检测正则集合。
 *
 * 这些模式匹配「输入超出模型上下文窗口」时返回的错误消息。
 *
 * 各 provider 的专属模式（附示例错误消息）：
 *
 * - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
 * - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
 * - OpenAI: "Your input exceeds the context window of this model"
 * - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
 * - OpenAI 兼容: "Input length (265330) exceeds model's maximum context length (262144)."
 * - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
 * - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
 * - Groq: "Please reduce the length of the messages or completion"
 * - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "the request exceeds the available context size, try increasing it"
 * - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
 * - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
 * - MiniMax: "invalid params, context window exceeds limit"
 * - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - Cerebras: "400/413 status code (no body)"
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - z.ai: 不报错，静默接受溢出——经 usage.input > contextWindow 检测
 * - 小米 MiMo: 把输入截断到恰好填满 contextWindow，随后返回 finish_reason "length"
 *   且 output=0（没有空间生成了）。经 stopReason "length" + 零输出 + 输入填满窗口检测。
 * - DashScope/Qwen: "Range of input length should be [1, X]"（HTTP 400 invalid_parameter_error）
 * - Ollama: 部分部署静默截断，部分返回 "prompt too long; exceeded max context length by X tokens" 这类错误
 */
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic token 溢出
	/request_too_large/i, // Anthropic 请求体过大（HTTP 413）
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI（Completions 与 Responses API）
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI 兼容代理（LiteLLM）
	/input token count.*exceeds the maximum/i, // Google（Gemini）
	/maximum prompt length is \d+/i, // xAI（Grok）
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter（多数后端）
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai 非标准 finish_reason 以错误文本形式出现
	/prompt too long; exceeded (?:max )?context length/i, // Ollama 显式溢出错误
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // 通用兜底
	/too many tokens/i, // 通用兜底
	/token limit exceeded/i, // 通用兜底
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras：400/13 无响应体
];

/**
 * 「非溢出」错误的排除模式（限流、服务端错误等）。
 * 即使错误消息同时命中 OVERFLOW_PATTERNS，命中这些模式也会被排除。
 *
 * 示例：Bedrock 把限流错误格式化为 "ThrottlingException: Too many tokens,
 * please wait before trying again."，若没有这个排除会误命中 /too many tokens/i。
 */
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i, // AWS Bedrock 非溢出错误（formatBedrockError 的人类可读前缀）
	/rate limit/i, // 通用限流
	/too many requests/i, // 通用 HTTP 429 风格
];

/**
 * 判定助手消息是否表示一次上下文溢出错误。
 *
 * 处理三种情形：
 * 1. 错误型溢出：多数 provider 返回 stopReason "error" 加特定错误消息模式。
 * 2. 静默溢出：某些 provider 接受超限请求并正常返回。对此检查 usage.input 是否超出上下文窗口。
 * 3. length 停止型溢出：小米 MiMo 在输入填满窗口时可能返回 output 为 0 的 "length"。
 *
 * ## 各 provider 检测可靠性
 *
 * **可靠检测（返回带可识别消息的错误）：**
 * - Anthropic: "prompt is too long: X tokens > Y maximum" 或 "request_too_large"
 * - OpenAI（Completions 与 Responses）: "exceeds the context window"、"exceeds the model's maximum context length of X tokens"、"exceeds model's maximum context length (X)"
 * - Google Gemini: "input token count exceeds the maximum"
 * - xAI（Grok）: "maximum prompt length is X but request contains Y"
 * - Groq: "reduce the length of the messages"
 * - Cerebras: 400/413 状态码（无响应体）
 * - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
 * - OpenRouter（多数后端）: "maximum context length is X tokens"
 * - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
 * - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
 * - llama.cpp: "exceeds the available context size"
 * - LM Studio: "greater than the context length"
 * - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
 * - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
 * - DashScope/Qwen: "Range of input length should be [1, X]"
 *
 * **不可靠检测：**
 * - z.ai: 有时静默接受溢出（可经 usage.input > contextWindow 检测），
 *   有时返回限流错误。传入 contextWindow 参数可检测静默溢出。
 * - 小米 MiMo: 截断输入塞满 contextWindow 后返回 stopReason "length" 且
 *   output=0。传入 contextWindow 参数可经「填满窗口 + 零输出」信号检测。
 * - Ollama: 部分配置会静默截断，部分返回能命中上述模式的显式错误。
 *   静默截断仍无法在此检测，因为我们不知道期望的 token 数。
 *
 * ## 自定义 Provider
 *
 * 若通过 settings.json 添加了自定义模型，本函数可能无法检测其溢出错误。要添加支持：
 *
 * 1. 发送一个超出模型上下文窗口的请求
 * 2. 查看响应中的 errorMessage
 * 3. 构造能匹配该错误的正则模式
 * 4. 把模式加入本文件的 OVERFLOW_PATTERNS，或在调用本函数前自行检查 errorMessage
 *
 * @param message - 待检查的助手消息
 * @param contextWindow - 可选的上下文窗口大小，用于检测静默溢出（z.ai）
 * @returns true 表示该消息指示一次上下文溢出
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// 情形 1：错误消息模式匹配
	if (message.stopReason === "error" && message.errorMessage) {
		// 先排除已知的非溢出模式（限流/服务端错误）
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// 情形 2：静默溢出（z.ai 型）——请求「成功」但 usage 超出窗口
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// 情形 3：length 停止型溢出（小米 MiMo 型）——服务端把超限输入截断到
	// 恰好塞满窗口，导致没有任何输出空间：stopReason "length"、output=0、
	// input+cacheRead 填满窗口（99% 容差对齐截断误差）
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}

/**
 * 判定一次 length 停止是否「低于调用方/模型原本打算的输出上限」提前结束。
 * 这类响应可能由上下文压力或 provider 侧截断引起，调用方可据此做一次
 * 有界的压缩后重试。`desiredMaxOutput` 必须是任何基于上下文的钳制之前的原始上限。
 */
export function isRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
	return message.stopReason === "length" && desiredMaxOutput > 0 && message.usage.output < desiredMaxOutput;
}

/**
 * 获取溢出模式列表（仅供测试使用）。
 */
export function getOverflowPatterns(): RegExp[] {
	return [...OVERFLOW_PATTERNS];
}
