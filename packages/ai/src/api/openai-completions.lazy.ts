/**
 * @file OpenAI Chat Completions API 的懒加载 shim。
 * @description 完整实现位于 openai-completions.ts（依赖 openai SDK），首次调用流方法时才动态 import，
 * 借助 lazyApi 包装成 ProviderStreams，减小启动开销。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 OpenAI Chat Completions API（stream / streamSimple）。 */
export const openAICompletionsApi = (): ProviderStreams => lazyApi(() => import("./openai-completions.ts"));
