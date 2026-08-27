/**
 * @file @earendil-works/pi-ai（packages/ai）的根入口。
 *
 * @description 多厂商 AI SDK 的门面模块：这里刻意保持「只含核心、零副作用」，
 * 仅重新导出纯类型与无副作用的核心模块，保证从根路径导入的使用方不会被迫
 * 加载任何厂商 SDK 的实现代码。完整能力请改用子路径导出：
 * - provider 工厂：`@earendil-works/pi-ai/providers/*`
 * - 各 API 实现：`@earendil-works/pi-ai/api/*`
 * - 旧版全局 API：`@earendil-works/pi-ai/compat`
 */

// 重新导出 typebox（schema 定义/校验的底层库），使用方无需再直接依赖它
export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// 下方导出列表刻意「只含核心、零副作用」：不含生成的模型目录（*.models.ts）、
// 不含 provider 工厂、不含 api-registry、不含 OAuth 实现、不含 compat。
// provider 工厂位于 "@earendil-works/pi-ai/providers/*"，
// API 实现位于 "@earendil-works/pi-ai/api/*"，
// 旧版全局 API 位于 "@earendil-works/pi-ai/compat"。
// —— 各厂商 API 的专属类型（纯 type 导出，不引入任何实现代码）——
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.ts";
export type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
export type { BedrockOptions, BedrockThinkingDisplay } from "./api/bedrock-converse-stream.ts";
export type { GoogleOptions } from "./api/google-generative-ai.ts";
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./api/google-shared.ts";
export type { GoogleVertexOptions } from "./api/google-vertex.ts";
// 懒加载 API 基建（lazyApi / lazyStream）：把「动态 import 实现模块」包装成统一形状
export * from "./api/lazy.ts";
export type { MistralOptions } from "./api/mistral-conversations.ts";
export type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "./api/openai-codex-responses.ts";
export type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
export type { PiMessagesEvent, PiMessagesOptions, PiMessagesRewriteImpact } from "./api/pi-messages.ts";
// —— 认证基建：auth 上下文、凭据存储、鉴权辅助与类型 ——
export * from "./auth/context.ts";
export * from "./auth/credential-store.ts";
export * from "./auth/helpers.ts";
export * from "./auth/types.ts";
// —— 从 compat 层透出的 OAuth 扩展类型（仅类型导出，不引入 compat 实现）——
export type {
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
// 图像生成 Provider（Provider 体系的图像侧对应物）
export * from "./images-models.ts";
// Provider 核心体系：createProvider、模型目录、鉴权解析等
export * from "./models.ts";
// 动态模型目录的持久化接口（read/write/delete + ETag 新鲜度）
export * from "./models-store.ts";
// faux provider：内置的假 provider，用于测试
export * from "./providers/faux.ts";
// 会话级资源清理：注册/执行 cleanup 回调
export * from "./session-resources.ts";
// 全包共享的核心类型：Api / Model / 消息 / 流 / Context 等
export * from "./types.ts";
// —— 通用工具集 ——
// 错误诊断信息（名称/消息/堆栈的结构化表示）
export * from "./utils/diagnostics.ts";
// EventStream：异步迭代的事件流基类（assistant 消息事件流的底层）
export * from "./utils/event-stream.ts";
// 容错 JSON 解析（基于 partial-json，可解析不完整的流式 JSON）
export * from "./utils/json-parse.ts";
// 上下文溢出（context overflow）错误的识别与处理
export * from "./utils/overflow.ts";
// 按厂商错误模式进行重试的机制
export * from "./utils/retry.ts";
// 从消息内容块中提取纯文本
export { contentText } from "./utils/text.ts";
// typebox schema 辅助构造器（如兼容各厂商的字符串枚举 schema）
export * from "./utils/typebox-helpers.ts";
// UUIDv7 生成器（时间有序，适合做消息/会话 ID）
export { uuidv7 } from "./utils/uuid.ts";
// 工具调用参数的 schema 校验（基于 typebox Compile/Value）
export * from "./utils/validation.ts";
