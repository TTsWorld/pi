/**
 * @file 工具调用参数校验(validation.ts)
 * @description
 * 模型输出的工具调用参数经常与工具定义的 JSON Schema 有出入:数字被写成字符串
 * ("123")、未提供的可选字段被填成 null、布尔写成 "true"/1 等。本文件在参数
 * 真正交给工具执行前做一次「先宽松矫正、后严格校验」的收口:
 * 1. normalizeOptionalNulls:删除可选字段的显式 null;
 * 2. Value.Convert / coerceWithJsonSchema:按 schema 尽力做类型矫正;
 * 3. 用 TypeBox 编译出的校验器做最终判定:通过则返回矫正后的参数,不通过则
 *    抛出带「字段路径 + 错误原因 + 原始参数」的异常,便于回传给模型自我修正。
 * 对外导出:validateToolCall / validateToolArguments。
 */

import { Compile } from "typebox/compile";
import type { TLocalizedValidationError } from "typebox/error";
import { Value } from "typebox/value";
import type { Tool, ToolCall } from "../types.ts";

// ========== 模块级缓存与 TypeBox 识别 ==========

/**
 * 已编译校验器缓存,以 schema 对象自身为键(WeakMap 不阻止其被 GC)。
 * Why:Compile 一次的开销远大于查表,而同一工具定义会被反复调用,
 * 缓存后每个 schema 对象只编译一次。
 */
const validatorCache = new WeakMap<object, ReturnType<typeof Compile>>();

/**
 * TypeBox 生成的 schema 对象自带名为 Kind 的 Symbol 属性;手写的普通
 * JSON Schema 对象则没有。用它区分两类 schema:普通 JSON Schema 走不了
 * TypeBox 内置的 Value.Convert 转换,需要走本文件自定义的宽松矫正逻辑。
 */
const TYPEBOX_KIND = Symbol.for("TypeBox.Kind");

/**
 * 递归遍历时使用的 JSON Schema 结构子集,只声明矫正逻辑需要访问的字段。
 * TypeBox 的 TSchema 结构与其兼容,因此代码中常以
 * `as JsonSchemaObject` 把 TSchema 当普通 JSON Schema 读取。
 */
interface JsonSchemaObject {
	/** 声明的 JSON 类型;数组形式表示类型联合,如 ["string", "null"]。 */
	type?: string | string[];
	/** 对象类型的属性 schema 表(键为属性名)。 */
	properties?: Record<string, JsonSchemaObject>;
	/** 必填属性名列表;不在其中的属性视为可选。 */
	required?: string[];
	/** 数组元素 schema:数组形式表示元组(逐位置对应),单对象表示所有元素共用。 */
	items?: JsonSchemaObject | JsonSchemaObject[];
	/** 额外属性约束:为 schema 对象时,未在 properties 中声明的键也按它矫正。 */
	additionalProperties?: boolean | JsonSchemaObject;
	/** 逻辑与:值需同时满足所有子 schema。 */
	allOf?: JsonSchemaObject[];
	/** 逻辑或:值满足任意一个子 schema 即可。 */
	anyOf?: JsonSchemaObject[];
	/** 互斥或:值必须恰好满足一个子 schema。 */
	oneOf?: JsonSchemaObject[];
}

// ========== Schema 读取与 JSON 类型判断 ==========

/**
 * 读取 schema 声明的 JSON 类型列表。
 * @param schema 待读取的 schema
 * @returns 类型名数组:type 为字符串时返回单元素数组,为数组时返回过滤掉
 * 非字符串项后的列表(防御式处理),未声明则返回空数组
 */
function getSchemaTypes(schema: JsonSchemaObject): string[] {
	if (typeof schema.type === "string") {
		return [schema.type];
	}
	if (Array.isArray(schema.type)) {
		return schema.type.filter((type): type is string => typeof type === "string");
	}
	return [];
}

/**
 * 判断 JS 值是否匹配指定的 JSON 类型名。
 * @param value 待检查的值
 * @param type JSON 类型名
 * @returns 是否匹配
 */
