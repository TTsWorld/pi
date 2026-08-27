#!/usr/bin/env node
/**
 * @file 模型目录代码生成脚本 —— packages/ai（@earendil-works/pi-ai）构建期流水线的核心。
 *
 * @description
 * 本脚本是多厂商模型目录的唯一数据来源，负责拉取外部模型目录、清洗修正后
 * 生成 src/ 下的 TypeScript 代码与 JSON 数据。流水线全景：
 *
 * 1. 数据拉取：models.dev 主目录（https://models.dev/api.json）为主，
 *    辅以 NVIDIA NIM /models、OpenRouter /api/v1/models、Vercel AI Gateway /v1/models
 *    三个在线列表（用于在线校验与补充目录）。
 * 2. 目录转换：loadModelsDevData 按 provider 逐一把 models.dev 条目转成 Model 对象，
 *    过程中叠加大量手工修正表（定价修正、preview ID 退役、Copilot 目录窄化、
 *    thinking level 映射、各网关 compat 差异等）。
 * 3. 合并去重：models.dev 优先于 OpenRouter / AI Gateway，按 (provider, model id) 去重，
 *    并剔除已知不需要的模型。
 * 4. 临时覆盖与补齐：修正 contextWindow / maxTokens / 定价，补齐上游缺失或错误的模型
 *    （GPT-5.6 系列、DeepSeek V4、AntLing、OpenAI Codex、Azure 克隆等）。
 * 5. 元数据加工：统一应用 compat 检测与 thinking level 等元数据（apply*Metadata 系列）。
 * 6. 输出渲染：先在临时目录里生成并校验 src/providers/data/<provider>.json（gitignored）
 *    与 .manifest.json，校验通过后原子替换正式目录；随后生成
 *    src/providers/<provider>.models.ts 分片与 src/models.generated.ts 聚合器。
 *
 * 运行模式（node scripts/generate-models.ts [--flags]）：
 * - 默认：全量生成（JSON 数据 + TS 分片 + 聚合器）。
 * - --data-only：仅水合（hydrate）src/providers/data/ 下的 JSON 数据，不重写 TS 分片；
 *   依赖磁盘上已有的 provider 清单，缺失即报错（用于本地还原 gitignored 数据）。
 * - --json-only --json-output <dir>：不写入 src/，只输出平铺 JSON 目录
 *   （models.json / providers.json / providers/<provider>.json）。
 * - --strict：数据源拉取失败或校验不一致时直接抛错（CI 场景使用）。
 * - --pretty：JSON 输出带缩进。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";
import {
	getOpenRouterThinkingLevelMap,
	type OpenRouterReasoningMetadata,
} from "./openrouter-reasoning-options.ts";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../src/api/cloudflare.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	KnownProvider,
	Model,
	ModelCost,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";
import {
	assertExactModelIds,
	createModelDataManifest,
	type ModelDataStructure,
	MODEL_DATA_MANIFEST_FILE,
	readModelDataProviderIds,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";

// 脚本自身路径与包根目录（packages/ai），所有产出均相对此根写入
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

// ========== 运行参数解析 ==========

/**
 * 解析命令行参数，返回生成器运行选项。
 *
 * 旗标含义见文件头；约束：--json-only 必须搭配 --json-output；
 * --data-only 不能与 JSON 目录输出（--json-only / --json-output）同时使用。
 */
function readGeneratorOptions(args: string[]): {
	strict: boolean;
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
} {
	let strict = false;
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir)) throw new Error("--data-only cannot be combined with JSON catalog output");
	return { strict, dataOnly, jsonOnly, jsonOutputDir, pretty };
}

const generatorOptions = readGeneratorOptions(process.argv.slice(2));

// ========== 外部数据源的类型定义 ==========

/** models.dev 目录中单个模型条目的原始结构（仅声明本脚本用到的字段） */
interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

/** models.dev 目录中单个 provider 节点 */
interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

/** models.dev 整份目录：provider id → provider 节点 */
type ModelsDevCatalog = Record<string, ModelsDevProvider>;

/** NVIDIA NIM /models 列表的单条记录 */
interface NvidiaNimModelListItem {
	id: string;
}

/** OpenRouter /api/v1/models 列表的单条记录 */
interface OpenRouterModelListItem {
	id: string;
	name: string;
	supported_parameters?: string[];
	architecture?: { modality?: string };
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	context_length?: number;
	reasoning?: OpenRouterReasoningMetadata;
}

/** Vercel AI Gateway /v1/models 列表的单条记录 */
interface AiGatewayModel {
	id: string;
	name?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: {
		input?: string | number;
		output?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
}

// ========== 手工修正表与 provider 常量 ==========
//
// 这一段是理解「为什么生成结果长这样」的关键：models.dev 等上游目录的元数据
// 经常滞后或出错，下面这些 Set / Map / 常量按主题记录了所有需要人工裁决的
// 覆盖规则（定价、上下文窗口、推理档位、能力黑名单等）。

// GitHub Copilot 端点要求的静态客户端请求头（伪装成 VSCode Copilot Chat 客户端）
const COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

// ---- Together AI ----
// 基础 compat 与三档派生：toggle 式（enable_thinking 开关）、OpenAI effort 式、两者兼有
const TOGETHER_BASE_URL = "https://api.together.ai/v1";
const TOGETHER_BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const TOGETHER_TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	thinkingFormat: "together",
};
const TOGETHER_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	supportsReasoningEffort: true,
	thinkingFormat: "openai",
};
const TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_TOGGLE_REASONING_COMPAT,
	supportsReasoningEffort: true,
};
// 推理「常开、不可关闭」的 Together 模型（不暴露推理控制参数）
const TOGETHER_REASONING_ONLY_MODELS = new Set([
	"deepseek-ai/DeepSeek-R1",
	"MiniMaxAI/MiniMax-M2.7",
]);
// 仅支持 OpenAI 风格 reasoning effort 的 Together 模型
const TOGETHER_REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
// 既支持 toggle 又支持 effort 的 Together 模型
const TOGETHER_TOGGLE_REASONING_EFFORT_MODELS = new Set(["deepseek-ai/DeepSeek-V4-Pro"]);
// Together 各模型族的 thinking level 映射：值为 null 表示该档位不支持（会被过滤掉）
const TOGETHER_FIXED_REASONING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
} as const;
const TOGETHER_REASONING_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;
const TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
} as const;
const TOGETHER_TOGGLE_REASONING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
} as const;

// ---- 各网关 / 云端的接入地址 ----
const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_HEADERS = {
	"NVCF-POLL-SECONDS": "3600",
} as const;
// NVIDIA NIM 的 OpenAI 兼容默认值（不支持 store / developer role / effort 等新参数）
const NVIDIA_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
// 已知在 NVIDIA NIM 上不可用（或行为异常）的模型黑名单，命中即从目录剔除
const NVIDIA_NIM_UNSUPPORTED_MODELS = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);
// 智谱不支持 zai 专用工具流式格式的旧模型
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
// OpenCode Go 上 GLM-5.2 的 thinking level 映射（off/minimal/low/medium 均不可用）
const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
// GitHub Copilot 上不支持 eager tool input 流式的 Claude 模型（key 为 "provider:id"）
const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);
// Anthropic 官方允许的模型回退关系：目标模型过期时可在请求中指定这些替代模型
const ANTHROPIC_ALLOWED_FALLBACK_MODELS = {
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
} satisfies Record<string, string[]>;

// DeepSeek V4 的 thinking level 映射：仅 high/max 有对应的原生档位，其余为 null（不支持）
const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
// Flash 版额外支持 low 档
const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP = {
	...DEEPSEEK_V4_THINKING_LEVEL_MAP,
	low: "low",
} as const;
// 通义 Token Plan 大多数模型只支持 high / max 两档
const QWEN_TOKEN_PLAN_HIGH_MAX_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
// qwen3.8-max 特例：支持 low/medium/xhigh，不支持 high/max
const QWEN_TOKEN_PLAN_QWEN38_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: null,
	xhigh: "xhigh",
	max: null,
} as const;
// 通义 Token Plan 上不支持 reasoning effort 参数的模型（只保留 qwen 式 enable_thinking）
const QWEN_TOKEN_PLAN_REASONING_EFFORT_UNSUPPORTED_MODEL_IDS = new Set([
	"MiniMax-M2.5",
	"deepseek-v3.2",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"qwen3.6-flash",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
]);
// 已退役的 preview id —— GA 版上线后 models.dev 可能仍会列出一段时间
const QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS = new Set(["qwen3.8-max-preview"]);
// 所有通义 Token Plan provider 的 id 集合（用于按 provider 匹配特殊逻辑）
const QWEN_TOKEN_PLAN_PROVIDER_IDS = new Set<string>([
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
]);
// 通义 Token Plan「个人版」的文本模型白名单（2026-08-05 人工核对）。
// 即便公共目录滞后，上面排除的退役模型也保持剔除。
// https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
const QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS = new Set<string>([
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-max",
]);

