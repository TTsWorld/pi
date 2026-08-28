/**
 * @file provider-attribution.ts —— Provider 归因请求头
 *
 * @description
 * 根据当前模型所属的 provider（OpenRouter / NVIDIA NIM / Cloudflare /
 * OpenCode）为 API 请求附加归因或会话相关的 HTTP 头，
 * 便于各平台识别流量来源为 pi；用户关闭安装遥测时则不加归因头。
 */
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { SettingsManager } from "./settings-manager.ts";
import { isInstallTelemetryEnabled } from "./telemetry.ts";

// 各 provider 的 API 主机名：仅凭 provider id 无法判断时用 baseUrl 兜底识别
const OPENROUTER_HOST = "openrouter.ai";
const NVIDIA_NIM_HOST = "integrate.api.nvidia.com";
const CLOUDFLARE_API_HOST = "api.cloudflare.com";
const CLOUDFLARE_AI_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const OPENCODE_HOST = "opencode.ai";

/** 判断 baseUrl 的主机名是否与预期一致；URL 解析失败视为不匹配 */
function matchesHost(baseUrl: string, expectedHost: string): boolean {
	try {
		return new URL(baseUrl).hostname === expectedHost;
	} catch {
		return false;
	}
}

/** 是否为 OpenRouter 模型（按 provider id 或 baseUrl 命中判断） */
function isOpenRouterModel(model: Model<Api>): boolean {
	return model.provider === "openrouter" || model.baseUrl.includes(OPENROUTER_HOST);
}

/** 是否为 NVIDIA NIM 模型 */
function isNvidiaNimModel(model: Model<Api>): boolean {
	return model.provider === "nvidia" || matchesHost(model.baseUrl, NVIDIA_NIM_HOST);
}

/** 是否为 Cloudflare 模型（Workers AI 或 AI Gateway） */
function isCloudflareModel(model: Model<Api>): boolean {
	return (
		model.provider === "cloudflare-workers-ai" ||
		model.provider === "cloudflare-ai-gateway" ||
		matchesHost(model.baseUrl, CLOUDFLARE_API_HOST) ||
		matchesHost(model.baseUrl, CLOUDFLARE_AI_GATEWAY_HOST)
	);
}

/**
 * 按模型所属 provider 生成默认归因头。
 *
 * 不同平台要求的头各不相同：OpenRouter 用 Referer/Title/Categories，
 * NVIDIA 用计费来源标记，Cloudflare 用自定义 User-Agent；
 * 不属于任何已知平台时返回 undefined。
 */
function getDefaultAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
): Record<string, string> | undefined {
	// 安装遥测被关闭时不附加任何归因头（归因头本身也算一种遥测）
	if (!isInstallTelemetryEnabled(settingsManager)) {
		return undefined;
	}

	if (isOpenRouterModel(model)) {
		return {
			"HTTP-Referer": "https://pi.dev",
			"X-OpenRouter-Title": "pi",
			"X-OpenRouter-Categories": "cli-agent",
		};
	}

	if (isNvidiaNimModel(model)) {
		return {
			"X-BILLING-INVOKE-ORIGIN": "Pi",
		};
	}

	if (isCloudflareModel(model)) {
		return {
			"User-Agent": "pi-coding-agent",
		};
	}

	return undefined;
}

/**
 * 为 OpenCode 系模型生成会话标识头（服务端据此区分不同会话的请求）。
 * 非 OpenCode 模型或没有 sessionId 时返回 undefined。
 */
function getSessionHeaders(model: Model<Api>, sessionId: string | undefined): Record<string, string> | undefined {
	if (!sessionId) return undefined;
	if (
		model.provider !== "opencode" &&
		model.provider !== "opencode-go" &&
		!matchesHost(model.baseUrl, OPENCODE_HOST)
	) {
		return undefined;
	}
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

/**
 * 合并出最终发给 provider 的归因头。
 *
 * 优先级从低到高：会话头 → 默认归因头 → 调用方传入的 headerSources
 * （后者覆盖前者同名字段）；合并结果为空时返回 undefined。
 */
export function mergeProviderAttributionHeaders(
	model: Model<Api>,
	settingsManager: SettingsManager,
	sessionId: string | undefined,
	...headerSources: Array<ProviderHeaders | undefined>
): ProviderHeaders | undefined {
	const merged: ProviderHeaders = {
		...getSessionHeaders(model, sessionId),
		...getDefaultAttributionHeaders(model, settingsManager),
	};

	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
