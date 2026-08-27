/**
 * @file Radius 网关配置：类型、防御性校验与目录转换（radius-config.ts）
 * @description
 * Radius 是 pi 自有的 LLM 网关（对外提供 pi-messages 协议）。与内置的
 * 静态模型目录（*.models.ts）不同，Radius 的目录是运行时从网关的
 * GET /v1/config 端点拉取的，本文件为这份动态配置提供全套支撑：
 * - 类型：RadiusGatewayModel（网关侧的「裸」模型条目）、RadiusGatewayConfig
 *   （baseUrl + 模型列表）、RadiusOAuthCredential（附带旧版目录缓存的凭据）；
 * - 校验：isRadiusGatewayModel / sanitizeRadiusGatewayConfig 对来自网络与
 *   凭据存储的不可信 JSON 逐字段校验，坏数据不会混进模型目录；
 * - 转换：getRadiusModelsFromConfig 把网关条目补全为 Model<"pi-messages">；
 * - 拉取：loadRadiusGatewayConfig 请求网关并校验响应。
 */
import type { OAuthCredential } from "../auth/types.ts";
import type { Model, ThinkingLevelMap } from "../types.ts";

// 默认 Radius 网关端点：未显式指定 gateway 时使用
export const DEFAULT_RADIUS_GATEWAY = "https://radius.pi.dev";

/**
 * 网关配置中的单个模型条目：尚未绑定 provider/baseUrl 的「裸」模型描述，
 * 经 getRadiusModelsFromConfig 补全 api/provider/baseUrl 后才成为可直接
 * 请求的 Model<"pi-messages">。
 */
export type RadiusGatewayModel = {
	/** 模型 id（网关内唯一，请求时使用）。 */
	id: string;
	/** 人类可读的展示名。 */
	name: string;
	/** 是否支持推理/思维链。 */
	reasoning: boolean;
	/** pi 思维链等级 → 网关/模型专属取值的映射；缺失的键回落默认值。 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 接受的输入模态：文本/图片。 */
	input: ("text" | "image")[];
	/** 计费信息（结构与 Model.cost 一致，单价为美元/百万 token）。 */
	cost: Model<"pi-messages">["cost"];
	/** 上下文窗口大小（token 数）。 */
	contextWindow: number;
	/** 单次响应的最大输出 token 数。 */
	maxTokens: number;
};

/** 网关配置：API 基地址 + 该网关提供的模型列表。 */
export type RadiusGatewayConfig = {
	/** 网关基地址（规范化后的完整 URL，成为目录中每个模型的 baseUrl）。 */
	baseUrl: string;
	/** 网关侧模型条目列表。 */
	models: RadiusGatewayModel[];
};

/**
 * Radius 的 OAuth 凭据：在标准 OAuthCredential 之上扩展可选的 gatewayConfig。
 * 旧版实现（ModelsStore 引入前）把网关目录缓存在凭据的这个字段里——
 * OAuthCredential 的索引签名允许此类附加字段；现仅用于一次性迁移
 * （见 radius.ts 的 refreshModels）。
 */
export type RadiusOAuthCredential = OAuthCredential & {
	/** 旧版缓存的网关配置（含模型目录）。 */
	gatewayConfig?: RadiusGatewayConfig;
};

/**
 * 运行时类型守卫：判断未知值是否为结构合法的 RadiusGatewayModel。
 * 配置来自网络响应或凭据存储，不可信任，必须逐字段校验。
 */
function isRadiusGatewayModel(value: unknown): value is RadiusGatewayModel {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const model = value as Partial<RadiusGatewayModel>;
	return (
		typeof model.id === "string" &&
		typeof model.name === "string" &&
		typeof model.reasoning === "boolean" &&
		Array.isArray(model.input) &&
		typeof model.cost === "object" &&
		model.cost !== null &&
		!Array.isArray(model.cost) &&
		typeof model.contextWindow === "number" &&
		typeof model.maxTokens === "number"
	);
}

