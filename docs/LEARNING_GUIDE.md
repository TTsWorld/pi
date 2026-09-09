# pi 项目学习指南

> 面向不熟悉本项目的读者。建议配合 `docs/PROJECT_OVERVIEW.md` 与源码中文注释使用。

## 这个项目能学到什么

- **一个生产级 LLM Agent 的最小完整实现**：工具调用循环、事件流架构、会话持久化、中断处理——约 1900 行就全部讲清楚了
- **从零实现终端 UI 引擎**：差分渲染、raw mode 键盘处理、组件化布局，不依赖 ink/blessed 等框架
- **monorepo 工程实践**：npm workspaces、双 tsconfig 体系、锁步版本发布
- **GPU Pod 运维自动化**：纯 spawn ssh/scp 实现远程部署 vLLM 的完整链路

## 推荐学习顺序

> **v2：自顶向下，按需下钻**（2026-09 修订）。v1 为由底向上（先 tui 后 agent），但依赖分析表明 `agent.ts` 对 tui **零 import**，两包仅通过 `tui-renderer.ts` 一个文件耦合——tui 完全可以黑盒化推迟；而本仓库不可替代的价值是 Agent 核心实现。故先攻 agent 主线，tui 降级为可选深潜，pods 垫底。每个阶段都有明确的"里程碑理解点"。

### 阶段 0：跑起来（0.5 小时）

1. 读根目录 `README.md`、`package.json`（看 workspaces 与 build 顺序）
2. `npm install && npm run build`
3. 跑 `npx pi-agent --model gpt-5-mini`（需 OPENAI_API_KEY），感受交互模式。任何 OpenAI 兼容端点均可，例如已在本机验证可用的 GLM：
   `npx tsx packages/agent/src/cli.ts --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-4.6 "你好"`（自备 key）
4. **里程碑**：知道 `pi` / `pi-agent` 两个 bin 分别来自哪个包；亲眼看到一次完整的 tool_calls 循环输出

### 阶段 1：入口追踪（0.5 小时）—— 一条命令如何变成 Agent

1. `packages/agent/src/cli.ts`（392 行）— 三种运行模式（单条消息 / 交互 / `--continue`）与 `import.meta.url` 双入口技巧
2. `packages/agent/src/args.ts`（282 行）— 手写参数解析器，学习类型化解析的紧凑实现
3. `packages/agent/src/index.ts`（68 行）— 导出清单即包的公开 API，先扫一遍建立词汇表

**里程碑**：能说清从 `main(argv)` 到 `new Agent(...)` 到第一条消息发出的完整调用链。

### 阶段 2：Agent 核心（1 天）—— 全仓库最重要的一天

1. **`src/agent.ts`（心脏，671 行）** — 精读：
   - `AgentEvent` 联合类型：10 种事件是全系统协议，先背下来
   - `AgentConfig`：`api: "completions" | "responses"` 决定走哪个循环
   - `callModelChatCompletionsApi()` 的 `while (!assistantResponded)` 循环：tool_calls → 执行 → role:"tool" 推回 → 再调模型
   - `callModelResponsesApi()`：reasoning / function_call / function_call_output 的差异
   - `setEvents()`：如何从事件流重建 messages（注意 completions 模式下 tool_call/tool_result 重新配对的 `pendingToolCalls`）
2. `src/tools/tools.ts`（361 行）— 5 个工具的定义与 `executeTool()` 分发；注意双格式导出（toolsForResponses / toolsForChat）

**里程碑**：能画出"用户输入 → tool_calls 循环 → assistant_message → 落盘"的完整时序；能解释 `comboReceiver` 如何让渲染与持久化走同一条流。

### 阶段 3：事件流的消费者（0.5 天）

1. `src/session-manager.ts`（292 行）— JSONL 会话文件格式（首行 SessionHeader，其后每事件一行）；它同时是个 AgentEventReceiver
2. `src/renderers/` 三个渲染器 — 按 json（35 行）→ console（183 行）→ tui-renderer（480 行）的顺序，感受"同一事件流、三种呈现"
3. tui-renderer 是 agent 与 tui 两包的**唯一接缝**——读完它再决定要不要深入 tui

**里程碑**：AgentEvent 的每个接收方（渲染 / 持久化）各自消费哪些事件；为什么"重放事件"就能完整重建会话。

### 阶段 4（可选）：tui 包深潜 — 差分渲染引擎

> 按需进入：如果阶段 3 后你仍想知道"这些行是怎么被画上屏幕的"，就进来；否则可直接跳到阶段 6。

先用最小组件理解接口形状，再读引擎，之后每个组件都是接口的练习题：

