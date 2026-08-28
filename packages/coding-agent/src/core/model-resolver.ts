/**
 * @file model-resolver.ts —— 模型引用解析、范围圈定与初始模型选择
 *
 * @description
 * 本文件负责把用户提供的各种「模型引用」解析为具体的 Model 对象，贯穿 CLI 启动到会话恢复：
 * - `defaultModelPerProvider`：每个已知 provider 的默认模型 ID 表，回退选型时按表内顺序优先；
 * - `findExactModelReferenceMatch` / `tryMatchModel` / `parseModelPattern`：
 *   单个引用的逐级解析——精确匹配 → provider/model 规范形式 → ID/名称模糊匹配，
 *   并从 "model:thinking" 后缀中提取思考级别；
 * - `resolveModelScope*` 三个函数：把 `--models` 模式列表（支持 glob 通配符）
 *   圈定为 ScopedModel 集合，供 Ctrl+P 在范围内循环切换模型；
 * - `resolveCliModel`：解析 CLI 的 --provider / --model / --thinking 组合，
 *   处理跨 provider 歧义、provider 推断与「自定义模型 ID」回退；
 * - `findInitialModel` / `restoreModelFromSession`：按优先级确定启动时的初始模型，
 *   以及从会话恢复模型失败时的逐级回退。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：Model / Api / KnownProvider 等模型目录类型与 modelsAreEqual 工具；
 * - `@earendil-works/pi-agent-core`：ThinkingLevel 思考级别类型；
 * - `../cli/args.ts`：思考级别合法性校验；`./model-runtime.ts`：模型运行时（目录、鉴权状态）；
 * - `./defaults.ts`：默认思考级别常量；`minimatch`：glob 匹配；`chalk`：终端着色输出。
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AuthOperationOptions,
	type KnownProvider,
	type Model,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRuntime } from "./model-runtime.ts";

/**
 * 每个已知 provider 的默认模型 ID 表。
 * 用途：一是自动回退选型时按表内顺序挑选（findInitialModel / restoreModelFromSession），
 * 二是 buildFallbackModel 构造自定义模型时选取元数据模板。
 */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	"ant-ling": "Ring-2.6-1T",
	anthropic: "claude-opus-4-8",
	openai: "gpt-5.5",
	"azure-openai-responses": "gpt-5.4",
	"openai-codex": "gpt-5.5",
	radius: "auto",
	nvidia: "nvidia/nemotron-3-super-120b-a12b",
	deepseek: "deepseek-v4-pro",
	google: "gemini-3.1-pro-preview",
	"google-vertex": "gemini-3.1-pro-preview",
	"github-copilot": "gpt-5.4",
	openrouter: "moonshotai/kimi-k2.6",
	"vercel-ai-gateway": "zai/glm-5.1",
	xai: "grok-4.6",
	groq: "openai/gpt-oss-120b",
	cerebras: "gpt-oss-120b",
	zai: "glm-5.3",
	"zai-coding-cn": "glm-5.3",
	mistral: "devstral-medium-latest",
	minimax: "MiniMax-M2.7",
	"minimax-cn": "MiniMax-M2.7",
	moonshotai: "kimi-k2.6",
	"moonshotai-cn": "kimi-k2.6",
	huggingface: "moonshotai/Kimi-K2.6",
	fireworks: "accounts/fireworks/models/kimi-k2p6",
	together: "moonshotai/Kimi-K2.6",
	baseten: "zai-org/GLM-5.2",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	"kimi-coding": "kimi-for-coding",
	"cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
	"cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
	"qwen-token-plan": "qwen3.7-max",
	"qwen-token-plan-cn": "qwen3.7-max",
	"qwen-token-plan-individual": "qwen3.8-max",
	xiaomi: "mimo-v2.5-pro",
	"xiaomi-token-plan-cn": "mimo-v2.5-pro",
	"xiaomi-token-plan-ams": "mimo-v2.5-pro",
	"xiaomi-token-plan-sgp": "mimo-v2.5-pro",
};

/**
 * 圈定范围（--models）中的单个模型条目：模型对象 + 可选思考级别。
 * 解析出的列表供 Ctrl+P 在范围内循环切换。
 */
