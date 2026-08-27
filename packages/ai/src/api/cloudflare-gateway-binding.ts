/**
 * @file 经 Workers AI binding 的 AI Gateway 传输层
 *
 * pi 的 Cloudflare AI Gateway 支持走 HTTPS
 * （`gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/...`，见 `api/cloudflare.ts`），
 * 即使调用方是网关所属账户内的 Worker，也需要 Cloudflare API token。
 *
 * 为解决这一问题，`createGatewayBindingFetch` 返回一个 {@link FetchFunction}，
 * 把网关 HTTPS 前缀下的请求翻译为 Workers AI binding 的通用端点调用：
 * `env.AI.gateway(id).run({provider, endpoint, headers, query})`。
 * binding 调用在账户内预认证，并以常规（可流式的）`Response` 返回 provider 的
 * 原生 wire format，因此各 API 实现在两种传输上的行为完全一致。
 *
 * 注意：它是「单个网关客户端的传输层」而非通用 fetch——无法服务的请求
 * （前缀外的 URL、通用端点表达不了的前缀内请求如非 POST / 非 JSON body）
 * 会以描述性错误拒绝。传输选择由调用方按客户端自行决定：这类流量应走
 * HTTPS + 真实网关认证，而不是经过本 shim。
 */

import type { FetchFunction } from "../types.ts";

/**
 * Workers AI binding 网关面（`env.AI`）的结构化类型，
 * 让本模块不必依赖 `@cloudflare/workers-types`。任何真实的 `Ai` binding 都满足它。
 */
export interface AiGatewayBinding {
	gateway(id: string): AiGatewayBindingGateway;
}

export interface AiGatewayBindingGateway {
	run(data: AiGatewayUniversalRequestLike, options?: { signal?: AbortSignal }): Promise<Response>;
}

/** `AiGateway.run()` 接受的单条通用端点请求条目 */
export interface AiGatewayUniversalRequestLike {
	provider: string;
	endpoint: string;
	headers: Record<string, string>;
	query: unknown;
}

/**
 * binding 路由请求的认证头占位值。各 API 实现在分发前要求存在 API key
 * 或可识别的认证头（`authorization`、`x-api-key`、`cf-aig-authorization`）；
 * binding 调用是预认证的，因此传
 * `cf-aig-authorization: Bearer ${CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL}`
 * 以通过检查。shim 在调用 binding 前剥掉 `cf-aig-authorization`。
 * 需与 `Authorization: null` / `x-api-key: null` 搭配，确保 SDK 的占位认证头
 * 永远到不了网关——网关会把请求自带的认证头当作 BYOK provider key，
 * 覆盖其存储的 key（与 HTTPS 行为一致）。
 */
export const CLOUDFLARE_GATEWAY_BINDING_AUTH_SENTINEL = "cloudflare-gateway-binding";

export interface GatewayBindingFetchOptions {
	/** Workers AI binding（例如 `env.AI`）。 */
	binding: AiGatewayBinding;
	/**
	 * 每个请求都必须落入的网关 HTTPS 前缀（不带尾斜杠）：
	 * `https://gateway.ai.cloudflare.com/v1/{accountId}/{gatewayName}`。
	 */
	baseUrl: string;
	/** 传给 `binding.gateway()` 的网关名。必须与 `baseUrl` 里的网关一致。 */
	gateway: string;
}

// 永不转发给 binding 的头：逐跳/派生头，以及网关认证
//（binding 调用预认证；哨兵值绝不能上线）
const STRIP_HEADERS = new Set(["content-length", "host", "cf-aig-authorization"]);

type FetchInput = Parameters<FetchFunction>[0];

/**
 * 创建一个把 AI Gateway 请求路由到 Workers AI binding 的 `fetch`。
 * 行为与组合方式见模块级文档。
 */
