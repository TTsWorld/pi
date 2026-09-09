# 项目架构总览 — pi monorepo（commit `f064ea0e1`）

> 对应 upstream 第 38 次提交：`feat(ai): Create unified AI package with OpenAI, Anthropic, and Gemini support`（2025-08-17）。
> 本文档描述的是该时点的代码状态，后续版本会有较大演进。

## 1. 项目简介

pi 是一个 TypeScript monorepo，目标是构建一套**终端 AI coding agent** 及其配套基础设施：

- 自研终端 UI 框架（差分渲染）
- 通用 AI agent 运行时（工具调用 + 会话持久化）
- 远程 GPU pod 上的 vLLM 模型部署管理
- **本提交新增**：统一 OpenAI / Anthropic / Gemini 三家 API 的 `ai` 包（此刻为「调研完成、代码为零」的占位状态）

## 2. 技术栈

| 项 | 选择 |
|---|---|
| 语言/运行时 | TypeScript 5.9 strict，ESM，Node >= 20，无 bundler（`tsc` 直出，开发用 tsx 直跑源码） |
| 包管理 | npm workspaces（`packages/*`），四包锁步版本号（当前 0.5.8） |
| Lint/Format | Biome 2.1（tab 缩进宽 3、行宽 120） |
| 测试 | Node 内置 `node --test --import tsx`，无 vitest；tui 用 @xterm/headless 虚拟终端做渲染回归 |
| Git hooks | husky pre-commit 跑 `npm run check` |
| 核心依赖 | chalk、marked、glob、mime-types、openai SDK（还直接被 agent 当兼容 HTTP 客户端用） |

## 3. 目录结构与包依赖

```
pi.38/
├── packages/
│   ├── tui/    @mariozechner/pi-tui   终端 UI 框架（零内部依赖，最底层）
│   ├── ai/     @mariozechner/ai       统一 AI 包【本提交新增，占位】
│   ├── agent/  @mariozechner/pi-agent AI coding agent（依赖 pi-tui）
│   └── pods/   @mariozechner/pi       远程 GPU pod 管理 CLI（依赖 pi-agent）
├── scripts/sync-versions.js           各包版本锁步同步
└── docs/                              本注释工程文档
```

依赖链（自底向上）：`tui → ai → agent → pods`（root `build` 脚本即按此拓扑序硬编码）。
注意：目录名 `pods` 的 npm 包名就叫 `@mariozechner/pi`；`ai` 包此时还没有被任何包依赖。

**TypeScript 双配置**：根 `tsconfig.json` 用 `paths` 映射到各包 `src/index.ts`，配合 tsx 免构建类型检查；各包 `tsconfig.build.json` 产出 `dist/` 发布。

## 4. 核心模块详解

### 4.1 packages/tui — 差分渲染 TUI 框架

分层：`terminal.ts`（终端 I/O 抽象）→ `tui.ts`（组件模型 + 渲染引擎）→ `components/*`（具体组件）→ `autocomplete.ts`（补全）。

- **Terminal 接口**（`terminal.ts`）：`start/stop/write/columns/rows` 五方法；`ProcessTerminal` 封装 `process.stdin/stdout` 与 raw mode。可注入（测试用虚拟终端模拟）。
- **TUI 渲染引擎**（`tui.ts`）：三层差分渲染策略——
  1. **Surgical**：逐行对比只重写变化行（典型更新仅 1-2 行）
  2. **Partial**：结构变化大时从首个变化行清屏尾重绘
  3. **Full**：变化落入 scrollback 时整屏重绘
  - 焦点路由：全局键（Esc/Ctrl+C）→ 焦点组件；`requestRender()` 经 `process.nextTick` 合并重绘请求
- **组件**：`TextEditor`（714 行多行编辑器，边框 + 反显光标 + 内嵌补全弹出）、`MarkdownComponent`（marked 解析 + chalk 样式 + ANSI 感知换行）、`SelectList`、`TextComponent`、`WhitespaceComponent`、`LoadingAnimation`
- **autocomplete.ts**：slash 命令 + 文件路径组合补全

### 4.2 packages/agent — AI coding agent