// Kimi K3 的官方输出上限与定价（$ / 百万 token），用于修正网关元数据
const KIMI_K3_MAX_TOKENS = 131072;
const KIMI_K3_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 0,
} as const;
// Kimi Coding 是订阅制，models.dev 因此上报零成本。这里用对等的 Moonshot API
// 费率来估算订阅用量的价值。
const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k2-thinking": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
};
// OpenRouter 上需要修正输出上限的 Kimi K3 模型 id（含 ~ 前缀的常规模型）
const OPENROUTER_KIMI_K3_MODEL_IDS = new Set(["moonshotai/kimi-k3", "~moonshotai/kimi-latest"]);

// AntLing Ring 系列：默认开启推理，仅 high / xhigh 有文档化的显式档位控制
const ANT_LING_RING_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
} as const;

// 只能通过 inference profile 调用（不走 bedrock-converse 直连）的 Bedrock 模型
const BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5"]);
// models.dev 收录了该别名，但 OpenAI API 实际不接受，需剔除
const MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS = new Set(["gpt-5.6"]);
// 支持 tool search（服务端工具检索）的 OpenAI 模型
const OPENAI_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
// OpenAI 公开文档中的 additional_tools：供在常规 tool-search 流程之外加载工具的
// 应用使用。Codex 目前在其 Responses Lite 的 GPT-5.6 模型上使用 input item 形式。
// https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input
const OPENAI_ADDITIONAL_TOOLS_MODEL_IDS = OPENAI_TOOL_SEARCH_MODEL_IDS;
// Codex 后端上支持 additional tools 的模型（Responses Lite 形式）
const OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
// OpenAI 长上下文分档计价的输入 token 阈值（超过即翻倍计费）
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;
// 默认把 contextWindow 封顶在短上下文档（阈值）内的模型，避免默认落入双倍计价档
const OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
// 需要附加长上下文阶梯定价（tiers）的 OpenAI 模型
const OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

/**
 * 为给定成本追加 OpenAI 长上下文档位（tier）：
 * 输入超过 OPENAI_LONG_CONTEXT_INPUT_THRESHOLD 时，input/cache ×2、output ×1.5。
 * 流水线位置：主流程「临时覆盖与补齐」阶段，处理 OpenAI / Codex / Cloudflare 网关的定价。
 */
function withOpenAiLongContextPricing(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

// OpenAI 于 2026-07-30 下调了 GPT-5.6 Terra / Luna 的价格。在 models.dev 与
// 各透传网关的目录跟上之前，以这里的值为准。
// https://developers.openai.com/api/docs/pricing
const OPENAI_GPT_56_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
};

// OpenAI Responses API 上支持把推理显式设为 "none" 的模型
const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
// xAI 官方 API 已退役或无需内置的模型（从生成结果剔除）
const XAI_BUILTIN_EXCLUDED_MODEL_IDS = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-code-fast-1",
]);
const XAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
};

// OpenCode（Zen / Go）上不支持长缓存保留的模型（key 为 "provider:id"）
const OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:minimax-m2.7",
	"opencode-go:kimi-k2.6",
]);

// GitHub「Models with extended capabilities」表中列出支持扩展 100 万 token 上下文的 Copilot 模型
const GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
]);

// 2026-06-15 用带鉴权的 GitHub Copilot /models 端点人工核对的结果。
// 保留这张表是为了在 models.dev 元数据之上做窄化修正，而不是快照整个 Copilot 目录。
const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
} satisfies Record<string, NonNullable<Model<Api>["thinkingLevelMap"]>>;

// ========== thinking level 与 models.dev reasoning 元数据的中枢辅助 ==========

/** 把新的 thinking level 映射合并进模型（新映射覆盖旧值），所有档位修正最终都走这里 */
function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

// models.dev 原始 reasoning_options 的缓存：key 为 "provider:id"。
// 目录转换阶段先记录，元数据加工阶段再统一消费。
const modelsDevReasoningOptions = new Map<string, ModelsDevReasoningOption[]>();

/** 生成模型的缓存 key："provider:id" */
function getModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

/** 目录转换时记录 models.dev 的原始 reasoning_options，供后续元数据加工使用 */
function recordModelsDevReasoningOptions(provider: string, id: string, sourceModel: ModelsDevModel): void {
	if (sourceModel.reasoning_options !== undefined) {
		modelsDevReasoningOptions.set(`${provider}:${id}`, sourceModel.reasoning_options);
	}
}

/**
 * 判断模型是否能直接透传 reasoning effort 参数：
 * - anthropic-messages：仅强制 adaptive thinking 的模型可以；
 * - *-responses 系列 API：都可以；
 * - openai-completions：取决于嗅探 + 已有 compat 合并后的 thinkingFormat / supportsReasoningEffort。
 */
function supportsDirectReasoningEffort(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return model.compat?.forceAdaptiveThinking === true;
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return true;
	}
	if (model.api !== "openai-completions") return false;

	const compat = {
		...detectOpenAICompletionsCompat(model as Model<"openai-completions">),
		...(model.compat as OpenAICompletionsCompat | undefined),
	};
	return compat.thinkingFormat === "openai" && compat.supportsReasoningEffort;
}

/**
 * 元数据加工阶段：若模型支持直接传 effort，则把 models.dev 的 reasoning_options
 * 换算成 thinkingLevelMap 合并进模型。
 */
function applyModelsDevReasoningOptionMetadata(model: Model<Api>): void {
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (!reasoningOptions || !supportsDirectReasoningEffort(model)) return;
	const thinkingLevelMap = getEffortThinkingLevelMap(reasoningOptions);
	if (thinkingLevelMap) mergeThinkingLevelMap(model, thinkingLevelMap);
}

// ========== Together AI 的 compat 与档位选择 ==========

/** 按模型 id 与是否推理模型，选择 Together 的四档 compat 之一 */
function getTogetherCompat(modelId: string, reasoning: boolean): OpenAICompletionsCompat {
	if (!reasoning) return TOGETHER_BASE_COMPAT;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_REASONING_EFFORT_COMPAT;
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT;
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return TOGETHER_BASE_COMPAT;
	return TOGETHER_TOGGLE_REASONING_COMPAT;
}

/** 与 getTogetherCompat 对应的 thinking level 映射选择 */
function getTogetherThinkingLevelMap(
	modelId: string,
	reasoning: boolean,
): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	if (!reasoning) return undefined;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_REASONING_EFFORT_LEVEL_MAP };
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP };
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return { ...TOGETHER_FIXED_REASONING_LEVEL_MAP };
	return { ...TOGETHER_TOGGLE_REASONING_LEVEL_MAP };
}

// ========== 模型家族识别辅助 ==========

/** OpenAI 5.2 及以后的模型支持 xhigh 推理档 */
function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6")
	);
}

/** GPT-5.6 系列在 Responses / Completions API 上支持 max 推理档 */
function supportsOpenAiMax(model: Model<Api>): boolean {
	return (
		model.id.includes("gpt-5.6") &&
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses" ||
			model.api === "openai-completions")
	);
}

/** 是否为 Google 原生 / Vertex 的 Gemini API（两者共用 thinking level 语义） */
function isGoogleThinkingApi(model: Model<any>): boolean {
	return model.api === "google-generative-ai" || model.api === "google-vertex";
}

/** 是否为支持 adaptive thinking（effort 式推理控制）的 Claude 模型（4.6+/5.x/Fable 5） */
function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("opus-4-8") ||
		modelId.includes("opus-4.8") ||
		modelId.includes("opus-5") ||
		modelId.includes("opus.5") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-5") ||
		modelId.includes("sonnet.5") ||
		modelId.includes("fable-5")
	);
}

/** 是否为不接受 temperature 参数的 Claude 模型（Opus 4.7+） */
function isAnthropicTemperatureUnsupportedModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("opus-4-7") ||
		id.includes("opus-4.7") ||
		id.includes("opus-4-8") ||
		id.includes("opus-4.8") ||
		id.includes("opus-5") ||
		id.includes("opus.5")
	);
}

// ========== OpenAI Completions 兼容层：默认值、嗅探与差量合并 ==========
//
// 所有 openai-completions 模型最终都会带一份「相对默认值的 delta」compat：
// detectOpenAICompletionsCompat 按 provider/baseUrl 嗅探出全量 compat，
// openAICompletionsCompatDelta 只保留与下面默认值不同的字段，再与已有 compat 合并。

// OpenAI Completions 兼容层的默认值（假想一个「标准 OpenAI」端点）
const OPENAI_COMPLETIONS_DEFAULT_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<
	Omit<
		OpenAICompletionsCompat,
		"cacheControlFormat" | "deferredToolsMode" | "supportsThinkingTokenBudget" | "thinkingTokenBudgetField"
	>
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
};

type OpenAICompletionsResolvedCompat = typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

/** 把 Anthropic Messages 兼容项合并进模型（新值覆盖旧值） */
function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

/**
 * 按 provider 名与 baseUrl 嗅探某个 openai-completions 模型的全量兼容能力。
 *
 * 覆盖大量「非标准 OpenAI」端点：NVIDIA / Cerebras / xAI / Together / Chutes /
 * DeepSeek / 智谱 / Moonshot / OpenCode / Cloudflare（Workers AI 与 AI Gateway）/
 * AntLing 等，分别决定 store、developer role、reasoning effort、max_tokens 字段名、
 * thinkingFormat（openai/deepseek/zai/together/ant-ling/openrouter）等差异。
 */
