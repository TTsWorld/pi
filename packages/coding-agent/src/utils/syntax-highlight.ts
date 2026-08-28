/**
 * @file syntax-highlight.ts —— 基于 highlight.js 的代码语法高亮
 *
 * @description
 * 为终端 UI 中的代码块渲染提供语法高亮能力：
 * - 启动时只注册 20 种常用语言，其余语言空闲时（setImmediate）
 *   异步动态加载全量语言包，避免拖慢 CLI 启动速度；
 * - 不直接输出 hljs 生成的 HTML，而是解析其中 `<span class="hljs-xxx">`
 *   的嵌套结构提取 token 作用域，再交由主题格式化函数生成终端文本；
 * - 作用域匹配逐级降级：精确名 → "." 前缀 → "-" 前缀 → default。
 *
 * 依赖关系：
 * - `highlight.js`（core + 按语言加载）；
 * - `./html.ts`：解码 HTML 实体（hljs 输出中的 &amp; 等）。
 */

import hljs from "highlight.js/lib/core.js";
import bash from "highlight.js/lib/languages/bash.js";
import c from "highlight.js/lib/languages/c.js";
import cpp from "highlight.js/lib/languages/cpp.js";
import csharp from "highlight.js/lib/languages/csharp.js";
import dart from "highlight.js/lib/languages/dart.js";
import go from "highlight.js/lib/languages/go.js";
import groovy from "highlight.js/lib/languages/groovy.js";
import java from "highlight.js/lib/languages/java.js";
import javascript from "highlight.js/lib/languages/javascript.js";
import kotlin from "highlight.js/lib/languages/kotlin.js";
import lua from "highlight.js/lib/languages/lua.js";
import nix from "highlight.js/lib/languages/nix.js";
import perl from "highlight.js/lib/languages/perl.js";
import php from "highlight.js/lib/languages/php.js";
import python from "highlight.js/lib/languages/python.js";
import ruby from "highlight.js/lib/languages/ruby.js";
import rust from "highlight.js/lib/languages/rust.js";
import scala from "highlight.js/lib/languages/scala.js";
import swift from "highlight.js/lib/languages/swift.js";
import typescript from "highlight.js/lib/languages/typescript.js";
import { decodeHtmlEntityAt } from "./html.ts";

/** 启动即注册的常用语言集合（键名即注册到 hljs 的语言名） */
const eagerLanguages = {
	python,
	java,
	go,
	javascript,
	cpp,
	typescript,
	php,
	ruby,
	c,
	csharp,
	nix,
	bash,
	rust,
	scala,
	kotlin,
	swift,
	dart,
	groovy,
	perl,
	lua,
};

for (const [name, language] of Object.entries(eagerLanguages)) {
	hljs.registerLanguage(name, language);
}

/** 全量语言加载的 Promise 缓存，保证动态 import 只执行一次 */
let allLanguagesPromise: Promise<void> | undefined;

/**
 * 异步加载 highlight.js 的全量语言包（首次调用时触发，之后复用缓存）。
 * 用 setImmediate 推迟到事件循环空闲处执行，避免全量 import
 * 阻塞启动路径。加载失败也按成功收尾——已注册的常用语言与
 * 纯文本兜底仍然可用。
 */
export function loadAllHighlightLanguages(): Promise<void> {
	if (!allLanguagesPromise) {
		allLanguagesPromise = new Promise((resolve) => {
			setImmediate(() => {
				void import("highlight.js/lib/index.js").then(
					() => resolve(),
					() => {
						// 急加载的常用语言与纯文本兜底仍然可用。
						resolve();
					},
				);
			});
		});
	}
	return allLanguagesPromise;
}

/** 文本格式化函数：接收一段纯文本，返回加上终端样式后的文本 */
export type HighlightFormatter = (text: string) => string;
/** 主题：作用域名（如 "keyword"、"string"）到格式化函数的映射 */
export type HighlightTheme = Partial<Record<string, HighlightFormatter>>;

/** 高亮选项 */
export interface HighlightOptions {
	/** 指定语言名；不指定则由 hljs 自动检测 */
	language?: string;
	/** 忽略非法语法，避免高亮报错中断渲染 */
	ignoreIllegals?: boolean;
	/** 自动检测模式下参与候选的语言子集 */
	languageSubset?: string[];
	/** 输出主题；缺省时不做任何着色 */
	theme?: HighlightTheme;
}

/** span 闭合标签（与开标签配对构成 hljs 输出的嵌套结构） */
const SPAN_CLOSE = "</span>";
/** hljs 作用域类名的固定前缀 */
const HIGHLIGHT_CLASS_PREFIX = "hljs-";

/**
 * 从 `<span class="hljs-xxx ...">` 标签中提取作用域名。
 * class 中可能含多个类名，只取第一个带 hljs- 前缀的；
 * 没有则返回 undefined（该 span 不产生着色作用域）。
 */
function getScopeFromSpanTag(tag: string): string | undefined {
	const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag);
	const classValue = match?.[1] ?? match?.[2];
	if (!classValue) {
		return undefined;
	}

	for (const className of classValue.split(/\s+/)) {
		if (className.startsWith(HIGHLIGHT_CLASS_PREFIX)) {
			return className.slice(HIGHLIGHT_CLASS_PREFIX.length);
		}
	}

	return undefined;
}

