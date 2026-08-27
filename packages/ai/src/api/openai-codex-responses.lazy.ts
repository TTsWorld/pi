/**
 * @file OpenAI Codex Responses API 的懒加载 shim。
 * @description 完整实现位于 openai-codex-responses.ts（走 Codex 专用的 Responses 端点与鉴权），
 * 首次调用流方法时才动态 import，借助 lazyApi 包装成 ProviderStreams，减小启动开销。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 OpenAI Codex Responses API（stream / streamSimple）。 */
export const openAICodexResponsesApi = (): ProviderStreams => lazyApi(() => import("./openai-codex-responses.ts"));
