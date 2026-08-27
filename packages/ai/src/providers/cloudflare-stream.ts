/**
 * @file Cloudflare 流转发工具
 * @description Cloudflare 系 provider（AI Gateway / Workers AI）的 baseUrl 中
 * 含租户级端点占位符（{CLOUDFLARE_ACCOUNT_ID} / {CLOUDFLARE_GATEWAY_ID}），
 * 因为账号 ID 与网关 ID 因租户而异，无法在生成目录中写死。本文件在请求
 * 派发前，用解析出的 provider env 将占位符替换为真实值。
 */
import type { Api, Model, ProviderEnv, ProviderStreams } from "../types.ts";

// 占位符名称，同时兼作对应环境变量的名称
const CLOUDFLARE_ACCOUNT_ID = "CLOUDFLARE_ACCOUNT_ID";
const CLOUDFLARE_GATEWAY_ID = "CLOUDFLARE_GATEWAY_ID";

/**
 * 将模型 baseUrl 中的 Cloudflare 占位符替换为环境中真实的账号/网关 ID。
 *
 * @param model 原始模型定义（baseUrl 可能含占位符）
 * @param env 已解析的 provider 环境变量（可能为空）
 * @returns 替换后的新模型对象；未发生任何替换时原样返回同一引用
 */
export function resolveCloudflareModel<TApi extends Api>(
	model: Model<TApi>,
	env: ProviderEnv | undefined,
): Model<TApi> {
	if (!env) return model;
	// 环境变量缺失时回写占位符本身，即保持 baseUrl 原样不动
	const baseUrl = model.baseUrl
		.replaceAll(`{${CLOUDFLARE_ACCOUNT_ID}}`, env[CLOUDFLARE_ACCOUNT_ID] ?? `{${CLOUDFLARE_ACCOUNT_ID}}`)
		.replaceAll(`{${CLOUDFLARE_GATEWAY_ID}}`, env[CLOUDFLARE_GATEWAY_ID] ?? `{${CLOUDFLARE_GATEWAY_ID}}`);
	// 占位符全部未命中时复用原对象，避免产生等价的新实例（保持引用相等）
	return baseUrl === model.baseUrl ? model : { ...model, baseUrl };
}

/**
 * 包装一层 API 流实现，使 Cloudflare 账号/网关端点占位符在请求派发前，
 * 从已解析的 provider env 中物化为真实值。
 *
 * @param streams 被包装的原始流实现
 * @returns 先解析占位符再委托调用的新流实现
 */
export function cloudflareStreams(streams: ProviderStreams): ProviderStreams {
	return {
		stream: (model, context, options) =>
			streams.stream(resolveCloudflareModel(model, options?.env), context, options),
		streamSimple: (model, context, options) =>
			streams.streamSimple(resolveCloudflareModel(model, options?.env), context, options),
	};
}
