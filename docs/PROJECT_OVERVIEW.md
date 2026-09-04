# pi 项目架构总览

> 本文档由 code-annotator 生成，配合源码中的中文注释使用。

## 项目简介

**pi**（仓库根名 `pi-monorepo`，作者 Mario Zechner）是一个用 TypeScript 编写的 **LLM 编码代理工具集 monorepo**。它由三个层层依赖的包组成：

- **pi-tui** — 自带差分渲染引擎的终端 UI 库（零第三方 TUI 框架）
- **pi-agent** — 仿 Claude Code 的极简、可魔改（hackable）通用 Agent，带工具调用与会话持久化
- **pi**（pods 包）— 在远程 GPU Pod 上部署/管理 vLLM 模型，并通过 agent 对话的 CLI

整体定位是"在任何 OpenAI 兼容端点（OpenAI / Anthropic / Groq / OpenRouter / Ollama / 自托管 vLLM）上跑的可魔改编码代理"——agent 内置 `read` / `list` / `bash` / `glob` / `rg` 五个代码导航工具，pods 包为它提供 `pi agent <model>` 的托管入口。

## 技术栈

| 类别 | 选型 | 说明 |
|---|---|---|
| 语言/运行时 | TypeScript 5.9（strict，ESM `"type":"module"`），Node.js ≥ 20 | `tsconfig.base.json`：target/module `esnext`，`moduleResolution: bundler` |
| 包管理 | npm workspaces（`packages/*`） | 根 build 脚本按依赖序构建：tui → agent → pods |
| Lint/Format | Biome 2.x（tab 缩进，行宽 120） | `npm run check` = biome + `tsc --noEmit` |
| 开发运行 | tsx（免构建直跑 `src/cli.ts`） | 根 `tsconfig.json` 的 `paths` 把包名映射到各自 `src/index.ts` |
| AI SDK | **openai ^5.12.2**（agent 包唯一 LLM 依赖） | 同时用 `chat.completions` 与 `responses` 两套 API，靠 baseURL 切换兼容任意供应商 |
| 终端渲染 | **自研 pi-tui** + chalk 5（颜色）、marked 15（Markdown 解析）、mime-types | |
| 文件查找 | glob 11（工具实现） | `rg` 工具直接 spawn 系统 ripgrep |
| 远程执行 | spawn 系统 `ssh` / `scp` 二进制（pods 包无 SSH 库依赖） | 配合两个 Bash 脚本模板做 GPU Pod 引导 |

## 目录结构

```
pi/
├── package.json              # pi-monorepo：workspaces、version:patch/minor/major 脚本
├── tsconfig.base.json        # 共享编译选项（strict、esnext、bundler resolution）
├── tsconfig.json             # paths 映射：三个包名 → 各自 src/index.ts（开发用）
├── biome.json                # lint + format
├── scripts/sync-versions.js  # lockstep 版本同步脚本
├── PUBLISHING.md             # 发布流程文档
├── docs/                     # 本目录：注释与分析文档
└── packages/
    ├── tui/          # @mariozechner/pi-tui   终端 UI 库（纯库，无 bin）
    ├── agent/        # @mariozechner/pi-agent 通用 Agent（bin: pi-agent）
    ├── pods/         # @mariozechner/pi       GPU Pod 管理 CLI（bin: pi）
    └── coding-agent/ # 空壳目录（预留的第 4 个包，无源码）
```

每个包内有 `tsconfig.build.json`（干净构建到 `dist/`），形成"根 tsconfig 负责开发期类型检查与 tsx 直跑、包级 tsconfig.build.json 负责生产构建"的**双配置体系**。

**依赖链（单向）**：`pi-tui` → `pi-agent` → `pi`（pods）

- `pi-agent` 依赖 `pi-tui`（仅 TuiRenderer 使用）
- `pi`（pods）依赖 `pi-agent`（仅 `commands/prompt.ts` 调 `main()`），不直接依赖 pi-tui

