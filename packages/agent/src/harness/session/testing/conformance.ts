/**
 * @file session/testing/conformance.ts —— 会话后端一致性（conformance）测试套件。
 *
 * @description
 * `createSessionBackendConformance(factory)` 为任意会话后端（内存 / JSONL /
 * SQLite…）生成一组**与测试框架无关**的一致性用例：每个用例运行时各自通过
 * 工厂创建独立的 fixture（内含一个 SessionRepo），跑完自动销毁。后端测试只需
 * 把返回的用例按 group / name 注册进任意运行器（如 vitest 的 describe / it），
 * 即可验证该后端行为与其它后端完全一致。本套件经包的 `./session/testing`
 * 子导出对外提供（消费方如 jsonl / memory 后端测试与 sqlite-node 后端）。
 *
 * 断言基于 node:assert/strict（deepStrictEqual / strictEqual / rejects 等）；
 * 被测接口契约见 ../types.ts：SessionStorage 的追加 / 查询 / lane / facts
 * 管理，以及 SessionRepo 的 create / open / list / delete / fork。
 *
 * 覆盖面总览（group → 主题）：
 * - entries and lanes —— 共享 seq 分配、lane 隔离与树共享、id 唯一性、lane
 *   生命周期校验、lane 视图实时绑定、预置 id 追加、terminate 标记、并发写线性化；
 * - records and log —— record / lane 迁移各自成笔、record 组合查询过滤、
 *   open operation 单写者约束、lane 名永久保留、队列取消；
 * - queries and facts —— 非法查询参数前置校验、有界 / 过滤 / 游标查询、
 *   facts 最新值语义、usage 台账统计（getStats）；
 * - validation and immutability —— 非 JSON 载荷拒绝、读取结果防御性拷贝；
 * - repository and forks —— 会话增删查与 branch / tree 两种 fork 范围。
 *
 * 注意：返回数组按编写顺序排列，同一 group 的用例并不在文件中连续出现。
 */
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import type { AgentMessage } from "../../../types.ts";
import type {
	CustomEntry,
	Entry,
	MessageEntry,
	NewRecord,
	OperationStartedRecord,
	SessionErrorCode,
	SessionRepo,
} from "../types.ts";
import type { SessionBackendConformanceCase, SessionBackendFixtureFactory } from "./types.ts";

/** 构造最小可序列化的用户消息（AgentMessage），作为 message entry 的载荷。 */
function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

/** 构造带零值 usage 与 "stop" 停止原因的助手消息；需要非零统计时由用例覆写 usage。 */
function createAssistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

/**
 * 构造指定 kind 的 operation_started record（NewRecord 形态，id 即操作 runId）。
 * 三种 intent 各取最小合法载荷；sourceLeafId 恒为 null（多数用例不关心锚点）。
 */
function operationStarted(
	id: string,
	{ lane, kind }: { lane: string; kind: OperationStartedRecord["intent"]["kind"] },
): NewRecord<OperationStartedRecord> {
	let intent: OperationStartedRecord["intent"];
	switch (kind) {
		case "run":
			intent = { kind, originalPrompt: [], initialMessages: [] };
			break;
		case "compaction":
			intent = { kind, resultEntryId: `${id}-result` };
			break;
		case "navigation":
			intent = { kind, targetId: null, summarize: false };
			break;
	}
	return { type: "operation_started", id, lane, sourceLeafId: null, intent };
}

/** 辅助：把 entry 查询的 Promise 映射为 id 列表，便于断言返回顺序。 */
async function entryIds(entries: Promise<Entry[]>): Promise<string[]> {
	return (await entries).map((entry) => entry.id);
}

/** 断言 operation 以携带指定 code 的 SessionError 拒绝（按 error.code 字段匹配，而非错误类型）。 */
async function rejectsWithCode(operation: Promise<unknown>, code: SessionErrorCode): Promise<void> {
	await rejects(
		operation,
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code,
		`Expected SessionError with code ${code}`,
	);
}

/** 单个一致性用例的测试体：接收 fixture 提供的仓库实例。 */
type ConformanceTest = (repository: SessionRepo) => Promise<void>;

/** 把测试体包装为可注册进任意运行器的用例：运行前创建 fixture，结束后自动销毁（await using）。 */
function createCase(
	factory: SessionBackendFixtureFactory,
	group: string,
	name: string,
	test: ConformanceTest,
): SessionBackendConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture.repository);
		},
	};
}

