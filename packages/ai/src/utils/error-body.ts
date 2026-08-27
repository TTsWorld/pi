/**
 * @file provider HTTP 错误对象的共享归一化
 * @description 代理/网关后的端点可能返回 SDK 无法折叠进 `error.message` 的非 2xx 响应体：
 *              SDK 错误对象仍携带 HTTP 状态与原始/已解析的响应体，但字段名因 SDK 而异。
 *              只读 `error.message` 的 catch 块会丢掉响应体，呈现出 "403 status code
 *              (no body)" 或坍缩成 "Unknown: UnknownError" 这类不透明消息。
 *
 * 主要功能：
 * - normalizeProviderError：探测各 SDK（Mistral、openai、@google/genai、AWS Bedrock）
 *   的已知字段形态，返回供各 provider 拼接展示字符串的结构体
 * - formatProviderError：把归一化结果拼成展示字符串（含 messageCarriesBody 判定，
 *   避免 Anthropic / @google/genai 快乐路径下 body 被重复打印）
 */

/** 错误响应体的最大保留字符数（超出截断） */
export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

/** 归一化后的 provider 错误结构 */
export interface NormalizedProviderError {
	/** 能从 SDK 错误对象中提取到的 HTTP 状态码。 */
	status?: number;
	/** 原始 HTTP 响应体文本，已去除首尾空白并截断到上限。 */
	body?: string;
	/** `error.message`；非 Error 抛出物则为 safeJsonStringify 的结果。 */
	message: string;
	/** message 已包含响应体时为 true（无需再拼接单独的 body）。 */
	messageCarriesBody: boolean;
}

/** 各家 SDK 错误对象的字段并集形态（字段均为 unknown，逐个探测） */
type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

/**
 * 把任意抛出物归一化为 NormalizedProviderError。
 * 非 Error 值整体 JSON 序列化充当 message；Error 则探测状态码与响应体，
 * 并用「message 是否已含 body」判定 messageCarriesBody。
 */
export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

/**
 * 探测 HTTP 状态码，按 SDK 字段顺序取第一个数值命中：
 * `statusCode`（Mistral）→ `status`（openai、@google/genai）→
 * `$metadata.httpStatusCode`（Bedrock）→ `$response.statusCode`（Bedrock）。
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * 探测原始响应体文本，按 SDK 字段顺序取第一个可用命中：
 * `body` 字符串（Mistral）→ `error` 已解析 JSON 体对象（openai SDK 的
 * `this.error`）→ `$response.body`（Bedrock）。空对象与未读的响应流
 * 视为「无响应体」，避免展现出 "{}" 或序列化的流内部结构。选中的体截断到上限。
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

/** 按字段形态挑选响应体文本；流式/空对象等不可用形态返回 undefined */
function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

/** Node 流嗅探：有 pipe 方法的对象视为未读的响应流（其字符串化是垃圾） */
function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * 只有「普通对象」才算 HTTP 响应体。SDK 错误字段里可能放着类实例而非已解析的体——
 * AWS SDK v3 的 `$response.body` 是 HTTP 流/响应包装对象，字符串化会产出
 * `{"_events":...}` 这类垃圾并顶替 `error.message` 参与展示拼接。而
 * `error.message` 才是 SDK 放真正反序列化异常文本（"Input is too long..."、
 * schema 校验细节等）的地方——唯一有用的字符串反而被噪音挤掉了。
 * 类实例不产出 body、messageCarriesBody 保持 true，真实消息得以保留。
 * 与上面的 pipe 嗅探互补：web ReadableStream（只有 pipeTo/pipeThrough、没有 pipe）
 * 与非流式 SDK 包装类都过不了原型检查，而已解析的 JSON 体（构造上就是普通对象）依然通过。
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * 用归一化结果拼接展示字符串。当 message 已携带响应体（Anthropic / @google/genai
 * 快乐路径）或未提取到 body/status 时，原样返回 message；否则把状态码与响应体
 * 展现出来，可带 provider 前缀。
 *
 * - 无前缀：`"<status>: <body>"`
 * - 有前缀：`"<prefix> (<status>): <body>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		return prefix !== undefined && norm.status !== undefined
			? `${prefix} (${norm.status}): ${norm.message}`
			: norm.message;
	}
	return prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
}

/** 超长文本截断，并注明被截掉的字符数 */
export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

/** 安全 JSON 序列化：循环引用等异常降级为 String(value)，永不抛错 */
export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
