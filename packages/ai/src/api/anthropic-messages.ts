/**
 * @file anthropic-messages 协议实现（Anthropic Messages API 流式适配器）
 * @description 基于 @anthropic-ai/sdk 把统一的 Context 转换为 Messages 请求并解析 SSE 流：
 *              - 请求侧：system / messages / tools 三类内容的协议转换（图片、thinking
 *                签名回放、连续工具结果聚合）、prompt cache 断点（system、工具列表末尾、
 *                最后一条 user 消息）、预算式与自适应两种 thinking 模式、tool references
 *                （延迟工具加载）
 *              - 流侧：内置 SSE 解码器 + Anthropic 事件过滤，把 message_start /
 *                content_block_* / message_delta 增量归并为标准 AssistantMessageEvent 流，
 *                并在 message_start / message_delta 两个时点核算 usage 与费用
 *              - 多端点复用：GitHub Copilot、OAuth 订阅令牌（sk-ant-oat）以及 minimax 等
 *                兼容厂商共用本协议，差异通过 model.compat 开关与请求头分支处理
 *              - 特殊机制：OAuth 模式下伪装成 Claude Code 客户端（User-Agent、beta 头、
 *                系统提示前缀与工具名规范化），以走通 Claude 订阅鉴权并获得更好的工具调用效果
 *
 * 依赖关系：
 * - ../types.ts 统一消息/模型类型；../models.ts 的 calculateCost 费用计算
 * - ./transform-messages.ts 发送前做跨模型消息改写；./simple-options.ts 简单选项归一化
 * - ../utils/ 下的事件流、JSON 容错解析、provider 重试等基础设施
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "./constrained-sampling.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { adjustMaxTokensForThinking, buildBaseOptions, clampMaxTokensToContext } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

/**
 * 解析缓存保留策略偏好。
 * 默认 "short"（5 分钟 TTL）；向后兼容：未显式传参时读环境变量 PI_CACHE_RETENTION，
 * 值为 "long" 则升级为 1 小时 TTL。
 *
 * @param cacheRetention 调用方显式指定的保留策略
 * @param env 提供方环境变量集（读取 PI_CACHE_RETENTION 用）
 * @returns 生效的缓存保留策略（"short" | "long" | "none"）
 */
function resolveCacheRetention(cacheRetention?: CacheRetention, env?: ProviderEnv): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") {
		return "long";
	}
	return "short";
}

/**
 * 计算本次请求实际使用的 cache_control 标记。
 *
 * 策略："none" 完全不加缓存标记；"long" 且模型兼容（supportsLongCacheRetention）时
 * 使用 1h TTL 的 ephemeral 标记（按输入价 2 倍计费），否则回落默认 5 分钟 TTL。
 *
 * @param model 目标模型（读取 compat 能力开关）
 * @param cacheRetention 调用方指定的保留策略
 * @param env 提供方环境变量集
 * @returns retention 为生效策略；cacheControl 为要打到请求块上的缓存标记（none 时缺省）
 */
function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// ========== Claude Code 伪装（隐身模式）==========
// OAuth 订阅令牌（sk-ant-oat）模式下，服务端要求请求看起来来自 Claude Code 客户端；
// 且官方 CLI 的内置工具名（规范大小写）是模型训练中见过的形态，沿用可获得更好的
// 工具调用效果。因此发送方向上把本地工具名伪装成 Claude Code 的内置工具名。
// claudeCodeVersion：伪装的 CLI 版本号，用于 User-Agent 与身份头
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x 的内置工具名清单（规范大小写）
// 来源：https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// 更新方式：https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

// 小写名 → Claude Code 规范名的查找表（支撑大小写不敏感的伪装映射）
const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

/** 发送方向：命中清单时把工具名转成 Claude Code 规范大小写，未命中则原样返回 */
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
/** 接收方向：把模型回吐的（可能是伪装后的）工具名按当前工具表反查还原成本地真实名字 */
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * 把统一内容块（文本/图片）转换为 Anthropic API 的消息内容格式。
 *
 * 纯文本时直接拼接为字符串（协议允许的简写形式）；含图片时转为内容块数组
 * （图片走 base64 source）；只有图片没有文本时补一个占位文本块。
 *
 * @param content 统一格式的文本/图片内容块数组
 * @returns 纯文本时的拼接字符串，或 Anthropic 内容块数组（text / image 块）
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// 无图片时直接用换行拼接的纯字符串，走协议的简写形式
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// 含图片时转为内容块数组
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// 只有图片没有文本时，补一个占位文本块
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

/** 自适应 thinking 的努力档位（由低到高）；"max" 仅 Opus 4.6，"xhigh" 仅部分新模型支持 */
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** 思考内容的返回形态："summarized" 返回摘要文本，"omitted" 只回传加密签名以续接多轮 */
export type AnthropicThinkingDisplay = "summarized" | "omitted";