export interface ScopedModel {
	/** 圈定到的模型对象 */
	model: Model<Api>;
	/** 模式中显式指定的思考级别（如 "model:high" 中的 high）；未指定时为 undefined */
	thinkingLevel?: ThinkingLevel;
}

/**
 * 判断模型 ID 是否为「别名」而非带日期后缀的具体版本。
 * 日期后缀的典型格式：-20241022 或 -20250929。
 */
function isAlias(id: string): boolean {
	// 以 -latest 结尾的一定是别名
	if (id.endsWith("-latest")) return true;

	// 不以日期模式（-YYYYMMDD，即 8 位数字）结尾的也视为别名
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * 查找与模型引用精确匹配的模型。
 * 支持裸模型 ID 或 "provider/modelId" 规范形式两种写法；
 * 用裸 ID 匹配时若命中多个 provider 下的同名模型，视为歧义并返回 undefined。
 *
 * @param modelReference - 模型引用（裸 ID 或 provider/modelId）
 * @param availableModels - 可供匹配的模型列表
 * @returns 唯一命中的模型；无命中或存在歧义时返回 undefined
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	// 去除首尾空白；空引用直接判为无匹配
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	// 统一转小写后比较，实现大小写不敏感匹配
	const normalizedReference = trimmedReference.toLowerCase();

	// ===== 第一步：按 "provider/modelId" 规范形式精确匹配 =====
	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	// 恰好命中一个即返回；命中多个说明目录里存在重复项，按歧义处理
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	// ===== 第二步：引用含斜杠时，拆成 provider 与 modelId 两段分别精确比对 =====
	// 额外容忍两段各自的多余空白（第一步的整串比较覆盖不了这种情况）
	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			// 命中唯一即返回；命中多个同样按歧义拒绝
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	// ===== 第三步：退回裸模型 ID 匹配；命中数不为 1（0 个或跨 provider 多个）都算失败 =====
	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * 尝试把一个模式匹配到可用模型列表中的某个模型（不含思考级别解析）。
 * 先走精确匹配，失败后退回 ID / 展示名的部分（模糊）匹配；找不到时返回 undefined。
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// 精确匹配失败 —— 退回部分匹配：模式作为子串出现在 ID 或展示名中即算命中
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// 把命中结果分成「别名」与「带日期的版本」两组
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// 优先取别名；多个别名并存时取字典序最大的（通常代表更新的模型）
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// 没有别名时取日期后缀最新的版本（YYYYMMDD 的字典序即时间序）
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

/** parseModelPattern 的解析结果：命中模型、可选思考级别与警告信息 */
export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** 模式中显式指定的思考级别；未指定（或指定不合法被忽略）时为 undefined */
	thinkingLevel?: ThinkingLevel;
	/** 供 CLI 展示的警告（如思考级别不合法而被忽略）；无警告时为 undefined */
	warning: string | undefined;
}

/**
 * 为「用户显式指定、但目录中不存在」的自定义模型 ID 构造回退 Model 对象。
 * 以该 provider 的默认模型（查不到则取其第一个模型）为模板，
 * 仅覆写 id / name，从而继承 api 等元数据；provider 名下没有任何模型时返回 undefined。
 */
