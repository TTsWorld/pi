# 学习指南 — pi monorepo（commit `e5aedfed2`）

> 面向不熟悉本项目的读者。建议按下面顺序阅读，先理解「事件驱动」这一全局骨架，再逐包深入。

## 0. 前置知识

- TypeScript（strict、ESM）、Node >= 20
- 终端基础：ANSI 转义序列、raw mode
- LLM API 基础：messages、tool/function calling、流式输出

## 1. 推荐学习顺序

### 第一阶段：终端 UI 框架（packages/tui，最底层、零内部依赖）

1. **`src/terminal.ts`**（122 行）— 先看最小的抽象层：`Terminal` 接口 5 个方法，理解「I/O 可注入」为测试带来的好处
2. **`src/tui.ts`** — 核心中的核心。重点理解：
   - `Component` / `Container` / `TUI` 的组件模型
   - **三层差分渲染**（Surgical / Partial / Full）——为什么终端重绘要这么讲究
   - 焦点路由与全局按键的关系
3. **`src/components/text-component.ts` → `select-list.ts` → `text-editor.ts`** — 由简到繁看组件如何实现 `render(width)` 与 `handleInput`；TextEditor（714 行）是集大成者
4. **`src/components/markdown-component.ts`** — 重点看 `wrapLine` 的 **ANSI 感知换行**（换行时正确关闭/重启颜色码）
5. **`src/autocomplete.ts`** — slash 命令 + 文件路径组合补全

### 第二阶段：AI agent 运行时（packages/agent）

1. **`src/agent.ts` 的 `AgentEvent` 判别联合**（文件开头 20 行）— 全项目最重要的 20 行，所有渲染、持久化、恢复都围绕它
2. **`Agent.ask()` 主循环** — 看 Responses API 与 Chat Completions 两个同构 while 循环如何处理 `function_call` → 执行工具 → 回填结果 → 继续
3. **Provider 方言层**（`detectProvider` 等，agent.ts:48-174）— 理解多厂商兼容的脏活，以及为什么需要 ai 包
4. **`session-manager.ts`** — JSONL 事件日志 + 重放恢复
5. **`tools/tools.ts`** — 5 个内置工具与中断处理
6. **`renderers/` 三个渲染器** — 同一事件流的三种消费方式（TUI / console / JSONL）
7. **`main.ts` + `args.ts`** — 三种运行模式如何串起来

### 第三阶段：本提交的主角（packages/ai）

1. **`src/types.ts`**（105 行）— 统一类型体系全貌。逐个理解 `Message / Content / Request / Event / TokenUsage / ToolCall / StopReason`，注意 `Event` 判别联合与 agent 包 `AgentEvent` 的同构关系
2. **`src/providers/anthropic.ts`**（246 行）— 第一个 provider 实现。重点看两个方向的转换：统一 Request → Anthropic content blocks（system prompt 独立传参）；流式 delta → 统一 Event 流的映射与结束条件
3. **`test/examples/anthropic.ts`**（63 行）— 真实 API 调用的手写示例，理解统一 API 的使用手感
4. **`packages/ai/plan.md`**（950 行设计蓝图）与三份 API 调研笔记 — 可跳读，对照实现看蓝图如何落地

> 💡 学习要点：#38 是「文档先行」，本提交开始「实现落地」。对比 `anthropic.ts` 的转换逻辑与 `agent.ts` 里 170 行 provider 方言代码（detectProvider / adjustRequestForProvider / parseReasoningFromMessage），体会统一抽象如何消灭方言。

### 第四阶段：远程 GPU pod 管理（packages/pods，可选）

1. **`types.ts` + `config.ts`** — 数据结构与 `~/.pi/pods.json`
2. **`ssh.ts`** — 零依赖 spawn 系统 ssh/scp 的封装思路
3. **`commands/models.ts`**（753 行）— GPU 选卡、端口分配、后台启动、日志监控就绪/失败回滚的完整编排
4. **`commands/prompt.ts`** — pods 与 agent 的桥梁（85 行，小而关键）

## 2. 关键概念速查

| 概念 | 一句话解释 | 定义位置 |
|---|---|---|
| AgentEvent | agent 发出的判别联合事件，贯穿渲染/持久化/恢复 | `agent/src/agent.ts:6` |
| AgentEventReceiver | 单方法 `on(event)` 接口，渲染器和会话管理器都实现它 | `agent/src/agent.ts:26` |
| 差分渲染 | 只重写变化的行，三层策略按变化范围升级 | `tui/src/tui.ts:256` |
| Component | `render(width) → {lines, changed}` + 可选 `handleInput` | `tui/src/tui.ts:15` |
| 焦点路由 | 全局键先检查，再转发给焦点组件 | `tui/src/tui.ts:469` |
| Provider 方言 | 各 LLM 厂商参数/思维链格式差异的适配代码 | `agent/src/agent.ts:48-174` |
| JSONL 会话 | 每行一个事件追加写盘，`--continue` 重放重建上下文 | `agent/src/session-manager.ts` |
| comboReceiver | 把 renderer + sessionManager 包成一个事件扇出器 | `agent/src/agent.ts:529` |

## 3. 上手运行

```bash
npm install
npm run build          # 按 tui → ai → agent → pods 拓扑序构建
npx tsx packages/pods/src/cli.ts --help    # 顶层 pi 命令
npx tsx packages/agent/src/main.ts --help  # agent CLI
npm run check          # biome + 各包类型检查
```

tui 渲染回归测试：`cd packages/tui && node --test --import tsx test/*.test.ts`

## 4. 阅读时的三个「为什么」

1. **为什么 agent 不直接渲染？** —— 事件总线解耦：LLM 层不知道前端是什么，一次 ask 多处消费（三渲染器 + 落盘 + 恢复）。
2. **为什么渲染要分三层策略？** —— 终端写入是真实开销：小改动静用外科手术式逐行重写，大改动才升级到清屏，并内置重绘行数指标验证效果。
3. **为什么有了 openai SDK 还要 ai 包？** —— openai SDK 被当「OpenAI 兼容 HTTP 客户端」用，方言适配散在 agent.ts 里；ai 包要用统一抽象消灭这 170 行脏活。
