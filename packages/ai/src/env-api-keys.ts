// 切勿改成顶层 import —— 会破坏浏览器/Vite 构建（NEVER convert to top-level imports）
/**
 * @file 环境变量 API Key 解析
 * @description 为各 provider 从环境变量中发现并读取 API Key：
 *   - 维护 provider → 密钥环境变量名的映射表（如 OPENAI_API_KEY、DEEPSEEK_API_KEY）
 *   - findEnvKeys：报告哪些候选环境变量已配置（用于状态展示）
 *   - getEnvApiKey：实际取出密钥值；对 google-vertex（ADC 应用默认凭据）与
 *     amazon-bedrock（多种 AWS 凭据来源）额外返回 "<authenticated>" 占位符表示"环境已认证"
 * 本模块会被浏览器端（Vite）引用，因此 Node 内置模块只能通过运行时动态 import 获取。
 */

// ========== Node 内置模块的惰性引用（浏览器兼容） ==========
// 三个函数引用初始为 null，动态 import 完成后才被赋值
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

// 动态导入的统一入口，供上方惰性引用按需加载
const dynamicImport: DynamicImport = (specifier) => import(specifier);
// 用字符串拼接构造 "node:fs" 等 specifier，避免打包器在静态分析阶段识别出 node: 前缀导入
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

// 仅在 Node.js/Bun 环境下提前异步加载（浏览器没有 process，自然跳过）
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_FS_SPECIFIER).then((m) => {
		_existsSync = (m as typeof import("node:fs")).existsSync;
	});
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_homedir = (m as typeof import("node:os")).homedir;
	});
	dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
		_join = (m as typeof import("node:path")).join;
	});
}

import type { KnownProvider, ProviderEnv } from "./types.ts";
import { getProviderEnvValue } from "./utils/provider-env.ts";

// ========== Anthropic 的三个候选凭据环境变量 ==========
// AUTH_TOKEN（Bearer 令牌）/ OAUTH_TOKEN（OAuth 访问令牌）/ API_KEY（普通 API 密钥）
export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

// ========== Vertex ADC（应用默认凭据）探测与缓存 ==========

// 探测结果缓存：null 表示尚未探测，true/false 为已缓存结论
let cachedVertexAdcCredentialsExists: boolean | null = null;

/**
 * 探测当前环境是否具备 Google Vertex 的 ADC（Application Default Credentials）凭据
 * @param env 可选的自定义环境变量集合；缺省时读取进程环境
 * @returns 是否存在可用的 ADC 凭据文件
 */
