# 学习指南：如何读懂 pi-agent-core

> 面向第一次接触本包的开发者。建议配合 [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md)（先读它建立全局图景）与源码中的中文注释。
> 每个阶段的文件都已按依赖顺序排列——前面的概念会在后面反复用到。

## 0. 前置知识

- TypeScript（interface / 泛型 / 声明合并 declaration merging / `satisfies`）
- AsyncIterator 与异步流（`for await ... of`）：整个框架建立在事件流之上
- LLM API 基本概念：message / tool call / toolResult / 流式输出 / token

## 1. 关键概念速查

| 概念 | 一句话解释 | 定义位置 |
|------|-----------|----------|
| **StreamFn** | 注入的「调 LLM」函数，本包不关心背后是哪个 provider | `src/types.ts` |
| **AgentMessage** | Agent 层消息 = LLM 标准消息 ∪ 自定义消息（声明合并扩展） | `src/types.ts` |
| **AgentState** | 循环的全部状态：systemPrompt/model/tools/messages/… | `src/types.ts` |
| **AgentEvent** | 9 种事件，外部观察 Agent 的唯一途径 | `src/types.ts` |
| **turn（轮）** | 一次「LLM 响应 + 工具执行」的完整周期 | `agent-loop.ts` |
| **steering / followUp** | 两种人机插话队列：steering 当轮插队生效，followUp 下一轮生效 | `agent.ts` |
| **ExecutionEnv** | 能力接口 = FileSystem + Shell，工具只依赖它而非直接用 node:fs | `harness/types.ts` |
| **Entry 树** | 会话持久化的主体：消息/变更等按 `parentId` 组成树 | `session/types.ts` |
| **lane（泳道）** | Entry 树上的命名游标（默认 `main`），对应一条对话线/子代理 | `session/types.ts` |
| **LaneRecord** | 操作日志（started/attempt/enqueued/usage…），崩溃恢复的依据 | `session/types.ts` |
| **compaction** | 上下文超限时把旧对话压缩成结构化总结 | `compaction/compaction.ts` |
| **上下文投影** | `buildSessionContext`：从 Entry 树切出真正发给 LLM 的消息序列 | `session/context.ts` |
| **reducer** | 把 record 日志切片规约回 LaneState（恢复 + 12 种损坏检测） | `harness/reducer.ts` |
| **Result&lt;T,E&gt;** | harness 层的显式错误返回风格（不靠 throw） | `harness/types.ts` |

## 2. 推荐阅读路径（12 步）

### 阶段一：核心引擎（src 顶层）—— 最稳定、必读

1. **`src/types.ts`** — 全部词汇表。先通读一遍，后面的文件都在用这些词。
2. **`src/agent.ts`** — `Agent` 类：状态持有、`PendingMessageQueue` 双队列、事件分发、生命周期（`runWithLifecycle`）。
3. **`src/agent-loop.ts`** — 循环引擎，本包心脏。对照 README 的事件序列图读 `runAgentLoop`：流式接收 → 工具调度 → 轮次收尾 → steering/followUp 轮询。
4. 顺带扫一眼 `src/stream-fn.ts`（全局默认 streamFn）与 `src/index.ts`（看导出了什么，建立 API 全貌）。

### 阶段二：harness 构建块 —— 能力模型与工具

5. **`src/harness/types.ts`** — `Result<T,E>`、`ExecutionEnv` 能力模型、各类错误。
6. **`src/harness/messages.ts`** — 声明合并注册 4 种自定义消息 + harness 版 `convertToLlm`（理解「UI 消息如何被过滤掉不发给 LLM」）。
7. **`src/harness/env/nodejs.ts`** — 能力接口的 Node 实现（文件解析、超时、流式 stdout）。
8. **`src/harness/tools/`**（建议顺序 write → read → bash → edit → edit-diff → file-mutation-queue）— 工具范式：typebox schema + execute + executionMode。

### 阶段三：会话内核 —— 最核心的耐久层

9. **`src/harness/session/types.ts`** — Entry/Record/存储三层接口。
10. **`src/harness/session/session.ts` + `state.ts` + `memory.ts`** — Session 门面、状态变更、内存实现（`applyMutation` 的 seq 单调校验）。
11. **`src/harness/session/context.ts`** — 上下文投影：Entry 树 → 发给 LLM 的消息序列。
12. **`src/harness/session/jsonl/`** — 落地细节：v4 逐行 JSON、temp + 原子 rename、v3 兼容。

### 阶段四（进阶）：压缩、恢复与全景

- **`src/harness/compaction/compaction.ts`** — 压缩算法全流程（触发 → 切点 → 总结）。
- **`src/harness/reducer.ts` + `agent-harness.ts` + 英文 `docs/harness.md`** — 耐久层全景：操作状态机、崩溃恢复语义（effect sandwich、`replay: "never"|"safe"`）。
- 扩展阅读：`search/scanning.ts`（会话搜索）、`skills.ts`（SKILL.md 加载）、`telemetry.ts`（schema 与 span）、`proxy.ts`（浏览器代理流）。

## 3. 上手做点什么（练习建议）

1. **跑通最小 Agent**：仿照 README，`new Agent({ initialState, streamFn })` + `subscribe` 打印事件 + `prompt("hi")`，观察 9 种 AgentEvent 的出现顺序。
2. **写一个自定义工具**：用 typebox 定义 schema，实现 `execute`，注册进 `initialState.tools`，让模型调用它。体会 `beforeToolCall`/`afterToolCall` 钩子。
3. **玩一次压缩**：把 `contextWindow` 临时调小，制造超限，观察 `shouldCompact → findCutPoint → compact` 全链路与 `CompactionEntry` 的结构。
4. **实现一个 SessionStorage**：实现 `SessionStorage` 接口，然后跑 `./session/testing` 的 conformance 套件验证你的实现（这正是该套件的用途）。

## 4. 阅读时的三个「为什么」

带着这三个问题读，能抓住设计动机：

1. **为什么 LLM 调用是注入的 StreamFn 而不是直接 import？** —— 核心包零 provider 依赖，可测试、可换模型、浏览器可走 `streamProxy`。
2. **为什么工具只依赖 `ExecutionEnv` 而不是直接用 node:fs？** —— 环境可替换（测试可用内存 FS），工具逻辑与环境解耦。
3. **为什么持久化分 Entry 树 + Record 日志两层？** —— Entry 是「内容真相」，Record 是「操作历史」；崩溃后靠重放 Record 恢复状态，且能检测出 12 种损坏。