/** 官方 SDK 类型尚未收录 fallbacks 字段的请求扩展：服务端模型降级备选列表 */
type MessageCreateParamsStreamingWithFallbacks = MessageCreateParamsStreaming & {
	fallbacks?: readonly { model: string }[];
};

// ========== beta 特性开关（拼进 anthropic-beta 请求头）==========
// 细粒度工具流：让工具入参在生成过程中就分片流出，而不是攒到块结束
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
// 交错思考：允许 thinking 与工具调用在同一回合交替出现
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
// 服务端 fallback：主模型过载时由服务端自动切换到备选模型
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * 是否启用服务端 fallback beta：模型配置了 allowedFallbackModels（降级备选）时开启。
 *
 * @param model 目标模型
 * @returns 配置了至少一个备选模型时为 true
 */
function shouldUseServerSideFallbackBeta(model: Model<"anthropic-messages">): boolean {
	return (model.compat?.allowedFallbackModels?.length ?? 0) > 0;
}

/**
 * 读取模型的 anthropic-messages 兼容层配置，未配置的字段填默认值。
 *
 * 兼容端点（GitHub Copilot、minimax 等）能力参差，各开关决定请求是否携带
 * 对应特性：长缓存 TTL、会话亲和头、工具上的 cache_control、temperature、
 * 严格 JSON schema、tool references 等。
 *
 * @param model 目标模型
 * @returns 除 forceAdaptiveThinking / allowedFallbackModels 之外全部必填的 compat 配置
 */
function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking" | "allowedFallbackModels">> {
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? false,
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model),
	};
}

/**
 * `supportsToolReferences` 的默认判定规则：仅第一方 Anthropic 模型支持，
 * 但排除 Haiku（会拒绝客户端侧的 tool_reference 块）以及早于「工具搜索」
 * 特性发布的模型（Claude 3.x、Opus/Sonnet 4.0、Opus 4.1）。
 *
 * @param model 目标模型
 * @returns 默认是否支持 tool references（延迟工具加载）
 */
function defaultSupportsToolReferences(model: Model<"anthropic-messages">): boolean {
	// 非第一方 Anthropic 提供方或 Haiku 系：不支持
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	// 从模型 id 中解析 claude-<系列>-<主版本>[-<次版本>] 的版本号
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	// 次版本段长度 >= 8 视为日期串（如 4.5-20250929），按 0 处理
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	// 主版本 > 4，或 4.5（含）之后的模型才支持工具搜索
	return major > 4 || (major === 4 && minor >= 5);
}

/** anthropic-messages 协议的完整流式选项（在通用 StreamOptions 之上扩展 Anthropic 专属项） */
export interface AnthropicOptions extends StreamOptions {
	/**
	 * 是否开启扩展思考。
	 * 自适应思考模型：由模型自行决定何时思考、思考多少。
	 * 旧模型：走预算式思考，配额由 thinkingBudgetTokens 指定。
	 * 默认：undefined（除非 streamSimple() 把简单推理档位映射到本选项，或调用方显式设置，
	 * 否则请求中不携带 thinking 配置）。
	 */
	thinkingEnabled?: boolean;
	/**
	 * 扩展思考的 token 预算（仅旧模型生效）。
	 * 自适应思考模型忽略此值。
	 * 默认：thinkingEnabled 为 true 且未提供预算时取 1024。
	 */
	thinkingBudgetTokens?: number;
	/**
	 * 自适应思考模型的努力档位，控制 Claude 分配多少思考：
	 * - "max"：总是思考且无约束（仅 Opus 4.6）
	 * - "xhigh"：最高推理档（Opus 4.7+、Fable 5）
	 * - "high"：总是思考，深度推理
	 * - "medium"：适度思考，简单问题可能跳过
	 * - "low"：最少思考，简单任务直接跳过
	 * 旧模型忽略此值。
	 * 默认：缺省，除非 streamSimple() 把简单推理档位映射到本选项。
	 */
	effort?: AnthropicEffort;
	/**
	 * 控制 API 响应中思考内容的返回形态：
	 * - "summarized"：thinking 块携带摘要化的思考文本。
	 * - "omitted"：thinking 块的 thinking 字段为空，但加密签名仍会回传以维持
	 *   多轮连续性。UI 不展示思考内容时选它可加快首文本 token 延迟。
	 *
	 * 注意：Claude Opus 4.7 与 Claude Mythos Preview 的 API 默认值是 "omitted"，
	 * 这里默认 "summarized" 以与旧 Claude 4 模型保持一致；显式传 "omitted" 可切换。
	 * 默认：开启思考时为 "summarized"。
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * 是否为非自适应思考模型请求「交错思考」beta 头。自适应思考模型已内建交错思考，
	 * 无论本设置如何都会跳过该头。
	 * 默认：true。
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic 的工具选择行为。字符串映射到内置选项；`{ type: "tool", name }` 强制指定工具。
	 * 默认：缺省（Anthropic 默认行为，当前等价于 auto）。
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * 预构建的 Anthropic 客户端实例。提供时完全跳过内部客户端构建，
	 * 用于注入共享同一 Messages API 的替代 SDK 客户端（如 AnthropicVertex）。
	 */
	client?: Anthropic;
}

