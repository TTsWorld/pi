/**
 * @file Result<T, E> 显式错误风格的配套工具：带标签错误（TaggedError）与模式匹配。
 * @description harness 层的约定是"预期失败以 ok:false 返回而非抛出异常"。本文件在
 *   Result 类型与命名空间式工厂之外，核心是 TaggedError：以 tag 为键生成可继承的
 *   错误基类（各处以 `class XxxError extends TaggedError("Xxx")<{...}>` 声明结构化错误），
 *   再配合 matchError 按 _tag 做穷尽式分支处理。
 */

/** 易错操作的结果：成功携带 value，预期失败携带 error（ok: false）而不是抛出异常。 */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Result 的命名空间式工厂：构造结果并做类型判断。 */
export const Result = {
	/** 构造成功结果。 */
	ok<TValue>(value: TValue): Result<TValue, never> {
		return { ok: true, value };
	},
	/** 构造失败结果。 */
	err<TError>(error: TError): Result<never, TError> {
		return { ok: false, error };
	},
	/** 类型守卫：结果是否为成功。 */
	isOk<TValue, TError>(result: Result<TValue, TError>): result is { ok: true; value: TValue } {
		return result.ok;
	},
	/** 类型守卫：结果是否为失败。 */
	isErr<TValue, TError>(result: Result<TValue, TError>): result is { ok: false; error: TError } {
		return !result.ok;
	},
};

/**
 * 带标签的错误实例类型：在 Error 之上附加只读 _tag 标识错误类别，
 * 并支持结构化序列化（toJSON），便于日志输出与跨边界传输。
 */
export interface TaggedErrorValue<Tag extends string> extends Error {
	/** 错误类别标签（如 "LaneBusy"）。 */
	readonly _tag: Tag;
	/** 序列化为包含 _tag、message 及其余自有属性的普通对象。 */
	toJSON(): { _tag: Tag; message: string } & Record<string, unknown>;
}

/**
 * TaggedError(tag) 的返回值：可 new 的错误类工厂。
 * 用 `class X extends TaggedError("X")<{...}>` 声明具体错误类型，
 * 静态方法 is() 提供 instanceof 级别的类型守卫。
 */
export interface TaggedErrorFactory<Tag extends string> {
	new <Props extends { message: string }>(props: Props): TaggedErrorValue<Tag> & Readonly<Props>;
	/** 类型守卫：值是否为本工厂创建的实例。 */
	is(value: unknown): value is TaggedErrorValue<Tag>;
}

/**
 * 创建一类带标签的错误基类。
 * 每次调用都会生成一个新的 class，因此 is() 只认同一工厂（及其子类）的实例。
 * @param tag 错误类别标签，同时用作实例的 name 与序列化后的 _tag。
 * @returns 可继承的错误类工厂，见 {@link TaggedErrorFactory}。
 */
export function TaggedError<Tag extends string>(tag: Tag): TaggedErrorFactory<Tag> {
	class TaggedErrorClass extends Error {
		// 标签同时挂在实例属性与 name 上，便于日志识别与 instanceof 守卫。
		readonly _tag = tag;

		constructor(props: { message: string } & Record<string, unknown>) {
			super(props.message);
			this.name = tag;
			// 把 message 之外的自定义属性（如 lane、reason）也挂到实例上，供类型收窄后直接访问。
			Object.assign(this, props);
		}

		/** 序列化：以 _tag 与 message 开头，再展开其余自有可枚举属性。 */
		toJSON(): { _tag: Tag; message: string } & Record<string, unknown> {
			const payload: Record<string, unknown> = {};
			// 收集除 _tag 之外的自有属性（_tag 已单独放在返回值开头）。
			for (const key of Object.keys(this)) {
				if (key !== "_tag") payload[key] = (this as unknown as Record<string, unknown>)[key];
			}
			return { _tag: tag, message: this.message, ...payload };
		}

		/** 类型守卫：基于 instanceof 判断是否为本工厂创建的错误实例。 */
		static is(value: unknown): value is TaggedErrorValue<Tag> {
			return value instanceof TaggedErrorClass;
		}
	}
	// class 表达式无法同时表达"new 签名 + is 静态方法"的工厂形状，需整体断言为接口。
	return TaggedErrorClass as unknown as TaggedErrorFactory<Tag>;
}

/**
 * matchError 的匹配表：键为 TError 的每个 _tag 标签，值为对应分支的处理函数。
 * 由于必须覆盖所有标签，漏配分支会在编译期报错（穷尽性由类型系统保证）。
 */
export type ErrorMatchers<TError extends TaggedErrorValue<string>, TValue> = {
	[Tag in TError["_tag"]]: (error: Extract<TError, { _tag: Tag }>) => TValue;
};

/**
 * 按 _tag 对带标签错误做穷尽式分发。
 * @param error 待分发的带标签错误。
 * @param matchers 以 _tag 为键的分支处理表，见 {@link ErrorMatchers}。
 * @returns 所匹配分支的返回值。
 */
export function matchError<TError extends TaggedErrorValue<string>, TValue>(
	error: TError,
	matchers: ErrorMatchers<TError, TValue>,
): TValue {
	// 映射类型的键无法直接索引，断言为普通 Record 后按 _tag 查表调用。
	const matcher = (matchers as unknown as Record<string, (value: TError) => TValue>)[error._tag];
	return matcher(error);
}