export function createGatewayBindingFetch(options: GatewayBindingFetchOptions): FetchFunction {
	const { binding, gateway } = options;
	// 前缀匹配基于 URL 规范化后的组件（origin + pathname）而非原始字符串：
	// 点号段会被消解、fragment 会丢弃，与真实 fetch 上线的形态一致，
	// 避免字形变体把 provider/endpoint 切得和 HTTPS 不同
	const base = new URL(options.baseUrl);
	const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

	return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? input : undefined;
		const url = request ? request.url : input.toString();
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			parsed = undefined;
		}
		// 前缀外的 URL 是配置错误而非透传流量：静默转发会把认证哨兵发给任意主机
		if (parsed === undefined || parsed.origin !== base.origin || !parsed.pathname.startsWith(basePath)) {
			throw new Error(
				`createGatewayBindingFetch: ${method} ${url} is outside the configured gateway ` +
					`prefix (${base.origin}${basePath}); this fetch only serves its gateway-bound client`,
			);
		}

		// 通用端点表达不了的前缀内请求一律拒绝：若改走 HTTPS 会把哨兵发给网关、
		// 以误导性的认证错误失败，而不是指出真正的问题。需要这类端点的调用方
		// 应自行走 HTTPS + 真实网关认证
		const unexpressible = (reason: string): never => {
			throw new Error(
				`createGatewayBindingFetch: cannot express ${method} ${url} as a universal ` +
					`gateway request (${reason}); route it over HTTPS with gateway auth instead`,
			);
		};
		if (method !== "POST") return unexpressible("only POST is supported");

		// 拆出 provider 与 endpoint：前缀后第一段是 provider，其余是 endpoint
		const rest = parsed.pathname.slice(basePath.length);
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			return unexpressible("missing provider/endpoint path");
		}
		const provider = rest.slice(0, slash);
		// query string 保留在 endpoint 上——它属于 HTTPS 本会发送的内容的一部分
		const endpoint = rest.slice(slash + 1) + parsed.search;

		const bodyText = await readBodyText(request, init);
		let query: unknown;
		try {
			query = bodyText === undefined ? undefined : JSON.parse(bodyText);
		} catch {
			return unexpressible("non-JSON body");
		}
		if (query === undefined) {
			return unexpressible("missing body");
		}

		const headers = collectHeaders(request, init);
		// 按 fetch 规范，init 里显式的 `signal: null` 会清除 Request 输入自带的 signal
		const signal = init?.signal ?? (init && "signal" in init && init.signal === null ? undefined : request?.signal);
		return binding.gateway(gateway).run({ provider, endpoint, headers, query }, signal ? { signal } : {});
	};
}

/** 读取请求体文本：兼容字符串/二进制/流式各形态，并遵循 fetch 规范的 init 覆盖语义 */
async function readBodyText(request: Request | undefined, init?: RequestInit): Promise<string | undefined> {
	const body = init?.body;
	if (body === undefined || body === null) {
		// 按 fetch 规范，init 里显式的 `body: null` 会清除 Request 输入自带的 body
		if (init && "body" in init && body === null) return undefined;
		if (request && request.body !== null) return request.clone().text();
		return undefined;
	}
	if (typeof body === "string") return body;
	if (body instanceof Uint8Array) return new TextDecoder().decode(body);
	if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
	// init 里的 URLSearchParams、FormData、Blob、ReadableStream：经 Request 包装读取。
	// 在这里消费一次性流没有问题——表达不了的请求会直接拒绝而不是重放，
	// 下游不会再需要这个 body
	return new Request("http://body.local", {
		method: "POST",
		body,
		// fetch 规范要求流式 body 构造 Request 时必须带 `duplex: "half"`
		//（Node 的 undici 强制校验；对可重放的 body 类型则被忽略）。
		// TypeScript 的 RequestInit 尚未声明该字段，因此需要 as 断言
		duplex: "half",
	} as RequestInit).text();
}

// 头名统一小写：大小写变体的重复项会坍缩、剥离逻辑也统一。
// 按 fetch 规范，`init.headers` 会整体替换 Request 输入自带的 headers
function collectHeaders(request: Request | undefined, init?: RequestInit): Record<string, string> {
	const result: Record<string, string> = {};
	const add = (key: string, value: string) => {
		const name = key.toLowerCase();
		if (!STRIP_HEADERS.has(name)) result[name] = value;
	};
	const headers = init?.headers;
	if (headers === undefined) {
		if (request) {
			for (const [key, value] of request.headers) add(key, value);
		}
	} else if (headers instanceof Headers) {
		for (const [key, value] of headers) add(key, value);
	} else if (Array.isArray(headers)) {
		for (const [key, value] of headers) add(key, value);
	} else {
		for (const [key, value] of Object.entries(headers)) {
			if (value !== undefined) add(key, String(value));
		}
	}
	return result;
}
