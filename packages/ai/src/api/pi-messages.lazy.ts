/**
 * @file pi 自有 Messages 协议的懒加载 shim。
 * @description 完整实现位于 pi-messages.ts（约 430 行）：单个 POST 到 <baseUrl>/messages，
 * 响应为 SSE 事件流。首次调用流方法时才动态 import，借助 lazyApi 包装成 ProviderStreams。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 pi Messages API（stream / streamSimple）。 */
export const piMessagesApi = (): ProviderStreams => lazyApi(() => import("./pi-messages.ts"));