function matchesJsonType(value: unknown, type: string): boolean {
	switch (type) {
		case "number":
			return typeof value === "number";
		case "integer":
			// JSON Schema 的 integer 指「无小数部分的 number」,JS 并无此基础类型
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "string":
			return typeof value === "string";
		case "null":
			return value === null;
		case "array":
			return Array.isArray(value);
		case "object":
			// 注意:JSON Schema 的 object 不包含数组与 null,与 JS typeof 语义不同
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

// ========== 宽松类型矫正(coercion) ==========

/**
 * 尝试为子 schema 编译校验器。
 * @param schema 子 schema
 * @returns 编译产物;编译失败(如子 schema 本身不合法)时返回 undefined,
 * 调用方用可选链兜底,保证单个坏 schema 不会中断整体矫正流程
 */
function getSubSchemaValidator(schema: JsonSchemaObject): ReturnType<typeof Compile> | undefined {
	try {
		return getValidator(schema as Tool["parameters"]);
	} catch {
		return undefined;
	}
}

/**
 * 按目标 JSON 类型对原始值做「尽力而为」的矫正。
 *
 * 矫正策略(与模型输出的常见偏差一一对应):
 * - null → 该类型的零值(0 / false / "");空串/0/false → null;
 * - 数字/整数字段:接受可解析的数字字符串("42" → 42),布尔转 1/0;
 * - 布尔字段:仅接受 "true"/"false" 与 1/0;
 * - 字符串字段:数字/布尔转字符串。
 *
 * @param value 原始值
 * @param type 目标 JSON 类型名
 * @returns 矫正后的值;无法安全矫正时原样返回,调用方通过
 * 「返回值与入参是否为同一引用」判断是否发生了矫正
 */
function coercePrimitiveByType(value: unknown, type: string): unknown {
	switch (type) {
		case "number": {
			// null 视为缺省,补零值
			if (value === null) {
				return 0;
			}
			// 非空字符串尝试解析为有限数字("42" → 42);空串或 NaN/Infinity 不动
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) {
					return parsed;
				}
			}
			// 布尔按惯例转 1/0
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "integer": {
			// 与 number 同策略,但字符串仅当解析结果为整数时才转("3" → 3,"3.5" 不动)
			if (value === null) {
				return 0;
			}
			if (typeof value === "string" && value.trim() !== "") {
				const parsed = Number(value);
				if (Number.isInteger(parsed)) {
					return parsed;
				}
			}
			if (typeof value === "boolean") {
				return value ? 1 : 0;
			}
			return value;
		}
		case "boolean": {
			// null 视为缺省,补 false
			if (value === null) {
				return false;
			}
			// 仅接受字面量 "true"/"false",避免误转 "yes" 之类的任意字符串
			if (typeof value === "string") {
				if (value === "true") {
					return true;
				}
				if (value === "false") {
					return false;
				}
			}
			// 数字仅接受 1/0
			if (typeof value === "number") {
				if (value === 1) {
					return true;
				}
				if (value === 0) {
					return false;
				}
			}
			return value;
		}
		case "string": {
			// null 视为缺省,补空串
			if (value === null) {
				return "";
			}
			// 数字/布尔转字符串(42 → "42")
			if (typeof value === "number" || typeof value === "boolean") {
				return String(value);
			}
			return value;
		}
		case "null": {
			// JSON 假值空串/0/false 语义上更接近 null,统一转成 null
			if (value === "" || value === 0 || value === false) {
				return null;
			}
			return value;
		}
		default:
			// 其他类型(嵌套 object/array 等)不做原始值层面的矫正,交给容器递归逻辑
			return value;
	}
}

/**
 * 按 schema 矫正对象类型的值(就地修改)。
 * 只矫正 value 中已存在的键,不负责补默认值。
 * @param value 待矫正的对象(会被就地修改)
 * @param schema 对应的 schema
 */
function applySchemaObjectCoercion(value: Record<string, unknown>, schema: JsonSchemaObject): void {
	const properties = schema.properties;
	// 记录已声明的属性名,供 additionalProperties 分支排除
	const definedKeys = new Set<string>(properties ? Object.keys(properties) : []);

	if (properties) {
		// 逐个矫正「已声明且实际出现」的属性
		for (const [key, propertySchema] of Object.entries(properties)) {
			if (!(key in value)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(value[key], propertySchema);
		}
	}

	// additionalProperties 为 schema 对象时,未被 properties 声明的键也按它矫正
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		for (const [key, propertyValue] of Object.entries(value)) {
			if (definedKeys.has(key)) {
				continue;
			}
			value[key] = coerceWithJsonSchema(propertyValue, schema.additionalProperties);
		}
	}
}

/**
 * 按 schema 矫正数组类型的值(就地修改)。
 * @param value 待矫正的数组(会被就地修改)
 * @param schema 对应的 schema
 */
function applySchemaArrayCoercion(value: unknown[], schema: JsonSchemaObject): void {
	// items 为数组:元组语法,每个位置对应各自的 schema;超出 schema 数量的元素跳过
	if (Array.isArray(schema.items)) {
		for (let index = 0; index < value.length; index++) {
			const itemSchema = schema.items[index];
			if (!itemSchema) {
				continue;
			}
			value[index] = coerceWithJsonSchema(value[index], itemSchema);
		}
		return;
	}

	// items 为单个对象:所有元素共用同一 schema
	if (schema.items && typeof schema.items === "object") {
		for (let index = 0; index < value.length; index++) {
			value[index] = coerceWithJsonSchema(value[index], schema.items);
		}
	}
}

/**
 * 处理 anyOf / oneOf 联合类型 schema 的矫正。
 *
 * 两阶段策略:
 * 1. 先看原值是否已经满足某个成员 schema,满足则原样返回(零成本快路径);
 * 2. 否则逐个成员尝试「克隆 → 按该成员矫正 → 校验」,第一个通过者胜出。
 *
 * Why 必须 structuredClone:矫正会就地修改对象,失败的尝试不能污染原值,
 * 否则前一个成员留下的「半成品矫正」会干扰后续成员的判定。
 *
 * @param value 原始值
 * @param schemas 联合类型的成员 schema 列表
 * @returns 矫正后能通过校验的值;所有成员都失败时原样返回
 */
function coerceWithUnionSchema(value: unknown, schemas: JsonSchemaObject[]): unknown {
	// ========== 阶段一:原值已直接命中某个成员,无需矫正 ==========
	for (const schema of schemas) {
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(value)) {
			return value;
		}
	}

	// ========== 阶段二:逐成员尝试「克隆 → 矫正 → 校验」 ==========
	for (const schema of schemas) {
		const candidate = structuredClone(value);
		const coerced = coerceWithJsonSchema(candidate, schema);
		const validator = getSubSchemaValidator(schema);
		if (validator?.Check(coerced)) {
			return coerced;
		}
	}
	// 全部失败:保留原值,交给最终校验器统一报错,不做瞎猜式转换
	return value;
}

