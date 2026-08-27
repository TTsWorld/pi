/**
 * @file Cloudflare 认证（cloudflare-auth.ts）
 * @description
 * 为两个 Cloudflare 系 provider——Workers AI（直连边缘推理）与 AI Gateway
 * （统一网关）——提供 ApiKeyAuth 工厂。Cloudflare 的认证由三个值组成：
 * API key、账号 ID（account id）与网关 ID（gateway id，仅 AI Gateway 需要）。
 *
 * 解析策略为「按字段合并」：存储凭据（login 时保存的 key 与 env 附加值）
 * 优先，缺失的字段回退到环境变量（CLOUDFLARE_API_KEY /
 * CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_GATEWAY_ID）。
 *
 * 解析出的账号/网关 ID 不进请求头，而是放进 AuthResult.env 返回——
 * 下游 cloudflare-stream.ts 用它们替换模型 baseUrl 中的租户端占位符
 * {CLOUDFLARE_ACCOUNT_ID} / {CLOUDFLARE_GATEWAY_ID}（账号/网关 ID 因租户
 * 而异，静态模型目录里只能写占位符）。
 */
import type { ApiKeyAuth, ApiKeyCredential, AuthContext } from "../auth/types.ts";
import type { ProviderEnv } from "../types.ts";

// API key 的环境变量名（兼作解析来源与 source 标签）
const CLOUDFLARE_API_KEY = "CLOUDFLARE_API_KEY";
// Cloudflare 账号 ID 的环境变量名；亦用作凭据 env 字段名与 baseUrl 占位符名
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
// AI Gateway 网关 ID 的环境变量名；用途同上
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

// Cloudflare 的两种接入形态：Workers AI 直连边缘推理 / 经 AI Gateway 网关转发
type CloudflareAuthKind = "workers-ai" | "ai-gateway";

/**
 * 按字段解析单个配置值（API key / 账号 ID / 网关 ID 之一）。
 *
 * 优先级：存储凭据 → 环境变量。凭据中的 API key 存于 credential.key，
 * 账号/网关 ID 存于 credential.env 的同名字段；环境兜底保证「凭据只存了
 * API key」时，账号/网关 ID 仍能从环境变量补齐（反之亦然）。
 *
 * @param name 要解析的配置名（对应同名环境变量与凭据字段）
 * @param ctx 环境访问上下文（可注入，便于测试与浏览器环境）
 * @param credential 已存储的凭据；可能不存在
 * @param signal 中止信号
 * @returns 解析出的值；该字段在任何来源都没有时返回 undefined
 */
async function resolveValue(
	name: string,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<string | undefined> {
	// 按字段合并：凭据值优先，缺失时回退到环境变量。
	// 只携带 API key 的凭据也必须能从环境中取到 account / gateway id。
	const fromCredential = credential
		? name === CLOUDFLARE_API_KEY
			? credential.key
			: credential.env?.[name]
		: undefined;
	if (fromCredential !== undefined) return fromCredential;
	// 环境变量读取前后都响应中止信号，保证取消即时生效
	signal.throwIfAborted();
	const value = await ctx.env(name);
	signal.throwIfAborted();
	return value;
}

/**
 * 汇总解析指定接入形态所需的全部 Cloudflare 配置。
 *
 * 必填项：API key + 账号 ID；AI Gateway 形态额外要求网关 ID。
 * 任一必填缺失即视为「该 provider 未配置」，返回 undefined。
 *
 * @param kind 接入形态（workers-ai / ai-gateway）
 * @param ctx 环境访问上下文
 * @param credential 已存储的凭据；可能不存在
 * @param signal 中止信号
 * @returns apiKey、供下游占位符替换用的 env 快照与来源标签；未配置时为 undefined
 */
async function resolveCloudflareEnv(
	kind: CloudflareAuthKind,
	ctx: AuthContext,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Promise<{ apiKey: string; env: ProviderEnv; source: string } | undefined> {
	const apiKey = await resolveValue(CLOUDFLARE_API_KEY, ctx, credential, signal);
	const accountId = await resolveValue(CLOUDFLARE_ACCOUNT_ID, ctx, credential, signal);
	// 网关 ID 仅 AI Gateway 形态需要，Workers AI 不解析
	const gatewayId =
		kind === "ai-gateway" ? await resolveValue(CLOUDFLARE_GATEWAY_ID, ctx, credential, signal) : undefined;

	if (!apiKey || !accountId || (kind === "ai-gateway" && !gatewayId)) return undefined;

	return {
		apiKey,
		// 账号/网关 ID 经 env 通道传给下游做占位符替换；API key 本身不放进 env
		env: {
			CLOUDFLARE_ACCOUNT_ID: accountId,
			...(gatewayId ? { CLOUDFLARE_GATEWAY_ID: gatewayId } : {}),
		},
		// 来源标签供状态 UI 展示：有存储凭据时标 "stored credential"，
		// 纯环境变量配置时标 CLOUDFLARE_API_KEY
		source: credential ? "stored credential" : CLOUDFLARE_API_KEY,
	};
}

/**
 * Workers AI（直连边缘推理）的 API key 认证。
 *
 * login 交互式收集 API key 与账号 ID；resolve 解析出标准的 apiKey 形式
 * 认证（Bearer 请求头由底层 API 实现按各自约定组装）。
 */
export function cloudflareWorkersAIAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			// 账号 ID 属于 provider 配置而非认证本体，存入凭据的 env 字段
			return { type: "api_key", key, env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
		},
		resolve: async ({ ctx, credential, signal }) => {
			const resolved = await resolveCloudflareEnv("workers-ai", ctx, credential, signal);
			// 必填配置缺失：视为未配置，向 Models 层报告不可用
			if (!resolved) return undefined;
			return {
				auth: { apiKey: resolved.apiKey },
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}

/**
 * AI Gateway（统一网关）的 API key 认证。
 *
 * 与 Workers AI 的两点差异：
 * - 额外需要网关 ID（login 多收集一项，resolve 多校验一项）；
 * - 鉴权不走标准 Authorization，而是经网关专有的 cf-aig-authorization
 *   头承载 Bearer token。
 */
export function cloudflareAIGatewayAuth(): ApiKeyAuth {
	return {
		name: "Cloudflare API key",
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: "Enter Cloudflare API key" });
			const accountId = await interaction.prompt({ type: "text", message: "Enter Cloudflare account ID" });
			const gatewayId = await interaction.prompt({ type: "text", message: "Enter Cloudflare AI Gateway ID" });
			// 账号/网关 ID 一并存入凭据 env，下次免填
			return {
				type: "api_key",
				key,
				env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_GATEWAY_ID: gatewayId },
			};
		},
		resolve: async ({ ctx, credential, signal }) => {
			const resolved = await resolveCloudflareEnv("ai-gateway", ctx, credential, signal);
			if (!resolved) return undefined;
			return {
				auth: {
					headers: {
						// 网关专有鉴权头：Bearer token 只经此头发送
						"cf-aig-authorization": `Bearer ${resolved.apiKey}`,
						// 显式置 null（ProviderHeaders 的 null 语义＝屏蔽同名默认头），
						// 防止底层 OpenAI/Anthropic 兼容实现再注入标准鉴权头，
						// 保证鉴权仅经 cf-aig-authorization 生效
						Authorization: null,
						"x-api-key": null,
					},
				},
				env: resolved.env,
				source: resolved.source,
			};
		},
	};
}
