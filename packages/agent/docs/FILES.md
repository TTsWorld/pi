# 源代码文件清单（待注释）

> 目标包：`@earendil-works/pi-agent-core`（`packages/agent`）
> 扫描范围：`src/` 下全部 TypeScript 源文件
> 已排除：`test/`、`node_modules/`、配置文件（*.json/*.config.*）、文档（*.md）、脚本

共 **50** 个文件，**12,635** 行代码。

## src/ 顶层（核心 Agent）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 1 | `src/index.ts` | 145 | 包入口，对外导出 |
| 2 | `src/types.ts` | 443 | 核心类型定义（AgentState/AgentTool/事件等） |
| 3 | `src/agent.ts` | 592 | Agent 类：有状态代理的对外门面 |
| 4 | `src/agent-loop.ts` | 796 | Agent 循环：流式调用 LLM + 工具执行的核心循环 |
| 5 | `src/stream-fn.ts` | 20 | 默认 streamFn 适配 |
| 6 | `src/node.ts` | 2 | Node.js 环境入口 |
| 7 | `src/proxy.ts` | 370 | Agent 代理/拦截层 |

## src/search/（代码搜索）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 8 | `src/search/index.ts` | 32 | search 模块导出 |
| 9 | `src/search/scanning.ts` | 176 | 目录扫描实现 |

## src/harness/（Agent Harness 宿主框架）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 10 | `src/harness/agent-harness.ts` | 508 | AgentHarness：组装 Agent + 工具 + 会话的宿主 |
| 11 | `src/harness/types.ts` | 315 | harness 层类型定义 |
| 12 | `src/harness/events.ts` | 102 | harness 事件定义 |
| 13 | `src/harness/messages.ts` | 168 | 消息构造辅助 |
| 14 | `src/harness/prompt-templates.ts` | 262 | 提示词模板 |
| 15 | `src/harness/system-prompt.ts` | 34 | 系统提示词组装 |
| 16 | `src/harness/reducer.ts` | 667 | 状态 reducer：事件 → 状态更新 |
| 17 | `src/harness/result.ts` | 63 | 结果类型 |
| 18 | `src/harness/skills.ts` | 386 | 技能（skills）加载与管理 |
| 19 | `src/harness/telemetry.ts` | 615 | 遥测数据上报 |
| 20 | `src/harness/env/nodejs.ts` | 695 | Node.js 环境适配（文件系统/子进程等） |

## src/harness/session/（会话与持久化）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 21 | `src/harness/session/types.ts` | 393 | 会话层类型（SessionStore 接口等） |
| 22 | `src/harness/session/session.ts` | 299 | Session 门面 |
| 23 | `src/harness/session/state.ts` | 344 | 会话状态（含工作树/分支） |
| 24 | `src/harness/session/context.ts` | 100 | 会话上下文 |
| 25 | `src/harness/session/memory.ts` | 192 | 内存版 SessionStore |
| 26 | `src/harness/session/index.ts` | 13 | session 模块导出 |
| 27 | `src/harness/session/jsonl.ts` | 9 | jsonl 后端转发入口 |
| 28 | `src/harness/session/jsonl/types.ts` | 57 | jsonl 后端类型 |
| 29 | `src/harness/session/jsonl/codec.ts` | 240 | jsonl 编解码 |
| 30 | `src/harness/session/jsonl/repo.ts` | 247 | jsonl 仓库层 |
| 31 | `src/harness/session/jsonl/storage.ts` | 277 | jsonl 存储实现 |
| 32 | `src/harness/session/jsonl/errors.ts` | 27 | jsonl 错误类型 |
| 33 | `src/harness/session/testing/types.ts` | 16 | 会话一致性测试类型 |
| 34 | `src/harness/session/testing/index.ts` | 6 | testing 模块导出 |
| 35 | `src/harness/session/testing/conformance.ts` | 1016 | SessionStore 一致性测试套件 |

## src/harness/compaction/（上下文压缩）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 36 | `src/harness/compaction/compaction.ts` | 848 | 压缩主逻辑 |
| 37 | `src/harness/compaction/branch-summarization.ts` | 280 | 分支摘要 |
| 38 | `src/harness/compaction/utils.ts` | 132 | 压缩工具函数 |

## src/harness/tools/（内置工具）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 39 | `src/harness/tools/index.ts` | 23 | 工具模块导出 |
| 40 | `src/harness/tools/tool-context.ts` | 6 | 工具上下文转发 |
| 41 | `src/harness/tools/bash.ts` | 161 | bash 工具 |
| 42 | `src/harness/tools/read.ts` | 144 | read 工具 |
| 43 | `src/harness/tools/write.ts` | 39 | write 工具 |
| 44 | `src/harness/tools/edit.ts` | 140 | edit 工具 |
| 45 | `src/harness/tools/edit-diff.ts` | 500 | edit 工具的 diff 算法 |
| 46 | `src/harness/tools/image.ts` | 104 | image 工具 |
| 47 | `src/harness/tools/file-mutation-queue.ts` | 56 | 文件变更串行队列 |
| 48 | `src/harness/tools/path-utils.ts` | 30 | 路径工具函数 |

## src/harness/utils/（通用工具）

| # | 文件路径 | 行数 | 说明 |
|---|----------|------|------|
| 49 | `src/harness/utils/shell-output.ts` | 195 | shell 输出处理 |
| 50 | `src/harness/utils/truncate.ts` | 350 | 输出截断 |
