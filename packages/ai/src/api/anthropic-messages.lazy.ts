/**
 * @file Anthropic Messages API 的懒加载 shim。
 * @description 完整实现位于 anthropic-messages.ts（约 1400 行），首次调用流方法时才动态 import，
 * 借助 lazyApi 包装成 ProviderStreams，避免启动时加载全部厂商实现。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 Anthropic Messages API（stream / streamSimple）。 */
export const anthropicMessagesApi = (): ProviderStreams => lazyApi(() => import("./anthropic-messages.ts"));
