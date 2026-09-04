/**
 * @file index.ts
 * @description pi-tui 包入口 —— 统一导出终端 UI 组件库的全部公共 API
 * @module pi-tui
 *
 * 主要功能：
 * - 核心框架：Component 组件契约、Container 容器与 TUI 根容器（终端接管、渲染循环、按键分发）
 * - 内置组件：Markdown 渲染、纯文本、多行文本编辑器、选择列表、空白占位
 * - 辅助能力：斜杠命令与文件路径自动补全、文件型调试日志
 *
 * 依赖关系：
 * - 本文件为纯 barrel 重导出（不含实现逻辑），各实现位于同目录下的同名模块
 * - chalk（终端着色）、marked（Markdown 解析）等第三方依赖由各实现模块自行引入
 */

// 核心 TUI 接口与类

/**
 * 自动补全支持
 *
 * - `AutocompleteItem`：单个补全建议项（value + label + 可选 description）
 * - `AutocompleteProvider`：补全提供者接口 —— 按当前文本与光标位置给出建议，并负责应用补全
 * - `CombinedAutocompleteProvider`：内置组合实现，同时支持斜杠命令与文件路径补全
 * - `SlashCommand`：斜杠命令定义，可携带参数补全回调
 */
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.js";
/**
 * 调试日志
 *
 * - `LoggerConfig`：日志配置（enabled 开关、logFile 输出文件、logLevel 级别）
 * - `logger`：全局 Logger 单例，将调试信息与组件状态变更写入日志文件
 */
export { type LoggerConfig, logger } from "./logger.js";
/**
 * Markdown 组件 —— 基于 marked 解析 Markdown 文本，并用 chalk 着色渲染为终端输出
 */
export { MarkdownComponent } from "./markdown-component.js";
/**
 * 选择列表组件
 *
 * - `SelectItem`：单个可选项（value + label + 可选 description）
 * - `SelectList`：可交互的选择列表组件
 */
export { type SelectItem, SelectList } from "./select-list.js";
/**
 * 文本组件 —— 渲染纯文本内容
 */
export { TextComponent } from "./text-component.js";
/**
 * 文本编辑器组件
 *
 * - `TextEditor`：多行文本编辑器，支持光标移动、文本编辑与输入处理
 * - `TextEditorConfig`：编辑器配置（当前暂无可配置项，仅作预留扩展）
 */
export { TextEditor, type TextEditorConfig } from "./text-editor.js";
/**
 * TUI 核心框架
 *
 * - `Component`：组件契约接口（render 渲染 + 可选 handleInput 处理按键）
 * - `ComponentRenderResult`：组件渲染结果（lines 文本行 + changed 变更标记）
 * - `ContainerRenderResult`：容器渲染结果，额外携带 keepLines 支持增量渲染
 * - `Container`：容器基类，管理子组件树（增删、哨兵清理、递归渲染）
 * - `Padding`：内边距配置（上/下/左/右，单位为行/列）
 * - `TUI`：根容器类，接管终端（raw 模式、隐藏光标）、批处理渲染循环与按键事件分发
 */
export {
	type Component,
	type ComponentRenderResult,
	Container,
	type ContainerRenderResult,
	type Padding,
	TUI,
} from "./tui.js";
/**
 * 空白组件 —— 渲染指定数量的空行，用于组件之间的间距
 */
export { WhitespaceComponent } from "./whitespace-component.js";
