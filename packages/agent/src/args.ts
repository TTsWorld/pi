/**
 * @file args.ts
 * @description 手写类型化命令行参数解析器 —— 支持 flag/boolean/int/float/string/file 六种参数类型、
 *              单字符别名、choices 可选值校验，以及 file 参数的 `~` 路径展开
 * @module pi-agent
 *
 * 主要功能：
 * - 定义声明式参数规格：ArgDef（单个参数）/ ArgDefs（参数集合）
 * - parseArgs：把原始 string[] 解析为带类型的 ParsedArgs（别名匹配、类型转换、choices 校验）
 * - printHelp：按参数规格打印格式化的帮助信息（含选项说明与默认值展示）
 */

import { homedir } from "os";
import { resolve } from "path";

/**
 * 选项（choice）定义：除选项值本身外，还可附带一段描述文字，
 * 供 printHelp 在参数行下方逐行展示各候选值的含义
 */
export type Choice<T = string> = {
	/** 选项值 */
	value: T;
	/** 选项说明（可选），仅用于帮助信息展示 */
	description?: string;
};

/**
 * 单个命令行参数的定义（规格声明）
 *
 * 各 type 的解析行为：
 * - flag：开关型，出现即视为 true，不接受附加值
 * - boolean / int / float / string / file：需跟随一个值 token，按类型分别转换
 */
export type ArgDef = {
	/** 参数类型，同时决定解析行为与 ParsedArgs 中的结果类型 */
	type: "flag" | "boolean" | "int" | "float" | "string" | "file";
	/** 单字符短别名，如 alias: "h" 允许以 -h 引用该参数 */
	alias?: string;
	/** 默认值；未显式给出默认值时，flag / boolean 类型自动置为 false */
	default?: any;
	/** 参数说明，用于 printHelp 输出 */
	description?: string;
	/** 可选值白名单 */
	choices?: Choice[] | string[]; // 可以是简单字符串，也可以是带描述的对象
	/** 帮助信息中默认值的展示策略 */
	showDefault?: boolean | string; // false 隐藏，true 显示实际值，字符串显示自定义文本
};

/** 参数定义集合：参数名（不含 -- 前缀）→ ArgDef 的映射 */
export type ArgDefs = Record<string, ArgDef>;

/**
 * 解析结果类型：通过映射类型把每个 ArgDef 的 type 静态翻译为对应的结果类型
 * （flag/boolean → boolean，int/float → number，string/file → string），
 * 并附加 `_` 位置参数数组
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
	_: string[]; // 位置参数（含未能匹配到定义的 -- 参数）
};

/**
 * 解析命令行参数
 *
 * 解析规则：
 * - `--name [value]`：长参数；name 先经别名映射还原为正式键名再查找定义
 * - `-x`（长度恰为 2）：短参数，仅支持 flag 类型，出现即 true
 * - 其余：位置参数，原样收集到 `_` 数组（未知 --flag / 短参数也会降级进入 `_`，而非报错）
 * - 值非法、缺值或 choices 校验失败时直接 throw Error，由调用方决定如何呈现
 *
 * @param defs 参数定义集合（键为不含 -- 前缀的参数名）
 * @param args 原始参数数组（通常来自 process.argv）
 * @returns 类型化的解析结果；`_` 字段为位置参数
 */