function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsResolvedCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isTogetherReasoningOnly = isTogether && TOGETHER_REASONING_ONLY_MODELS.has(model.id);
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		provider === "cerebras" ||
		baseUrl.includes("cerebras.ai") ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat =
		provider === "openrouter" && /^~?anthropic\//.test(model.id) ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether && !isTogetherReasoningOnly
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsOpenAIGrammarTools: false,
		...(cacheControlFormat ? { cacheControlFormat } : {}),
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

/** 判断是否为空对象字面量（用于 delta 计算时忽略 {} 与 {} 的差异） */
function isPlainEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

/** 求全量 compat 相对默认值的差量（delta），只保留与默认不同的字段 */
function openAICompletionsCompatDelta(compat: OpenAICompletionsResolvedCompat): OpenAICompletionsCompat {
	const delta: OpenAICompletionsCompat = {};
	for (const [key, value] of Object.entries(compat)) {
		const defaultValue = OPENAI_COMPLETIONS_DEFAULT_COMPAT[key as keyof typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT];
		if (isPlainEmptyObject(value) && isPlainEmptyObject(defaultValue)) continue;
		if (value !== defaultValue) {
			(delta as Record<string, unknown>)[key] = value;
		}
	}
	return delta;
}

/** 把 OpenAI Completions 兼容项合并进模型（当前未在主流程使用，保留工具函数） */
function mergeOpenAICompletionsCompat(model: Model<Api>, compat: OpenAICompletionsCompat): void {
	model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), ...compat };
}

/**
 * 元数据加工阶段：为 openai-completions 模型写入嗅探出的 compat delta。
 * 已有 compat 优先于嗅探结果；合并后为空则删除 compat 字段。
 */
function applyOpenAICompletionsCompatMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const detected = openAICompletionsCompatDelta(detectOpenAICompletionsCompat(model as Model<"openai-completions">));
	model.compat = { ...detected, ...(model.compat as OpenAICompletionsCompat | undefined) };
	if (Object.keys(model.compat).length === 0) {
		delete model.compat;
	}
}

/** 元数据加工阶段：为 anthropic-messages 模型合并 provider 级别的兼容修正 */
function applyAnthropicMessagesCompatMetadata(model: Model<Api>): void {
	if (model.api !== "anthropic-messages") return;
	const compat = getAnthropicMessagesCompat(model.provider, model.id);
	if (compat) {
		mergeAnthropicMessagesCompat(model, compat);
	}
}

/** 类型守卫：筛选出参与 Anthropic 回退关系（目标或候选）的 Anthropic 官方模型 */
function isAnthropicFallbackMetadataModel(model: Model<Api>): model is Model<"anthropic-messages"> {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	return (
		model.id in ANTHROPIC_ALLOWED_FALLBACK_MODELS ||
		Object.values(ANTHROPIC_ALLOWED_FALLBACK_MODELS).some((fallbackModelIds) => fallbackModelIds.includes(model.id))
	);
}

/**
 * 元数据加工阶段：按 ANTHROPIC_ALLOWED_FALLBACK_MODELS 为目标模型挂上
 * allowedFallbackModels（含候选模型的 provider/id/定价）。
 */
function applyAnthropicAllowedFallbackModelMetadata(models: readonly Model<"anthropic-messages">[]): void {
	const modelsById = new Map(models.map((model) => [model.id, model]));
	for (const [modelId, fallbackModelIds] of Object.entries(ANTHROPIC_ALLOWED_FALLBACK_MODELS)) {
		const model = modelsById.get(modelId);
		if (!model) continue;

		const allowedFallbackModels = fallbackModelIds.flatMap((fallbackModelId) => {
			const fallbackModel = modelsById.get(fallbackModelId);
			return fallbackModel
				? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: fallbackModel.cost }]
				: [];
		});
		if (allowedFallbackModels.length > 0) {
			mergeAnthropicMessagesCompat(model, { allowedFallbackModels });
		}
	}
}

// ========== 各类专项元数据（strict tools / grammar tools / tool search / prompt cache） ==========

/** 标记支持 strict 工具 schema 的端点：OpenAI 系 Responses 与 Anthropic Messages */
function applyStrictToolCompatMetadata(model: Model<Api>): void {
	if (
		(model.provider === "openai" || model.provider === "cloudflare-ai-gateway") &&
		model.api === "openai-responses"
	) {
		model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsStrictMode: true };
	} else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsStrictTools: true });
	}
}

// 已验证（OpenAI、ChatGPT Codex 后端、GitHub Copilot、opencode zen）或官方文档确认
// （Azure OpenAI、Cloudflare AI Gateway）能透传 OpenAI 自定义 grammar 工具的
// Responses 端点。OpenAI 对 GPT-5 之前的模型（gpt-4.x、gpt-4o、o 系列）会拒绝
// `type: "custom"` 工具。
const OPENAI_GRAMMAR_TOOL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"azure-openai-responses",
	"github-copilot",
	"opencode",
	"cloudflare-ai-gateway",
]);
const OPENAI_GRAMMAR_TOOL_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

/** 为白名单 provider 上的 GPT-5+ Responses 模型标记支持 grammar 工具 */
function applyOpenAIGrammarToolCompatMetadata(model: Model<Api>): void {
	if (!OPENAI_GRAMMAR_TOOL_APIS.has(model.api) || !OPENAI_GRAMMAR_TOOL_PROVIDERS.has(model.provider)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsOpenAIGrammarTools: true };
}

/** 为支持 tool search 的 OpenAI / Codex 模型标记 supportsToolSearch（及 additional tools） */
function applyOpenAIToolSearchMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!(isOpenAIResponses || isOpenAICodex) || !OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) return;
	const supportsAdditionalTools =
		(isOpenAIResponses && OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id)) ||
		(isOpenAICodex && OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id));
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		...(supportsAdditionalTools ? { supportsAdditionalTools: true } : {}),
		supportsToolSearch: true,
	};
}

// OpenAI 从 GPT-5.6 系列开始对 prompt cache 写入收费，且恰好只有这些模型接受
// `prompt_cache_options` 参数；更早的模型会拒绝该参数。
// https://developers.openai.com/api/docs/guides/prompt-caching
function applyOpenAIExplicitPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!(model.cost.cacheWrite > 0)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsExplicitPromptCacheMode: true,
	};
}

// ========== Gemini / Gemma 家族识别 ==========

/** 是否为 Gemini 3 Pro 系（thinking level 用 LOW/HIGH 大写档位） */
function isGemini3ProModel(modelId: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(modelId.toLowerCase());
}

/** 是否为 Gemini 3 Flash 系（含 flash-latest 别名） */
function isGemini3FlashModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return /gemini-3(?:\.\d+)?-flash/.test(id) || id === "gemini-flash-latest" || id === "gemini-flash-lite-latest";
}

/** 是否为 Gemma 4 系 */
function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

/**
 * 元数据加工阶段的中枢：为各 provider / 模型家族叠加 thinkingLevelMap 与相关 compat。
 *
 * 逐条 if 对应一族模型的档位规则（值见上方各 *_THINKING_LEVEL_MAP 常量）：
 * OpenAI GPT-5 系（off/none/xhigh/max）、Anthropic adaptive thinking（max/xhigh 分代）、
 * DeepSeek V4、Gemini 3 Pro/Flash、Gemma 4、Groq Qwen、Kimi、OpenRouter 特例、
 * Fireworks GLM、OpenCode Go、AntLing Ring、GitHub Copilot 覆盖表等。
 * 同时为 adaptive thinking 的 Claude 打上 forceAdaptiveThinking，
 * 为不支持 temperature 的 Claude 打上 supportsTemperature: false。
 */