/**
 * 矫正主入口:按 schema 递归地对值做类型矫正。
 *
 * 处理顺序(各步骤有依赖关系,不可调换):
 * 1. allOf:逐个嵌套 schema 依次矫正(值需同时满足所有分支);
 * 2. anyOf / oneOf:交给 coerceWithUnionSchema 做联合矫正;
 * 3. type 声明:值不匹配任何声明类型(且非多类型命中)时,按声明顺序逐类型
 *    尝试原始值矫正,取第一个真正改变了值的方案;
 * 4. object / array:递归矫正属性与元素。
 *
 * @param value 待矫正的值(对象/数组会被就地修改)
 * @param schema 值对应的 schema
 * @returns 矫正后的值(可能是原引用,也可能是联合矫正产生的新对象)
 */
function coerceWithJsonSchema(value: unknown, schema: JsonSchemaObject): unknown {
	let nextValue = value;

	// ========== 1. allOf:所有分支依次作用于同一个值 ==========
	if (Array.isArray(schema.allOf)) {
		for (const nested of schema.allOf) {
			nextValue = coerceWithJsonSchema(nextValue, nested);
		}
	}

	// ========== 2. anyOf / oneOf:联合类型矫正 ==========
	if (Array.isArray(schema.anyOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.anyOf);
	}

	if (Array.isArray(schema.oneOf)) {
		nextValue = coerceWithUnionSchema(nextValue, schema.oneOf);
	}

	// ========== 3. type 声明的原始值矫正 ==========
	const schemaTypes = getSchemaTypes(schema);
	// 多类型联合(如 ["string", "null"])下,只要值命中其中一个类型就不矫正,
	// 避免把本就合法的值强行转成排在前面的类型
	const matchesUnionMember =
		schemaTypes.length > 1 && schemaTypes.some((schemaType) => matchesJsonType(nextValue, schemaType));
	if (schemaTypes.length > 0 && !matchesUnionMember) {
		for (const schemaType of schemaTypes) {
			const candidate = coercePrimitiveByType(nextValue, schemaType);
			// 返回值为同一引用 = 该类型无法矫正,换下一个类型尝试
			if (candidate !== nextValue) {
				nextValue = candidate;
				break;
			}
		}
	}

	// ========== 4. 递归矫正容器(对象属性 / 数组元素) ==========
	if (
		schemaTypes.includes("object") &&
		typeof nextValue === "object" &&
		nextValue !== null &&
		!Array.isArray(nextValue)
	) {
		applySchemaObjectCoercion(nextValue as Record<string, unknown>, schema);
	}

	if (schemaTypes.includes("array") && Array.isArray(nextValue)) {
		applySchemaArrayCoercion(nextValue, schema);
	}

	return nextValue;
}