- **AgentEvent 事件总线**（`agent.ts`）：`session_start / assistant_start / reasoning / tool_call / tool_result / assistant_message / error / user_message / interrupted / token_usage` 判别联合——同时驱动渲染、持久化与恢复，是全局骨架。
- **Agent 主循环 `ask()`**：按 `config.api` 分派到 OpenAI Responses API 或 Chat Completions 两个同构 while 循环：遇到 `function_call` 就执行工具、把结果追加进 messages 继续，直到出现纯文本回复。
- **Provider 方言层**：`detectProvider` / `adjustRequestForProvider` / `parseReasoningFromMessage`（约 170 行）处理 Gemini/Groq/OpenRouter/Anthropic 的参数与思维链差异——**这正是新增 ai 包要消灭的对象**。
- **SessionManager**：JSONL 追加写入 `~/.pi/sessions/<cwd编码路径>/`，`-c` 重放最近会话恢复上下文。
- **tools.ts**：5 个内置工具 `read / list / bash / glob / rg`，支持 AbortSignal 中断、1MB 输出截断。
- **三种渲染器**：`TuiRenderer`（交互模式五层布局）、`ConsoleRenderer`（单发/管道）、`JsonRenderer`（JSONL 供程序化消费）。

### 4.3 packages/ai — 统一 AI 包【本提交的主角】

此刻 `src/index.ts` 仅 5 行（导出版本号）。本提交的实际内容是**调研与设计**：

- 装齐三个官方 SDK：openai / @anthropic-ai/sdk / @google/genai
- 三份 API 调研笔记（`openai-api.md` 2320 行、`anthropic-api.md` 1706 行、`gemini-api.md` 1233 行）
- `plan.md`（950 行）设计蓝图：统一 `class AI` + `async *stream()` 流式优先、统一 Message/Request/Event 格式、三个 Provider Adapter、models.dev 模型能力与成本追踪

**历史意义**：这是「文档先行」架构演进的典型样本——6200+ 行调研文档是蓝图，agent.ts 里的方言代码是被革命的对象。

### 4.4 packages/pods — 远程 GPU pod 管理

- **cli.ts**：顶层 `pi` 命令（`pods setup/active/remove/list`、`shell/ssh/start/stop/list/logs/agent`）
- **ssh.ts**：对系统 `ssh/scp` 二进制的 spawn 封装（零 SSH 库依赖）
- **commands/pods.ts**：pod 初始化（上传脚本 → 装 vLLM → `nvidia-smi` 解析 GPU → 写配置）
- **commands/models.ts**（753 行）：按 GPU 数量/型号匹配最优配置选卡、分配端口、`setsid` 后台启动 vLLM、日志监控直到就绪或 OOM、失败自动回滚
- **commands/prompt.ts**：连接 pods 与 agent 的桥梁——从 pod 配置推出 base URL，注入 system prompt，直接复用 `agentMain()`

## 5. 数据流（交互模式完整链路）

以 `pi agent my-model` 为例：

1. `pods/cli.ts` → `prompt.ts` 组装 `--base-url http://host:8001/v1` → `agent/main.ts main()`
2. `main()` 创建 SessionManager + TuiRenderer，TUI 五层布局（header/chat/status/editor/token）进入 raw mode
3. 用户键入：ProcessTerminal → TUI 全局键检查 → 焦点组件 TextEditor → 回车 resolve `getUserInput()` 的 Promise
4. `agent.ask()`：发 `user_message` 事件（扇出给渲染器 + 落盘）→ 经方言适配请求 LLM → 流式循环逐事件发出
5. `tool_call` → `executeTool`（read/bash/glob/rg）→ `tool_result` 追加回 messages → 继续循环
6. 每个事件 → TuiRenderer 往 chatContainer 加组件 → 差分渲染（通常只重绘 1-2 行）
7. Esc 中断 → `agent.interrupt()` → AbortController → `interrupted` 事件；全部事件同步追加 JSONL，`--continue` 重放恢复

## 6. 架构亮点（学习时重点关注）

1. **事件总线解耦**：LLM 调用层完全不知道前端是什么——一次 ask，多处消费（三渲染器 + 持久化 + 恢复）。
2. **差分渲染**：三层策略把终端重绘开销压到最低，并内置重绘行数性能指标。
3. **零依赖 SSH**：直接 spawn 系统 ssh/scp，避免引入庞大的 SSH 库。
4. **文档先行的包设计**：ai 包先写 6200 行调研再写代码。
