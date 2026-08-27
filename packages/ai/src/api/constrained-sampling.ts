/**
 * @file 约束采样（constrained sampling）支持
 * @description 两类约束的统一处理：
 *              1. strict JSON-schema：把工具参数 schema 改写成 provider 严格模式要求的
 *                 子集（全字段必填 + additionalProperties:false），不支持的结构直接报错
 *              2. grammar（Lark/regex）：从工具声明解析文法定义与承载输入的属性名，
 *                 并在流式回放时把「输入属性的增长文本」增量拼回 JSON delta
 *
 * 依赖关系：
 * - ../types.ts 的 Tool（含 constrainedSampling 声明）；被各 API 实现调用
 */

import type { Tool } from "../types.ts";

/** JSON schema 对象的宽松形态（字段逐个探测） */
interface JsonSchemaObject {
	[key: string]: unknown;
	type?: unknown;
	properties?: Record<string, JsonSchemaObject | undefined>;
	required?: unknown;
}

/** schema 结构超出严格模式支持范围时抛出（区别于真正的程序错误） */
class UnsupportedStrictJsonSchemaError extends Error {}

// 严格模式不支持的结构化关键字：$ref 引用、组合逻辑、条件分支等
//（provider 的 strict 子集只有「对象 + 全必填 + 禁额外属性 + anyOf 基础类型联合」）
const UNSUPPORTED_STRICT_SCHEMA_KEYS = [
	"$ref",
	"$defs",
	"definitions",
	"allOf",
	"oneOf",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"unevaluatedProperties",
	"propertyNames",
	"contains",
	"prefixItems",
	"not",
	"if",
	"then",
	"else",
] as const;

/** 类型守卫：JSON schema 节点必须是普通对象（布尔 schema 单独处理/拒绝） */
function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 是否为「结构化」schema（对象/数组形态）：strict 模式下 anyOf 里不允许出现 */
function isStructuredSchema(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
	return (
		types.includes("object") ||
		types.includes("array") ||
		schema.properties !== undefined ||
		schema.items !== undefined
	);
}

/** schema 是否允许 null（type/const/enum/anyOf 四种形态任一命中） */
function schemaAllowsNull(schema: unknown): boolean {
	if (!isJsonSchemaObject(schema)) return false;
	if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
	if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true;
	return Array.isArray(schema.anyOf) && schema.anyOf.some((variant) => schemaAllowsNull(variant));
}

/**
 * 递归把 schema 节点改写为严格模式（就地修改）：
 * - 拒绝不支持的关键字与结构（布尔 schema、$ref、组合逻辑、元组 items 等）
 * - anyOf 仅允许基础类型联合（对象/数组联合不支持）
 * - 对象节点的非必填属性包一层 `anyOf: [属性, {type:"null"}]`，然后全部标记为必填
 *   ——严格模式要求全必填，用可空联合保住「原来可选」的语义
 * - 最后强制 additionalProperties: false
 */
function makeJsonSchemaNodeStrict(schema: unknown): void {
	if (!isJsonSchemaObject(schema)) {
		throw new UnsupportedStrictJsonSchemaError("boolean schemas are unsupported");
	}
	for (const key of UNSUPPORTED_STRICT_SCHEMA_KEYS) {
		if (schema[key] !== undefined) {
			throw new UnsupportedStrictJsonSchemaError(`${key} schemas are unsupported`);
		}
	}

	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
			throw new UnsupportedStrictJsonSchemaError("anyOf must contain at least one schema");
		}
		for (const variant of schema.anyOf) {
			if (isStructuredSchema(variant)) {
				throw new UnsupportedStrictJsonSchemaError("object and array unions are unsupported");
			}
			makeJsonSchemaNodeStrict(variant);
		}
	}

	if (schema.items !== undefined) {
		// 数组形式的 items 是元组（tuple）语义，严格模式不支持
		if (Array.isArray(schema.items)) {
			throw new UnsupportedStrictJsonSchemaError("tuple schemas are unsupported");
		}
		makeJsonSchemaNodeStrict(schema.items);
	}

	const isObjectSchema = schema.type === "object";
	if (schema.properties !== undefined && !isObjectSchema) {
		throw new UnsupportedStrictJsonSchemaError("properties require type object");
	}
	if (!isObjectSchema) return;
	// additionalProperties 只接受 false（true 或 schema 形态都不支持）
	if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
		throw new UnsupportedStrictJsonSchemaError("schema-valued or true additionalProperties is unsupported");
	}
	if (schema.properties !== undefined && !isJsonSchemaObject(schema.properties)) {
		throw new UnsupportedStrictJsonSchemaError("object properties must be a schema map");
	}
	if (
		schema.required !== undefined &&
		(!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))
	) {
		throw new UnsupportedStrictJsonSchemaError("object required must be a string array");
	}

	const properties = schema.properties ?? {};
	const propertyNames = Object.keys(properties);
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	// required 里出现 properties 没定义的键属于 schema 自身错误
	if ([...required].some((key) => !propertyNames.includes(key))) {
		throw new UnsupportedStrictJsonSchemaError("required contains an unknown property");
	}
	for (const [key, property] of Object.entries(properties)) {
		makeJsonSchemaNodeStrict(property);
		// 原本可选的属性包一层可空联合，再随全量必填一起发——语义上仍是「可缺省」
		if (!required.has(key) && !schemaAllowsNull(property)) {
			properties[key] = { anyOf: [property, { type: "null" }] };
		}
	}
	// 严格模式三件套：全字段必填 + 禁额外属性
	schema.required = propertyNames;
	schema.additionalProperties = false;
}