// ========== 可选字段的显式 null 清理 ==========

/**
 * 递归删除「值为 null 的可选属性」(就地修改)。
 *
 * Why:模型经常把未提供的可选参数显式写成 null,而 TypeBox 中
 * `Type.Optional(Type.String())` 只允许「缺省」、不允许显式 null——
 * 不先清理的话校验必然失败。选择「删除」而非「转零值」,把如何补
 * 默认值留给业务层决定。
 *
 * 同时满足以下条件的属性才会被删除:
 * 1. 属性值确实为 null;
 * 2. 属性不在 required 列表中(即可选);
 * 3. 子 schema 不是 $ref(引用式 schema 无法在此安全展开判定,跳过);
 * 4. null 本身无法通过子 schema 校验(即 schema 并不打算接受 null)。
 *
 * @param value 待清理的参数值(会被就地修改)
 * @param schema 值对应的 schema
 */
function normalizeOptionalNulls(value: unknown, schema: JsonSchemaObject): void {
	// 数组:按元组或统一 items 逐元素递归
	if (Array.isArray(value)) {
		if (Array.isArray(schema.items)) {
			for (let index = 0; index < value.length; index++) {
				const itemSchema = schema.items[index];
				if (itemSchema) normalizeOptionalNulls(value[index], itemSchema);
			}
		} else if (schema.items) {
			for (const item of value) normalizeOptionalNulls(item, schema.items);
		}
		return;
	}
	if (typeof value !== "object" || value === null || !schema.properties) return;

	// ========== 逐属性判定:满足条件则删 null,否则继续向下递归 ==========
	const object = value as Record<string, unknown>;
	const required = new Set(schema.required ?? []);
	for (const [key, propertySchema] of Object.entries(schema.properties)) {
		if (!(key in object)) continue;
		if (
			object[key] === null &&
			!required.has(key) &&
			typeof (propertySchema as { $ref?: unknown }).$ref !== "string" &&
			getSubSchemaValidator(propertySchema)?.Check(null) === false
		) {
			delete object[key];
		} else {
			normalizeOptionalNulls(object[key], propertySchema);
		}
	}
}

// ========== 校验器获取与错误信息构造 ==========

/**
 * 获取(并缓存)schema 的编译校验器。
 * @param schema 工具参数的 TypeBox schema
 * @returns 编译后的校验器(同一 schema 对象只编译一次)
 */
function getValidator(schema: Tool["parameters"]): ReturnType<typeof Compile> {
	const key = schema as object;
	const cached = validatorCache.get(key);
	if (cached) {
		return cached;
	}
	const validator = Compile(schema);
	validatorCache.set(key, validator);
	return validator;
}