/**
 * 顺序合并多个请求头来源，后出现的键覆盖先出现的。
 *
 * @param headerSources 若干请求头集合（可为 undefined，会被跳过）
 * @returns 合并后的请求头对象
 */
function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

/**
 * 合并客户端默认头：在最前面固定注入 pi 的 User-Agent（可被后续来源覆盖）。
 *
 * @param headerSources 其余请求头来源
 * @returns 带 pi User-Agent 的合并结果
 */
function mergeClientHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	return mergeHeaders({ "User-Agent": getPiUserAgent() }, ...headerSources);
}

/**
 * 判断请求头中是否携带指定头且值非空（头名大小写不敏感）。
 *
 * @param headers 请求头集合
 * @param name 目标头名
 * @returns 存在且值非空白时为 true
 */
function hasHeader(headers: ProviderHeaders | undefined, name: string): boolean {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	}
	return false;
}

/**
 * 校验请求具备可用的鉴权：apiKey、authorization / x-api-key / cf-aig-authorization
 * 任一存在即通过，否则抛错（兼容 Copilot 的 Cloudflare 网关鉴权等头部自带凭证的场景）。
 *
 * @param provider 提供方名（用于报错信息）
 * @param apiKey 显式 API key
 * @param headers 调用方自定义请求头
 */
function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (apiKey) return;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	) {
		return;
	}
	throw new Error(`No API key for provider: ${provider}`);
}

// ========== SSE 解码器（手写实现，不依赖 SDK 的流解析）==========

/** 解析出的单个 SSE 事件：event 名、data 载荷与原始行（用于报错诊断） */
interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

/** SSE 解码器的跨行累积状态：当前事件的 event 名 / 多行 data / 原始行 */
interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

// 我们关心的 Anthropic 消息事件白名单：ping / error 之外的事件一律忽略
const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

/**
 * 结束当前事件的累积并产出（空行触发）。无任何累积内容时返回 null。
 *
 * @param state SSE 解码器状态（产出后会被重置）
 * @returns 完整的 SSE 事件，或 null（无内容可产出）
 */
function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	// 重置状态，开始累积下一个事件
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

/**
 * 按 SSE 规范解码单行并写入累积状态；遇到空行（事件分隔符）时产出完整事件。
 *
 * 规范要点：以 ":" 开头的行是注释（心跳）直接忽略；"field: value" 冒号后
 * 至多一个前导空格要去掉；event / data 字段分别累积，data 允许多行。
 *
 * @param line 单行文本（不含换行符）
 * @param state SSE 解码器状态
 * @returns 空行且状态非空时返回完整事件，其余返回 null
 */
function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	// 空行 = 事件结束分隔符，触发一次 flush
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	// 冒号开头为注释行（服务端心跳），跳过
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	// 冒号后的单个前导空格按规范去掉
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

/**
 * 找到文本中最早的换行位置（\r 或 \n，兼容 CRLF）。
 *
 * @param text 缓冲区文本
 * @returns 最早换行符的下标，两者都没有时为 -1
 */
function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

/**
 * 从缓冲区消费出一行（兼容 \n、\r、\r\n 三种换行），返回剩余文本。
 *
 * @param text 缓冲区文本
 * @returns { line, rest }；缓冲区还没有完整一行时返回 null
 */
function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	// \r\n 计为一行，需要额外跳过 \n
	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

/**
 * 把响应体的字节流增量解码为 SSE 事件序列。
 *
 * 逐 chunk 读入 → 追加到缓冲区 → 循环消费完整行喂给 decodeSseLine；
 * 流结束后冲刷解码器余量（尾部 final flush、无换行的最后一行、未触发空行的
 * 残留事件），确保代理端点不规范结尾时不丢事件。
 *
 * @param body 响应字节流
 * @param signal 取消信号；中止时抛错终止迭代
 */