## 核心模块介绍

### 1. packages/tui — 终端 UI 库（9 文件，约 2500 行）

| 文件 | 职责 |
|---|---|
| `src/tui.ts` | **差分渲染引擎**。`Component` 接口只需 `render(width)` 与可选 `handleInput(keyData)`；`Container` 递归聚合子组件并计算 `keepLines`（顶部未变化行数）；`TUI` 是根管理器——raw mode、按键分发（`onGlobalKeyPress` 钩子可吞键）、`requestRender()` 用 `process.nextTick` 合帧、`renderToScreen()` 只重写变化行 |
| `src/text-editor.ts` | **最大组件（802 行）**：多行编辑器，光标移动、编辑、Enter 提交、Shift+Enter 换行、Tab 触发补全、多行粘贴检测 |
| `src/autocomplete.ts` | `AutocompleteProvider` 接口 + `CombinedAutocompleteProvider`：斜杠命令补全 + 文件路径补全（`./`、`~/`、`@` 附件前缀） |
| `src/markdown-component.ts` | 基于 marked 词法 token 渲染标题、代码块、列表、粗斜体、链接、引用 |
| `src/select-list.ts` | 键盘导航选择列表 |
| `src/text-component.ts` | 自动按宽度换行的静态文本 + 四边 Padding |
| `src/logger.ts` / `whitespace-component.ts` | 文件日志调试器；空白占位组件 |

### 2. packages/agent — Agent 核心（9 文件，约 1900 行）

| 文件 | 职责 |
|---|---|
| `src/agent.ts` | **包的心脏（484 行）**。`AgentEvent` 10 种事件的联合类型（全包统一事件总线协议）；`Agent` 类的两个核心循环实现：`callModelChatCompletionsApi()`（tool_calls 循环）与 `callModelResponsesApi()`（reasoning/function_call 循环），均支持 AbortSignal 中断；`setEvents()` 从事件流重建 messages 用于 `--continue` |
| `src/tools/tools.ts` | 5 个工具（read/list/bash/glob/rg）的双格式定义（`toolsForResponses` / `toolsForChat`）与 `executeTool()` 分发；`bash` 有 1MB 输出上限，abort 时 SIGTERM |
| `src/session-manager.ts` | 会话以 JSONL 存于 `~/.pi/sessions/<cwd 编码路径>/<timestamp>_<uuid>.jsonl`；它本身实现 `AgentEventReceiver`，记录与渲染走同一条事件流 |
| `src/renderers/` | 三种渲染器：`JsonRenderer`（7 行，JSONL 输出供程序消费）、`ConsoleRenderer`（chalk 着色 + spinner）、`TuiRenderer`（353 行，完整交互界面：header / 聊天历史 / 状态动画 / 编辑器 / token 用量行） |
| `src/cli.ts` | `main(args)` 入口，三种运行模式：TUI 交互 / JSON 交互（stdin JSONL）/ 单次执行。文件尾 `import.meta.url` 检测使其**既是 bin 又是可复用库**——pods 包正是以此库级复用 agent |
| `src/args.ts` | 手写类型化参数解析器（flag/boolean/int/float/string、alias、choices、`~` 展开） |

### 3. packages/pods — GPU Pod 管理 CLI（9 文件，约 1750 行）

