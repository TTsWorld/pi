/**
 * @file Google Vertex AI（GCP 服务账号鉴权）的懒加载 shim。
 * @description 完整实现位于 google-vertex.ts（约 600 行），首次调用流方法时才动态 import，
 * 借助 lazyApi 包装成 ProviderStreams，减小启动开销。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/** 工厂函数：返回懒加载版 Google Vertex AI API（stream / streamSimple）。 */
export const googleVertexApi = (): ProviderStreams => lazyApi(() => import("./google-vertex.ts"));