async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		// ========== 增量读取循环：chunk 到达即尝试切行，行完整才喂给解码器 ==========
		while (true) {
			// 每次 read 前检查取消信号，保证中止能及时终止迭代
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			// stream: true 表示还有后续字节，避免多字节 UTF-8 字符被截断
			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		// ========== 流结束后的收尾冲刷 ==========
		// 冲刷 TextDecoder 剩余字节，继续按行消费
		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		// 末尾还有一行但没带换行符的：也要喂给解码器
		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		// 兼容不以空行结尾的流：强制冲刷残留的半成品事件
		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * 把 SSE 事件流过滤、反序列化为 Anthropic 官方的 RawMessageStreamEvent 序列。
 *
 * 只放行白名单内的六种消息事件（ping 等直接丢弃）；SSE 层的 error 事件
 * 转为异常；JSON 解析失败时带着原始行抛错便于排查。
 * 另外跟踪 message_start / message_stop 配对：开始过却没正常结束
 * （常见于代理截断流）时在末尾抛错，而不是静默产出半截消息。
 *
 * @param response fetch 响应（SSE 流）
 * @param signal 取消信号
 */
async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	// 流完整性哨兵：记录是否见到过消息的开始与结束事件
	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		// SSE 层显式 error 事件：直接转为异常
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		// 非消息事件（如 ping）：跳过
		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	// 有开始无结束 = 流被截断，视为异常而非正常完成
	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

/**
 * anthropic-messages 协议的主流式入口。
 *
 * 整体流程：构建 Anthropic 客户端（OAuth / Copilot / 普通 API key 三分支）→
 * 组装请求参数 → 发送（SDK 层不重试，由 retryProviderRequest 包装）→ 消费
 * SSE 事件流，增量更新 output 并向下游推送标准事件 → 结束校验后推送 done。
 * 任何一步抛错都会走统一 catch：清理临时字段、标记 error/aborted 并推送 error 事件。
 *
 * @param model 目标模型
 * @param context 统一请求上下文（systemPrompt / messages / tools）
 * @param options 协议专属与通用流式选项
 * @returns 标准 AssistantMessageEventStream（事件流 + 最终 AssistantMessage 双消费）
 */
export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		// ========== 输出骨架：最终 AssistantMessage 的可变累积对象 ==========
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			// OAuth 模式标志：决定后续是否做 Claude Code 工具名双向映射
			let isOAuth: boolean;
			// 计费所用模型：服务端 fallback 换了模型时替换为备选模型的费率
			let usageModel = model;

			// ========== 客户端构建（外部注入 / 自建两分支）==========
			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				assertRequestAuth(model.provider, apiKey, options?.headers);

				// Copilot 专属：根据是否带图片等输入特征构建动态请求头
				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				// 关闭缓存时不发送会话亲和 id（用于服务端路由到同一缓存节点）
				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					shouldUseServerSideFallbackBeta(model),
					options?.headers,
					options?.fetch,
					copilotDynamicHeaders,
					cacheSessionId,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			// ========== 组装请求并发出（SDK 层零重试，重试交给外层包装）==========
			let params = buildParams(model, context, isOAuth, options);
			// onPayload 钩子：发送前最后一次改写请求体的机会
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				// SDK 内建重试关掉：退避等待无法被 AbortSignal 中断，改用 retryProviderRequest
				maxRetries: 0,
			};
			const response = await retryProviderRequest(
				() => client.messages.create({ ...params, stream: true }, requestOptions).asResponse(),
				{
					maxRetries: options?.maxRetries,
					maxRetryDelayMs: options?.maxRetryDelayMs,
					signal: options?.signal,
				},
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			// 流式期间的内容块形态：在标准块之上临时挂 index（Anthropic 事件索引）
			// 与 partialJson（工具入参的原始 JSON 分片缓冲），块结束时再删掉
			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			// ========== 事件循环：SSE 增量 → 标准事件流 ==========
			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				if (event.type === "message_start") {
					// ===== message_start：记录响应元信息并核算首个用量快照 =====
					output.responseId = event.message.id;
					output.model = event.message.model;
					// 服务端 fallback 实际切换了模型时，从备选清单里找回对应费率用于计费
					const fallbackCost =
						output.model === model.id
							? undefined
							: model.compat?.allowedFallbackModels?.find(
									(fallback) => fallback.provider === model.provider && fallback.model === output.model,
								)?.cost;
					usageModel = fallbackCost ? { ...model, id: output.model, cost: fallbackCost } : model;
					// 在 message_start 就先取一次用量：即使流中途被中止，
					// 输入 token（含缓存读写）也已有账可查
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					// 1h TTL 缓存写入量单独记录：计费按输入价 2 倍（见 calculateCost）
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic 不返回 total_tokens，自行按分量求和
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(usageModel, output.usage);
				} else if (event.type === "content_block_start") {
					// ===== content_block_start：新内容块开块（text / thinking / redacted_thinking / tool_use）=====
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: event.content_block.text ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						// 被安全策略涂黑的思考块：内容不可见，只回传不透明载荷（存在 signature 字段）供多轮续接
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						// OAuth 伪装模式：模型回吐的是 Claude Code 规范名，反查还原成本地工具名
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					// ===== content_block_delta：往已开块追加增量 =====
					// 按事件 index 在本地块表中定位目标块再写入
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						// 工具入参以 JSON 分片流式到达：先积累原始文本，再尝试增量解析
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						// thinking 签名可能分片到达：累积拼接，多轮回放时必须完整
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					// ===== content_block_stop：收块，剥离流式临时字段并推送 *_end 事件 =====
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						// index 是流式期间的定位辅助字段，最终消息里不应保留
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// 最终入参就地定稿，并删掉分片缓冲：重放（多轮回发）时只带解析后的 arguments
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					// ===== message_delta：停止原因与最终用量（只在流末出现一次）=====
					if (event.delta.stop_reason) {
						output.rawStopReason = event.delta.stop_reason;
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// 只覆盖「实际存在（非 null）」的用量字段：
					// 部分代理端点在 message_delta 里不回传 input_tokens，保留 message_start 的值
					if (event.usage) {
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Anthropic 在最终 message_delta 的 usage 里以 output_tokens_details.thinking_tokens
						// 报告思考 token（output_tokens 的子集）。SDK 0.91.1 的 Usage 类型未收录该字段，
						// 通过窄化类型断言读取（已对照线上 API 验证）。
						const thinkingTokens = (event.usage as { output_tokens_details?: { thinking_tokens?: number } })
							.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic 不返回 total_tokens，自行按分量求和
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(usageModel, output.usage);
				}
			}

			// ========== 收尾校验 ==========
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			// 流走完仍没有停止原因：视为异常流
			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// ========== 错误处理：清理临时字段后推送 error 事件 ==========
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson 只是流式期间的分片缓冲，绝不能持久化到错误消息里
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * 把统一思考档位映射为 Anthropic 自适应 thinking 的努力档位。
 * 注意："max" 在所有自适应思考的 Claude 模型上可用，而原生 "xhigh" 仅
 * Opus 4.7/4.8、Sonnet 5 与 Fable 5 支持。
 *
 * @param model 目标模型（优先读其 thinkingLevelMap 的显式映射）
 * @param level 统一思考档位
 * @returns Anthropic 的 effort 档位
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	// 无显式映射时的兜底规则：minimal/low → low，medium → medium，其余 → high
	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

/**
 * 简单选项入口：把统一 SimpleStreamOptions 归一化为 AnthropicOptions 后转调 stream。
 *
 * 关键分派：未要求推理 → 显式关闭思考；自适应思考模型 → 档位映射成 effort；
 * 旧模型 → 预算式思考（thinkingBudgetTokens，且为正文输出预留至少 1024 token）。
 *
 * @param model 目标模型
 * @param context 统一请求上下文
 * @param options 简单流式选项（reasoning 档位等）
 * @returns 标准 AssistantMessageEventStream
 */
export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	assertRequestAuth(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AnthropicOptions;
	// 未要求推理：显式关闭思考
	if (!options?.reasoning) {
		return stream(model, context, {
			...base,
			thinkingEnabled: false,
		} satisfies AnthropicOptions);
	}

	// 自适应思考模型：映射为 effort 档位；旧模型：走预算式思考
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// maxTokens 为 undefined 表示调用方没有限制输出上限，交给辅助函数用模型上限；
	// 这里不能强转成 0，否则思考预算会吃满整个 max_tokens，正文一个 token 都不剩
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	// 思考预算再兜底一次：不超过 maxTokens - 1024，保证正文有输出空间
	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
	} satisfies AnthropicOptions);
};

