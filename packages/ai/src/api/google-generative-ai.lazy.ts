/**
 * @file Google Generative AI（Gemini，AI Studio API Key 直连）的懒加载 shim。
 * @description 完整实现位于 google-generative-ai.ts（依赖 @google/genai SDK），首次调用流方法时
 * 才动态 import，借助 lazyApi 包装成 ProviderStreams，减小启动开销。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 Google Generative AI API（stream / streamSimple）。 */
export const googleGenerativeAIApi = (): ProviderStreams => lazyApi(() => import("./google-generative-ai.ts"));