/**
 * 把 TypeBox 校验错误的路径格式化为人类可读的点分字段路径。
 * @param error TypeBox 校验错误
 * @returns 点分路径,如 "a.b.c";顶层错误返回 "root"
 */
function formatValidationPath(error: TLocalizedValidationError): string {
	if (error.keyword === "required") {
		// required 错误的 instancePath 指向父对象,这里补上第一个缺失的属性名,
		// 让错误信息直接指向缺失字段(如 "a.b")而不是父对象 "a"
		const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
		const requiredProperty = requiredProperties?.[0];
		if (requiredProperty) {
			const basePath = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
			return basePath ? `${basePath}.${requiredProperty}` : requiredProperty;
		}
	}
	// JSON Pointer("/a/b")转点分路径("a.b");空路径(顶层错误)显示为 "root"
	const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
	return path || "root";
}

// ========== 对外导出的校验入口 ==========

/**
 * 按名称查找工具,并校验该次工具调用的参数是否符合工具的 TypeBox schema
 * @param tools 工具定义列表
 * @param toolCall 模型发起的工具调用
 * @returns 校验通过(可能已被矫正过)的参数
 * @throws 工具不存在或校验失败时抛出 Error
 */
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
	const tool = tools.find((t) => t.name === toolCall.name);
	if (!tool) {
		throw new Error(`Tool "${toolCall.name}" not found`);
	}
	return validateToolArguments(tool, toolCall);
}

/**
 * 校验工具调用参数是否符合工具的 TypeBox schema
 * @param tool 带有 TypeBox schema 的工具定义
 * @param toolCall 模型发起的工具调用
 * @returns 校验通过(且可能已被矫正过)的参数
 * @throws 校验失败时抛出带格式化信息的 Error
 */
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
	// ========== 0. 克隆参数,避免污染会话历史 ==========
	// toolCall.arguments 属于 assistant 消息,后续的 null 清理与类型矫正
	// 只能作用于副本,原始消息必须保持模型输出的原样
	const args = structuredClone(toolCall.arguments);

	// ========== 1. 预处理:清理可选字段 null + TypeBox 内置类型转换 ==========
	// 删除可选字段的显式 null(背景见 normalizeOptionalNulls 的说明)
	normalizeOptionalNulls(args, tool.parameters as JsonSchemaObject);
	// TypeBox 内置的尽力转换(如字符串数字转数字),就地修改 args
	Value.Convert(tool.parameters, args);

	const validator = getValidator(tool.parameters);

	// ========== 2. 普通 JSON Schema 的自定义宽松矫正 ==========
	// 仅当 schema 不带 TypeBox Kind 标记(即手写的普通 JSON Schema)时才执行
	// 自定义矫正,避免与 TypeBox 体系自带的 Value.Convert 重复处理
	if (!Object.getOwnPropertySymbols(tool.parameters).includes(TYPEBOX_KIND)) {
		const coerced = coerceWithJsonSchema(args, tool.parameters as JsonSchemaObject);
		if (coerced !== args) {
			if (typeof args === "object" && args !== null && typeof coerced === "object" && coerced !== null) {
				// 联合矫正可能产生新对象(内部 structuredClone),这里把结果搬回
				// 原 args 引用,保证调用方拿到的始终是同一个对象
				for (const key of Object.keys(args)) {
					delete args[key];
				}
				Object.assign(args, coerced);
			} else {
				// 边界:两者并非都是对象(参数理论上应为对象,防御式处理)——
				// 只有矫正结果能通过校验才采用,否则保留原值走下方统一报错
				return validator.Check(coerced) ? coerced : args;
			}
		}
	}

	// ========== 3. 最终严格校验:通过则返回 ==========
	if (validator.Check(args)) {
		return args;
	}

	// ========== 4. 汇总错误并抛出 ==========
	// 列出全部校验错误(字段路径 + 原因),并附上矫正前的原始参数,
	// 便于把错误信息回传给模型,让其自行修正后重试
	const errors =
		validator
			.Errors(args)
			.map((error) => `  - ${formatValidationPath(error)}: ${error.message}`)
			.join("\n") || "Unknown validation error";

	const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

	throw new Error(errorMessage);
}