1. `src/index.ts`（82 行）— 导出清单
2. `src/whitespace-component.ts`（48 行）→ `src/text-component.ts`（169 行）— 最简单的组件，理解 `Component` 接口（`render(width)` 返回什么）
3. **`src/tui.ts`（核心，689 行）** — 差分渲染引擎：`Container.render()` 递归聚合、`keepLines` 计算、`renderToScreen()` 的光标移动 + 清屏 + 增量写入、`requestRender()` 合帧、`removeChild()` 的哨兵占位
4. `src/select-list.ts`（232 行）— `handleInput()` 键盘交互模式与滚动逻辑
5. `src/markdown-component.ts`（362 行）— marked token 遍历渲染
6. `src/autocomplete.ts`（699 行）— `AutocompleteProvider` 接口设计（命令补全 + 路径补全如何组合）
7. **`src/text-editor.ts`（最难，1025 行）** — 最后读。光标行列/偏移互转、视口滚动、历史记录、按键分支

**里程碑**：能回答"为什么 TUI 只重写变化的行？`removeChild` 为什么用哨兵而不是 splice？`onGlobalKeyPress` 返回 false 意味着什么？"

### 阶段 5（可选）：pods 包 — 运维外壳

> 与 Agent 主线知识距离最远，只在需要时读。

1. `src/types.ts`（27 行）→ `src/config.ts` — 数据模型与本地持久化
2. `src/ssh.ts` — 三个 ssh/scp 原语的封装
3. `src/model-configs.ts` — 预置模型配置与选型逻辑
4. `src/commands/pods.ts` — Pod 初始化流程（setupPod）
5. **`src/commands/models.ts`（843 行）** — startModel 的完整链路：端口分配 → 参数三级决策 → 模板替换 → 远程后台启动 → 健康检查
6. `src/commands/prompt.ts` + `src/cli.ts` — 注意 prompt.ts 直接 import pi-agent 的 `main()`，这是包间接合点

**里程碑**：能说清 `pi agent qwen` 一条命令背后发生了什么（从 pods.json 到 vLLM 启动再到 agent 连接）。

### 阶段 6：横向贯通与终局（0.5 小时）

- 读 `scripts/sync-versions.js`（39 行）理解锁步发布
- 对照 `PUBLISHING.md` 理解 npm workspaces 发布流程
- 思考题：如果要加一个"网页 UI"，应该实现哪个接口？（答案：AgentEventReceiver / 写一个新 Renderer）
- **终局视角**：本提交只是种子。切到 `main` 分支可见它长成完整 coding-agent 的全过程（676 个文件的 `packages/coding-agent` + `packages/ai`），可与本基线对照阅读演进

## 关键概念速查

| 概念 | 定义位置 | 一句话解释 |
|---|---|---|
| `Component` 接口 | tui/src/tui.ts | 终端组件契约：`render(width)` 产出行，可选 `handleInput()` 接键 |
| 差分渲染 | tui/src/tui.ts `renderToScreen()` | 只重写终端变化的行（keepLines + ANSI 清屏） |
| `AgentEvent` | agent/src/agent.ts | 10 种事件的联合类型，全系统统一协议 |
| `AgentEventReceiver` | agent/src/agent.ts | `on(event): Promise<void>`，渲染器与 SessionManager 都实现它 |
| tool_calls 循环 | agent/src/agent.ts `callModelChatCompletionsApi()` | 模型请求工具 → 执行 → 结果推回 → 再调模型，直到纯文本回复 |
| `comboReceiver` | agent/src/agent.ts 构造器 | 把每个事件同时转发给 renderer 和 sessionManager 的扇出器 |
| 会话 JSONL | agent/src/session-manager.ts | 首行 SessionHeader + 每事件一行，`--continue` 时重放 |
| 双入口 | agent/src/cli.ts 文件尾 | `import.meta.url` 检测使 cli.ts 既可作 bin 又可作库被 import |
| 参数三级决策 | pods/src/commands/models.ts `startModel()` | `--vllm` 自定义参数 > 预置模型配置 > 未知模型默认单卡 |

## 阅读技巧

- **先读 JSDoc 文件头**：每个文件开头都有 `@description` 注释块，先看完再读代码
- **跟着事件流走**：读 agent 包时始终问"这个函数发了什么事件？谁在接收？"
- **大文件分段啃**：text-editor.ts 和 models.ts 超过 700 行，按 `// ========== 段落名 ==========` 分段标记逐段读
- 用 `npm run check`（biome + tsc）验证你对代码的修改理解

## 一页总结

```
pi-tui（怎么画）  ──►  pi-agent（怎么想）  ──►  pi/pods（怎么部署）
   差分渲染              事件流 + 工具循环          ssh + vLLM 运维
```

三个包各约 2000 行、边界干净、依赖单向——这是一个非常适合通读全文的 Agent 项目。
