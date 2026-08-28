/**
 * @file index.ts —— 交互模式 UI 组件的 barrel 导出
 *
 * @description
 * 汇总 modes/interactive/components/ 下的全部组件与工具函数，
 * 供宿主与扩展 API 统一从一处导入。
 * 覆盖：消息渲染组件、各类选择器/对话框、编辑器、加载器、
 * 键位提示与文本处理工具等。
 */

// 扩展可用的 UI 组件统一导出
// 彩蛋：Armin 人物组件
export { ArminComponent } from "./armin.ts";
export { AssistantMessageComponent } from "./assistant-message.ts";
export { BashExecutionComponent } from "./bash-execution.ts";
export { BorderedLoader } from "./bordered-loader.ts";
export { BranchSummaryMessageComponent } from "./branch-summary-message.ts";
export { CompactionSummaryMessageComponent } from "./compaction-summary-message.ts";
export { CustomEditor } from "./custom-editor.ts";
export { CustomMessageComponent } from "./custom-message.ts";
// 彩蛋：Daxnuts 人物组件
export { DaxnutsComponent } from "./daxnuts.ts";
// 终端 diff 渲染工具
export { type RenderDiffOptions, renderDiff } from "./diff.ts";
// 动画边框（选择器/加载器等共用）
export { DynamicBorder } from "./dynamic-border.ts";
// 扩展自定义的输入行编辑器
export { ExtensionEditorComponent } from "./extension-editor.ts";
export { ExtensionInputComponent } from "./extension-input.ts";
export { ExtensionSelectorComponent } from "./extension-selector.ts";
// 首次启动的引导/选择流程组件
export {
	FirstTimeSetupComponent,
	type FirstTimeSetupOptions,
	type FirstTimeSetupResult,
} from "./first-time-setup.ts";
// 底部状态栏组件
export { FooterComponent } from "./footer.ts";
// 键位提示文案工具（键位 + 说明的着色片段）
export { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";
export { LoginDialogComponent } from "./login-dialog.ts";
export { ModelSelectorComponent } from "./model-selector.ts";
export { OAuthSelectorComponent } from "./oauth-selector.ts";
export { type ModelsCallbacks, type ModelsConfig, ScopedModelsSelectorComponent } from "./scoped-models-selector.ts";
export { SessionSelectorComponent } from "./session-selector.ts";
export { type SettingsCallbacks, type SettingsConfig, SettingsSelectorComponent } from "./settings-selector.ts";
export { ShowImagesSelectorComponent } from "./show-images-selector.ts";
export { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";
export { ThemeSelectorComponent } from "./theme-selector.ts";
export { ThinkingSelectorComponent } from "./thinking-selector.ts";
export { ToolExecutionComponent, type ToolExecutionOptions } from "./tool-execution.ts";
export { TreeSelectorComponent } from "./tree-selector.ts";
export { TrustSelectorComponent } from "./trust-selector.ts";
// 用户消息渲染组件
export { UserMessageComponent } from "./user-message.ts";
// 用户消息编辑/重发选择器
export { UserMessageSelectorComponent } from "./user-message-selector.ts";
// 按可视行截断文本的工具（工具输出截断用）
export { truncateToVisualLines, type VisualTruncateResult } from "./visual-truncate.ts";