| 文件 | 职责 |
|---|---|
| `src/cli.ts` | 手写 switch 分发子命令：`pods [setup\|active\|remove\|list]`、`shell`、`ssh`、`start`、`stop`、`list`、`logs`、`agent` |
| `src/commands/models.ts` | **包内最大（703 行）**。`startModel()`：端口分配 → GPU/vLLM 参数三级决策 → 读 `model_run.sh` 模板替换占位符 → SSH 上传 → 伪 TTY + setsid 后台启动取 PID → tail 日志直到就绪。另有 stop/list/logs |
| `src/commands/pods.ts` | `setupPod()`：测 SSH → 上传 `pod_setup.sh` → 远程装 vLLM → `nvidia-smi` 解析 GPU 清单 |
| `src/commands/prompt.ts` | `pi agent <name>` 实现：从 pods.json 取配置 → 构造代码导航专用 system prompt → **直接调用 pi-agent 的 `main()`**（pods 与 agent 的接合点） |
| `src/ssh.ts` | `sshExec` / `sshExecStream`（流式、keepAlive）/ `scpFile` |
| `src/model-configs.ts` | 预置模型库（Qwen3-Coder、GPT-OSS、GLM-4.5、Kimi-K2 等）+ 按 GPU 数量/型号选最佳配置 |
| `src/config.ts` / `types.ts` | `~/.pi/pods.json` 持久化；核心类型（GPU/Model/Pod/Config） |

## 核心数据流

以 `pi agent qwen -i` 交互模式为例：

```
┌─────────────────────────── 终端进程 ───────────────────────────┐
│                                                                │
│  键盘输入 ──► TUI.handleKeypress() ──► TextEditor.handleInput() │
│                    (pi-tui)                    │ Enter 提交      │
│                                               ▼                 │
│  TuiRenderer.getUserInput() ◄── resolve Promise                │
│                    │                                           │
└────────────────────┼───────────────────────────────────────────┘
                     ▼
┌─────────────────── Agent.ask() (pi-agent) ─────────────────────┐
│  user_message 事件 ─► push 用户消息                              │
│       ▼                                                        │
│  while 循环: 调 OpenAI SDK (chat.completions / responses)       │
│       ├─ 返回 tool_calls ─► tool_call 事件 ─► executeTool()     │
│       │                        ─► tool_result 事件              │
│       │                        ─► role:"tool" 消息推回 ─► 继续循环 │
│       └─ 返回纯文本 ─► assistant_message 事件 ─► 退出循环          │
└────────────────────┬───────────────────────────────────────────┘
                     │ AgentEvent 事件流（comboReceiver 同时分发）
          ┌──────────┴──────────┬─────────────────┐
          ▼                     ▼                 ▼
   TuiRenderer.on()      SessionManager.on()   (其他接收器)
   渲染到 pi-tui 组件      追加写入 JSONL 会话
   requestRender() 差分     --continue 时重建
```

**中断路径**：Esc → `onGlobalKeyPress` → `agent.interrupt()` → `AbortController.abort()` → 各检查点发 `interrupted` 事件。

## 架构要点（为什么这样设计）

1. **AgentEvent 事件协议是全系统的粘合剂**：渲染（3 种 renderer）、持久化（SessionManager）、会话重建（`setEvents`）三者共用同一条事件流，实现 UI / API / 录制回放的彻底解耦。
2. **`import.meta.url === \`file://${process.argv[1]}\`` 的双入口设计**：`agent/src/cli.ts` 既是 bin 入口又是可复用库函数，pods 包因此能零成本嵌入 agent。
3. **差分渲染**：pi-tui 只重写终端中变化的行（`keepLines` + `\x1b[0J` 清屏），避免全屏闪烁，这是它不依赖任何第三方 TUI 框架的底气。
4. **锁步版本**：`scripts/sync-versions.js` 保证三个包版本一致并把内部依赖改写为 `^<version>`。

## 入口点速查

| 入口 | 位置 | 说明 |
|---|---|---|
| `pi` bin | `packages/pods/src/cli.ts` | GPU Pod / vLLM 管理总 CLI |
| `pi-agent` bin | `packages/agent/src/cli.ts` | 独立通用 agent CLI，可指任意 OpenAI 兼容端点 |
| 库入口 | `packages/agent/src/index.ts` | 导出 `Agent`、事件类型、`main`、三个 Renderer、`SessionManager` |
| 库入口 | `packages/tui/src/index.ts` | 导出全部 UI 组件与类型 |
| 库入口 | `packages/pods/src/index.ts` | 仅导出 types |
