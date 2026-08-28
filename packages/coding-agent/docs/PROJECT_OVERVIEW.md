# packages/coding-agent 项目概览

> 本文档由 code-annotator 生成于 2026-08-27，配合中文注释源码阅读。
> 配套文档：[LEARNING_GUIDE.md](./LEARNING_GUIDE.md)（学习路径）｜[FILES.md](./FILES.md)（文件清单）｜[ANNOTATION_PLAN.md](./ANNOTATION_PLAN.md)（注释进度）

## 1. 项目定位

**@earendil-works/pi-coding-agent**（可执行命令 `pi`，version 0.84.3）是 monorepo `@earendil-works/pi` 中最顶层的应用包：一个**终端 AI 编码助手 CLI**（同类产品：Claude Code / Codex CLI），自述为 "minimal terminal coding harness"。

核心理念：**内核极小 + 扩展优先**。默认只给模型 4 个工具（read / bash / edit / write），刻意不内置 sub-agents、plan mode 等功能，而是通过 TypeScript Extensions（约 35 种事件钩子）、Skills、Prompt Templates、Themes 与 Pi Packages（npm/git 分发）实现一切扩展。

## 2. 包间依赖关系

```
pi-tui（终端 UI 组件库）        pi-ai（多厂商 LLM SDK：模型目录、流式、认证）
        ↑                              ↑
        │                              │（streamSimple / Models / Provider）
pi-agent-core（Agent 循环，provider 无关）←── sdk.ts: setDefaultStreamFn(streamSimple) 桥接
        ↑                              ↑
        └────────── coding-agent ──────┘   ← 本包（应用层，依赖最多）
                     ↑        ↑
        pi-client + pi-protocol（远程会话，仅 src/client/ 使用）
```

- 调用方向：**coding-agent → pi-agent-core + pi-ai + pi-tui**。
- 关键解耦：pi-agent-core 不依赖 pi-ai；`src/core/sdk.ts` 通过 `setDefaultStreamFn()` 把 pi-ai 的流式函数注入 agent core。
- monorepo 中另有 server / client / protocol / evals / telemetry / session-backends 等包；本包经 `src/server/create-harness.ts` 与 `src/client/` 与之协作。

**双入口**：
- `bin: pi` → `dist/bundle/cli.js`（源 `src/cli.ts`）
- SDK：`main/exports` → `src/index.ts`；子导出 `./rpc-entry`、`./client`

## 3. 目录结构

| 路径 | 职责 |
|---|---|
| `src/cli.ts` | bin 入口 shim（注意与 `src/cli/` 目录是两回事）：设进程标题、配 undici，调 `main()` |
| `src/main.ts` | **CLI 总编排**（976 行）：参数解析 → session/trust/模型解析 → 三种模式分发 |
| `src/index.ts` | SDK 公共 API 导出（session 管理、extension 类型、tool 工厂、compaction、UI 组件等） |
| `src/config.ts` | 路径体系（`.pi`、`~/.pi/agent`）、安装方式检测、fork/品牌化 |
| `src/migrations.ts` | 配置/认证数据的版本迁移与弃用警告 |
| `src/package-manager-cli.ts` | `pi install/remove/list/update/config` 包管理子命令 |
| `src/cli/` | CLI 层辅助：args（参数解析）、auth-*（`pi auth`）、startup-ui（首启向导）、file-processor（`@file`）等 |
| `src/core/` | **无 I/O 的核心域层**：AgentSession、SessionManager、ModelRuntime、ResourceLoader、SettingsManager、extension 系统、tools、compaction |
| `src/core/extensions/` | Extension 内核：types（契约）、loader（发现+jiti 加载）、runner（事件分发） |
| `src/core/tools/` | 内置工具：read/write/edit/bash/grep/find/ls/powershell + diff、截断、文件变更队列 |
| `src/core/compaction/` | 上下文压缩与分支摘要 |
| `src/core/export-html/` | 会话导出 HTML |
| `src/modes/` | 三种运行模式的 I/O 层：`interactive/`（TUI）、`rpc/`、`print-mode.ts`、`json-event.ts` |
| `src/modes/interactive/components/` | ~45 个 TUI 组件（footer、各选择器、diff、extension editor 等） |
| `src/modes/interactive/theme/` | JSON 主题 + 热加载 watcher |
| `src/extensions/` | 内置 extension（目前仅 hidden 的 llama.cpp 扩展） |
| `src/utils/` | 通用工具：路径、shell、剪贴板、图片处理（photon WASM + worker）、git、语法高亮 |
| `src/client/` | 远程会话客户端（RemoteSession + transcript 状态机），基于 pi-client/pi-protocol |
| `src/server/` | create-harness：把工具与系统提示词组装成 pi-agent-core 的 AgentHarness 供 server 包托管 |
| `src/bun/` | Bun 编译单文件二进制的入口与运行时适配 |

## 4. 核心数据流（CLI 启动主链路）