/** 把工具 schema 转换为 provider 约束采样期望的严格子集（深拷贝后就地改写）。 */
export function makeStrictJsonSchema(schema: Tool["parameters"]): Record<string, unknown> {
	const cloned: unknown = structuredClone(schema);
	if (!isJsonSchemaObject(cloned)) {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	makeJsonSchemaNodeStrict(cloned);
	if (cloned.type !== "object") {
		throw new UnsupportedStrictJsonSchemaError("root schema must have type object");
	}
	return cloned;
}

/** 按需取工具参数：strict 为 true 时返回严格化改写版，否则原样返回 */
export function getJsonSchemaToolParameters(tool: Tool, strict: boolean | undefined): Tool["parameters"] {
	return (strict === true ? makeStrictJsonSchema(tool.parameters) : tool.parameters) as Tool["parameters"];
}

/** 文法约束的解析结果：格式（lark/regex）、文法定义、承载输入的属性名 */
export interface GrammarConstrainedSampling {
	format: "lark" | "regex";
	definition: string;
	inputProperty: string;
}

/** 文法工具输入的流式缓冲状态（输入文本单调增长，关闭后不可再变） */
export interface GrammarToolInputJsonBuffer {
	input: string;
	started: boolean;
	closed: boolean;
}

/** 从完整工具调用参数中取出文法输入属性（必须是字符串，否则报错） */
export function getGrammarToolInput(
	toolName: string,
	arguments_: Record<string, unknown>,
	inputProperty: string,
): string {
	const input = arguments_[inputProperty];
	if (typeof input !== "string") {
		throw new Error(`Grammar tool call "${toolName}" requires argument "${inputProperty}" to be a string.`);
	}
	return input;
}

/**
 * 把「输入属性文本的增量」翻译为 JSON 参数流的 delta：
 * 首次产出 `{属性名:"` 前缀，增量做 JSON 字符串转义后追加，close 时补 `"}` 收尾。
 * 校验输入只能单调增长、关闭后不可变更——保证重放出的 JSON 始终合法。
 * 无新增内容且未关闭时返回 undefined（无 delta 可发）。
 */
export function appendGrammarToolInputJsonDelta(
	buffer: GrammarToolInputJsonBuffer,
	inputProperty: string,
	nextInput: string,
	close: boolean,
): string | undefined {
	if (buffer.closed) {
		// 已关闭后的合法操作只有「相同内容的重复关闭」，其余一律报错
		if (close && nextInput === buffer.input) return undefined;
		throw new Error(`grammar tool input for property "${inputProperty}" changed after it was closed`);
	}
	// 文本必须只增不改（前缀保持），否则重放的 JSON 会与流出的内容矛盾
	if (!nextInput.startsWith(buffer.input)) {
		throw new Error(`grammar tool input for property "${inputProperty}" changed non-monotonically`);
	}

	const inputDelta = nextInput.slice(buffer.input.length);
	if (!close && inputDelta.length === 0) return undefined;

	let delta = "";
	// 首个 delta 带 JSON 前缀：{"属性名":"
	if (!buffer.started) {
		delta += `{${JSON.stringify(inputProperty)}:"`;
		buffer.started = true;
	}
	// 增量部分：整体 JSON.stringify 再剥掉首尾引号，得到转义后的中间片段
	delta += JSON.stringify(inputDelta).slice(1, -1);
	buffer.input = nextInput;

	if (close) {
		delta += '"}';
		buffer.closed = true;
	}
	return delta;
}

/**
 * 从工具 schema 推断文法输入属性：要求「恰好一个必填的 string 属性」
 * ——文法约束的输出全部落在该属性里，其余属性无意义。
 */
function inferGrammarInputProperty(tool: Tool): string {
	const schema = tool.parameters as JsonSchemaObject;
	if (schema.type !== "object") {
		throw new Error("grammar constrained sampling requires an object parameter schema");
	}
	if (!Array.isArray(schema.required) || schema.required.length !== 1 || typeof schema.required[0] !== "string") {
		throw new Error("grammar constrained sampling requires exactly one required string property");
	}

	const inputProperty = schema.required[0];
	if (!schema.properties?.[inputProperty]) {
		throw new Error(`grammar constrained sampling requires a properties entry for ${inputProperty}`);
	}
	if (schema.properties[inputProperty]?.type !== "string") {
		throw new Error(`grammar constrained sampling property ${inputProperty} must have type string`);
	}
	return inputProperty;
}

/**
 * 决定工具是否启用 strict JSON-schema 约束采样。
 * - 未声明 json_schema 约束：undefined（不启用）
 * - provider 支持且 schema 可严格化：true；schema 不可严格化时按声明的严格度
 *   （strict: "require" 抛错 / 其他静默降级为 undefined）
 * - provider 不支持但声明了 require：抛错
 */
export function resolveJsonSchemaStrictSampling(tool: Tool, supportsStrictMode: boolean): boolean | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "json_schema") return undefined;

	if (supportsStrictMode) {
		try {
			makeStrictJsonSchema(tool.parameters);
			return true;
		} catch (error) {
			// 只降级「schema 结构不支持」；真正的程序错误继续抛出
			if (!(error instanceof UnsupportedStrictJsonSchemaError)) throw error;
			if (config.strict !== "require") return undefined;
			throw new Error(`Tool "${tool.name}" requires JSON-schema constrained sampling, but ${error.message}.`);
		}
	}
	if (config.strict === "require") {
		throw new Error(
			`Tool "${tool.name}" requires JSON-schema constrained sampling, but strict tools are unsupported.`,
		);
	}
	return undefined;
}