/**
 * 判断是否为 OAuth 订阅令牌（Claude Pro/Max 等订阅的 sk-ant-oat 前缀 token）。
 *
 * @param apiKey 待判定的 key
 * @returns 是 OAuth token 时为 true（此时走 Claude Code 伪装分支）
 */
function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

/**
 * 构建 Anthropic SDK 客户端实例，按鉴权形态分三条分支：
 * 1) GitHub Copilot：Bearer token + Copilot 动态头；
 * 2) OAuth 订阅令牌：Bearer token + Claude Code 身份伪装头（User-Agent、x-app、
 *    claude-code beta），这是工具名伪装生效的前提；
 * 3) 普通 API key（或请求头自带凭证）：x-api-key 鉴权 + 按需的会话亲和头。
 * beta 特性头按需拼接：细粒度工具流、交错思考（自适应思考模型已内建则跳过）、
 * 服务端 fallback。
 *
 * @param model 目标模型
 * @param apiKey API key 或 OAuth token
 * @param interleavedThinking 调用方是否要求交错思考 beta
 * @param useFineGrainedToolStreamingBeta 是否启用细粒度工具流 beta
 * @param useServerSideFallbackBeta 是否启用服务端 fallback beta
 * @param optionsHeaders 调用方自定义请求头
 * @param fetch 自定义 fetch 实现
 * @param dynamicHeaders 动态请求头（Copilot 视觉路由等）
 * @param sessionId 缓存会话亲和 id（开启且模型支持时发送 x-session-affinity）
 * @returns 客户端实例与「是否 OAuth token」标志
 */
