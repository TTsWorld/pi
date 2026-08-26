/**
 * @file 会话搜索模块的公共入口
 *
 * @description
 * 定义跨后端共享的搜索契约：`SessionSearch`（按查询文本异步迭代命中）、
 * `SessionSearchHit`（仅携带可移植的稳定命中身份）、`SessionSearchOptions`
 * （条目类型过滤 / 数量上限 / 取消信号）。同时转售 scanning.ts 中的扫描式实现
 * （`createScanningSessionSearch` 等），供任意类 SessionStorage 的只读视图
 * 以线性扫描方式复用同一套搜索逻辑。模块设计详见 docs/search.md。
 */

import type { Entry } from "../harness/session/types.ts";

// ========== 扫描式实现（scanning.ts）的转售导出 ==========
// 契约类型定义在本文件，可复用的线性扫描实现放在 scanning.ts，此处统一对外暴露
export type {
	ScanningReadable,
	ScanningReadableOptions,
	ScanningReadableSource,
	ScanningSearchTextProjector,
	ScanningSessionSearchHit,
	ScanningSessionSearchOptions,
	SessionSearchCandidate,
} from "./scanning.ts";
export { createScanningSessionSearch, scanningEntries } from "./scanning.ts";

/** 搜索选项：限定条目类型、命中数量上限，以及取消信号。 */
export interface SessionSearchOptions {
	/** 限定只返回指定 canonical 条目类型的结果。 */
	readonly entryTypes?: readonly Entry["type"][];
	/** 返回命中的最大数量。 */
	readonly limit?: number;
	/** 用于取消操作的 AbortSignal，例如边输入边搜索 (search-as-you-type)。 */
	readonly signal?: AbortSignal;
}

/**
 * 搜索命中（基础形态）：只携带稳定身份。
 *
 * (sessionId, entryId) 是跨 JSONL、内存、SQLite FTS 与远程索引可移植的命中身份；
 * snippet、时间戳、评分、排序语义等展示数据由具体实现自行扩展
 * （扫描式实现见 {@link ScanningSessionSearchHit}）。
 */
export interface SessionSearchHit {
	/** 拥有该条目的会话的逻辑标识。 */
	readonly sessionId: string;
	/** 该条目在其所属会话内的逻辑标识。 */
	readonly entryId: string;
}

/**
 * 会话搜索契约：按查询文本搜索已提交的会话条目，异步迭代命中结果。
 *
 * 返回 AsyncIterable 使消费方可以尽早渲染结果、取够即停止迭代，
 * 并可通过 AbortSignal 取消在途工作；防抖 (debounce) 是调用方 / UI 的职责。
 */
export interface SessionSearch<T extends SessionSearchHit = SessionSearchHit> {
	/** 执行搜索并按实现定义的顺序逐个产出命中（扫描式实现为时间正序）。 */
	search(text: string, options?: SessionSearchOptions): AsyncIterable<T>;
}