function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	// 选元数据模板：优先默认表中的模型，其次该 provider 的第一个模型
	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * 解析模式字符串，提取模型与思考级别。
 * 兼容 ID 本身含冒号的模型（如 OpenRouter 的 :exacto 后缀）。
 *
 * 算法：
 * 1. 先尝试把整个模式当作模型来匹配；
 * 2. 命中则返回该模型（思考级别为 off）；
 * 3. 未命中且含冒号时，按最后一个冒号切分：
 *    - 后缀是合法思考级别 → 采用该级别，并对前缀递归解析；
 *    - 后缀不合法 → 视配置给出警告后对前缀递归（思考级别按 off 处理），或直接失败。
 *
 * @param pattern - 待解析的模式（可能是 "model"、"model:high" 等形式）
 * @param availableModels - 可供匹配的模型列表
 * @param options - allowInvalidThinkingLevelFallback 为 false 时进入严格模式（后缀不合法即失败）
 * @returns 解析结果（模型 + 思考级别 + 警告）
 * @internal 仅为测试而导出
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// 先尝试把整个模式当作模型整体匹配（精确 + 模糊）
	const exactMatch = tryMatchModel(pattern, availableModels);
	if (exactMatch) {
		return { model: exactMatch, thinkingLevel: undefined, warning: undefined };
	}

	// 整体未命中 —— 若含冒号则按最后一个冒号切分再试
	const lastColonIndex = pattern.lastIndexOf(":");
	if (lastColonIndex === -1) {
		// 没有冒号，说明该模式确实不匹配任何模型
		return { model: undefined, thinkingLevel: undefined, warning: undefined };
	}

	// 切出前缀（可能仍含冒号，交给递归继续剥）与后缀
	const prefix = pattern.substring(0, lastColonIndex);
	const suffix = pattern.substring(lastColonIndex + 1);

	if (isValidThinkingLevel(suffix)) {
		// 后缀是合法思考级别 —— 对前缀递归解析，并准备采用该级别
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			// 仅当内层递归没有产生警告（前缀被干净解析）时才采用该思考级别
			return {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		}
		return result;
	} else {
		// 后缀不是合法思考级别
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback) {
			// 严格模式（CLI --model 解析）：把后缀当作模型 ID 的一部分，直接判定失败。
			// 这样可避免意外解析到另一个不同的模型。
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		// 范围模式（--models 解析）：对前缀递归解析，并附带警告信息
		const result = parseModelPattern(prefix, availableModels, options);
		if (result.model) {
			return {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${pattern}". Using default instead.`,
			};
		}
		return result;
	}
}

/**
 * 把模式列表解析为带可选思考级别的实际 Model 对象集合（--models 范围圈定的总体说明）。
 * 格式："pattern:level"，其中 :level 可省略。
 * 每个模式会找出所有命中模型并挑选最佳版本：
 * 1. 优先取别名（如 claude-sonnet-4-5）而非带日期的版本（claude-sonnet-4-5-20250929）
 * 2. 没有别名时取日期最新的版本
 *
 * 兼容 ID 本身含冒号的模型（如 OpenRouter 的 model:exacto）：
 * 算法先尝试整体匹配，再逐层剥离冒号后缀继续尝试。
 */
/**
 * 范围解析过程中产生的单条诊断信息（当前只用于警告级别）。
 */
export interface ModelScopeDiagnostic {
	type: "warning";
	/** 诊断类别：模式无命中（no-match）或思考级别不合法（invalid-thinking-level） */
	code: "no-match" | "invalid-thinking-level";
	/** 供终端展示的警告文案 */
	message: string;
	/** 触发该诊断的原始模式 */
	pattern: string;
}

/** 范围解析结果：圈定到的模型列表 + 过程中产生的诊断（警告）列表 */
export interface ResolveModelScopeResult {
	/** 圈定到的模型列表（已去重、按模式出现顺序排列） */
	scopedModels: ScopedModel[];
	/** 解析过程中产生的警告列表 */
	diagnostics: ModelScopeDiagnostic[];
}

/**
 * 把 `--models` 的模式列表解析为圈定模型集合（纯同步版本，直接接收模型数组）。
 * 模式分两类：含 glob 通配符（* ? [）的走 minimatch 分支，其余走 parseModelPattern
 * 的精确 / 模糊 + 思考级别解析；无法匹配的模式不抛错，而是记为诊断警告后继续。
 *
 * @param patterns - `--models` 传入的模式列表（普通模式或 glob 模式）
 * @param models - 全量模型目录
 * @returns 圈定模型列表（已去重）与诊断信息
 */
