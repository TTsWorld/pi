/**
 * @file remote-catalog-provider.ts —— pi.dev 远程模型目录覆盖层
 *
 * @description
 * 通过 `withRemoteCatalog` 包装静态内置的 Provider：在其内置模型列表之上叠加
 * 从 pi.dev 远程拉取并持久化的动态模型目录，使新增模型无需升级 CLI 即可使用。
 * 刷新逻辑带节流（默认 4 小时）、ETag 条件请求（304 免下载）与本地构建时间对比，
 * 避免远程数据比内置目录更旧时覆盖内置模型。
 */
import type { Api, Model, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import { fetchWithRetry } from "../utils/management-http.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";

const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
/** 单次目录请求的超时时间（毫秒）。 */
const REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
/** 目录刷新节流间隔：距上次检查不足该时长则跳过网络请求。 */
export const REMOTE_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

/** 合并模型列表：dynamic 中同 id 的模型覆盖 baseline 中的同名项，其余追加。 */
function mergeModels(baseline: readonly Model<Api>[], dynamic: readonly Model<Api>[]): Model<Api>[] {
	const merged = [...baseline];
	for (const model of dynamic) {
		const index = merged.findIndex((entry) => entry.id === model.id);
		if (index >= 0) merged[index] = model;
		else merged.push(model);
	}
	return merged;
}

/** 解析远端目录响应：兼容「模型数组 / { models: [...] } / id→模型的对象」三种形态。 */
function parseCatalog(providerId: string, value: unknown): Model<Api>[] {
	const entries = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
			? value.models
			: typeof value === "object" && value !== null
				? Object.values(value)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter((entry): entry is Model<Api> => typeof entry === "object" && entry !== null && "id" in entry)
		.map((model) => ({ ...model, provider: providerId }));
}

/**
 * 从持久化条目中取出可用于覆盖的远程模型。
 * 若已知本地生成时间且远程数据不比它新（lastModified 缺失或更早），返回空列表，
 * 防止过期的远程目录压过随 CLI 发布的内置模型。
 */
function remoteModels(
	entry: ModelsStoreEntry | undefined,
	localGeneratedAt: number | undefined,
): readonly Model<Api>[] {
	if (!entry) return [];
	if (localGeneratedAt !== undefined && (entry.lastModified === undefined || entry.lastModified <= localGeneratedAt)) {
		return [];
	}
	return entry.models;
}

/**
 * 为静态内置 Provider 叠加持久化的 pi.dev 远程模型目录，返回增强后的 Provider。
 *
 * 返回的对象保留原 Provider 的全部能力，但 `getModels` 会合并远程覆盖层，
 * `refreshModels` 负责恢复本地缓存并按节流间隔向 pi.dev 发起条件刷新。
 *
 * @param provider - 待增强的内置 Provider
 * @param catalogBaseUrl - 目录服务基地址，默认 https://pi.dev
 * @param localGeneratedAt - 内置目录的生成时间戳（毫秒），用于丢弃更旧的远程数据
 */
export function withRemoteCatalog(
	provider: Provider,
	catalogBaseUrl: string = DEFAULT_CATALOG_BASE_URL,
	localGeneratedAt?: number,
): Provider {
	let dynamicModels: readonly Model<Api>[] = [];

	return {
		...provider,
		getModels: () => mergeModels(provider.getModels(), dynamicModels),
		refreshModels: async (context) => {
			// 第一步：恢复本地持久化的覆盖层（按 provider 过滤并丢弃比内置目录旧的数据）
			const stored = context.stored;
			const restored = remoteModels(stored, localGeneratedAt).filter((model) => model.provider === provider.id);
			if (
				!(await context.publish({
					update: () => {
						dynamicModels = restored;
					},
				}))
			) {
				return;
			}
			// 不允许联网或已被中断：恢复到此为止
			if (!context.allowNetwork || context.signal.aborted) return;
			// 非强制刷新且仍在节流窗口内：跳过网络请求
			if (
				!context.force &&
				stored?.checkedAt !== undefined &&
				stored.lastModified !== undefined &&
				Date.now() - stored.checkedAt < REMOTE_CATALOG_REFRESH_INTERVAL_MS
			) {
				return;
			}

			// 只有当缓存的模型主体还在、ETag 有对应内容可回退时才发送条件请求，
			// 这样 304 响应绝不会把覆盖层清空。
			const validator = stored?.models.length ? stored.etag : undefined;
			const url = new URL(`/api/models/providers/${encodeURIComponent(provider.id)}`, catalogBaseUrl);
			const response = await fetchWithRetry(
				url,
				{
					headers: {
						accept: "application/json",
						"User-Agent": getPiUserAgent(VERSION),
						...(validator ? { "if-none-match": validator } : {}),
					},
					signal: context.signal,
				},
				{ attemptTimeoutMs: REMOTE_CATALOG_ATTEMPT_TIMEOUT_MS },
			);
			if (context.signal.aborted) return;
			const checkedAt = Date.now();
			// 304 未变更：dynamicModels 已持有存储的覆盖层，只需推进新鲜度窗口（checkedAt）。
			if (response.status === 304 && stored) {
				await context.publish({ persist: { ...stored, checkedAt } });
				return;
			}
			// 服务端明确没有该供应商的目录：记录空目录并清空 lastModified/etag
			if (response.status === 404 || response.status === 501) {
				await context.publish({
					persist: {
						...(stored ?? { models: [] }),
						checkedAt,
						lastModified: 0,
						etag: undefined,
					},
				});
				return;
			}
			if (!response.ok) {
				// 瞬时失败：缓存的模型主体与校验器仍然有效，因此保留 etag，
				// 让下次刷新走条件请求而非重新下载整个目录。
				await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
				throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
			}
			const refreshed = parseCatalog(provider.id, await response.json());
			const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
			if (context.signal.aborted) return;
			const entry = {
				models: refreshed,
				checkedAt,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: response.headers.get("etag") ?? undefined,
			};
			const published = remoteModels(entry, localGeneratedAt);
			await context.publish({
				persist: entry,
				update: () => {
					dynamicModels = published;
				},
			});
		},
	};
}