```
pi (bin)
 └─ src/cli.ts ──► src/main.ts: main(args)
     ├─ 1. parseArgs                    cli/args.ts（未知 flag 收集转发给 extension）
     ├─ 2. SettingsManager 引导         core/settings-manager.ts（全局 ~/.pi/agent + 项目 .pi）
     ├─ 3. createSessionManager         core/session-manager.ts（--fork / --resume / -c / 新建）
     ├─ 4. createRuntime 工厂（闭包捕获 CLI 参数）
     │     ├─ 项目信任解析               core/trust-manager.ts（先加载 extensions 再决定信任）
     │     ├─ createAgentSessionServices core/agent-session-services.ts
     │     │     ├─ ModelRuntime         core/model-runtime.ts（封装 pi-ai Models/认证）
     │     │     └─ ResourceLoader.reload()  core/resource-loader.ts（extensions/skills/prompts/themes）
     │     ├─ 模型解析                   core/model-resolver.ts（--provider/--model、glob --models）
     │     └─ createAgentSession        core/sdk.ts（new Agent + streamFn 注入 + 工具集）
     ├─ 5. AgentSessionRuntime          core/agent-session-runtime.ts（session + cwd 绑定 services）
     ├─ 6. 初始消息/图片                 cli/initial-message.ts + file-processor.ts（@file、stdin）
     └─ 7. 按模式分发
           ├─ interactive → InteractiveMode.run()   modes/interactive/interactive-mode.ts
           ├─ rpc         → runRpcMode()            modes/rpc/rpc-mode.ts
           └─ print/json  → runPrintMode()          modes/print-mode.ts
```

agent 循环内：`Agent`（pi-agent-core）经 sdk.ts 注入的 `streamFn` 调 `ModelRuntime.streamSimple`（pi-ai），`transformContext`/`onPayload`/`transformHeaders` 三钩子把 ExtensionRunner 接入请求全链路。TUI 侧 `InteractiveMode` 订阅 `AgentSessionEvent` 驱动 pi-tui 组件更新。

**核心结论：`AgentSession` 是唯一被三种模式共享的核心，模式只是 I/O 适配层。**

## 5. 四种运行模式

| 模式 | 触发方式 | 入口 | I/O | 用途 |
|---|---|---|---|---|
| Interactive TUI | 默认（TTY 且无 `-p`） | `InteractiveMode.run()` | 全屏 TUI：编辑器、消息流、footer、slash 命令、Ctrl+P 模型切换、`/tree` | 日常人工交互 |
| Print / JSON | `-p`、`--mode json`、非 TTY/管道 | `runPrintMode()` | 单发 prompt → 文本或 JSON 事件流 | 脚本化、CI、管道 |
| RPC | `--mode rpc` | `runRpcMode()` | stdin JSONL 命令 / stdout JSONL 事件，长驻 | 进程集成（IDE、Web UI）；配 `RpcClient` |
| SDK | `import { createAgentSession }` | `src/index.ts` | 库调用 | 嵌入宿主应用 |

模式判定在 `main.ts` 的 `resolveAppMode()`；管道 stdin 会把 interactive 降级为 print；非 interactive 模式统一 `takeOverStdout()`（output-guard）保证 JSON 流纯净。

## 6. 核心模块速查（按重要性）

**入口与编排**：`main.ts`（总编排）、`cli/args.ts`（参数契约）、`config.ts`（路径体系）、`core/sdk.ts`（SDK 主工厂）

**会话域**：`core/agent-session.ts`（3478 行，全模式共享会话核心）、`core/session-manager.ts`（JSONL 追加树持久化）、`core/agent-session-runtime.ts`（runtime 可重建）、`core/agent-session-services.ts`（按 cwd 组装服务）

**模型与配置**：`core/model-runtime.ts`、`core/model-resolver.ts`、`core/settings-manager.ts`（全局/项目分层设置）、`core/resource-loader.ts`（资源发现加载）、`core/trust-manager.ts`（项目信任）

**扩展与工具**：`core/extensions/types.ts`（1769 行，API 契约）、`core/extensions/runner.ts`（事件分发）、`core/tools/index.ts`（工具工厂）、`core/system-prompt.ts`（提示词组装）

**运行模式**：`modes/interactive/interactive-mode.ts`（6548 行，全包最大，UI 编排）、`modes/rpc/rpc-mode.ts`、`modes/print-mode.ts`

## 7. 值得重点理解的架构特点

1. **分层极清晰**：pi-ai（厂商抽象）→ pi-agent-core（agent 循环）→ coding-agent core（无 I/O 域层）→ modes（纯 I/O 适配）。
2. **Extension 是第一公民**：约 35 种事件钩子覆盖全生命周期，可注册 tool/command/flag/provider，甚至接管编辑器、注入 UI；jiti 加载 TS 源文件，可来自本地/npm/git。
3. **会话 = 追加式 JSONL 树**：entry 带 id/parentId，leaf 指针定位当前；分支/树导航不改写历史；`buildSessionContext()` 沿 root→leaf 解析 LLM 上下文（格式见 docs/session-format.md）。
4. **Settings 分层 + 项目信任**：全局 vs 项目两层均可声明资源；未信任项目不自动执行项目级 extension 代码（安全边界）。
5. **Runtime 可重建性**：`AgentSessionRuntime` + cwd 绑定 services —— 切换跨项目 session 或 `/reload` 时整套服务按新 cwd 重建。
6. **工具可注入**：工具分离 definition 与 Operations，SDK 与 server 包的 AgentHarness 复用同一套工具与提示词构建；file-mutation-queue 保证编辑串行安全。
7. **多形态分发**：npm 双构建（unbundled + bundle、shrinkwrap）、Bun 单文件二进制（含 WASM）、自更新与安装管理。
8. **启动性能可观测**：`core/timings.ts` 贯穿启动链路计时（`PI_STARTUP_BENCHMARK`）。
