/**
 * @file http-dispatcher.ts —— HTTP 请求分发器（undici Dispatcher）配置
 *
 * @description
 * 为全局 fetch 安装统一的 undici 分发器：统一连接池、空闲/响应头超时与
 * 环境变量代理；同时提供 HTTP 空闲超时配置的解析与格式化工具，
 * 供设置界面与启动流程调用。
 */
import { EventEmitter } from "node:events";
import * as undici from "undici";

/** 默认 HTTP 空闲超时：5 分钟（bodyTimeout / headersTimeout 共用） */
export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node 默认的 250ms 在高延迟链路上可能中断合法的连接尝试，故放宽到 2 秒。
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

/** 设置界面可选的空闲超时档位（timeoutMs 为 0 表示禁用超时） */
export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

/**
 * 把设置中的空闲超时值解析为毫秒数。
 *
 * 接受字符串（"disabled" → 0、数字字符串、空串 → undefined）或非负有限数字；
 * 无法解析时返回 undefined，由调用方决定如何报错。
 */
export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

/** 把毫秒超时格式化为界面文案：优先命中预设档位标签，否则退化为「N sec」 */
export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

/**
 * 把用户配置的 HTTP 代理地址写入 HTTP_PROXY / HTTPS_PROXY 环境变量。
 * 使用 ??=，不覆盖调用前已存在的环境变量。
 */
export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

// 吞掉 undici 内部 error 事件的空监听器（见下 withUndiciErrorListener 的说明）
const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// undici 在中断一个流式 fetch body 的过程中可能抛出内部 Client "error" 事件。
// body 流本身仍会通过 reader.read() reject；这里挂一个空监听器，
// 只是避免 EventEmitter 的未处理 "error" 特例把整个 pi 进程搞崩。
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

/** 创建单个 origin 的 undici Client，并挂上防崩溃的 error 监听 */
function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

/**
 * 为单个 origin 创建分发器：connections === 1 时退化为单连接 Client，
 * 其余情况用 Pool（以 createUndiciClient 为连接工厂）管理多连接。
 */
function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

/**
 * 构造并安装全局 HTTP 分发器（EnvHttpProxyAgent：支持环境变量代理）。
 *
 * 统一设置 body/headers 空闲超时、禁用 HTTP/2（allowH2: false）、
 * 放宽地址族自动选择的尝试超时，并把全局 fetch 切到同一份 undici 实现。
 *
 * @param timeoutMs - 空闲超时毫秒数，0 表示禁用；非法值抛出 Error
 */
export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// 让 fetch 与分发器跑在同一份 undici 实现上。否则 Node 26.0 自带的 fetch
	// 可能通过 npm 版 undici 的分发器读取压缩响应而不解压，导致 response.json() 失败。
	// 若调用方在本模块加载后又替换过 fetch，则保留那次刻意的覆盖，不再强装。
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