/**
 * 为单个作用域查找主题中的格式化函数，按三级降序匹配：
 * 1. 精确名（如 "title.function"）；
 * 2. 第一个 "." 之前的前缀（如 "title"）；
 * 3. 第一个 "-" 之前的前缀。
 * 主题未覆盖该作用域时返回 undefined。
 */
function getScopeFormatter(scope: string, theme: HighlightTheme): HighlightFormatter | undefined {
	const exact = theme[scope];
	if (exact) {
		return exact;
	}

	// 复合作用域（如 title.function）回退到主类 title
	const dotIndex = scope.indexOf(".");
	if (dotIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dotIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	// 连字符形式的作用域同样回退到前缀
	const dashIndex = scope.indexOf("-");
	if (dashIndex !== -1) {
		const prefixFormatter = theme[scope.slice(0, dashIndex)];
		if (prefixFormatter) {
			return prefixFormatter;
		}
	}

	return undefined;
}

/**
 * 从当前打开的作用域栈中确定生效的格式化函数。
 * 自栈顶（最内层 span）向下查找第一个主题命中的作用域，
 * 让内层样式优先于外层；全部未命中时用主题的 default。
 */
function getActiveFormatter(scopes: Array<string | undefined>, theme: HighlightTheme): HighlightFormatter | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const scope = scopes[i];
		if (!scope) {
			continue;
		}
		const formatter = getScopeFormatter(scope, theme);
		if (formatter) {
			return formatter;
		}
	}
	return theme.default;
}

/**
 * 判断 index 处是否为 span 开标签的起始。
 * 除 "<span" 前缀外还要求其后紧跟 ">" 或空白字符，
 * 排除 "<spanx" 之类的误匹配。
 */
function isSpanOpenTagStart(html: string, index: number): boolean {
	if (!html.startsWith("<span", index)) {
		return false;
	}
	const nextChar = html[index + "<span".length];
	return nextChar === ">" || nextChar === " " || nextChar === "\t" || nextChar === "\n" || nextChar === "\r";
}

/**
 * 把 highlight.js 产出的 HTML 转换为应用主题后的最终文本。
 *
 * 工作原理：逐字符扫描 HTML，用作用域栈跟踪当前嵌套的 span
 * 层级；普通字符先积累到 textBuffer，遇到标签边界时 flush——
 * 按当前生效作用域的格式化函数处理后拼入输出。
 * 其间同步解码 HTML 实体（hljs 会转义 &、<、> 等字符）。
 *
 * @param html - hljs.highlight 输出的 HTML 字符串
 * @param theme - 作用域到格式化函数的映射；空主题等价于剥掉全部标签
 * @returns 应用了主题样式的纯文本
 */
export function renderHighlightedHtml(html: string, theme: HighlightTheme = {}): string {
	let output = "";
	// 待着色文本的累积缓冲，遇到标签边界时统一 flush
	let textBuffer = "";
	// 当前打开的 span 作用域栈（undefined 表示该层无 hljs 类名）
	const scopes: Array<string | undefined> = [];

	/** 把缓冲中的文本按当前作用域着色后写入输出 */
	const flushText = () => {
		if (!textBuffer) {
			return;
		}
		const formatter = getActiveFormatter(scopes, theme);
		output += formatter ? formatter(textBuffer) : textBuffer;
		textBuffer = "";
	};

	let index = 0;
	while (index < html.length) {
		// ===== 情况一：span 开标签 → 解析作用域并入栈 =====
		if (isSpanOpenTagStart(html, index)) {
			const tagEndIndex = html.indexOf(">", index + 5);
			if (tagEndIndex !== -1) {
				flushText();
				const tag = html.slice(index, tagEndIndex + 1);
				const scope = getScopeFromSpanTag(tag);
				scopes.push(scope);
				index = tagEndIndex + 1;
				continue;
			}
		}

		// ===== 情况二：span 闭标签 → 弹出一层作用域 =====
		// 栈已空时忽略多余的闭标签，保证 malformed HTML 不会崩掉
		if (html.startsWith(SPAN_CLOSE, index)) {
			flushText();
			if (scopes.length > 0) {
				scopes.pop();
			}
			index += SPAN_CLOSE.length;
			continue;
		}

		// ===== 情况三：HTML 实体（&amp; 等）→ 解码后计入文本 =====
		if (html[index] === "&") {
			const decoded = decodeHtmlEntityAt(html, index);
			if (decoded) {
				textBuffer += decoded.text;
				index += decoded.length;
				continue;
			}
		}

		// ===== 其余：普通字符直接积累 =====
		textBuffer += html[index];
		index++;
	}

	flushText();
	return output;
}

/**
 * 对代码做语法高亮（对外主入口）。
 * 指定了 language 时按该语言高亮（ignoreIllegals 可容忍非法语法），
 * 否则由 hljs 自动检测语言（可限定候选子集）；
 * 再把产出的 HTML 按主题渲染为最终文本。
 */
export function highlight(code: string, options: HighlightOptions = {}): string {
	const html = options.language
		? hljs.highlight(code, {
				language: options.language,
				ignoreIllegals: options.ignoreIllegals,
			}).value
		: hljs.highlightAuto(code, options.languageSubset).value;
	return renderHighlightedHtml(html, options.theme);
}

/** 判断指定名称的语言是否已注册可用 */
export function supportsLanguage(name: string): boolean {
	return hljs.getLanguage(name) !== undefined;
}