function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	useServerSideFallbackBeta: boolean,
	optionsHeaders?: ProviderHeaders,
	fetch?: typeof globalThis.fetch,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
): { client: Anthropic; isOAuthToken: boolean } {
	// 自适应思考模型已内建交错思考，无需再请求该 beta 头
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}
	if (useServerSideFallbackBeta) {
		betaFeatures.push(SERVER_SIDE_FALLBACK_BETA);
	}

	// ===== 分支一：GitHub Copilot —— Bearer 鉴权，只带被选中的 beta =====
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeClientHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// ===== 分支二：OAuth 订阅令牌 —— Bearer 鉴权 + Claude Code 身份伪装 =====
	// 服务端要求 OAuth 流量来自 Claude Code 客户端：伪装 CLI 版本号（User-Agent）、
	// x-app: cli，并挂 claude-code-20250219 与 oauth-2025-04-20 beta 头
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			fetch,
			defaultHeaders: mergeClientHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// ===== 分支三：普通 API key（或请求头自带凭证）=====
	// 会话亲和头：开启缓存且模型支持时发送，让同一会话路由到同一节点以提高缓存命中
	const sessionAffinityHeaders: ProviderHeaders =
		sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const defaultHeaders = mergeClientHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	const client = new Anthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		fetch,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

/**
 * 把统一 Context 组装为 Messages 请求参数。
 *
 * 覆盖：消息转换（含 tool_reference 重建）、system 提示（OAuth 模式额外注入
 * Claude Code 身份前缀）、温度、工具列表（立即 + 延迟两组）、thinking 配置
 * （自适应 / 预算式 / 显式关闭）、metadata、tool_choice、服务端 fallbacks。
 *
 * @param model 目标模型
 * @param context 统一请求上下文
 * @param isOAuthToken 是否 OAuth 订阅令牌（决定 Claude Code 伪装）
 * @param options 协议专属与通用流式选项
 * @returns 可直接发给 Messages API 的流式请求参数
 */
function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreamingWithFallbacks {
	// ========== 基础准备：缓存标记、消息改写、工具拆分 ==========
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	// 发送前先做跨模型改写（图片降级、thinking 跨模型处理、工具调用 ID 归一化等）
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	// OAuth 模式下工具名要伪装成 Claude Code 规范名，工具拆分与消息转换都要用同一映射
	const normalizeToolName = isOAuthToken ? toClaudeCodeName : (name: string) => name;
	// 拆分「立即完整下发」与「已被历史 tool_reference 延迟加载」两组工具
	const toolPlacement = splitDeferredTools(
		{ ...context, messages: transformedMessages },
		compat.supportsToolReferences,
		normalizeToolName,
	);
	let immediateTools = toolPlacement.immediate;
	let deferredTools = [...toolPlacement.deferred.values()];
	// 兜底：若没有任何立即下发的工具，把延迟工具全部转为立即下发（请求不允许没有可用工具）
	if (immediateTools.length === 0 && deferredTools.length > 0) {
		immediateTools = deferredTools;
		deferredTools = [];
	}
	// 延迟工具名集合（归一化后）：转换历史消息时据此生成 tool_reference
	const deferredToolNames = new Set(deferredTools.map((tool) => normalizeToolName(tool.name)));
	const params: MessageCreateParamsStreamingWithFallbacks = {
		model: model.id,
		messages: convertMessages(
			transformedMessages,
			isOAuthToken,
			cacheControl,
			compat.allowEmptySignature,
			deferredToolNames,
			normalizeToolName,
		),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// ========== system 提示：OAuth 模式必须携带 Claude Code 身份前缀 ==========
	if (isOAuthToken) {
		// 订阅令牌鉴权要求系统提示以 Claude Code 官方身份声明开头，否则请求会被拒
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// 非 OAuth：直接带调用方系统提示，并打上缓存断点
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// ========== 温度：与扩展思考互斥，且 Claude Opus 4.7+ 不再支持 ==========
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	// ========== 工具：立即组（末项打缓存断点）+ 延迟组（defer_loading）==========
	if (immediateTools.length > 0 || deferredTools.length > 0) {
		params.tools = [
			...convertTools(
				immediateTools,
				isOAuthToken,
				compat.supportsEagerToolInputStreaming,
				compat.supportsStrictTools,
				compat.supportsCacheControlOnTools ? cacheControl : undefined,
			),
			...convertTools(
				deferredTools,
				isOAuthToken,
				compat.supportsEagerToolInputStreaming,
				compat.supportsStrictTools,
				undefined,
				true,
			),
		];
	}

	// ========== thinking 配置：自适应 / 预算式 / 显式关闭三选一 ==========
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// 默认 "summarized"：让 Opus 4.7 与 Mythos Preview 的行为与
			// 旧 Claude 4 模型一致（后者的 API 默认也是 "summarized"）
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// 自适应思考：由 Claude 自行决定何时思考、思考多少
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// SDK 类型可能滞后于新支持的 effort 值（如 "xhigh"），这里做一层断言绕过
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// 旧模型：预算式思考，未指定预算时默认 1024
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			// 显式关闭（且模型档位表没有把 off 禁掉）时才下发 disabled
			params.thinking = { type: "disabled" };
		}
	}

	// ========== metadata / tool_choice / fallbacks ==========
	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		// 字符串映射为内置选项；对象形态（强制指定工具）原样透传
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	// 配置了备选模型时下发 fallbacks：主模型过载由服务端自动降级
	const allowedFallbackModels = model.compat?.allowedFallbackModels;
	if (allowedFallbackModels && allowedFallbackModels.length > 0) {
		params.fallbacks = allowedFallbackModels.map((fallback) => ({ model: fallback.model }));
	}

	return params;
}

