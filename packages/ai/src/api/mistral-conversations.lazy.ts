/**
 * @file Mistral Conversations API 的懒加载 shim。
 * @description 完整实现位于 mistral-conversations.ts，首次调用流方法时才动态 import，
 * 借助 lazyApi 包装成 ProviderStreams，减小启动开销。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 Mistral Conversations API（stream / streamSimple）。 */
export const mistralConversationsApi = (): ProviderStreams => lazyApi(() => import("./mistral-conversations.ts"));
