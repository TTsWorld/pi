/**
 * @file 旧版 API 命名的兼容别名（legacy-api-aliases）。
 *
 * @description 早期版本的本包把各厂商的流式入口直接以 `streamAnthropic` /
 * `streamGoogle` 这类全局命名导出。如今规范用法是按 API 子路径导入
 * （如 `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream` / `streamSimple`），
 * 本文件保留旧命名作为 @deprecated 别名以维持向后兼容，避免使用方升级即断。
 *
 * 注意：这里刻意通过 *.lazy.ts 工厂获取流函数，保证引用本文件不会静态引入
 * 任何厂商 SDK 的实现代码（与根入口「零副作用」的约束保持一致）。
 */

import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
import type { AnthropicOptions } from "./api/anthropic-messages.ts";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
import type { AzureOpenAIResponsesOptions } from "./api/azure-openai-responses.ts";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
import type { GoogleOptions } from "./api/google-generative-ai.ts";
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
import type { GoogleVertexOptions } from "./api/google-vertex.ts";
import { mistralConversationsApi } from "./api/mistral-conversations.lazy.ts";
import type { MistralOptions } from "./api/mistral-conversations.ts";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
import type { OpenAICodexResponsesOptions } from "./api/openai-codex-responses.ts";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import type { OpenAICompletionsOptions } from "./api/openai-completions.ts";
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
import type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
import type { SimpleStreamOptions, StreamFunction } from "./types.ts";

// 模块加载时经懒加载工厂取得各 API 的流方法集合（stream / streamSimple），
// 供下方旧命名别名引用
const anthropicMessagesStreams = anthropicMessagesApi();
const azureOpenAIResponsesStreams = azureOpenAIResponsesApi();
const googleGenerativeAIStreams = googleGenerativeAIApi();
const googleVertexStreams = googleVertexApi();
const mistralConversationsStreams = mistralConversationsApi();
const openAICodexResponsesStreams = openAICodexResponsesApi();
const openAICompletionsStreams = openAICompletionsApi();
const openAIResponsesStreams = openAIResponsesApi();

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/anthropic-messages` 的 `stream`，或 `anthropicMessagesApi().stream`。 */
export const streamAnthropic = anthropicMessagesStreams.stream as StreamFunction<
	"anthropic-messages",
	AnthropicOptions
>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/anthropic-messages` 的 `streamSimple`，或 `anthropicMessagesApi().streamSimple`。 */
export const streamSimpleAnthropic = anthropicMessagesStreams.streamSimple as StreamFunction<
	"anthropic-messages",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/azure-openai-responses` 的 `stream`，或 `azureOpenAIResponsesApi().stream`。 */
export const streamAzureOpenAIResponses = azureOpenAIResponsesStreams.stream as StreamFunction<
	"azure-openai-responses",
	AzureOpenAIResponsesOptions
>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/azure-openai-responses` 的 `streamSimple`，或 `azureOpenAIResponsesApi().streamSimple`。 */
export const streamSimpleAzureOpenAIResponses = azureOpenAIResponsesStreams.streamSimple as StreamFunction<
	"azure-openai-responses",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/google-generative-ai` 的 `stream`，或 `googleGenerativeAIApi().stream`。 */
export const streamGoogle = googleGenerativeAIStreams.stream as StreamFunction<"google-generative-ai", GoogleOptions>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/google-generative-ai` 的 `streamSimple`，或 `googleGenerativeAIApi().streamSimple`。 */
export const streamSimpleGoogle = googleGenerativeAIStreams.streamSimple as StreamFunction<
	"google-generative-ai",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/google-vertex` 的 `stream`，或 `googleVertexApi().stream`。 */
export const streamGoogleVertex = googleVertexStreams.stream as StreamFunction<"google-vertex", GoogleVertexOptions>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/google-vertex` 的 `streamSimple`，或 `googleVertexApi().streamSimple`。 */
export const streamSimpleGoogleVertex = googleVertexStreams.streamSimple as StreamFunction<
	"google-vertex",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/mistral-conversations` 的 `stream`，或 `mistralConversationsApi().stream`。 */
export const streamMistral = mistralConversationsStreams.stream as StreamFunction<
	"mistral-conversations",
	MistralOptions
>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/mistral-conversations` 的 `streamSimple`，或 `mistralConversationsApi().streamSimple`。 */
export const streamSimpleMistral = mistralConversationsStreams.streamSimple as StreamFunction<
	"mistral-conversations",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/openai-codex-responses` 的 `stream`，或 `openAICodexResponsesApi().stream`。 */
export const streamOpenAICodexResponses = openAICodexResponsesStreams.stream as StreamFunction<
	"openai-codex-responses",
	OpenAICodexResponsesOptions
>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/openai-codex-responses` 的 `streamSimple`，或 `openAICodexResponsesApi().streamSimple`。 */
export const streamSimpleOpenAICodexResponses = openAICodexResponsesStreams.streamSimple as StreamFunction<
	"openai-codex-responses",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/openai-completions` 的 `stream`，或 `openAICompletionsApi().stream`。 */
export const streamOpenAICompletions = openAICompletionsStreams.stream as StreamFunction<
	"openai-completions",
	OpenAICompletionsOptions
>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/openai-completions` 的 `streamSimple`，或 `openAICompletionsApi().streamSimple`。 */
export const streamSimpleOpenAICompletions = openAICompletionsStreams.streamSimple as StreamFunction<
	"openai-completions",
	SimpleStreamOptions
>;

/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/openai-responses` 的 `stream`，或 `openAIResponsesApi().stream`。 */
export const streamOpenAIResponses = openAIResponsesStreams.stream as StreamFunction<
	"openai-responses",
	OpenAIResponsesOptions
>;
/** @deprecated 已弃用：请改用 `@earendil-works/pi-ai/api/openai-responses` 的 `streamSimple`，或 `openAIResponsesApi().streamSimple`。 */
export const streamSimpleOpenAIResponses = openAIResponsesStreams.streamSimple as StreamFunction<
	"openai-responses",
	SimpleStreamOptions
>;