/**
 * 清洗不可信的网关配置。
 *
 * 策略：顶层结构（对象 + 字符串 baseUrl + 数组 models）不合法时整体作废
 * （返回 undefined）；模型列表则逐条过滤掉结构不合法的条目，不因单条坏
 * 数据拒绝整个配置。对存活条目做浅拷贝（{ ...model }），切断与原始
 * JSON 对象的引用共享。
 */
function sanitizeRadiusGatewayConfig(config: unknown): RadiusGatewayConfig | undefined {
	if (typeof config !== "object" || config === null || Array.isArray(config)) return undefined;
	const { baseUrl, models } = config as Partial<RadiusGatewayConfig>;
	if (typeof baseUrl !== "string" || !Array.isArray(models)) return undefined;
	return {
		baseUrl,
		models: models.filter(isRadiusGatewayModel).map((model) => ({ ...model })),
	};
}

/**
 * 规范化网关地址：缺少协议前缀时补上 https://（容忍裸域名写法），
 * 再去掉末尾的全部斜杠，保证后续 new URL(path, gateway) 拼接路径正确。
 */
export function normalizeRadiusGatewayUrl(value: string): string {
	const withScheme = /^https?:\/\//iu.test(value) ? value : `https://${value}`;
	return withScheme.replace(/\/+$/u, "");
}

/**
 * 从 OAuth 凭据中取出并清洗 gatewayConfig（旧版目录缓存）。
 * 凭据缺失或该字段结构不合法时返回 undefined。
 */
export function getRadiusCredentialConfig(credential: OAuthCredential | undefined): RadiusGatewayConfig | undefined {
	return sanitizeRadiusGatewayConfig((credential as RadiusOAuthCredential | undefined)?.gatewayConfig);
}

/**
 * 把网关配置映射为完整的 pi-messages 模型目录：
 * 保留条目自身字段，补上固定的 api（"pi-messages"）、provider id 与
 * 来自配置的 baseUrl。返回新对象数组，不改动传入配置。
 */
export function getRadiusModelsFromConfig(providerId: string, config: RadiusGatewayConfig): Model<"pi-messages">[] {
	return config.models.map((model) => ({
		...model,
		api: "pi-messages",
		provider: providerId,
		baseUrl: config.baseUrl,
	}));
}

/**
 * 便捷组合：OAuth 凭据 →（旧版缓存的）模型目录。
 * 凭据没有可用的 gatewayConfig 时返回空数组。
 */
export function getRadiusModels(providerId: string, credential: OAuthCredential | undefined): Model<"pi-messages">[] {
	const config = getRadiusCredentialConfig(credential);
	return config ? getRadiusModelsFromConfig(providerId, config) : [];
}

/**
 * 截断 HTTP 响应体用于错误消息：超过 512 字符时截断并追加省略号，
 * 避免网关返回大段 HTML/JSON 时报错信息过长不可读。
 */
function truncateHttpBody(body: string): string {
	const trimmed = body.trim();
	return trimmed.length > 512 ? `${trimmed.slice(0, 512)}…` : trimmed;
}

/**
 * 从网关拉取配置（GET /v1/config）并校验。
 *
 * @param gateway 规范化后的网关基地址
 * @param apiKey 可选的 Bearer token（OAuth 的 access token 或 API key）
 * @param signal 可选中止信号
 * @returns 清洗后的网关配置
 * @throws HTTP 非 2xx 或响应结构校验失败时，抛出带上下文信息的 Error
 */
export async function loadRadiusGatewayConfig(
	gateway: string,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<RadiusGatewayConfig> {
	const headers: Record<string, string> = { accept: "application/json" };
	// 提供了 key 则以标准 Bearer 头鉴权
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;
	const response = await fetch(new URL("/v1/config", gateway), { headers, signal });
	// 非 2xx：带上状态码与截断后的响应体，便于定位网关侧问题
	if (!response.ok) {
		throw new Error(
			`Could not load Radius config from ${gateway}: ${response.status}: ${truncateHttpBody(await response.text())}`,
		);
	}
	// 响应不是合法的 Radius 配置结构：整体作废
	const config = sanitizeRadiusGatewayConfig(await response.json());
	if (!config) throw new Error(`Invalid Radius config from ${gateway}`);
	return config;
}
