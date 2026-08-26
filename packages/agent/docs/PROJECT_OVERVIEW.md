# 项目架构总览：@earendil-works/pi-agent-core

> 本文由代码分析自动生成（2026-08-26），配合全量中文源码注释阅读。
> 相关文档：[LEARNING_GUIDE.md](./LEARNING_GUIDE.md) ｜ [FILES.md](./FILES.md) ｜ 原英文文档 [harness.md](./harness.md)、[search.md](./search.md)、[telemetry-schema.md](./telemetry-schema.md)

## 1. 项目简介

pi-agent-core 是 pi monorepo 中的**有状态 Agent 运行时**：在 `@earendil-works/pi-ai`（LLM 统一接口）之上，提供 Agent 循环、状态管理、事件流、工具执行、会话持久化、上下文压缩、技能加载与遥测等能力。

与相邻包的分工边界非常清晰：

| 包 | 职责 |
|----|------|
| `pi-ai` | 「调模型」：providers、Models、流式请求、usage/成本统计 |
| **`pi-agent-core`（本包）** | 「循环、状态、工具、会话」：不含任何 provider 代码，所有 LLM 调用通过注入的 `StreamFn` 完成（`Models.streamSimple` 即满足签名） |
| `pi-coding-agent` | 下游产品，同时使用以上两者 |

## 2. 技术栈

- **语言**：TypeScript（ESM-only，Node ≥ 22.19，`.ts` 后缀导入）
- **构建**：`tsgo`（TypeScript 原生编译器预览版）
- **运行时依赖仅 6 个**：
  - `@earendil-works/pi-ai` — LLM 接口、EventStream、uuidv7
  - `@earendil-works/pi-telemetry` — 遥测基座
  - `typebox` — 工具参数 schema 与深比较
  - `diff` — edit 工具的 diff 算法
  - `ignore` — skills 加载时尊重 .gitignore
  - `yaml` — SKILL.md 的 frontmatter 解析
- **测试**：vitest（`test/` + harness 专用配置）

## 3. 目录结构与模块职责

```
packages/agent/src/
├── types.ts            # 核心词汇表：StreamFn / AgentTool / AgentMessage / AgentState / AgentEvent / AgentLoopConfig
├── agent.ts            # Agent 类：低层循环的有状态门面（状态 + 双消息队列 + 事件分发）
├── agent-loop.ts       # ★ 心脏：流式调用 LLM → 解析事件 → 执行工具 → 产出 AgentEvent 流
├── stream-fn.ts        # 默认 streamFn 的全局配置/兜底
├── proxy.ts            # streamProxy：浏览器场景经后端代理的 StreamFn（削减字段省带宽）
├── index.ts / node.ts  # 导出入口（node.ts 额外导出 NodeExecutionEnv）
├── search/             # SessionSearch 接口 + 线性扫描实现（会话/条目搜索）
└── harness/            # 耐久运行时（构建块完成，执行引擎按 docs/harness.md 规范实现中）
    ├── agent-harness.ts    # AgentHarness：组装 Agent + 工具 + 会话 + hooks 的宿主
    ├── types.ts            # Result<T,E>、Skill、ExecutionEnv（FileSystem+Shell 能力接口）、各类 Error
    ├── env/nodejs.ts       # NodeExecutionEnv：ExecutionEnv 的 Node 实现
    ├── session/            # ★ 会话持久化体系（见 §4.3）
    ├── compaction/         # 上下文压缩（见 §4.4）
    ├── tools/              # bash/read/write/edit 工具工厂 + diff 算法 + 文件变更串行队列
    ├── skills.ts           # 递归加载 SKILL.md（YAML frontmatter，尊重 .gitignore）
    ├── system-prompt.ts    # 把技能列表格式化为 agentskills.io 风格 XML 块
    ├── prompt-templates.ts # 加载 .md 提示词模板
    ├── messages.ts         # 声明合并注册 4 种自定义消息 + harness 版 convertToLlm
    ├── reducer.ts          # record 日志 → LaneState 规约（崩溃恢复 + 12 种损坏检测）
    ├── events.ts           # HarnessEventBus（run_start/run_end + watch 快照）
    ├── result.ts           # TaggedError 工厂与 matchError
    ├── telemetry.ts        # 遥测 schema 与 span 工具
    └── utils/              # truncate（2000 行/50KB 双限制）、shell-output（流式捕获）
```

