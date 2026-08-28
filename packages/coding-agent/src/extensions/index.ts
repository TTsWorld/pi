/**
 * @file 内置扩展出口：汇总随包分发、默认注册的扩展列表（目前仅 hidden 的 llama.cpp）。
 */
import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [{ name: "llama.cpp", factory: llamaExtension, hidden: true }];
