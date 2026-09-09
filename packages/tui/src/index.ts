/**
 * @file tui 包的导出入口文件
 * @description 统一对外导出 TUI（Terminal UI）包的核心接口与实现，包括自动补全、
 *              各类 UI 组件（loading 动画、Markdown、选择列表、文本、文本编辑器、空白）、
 *              终端抽象以及 TUI 核心框架类，供外部使用者从包根路径一次性引入。
 */

// 核心 TUI 接口与类

// 自动补全支持
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
// 加载动画组件
export { LoadingAnimation } from "./components/loading-animation.js";
// Markdown 渲染组件
export { MarkdownComponent } from "./components/markdown-component.js";
// 选择列表组件
export { type SelectItem, SelectList } from "./components/select-list.js";
// 文本组件
export { TextComponent } from "./components/text-component.js";
// 文本编辑器组件
export { TextEditor, type TextEditorConfig } from "./components/text-editor.js";
// 空白占位组件
export { WhitespaceComponent } from "./components/whitespace-component.js";
// 终端接口及其实现
export { ProcessTerminal, type Terminal } from "./terminal.js";
export {
	type Component,
	type ComponentRenderResult,
	Container,
	getNextComponentId,
	type Padding,
	TUI,
} from "./tui.js";