function applyThinkingLevelMetadata(model: Model<any>): void {
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	// 没有经过验证的 effort 选项的 xAI 模型（如 grok-build-0.1）绝不能发送
	// 未公开文档化的 "none"/"minimal" effort。
	if (model.provider === "xai" && model.api === "openai-responses" && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(model, { off: null, minimal: null });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.provider === "openai" && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive thinking 的 effort 支持（依据官方文档）：
	// - 所有 adaptive thinking 的 Claude 模型都支持 "max"。
	// - "xhigh" 仅 Opus 4.7/4.8/5、Sonnet 5 与 Fable 5 支持。
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("opus.5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	if (model.api === "openai-completions" && model.id.includes("deepseek-v4")) {
		mergeThinkingLevelMap(
			model,
			model.provider === "openrouter"
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: (model.provider === "deepseek" || model.provider === "opencode" || model.provider === "opencode-go") &&
					model.id.includes("deepseek-v4-flash")
					? DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP
					: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	if (isGoogleThinkingApi(model) && isGemini3ProModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: "LOW", medium: null, high: "HIGH" });
	}
	if (isGoogleThinkingApi(model) && isGemini3FlashModel(model.id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (isGoogleThinkingApi(model) && isGemma4Model(model.id)) {
		mergeThinkingLevelMap(model, { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" });
	}
	if (model.provider === "groq" && model.id === "qwen/qwen3.6-27b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	if (model.provider === "openai-codex" && supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code 恒定开启思考。官方文档说明 `thinking: { type: "disabled" }`
		// 会被拒绝，调用方只能省略 thinking 参数以使用默认开启的行为。
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 的 instant 模式（reasoning_effort: "none"）会禁用工具调用。
		// 把 "off" 标记为不支持，openai-completions provider 就会省略 reasoning 参数，
		// 而不是默认发送 {reasoning:{effort:"none"}}（见 openai-completions.ts:575）。
		// Pi 的 low/medium/high 原样透传；OpenRouter 会归一化到 Mercury 的词汇表。
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id === "z-ai/glm-5.2") {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks" && model.id.includes("glm-5p2")) {
		mergeThinkingLevelMap(model, { off: "none", minimal: null, low: "high", medium: "high", max: "max" });
	}
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go 把 Kimi K2.6 的思考暴露为开/关，而非独立的 effort 档位。
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen 的 Grok Build 默认推理，但拒绝显式的 reasoningEffort。
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.provider === "ant-ling" && model.reasoning) {
		// Ring 默认推理。仅 high/xhigh 有文档化的显式档位控制。
		mergeThinkingLevelMap(model, ANT_LING_RING_THINKING_LEVEL_MAP);
	}
	if (model.provider === "github-copilot") {
		const override = GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES[model.id];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}

// ========== 通用小工具（Bedrock / NVIDIA / 定价换算） ==========

/** 计算 Anthropic Messages 兼容模型的 provider 级修正（eager 流式、空签名等） */
function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	const compat: AnthropicMessagesCompat = {};
	if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)) {
		compat.supportsEagerToolInputStreaming = false;
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		compat.allowEmptySignature = true;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

/** Bedrock 端点按模型 id 前缀选区域：eu. 走 eu-central-1，其余走 us-east-1 */
function getBedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

/** NVIDIA 模型 id 归一化：小写并把下划线换成点，用于匹配 NIM 在线列表 */
function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

/** 定价统一保留 6 位小数（单位均为 $ / 百万 token） */
function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

/** 把 models.dev 的 cost 结构（snake_case）转成 ModelCost，并保留 context 类型的分档 tiers */
function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input || 0,
				output: tier.output || 0,
				cacheRead: tier.cache_read || 0,
				cacheWrite: tier.cache_write || 0,
			},
		];
	});

	return {
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}

// ========== 在线数据源拉取（NVIDIA NIM / OpenRouter / Vercel AI Gateway） ==========

/**
 * 拉取 NVIDIA NIM /models 的在线模型 id 表（含「归一化 id → 原始 id」的别名）。
 * 用于过滤 models.dev 中已下架的 NVIDIA 条目。拉取失败时：strict 模式抛错，
 * 否则返回空表（放弃过滤）。
 */
async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetch(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (generatorOptions.strict) throw error;
		return new Map();
	}
}

/**
 * 拉取 OpenRouter /api/v1/models 并转成 Model 列表：
 * 仅保留支持 tools 的模型；把 $/token 定价换算为 $/百万 token；
 * reasoning / thinking level 由 openrouter-reasoning-options 辅助模块推导。
 */
async function fetchOpenRouterModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const response = await fetch("https://openrouter.ai/api/v1/models");
		if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
		const data = (await response.json()) as { data?: OpenRouterModelListItem[] };

		const models: Model<any>[] = [];

		for (const model of data.data ?? []) {
			// 仅保留支持工具调用的模型
			if (!model.supported_parameters?.includes("tools")) continue;

			// 解析模型 ID 所属 provider
			let provider: KnownProvider = "openrouter";
			let modelKey = model.id;

			modelKey = model.id; // Keep full ID for OpenRouter

			// 解析输入模态
			const input: ("text" | "image")[] = ["text"];
			if (model.architecture?.modality?.includes("image")) {
				input.push("image");
			}

			// 把 $/token 定价换算成 $/百万 token
			const inputCost = roundCost(parseFloat(model.pricing?.prompt || "0") * 1_000_000);
			const outputCost = roundCost(parseFloat(model.pricing?.completion || "0") * 1_000_000);
			const cacheReadCost = roundCost(parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000);
			const cacheWriteCost = roundCost(parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000);

			const contextWindow = model.top_provider?.context_length || model.context_length || 4096;
			const thinkingLevelMap = getOpenRouterThinkingLevelMap(model.reasoning);

			const normalizedModel: Model<any> = {
				id: modelKey,
				name: model.name,
				api: "openai-completions",
				baseUrl: "https://openrouter.ai/api/v1",
				provider,
				reasoning: model.supported_parameters?.includes("reasoning") || false,
				...(thinkingLevelMap && { thinkingLevelMap }),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow,
				maxTokens: model.top_provider?.max_completion_tokens || 4096,
			};
			models.push(normalizedModel);
		}

		console.log(`Fetched ${models.length} tool-capable models from OpenRouter`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

/**
 * 拉取 Vercel AI Gateway /v1/models 并转成 Model 列表：
 * 仅保留带 tool-use 标签的模型，统一走 anthropic-messages 兼容端点；
 * 定价同样换算为 $/百万 token。
 */
async function fetchAiGatewayModels(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json();
		const models: Model<any>[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// 仅保留支持工具调用的模型
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const inputCost = roundCost(toNumber(model.pricing?.input) * 1_000_000);
			const outputCost = roundCost(toNumber(model.pricing?.output) * 1_000_000);
			const cacheReadCost = roundCost(toNumber(model.pricing?.input_cache_read) * 1_000_000);
			const cacheWriteCost = roundCost(toNumber(model.pricing?.input_cache_write) * 1_000_000);

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} tool-capable models from Vercel AI Gateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

// ========== models.dev 目录的 provider 专属处理函数 ==========
//
// 这些 provider 的转换逻辑较复杂（多区域变体、特殊 compat 组合），因此从
// loadModelsDevData 中拆出；其余 provider 直接在 loadModelsDevData 内联处理。

/**
 * 智谱 Z.ai 编程套餐：国际版（zai）与国内版（zai-coding-cn）两个变体共用
 * models.dev 的 zai-coding-plan / zhipuai-coding-plan 目录。
 * GLM-5.2 系列的 off 档映射为 "none"；定价优先取 zai 主目录的参考值。
 */
function processZaiModels(data: ModelsDevCatalog): Model<Api>[] {
	const variants = [
		{
			source: "zai-coding-plan",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		},
		{
			source: "zhipuai-coding-plan",
			provider: "zai-coding-cn",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		},
	] as const;
	const models: Model<Api>[] = [];

	for (const { source, provider, baseUrl } of variants) {
		for (const [modelId, model] of Object.entries(data[source]?.models ?? {})) {
			const m = model as ModelsDevModel;
			if (m.tool_call !== true) continue;
			const supportsImage = m.modalities?.input?.includes("image");

			const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
			const isGlm52 = modelId === "glm-5.2" || modelId === "glm-5.2-highspeed";
			if (thinkingLevelMap && isGlm52) {
				thinkingLevelMap.off = "none";
			}
			const supportsReasoningEffort = thinkingLevelMap !== undefined;
			const referenceCost = data.zai?.models[modelId]?.cost ?? m.cost;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: supportsImage ? ["text", "image"] : ["text"],
				cost: {
					input: referenceCost?.input || 0,
					output: referenceCost?.output || 0,
					cacheRead: referenceCost?.cache_read || 0,
					cacheWrite: referenceCost?.cache_write || 0,
				},
				compat: {
					supportsDeveloperRole: false,
					thinkingFormat: "zai",
					...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
					...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions(provider, modelId, m);
		}
	}

	return models;
}

/**
 * Baseten 推理平台：按 reasoning_options 中的 toggle / effort 组合
 * 选择四种 compat 之一；GLM-5.2 系列使用专属 thinking level 映射。
 */
function processBasetenModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const baseUrl = "https://inference.baseten.co/v1";
	const baseCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: true,
		supportsLongCacheRetention: false,
	};
	const reasoningEffortCompat: OpenAICompletionsCompat = {
		...baseCompat,
		supportsReasoningEffort: true,
		thinkingFormat: "openai",
	};
	const toggleReasoningCompat: OpenAICompletionsCompat = {
		...baseCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleReasoningEffortCompat: OpenAICompletionsCompat = {
		...reasoningEffortCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleThinkingLevelMap = {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	} as const;
	const glm52ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	} as const;
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.status === "deprecated") continue;

		const reasoning = model.reasoning === true;
		const reasoningOptions = model.reasoning_options ?? [];
		const isGlm52 = modelId === "zai-org/GLM-5.2" || modelId === "zai-org/GLM-5.2-Fast";
		const supportsToggle = reasoningOptions.some((option) => option.type === "toggle") || isGlm52;
		const supportsEffort = reasoningOptions.some((option) => option.type === "effort") || isGlm52;
		const compat =
			supportsToggle && supportsEffort
				? toggleReasoningEffortCompat
				: supportsToggle
					? toggleReasoningCompat
					: supportsEffort
						? reasoningEffortCompat
						: baseCompat;
		const thinkingLevelMap = isGlm52
			? glm52ThinkingLevelMap
			: supportsToggle
				? toggleThinkingLevelMap
				: getEffortThinkingLevelMap(reasoningOptions);

		models.push({
			id: modelId,
			name: model.name || modelId,
			api: "openai-completions",
			provider: "baseten",
			baseUrl,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			cost: {
				input: model.cost?.input || 0,
				output: model.cost?.output || 0,
				cacheRead: model.cost?.cache_read || 0,
				cacheWrite: model.cost?.cache_write || 0,
			},
			compat,
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		});
	}

	return models;
}

