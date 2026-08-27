/**
 * @file 容错 JSON 解析
 * @description 面向「模型输出的 JSON 不可靠」的现实：流式传输中的不完整 JSON、字符串内
 *              的裸控制字符、非法转义序列等。提供三层解析：先原生 JSON.parse，失败后
 *              修复再解析（repairJson），流式场景再降级到 partial-json 的部分解析。
 *
 * 主要功能：
 * - repairJson：修复 JSON 字符串字面量（转义裸控制字符、非法转义加双反斜杠）
 * - parseJsonWithRepair：原生解析 → 修复后重试
 * - parseStreamingJson：流式增量解析，永不抛错（失败返回空对象）
 *
 * 依赖关系：
 * - partial-json（流式不完整 JSON 的部分解析）
 */

import { parse as partialParse } from "partial-json";

/** JSON 合法转义字符白名单（\u 后必须跟 4 位十六进制） */
const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** 判断是否为 JSON 不允许裸出现在字符串里的控制字符（U+0000~U+001F） */
function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

/** 把单个控制字符转义为合法 JSON 序列（常用短转义优先，其余用 \uXXXX） */
function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * 修复畸形的 JSON 字符串字面量：
 * - 把字符串内部的裸控制字符转义
 * - 把非法转义字符前的反斜杠翻倍（使其成为字面反斜杠）
 * 状态机只跟踪「是否在字符串内」，字符串外的内容原样保留。
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		// 字符串外：原样保留；遇到开引号进入字符串态
		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		// 闭引号：退出字符串态
		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		// 反斜杠：按后续字符分派
		if (char === "\\") {
			const nextChar = json[index + 1];
			// 末尾孤立反斜杠：翻倍成为字面反斜杠
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			// \uXXXX：4 位十六进制齐全则视为合法 unicode 转义，整体保留
			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			// 白名单转义（如 \" \n）：保留并跳过被转义字符
			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			// 非法转义（如 \x）：翻倍反斜杠使其退化为字面反斜杠
			repaired += "\\\\";
			continue;
		}

		// 普通字符：控制字符转义，其余原样
		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

/** 带修复的解析：原生 JSON.parse 失败时用修复版重试；修复无改动则抛出原始错误 */
export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * 尝试解析流式传输中可能不完整的 JSON。总是返回合法对象，
 * 即使 JSON 不完整或彻底无法解析。
 *
 * 降级顺序：原生解析 → partial-json 直接部分解析 → 先修复再部分解析 → 空对象
 *
 * @param partialJson 流式产生的部分 JSON 字符串
 * @returns 解析结果；解析失败时返回空对象
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
