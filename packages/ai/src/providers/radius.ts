/**
 * @file Radius 网关 provider（radius.ts）——动态目录 + ModelsStore 持久化的范例
 * @description
 * Radius 是 pi 自有的 LLM 网关（对外提供 pi-messages 协议），模型目录
 * 完全来自网关、没有静态基线，因此本 provider 不经 createProvider 组装，
 * 而是直接实现 Provider 接口，以获得自定义的 refreshModels 语义：
 * 1. 离线恢复：从 context.stored（ModelsStore 快照）读回上次持久化的
 *    目录，经 context.publish 只同步内存态、不重复落盘；
 * 2. 旧版迁移：ModelsStore 引入前的实现把目录缓存在 OAuth 凭据的
 *    gatewayConfig 字段里，这里一次性导入并转入 ModelsStore；
 * 3. 联网刷新：GET /v1/config 拉取最新目录，publish 持久化并更新内存。
 *
 * 工厂可按不同 id/gateway 实例化多个 Radius provider（models.json 自定义
 * 网关即走此路径）。鉴权双通道：RADIUS_API_KEY 环境变量（API key）与
 * OAuth（浏览器/设备码登录，流程见 auth/oauth/radius.ts）。
 */
import { piMessagesApi } from "../api/pi-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadRadiusOAuth } from "../auth/oauth/load.ts";
import type { Provider } from "../models.ts";
import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModels,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
	normalizeRadiusGatewayUrl,
} from "./radius-config.ts";

/** radiusProvider 的可选项：全部缺省时得到官方 Radius provider。 */
export interface RadiusProviderOptions {
	/** provider 唯一 id；默认 "radius"。自定义网关用不同 id 注册多个实例。 */
	id?: string;
	/** 展示名；默认 "Radius"。 */
	name?: string;
	/** 网关基地址（裸域名会自动补 https://）；默认官方网关 radius.pi.dev。 */
	gateway?: string;
}

/** Radius 网关 provider：模型目录可动态刷新，并持久化到 ModelsStore。 */
export function radiusProvider(options: RadiusProviderOptions = {}): Provider<"pi-messages"> {
	// 身份三要素均可覆盖；网关地址统一先规范化（补协议前缀、去尾斜杠）
	const id = options.id ?? "radius";
	const name = options.name ?? "Radius";
	const gateway = normalizeRadiusGatewayUrl(options.gateway ?? DEFAULT_RADIUS_GATEWAY);
	// 当前目录的内存态：此刻无凭据可恢复，初始恒为空数组（调用只为确立
	// 类型与初值）；之后每次 refreshModels 成功发布时整体替换
	let models = getRadiusModels(id, undefined);
	// pi-messages 协议的流实现（首次调用时才加载完整实现模块）
	const streams = piMessagesApi();

	return {
		id,
		name,
		auth: {
			// API key 通道：读 RADIUS_API_KEY 环境变量（存储凭据优先）
			apiKey: envApiKeyAuth("Radius API key", ["RADIUS_API_KEY"]),
			// OAuth 通道：实现按需加载（把 Node-only 流程代码挡在浏览器产物外），
			// 并绑定本 provider 的网关地址
			oauth: lazyOAuth({ name, load: () => loadRadiusOAuth({ name, gateway }) }),
		},
		// 同步返回最近一次刷新后的目录；首次刷新成功前为空
		getModels: () => models,
		refreshModels: async (context) => {
			// ===== 阶段 1（离线）：恢复上次持久化的目录 =====
			const stored = context.stored;
			if (stored) {
				// 只保留属于本 provider 的条目（防御性过滤，隔离其他 provider 的模型）
				const restored = stored.models.filter((model) => model.provider === id) as typeof models;
				if (
					!(await context.publish({
						// 只更新内存态、不落盘：存储里本来就是这份内容
						update: () => {
							models = restored;
						},
					}))
				) {
					// 发布被作废（本轮刷新已过期/被中止）：放弃后续动作，保留旧列表
					return;
				}
			}

			// 迁移旧版实现缓存在 OAuth 凭据 gatewayConfig 里的目录
			//（ModelsStore 引入之前的存储形态）。仅在存储中尚无本 provider
			// 条目（!stored）时执行，避免覆盖新存储里的目录。
			if (!stored && context.credential?.type === "oauth") {
				const legacy = getRadiusModels(id, context.credential);
				if (legacy.length > 0) {
					if (
						!(await context.publish({
							// 一次性转入 ModelsStore，此后不再依赖凭据内缓存
							persist: { models: legacy, checkedAt: Date.now() },
							update: () => {
								models = legacy;
							},
						}))
					) {
						return;
					}
				}
			}

			// ===== 阶段 2（联网）：拉取最新目录 =====
			// 离线/仅缓存模式，或本轮已被中止时到此为止
			if (!context.allowNetwork || context.signal.aborted) return;
			// 鉴权 token：OAuth 取 access token，API key 取 key 本身
			const apiKey = context.credential?.type === "oauth" ? context.credential.access : context.credential?.key;
			const config = await loadRadiusGatewayConfig(gateway, apiKey, context.signal);
			// 网络返回后再次检查中止：过期刷新不再发布
			if (context.signal.aborted) return;
			const refreshed = getRadiusModelsFromConfig(id, config);
			// 持久化新目录（checkedAt 记录本次检查时刻）并更新内存态
			await context.publish({
				persist: { models: refreshed, checkedAt: Date.now() },
				update: () => {
					models = refreshed;
				},
			});
		},
		// 流式调用直接委托给 pi-messages 协议实现（请求鉴权由 Models 层统一完成）
		stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, streamOptions),
	};
}