/**
 * Fireworks：GLM-5p2 与 Kimi K3 走 OpenAI 兼容端点（K3 还需 deepseek 式
 * thinking content 与 kimi 式延迟工具），其余模型走 Anthropic 兼容端点。
 */
function processFireworksModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const anthropicCompat: AnthropicMessagesCompat = {
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	};
	const openAICompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const kimiK3Compat: OpenAICompletionsCompat = {
		...openAICompat,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "openai",
		deferredToolsMode: "kimi",
	};
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.tool_call !== true) continue;

		const input: ("text" | "image")[] = model.modalities?.input?.includes("image")
			? ["text", "image"]
			: ["text"];
		const common = {
			id: modelId,
			name: model.name || modelId,
			provider: "fireworks",
			reasoning: model.reasoning === true,
			input,
			cost: {
				input: model.cost?.input || 0,
				output: model.cost?.output || 0,
				cacheRead: model.cost?.cache_read || 0,
				cacheWrite: model.cost?.cache_write || 0,
			},
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		};

		if (modelId.includes("glm-5p2")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: openAICompat,
			});
		} else if (modelId.includes("kimi-k3")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: kimiK3Compat,
			});
		} else {
			models.push({
				...common,
				api: "anthropic-messages",
				// Fireworks 的 Anthropic 兼容 API —— SDK 会自动追加 /v1/messages。
				baseUrl: "https://api.fireworks.ai/inference",
				// Fireworks 的 prompt cache 依赖自动前缀匹配 + 会话亲和：
				// x-session-affinity 把请求路由到同一副本以命中缓存；
				// 不支持工具上的 cache_control 与 eager_input_streaming。
				// 参见：https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
				compat: anthropicCompat,
			});
		}
		recordModelsDevReasoningOptions("fireworks", modelId, model);
	}

	return models;
}

// ========== models.dev 主目录的拉取与转换 ==========

/**
 * 拉取 models.dev 主目录并逐 provider 转换成 Model 列表（流水线第 1-2 步的主体）。
 *
 * 每个 provider 块决定该目录条目映射到哪个 api / baseUrl / compat；并在此叠加
 * 手工修正：退役模型剔除（Bedrock inference profile、NVIDIA 黑名单、OpenAI 别名）、
 * gemini-*-latest 别名回填具体版本的元数据、NVIDIA 仅保留 NIM 在线模型、
 * Together / Baseten / Fireworks / OpenCode / Copilot / MiniMax / Kimi / Moonshot /
 * 小米 / 通义 Token Plan 等专属规则。仅保留支持 tool call 的模型。
 * 整体拉取失败时：strict 抛错，否则返回空列表。
 */