export function resolveModelScopeFromModels(
	patterns: string[],
	models: readonly Model<Api>[],
): ResolveModelScopeResult {
	const availableModels = [...models];
	const scopedModels: ScopedModel[] = [];
	const diagnostics: ModelScopeDiagnostic[] = [];

	for (const pattern of patterns) {
		// ===== glob 分支：模式含通配符（*、?、[）时按 glob 语义匹配 =====
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// 先剥离可选的思考级别后缀（如 "provider/*:high" 中的 high）
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				// 仅当冒号后的后缀确是合法思考级别时才剥离，避免误吞 ID 自带的冒号后缀
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			// 边界情形：glob 串与某个模型引用完全相同时按精确匹配处理
			const exactMatch = findExactModelReferenceMatch(globPattern, availableModels);
			if (exactMatch) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, exactMatch))) {
					scopedModels.push({ model: exactMatch, thinkingLevel });
				}
				continue;
			}

			// 同时按 "provider/modelId" 完整形式与裸模型 ID 两种形式做 glob 匹配，
			// 这样 "*sonnet*" 不必写成 "anthropic/*sonnet*" 也能命中
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				// 一个模型都没命中：记警告后跳过该模式，不影响其余模式的解析
				diagnostics.push({
					type: "warning",
					code: "no-match",
					message: `No models match pattern "${pattern}"`,
					pattern,
				});
				continue;
			}

			// 命中的模型逐个入列（去重）
			for (const model of matchingModels) {
				if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		// ===== 普通（非 glob）模式：交给 parseModelPattern 统一解析 =====
		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			diagnostics.push({ type: "warning", code: "invalid-thinking-level", message: warning, pattern });
		}

		if (!model) {
			diagnostics.push({
				type: "warning",
				code: "no-match",
				message: `No models match pattern "${pattern}"`,
				pattern,
			});
			continue;
		}

		// 去重：避免同一模型被多个模式重复加入
		if (!scopedModels.find((sm) => modelsAreEqual(sm.model, model))) {
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return { scopedModels, diagnostics };
}

/**
 * 异步版范围解析：先经 ModelRuntime 拉取可用模型列表（必要时触发鉴权流程），
 * 再交给 resolveModelScopeFromModels 处理。
 * 诊断信息随结果返回，由调用方决定如何呈现。
 */
export async function resolveModelScopeWithDiagnostics(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ResolveModelScopeResult> {
	// getAvailable 的 provider 参数传 undefined 表示拉取全部 provider 的模型；options 透传鉴权流程配置
	return resolveModelScopeFromModels(patterns, await modelRuntime.getAvailable(undefined, options));
}

/**
 * 解析 `--models` 圈定范围，并把诊断警告直接以黄色 Warning 打印到终端，
 * 只返回圈定到的模型列表。适合不需要结构化诊断信息的调用方。
 */
export async function resolveModelScope(
	patterns: string[],
	modelRuntime: ModelRuntime,
	options?: AuthOperationOptions,
): Promise<ScopedModel[]> {
	const { scopedModels, diagnostics } = await resolveModelScopeWithDiagnostics(patterns, modelRuntime, options);
	// 警告逐条打印到 stderr，不中断启动流程
	for (const diagnostic of diagnostics) {
		console.warn(chalk.yellow(`Warning: ${diagnostic.message}`));
	}
	return scopedModels;
}

/** resolveCliModel 的解析结果：模型、可选思考级别，以及警告 / 错误信息 */
export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * 适合直接在 CLI 展示的错误信息。
	 * 一旦设置，model 必为 undefined。
	 */
	error: string | undefined;
}

