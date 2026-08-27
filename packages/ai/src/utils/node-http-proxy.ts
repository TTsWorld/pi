/**
 * @file Node HTTP(S) 代理 URL 解析工具
 * @description 根据标准代理环境变量（http_proxy / https_proxy / all_proxy / no_proxy，
 * 大小写两种写法均识别）为目标请求 URL 解析出应使用的代理地址；也可通过 ProviderEnv
 * 传入作用域化的覆盖值，优先级高于进程环境变量。上层（如 Bedrock 适配器、OpenAI Codex
 * 的 WebSocket）拿到返回的 URL 后构造 Node 侧的代理 Agent（HttpProxyAgent /
 * HttpsProxyAgent，或 WebSocket 的 proxy 选项），使 SDK 请求经由代理发出。
 * 仅支持 HTTP(S) 代理：SOCKS、PAC 等协议会直接抛错。
 */
import type { ProviderEnv } from "../types.ts";
import { getProviderEnvValue } from "./provider-env.ts";

/**
 * 各协议的默认端口表。
 * 目标 URL 未显式携带端口时（如 https://example.com），用对应协议的默认端口
 * 参与 NO_PROXY 条目的 host:port 匹配。
 */
const DEFAULT_PROXY_PORTS: Record<string, number> = {
	ftp: 21,
	gopher: 70,
	http: 80,
	https: 443,
	ws: 80,
	wss: 443,
};

/**
 * 读取一个代理相关的环境变量（如 http_proxy、no_proxy）。
 * 查找优先级逐级回退，空字符串视为未设置：
 * 1. 作用域 env 覆盖值的小写形式；2. 作用域 env 的大写形式；
 * 3. 进程环境（process.env 及 Bun 沙箱兜底）的小写形式；4. 进程环境的大写形式。
 * @param key 环境变量名（任意大小写）
 * @param env 可选的 ProviderEnv 作用域覆盖
 * @returns 环境变量值；各级均未设置时返回空字符串
 */
function getProxyEnv(key: string, env?: ProviderEnv): string {
	// 代理变量以小写为惯例（curl 等工具），同时兼容大写写法
	const lowercaseKey = key.toLowerCase();
	const uppercaseKey = key.toUpperCase();
	return (
		env?.[lowercaseKey] ||
		env?.[uppercaseKey] ||
		getProviderEnvValue(lowercaseKey) ||
		getProviderEnvValue(uppercaseKey) ||
		""
	);
}

/**
 * 安全解析目标 URL。
 * @param targetUrl 目标地址（字符串或 URL 对象）
 * @returns 解析结果；字符串不是合法 URL 时返回 undefined（后续按不走代理处理）
 */
function parseProxyTargetUrl(targetUrl: string | URL): URL | undefined {
	if (targetUrl instanceof URL) {
		return targetUrl;
	}

	try {
		return new URL(targetUrl);
	} catch {
		return undefined;
	}
}

/**
 * 判断目标主机是否应走代理，即实现 NO_PROXY 的匹配语义。
 * 规则：
 * - 未设置 no_proxy：一律走代理
 * - no_proxy 为 "*"：一律不走代理
 * - 其余情况按逗号/空白拆分为多个条目，目标主机必须「不匹配任何条目」才走代理
 *   - 条目可携带端口（host:port）：仅当目标端口与条目端口一致时该条目才可能命中
 *   - 条目以 . 或 * 开头时按域名后缀匹配（忽略前导 *），否则要求主机名完全相等
 * @param hostname 目标主机名（不含端口）
 * @param port 目标端口
 * @param env 可选的 ProviderEnv 作用域覆盖
 * @returns true 表示应走代理；false 表示被 NO_PROXY 排除（直连）
 */