/**
 * 解析工具的文法约束（provider 支持 grammar 工具时）：
 * 从 variants 里优先取 openai_lark、其次 openai_regex，两者都没有则报错；
 * 再从 schema 推断输入属性。provider 不支持时静默返回 undefined。
 */
export function resolveGrammarConstrainedSampling(
	tool: Tool,
	supportsOpenAIGrammarTools: boolean,
): GrammarConstrainedSampling | undefined {
	const config = tool.constrainedSampling;
	if (!config || config.type !== "grammar") {
		return undefined;
	}

	if (!supportsOpenAIGrammarTools) {
		return undefined;
	}

	const larkDefinition = config.variants.openai_lark;
	const regexDefinition = config.variants.openai_regex;
	const hasLarkDefinition = typeof larkDefinition === "string" && larkDefinition.trim().length > 0;
	const hasRegexDefinition = typeof regexDefinition === "string" && regexDefinition.trim().length > 0;
	if (!hasLarkDefinition && !hasRegexDefinition) {
		throw new Error(
			`Tool "${tool.name}" cannot use grammar constrained sampling: no supported grammar variant was provided.`,
		);
	}

	try {
		return {
			format: hasLarkDefinition ? "lark" : "regex",
			definition: hasLarkDefinition ? larkDefinition : regexDefinition!,
			inputProperty: inferGrammarInputProperty(tool),
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Tool "${tool.name}" cannot use grammar constrained sampling: ${message}.`);
	}
}

/** 汇总所有启用文法约束的工具：工具名 → 输入属性名（流式回放时按名查表） */
export function createGrammarToolInputProperties(
	tools: Tool[] | undefined,
	supportsOpenAIGrammarTools: boolean,
): ReadonlyMap<string, string> {
	const properties = new Map<string, string>();
	for (const tool of tools ?? []) {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			properties.set(tool.name, grammar.inputProperty);
		}
	}
	return properties;
}
