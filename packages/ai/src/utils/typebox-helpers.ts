/**
 * @file TypeBox 自定义 schema 辅助工具。
 * 提供 StringEnum：生成 enum 风格的字符串 schema，兼容不支持 anyOf/const 模式的 provider（如 Google API），供定义工具参数使用。
 */
import { type TUnsafe, Type } from "typebox";

/**
 * 创建与 Google API 及其他不支持 anyOf/const 模式的 provider 兼容的字符串枚举 schema。
 *
 * 通过 Type.Unsafe 直接输出 JSON Schema 的 { type: "string", enum: [...] } 形式，静态类型推断为枚举值的联合类型。
 *
 * @param values 允许的枚举值列表
 * @param options 可选附加项：description 描述文案、default 默认值
 * @returns 对应的 TypeBox schema（TUnsafe 包装，静态类型为 T[number]）
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract", "multiply", "divide"], {
 *   description: "The operation to perform"
 * });
 *
 * type Operation = Static<typeof OperationSchema>; // "add" | "subtract" | "multiply" | "divide"
 */
export function StringEnum<T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({
		type: "string",
		enum: values as any,
		...(options?.description && { description: options.description }),
		...(options?.default && { default: options.default }),
	});
}
