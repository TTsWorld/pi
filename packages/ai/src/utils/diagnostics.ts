/**
 * @file 助手消息诊断记录：把流式请求/处理过程中的错误与异常事件
 * 以结构化形式挂到 assistant 消息上（message.diagnostics），便于事后排查。
 */

/** 错误的结构化快照（与 Error 实例解耦，便于序列化与展示） */
export interface DiagnosticErrorInfo {
	/** 错误名（如 TypeError、AbortError） */
	name?: string;
	/** 错误消息 */
	message: string;
	/** 错误堆栈 */
	stack?: string;
	/** 错误码（常见于 Node 系统错误，如 ECONNRESET） */
	code?: string | number;
}

/** 挂在 assistant 消息上的一条诊断记录 */
export interface AssistantMessageDiagnostic {
	/** 诊断类型标识 */
	type: string;
	/** 记录时间戳（Date.now()，毫秒） */
	timestamp: number;
	/** 关联错误的结构化信息（可选） */
	error?: DiagnosticErrorInfo;
	/** 附加明细 */
	details?: Record<string, unknown>;
}

/**
 * 把任意被抛出的值格式化为可读字符串。
 *
 * @param value - 任意 thrown 值
 * @returns Error 取 message（为空时退化为 name）；字符串原样返回；其余值经 String() 转换
 */
export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

/**
 * 从任意 thrown 值中提取结构化错误信息。
 *
 * @param error - 任意 thrown 值
 * @returns 非 Error 值包装为 name 为 "ThrownValue" 的记录；Error 则提取 name/message/stack，
 *          以及仅当 code 为 string 或 number 时才保留的 code 字段
 */
export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	// 读取常见于 Node 系统错误的 code 属性（Error 类型上未声明，需类型收窄后访问）
	const code = (error as Error & { code?: unknown }).code;
	// name 为空时省略该字段；message 为空时退化为 name，避免输出空字符串
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
	};
}

/**
 * 创建一条带当前时间戳的诊断记录。
 *
 * @param type - 诊断类型标识
 * @param error - 触发诊断的 thrown 值
 * @param details - 附加明细（可选）
 * @returns 可挂到消息上的诊断记录
 */
export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

/**
 * 向消息追加一条诊断记录。
 *
 * 用展开运算符生成新数组而非原地 push，避免改动可能被别处共享的旧数组。
 *
 * @param message - 目标消息（需带可选的 diagnostics 数组）
 * @param diagnostic - 要追加的诊断记录
 */
export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
