/**
 * @file highlight-js.d.ts —— highlight.js 的最小化类型声明
 *
 * @description
 * 只声明本仓库实际用到的 highlight.js API 子集
 * （highlight / highlightAuto / getLanguage / registerLanguage 及语言模块），
 * 避免引入完整官方类型包；三个 declare module 分别对应 core 入口、
 * 全量入口与按语言拆分的模块文件。
 */

/** 高亮结果：只关心渲染后的 HTML 字符串。 */
interface HighlightJsResult {
	value: string;
}

/** highlight 调用选项：指定语言，可选地容忍非法语法。 */
interface HighlightJsOptions {
	language: string;
	ignoreIllegals?: boolean;
}

/** 语言定义：此处只需语言名。 */
interface HighlightJsLanguageDefinition {
	readonly name?: string;
}

/** 语言模块的工厂函数：接收 hljs 实例，返回该语法的定义。 */
type HighlightJsLanguageFactory = (hljs: HighlightJsApi) => HighlightJsLanguageDefinition;

/** highlight.js 核心 API 的最小子集。 */
interface HighlightJsApi {
	highlight(code: string, options: HighlightJsOptions): HighlightJsResult;
	highlightAuto(code: string, languageSubset?: string[]): HighlightJsResult;
	getLanguage(name: string): HighlightJsLanguageDefinition | undefined;
	registerLanguage(name: string, language: HighlightJsLanguageFactory): void;
}

/** core 入口：默认导出 hljs 实例（不含内置语言，需手动 registerLanguage）。 */
declare module "highlight.js/lib/core.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

/** 全量入口：默认导出带全部内置语言的 hljs 实例。 */
declare module "highlight.js/lib/index.js" {
	const hljs: HighlightJsApi;
	export default hljs;
}

/** 单个语言模块（lib/languages/ 下）：默认导出该语言的定义工厂。 */
declare module "highlight.js/lib/languages/*.js" {
	const language: HighlightJsLanguageFactory;
	export default language;
}