## 4. 核心抽象与数据流

### 4.1 Agent 生命周期（核心引擎）

```
agent.prompt("...")
  └─ runWithLifecycle（AbortController + activeRun promise）
      └─ runAgentLoop(消息, 状态快照, loopConfig, processEvents, signal, streamFn)
          └─ 每个 turn：
              ① 注入 pending 消息（steering / follow-up 队列）
              ② streamAssistantResponse
                 transformContext 裁剪 → convertToLlm 过滤 UI 消息 → streamFn 流式
                 （逐事件 emit message_start / message_update）
              ③ message_end：assistant 消息 push 进上下文
              ④ 有 toolCall → executeToolCalls
                 参数校验 → beforeToolCall 可拦截 → 执行（sequential/parallel）
                 → afterToolCall 可改写结果 → toolResult 消息
              ⑤ turn_end → shouldStopAfterTurn（compaction 借此优雅停）
                          → prepareNextTurn（可换 model/context）
              ⑥ 轮询 steering → 轮询 follow-up → 下一轮或 agent_end
```

- **状态**：`MutableAgentState` 中 `tools`/`messages` 经 getter/setter 强制替换式更新（保证引用可见性）；`isStreaming`/`pendingToolCalls` 等为只读派生。
- **队列**：`PendingMessageQueue` 支持 `steer`（插队，当轮生效）与 `followUp`（排队，下一轮生效）两种模式（`QueueMode`: `"all" | "one-at-a-time"`）。
- **事件**：`Agent.processEvents` 先内联更新 state，再按注册顺序 `await` 监听器；`agent_end` 监听器全部结算完才算 idle（`waitForIdle`）。

### 4.2 工具体系

- `AgentTool` = typebox 参数 schema + `execute` + `executionMode`（sequential/parallel）。
- `beforeToolCall` 可 block；`afterToolCall` 可改写 content/details；整批可 `terminate` 早停。
- 截断消息中的工具调用会全批失败（`failToolCallsFromTruncatedMessage`）。
- harness 工具额外接收 turn 快照 context（`ExecutionToolContext = { env }`）；`file-mutation-queue` 按 canonical path 串行化文件写，避免并发写冲突；`path-utils` 处理 Unicode 空格/变音路径容错。

### 4.3 Session 持久化体系（harness/session/）

接口三层 + 数据模型两种：

| 概念 | 说明 |
|------|------|
| `SessionStorage` | 追加 entry/record + 查询（最底层接口） |
| `Session` | 类型化门面：`assertJsonSerializable` 严格校验 + UUIDv7 id + `view(lane)` 返回 `SessionTree` |
| `SessionRepo` | create/open/list/delete/fork |
| **Entry 树** | message / model_change / thinking_level_change / active_tools_change / compaction / branch_summary / custom；`parentId` 链成树；**lane 是命名游标**（默认 `main`，可对应 Slack 线程/子代理） |
| **LaneRecord 操作日志** | operation_started / step_attempt / tool_started / queue_enqueued / usage 等，供崩溃恢复 |

- 实现：`memory.ts`（内存版，`SessionState.applyMutation` 严格 seq 单调校验）、`jsonl/`（v4 逐行 JSON，temp 文件 + 原子 rename，按 cwd 编码目录，兼容 v3）；SQLite 后端在独立包 `@earendil-works/pi-session-backend-sqlite-node`。
- `testing/conformance.ts`：所有后端共用的同一套一致性用例（经 `./session/testing` 子导出）。
- `context.ts` 的 `buildSessionContext` 做**上下文投影**：从 leaf 向根扫到最近 compaction 截止，取 summary + retainedTail + 其后消息；丢弃 error/aborted/deferred 的 assistant；custom entry 经 projector 注入。