export function parseArgs<T extends ArgDefs>(defs: T, args: string[]): ParsedArgs<T> {
	const result: any = { _: [] }; // 解析结果容器：内部以 any 动态写入，返回时再断言回类型化结构
	const aliasMap: Record<string, string> = {}; // 别名 → 正式键名 的反查表

	// ========== 第一遍：构建别名映射 & 预写默认值 ==========
	for (const [key, def] of Object.entries(defs)) {
		if (def.alias) {
			// 登记别名 → 正式键名，供后续 -x / --alias 反查
			aliasMap[def.alias] = key;
		}
		if (def.default !== undefined) {
			// 有默认值则先写入，解析命中后才覆盖
			result[key] = def.default;
		} else if (def.type === "flag" || def.type === "boolean") {
			// 布尔类参数即使未声明默认值也初始化为 false，保证结果字段完整
			result[key] = false;
		}
	}

	// ========== 第二遍：主解析循环 ==========
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		// ---------- 长参数（--name） ----------
		if (arg.startsWith("--")) {
			const flagName = arg.slice(2);
			// 先查别名表还原正式键名，查不到则把 flagName 本身当键名
			const key = aliasMap[flagName] || flagName;
			const def = defs[key];

			if (!def) {
				// 未知 flag：不报错，降级为位置参数（便于透传给子命令等场景）
				result._.push(arg);
				continue;
			}

			if (def.type === "flag") {
				// 纯开关型 flag：出现即 true，无需取值
				result[key] = true;
			} else if (i + 1 < args.length) {
				// 带值的参数：取下一个 token 作为值（++i 一并推进游标）
				const value = args[++i];

				let parsedValue: any;

				// 按声明的类型逐个分支解析
				switch (def.type) {
					case "boolean":
						// 宽松真值判定：true/1/yes 视为 true，其余一律为 false
						parsedValue = value === "true" || value === "1" || value === "yes";
						break;
					case "int":
						// 按十进制解析整数；NaN 说明不是合法整数，立即报错
						parsedValue = parseInt(value, 10);
						if (Number.isNaN(parsedValue)) {
							throw new Error(`Invalid integer value for --${key}: ${value}`);
						}
						break;
					case "float":
						// 解析浮点数；NaN 同样立即报错
						parsedValue = parseFloat(value);
						if (Number.isNaN(parsedValue)) {
							throw new Error(`Invalid float value for --${key}: ${value}`);
						}
						break;
					case "string":
						// 字符串类型：原样使用
						parsedValue = value;
						break;
					case "file": {
						// 把 ~ 展开为用户主目录，并规范为绝对路径。
						// Why：编程方式传入的参数不会经过 shell 的 ~ 展开，
						// 这里统一兜底，保证拿到的是可直接使用的绝对路径
						let path = value;
						if (path.startsWith("~")) {
							path = path.replace("~", homedir());
						}
						parsedValue = resolve(path);
						break;
					}
				}

				// ---------- choices 校验 ----------
				// 声明了可选值时，解析结果必须命中白名单之一，否则报错并列出全部合法值
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
				// 该参数位于末尾、后面没有值 token：缺少值，报错
				throw new Error(`Flag --${key} requires a value`);
			}
		} else if (arg.startsWith("-") && arg.length === 2) {
			// ---------- 短参数（如 -h；限定长度为 2，避免误吞负数等其他 - 开头的 token） ----------
			const flagChar = arg[1];
			// 短参数同样先经别名表反查正式键名
			const key = aliasMap[flagChar] || flagChar;
			const def = defs[key];

			if (!def) {
				// 未知短参数同样降级为位置参数
				result._.push(arg);
				continue;
			}

			if (def.type === "flag") {
				result[key] = true;
			} else {
				// 短参数只支持开关型 flag：带值类型的值无法附加在单字符上
				throw new Error(`Short flag -${flagChar} cannot have a value`);
			}
		} else {
			// ---------- 位置参数：原样收集到 _ 数组 ----------
			result._.push(arg);
		}
	}

	return result as ParsedArgs<T>;
}

/**
 * 根据参数定义打印命令行帮助信息
 *
 * 输出结构：首行 usage，随后 "Options:" 与每个参数一行，
 * 形如 `  --name, -a <type>  描述 (default: xxx)`；
 * 若 choices 使用了带 description 的对象形式，则在参数行下方逐行列出各候选值及说明。
 *
 * @param defs 参数定义集合（遍历顺序即输出顺序）
 * @param usage 用法说明行，原样作为首行输出
 */
export function printHelp<T extends ArgDefs>(defs: T, usage: string): void {
	console.log(usage);
	console.log("\nOptions:");

	for (const [key, def] of Object.entries(defs)) {
		let line = `  --${key}`;
		if (def.alias) {
			line += `, -${def.alias}`;
		}

		if (def.type !== "flag") {
			if (def.choices) {
				// 声明了可选值时，用候选值列表替代类型占位符
				const simpleChoices = def.choices.filter((c) => typeof c === "string");
				if (simpleChoices.length === def.choices.length) {
					// 全部是简单字符串：直接拼成 <a|b|c>
					line += ` <${simpleChoices.join("|")}>`;
				} else {
					// 混有带描述的对象：此处只显示类型，候选值明细见下方逐行输出
					const typeStr = def.type === "file" ? "path" : def.type;
					line += ` <${typeStr}>`;
				}
			} else {
				// 无可选值：显示类型占位符（file 类型展示为更友好的 path）
				const typeStr = def.type === "file" ? "path" : def.type;
				line += ` <${typeStr}>`;
			}
		}

		if (def.description) {
			// 统一补齐到 30 列，让所有参数描述纵向对齐
			line = line.padEnd(30) + def.description;
		}

		// 追加默认值展示：flag 不显示；showDefault 为 false 可隐藏，为字符串时显示自定义文本
		if (def.default !== undefined && def.type !== "flag" && def.showDefault !== false) {
			if (typeof def.showDefault === "string") {
				line += ` (default: ${def.showDefault})`;
			} else {
				line += ` (default: ${def.default})`;
			}
		}

		console.log(line);

		// 若存在带描述的选项，则在参数行下方逐行打印 值 + 说明
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