function hasVertexAdcCredentials(env?: ProviderEnv): boolean {
	// 调用方通过 env 显式指定了凭据文件路径：直接检查该文件是否存在（不走缓存）
	const explicitCredentialsPath = env?.GOOGLE_APPLICATION_CREDENTIALS;
	if (explicitCredentialsPath) {
		return _existsSync ? _existsSync(explicitCredentialsPath) : false;
	}

	if (cachedVertexAdcCredentialsExists === null) {
		// 若 Node 内置模块尚未加载完成（启动时的动态 import 竞态），
		// 返回 false 但【不写入缓存】，这样下次调用会在模块就绪后重试；
		// 只有在永远拿不到 fs 的浏览器环境里才把 false 永久缓存
		if (!_existsSync || !_homedir || !_join) {
			const isNode = typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
			if (!isNode) {
				// 确定处于浏览器环境 —— 可以安全地把 false 永久缓存
				cachedVertexAdcCredentialsExists = false;
			}
			return false;
		}

		// 优先检查 GOOGLE_APPLICATION_CREDENTIALS 环境变量（标准方式）
		const gacPath = getProviderEnvValue("GOOGLE_APPLICATION_CREDENTIALS", env);
		if (gacPath) {
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// 否则回退到 gcloud CLI 的默认 ADC 路径（惰性求值）
			cachedVertexAdcCredentialsExists = _existsSync(
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

/**
 * 返回指定 provider 的候选 API Key 环境变量名列表
 * @param provider provider 标识
 * @returns 候选环境变量名数组（有先后顺序）；该 provider 不支持环境变量配置时返回 undefined
 */
function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	// GitHub Copilot：使用固定的 GitHub 令牌环境变量
	if (provider === "github-copilot") {
		return ["COPILOT_GITHUB_TOKEN"];
	}

	// ANTHROPIC_AUTH_TOKEN 会参与环境发现/状态展示，但 getEnvApiKey() 会跳过它，
	// 因为发请求时它必须以 Authorization: Bearer 头的形式传递，不能当普通 API Key 用
	if (provider === "anthropic") {
		return [ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV];
	}

	// ========== provider → API Key 环境变量映射表 ==========
	// 命名惯例：-cn/-ams/-sgp 等后缀表示同一厂商的不同区域版本；
	// token-plan 系列表示厂商的"套餐令牌"接入；部分变体与主 provider 共用同一环境变量
	const envMap: Record<string, string> = {
		"ant-ling": "ANT_LING_API_KEY",
		// Qwen 套餐接入；individual（个人版）与主套餐共用 QWEN_TOKEN_PLAN_API_KEY
		"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
		"qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
		"qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
		openai: "OPENAI_API_KEY",
		"azure-openai-responses": "AZURE_OPENAI_API_KEY",
		nvidia: "NVIDIA_API_KEY",
		deepseek: "DEEPSEEK_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		groq: "GROQ_API_KEY",
		cerebras: "CEREBRAS_API_KEY",
		xai: "XAI_API_KEY",
		radius: "RADIUS_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
		mistral: "MISTRAL_API_KEY",
		minimax: "MINIMAX_API_KEY",
		"minimax-cn": "MINIMAX_CN_API_KEY",
		// Moonshot 海外版与国内版共用 MOONSHOT_API_KEY
		moonshotai: "MOONSHOT_API_KEY",
		"moonshotai-cn": "MOONSHOT_API_KEY",
		huggingface: "HF_TOKEN",
		fireworks: "FIREWORKS_API_KEY",
		together: "TOGETHER_API_KEY",
		baseten: "BASETEN_API_KEY",
		// opencode 与 opencode-go 共用 OPENCODE_API_KEY
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
		// Cloudflare Workers AI 与 AI Gateway 共用 CLOUDFLARE_API_KEY
		"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
		"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	const envVar = envMap[provider];
	// 查不到映射说明该 provider 不支持通过环境变量提供 API Key
	return envVar ? [envVar] : undefined;
}

/**
 * 查找当前已配置、可为指定 provider 提供 API Key 的环境变量
 * @param provider provider 标识
 * @param env 可选的自定义环境变量集合；缺省时读取进程环境
 * @returns 已配置的环境变量名列表；无候选或均未配置时返回 undefined
 *
 * 只报告真正的 API Key 变量；有意排除 AWS Profile、AWS IAM 凭据、
 * Google 应用默认凭据（ADC）这类"环境级"凭据来源。
 */
export function findEnvKeys(provider: KnownProvider, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined;
export function findEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	// 过滤出实际有值的环境变量；一个都没有则返回 undefined
	const found = envVars.filter((envVar) => !!getProviderEnvValue(envVar, env));
	return found.length > 0 ? found : undefined;
}

/**
 * 从已知的环境变量中读取 provider 的 API Key，如 OPENAI_API_KEY
 * @param provider provider 标识
 * @param env 可选的自定义环境变量集合；缺省时读取进程环境
 * @returns 密钥值；通过 ADC/AWS 等环境级凭据认证时返回 "<authenticated>" 占位符（并非真实密钥）；无凭据返回 undefined
 *
 * 对要求 OAuth 令牌的 provider 不会返回 API Key。
 */
export function getEnvApiKey(provider: KnownProvider, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined;
export function getEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	// ========== 常规路径：从密钥环境变量直接取值 ==========
	const envKeys = findEnvKeys(provider, env);
	if (envKeys?.[0]) {
		// anthropic 特例：跳过 ANTHROPIC_AUTH_TOKEN（它要以 Bearer 头传递，不能当 API Key 用）
		const apiKeyEnv = provider === "anthropic" ? envKeys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV) : envKeys[0];
		if (apiKeyEnv) return getProviderEnvValue(apiKeyEnv, env);
	}

	// ========== Vertex AI：ADC 应用默认凭据回退 ==========
	// Vertex AI 既支持显式 API Key，也支持应用默认凭据（ADC）；
	// ADC 认证通过 `gcloud auth application-default login` 配置
	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials(env);
		// 项目 ID：GOOGLE_CLOUD_PROJECT 或 GCLOUD_PROJECT 任一即可
		const hasProject = !!(
			getProviderEnvValue("GOOGLE_CLOUD_PROJECT", env) || getProviderEnvValue("GCLOUD_PROJECT", env)
		);
		// 区域：GOOGLE_CLOUD_LOCATION
		const hasLocation = !!getProviderEnvValue("GOOGLE_CLOUD_LOCATION", env);

		// 凭据 + 项目 + 区域三者齐备即视为已认证
		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	// ========== Amazon Bedrock：多种 AWS 凭据来源回退 ==========
	if (provider === "amazon-bedrock") {
		// Amazon Bedrock 支持多种凭据来源：
		// 1. AWS_PROFILE —— ~/.aws/credentials 中的命名 profile
		// 2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY —— 标准 IAM 密钥
		// 3. AWS_BEARER_TOKEN_BEDROCK —— Bedrock Bearer 令牌
		// 4. AWS_CONTAINER_CREDENTIALS_RELATIVE_URI —— ECS 任务角色（相对 URI）
		// 5. AWS_CONTAINER_CREDENTIALS_FULL_URI —— ECS 任务角色（完整 URI）
		// 6. AWS_WEB_IDENTITY_TOKEN_FILE —— IRSA（服务账号的 IAM 角色）
		if (
			getProviderEnvValue("AWS_PROFILE", env) ||
			(getProviderEnvValue("AWS_ACCESS_KEY_ID", env) && getProviderEnvValue("AWS_SECRET_ACCESS_KEY", env)) ||
			getProviderEnvValue("AWS_BEARER_TOKEN_BEDROCK", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			getProviderEnvValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			getProviderEnvValue("AWS_WEB_IDENTITY_TOKEN_FILE", env)
		) {
			// 任一来源命中即视为已认证
			return "<authenticated>";
		}
	}

	// 以上路径都未命中：环境变量中没有可用的凭据
	return undefined;
}