async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;

		const models: Model<any>[] = [];
		const nvidiaNimModelIds = data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();

		// 处理 Amazon Bedrock 模型
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS.has(modelId)) continue;

				let id = modelId;

				if (id.startsWith("ai21.jamba")) {
					// 这些模型在流式模式下不支持工具调用
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// 这些模型不支持系统消息
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(m.structured_output === true && { compat: { supportsStrictMode: true } }),
				});
				recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
			}
		}

		// 处理 Anthropic 官方模型
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("anthropic", modelId, m);
			}
		}

		// 处理 Google Gemini（AI Studio）模型；*-latest 别名回填具体版本的元数据
		if (data.google?.models) {
			for (const [modelId, model] of Object.entries(data.google.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				let source = m;
				if (modelId === "gemini-flash-latest") {
					source = (data.google.models["gemini-3.5-flash"] as ModelsDevModel | undefined) ?? m;
				}
				if (modelId === "gemini-flash-lite-latest") {
					source = (data.google.models["gemini-3.1-flash-lite"] as ModelsDevModel | undefined) ?? m;
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-generative-ai",
					provider: "google",
					baseUrl: "https://generativelanguage.googleapis.com/v1beta",
					reasoning: source.reasoning === true,
					input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: source.cost?.input || 0,
						output: source.cost?.output || 0,
						cacheRead: source.cost?.cache_read || 0,
						cacheWrite: source.cost?.cache_write || 0,
					},
					contextWindow: source.limit?.context || 4096,
					maxTokens: source.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("google", modelId, source);
			}
		}

		// 处理 Google Vertex Gemini 模型。models.dev 的 google-vertex 目录还包含
		// Claude、OpenAI 等 MaaS 模型，但它们不走我们 google-vertex provider 实现的
		// @google/genai Gemini 流式路径，因此只保留 gemini- 前缀条目。
		if (data["google-vertex"]?.models) {
			for (const [modelId, model] of Object.entries(data["google-vertex"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!modelId.startsWith("gemini-")) continue;
				if (modelId === "gemini-3.1-flash-lite-preview") continue;
				let source = m;
				if (modelId === "gemini-flash-latest") {
					source = (data["google-vertex"].models["gemini-3.5-flash"] as ModelsDevModel | undefined) ?? m;
				}
				if (modelId === "gemini-flash-lite-latest") {
					source = (data["google-vertex"].models["gemini-3.1-flash-lite"] as ModelsDevModel | undefined) ?? m;
				}

				// models.dev 上 Gemini 2.5 Flash 的 cache_read/cache_write 与官方 Gemini API
				// 标准定价表不符。pi 只把 cachedContentTokenCount 计为 cacheRead。
				const cacheRead = modelId === "gemini-2.5-flash" ? 0.03 : source.cost?.cache_read || 0;
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "google-vertex",
					provider: "google-vertex",
					baseUrl: VERTEX_BASE_URL,
					reasoning: source.reasoning === true,
					input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: source.cost?.input || 0,
						output: source.cost?.output || 0,
						cacheRead,
						cacheWrite: 0,
					},
					contextWindow: source.limit?.context || 4096,
					maxTokens: source.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("google-vertex", modelId, source);
			}
		}

		// 处理 OpenAI 官方模型
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev 收录了这个别名，但 OpenAI API 并不接受。
				if (MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS.has(modelId)) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("openai", modelId, m);
			}
		}

		// 处理 Groq 模型
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("groq", modelId, m);
			}
		}

		// 处理 Cerebras 模型
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("cerebras", modelId, m);
			}
		}

		// 处理 Cloudflare Workers AI 模型
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-workers-ai", modelId, m);
			}
		}

		// 处理 Cloudflare AI Gateway 模型：按「上游/原生 id」前缀分流到
		// OpenAI / Anthropic / Workers AI 三种端点形态
		const cloudflareAIGatewayModelIds = new Set<string>();
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					id = nativeId;
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// 网关透传时，对使用会话亲和做缓存 / 路由的上游转发 session affinity 头。
				const compat =
					upstream === "anthropic" || upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				cloudflareAIGatewayModelIds.add(id);
				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// models.dev 的 AI Gateway provider 列表可能漏掉 Workers AI 透传模型，
		// 但网关的 /compat 端点其实支持路由到它们。这里把 Workers AI 目录按
		// 文档规定的 workers-ai/ 前缀镜像一份，保证 /compat 的 OpenAI 兼容
		// 模型集合稳定。
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const id = `workers-ai/${modelId}`;
				if (cloudflareAIGatewayModelIds.has(id)) continue;
				cloudflareAIGatewayModelIds.add(id);

				models.push({
					id,
					name: m.name || id,
					api: "openai-completions",
					provider: "cloudflare-ai-gateway",
					baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// 处理 xAI 模型
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					compat: { ...XAI_RESPONSES_COMPAT },
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("xai", modelId, m);
			}
		}

		models.push(...processZaiModels(data));

		// 处理 Mistral 模型（cache_read 缺省时按 input 的 10% 估算）
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read ?? (m.cost?.input ? roundCost(m.cost.input * 0.1) : 0),
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("mistral", modelId, m);
			}
		}

		// 处理 Hugging Face 路由模型
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("huggingface", modelId, m);
			}
		}

		models.push(...processFireworksModels(data["fireworks-ai"]));

		// 处理 NVIDIA NIM 模型：仅保留文本进出、且存在于 NIM 在线列表的模型
		if (data.nvidia?.models) {
			for (const [modelId, model] of Object.entries(data.nvidia.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!m.modalities?.input?.includes("text")) continue;
				if (!m.modalities?.output?.includes("text")) continue;

				const liveModelId = nvidiaNimModelIds.get(modelId) ?? nvidiaNimModelIds.get(normalizeNvidiaModelId(modelId));
				if (!liveModelId) continue;
				if (NVIDIA_NIM_UNSUPPORTED_MODELS.has(liveModelId)) continue;

				models.push({
					id: liveModelId,
					name: m.name || liveModelId,
					api: "openai-completions",
					provider: "nvidia",
					baseUrl: NVIDIA_BASE_URL,
					headers: { ...NVIDIA_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities.input.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: NVIDIA_OPENAI_COMPAT,
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("nvidia", liveModelId, m);
			}
		}

		// 处理 Together AI 模型（compat / 档位由上方 Together 专属函数选择）
		const togetherProvider = data.together ?? data.togetherai ?? data["together-ai"];
		if (togetherProvider?.models) {
			for (const [modelId, model] of Object.entries(togetherProvider.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const reasoning = m.reasoning === true;
				const thinkingLevelMap = getTogetherThinkingLevelMap(modelId, reasoning);
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "together",
					baseUrl: TOGETHER_BASE_URL,
					reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: getTogetherCompat(modelId, reasoning),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("together", modelId, m);
			}
		}

		models.push(...processBasetenModels(data.baseten));

		// 处理 OpenCode 模型（Zen 与 Go 两个变体）。
		// API 映射依据 provider.npm 字段：
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/zen" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/zen/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/v1`;
					compat = { sessionAffinityFormat: "openai-nosession" };
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK 会自动在 baseURL 后追加 /v1/messages
					baseUrl = variant.basePath;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null、undefined 或 @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
				}

				if (variant.provider === "opencode" && modelId === "grok-build-0.1") {
					compat = { ...(compat ?? {}), supportsReasoningEffort: false };
				}

				if ((variant.provider === "opencode" || variant.provider === "opencode-go") && modelId === "kimi-k2.6") {
					// OpenCode 的 Kimi K2.6 接受 Anthropic 风格的 thinking 对象，
					// 拒绝字符串形式的 thinking 值或组合的 reasoning_effort。
					compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
				}

				// 修正 models.dev 的 npm 数据与 OpenCode Go 端点实际行为之间的已知错配。
				// models.dev 把这些模型标为 @ai-sdk/anthropic，但 OpenCode Go 端点要么
				// 不接受 Anthropic SDK 鉴权（MiniMax M2.7），要么实际通过 OpenAI 兼容的
				// /v1/chat/completions 路径提供服务（Qwen 3.5/3.6）。统一切到
				// openai-completions，让请求走 Bearer 鉴权与标准端点。
				if (variant.provider === "opencode-go") {
					if (modelId === "minimax-m2.7") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
					}
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
						// Qwen/DashScope 的 enable_thinking 是顶层参数。
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				if (api === "openai-completions") {
					compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
					if (
						OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(
							`${variant.provider}:${modelId}`,
						)
					) {
						compat = { ...compat, supportsLongCacheRetention: false };
					}
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(variant.provider, modelId, m);
			}
		}

		// 处理 GitHub Copilot 模型
		if (data["github-copilot"]?.models) {
			for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				// Claude 4.x / 5.x 模型路由到 Anthropic Messages API
				const isCopilotClaude = /^claude-(haiku|sonnet|opus)-[45]([.\-]|$)/.test(modelId);
				// Grok、gpt-5、oswe 与 MAI-Code 模型只通过 Copilot 的 /responses 端点提供。
				const needsResponsesApi =
					modelId.startsWith("grok-") ||
					modelId.startsWith("gpt-5") ||
					modelId.startsWith("oswe") ||
					modelId.startsWith("mai-");

				const api: Api = isCopilotClaude
					? "anthropic-messages"
					: needsResponsesApi
						? "openai-responses"
						: "openai-completions";

				const anthropicCompat =
					api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

				const copilotModel: Model<any> = {
					id: modelId,
					name: m.name || modelId,
					api,
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 128000,
					maxTokens: m.limit?.output || 8192,
					headers: { ...COPILOT_STATIC_HEADERS },
					...(anthropicCompat ? { compat: anthropicCompat } : {}),
					// 这段 compat 仅适用于 openai-completions 形态
					...(api === "openai-completions" ? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					} : {}),
				};

				models.push(copilotModel);
				recordModelsDevReasoningOptions("github-copilot", modelId, m);
			}
		}

		// 处理 MiniMax 模型（国际 / 国内两个变体，走 Anthropic 兼容端点）
		const minimaxVariants = [
			{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
			{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
		] as const;

		for (const { key, provider, baseUrl } of minimaxVariants) {
			if (data[key]?.models) {
				for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						// MiniMax 的 Anthropic 兼容 API —— SDK 会自动追加 /v1/messages
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
					recordModelsDevReasoningOptions(provider, modelId, m);
				}
			}
		}

		// 处理 Kimi For Coding（订阅制编程套餐，Anthropic 兼容端点）模型
		if (data["kimi-for-coding"]?.models) {
			const kimiModels = data["kimi-for-coding"].models as Record<string, ModelsDevModel>;
			const hasCanonicalModel = Object.prototype.hasOwnProperty.call(kimiModels, "kimi-for-coding");

			const kimiAliases = new Set(["k2p5", "k2p6", "k2p7"]);

			for (const [modelId, model] of Object.entries(kimiModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev 可能暴露带版本的别名（如 k2p5/k2p6/k2p7）。
				// 把别名归一到规范模型 id；规范 id 已存在时直接丢弃重复项。
				if (kimiAliases.has(modelId) && hasCanonicalModel) continue;

				const normalizedId = kimiAliases.has(modelId) ? "kimi-for-coding" : modelId;
				const normalizedName = kimiAliases.has(modelId) ? "Kimi For Coding" : m.name || normalizedId;
				const isKimiK3 = normalizedId === "k3";
				const allowEmptySignature = isKimiK3 || normalizedId === "kimi-for-coding";
				const impliedCost = KIMI_CODING_IMPLIED_COSTS[normalizedId];

				models.push({
					id: normalizedId,
					name: normalizedName,
					api: "anthropic-messages",
					provider: "kimi-coding",
					// Kimi For Coding 的 Anthropic 兼容 API —— SDK 会自动追加 /v1/messages
					baseUrl: "https://api.kimi.com/coding",
					compat: {
						...(allowEmptySignature ? { allowEmptySignature: true } : {}),
						forceAdaptiveThinking: true,
					},
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || impliedCost?.input || 0,
						output: m.cost?.output || impliedCost?.output || 0,
						cacheRead: m.cost?.cache_read || impliedCost?.cacheRead || 0,
						cacheWrite: m.cost?.cache_write || impliedCost?.cacheWrite || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("kimi-coding", normalizedId, m);
			}
		}

		// 处理 Moonshot AI 模型（国际 / 国内两个变体，OpenAI 兼容端点；
		// Kimi K3 需要 deepseek 式 thinking content、kimi 式延迟工具与 effort 支持）
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const moonshotCompat: OpenAICompletionsCompat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
		};
		const getMoonshotProviderModels = (key: "moonshotai" | "moonshotai-cn"): Record<string, ModelsDevModel> => {
			const providerModels = data[key]?.models as Record<string, ModelsDevModel> | undefined;
			return providerModels ? { ...providerModels } : {};
		};
		const moonshotModels = {
			moonshotai: getMoonshotProviderModels("moonshotai"),
			"moonshotai-cn": getMoonshotProviderModels("moonshotai-cn"),
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			for (const [modelId, m] of Object.entries(moonshotModels[key])) {
				if (m.tool_call !== true) continue;

				const isKimiK3 = modelId === "kimi-k3";
				const compat = isKimiK3 ? { ...moonshotCompat } : moonshotCompat;
				if (isKimiK3) {
					compat.requiresReasoningContentOnAssistantMessages = true;
					compat.deferredToolsMode = "kimi";
					compat.thinkingFormat = "openai";
					compat.supportsReasoningEffort = true;
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || (isKimiK3 ? KIMI_K3_COST.input : 0),
						output: m.cost?.output || (isKimiK3 ? KIMI_K3_COST.output : 0),
						cacheRead: m.cost?.cache_read || (isKimiK3 ? KIMI_K3_COST.cacheRead : 0),
						cacheWrite: m.cost?.cache_write || (isKimiK3 ? KIMI_K3_COST.cacheWrite : 0),
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// 处理小米 MiMo 模型。
		// 内置 `xiaomi` 指向 API 计费端点（单一稳定 URL，密钥来自
		// platform.xiaomimimo.com）；三个 `xiaomi-token-plan-*` provider 覆盖
		// cn / ams / sgp 的预付费 Token Plan 端点。
		const xiaomiCompat: OpenAICompletionsCompat = {
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		};
		const xiaomiVariants = [
			{ source: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
			{
				source: "xiaomi-token-plan-cn",
				provider: "xiaomi-token-plan-cn",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-ams",
				provider: "xiaomi-token-plan-ams",
				baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-sgp",
				provider: "xiaomi-token-plan-sgp",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		] as const;

		for (const { source, provider, baseUrl } of xiaomiVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: xiaomiCompat,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// 处理阿里云百炼 Model Studio 的 Token Plan 模型。国际站与中国站使用
		// 各自的端点和 API 密钥（sk-sp- 前缀）。个人版（Individual）复用国际站的
		// 数据源与端点，但目录更窄（白名单见上方 QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS）。
		// models.dev 的 key 是 "alibaba-token-plan[-cn]"；pi 以
		// "qwen-token-plan[-cn]" 暴露，另加 Individual 目录视图。
		const qwenTokenPlanCompat: OpenAICompletionsCompat = {
			thinkingFormat: "qwen",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
		};
		const qwenTokenPlanVariants = [
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: undefined,
			},
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan-individual",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
			},
			{
				source: "alibaba-token-plan-cn",
				provider: "qwen-token-plan-cn",
				baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: undefined,
			},
		] as const;

		for (const { source, provider, baseUrl, modelIds } of qwenTokenPlanVariants) {
			const providerModels = data[source]?.models;
			const emittedModelIds = modelIds ? new Set<string>() : undefined;

			for (const [modelId, model] of Object.entries(providerModels ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS.has(modelId)) continue;
				if (modelIds && !modelIds.has(modelId)) continue;
				const supportsReasoningEffort = !QWEN_TOKEN_PLAN_REASONING_EFFORT_UNSUPPORTED_MODEL_IDS.has(modelId);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: supportsReasoningEffort
						? qwenTokenPlanCompat
						: { ...qwenTokenPlanCompat, supportsReasoningEffort: false },
					...(supportsReasoningEffort
						? {
								thinkingLevelMap:
									modelId === "qwen3.8-max"
										? QWEN_TOKEN_PLAN_QWEN38_THINKING_LEVEL_MAP
										: QWEN_TOKEN_PLAN_HIGH_MAX_THINKING_LEVEL_MAP,
							}
						: {}),
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				emittedModelIds?.add(modelId);
				recordModelsDevReasoningOptions(provider, modelId, m);
			}

			if (modelIds && emittedModelIds && generatorOptions.strict) {
				assertExactModelIds(provider, modelIds, emittedModelIds);
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

// ========== 主流程：合并、修正、补齐、元数据加工与输出渲染 ==========

/**
 * 生成器主流程（自上而下即流水线顺序）：
 * 拉取三个数据源 → 合并去重 → 临时覆盖（窗口/定价）→ 补齐缺失模型 →
 * 统一元数据加工 → 按 provider 分组 → 暂存并校验后原子写入产出文件。
 * 任一步骤失败都会回滚已写入的 TS 分片 / 聚合器与 JSON 数据目录。
 */
async function generateModels() {
	// 从三个数据源拉取模型：
	// models.dev：Anthropic、Google、OpenAI、Groq、Cerebras 等；
	// OpenRouter：xAI 及其他 provider（不含 Anthropic / Google / OpenAI）；
	// AI Gateway：支持工具调用的 OpenAI 兼容目录。
	const modelsDevModels = await loadModelsDevData();
	const openRouterModels = await fetchOpenRouterModels();
	const aiGatewayModels = await fetchAiGatewayModels();

	// 合并三个来源（models.dev 优先），并剔除已知不需要内置的模型
	const allModels = [...modelsDevModels, ...openRouterModels, ...aiGatewayModels].filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);

	// ---- 临时覆盖：在上游模型元数据被修正之前手工钉住的值 ----
	for (const candidate of allModels) {
		if (candidate.provider === "github-copilot" && GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS.has(candidate.id)) {
			candidate.contextWindow = 1000000;
		}

		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode 把 Claude Sonnet 4/4.5 标成 1M 上下文，实际限制是 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// 默认让直连 OpenAI 的请求停留在短上下文计价档。用户可以通过模型覆盖项
		// 主动选择更大上下文，因此封顶模型上仍保留长上下文的成本分档元数据。
		if (candidate.provider === "openai" && OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS.has(candidate.id)) {
			candidate.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
			candidate.maxTokens = 128000;
		}
		if (candidate.provider === "openai" && OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(candidate.id)) {
			const standardCost = OPENAI_GPT_56_STANDARD_COSTS[candidate.id];
			candidate.cost = withOpenAiLongContextPricing(standardCost ?? candidate.cost);
		}
		// Cloudflare AI Gateway 按 OpenAI 目录价透传 OpenAI 用量计费。
		if (candidate.provider === "cloudflare-ai-gateway") {
			const standardCost = OPENAI_GPT_56_STANDARD_COSTS[candidate.id];
			if (standardCost) candidate.cost = withOpenAiLongContextPricing(standardCost);
		}
		// models.dev 把 gpt-5-pro 的输出报成 272000（误抄了输入子限值），
		// 实际最大输出是 128000。该修正也会传导到派生的 Azure 克隆模型。
		if (candidate.provider === "openai" && candidate.id === "gpt-5-pro") {
			candidate.maxTokens = 128000;
		}
		// 网关元数据缺失或不正确时，钉住 Kimi K3 的规范输出上限。
		if (
			(candidate.provider === "openrouter" && OPENROUTER_KIMI_K3_MODEL_IDS.has(candidate.id)) ||
			(candidate.provider === "vercel-ai-gateway" && candidate.id === "moonshotai/kimi-k3")
		) {
			candidate.maxTokens = KIMI_K3_MAX_TOKENS;
		}
		// 在上游稳定之前，钉住部分 OpenRouter 模型的元数据（Kimi K2.5 定价 / K2.6 compat / GLM-5 定价）。
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id.startsWith("moonshotai/kimi-k2.6")) {
			candidate.compat = {
				...candidate.compat,
				supportsDeveloperRole: false,
				requiresReasoningContentOnAssistantMessages: true,
			};
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}
	}

	// ---- 补齐 models.dev 尚未收录 / 收录有误的模型 ----

	// 补齐缺失的 OpenAI GPT 模型（GPT-5.6 三兄弟 + gpt-5-chat-latest），已存在则跳过
	const missingOpenAiModels: Model<"openai-responses">[] = [
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_56_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_56_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		},
	];
	for (const model of missingOpenAiModels) {
		if (!allModels.some((m) => m.provider === model.provider && m.id === model.id)) {
			allModels.push(model);
		}
	}

	// 追加 DeepSeek V4 直连模型（models.dev 缺失）：Flash / Flash Vision 实验版 / Pro
	const deepseekCompat: OpenAICompletionsCompat = {
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
	const deepseekV4Models: Model<"openai-completions">[] = [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.14,
				output: 0.28,
				cacheRead: 0.0028,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
		{
			id: "deepseek-v4-flash-vision-exp",
			name: "DeepSeek V4 Flash Vision Exp",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.14,
				output: 0.28,
				cacheRead: 0.0028,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.435,
				output: 0.87,
				cacheRead: 0.003625,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
	];
	allModels.push(...deepseekV4Models);

	// 追加 AntLing 直连模型（models.dev 缺失）：Ling 2.6 两档 + 常推理的 Ring 2.6
	const antLingCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsLongCacheRetention: false,
	};
	const antLingModels: Model<"openai-completions">[] = [
		{
			id: "Ling-2.6-flash",
			name: "Ling 2.6 Flash",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ling-2.6-1T",
			name: "Ling 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ring-2.6-1T",
			name: "Ring 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: { ...antLingCompat, thinkingFormat: "ant-ling" },
		},
	];
	allModels.push(...antLingModels);

	// 为所有 provider 上的 deepseek-v4 系列统一 DeepSeek 兼容行为；
	// openrouter / opencode 自身已正确处理原生 effort，只补 thinking content 要求
	for (const candidate of allModels) {
		if (
			candidate.api === "openai-completions" &&
			candidate.id.includes("deepseek-v4") &&
			!QWEN_TOKEN_PLAN_PROVIDER_IDS.has(candidate.provider)
		) {
			const preservesNativeReasoningEffort = candidate.provider === "openrouter" || candidate.provider === "opencode";
			candidate.compat = {
				...candidate.compat,
				...(preservesNativeReasoningEffort
					? {
							requiresReasoningContentOnAssistantMessages:
								deepseekCompat.requiresReasoningContentOnAssistantMessages,
						}
					: deepseekCompat),
			};
		}
	}

	// MiniMax 直连（minimax / minimax-cn）仅保留这批受支持 ID，其余从目录剔除
	const minimaxDirectSupportedIds = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3"]);

	for (let i = allModels.length - 1; i >= 0; i--) {
		const candidate = allModels[i];
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			!minimaxDirectSupportedIds.has(candidate.id)
		) {
			allModels.splice(i, 1);
		}
	}

	// OpenAI Codex（ChatGPT OAuth）模型。
	// 注意：这些不来自 models.dev；保留一份小而明确的清单以避开别名。
	// 旧模型的限额来自观测到的服务端行为；GPT-5.6 遵循 Codex 272k 目录限额（曾是 372k）。
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_GPT_56_CONTEXT = 272000;
	const CODEX_SPARK_CONTEXT = 128000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_SPARK_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 }),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.4-mini",
			name: "GPT-5.4 mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_56_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 }),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_56_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	allModels.push(...codexModels);

	// 在 models.dev 收录之前，先补上 Mistral Medium 3.5
	if (!allModels.some(m => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// 为 openrouter/auto 补一个 "auto" 别名（由 OpenRouter 自动路由）
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// 定价未知：OpenRouter auto 会路由到不同模型并按实际使用的模型计费
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// 为 openrouter/fusion 补 "fusion" 别名。OpenRouter 把 Fusion 暴露为路由
	// 别名 / 插件入口；其模型元数据未声明工具支持，但该别名会解析到能调用
	// 调用方工具的具体模型，并自动注入 openrouter:fusion 服务端工具。
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "openrouter/fusion")) {
		allModels.push({
			id: "openrouter/fusion",
			name: "OpenRouter: Fusion",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				// 定价未知：Fusion 会路由到多个模型并按实际使用的模型计费
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 30000,
		});
	}

	// Azure Foundry 部署的这些模型上下文窗口比 OpenAI 自家的短档默认值更大。
	// 参见 models-sold-directly-by-azure 文档。
	const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
		"gpt-5.4": 1050000,
		"gpt-5.5": 1050000,
		"gpt-5.6-luna": 1050000,
		"gpt-5.6-sol": 1050000,
		"gpt-5.6-terra": 1050000,
	};
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "",
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
	allModels.push(...azureOpenAiModels);

	// ---- 元数据加工：统一应用各 apply*Metadata 修正 ----
	for (const model of allModels) {
		applyOpenAICompletionsCompatMetadata(model);
		applyAnthropicMessagesCompatMetadata(model);
		applyModelsDevReasoningOptionMetadata(model);
		applyThinkingLevelMetadata(model);
		applyStrictToolCompatMetadata(model);
		applyOpenAIGrammarToolCompatMetadata(model);
		applyOpenAIToolSearchMetadata(model);
		applyOpenAIExplicitPromptCacheMetadata(model);
	}
	applyAnthropicAllowedFallbackModelMetadata(allModels.filter(isAnthropicFallbackMetadataModel));

	// 按 provider 分组，并以模型 id 为 key 自动去重
	const providers: Record<string, Record<string, Model<any>>> = {};
	for (const model of allModels) {
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		// 以模型 id 为 key 自动去重；
		// 仅在尚未存在时写入（models.dev 优先于 OpenRouter）
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	const sortedProviderIds = Object.keys(providers).sort();
	const jsonProviders: Record<string, Record<string, Model<any>>> = {};
	for (const providerId of sortedProviderIds) {
		jsonProviders[providerId] = {};
		for (const modelId of Object.keys(providers[providerId]).sort()) {
			jsonProviders[providerId][modelId] = providers[providerId][modelId];
		}
	}

	// 统一序列化（--pretty 时带缩进，始终以换行结尾）与写文件辅助
	const serializeJson = (value: unknown) => `${JSON.stringify(value, null, generatorOptions.pretty ? 2 : undefined)}\n`;
	const writeJson = (path: string, value: unknown) => writeFileSync(path, serializeJson(value));
	// --data-only 模式沿用磁盘上已有的 provider 清单；否则用本次全量清单。
	// 水合时若磁盘清单里有本次未产出的 provider，直接报错。
	const generatedDataProviderIds = generatorOptions.dataOnly
		? readModelDataProviderIds(packageRoot)
		: sortedProviderIds;
	const missingProviderIds = generatedDataProviderIds.filter((providerId) => !jsonProviders[providerId]);
	if (missingProviderIds.length > 0) {
		throw new Error(`Cannot hydrate missing providers: ${missingProviderIds.join(", ")}`);
	}

	// 仅供 gitignored 内部数据按 API 再分组以推导类型；公开的 JSON 目录输出保持平铺。
	const generatedDataProviders: Record<string, Record<string, Record<string, Model<Api>>>> = {};
	const modelDataStructure: ModelDataStructure = {};
	for (const providerId of generatedDataProviderIds) {
		const models = jsonProviders[providerId];
		generatedDataProviders[providerId] = {};
		modelDataStructure[providerId] = {};
		const apiIds = Array.from(new Set(Object.values(models).map((model) => model.api))).sort();
		for (const api of apiIds) {
			generatedDataProviders[providerId][api] = {};
			for (const [modelId, model] of Object.entries(models)) {
				if (model.api !== api) continue;
				generatedDataProviders[providerId][api][modelId] = model;
				modelDataStructure[providerId][modelId] = api;
			}
		}
	}

	const generatedAt = new Date().toISOString();

	// ---- 输出渲染（非 --json-only 模式）：暂存 → 校验 → 原子替换 ----
	if (!generatorOptions.jsonOnly) {
		// 先把所有 provider 数据写入临时目录并校验，全部通过后才替换现有生成数据，
		// 避免半途失败把 src/providers/data/ 留在损坏状态。
		const providersDir = join(packageRoot, "src/providers");
		const dataDir = join(providersDir, "data");
		const stagingRoot = mkdtempSync(join(providersDir, ".model-generation-"));
		const stagedDataDir = join(stagingRoot, "data");
		const previousDataDir = join(stagingRoot, "previous-data");
		let restoreGeneratedCatalog: (() => void) | undefined;
		try {
			mkdirSync(stagedDataDir, { recursive: true });
			const fileContents: Record<string, string> = {};
			for (const providerId of generatedDataProviderIds) {
				const filename = `${providerId}.json`;
				const content = serializeJson(generatedDataProviders[providerId]);
				fileContents[filename] = content;
				writeFileSync(join(stagedDataDir, filename), content);
			}
			writeJson(
				join(stagedDataDir, MODEL_DATA_MANIFEST_FILE),
				createModelDataManifest(modelDataStructure, fileContents, generatedAt),
			);
			validateModelDataDirectory(modelDataStructure, stagedDataDir);

			// 非 --data-only：生成 TS 分片与聚合器。
			// 先快照现有分片与聚合器内容，失败时用于回滚。
			if (!generatorOptions.dataOnly) {
				const previousShardContents = new Map(
					readdirSync(providersDir)
						.filter((entry) => entry.endsWith(".models.ts"))
						.map((entry) => [entry, readFileSync(join(providersDir, entry), "utf8")] as const),
				);
				// 聚合器 src/models.generated.ts 的路径
				const aggregatorPath = join(packageRoot, "src/models.generated.ts");
				const previousAggregator = readFileSync(aggregatorPath, "utf8");
				restoreGeneratedCatalog = () => {
					for (const entry of readdirSync(providersDir)) {
						if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
					}
					for (const [entry, content] of previousShardContents) {
						writeFileSync(join(providersDir, entry), content);
					}
					writeFileSync(aggregatorPath, previousAggregator);
				};

				const generatedHeader = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

`;
				const catalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
				const generatedShardFiles = new Set<string>();
				for (const providerId of sortedProviderIds) {
					let output = generatedHeader;
					output += `import values from "./data/${providerId}.json" with { type: "json" };\n`;
					output += `import { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";\n\n`;
					output += `export const ${catalogConstName(providerId)}: ModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenModelCatalog(${JSON.stringify(providerId)}, values);\n`;
					const filename = `${providerId}.models.ts`;
					generatedShardFiles.add(filename);
					writeFileSync(join(providersDir, filename), output);
				}
				for (const entry of readdirSync(providersDir)) {
					if (entry.endsWith(".models.ts") && !generatedShardFiles.has(entry)) rmSync(join(providersDir, entry));
				}

				let output = generatedHeader;
				for (const providerId of sortedProviderIds) {
					output += `import { ${catalogConstName(providerId)} } from "./providers/${providerId}.models.ts";\n`;
				}
				output += `\nexport const MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${catalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${catalogConstName(providerId)},\n`;
				}
				output += `};\n`;
				writeFileSync(aggregatorPath, output);
				console.log("Generated provider catalogs and src/models.generated.ts");
			}

			// 原子替换 JSON 数据目录：旧目录先挪走，新目录就位并校验，
			// 出错则删新还原旧。
			const hadPreviousData = existsSync(dataDir);
			if (hadPreviousData) renameSync(dataDir, previousDataDir);
			try {
				renameSync(stagedDataDir, dataDir);
				validateGeneratedModelData(packageRoot);
			} catch (error) {
				rmSync(dataDir, { recursive: true, force: true });
				if (hadPreviousData && existsSync(previousDataDir)) renameSync(previousDataDir, dataDir);
				throw error;
			}
			restoreGeneratedCatalog = undefined;
			console.log(
				generatorOptions.dataOnly
					? "Hydrated JSON model values under src/providers/data/"
					: "Generated JSON model values under src/providers/data/",
			);
		} catch (error) {
			restoreGeneratedCatalog?.();
			throw error;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	// ---- 可选输出：纯 JSON 目录（--json-output） ----
	if (generatorOptions.jsonOutputDir) {
		const providerOutputDir = join(generatorOptions.jsonOutputDir, "providers");
		rmSync(generatorOptions.jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(generatorOptions.jsonOutputDir, "models.json"), jsonProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "providers.json"), sortedProviderIds);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonProviders[providerId]);
		}
		console.log(`Generated JSON model catalog under ${generatorOptions.jsonOutputDir}`);
	}

	// 打印统计信息（总数 / 推理模型数 / 各 provider 模型数）
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

// 执行入口：运行生成器，失败时打印错误并置非零退出码
generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
