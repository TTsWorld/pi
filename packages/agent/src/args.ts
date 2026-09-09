/**
 * @file 自研的类型化 CLI 参数解析器（packages/agent 包内部模块）
 * @description 提供轻量的命令行参数定义与解析能力：
 *              - 通过 `ArgDefs` 以声明式方式描述各参数（类型 / 别名 / 默认值 / 可选值等）
 *              - `parseArgs` 将 string[] 解析为带 TypeScript 类型推导的结果对象
 *              - `printHelp` 按统一格式打印 usage 与选项帮助信息
 *              依赖关系：仅依赖 Node.js 内置模块 os（homedir）与 path（resolve），无第三方依赖。
 */

import { homedir } from "os";
import { resolve } from "path";

/** 可选值（choice）定义：既可以是纯字符串，也可以是带描述说明的对象（用于帮助信息展示） */
export type Choice<T = string> = {
	/** 选项的实际取值 */
	value: T;
	/** 该选项的人类可读描述（仅用于帮助信息展示） */
	description?: string;
};

/** 单个命令行参数的定义 */
export type ArgDef = {
	/** 参数类型：flag（开关）/ boolean / int / float / string / file（文件路径） */
	type: "flag" | "boolean" | "int" | "float" | "string" | "file";
	/** 单字符短别名（如 "h" 对应 --help 的 -h） */
	alias?: string;
	/** 默认值；未指定时 flag/boolean 类型默认为 false */
	default?: any;
	/** 帮助信息中展示的参数说明 */
	description?: string;
	/** 可选值列表：可以是简单字符串，也可以是带描述的对象 */
	choices?: Choice[] | string[]; // Can be simple strings or objects with descriptions
	/**
	 * 控制帮助信息中默认值的展示方式：
	 * - false：隐藏默认值
	 * - true：直接展示 default 的值
	 * - string：展示自定义文案
	 */
	showDefault?: boolean | string; // false to hide, true to show value, string to show custom text
};

/** 参数定义集合：参数名 → 参数定义 的映射 */
export type ArgDefs = Record<string, ArgDef>;

/**
 * 解析结果类型：根据 ArgDefs 中每个参数的 type 做条件类型映射，
 * 使调用方拿到强类型的结果对象（如 flag/boolean → boolean，int/float → number 等），
 * 额外附带 `_` 字段存放位置参数（positional arguments）。
 */
export type ParsedArgs<T extends ArgDefs> = {
	[K in keyof T]: T[K]["type"] extends "flag"
		? boolean
		: T[K]["type"] extends "boolean"
			? boolean
			: T[K]["type"] extends "int"
				? number
				: T[K]["type"] extends "float"
					? number
					: T[K]["type"] extends "string"
						? string
						: T[K]["type"] extends "file"
							? string
							: never;
} & {
	_: string[]; // 位置参数（positional arguments）
};

/**
 * 解析命令行参数
 *
 * @param defs 参数定义集合（参数名 → ArgDef）
 * @param args 原始参数数组（通常是 process.argv 切掉前两项后的部分）
 * @returns 强类型的解析结果：每个参数对应其类型映射后的值，`_` 存放位置参数与未识别的参数
 * @throws 当值无法转换为声明类型、不在 choices 范围内、或缺少必需的值时抛出 Error
 */
