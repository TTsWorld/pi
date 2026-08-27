/**
 * @file Azure OpenAI Responses API 的懒加载 shim。
 * @description 完整体积较大的实现（依赖 openai SDK 的 Azure 分支）位于 azure-openai-responses.ts，
 * 首次调用流方法时才动态 import，借助 lazyApi 包装成 ProviderStreams，减小启动开销。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 Azure OpenAI Responses API（stream / streamSimple）。 */
export const azureOpenAIResponsesApi = (): ProviderStreams => lazyApi(() => import("./azure-openai-responses.ts"));