/**
 * 归一化工具调用 ID，满足 Anthropic 对 ID 的格式（^[a-zA-Z0-9_-]+$）与长度（<= 64）要求。
 * 兼容 OpenAI 等其他协议产生的特殊字符 ID：非法字符替换为下划线，超长截断。
 *
 * @param id 原始工具调用 ID
 * @returns 合法的 Anthropic 工具调用 ID
 */
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * 转换单条工具结果消息为 Anthropic 的 tool_result 块。
 *
 * 同时负责重建 tool_reference：该消息的 addedToolNames 里属于延迟工具且
 * 尚未加载过的名字，生成 tool_reference 块放进 tool_result 的 content；
 * 由于 Anthropic 不允许 tool_reference 与普通内容混在同一 content 里，
 * 真实结果内容会被挪到同一条 user 消息的兄弟块（siblingContent）中。
 *
 * @param msg 工具结果消息
 * @param isOAuthToken 是否 OAuth 模式（tool_reference 里的工具名同样要伪装）
 * @param deferredToolNames 本次请求中走延迟加载的工具名集合
 * @param loadedToolNames 跨消息累积的「已生成过 reference」名单（避免重复引用）
 * @param normalizeToolName 工具名归一化函数
 * @returns toolResult 为 tool_result 块；siblingContent 为被挤出的普通内容块
 */
function convertToolResult(
	msg: ToolResultMessage,
	isOAuthToken: boolean,
	deferredToolNames: ReadonlySet<string>,
	loadedToolNames: Set<string>,
	normalizeToolName: (name: string) => string,
): { toolResult: ContentBlockParam; siblingContent: ContentBlockParam[] } {
	const references: Array<{ type: "tool_reference"; tool_name: string }> = [];
	for (const name of msg.addedToolNames ?? []) {
		const normalizedName = normalizeToolName(name);
		// 非延迟工具或已引用过：跳过，不重复生成 reference
		if (!deferredToolNames.has(normalizedName) || loadedToolNames.has(normalizedName)) continue;
		loadedToolNames.add(normalizedName);
		references.push({
			type: "tool_reference",
			tool_name: isOAuthToken ? toClaudeCodeName(name) : name,
		});
	}
	const convertedContent = convertContentBlocks(msg.content);
	// Anthropic 会拒绝 tool_reference 与普通 tool_result 内容混排，二者必须分开
	return {
		toolResult: {
			type: "tool_result",
			tool_use_id: msg.toolCallId,
			content: references.length > 0 ? references : convertedContent,
			is_error: msg.isError,
		},
		siblingContent:
			references.length === 0
				? []
				: typeof convertedContent === "string"
					? [{ type: "text", text: convertedContent }]
					: convertedContent,
	};
}

/**
 * 把统一消息历史转换为 Anthropic 的 MessageParam 数组。
 *
 * 处理要点：空文本消息/空块直接丢弃（Anthropic 拒绝空 content）；assistant 的
 * thinking 块带签名原样回放（多轮思考连续性的关键），签名缺失时降级为纯文本
 * （或按 allowEmptySignature 保留空签名）；连续多条工具结果合并进同一条 user
 * 消息（z.ai 兼容端点的要求）；最后给末条 user 消息打缓存断点。
 *
 * @param transformedMessages 已经过 transformMessages 改写的消息历史
 * @param isOAuthToken 是否 OAuth 模式（工具名伪装）
 * @param cacheControl 缓存标记（打到末条 user 消息）
 * @param allowEmptySignature 是否允许 thinking 块携带空签名（兼容端点开关）
 * @param deferredToolNames 延迟工具名集合（生成 tool_reference 用）
 * @param normalizeToolName 工具名归一化函数
 * @returns Anthropic 协议的消息数组
 */