export function parseArgs<T extends ArgDefs>(defs: T, args: string[]): ParsedArgs<T> {
	const result: any = { _: [] };
	// 别名 → 规范参数名 的映射表，用于把短别名（-h）还原成完整参数名
	const aliasMap: Record<string, string> = {};

	// ========== 构建别名映射并填充默认值 ==========
	// Why: 解析前先把默认值铺好，可保证未出现在命令行的参数也有确定的取值，
	// 同时把 alias 归一化为完整 key，后续只需按 key 查找一次。
	for (const [key, def] of Object.entries(defs)) {
		if (def.alias) {
			aliasMap[def.alias] = key;
		}
		if (def.default !== undefined) {
			result[key] = def.default;
		} else if (def.type === "flag" || def.type === "boolean") {
			result[key] = false;
		}
	}

	// ========== 逐个解析参数 ==========
	// Why: 采用单循环 + 索引前跳的方式而非预分词，遇到"带值参数"时直接消费下一项，
	// 避免了二次遍历和额外的状态机。
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		// 判断是否为长参数（--xxx）
		if (arg.startsWith("--")) {
			const flagName = arg.slice(2);
			// 先查别名映射表，把别名还原为完整参数名
			const key = aliasMap[flagName] || flagName;
			const def = defs[key];

			if (!def) {
				// 未识别的参数：不报错，降级为位置参数（Why: 交给调用方决定如何处理未知项，保持解析器宽容）
				result._.push(arg);
				continue;
			}

			if (def.type === "flag") {
				// 简单开关型参数：出现即为 true
				result[key] = true;
			} else if (i + 1 < args.length) {
				// 带值参数：取下一个 argv 项作为值
				const value = args[++i];

				let parsedValue: any;

				switch (def.type) {
					case "boolean":
						parsedValue = value === "true" || value === "1" || value === "yes";
						break;
					case "int":
						parsedValue = parseInt(value, 10);
						if (Number.isNaN(parsedValue)) {
							throw new Error(`Invalid integer value for --${key}: ${value}`);
						}
						break;
					case "float":
						parsedValue = parseFloat(value);
						if (Number.isNaN(parsedValue)) {
							throw new Error(`Invalid float value for --${key}: ${value}`);
						}
						break;
					case "string":
						parsedValue = value;
						break;
					case "file": {
						// 展开路径中的 ~ 为用户主目录，并转换为绝对路径
						// Why: CLI 用户习惯用 ~/xxx 指向 home 下的文件，而 fs API 只认绝对/相对路径
						let path = value;
						if (path.startsWith("~")) {
							path = path.replace("~", homedir());
						}
						parsedValue = resolve(path);
						break;
					}
				}

				// ========== 校验可选值范围 ==========
				// Why: 在解析阶段就拦截非法取值并给出完整候选列表，比让错误值流向业务层更易排查
				if (def.choices) {
					const validValues = def.choices.map((c) => (typeof c === "string" ? c : c.value));
					if (!validValues.includes(parsedValue)) {
						throw new Error(
							`Invalid value for --${key}: "${parsedValue}". Valid choices: ${validValues.join(", ")}`,
						);
					}
				}

				result[key] = parsedValue;
			} else {
				throw new Error(`Flag --${key} requires a value`);
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			// 短参数（如 -h）：同样先经别名映射表还原为完整参数名
			const flagChar = arg[1];
			const key = aliasMap[flagChar] || flagChar;
			const def = defs[key];

			if (!def) {
				result._.push(arg);
				continue;
			}

			if (def.type === "flag") {
				result[key] = true;
			} else {
				throw new Error(`Short flag -${flagChar} cannot have a value`);
			}
		} else {
			// 既非 --xxx 也非 -x：按位置参数收集
			result._.push(arg);
		}
	}

	return result as ParsedArgs<T>;
}

/**
 * 打印命令行帮助信息（usage + 所有选项的说明）
 *
 * @param defs 参数定义集合
 * @param usage 用法示例行（如 "pi [options] <prompt>"），原样打印在首行
 */
export function printHelp<T extends ArgDefs>(defs: T, usage: string): void {
	console.log(usage);
	console.log("\nOptions:");

	for (const [key, def] of Object.entries(defs)) {
		// ========== 拼接参数名与别名 ==========
		let line = `  --${key}`;
		if (def.alias) {
			line += `, -${def.alias}`;
		}

		// ========== 拼接值占位符（开关型参数无值占位） ==========
		if (def.type !== "flag") {
			if (def.choices) {
				// 用可选值列表代替类型占位符，让用户一眼看清合法取值
				const simpleChoices = def.choices.filter((c) => typeof c === "string");
				if (simpleChoices.length === def.choices.length) {
					// 全部是简单字符串：直接枚举展示（如 <a|b|c>）
					line += ` <${simpleChoices.join("|")}>`;
				} else {
					// 含带描述的对象：枚举会太长，改为只展示类型
					const typeStr = def.type === "file" ? "path" : def.type;
					line += ` <${typeStr}>`;
				}
			} else {
				const typeStr = def.type === "file" ? "path" : def.type;
				line += ` <${typeStr}>`;
			}
		}

		if (def.description) {
			// 补齐空格使所有参数说明对齐（Why: 固定 30 列对齐，帮助信息更易扫读）
			line = line.padEnd(30) + def.description;
		}

		// ========== 追加默认值说明（showDefault === false 时隐藏；字符串则展示自定义文案） ==========
		if (def.default !== undefined && def.type !== "flag" && def.showDefault !== false) {
			if (typeof def.showDefault === "string") {
				line += ` (default: ${def.showDefault})`;
			} else {
				line += ` (default: ${def.default})`;
			}
		}

		console.log(line);

		// ========== 打印带描述的候选值明细 ==========
		// Why: 当 choices 是带 description 的对象时，单行放不下，
		// 改为在参数行下方逐行列出每个候选值及其说明
		if (def.choices) {
			const hasDescriptions = def.choices.some((c) => typeof c === "object" && c.description);
			if (hasDescriptions) {
				for (const choice of def.choices) {
					if (typeof choice === "object") {
						const choiceLine = `      ${choice.value}`.padEnd(30) + (choice.description || "");
						console.log(choiceLine);
					}
				}
			}
		}
	}
}