/** 创建会话后端一致性用例集合；每个用例各自创建并销毁独立的 fixture。 */
export function createSessionBackendConformance(
	factory: SessionBackendFixtureFactory,
): readonly SessionBackendConformanceCase[] {
	return [
		/**
		 * 验证所有变更共享同一个全局 seq 空间：entry、lane 创建 / 迁移、record、
		 * facts（name / label）各占一个序号；存储正确分配 parentId 与 Unix 毫秒
		 * 时间戳，getLog 按提交顺序混编全部事件。
		 */
		createCase(
			factory,
			"entries and lanes",
			"assigns parents and one sequence across every mutation",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const root = await session.appendEntry<MessageEntry>(
					{ type: "message", id: "root", message: createUserMessage("root") },
					"main",
				);
				await session.createLane("thread", root.id);
				const child = await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "child", customType: "note", data: { value: 1 } },
					"thread",
				);
				const record = await session.appendRecord(operationStarted("run", { lane: "thread", kind: "run" }));
				await session.setName("Example");
				await session.setLabel(root.id, "checkpoint");
				await session.moveLane("main", child.id);

				// seq 1 = root entry，2 = createLane，3 = child entry，4 = record（跨变更类型连续编号）
				deepStrictEqual({ parentId: root.parentId, seq: root.seq }, { parentId: null, seq: 1 });
				deepStrictEqual({ parentId: child.parentId, seq: child.seq }, { parentId: "root", seq: 3 });
				strictEqual(record.seq, 4);
				for (const timestamp of [root.timestamp, child.timestamp, record.timestamp]) {
					ok(
						Number.isSafeInteger(timestamp) && timestamp >= 0,
						"storage-assigned timestamps must be Unix milliseconds",
					);
				}
				deepStrictEqual(
					(await session.getLog()).map((item) => [item.kind, item.seq]),
					[
						["entry", 1],
						["lane", 2],
						["entry", 3],
						["record", 4],
						["fact", 5],
						["fact", 6],
						["lane", 7],
					],
				);
				// main 被移到 child 上：两条 lane 可同时指向同一叶子
				deepStrictEqual(await session.getLanes(), [
					{ lane: "main", leafId: "child" },
					{ lane: "thread", leafId: "child" },
				]);
			},
		),

		/**
		 * 验证 record 追加与 lane 迁移是两笔独立变更（各占一个 seq）；moveLane
		 * 目标不存在时以 not_found 拒绝，且失败的变更不消耗 seq、不产生日志项。
		 */
		createCase(
			factory,
			"records and log",
			"commits records and lane moves as separate mutations",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const root = await session.appendEntry<MessageEntry>(
					{ type: "message", id: "root", message: createUserMessage("root") },
					"main",
				);
				const finished = await session.appendRecord({
					type: "operation_finished",
					id: "finish",
					lane: "main",
					runId: "run",
					outcome: "completed",
				});

				strictEqual(finished.seq, 2);
				deepStrictEqual(await session.getLanes(), [{ lane: "main", leafId: "root" }]);
				await session.moveLane("main", null);
				deepStrictEqual(await session.getLanes(), [{ lane: "main", leafId: null }]);
				deepStrictEqual(await session.getLog(), [
					{ kind: "entry", seq: 1, entry: root },
					{ kind: "record", seq: 2, record: finished },
					{ kind: "lane", seq: 3, lane: "main", leafId: null },
				]);

				// 失败的 moveLane 不留任何痕迹：record 仍只有 1 条，日志仍止于 seq 3
				await rejectsWithCode(session.moveLane("main", "missing"), "not_found");
				strictEqual((await session.findRecords()).length, 1);
				deepStrictEqual(
					(await session.getLog()).map((item) => item.seq),
					[1, 2, 3],
				);
			},
		),

		/**
		 * 验证 entry 与 record 共享同一 id 命名空间：任何一侧的重复 id 都以
		 * already_exists 拒绝，且失败的写入不改变存储状态（seq 不前移）。
		 */
		createCase(factory, "entries and lanes", "rejects duplicate ids without changing state", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "shared", message: createUserMessage("root") },
				"main",
			);
			// record id 与已有 entry id 冲突 → already_exists
			await rejectsWithCode(
				session.appendRecord(operationStarted("shared", { lane: "main", kind: "run" })),
				"already_exists",
			);
			await session.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
			// 反向：entry id 与已有 record id 冲突 → already_exists
			await rejectsWithCode(
				session.appendEntry<CustomEntry>({ type: "custom", id: "run", customType: "note" }, "main"),
				"already_exists",
			);
			// 日志只含两笔成功写入：失败的追加未占用 seq
			deepStrictEqual(
				(await session.getLog()).map((item) => item.seq),
				[1, 2],
			);
		}),

		/**
		 * 验证 lane 共享同一棵 entry 树但相互隔离：thread 从 root 分叉后，两条
		 * lane 各自追加子节点，分支查询只返回各自路径上的 entry。
		 */
		createCase(factory, "entries and lanes", "isolates lanes while sharing the tree", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "root", message: createUserMessage("root") },
				"main",
			);
			await session.createLane("thread", "root");
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "main-child", message: createUserMessage("main") },
				"main",
			);
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "thread-child", message: createUserMessage("thread") },
				"thread",
			);

			deepStrictEqual(await session.getLanes(), [
				{ lane: "main", leafId: "main-child" },
				{ lane: "thread", leafId: "thread-child" },
			]);
			// 两条分支只在共享的 root 处重叠，此后互不可见
			deepStrictEqual(await entryIds(session.findEntriesOnBranch({ start: "main-child", order: "oldestFirst" })), [
				"root",
				"main-child",
			]);
			deepStrictEqual(await entryIds(session.findEntriesOnBranch({ start: "thread-child", order: "oldestFirst" })), [
				"root",
				"thread-child",
			]);
		}),

		/**
		 * 验证非法查询参数在任何读取发生前就被 invalid_query 拒绝——即使会话
		 * 为空、结果本可以是空数组，参数校验也不容放过：limit 非正、afterSeq
		 * 为负、operationKind 未搭配 type: "operation_started" 等。
		 */
		createCase(factory, "queries and facts", "rejects invalid queries before empty reads", async (repository) => {
			const session = await repository.create({ id: "invalid-queries" });
			await session.createLane("thread", null);
			const thread = session.view("thread");

			// 逐一覆盖各查询入口的参数约束（entry 查询 / 视图分支查询 / record 查询 / 统一日志）
			await rejectsWithCode(session.findEntries({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findEntry({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findEntriesOnBranch({ limit: 0 }), "invalid_query");
			await rejectsWithCode(thread.findEntriesOnBranch({ cursor: { afterSeq: -1 } }), "invalid_query");
			await rejectsWithCode(thread.findEntryOnBranch({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findRecords({ limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findRecords({ operationKind: "run" }), "invalid_query");
			await rejectsWithCode(session.findRecords({ type: "step_attempt", operationKind: "run" }), "invalid_query");
			await rejectsWithCode(session.findOpenOperations("main", { limit: 0 }), "invalid_query");
			await rejectsWithCode(session.findOpenOperations("main", { limit: -1 }), "invalid_query");
			await rejectsWithCode(session.getLog({ afterSeq: -1 }), "invalid_query");
		}),

		/**
		 * 验证 entry 查询的排序（默认 newestFirst）、游标翻页（afterSeq 与
		 * order 同向取「下一页」）、limit 与 customType 过滤，以及分支扫描的
		 * stopAtType / stopAtId 终止边界（均含终止项）；start 指向不存在的
		 * entry 时以 not_found 拒绝。
		 */
		createCase(
			factory,
			"queries and facts",
			"supports bounded filtered and cursor-based queries",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.appendEntry<MessageEntry>(
					{ type: "message", id: "root", message: createUserMessage("root") },
					"main",
				);
				await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "old-note", customType: "note", data: 1 },
					"main",
				);
				await session.appendEntry(
					{ type: "compaction", id: "compact", summary: "summary", retainedTail: [], tokensBefore: 10 },
					"main",
				);
				await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "new-note", customType: "note", data: 2 },
					"main",
				);
				await session.appendEntry<MessageEntry>(
					{ type: "message", id: "tail", message: createAssistantMessage("tail") },
					"main",
				);

				// 缺省 newestFirst：最新在前
				deepStrictEqual(await entryIds(session.findEntries()), ["tail", "new-note", "compact", "old-note", "root"]);
				deepStrictEqual(
					await entryIds(session.findEntries({ order: "oldestFirst", cursor: { afterSeq: 2 }, limit: 2 })),
					["compact", "new-note"],
				);
				// oldestFirst + afterSeq 2：从 seq 2 之后向更旧方向翻页，再取 2 条；
				// customType 只在 type: "custom" 的 entry 中按二级类型过滤
				deepStrictEqual(await entryIds(session.findEntries({ customType: "note" })), ["new-note", "old-note"]);
				deepStrictEqual(
					await entryIds(session.findEntriesOnBranch({ start: "tail", customType: "note", limit: 1 })),
					["new-note"],
				);
				// 扫描至 compaction（含）即止：终止点之后的 root 虽也是 message 但被截掉
				deepStrictEqual(
					await entryIds(
						session.findEntriesOnBranch({ start: "tail", stopAtType: "compaction", type: "message" }),
					),
					["tail"],
				);
				// stopAtId 即起点本身：区间内无 custom 项 → 空
				deepStrictEqual(
					await entryIds(session.findEntriesOnBranch({ start: "tail", stopAtId: "tail", type: "custom" })),
					[],
				);
				// oldestFirst 方向同理：到最旧的 custom 项（old-note，含）为止
				deepStrictEqual(
					await entryIds(
						session.findEntriesOnBranch({ start: "tail", stopAtType: "custom", order: "oldestFirst" }),
					),
					["root", "old-note"],
				);
				await rejectsWithCode(session.findEntries({ limit: 0 }), "invalid_query");
				await rejectsWithCode(session.findEntriesOnBranch({ start: "missing" }), "not_found");
			},
		),

		/**
		 * 验证 lane 名一经创建即永久保留：即使该 lane 还没有任何 entry、只剩
		 * 恢复用的 record（遗留的 operation_started / queue_enqueued），也不允许
		 * 重建同名 lane（already_exists）——保证崩溃恢复记录始终能按 lane 定位。
		 */
		createCase(
			factory,
			"records and log",
			"keeps lane names permanent with their recovery records",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.createLane("thread", null);
				await session.appendRecord(operationStarted("old-run", { lane: "thread", kind: "run" }));
				await session.appendRecord({
					type: "queue_enqueued",
					id: "old-next-run",
					lane: "thread",
					queue: "nextRun",
					target: { type: "message", id: "queued-message", message: createUserMessage("queued") },
				});

				deepStrictEqual(
					(await session.findRecords({ lane: "thread" })).map((record) => record.id),
					["old-next-run", "old-run"],
				);
				deepStrictEqual(
					(await session.getLog()).flatMap((item) => (item.kind === "record" ? [item.record.id] : [])),
					["old-run", "old-next-run"],
				);
				await rejectsWithCode(session.createLane("thread", null), "already_exists");
			},
		),

		/**
		 * 验证 queue_cancelled record：nextRun 队列不隶属任何操作（record 上无
		 * runId 字段），被取消的入队目标不会落盘成 entry（getEntry 为
		 * undefined），入队与取消两笔 record 均按序进入统一日志。
		 */
		createCase(
			factory,
			"records and log",
			"persists queue cancellation without consuming its target",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const enqueued = await session.appendRecord({
					type: "queue_enqueued",
					id: "enqueue",
					lane: "main",
					queue: "nextRun",
					target: { type: "message", id: "queued-message", message: createUserMessage("queued") },
				});
				const cancelled = await session.appendRecord({
					type: "queue_cancelled",
					id: "cancel",
					lane: "main",
					entryId: "queued-message",
				});
				// 取消 record 排在入队之后（seq 2）；被取消的 target 始终未物化为 entry
				deepStrictEqual({ seq: cancelled.seq, entryId: cancelled.entryId }, { seq: 2, entryId: "queued-message" });
				strictEqual("runId" in cancelled, false);
				strictEqual(await session.getEntry("queued-message"), undefined);
				const cancellations = await session.findRecords({ type: "queue_cancelled" });
				strictEqual(cancellations[0]?.entryId, "queued-message");
				deepStrictEqual(cancellations, [cancelled]);
				deepStrictEqual(await session.getLog(), [
					{ kind: "record", seq: enqueued.seq, record: enqueued },
					{ kind: "record", seq: cancelled.seq, record: cancelled },
				]);
			},
		),

		/**
		 * 验证 findRecords 的组合过滤：按 lane 精确匹配、按 type + oldestFirst
		 * 排序、按 runId + afterSeq（排他下界 seq > afterSeq，与 order 无关）、
		 * 以及 limit 截取（默认 newestFirst）。
		 */
		createCase(
			factory,
			"records and log",
			"filters records by lane type run sequence and order",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.appendRecord(operationStarted("run-1", { lane: "main", kind: "run" }));
				await session.appendRecord({
					type: "step_attempt",
					id: "attempt-1",
					lane: "main",
					runId: "run-1",
					step: "assistant",
					attempt: 1,
					resultEntryId: "assistant-1",
				});
				await session.createLane("thread", null);
				await session.appendRecord(operationStarted("run-2", { lane: "thread", kind: "run" }));
				await session.appendRecord({
					type: "step_attempt",
					id: "attempt-2",
					lane: "thread",
					runId: "run-2",
					step: "assistant",
					attempt: 1,
					resultEntryId: "assistant-2",
				});

				deepStrictEqual(
					(await session.findRecords({ lane: "thread" })).map((record) => record.id),
					["attempt-2", "run-2"],
				);
				deepStrictEqual(
					(await session.findRecords({ type: "step_attempt", order: "oldestFirst" })).map((record) => record.id),
					["attempt-1", "attempt-2"],
				);
				// afterSeq 1 排除 run-1 自身（seq 1），只剩隶属它的 attempt-1（seq 2）
				deepStrictEqual(
					(await session.findRecords({ runId: "run-1", afterSeq: 1 })).map((record) => record.id),
					["attempt-1"],
				);
				deepStrictEqual(
					(await session.findRecords({ limit: 1 })).map((record) => record.id),
					["attempt-2"],
				);
			},
		),

		/** 验证 operationKind 过滤仅作用于 operation_started：按 run / compaction / navigation 分别筛选，并可与 limit 组合取最新一条。 */
		createCase(factory, "records and log", "filters operation starts by operation kind", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendRecord(operationStarted("run-old", { lane: "main", kind: "run" }));
			await session.appendRecord({
				type: "operation_finished",
				id: "run-old-finished",
				lane: "main",
				runId: "run-old",
				outcome: "completed",
			});
			await session.appendRecord(operationStarted("compaction", { lane: "main", kind: "compaction" }));
			await session.appendRecord({
				type: "operation_finished",
				id: "compaction-finished",
				lane: "main",
				runId: "compaction",
				outcome: "completed",
			});
			await session.appendRecord(operationStarted("navigation", { lane: "main", kind: "navigation" }));
			await session.appendRecord({
				type: "operation_finished",
				id: "navigation-finished",
				lane: "main",
				runId: "navigation",
				outcome: "completed",
			});
			await session.appendRecord(operationStarted("run-new", { lane: "main", kind: "run" }));

			// 已收尾的 run-old 与未收尾的 run-new 都能按 kind 检出
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "run",
						order: "oldestFirst",
					})
				).map((record) => record.id),
				["run-old", "run-new"],
			);
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "compaction",
					})
				).map((record) => record.id),
				["compaction"],
			);
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "navigation",
					})
				).map((record) => record.id),
				["navigation"],
			);
			deepStrictEqual(
				(
					await session.findRecords({
						type: "operation_started",
						operationKind: "run",
						limit: 1,
					})
				).map((record) => record.id),
				["run-new"],
			);
		}),

		/**
		 * 验证单写者约束：每个 lane 同时至多一个未收尾操作——findOpenOperations
		 * 追踪 open 状态；在已有 open operation 的 lane 上再启动一个操作以
		 * storage 错误拒绝且不改变现有状态；operation_finished 收尾后 lane
		 * 恢复空闲。
		 */
		createCase(factory, "records and log", "tracks and enforces one open operation per lane", async (repository) => {
			const session = await repository.create({ id: "session" });
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), []);

			const first = await session.appendRecord(operationStarted("first", { lane: "main", kind: "run" }));
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), [first]);
			// 同一 lane 的第二个 open operation 违反单写者协议 → storage 错误
			await rejectsWithCode(
				session.appendRecord(operationStarted("second", { lane: "main", kind: "run" })),
				"storage",
			);
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), [first]);

			await session.appendRecord({
				type: "operation_finished",
				id: "finish-first",
				lane: "main",
				runId: first.id,
				outcome: "completed",
			});
			deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), []);
		}),

		/**
		 * 验证 finish 只能关闭其日志位置之后的 start：先落盘的
		 * operation_finished 不能关闭之后才启动的同 runId 操作——open 状态由
		 * 日志顺序决定，而非简单按 runId 配对抵消。
		 */
		createCase(
			factory,
			"records and log",
			"does not let an earlier finish close a later start",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				await session.appendRecord({
					type: "operation_finished",
					id: "finish-before-start",
					lane: "main",
					runId: "run",
					outcome: "completed",
				});
				const started = await session.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
				deepStrictEqual(await session.findOpenOperations("main", { limit: 2 }), [started]);
			},
		),

		/** 验证 findOpenOperations 按 lane 隔离：main 与 thread 各自的未收尾操作互不可见，limit 仅截取返回条数。 */
		createCase(factory, "records and log", "scopes open operations by lane and limit", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.createLane("thread", null);
			const mainRun = await session.appendRecord(operationStarted("main-run", { lane: "main", kind: "run" }));
			const threadNavigation = await session.appendRecord(
				operationStarted("thread-navigation", { lane: "thread", kind: "navigation" }),
			);

			deepStrictEqual(await session.findOpenOperations("main"), [mainRun]);
			deepStrictEqual(await session.findOpenOperations("main", { limit: 1 }), [mainRun]);
			deepStrictEqual(await session.findOpenOperations("thread", { limit: 2 }), [threadNavigation]);
		}),

		/**
		 * 验证读取结果不可变：篡改 findOpenOperations 返回 record 的 intent
		 * 数组后再读，数据不受影响——后端必须返回防御性副本而非内部引用。
		 */
		createCase(
			factory,
			"validation and immutability",
			"returns immutable open-operation records",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const committed = await session.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
				const [read] = await session.findOpenOperations("main");
				if (read?.intent.kind !== "run") throw new Error("Expected an open run operation");
				read.intent.originalPrompt.push(createUserMessage("mutated"));

				deepStrictEqual(await session.findOpenOperations("main"), [committed]);
			},
		),

		/**
		 * 验证 facts 的最新值语义（重复 set 取最后一次、传 undefined 即清除、
		 * 目标不存在则 not_found），以及 getStats 台账统计：跨 lane 累加全部
		 * usage record——cachedTokens 计 cacheRead，uncachedTokens 计 input +
		 * cacheWrite，负数 adjustment 参与冲抵。
		 */
		createCase(
			factory,
			"queries and facts",
			"keeps latest-value facts and computes ledger statistics across lanes",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const assistant = createAssistantMessage("answer");
				if (assistant.role !== "assistant") throw new Error("Expected assistant message");
				assistant.usage = {
					input: 10,
					output: 5,
					cacheRead: 3,
					cacheWrite: 2,
					totalTokens: 20,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
				};
				await session.appendEntry<MessageEntry>(
					{ type: "message", id: "user", message: createUserMessage("question") },
					"main",
				);
				await session.appendEntry<MessageEntry>({ type: "message", id: "assistant", message: assistant }, "main");
				await session.appendRecord({
					type: "usage",
					id: "assistant-usage",
					lane: "main",
					cause: "assistant",
					runId: "run",
					entryId: "assistant",
					attempt: 1,
					stopReason: "stop",
					usage: assistant.usage,
				});
				await session.appendRecord({
					type: "usage",
					id: "deferred-usage",
					lane: "main",
					cause: "deferred_fetch",
					runId: "run",
					entryId: "deferred-result",
					attempt: 1,
					stopReason: "deferred",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
				await session.createLane("thread", "assistant");
				await session.appendRecord({
					type: "usage",
					id: "correction",
					lane: "thread",
					cause: "adjustment",
					details: { reason: "provider correction" },
					usage: {
						input: -2,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: -2,
						cost: { input: -0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: -0.5 },
					},
				});
				await session.setName("First");
				await session.setName("Second");
				await session.setLabel("user", "keep");
				await session.setLabel("user", undefined);
				await rejectsWithCode(session.setLabel("missing", "checkpoint"), "not_found");

				strictEqual(await session.getName(), "Second");
				strictEqual(await session.getLabel("user"), undefined);
				const usageRecords = await session.findRecords({ type: "usage", order: "oldestFirst" });
				deepStrictEqual(
					usageRecords.map((record) => record.cause),
					["assistant", "deferred_fetch", "adjustment"],
				);
				const deferredUsage = usageRecords.find((record) => record.cause === "deferred_fetch");
				if (deferredUsage?.cause !== "deferred_fetch") throw new Error("Expected deferred usage record");
				strictEqual(deferredUsage.stopReason, "deferred");
				// cached = 3；uncached = (10+2) + 0 − 2 = 10；total = 20 + 0 − 2 = 18；费用 = 10 − 0.5 = 9.5
				deepStrictEqual(await session.getStats(), {
					messageCount: 2,
					cachedTokens: 3,
					uncachedTokens: 10,
					totalTokens: 18,
					costTotal: 9.5,
				});
			},
		),

		/**
		 * 验证 setName(undefined) 的清除是持久事实：清除本身作为一条 name 为
		 * undefined 的 fact 日志项落盘，重开会话与 fork 之后名称仍为空。
		 */
		createCase(factory, "queries and facts", "clears session names durably", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.setName("Temporary");
			await session.setName(undefined);

			strictEqual(await session.getName(), undefined);
			deepStrictEqual(await session.getLog(), [
				{ kind: "fact", seq: 1, fact: "name", name: "Temporary" },
				{ kind: "fact", seq: 2, fact: "name", name: undefined },
			]);

			const metadata = await session.getMetadata();
			const reopened = await repository.open(metadata);
			strictEqual(await reopened.getName(), undefined);
			deepStrictEqual(await reopened.getLog(), [
				{ kind: "fact", seq: 1, fact: "name", name: "Temporary" },
				{ kind: "fact", seq: 2, fact: "name", name: undefined },
			]);

			const fork = await repository.fork(metadata, { id: "fork" });
			strictEqual(await fork.getName(), undefined);
		}),

		/**
		 * 验证读取接口返回深拷贝：写入后修改调用方持有的原始对象、篡改
		 * getEntry / getMetadata / getLog 的返回值，都不会污染存储中的数据。
		 */
		createCase(factory, "validation and immutability", "returns immutable copies from reads", async (repository) => {
			const session = await repository.create({ id: "immutable" });
			const metadata = await session.getMetadata();
			const data = { nested: { value: 1 } };
			await session.appendEntry<CustomEntry>({ type: "custom", id: "custom", customType: "note", data }, "main");
			// 追加后修改原始对象：存储必须持有写入时的快照而非引用
			data.nested.value = 50;
			const read = await session.getEntry("custom");
			if (read?.type !== "custom") throw new Error("Expected custom entry");
			(read.data as { nested: { value: number } }).nested.value = 99;
			const readMetadata = await session.getMetadata();
			readMetadata.id = "changed";
			const log = await session.getLog();
			if (log[0]?.kind !== "entry" || log[0].entry.type !== "custom") throw new Error("Expected entry log");
			(log[0].entry.data as { nested: { value: number } }).nested.value = 100;

			deepStrictEqual(await session.getMetadata(), metadata);
			deepStrictEqual(await session.getEntry("custom"), {
				type: "custom",
				id: "custom",
				customType: "note",
				data: { nested: { value: 1 } },
				parentId: null,
				seq: 1,
				timestamp: read.timestamp,
			});
		}),

		/** 验证 lane 生命周期校验：重复创建 → already_exists；锚点 entry 不存在 → not_found；移动不存在的 lane → invalid_lane。 */
		createCase(factory, "entries and lanes", "validates lane lifecycle and targets", async (repository) => {
			const session = await repository.create({ id: "session" });
			await rejectsWithCode(session.createLane("main", null), "already_exists");
			await rejectsWithCode(session.createLane("thread", "missing"), "not_found");
			await rejectsWithCode(session.moveLane("missing", null), "invalid_lane");
		}),

		/**
		 * 验证 view(lane) 返回实时视图而非缓存快照：并发向两条 lane 追加后，
		 * 各自的 getLeafId / 分支查询都能立即看到新叶子；空会话的分支查询
		 * （缺省起点）返回空数组。
		 */
		createCase(factory, "entries and lanes", "binds lane views without caching leaves", async (repository) => {
			const session = await repository.create({ id: "session" });
			const root = await session.appendMessage(createUserMessage("root"));
			await session.createLane("thread", root);
			const thread = session.view("thread");
			// 拿到视图后再并发追加：视图不得缓存创建时刻的叶子
			const [mainChild, threadChild] = await Promise.all([
				session.appendMessage(createUserMessage("main")),
				thread.appendMessage(createUserMessage("thread")),
			]);

			strictEqual(await session.getLeafId(), mainChild);
			strictEqual(await thread.getLeafId(), threadChild);
			deepStrictEqual(await entryIds(session.findEntriesOnBranch({ order: "oldestFirst" })), [root, mainChild]);
			deepStrictEqual(await entryIds(thread.findEntriesOnBranch({ order: "oldestFirst" })), [root, threadChild]);
			const empty = await repository.create({ id: "empty" });
			deepStrictEqual(await empty.findEntriesOnBranch(), []);
		}),

		/**
		 * 验证 appendEntry 保留写入方预置的 entry id（崩溃恢复按 id 幂等补写的
		 * 前提），存储只补齐 parentId / seq / timestamp 等分配字段。
		 */
		createCase(
			factory,
			"entries and lanes",
			"appends provisioned entries with their existing ids",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const entry = await session.appendEntry<CustomEntry>(
					{ type: "custom", id: "provisioned", customType: "note", data: { value: 1 } },
					"main",
				);

				strictEqual(entry.customType, "note");
				deepStrictEqual(
					{ id: entry.id, parentId: entry.parentId, seq: entry.seq },
					{ id: "provisioned", parentId: null, seq: 1 },
				);
				strictEqual(await session.getLeafId(), "provisioned");
			},
		),

		/** 验证 message entry 的 terminate: true（工具结果要求终止本轮运行）被完整持久化，且经查询与统一日志均可原样读回。 */
		createCase(factory, "entries and lanes", "persists tool-result termination decisions", async (repository) => {
			const session = await repository.create({ id: "session" });
			const entry = await session.appendEntry<MessageEntry>(
				{
					type: "message",
					id: "tool-result",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "example",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: 1,
					},
					terminate: true,
				},
				"main",
			);

			strictEqual(entry.terminate, true);
			const stored = await session.getEntry(entry.id);
			if (stored?.type !== "message") throw new Error("Expected message entry");
			strictEqual(stored.terminate, true);
			deepStrictEqual(await session.findEntries(), [entry]);
			deepStrictEqual(await session.getLog(), [{ kind: "entry", seq: entry.seq, entry }]);
		}),

		/**
		 * 验证非严格 JSON 载荷（undefined / BigInt / NaN / Map / 循环引用等）
		 * 在触及存储前即被 invalid_payload 拒绝：不留 entry、不占 seq、日志为
		 * 空；随后的合法写入从 seq 1 起算。
		 */
		createCase(
			factory,
			"validation and immutability",
			"rejects non-JSON entries before storage mutation",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				const cyclic: { self?: unknown } = {};
				cyclic.self = cyclic;

				for (const data of [
					{ value: undefined },
					[undefined],
					{ value: 1n },
					{ value: Number.NaN },
					{ value: new Map() },
					cyclic,
				]) {
					await rejectsWithCode(session.appendCustomEntry("invalid", data), "invalid_payload");
				}

				strictEqual(await session.getLeafId(), null);
				deepStrictEqual(await session.findEntries(), []);
				deepStrictEqual(await session.getLog(), []);
				const validId = await session.appendCustomEntry("valid", { value: 1 });
				strictEqual((await session.getEntry(validId))?.seq, 1);
			},
		),

		/**
		 * 同「rejects non-JSON entries」但针对 record：effectiveArgs 含
		 * undefined / BigInt 的 tool_started record 以 invalid_payload 拒绝且
		 * 不留痕迹；随后的合法 record 从 seq 1 起算。
		 */
		createCase(
			factory,
			"validation and immutability",
			"rejects non-JSON records before storage mutation",
			async (repository) => {
				const session = await repository.create({ id: "session" });
				for (const [id, value] of [
					["undefined-record", undefined],
					["bigint-record", 1n],
				] as const) {
					await rejectsWithCode(
						session.appendRecord({
							type: "tool_started",
							id,
							lane: "main",
							runId: "run",
							assistantEntryId: "assistant",
							toolIndex: 0,
							toolCallId: "call",
							toolName: "example",
							effectiveArgs: { value },
							resultEntryId: "result",
							replay: "never",
						}),
						"invalid_payload",
					);
				}

				deepStrictEqual(await session.findRecords(), []);
				deepStrictEqual(await session.getLog(), []);
				strictEqual(
					(await session.appendRecord(operationStarted("valid-record", { lane: "main", kind: "run" }))).seq,
					1,
				);
			},
		),

		/**
		 * 验证并发追加被线性化：跨两条 lane 同时发起四次写入，每个 entry 拿到
		 * 互不相同的 seq；Promise 完成顺序与 seq 提交顺序一致；统一日志按 seq
		 * 严格递增且包含全部并发 entry。
		 */
		createCase(factory, "entries and lanes", "linearizes concurrent writes across two lanes", async (repository) => {
			const session = await repository.create({ id: "session" });
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "root", message: createUserMessage("root") },
				"main",
			);
			await session.createLane("thread", "root");
			const completionOrder: string[] = [];
			const writes = [
				session.appendEntry<CustomEntry>({ type: "custom", id: "main-1", customType: "note" }, "main"),
				session.appendEntry<CustomEntry>({ type: "custom", id: "thread-1", customType: "note" }, "thread"),
				session.appendEntry<CustomEntry>({ type: "custom", id: "main-2", customType: "note" }, "main"),
				session.appendEntry<CustomEntry>({ type: "custom", id: "thread-2", customType: "note" }, "thread"),
			].map((write) =>
				write.then((entry) => {
					completionOrder.push(entry.id);
					return entry;
				}),
			);
			const entries = await Promise.all(writes);
			const commitOrder = [...entries].sort((left, right) => left.seq - right.seq).map((entry) => entry.id);

			// seq 两两互异；且谁先 resolve 谁先拿到更小的 seq（完成序 = 提交序）
			strictEqual(new Set(entries.map((entry) => entry.seq)).size, entries.length);
			deepStrictEqual(completionOrder, commitOrder);
			const concurrentIds = new Set(entries.map((entry) => entry.id));
			deepStrictEqual(
				(await session.getLog()).flatMap((item) =>
					item.kind === "entry" && concurrentIds.has(item.entry.id) ? [item.entry.id] : [],
				),
				commitOrder,
			);
			const sequences = (await session.getLog()).map((item) => item.seq);
			deepStrictEqual(
				sequences,
				[...sequences].sort((left, right) => left - right),
			);
		}),

		/** 验证仓库基础生命周期：create → list（元数据逐字段一致）→ open（写入内容可读回）；重复 id 创建 → already_exists。 */
		createCase(factory, "repository and forks", "creates lists and opens sessions", async (repository) => {
			const session = await repository.create({ id: "one" });
			const entryId = await session.appendMessage(createUserMessage("persisted"));
			const metadata = await session.getMetadata();

			const listed = await repository.list();
			strictEqual(listed.length, 1);
			strictEqual(listed[0]?.id, metadata.id);
			strictEqual(listed[0]?.createdAt, metadata.createdAt);
			strictEqual(listed[0]?.parentSessionId, metadata.parentSessionId);
			deepStrictEqual(await entryIds((await repository.open(metadata)).findEntries()), [entryId]);
			await rejectsWithCode(repository.create({ id: "one" }), "already_exists");
		}),

		/** 验证删除幂等：删除后 open → not_found；对已删除会话再次 delete 不报错。 */
		createCase(factory, "repository and forks", "deletes sessions idempotently", async (repository) => {
			const session = await repository.create({ id: "one" });
			const metadata = await session.getMetadata();

			await repository.delete(metadata);
			await rejectsWithCode(repository.open(metadata), "not_found");
			await repository.delete(metadata);
		}),

		/**
		 * 验证 branch fork（scope: "branch" + position: "at"）：只复制目标 entry
		 * 到根的路径，仅保留指向被复制 entry 的 label（thread 分支上的被丢弃）；
		 * 不复制任何 record（token / 费用统计清零、messageCount 按复制的
		 * entry 重算）；元数据记录 parentSessionId，且 fork 后可继续追加。
		 */
		createCase(
			factory,
			"repository and forks",
			"forks one branch with selected facts and no records",
			async (repository) => {
				const source = await repository.create({ id: "source" });
				const root = await source.appendMessage(createUserMessage("root"));
				const shared = await source.appendMessage(createAssistantMessage("shared"));
				await source.createLane("thread", shared);
				const threadChild = await source.view("thread").appendMessage(createUserMessage("thread"));
				const mainChild = await source.appendMessage(createUserMessage("main"));
				await source.setName("Source");
				await source.setLabel(shared, "copied");
				await source.setLabel(threadChild, "excluded");
				await source.appendRecord(operationStarted("run", { lane: "main", kind: "run" }));
				await source.appendRecord({
					type: "usage",
					id: "source-usage",
					lane: "main",
					cause: "adjustment",
					usage: {
						input: 10,
						output: 5,
						cacheRead: 3,
						cacheWrite: 2,
						totalTokens: 20,
						cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
					},
				});

				const fork = await repository.fork(await source.getMetadata(), {
					scope: "branch",
					entryId: mainChild,
					position: "at",
					id: "branch-fork",
				});

				deepStrictEqual(await entryIds(fork.findEntries({ order: "oldestFirst" })), [root, shared, mainChild]);
				deepStrictEqual(await fork.getLanes(), [{ lane: "main", leafId: mainChild }]);
				strictEqual(await fork.getName(), "Source");
				strictEqual(await fork.getLabel(shared), "copied");
				// 未被复制的 entry 上的 label 不随 fork 迁移；record 日志整体不复制
				strictEqual(await fork.getLabel(threadChild), undefined);
				deepStrictEqual(await fork.findRecords(), []);
				deepStrictEqual(await fork.getStats(), {
					messageCount: 3,
					cachedTokens: 0,
					uncachedTokens: 0,
					totalTokens: 0,
					costTotal: 0,
				});
				await fork.appendMessage(createUserMessage("after fork"));
				strictEqual((await fork.getStats()).messageCount, 4);
				const metadata = await fork.getMetadata();
				deepStrictEqual(
					{ id: metadata.id, parentSessionId: metadata.parentSessionId },
					{ id: "branch-fork", parentSessionId: "source" },
				);
			},
		),

		/**
		 * 验证 tree fork（scope: "tree"）：整棵 entry 树、全部 lane 指针与
		 * entry label 一并复制，日志中的 lane 项按复制后的写入顺序重新编号。
		 */
		createCase(factory, "repository and forks", "forks a complete tree with lanes and facts", async (repository) => {
			const source = await repository.create({ id: "source" });
			const root = await source.appendMessage(createUserMessage("root"));
			await source.createLane("thread", root);
			const mainChild = await source.appendMessage(createUserMessage("main"));
			const threadChild = await source.view("thread").appendMessage(createUserMessage("thread"));
			await source.setLabel(threadChild, "thread-tip");

			const fork = await repository.fork(await source.getMetadata(), { scope: "tree", id: "tree-fork" });
			deepStrictEqual(await entryIds(fork.findEntries({ order: "oldestFirst" })), [root, mainChild, threadChild]);
			deepStrictEqual(await fork.getLanes(), [
				{ lane: "main", leafId: mainChild },
				{ lane: "thread", leafId: threadChild },
			]);
			strictEqual(await fork.getLabel(threadChild), "thread-tip");
			strictEqual((await fork.getStats()).messageCount, 3);
			deepStrictEqual(
				// fork 日志中两条 lane 迁移紧随 3 个 entry（seq 1-3）之后
				(await fork.getLog()).filter((item) => item.kind === "lane"),
				[
					{ kind: "lane", seq: 4, lane: "main", leafId: mainChild },
					{ kind: "lane", seq: 5, lane: "thread", leafId: threadChild },
				],
			);
		}),

		/**
		 * 验证 position 语义与默认目标：position "before" 排除目标 entry、
		 * "at" 包含；entryId 缺省取 main 叶子；fork 不改动源会话；目标 entry
		 * 不存在 → invalid_fork_target。
		 */
		createCase(
			factory,
			"repository and forks",
			"forks before an entry without modifying the source",
			async (repository) => {
				const source = await repository.create({ id: "source" });
				const root = await source.appendMessage(createUserMessage("root"));
				const tail = await source.appendMessage(createUserMessage("tail"));
				const fork = await repository.fork(await source.getMetadata(), { entryId: tail, id: "fork" });

				deepStrictEqual(await entryIds(fork.findEntries({ order: "oldestFirst" })), [root]);
				strictEqual(await fork.getLeafId(), root);
				strictEqual(await source.getLeafId(), tail);
				const beforeDefaultTarget = await repository.fork(await source.getMetadata(), {
					position: "before",
					id: "before-default-target",
				});
				deepStrictEqual(await entryIds(beforeDefaultTarget.findEntries({ order: "oldestFirst" })), [root]);
				strictEqual(await beforeDefaultTarget.getLeafId(), root);

				const atDefaultTarget = await repository.fork(await source.getMetadata(), {
					position: "at",
					id: "at-default-target",
				});
				deepStrictEqual(await entryIds(atDefaultTarget.findEntries({ order: "oldestFirst" })), [root, tail]);
				strictEqual(await atDefaultTarget.getLeafId(), tail);
				await rejectsWithCode(
					repository.fork(await source.getMetadata(), { entryId: "missing" }),
					"invalid_fork_target",
				);
			},
		),

		/** 验证默认 fork 目标必须是 message entry：main 叶子为 custom entry 时，按默认目标 fork → invalid_fork_target。 */
		createCase(factory, "repository and forks", "validates the default fork target", async (repository) => {
			const source = await repository.create({ id: "source-with-custom-leaf" });
			await source.appendCustomEntry("not-a-message");

			await rejectsWithCode(repository.fork(await source.getMetadata(), { id: "fork" }), "invalid_fork_target");
		}),
	];
}