function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	deferredToolNames: ReadonlySet<string> = new Set(),
	normalizeToolName: (name: string) => string = (name) => name,
): MessageParam[] {
	const params: MessageParam[] = [];
	// 跨消息共享的「已生成 tool_reference」名单，保证每个延迟工具只引用一次
	const loadedToolNames = new Set<string>();

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		// ========== user 消息：字符串或内容块数组 ==========
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				// 内容块数组：文本块 + 图片块（base64 source）
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				// 过滤空白文本块；整条消息全空则跳过（Anthropic 拒绝空 content）
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			// ========== assistant 消息：text / thinking 回放 / tool_use ==========
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					// 空文本块跳过
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// 涂黑思考：把不透明载荷（存在 signature 字段）原样回传为 redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					// 内容与签名全空：整块丢弃
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// 签名缺失/为空（典型来源：被中止的流）时降级为纯文本块；
					// 部分兼容端点会发出并接受空签名，打了 allowEmptySignature 标记的模型保留原块
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						// 带签名的 thinking 块原样回放：签名是 Anthropic 校验多轮思考
						// 连续性的凭证，缺失会被服务端拒绝
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					// OAuth 模式：历史工具调用的名字同样要做 Claude Code 伪装
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// ========== toolResult：聚合同一轮的连续工具结果到一条 user 消息 ==========
			// 必须聚合的原因：z.ai 的 Anthropic 兼容端点要求工具结果成组出现
			const toolResults: ContentBlockParam[] = [];
			const siblingContent: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const converted = convertToolResult(
					transformedMessages[j] as ToolResultMessage,
					isOAuthToken,
					deferredToolNames,
					loadedToolNames,
					normalizeToolName,
				);
				toolResults.push(converted.toolResult);
				siblingContent.push(...converted.siblingContent);
				j++;
			}

			// 外层 for 的游标直接跳过已聚合处理的消息
			i = j - 1;

			// 被挤出的普通内容块必须紧跟在全部 tool_result 块之后（Anthropic 的顺序要求）
			params.push({
				role: "user",
				content: [...toolResults, ...siblingContent],
			});
		}
	}

	// ========== 缓存断点：在最后一条 user 消息的末块上打 cache_control ==========
	// 前缀缓存按写入点截断，把断点放在对话历史末尾可最大化可命中的缓存前缀
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				// 字符串形态无法直接打标记：升级为带 cache_control 的文本块数组
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

/**
 * 是否需要请求「细粒度工具流」beta：有工具且模型不支持 eager_input_streaming 时启用，
 * 让工具入参以分片形式流式输出（替代默认的攒齐再吐）。
 *
 * @param model 目标模型
 * @param context 请求上下文（看是否带工具）
 * @returns 需要启用时为 true
 */
function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

/**
 * 把统一工具定义转换为 Anthropic 的工具声明。
 *
 * 附加能力按开关拼装：eager_input_streaming（入参提前流式输出）、strict
 * （严格 JSON schema 采样）、defer_loading（延迟加载，配合 tool_reference）、
 * 以及仅打在组内最后一个工具上的 cache_control（工具定义也是缓存前缀的一部分）。
 *
 * @param tools 统一工具定义列表
 * @param isOAuthToken 是否 OAuth 模式（工具名伪装为 Claude Code 规范名）
 * @param supportsEagerToolInputStreaming 模型是否支持入参饥饿流式
 * @param supportsStrictTools 模型是否支持 strict schema
 * @param cacheControl 缓存标记（只打在末尾工具上）
 * @param deferLoading 是否标记为延迟加载工具
 * @returns Anthropic 协议的工具声明数组
 */
function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	supportsStrictTools: boolean,
	cacheControl?: CacheControlEphemeral,
	deferLoading = false,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools);
		const parameters = getJsonSchemaToolParameters(tool, strict);
		const schema = parameters as { properties?: unknown; required?: string[] };
		// 兼容端点只认旧的平铺形态：从完整 schema 中抽出 properties/required 重组
		const legacyInputSchema = {
			type: "object" as const,
			properties: schema.properties ?? {},
			required: schema.required ?? [],
		};
		// strict 模式在平铺形态之上保留完整 schema 的其余约束字段
		const inputSchema =
			strict === true
				? {
						...(parameters as Record<string, unknown>),
						...legacyInputSchema,
					}
				: legacyInputSchema;

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			...(strict === true ? { strict: true } : {}),
			input_schema: inputSchema,
			...(deferLoading ? { defer_loading: true } : {}),
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

/**
 * 把 Anthropic 的停止原因映射为统一 StopReason。
 *
 * @param reason Anthropic 的停止原因（或兼容端点的任意字符串）
 * @param stopDetails 拒绝详情（stop_reason 为 refusal 时携带解释文本）
 * @returns 统一停止原因；映射为 error 时附带 errorMessage
 */
function mapStopReason(
	reason: Anthropic.Messages.StopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		// 长思考被暂停：按正常结束处理，由上层决定是否重新提交
		case "pause_turn":
			return { stopReason: "stop" };
		case "stop_sequence":
			// 我们从不下发 stop sequences，正常情况下不会走到这里
			return { stopReason: "stop" };
		// 内容被安全过滤器拦截（SDK 类型尚未收录该值）
		case "sensitive":
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// 未知停止原因直接抛错，避免把 API 新增值静默吞掉
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
