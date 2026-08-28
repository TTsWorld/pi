/*
 * Portions of this file are derived from:
 * - ansi-regex (https://github.com/chalk/ansi-regex)
 * - strip-ansi (https://github.com/chalk/strip-ansi)
 *
 * MIT License
 *
 * Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/**
 * @file ansi.ts —— ANSI 转义序列识别与剥离
 *
 * @description
 * 移植自 ansi-regex / strip-ansi（MIT，版权声明见上），
 * 提供 `stripAnsi` 从终端输出中去除颜色等 ANSI 转义序列，得到纯文本。
 */

/**
 * 构造匹配 ANSI 转义序列的正则。
 *
 * @param options.onlyFirst - 为 true 时正则不带 g 标志（只匹配第一个）
 * @returns 匹配 OSC 或 CSI 转义序列的正则
 */
function ansiRegex({ onlyFirst = false }: { onlyFirst?: boolean } = {}): RegExp {
	// 有效的字符串终结符（ST）序列：BEL、ESC\ 以及 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";

	// 仅 OSC 序列：ESC ] ... ST（非贪婪，匹配到第一个 ST 为止）
	const osc = `(?:\\u001B\\][\\s\\S]*?${ST})`;

	// CSI 及相关序列：ESC/C1 引导 + 可选中间字节 + 可选参数（支持 ; 和 :）+ 终止字节
	const csi = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

	const pattern = `${osc}|${csi}`;

	return new RegExp(pattern, onlyFirst ? undefined : "g");
}

const regex = ansiRegex();

/**
 * 去除字符串中的所有 ANSI 转义序列。
 *
 * @param value - 待清理的字符串
 * @returns 不含 ANSI 转义序列的纯文本
 * @throws 入参不是字符串时抛出 TypeError
 */
export function stripAnsi(value: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`Expected a \`string\`, got \`${typeof value}\``);
	}

	// 快速路径：ANSI 码必然包含 ESC（7 位）或 CSI（8 位）引导符，都不含则直接返回
	if (!value.includes("\u001B") && !value.includes("\u009B")) {
		return value;
	}

	// 虽然正则是全局的，但无需手动重置 `.lastIndex`：
	// 与 `.exec()` 和 `.test()` 不同，`.replace()` 会自动重置，手动做反而有性能损耗。
	return value.replace(regex, "");
}