function shouldProxyHostname(hostname: string, port: number, env?: ProviderEnv): boolean {
	const noProxy = getProxyEnv("no_proxy", env).toLowerCase();
	if (!noProxy) {
		// 未设置 no_proxy：默认全部走代理
		return true;
	}
	if (noProxy === "*") {
		// 通配符：排除所有主机，全部直连
		return false;
	}

	// 回调返回 true 表示「该条目未排除此目标」；every 为 true 才走代理
	return noProxy.split(/[,\s]/).every((proxy) => {
		// 连续分隔符产生的空片段视为无约束
		if (!proxy) {
			return true;
		}

		// 拆出可选的 host:port 形式
		const parsedProxy = proxy.match(/^(.+):(\d+)$/);
		let proxyHostname = parsedProxy ? parsedProxy[1] : proxy;
		const proxyPort = parsedProxy ? Number.parseInt(parsedProxy[2]!, 10) : 0;
		// 条目带了端口但与目标端口不一致：条目不适用于此目标，仍走代理
		if (proxyPort && proxyPort !== port) {
			return true;
		}

		// 普通主机名：精确比较
		if (!/^[.*]/.test(proxyHostname)) {
			return hostname !== proxyHostname;
		}

		// .example.com / *.example.com 形式：按域名后缀匹配
		if (proxyHostname.startsWith("*")) {
			proxyHostname = proxyHostname.slice(1);
		}
		return !hostname.endsWith(proxyHostname);
	});
}

/**
 * 计算目标 URL 应使用的代理地址字符串。
 * 优先取协议专属变量（https 目标配 https_proxy、http 目标配 http_proxy），
 * 未设置时回退到 all_proxy。
 * @param targetUrl 目标地址
 * @param env 可选的 ProviderEnv 作用域覆盖
 * @returns 代理地址字符串；无需代理时返回空字符串
 */
function getProxyForUrl(targetUrl: string | URL, env?: ProviderEnv): string {
	const parsedUrl = parseProxyTargetUrl(targetUrl);
	// 无法解析或缺少协议/主机：视为不走代理
	if (!parsedUrl?.protocol || !parsedUrl.host) {
		return "";
	}

	// 取协议名（去掉末尾冒号），并从 host 中剥离端口得到纯主机名
	const protocol = parsedUrl.protocol.split(":", 1)[0]!;
	const hostname = parsedUrl.host.replace(/:\d*$/, "");
	// URL 未写端口时按协议默认端口补齐，供 NO_PROXY 的端口匹配使用
	const port = Number.parseInt(parsedUrl.port, 10) || DEFAULT_PROXY_PORTS[protocol] || 0;
	if (!shouldProxyHostname(hostname, port, env)) {
		return "";
	}

	// 协议专属变量优先于 all_proxy
	let proxy = getProxyEnv(`${protocol}_proxy`, env) || getProxyEnv("all_proxy", env);
	// 裸 host:port 形式补上协议前缀，保证能被 new URL() 解析
	if (proxy && !proxy.includes("://")) {
		proxy = `${protocol}://${proxy}`;
	}
	return proxy;
}

/**
 * 不支持的代理协议（SOCKS / PAC）时使用的报错文案。
 * 单独导出以便上层在做协议预检时复用同一提示。
 */
export const UNSUPPORTED_PROXY_PROTOCOL_MESSAGE =
	"Unsupported proxy protocol. SOCKS and PAC proxy URLs are not supported; use an HTTP or HTTPS proxy URL.";

/**
 * 解析目标 URL 应使用的代理，返回可直接交给代理 Agent 的 URL 对象。
 * 本模块的对外入口：未配置代理时返回 undefined（调用方按直连处理）；
 * 代理变量配置了非法 URL 或非 HTTP(S) 协议（如 SOCKS、PAC）时抛错。
 * @param targetUrl 目标地址
 * @param env 可选的 ProviderEnv 作用域覆盖
 * @returns 代理 URL；无需代理时为 undefined
 * @throws 代理 URL 非法或不支持其协议时抛出 Error
 */
export function resolveHttpProxyUrlForTarget(targetUrl: string | URL, env?: ProviderEnv): URL | undefined {
	const proxy = getProxyForUrl(targetUrl, env);
	// 未配置代理：返回 undefined 表示直连
	if (!proxy) {
		return undefined;
	}

	let proxyUrl: URL;
	try {
		proxyUrl = new URL(proxy);
	} catch (error) {
		// 代理变量存在但值不是合法 URL：立即失败并附上原始值，便于排查配置问题
		throw new Error(
			`Invalid proxy URL ${JSON.stringify(proxy)}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	// 仅支持 HTTP(S) 代理；SOCKS / PAC 没有对应的 Agent 实现，直接报错
	if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
		throw new Error(`${UNSUPPORTED_PROXY_PROTOCOL_MESSAGE} Got ${proxyUrl.protocol}`);
	}

	return proxyUrl;
}