### 4.4 Compaction（上下文压缩）

- 触发：`shouldCompact` — `contextTokens > contextWindow - reserveTokens`（默认 reserve 16384 / keepRecent 20000）。
- 切点：`findCutPoint` 从尾部累计 `keepRecentTokens`，只在合法边界切（可识别 split-turn）。
- 执行：`compact()` 用独立的 `completeSimple` 请求（`cacheRetention:"none"`）生成/增量更新结构化总结（Goal/Progress/Next Steps），附 readFiles/modifiedFiles 清单；结果存为 `CompactionEntry`（含 `retainedTail`，后续读取永不越过它）。
- `branch-summarization.ts` 负责分支导航时的总结。

### 4.5 AgentHarness 的增值

相对 `Agent`（进程内、单对话、无持久化），harness 提供：耐久 Entry 树会话 + 多 lane、操作状态机（run/compaction/navigation + 崩溃恢复：reducer 从 record 日志重建 LaneState，可检测 12 种记录损坏）、工具/技能/模板注册表、11 种 hooks（before_run/before_tool 等）、Usage 台账、遥测。

> ⚠️ 注意：当前版本的 `AgentHarness` 执行方法（prompt/compact 等）返回 `HarnessNotImplemented` 脚手架，完整实现遵循 `docs/harness.md` 的「三存储 + 操作状态机」规范（含 crash 恢复语义 effect sandwich、`replay: "never"|"safe"`）。

## 5. 对外 API（index.ts / node.ts）

- `Agent`、`agentLoop`/`agentLoopContinue`（低层无状态循环）
- 全部 harness 构建块：session 体系、compaction 函数、4 个工具工厂、skills/telemetry/搜索
- `streamProxy`、`setDefaultStreamFn` 及大量类型
- `./node` 子导出追加 `NodeExecutionEnv`；`./session/testing` 导出 conformance 套件

典型用法：

```typescript
const agent = new Agent({
  initialState: { systemPrompt: "...", model },
  streamFn: models.streamSimple.bind(models),
});
agent.subscribe((event) => { /* 处理 AgentEvent 流 */ });
await agent.prompt("Hello!");
```

## 6. 架构图（模块依赖）

```
                       ┌────────────────────────────┐
                       │      pi-ai（LLM 统一接口）    │
                       │  providers/Models/streamSimple │
                       └─────────────▲──────────────┘
                                     │ StreamFn（依赖注入）
┌────────────────────────────────────┴───────────────────────────────┐
│                      pi-agent-core                                 │
│                                                                    │
│  Agent ──▶ agent-loop ──▶ streamFn ──▶ LLM                         │
│    │           │                                                   │
│    │           ├── executeToolCalls ──▶ AgentTool（typebox schema）  │
│    │           └── AgentEvent 流 ──▶ subscribe() 订阅者              │
│    │                                                                │
│  AgentHarness（宿主）                                                │
│    ├── Session（Entry 树 + Record 日志）──▶ SessionStorage           │
│    │        │                    ├── memory（InMemory）             │
│    │        │                    └── jsonl/（原子写、v3/v4 兼容）      │
│    │        ├── buildSessionContext（上下文投影）                      │
│    │        └── reducer（record → LaneState，崩溃恢复）               │
│    ├── Compaction（shouldCompact → findCutPoint → compact）          │
│    ├── Skills / PromptTemplates / SystemPrompt                      │
│    ├── Telemetry（span + schema）                                    │
│    └── ExecutionEnv（FileSystem+Shell 能力接口）◀── NodeExecutionEnv  │
└────────────────────────────────────────────────────────────────────┘
```