/**
 * 从 CLI 参数（--provider / --model）解析出单个模型。
 *
 * 支持：
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>（由斜杠前缀推断 provider）
 * - 模糊匹配（规则与范围圈定一致：先精确 ID，再部分匹配 ID / 名称）
 *
 * 注意：本函数不会自行应用思考级别，但可能从 "<pattern>:<thinking>" 中
 * *解析*出思考级别并返回，由调用方负责实际应用。
 *
 * @param options.cliProvider - --provider 指定的 provider（可选）
 * @param options.cliModel - --model 指定的模型引用（可选；缺省时直接返回空结果）
 * @param options.cliThinking - --thinking 指定的思考级别（可选）
 * @param options.modelRuntime - 模型运行时，提供模型目录与鉴权状态查询
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	cliThinking?: ThinkingLevel;
	modelRuntime: ModelRuntime;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, cliThinking, modelRuntime } = options;

	// 未提供 --model 时无需解析，交由上层走默认选型流程
	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// 重要：这里必须用*全部*模型，而不是只用已配置鉴权的模型，
	// 否则首次配置时 "--api-key" 将无法匹配到任何模型。
	const availableModels = [...modelRuntime.getModels()];
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// 构建 provider 规范名映射（小写 → 原始大小写），实现大小写不敏感的 provider 匹配
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	// --provider 指向未知 provider 时直接报错（提示用 --list-models 查看可选项）
	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// 未显式指定 --provider 时，优先把 --model 解释为 "provider/model" 形式：
	// 当第一个斜杠前的片段恰是已知 provider 时优先采用这种解释，
	// 而不是去匹配 ID 中字面含斜杠的模型
	// （如 "zai/glm-5" 应解析为 provider=zai、model=glm-5，
	// 而不是 vercel-ai-gateway 下 ID 为 "zai/glm-5" 的模型）。
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			// 斜杠前的片段能对上已知 provider 时，才视为 provider/model 形式
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// 斜杠未能推断出 provider 时，先在不带 provider 的前提下做整体精确匹配，
	// 覆盖 ID 本身就含斜杠的模型（如 OpenRouter 风格的 ID）。
	// 裸精确 ID 可能同时存在于多个 provider，因此不能按目录顺序挑第一个：
	// 恰有一个已鉴权 provider 命中时优先选它；否则要求显式指定 provider，
	// 避免静默选中一个未鉴权（不可用）的 provider。
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exactMatches = availableModels.filter(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exactMatches.length === 1) {
			return { model: exactMatches[0], warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		if (exactMatches.length > 1) {
			// 多个 provider 命中：若其中恰好只有一个已鉴权，直接选它
			const authenticatedExactMatches = exactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
			if (authenticatedExactMatches.length === 1) {
				return {
					model: authenticatedExactMatches[0],
					warning: undefined,
					thinkingLevel: undefined,
					error: undefined,
				};
			}

			// 仍无法消歧：列出全部候选并按鉴权情况给出提示，交还用户决定
			const matches = exactMatches
				.map((m) => `${m.provider}/${m.id}`)
				.sort((a, b) => a.localeCompare(b))
				.join(", ");
			const authHint =
				authenticatedExactMatches.length === 0
					? "No matching provider is authenticated."
					: "More than one matching provider is authenticated.";
			return {
				model: undefined,
				warning: undefined,
				thinkingLevel: undefined,
				error: `Model "${cliModel}" is ambiguous across providers: ${matches}. ${authHint} Use --provider or provider/model.`,
			};
		}
	}

	if (cliProvider && provider) {
		// 两者同时提供时，容忍 --model 仍写成 <provider>/<pattern>：剥掉重复的 provider 前缀
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	// 已确定 provider 时只在该 provider 的模型里找，否则全量候选
	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;
	// 在候选范围内解析模式；严格模式下不允许「非法思考级别后缀」回退成别的模型
	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		// 若 provider 推断命中的是未鉴权的 provider/model 组合，则改选唯一的
		// 「按裸模型 ID 精确命中且已鉴权」的模型。这样 "provider/model" 语法在可用时
		// 依然优先，同时兜住模型 ID 以已知 provider 名开头的情况
		// （例如 commandcode 的模型 ID "xiaomi/mimo-v2.5-pro"）。
		if (inferredProvider) {
			const rawExactMatches = availableModels.filter(
				(m) => m.id.toLowerCase() === cliModel.toLowerCase() && !modelsAreEqual(m, model),
			);
			if (rawExactMatches.length > 0 && !modelRuntime.hasConfiguredAuth(model.provider)) {
				const authenticatedRawMatches = rawExactMatches.filter((m) => modelRuntime.hasConfiguredAuth(m.provider));
				if (authenticatedRawMatches.length === 1) {
					return {
						model: authenticatedRawMatches[0],
						thinkingLevel: undefined,
						warning: undefined,
						error: undefined,
					};
				}
			}
		}
		return { model, thinkingLevel, warning, error: undefined };
	}

	// 从斜杠推断出了 provider、但该 provider 下没有命中时，
	// 回退为把完整输入当作裸模型 ID 在全量模型中匹配。
	// 覆盖 OpenRouter 风格的 ID，如 "openai/gpt-4o:extended"：
	// "openai" 看似 provider，但整串其实是 openrouter 上的模型 ID。
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// 精确匹配也未命中时，再对完整输入在全量模型上跑一次 parseModelPattern（含模糊匹配）
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		// 构造回退模型前，先从模式里解析出思考级别后缀——
		// 但仅当未显式提供 --thinking 时才生效。
		// 例："zai-org/GLM-5.1-FP8:high" → modelId="zai-org/GLM-5.1-FP8"、fallbackThinking="high"
		let fallbackPattern = pattern;
		let fallbackThinking: ThinkingLevel | undefined;
		if (!cliThinking) {
			const lastColon = pattern.lastIndexOf(":");
			if (lastColon !== -1) {
				const suffix = pattern.substring(lastColon + 1);
				if (isValidThinkingLevel(suffix)) {
					fallbackPattern = pattern.substring(0, lastColon);
					fallbackThinking = suffix;
				}
			}
		}

		// 目录中不存在该模型时，以 provider 的默认模型为模板构造自定义模型对象
		const fallbackModel = buildFallbackModel(provider, fallbackPattern, availableModels);
		if (fallbackModel) {
			// 请求了思考级别（非 off）时为自定义模型打开 reasoning 能力
			const requestedThinking = cliThinking ?? fallbackThinking;
			const model =
				requestedThinking && requestedThinking !== "off" ? { ...fallbackModel, reasoning: true } : fallbackModel;
			// 警告里补充说明：模型未找到，已按自定义模型 ID 处理
			const fallbackWarning = warning
				? `${warning} Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`
				: `Model "${fallbackPattern}" not found for provider "${provider}". Using custom model id.`;
			return { model, thinkingLevel: fallbackThinking, warning: fallbackWarning, error: undefined };
		}
	}

	// 所有路径都失败：拼出可读的引用形式并返回错误
	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

/** findInitialModel 的结果：初始模型、其思考级别，以及发生回退时的说明信息 */
export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * 按优先级确定启动时要使用的初始模型：
 * 1. CLI 参数（--provider + --model）
 * 2. --models 圈定范围中的第一个模型（仅在非续接 / 恢复会话时）
 * 3. 从会话恢复的模型（仅续接 / 恢复会话时，由调用方另行处理）
 * 4. 设置中保存的默认模型
 * 5. 第一个持有有效 API key 的可用模型
 *
 * @param options.cliProvider / options.cliModel - CLI 显式指定的 provider 与模型
 * @param options.scopedModels - --models 圈定出的模型列表
 * @param options.isContinuing - 是否处于续接 / 恢复会话模式
 * @param options.defaultProvider / options.defaultModelId - 设置中保存的默认模型
 * @param options.defaultThinkingLevel - 设置中保存的默认思考级别
 * @param options.modelThinkingLevels - 按模型记录的思考级别覆盖表
 * @param options.modelRuntime - 模型运行时
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelThinkingLevels?: Record<string, ThinkingLevel>;
	modelRuntime: ModelRuntime;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelThinkingLevels,
		modelRuntime,
	} = options;

	// 以下按优先级逐级尝试；思考级别先取内置默认，各分支再按需覆盖
	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI 参数优先级最高；解析出错直接红字报错并退出进程
	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRuntime,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
		}
	}

	// 2. 取圈定范围（--models）的第一个模型；续接 / 恢复会话时跳过，
	//    以免覆盖会话中已恢复的模型
	if (scopedModels.length > 0 && !isContinuing) {
		const scopedModel = scopedModels[0];
		// 思考级别优先级：模式内显式指定 > 模型级设置 > 全局默认 > 内置默认
		const perModel = modelThinkingLevels?.[`${scopedModel.model.provider}/${scopedModel.model.id}`];
		return {
			model: scopedModel.model,
			thinkingLevel: scopedModel.thinkingLevel ?? perModel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. 尝试设置中保存的默认模型；模型必须存在且其 provider 已配置鉴权
	if (defaultProvider && defaultModelId) {
		const found = modelRuntime.getModel(defaultProvider, defaultModelId);
		if (found && modelRuntime.hasConfiguredAuth(found.provider)) {
			model = found;
			// 思考级别优先级：模型级设置 > 全局默认设置
			const perModel = modelThinkingLevels?.[`${defaultProvider}/${defaultModelId}`];
			if (perModel) {
				thinkingLevel = perModel;
			} else if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. 取第一个有有效 API key 的可用模型
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// 优先挑已知 provider 默认表中的模型，保证自动回退时选到相对合适的模型
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				return { model: match, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
			}
		}

		// 默认表未命中就直接用第一个可用模型
		return { model: availableModels[0], thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. 一个模型都找不到：返回 undefined，由调用方处理
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/**
 * 从会话记录恢复上次使用的模型；恢复失败时逐级回退：
 * 当前已有模型 → 已鉴权可用模型中默认表的命中项 → 第一个可用模型。
 *
 * @param savedProvider - 会话中保存的 provider 名
 * @param savedModelId - 会话中保存的模型 ID
 * @param currentModel - 调用方手头已有的模型（可选），恢复失败时优先用它兜底
 * @param shouldPrintMessages - 是否打印恢复 / 回退日志
 * @param modelRuntime - 模型运行时
 * @returns 恢复或回退后的模型，以及发生回退时的说明信息
 */
export async function restoreModelFromSession(
	savedProvider: string,
	savedModelId: string,
	currentModel: Model<Api> | undefined,
	shouldPrintMessages: boolean,
	modelRuntime: ModelRuntime,
): Promise<{ model: Model<Api> | undefined; fallbackMessage: string | undefined }> {
	const restoredModel = modelRuntime.getModel(savedProvider, savedModelId);

	// 模型必须仍存在于目录中，且其 provider 仍配置了鉴权，二者缺一即恢复失败
	const hasConfiguredAuth = restoredModel ? modelRuntime.hasConfiguredAuth(restoredModel.provider) : false;

	if (restoredModel && hasConfiguredAuth) {
		// 恢复成功：按需打印提示后直接返回
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Restored model: ${savedProvider}/${savedModelId}`));
		}
		return { model: restoredModel, fallbackMessage: undefined };
	}

	// 模型不存在或没有鉴权 —— 进入回退流程，并记录原因用于提示
	const reason = !restoredModel ? "model no longer exists" : "no auth configured";

	if (shouldPrintMessages) {
		console.error(chalk.yellow(`Warning: Could not restore model ${savedProvider}/${savedModelId} (${reason}).`));
	}

	// 手头已有模型（如 CLI 已解析出一个）时直接用它兜底
	if (currentModel) {
		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${currentModel.provider}/${currentModel.id}`));
		}
		return {
			model: currentModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${currentModel.provider}/${currentModel.id}.`,
		};
	}

	// 没有现成模型时，从已鉴权的可用模型中挑一个兜底
	const availableModels = [...modelRuntime.getAvailableSnapshot()];

	if (availableModels.length > 0) {
		// 优先挑已知 provider 默认表中的模型，保证回退质量
		let fallbackModel: Model<Api> | undefined;
		for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
			const defaultId = defaultModelPerProvider[provider];
			const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
			if (match) {
				fallbackModel = match;
				break;
			}
		}

		// 默认表未命中就用第一个可用模型
		if (!fallbackModel) {
			fallbackModel = availableModels[0];
		}

		if (shouldPrintMessages) {
			console.log(chalk.dim(`Falling back to: ${fallbackModel.provider}/${fallbackModel.id}`));
		}

		return {
			model: fallbackModel,
			fallbackMessage: `Could not restore model ${savedProvider}/${savedModelId} (${reason}). Using ${fallbackModel.provider}/${fallbackModel.id}.`,
		};
	}

	// 一个可用模型都没有：只能返回 undefined，由调用方处理
	return { model: undefined, fallbackMessage: undefined };
}
