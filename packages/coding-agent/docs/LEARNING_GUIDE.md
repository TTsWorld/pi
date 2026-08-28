# packages/coding-agent 学习指南

> 面向第一次接触本代码库的读者。配合源码中的中文注释使用；架构全景先看 [PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md)。

## 前置知识

- TypeScript（含较新的类型语法）、Node.js 进程/流（stdin/stdout）
- 对 LLM Agent 的基本概念：system prompt、消息流、tool call、上下文窗口
- 不需要先读完 pi-ai / pi-agent-core，但要知道：pi-ai 提供「模型目录 + 流式调用 + 认证」，pi-agent-core 提供「provider 无关的 Agent 循环」

## 推荐学习顺序（六阶段）

### 阶段 1：跑起来 + 看骨架（半天）

1. 读 `README.md`、`docs/quickstart.md`、`docs/packages.md`，安装并实际使用 `pi`（交互模式、`-p` 打印模式、`/help`）
2. `src/cli.ts`（21 行）→ `src/main.ts`（976 行，总编排，对照 PROJECT_OVERVIEW 第 4 节的数据流图逐段读）
3. `src/cli/args.ts`：所有 CLI 参数的含义与 `Args` 契约

**目标**：能口头复述「从敲下 `pi` 到进入交互模式」经过的 7 步。

### 阶段 2：会话域核心（1–2 天）⭐ 最重要

4. `src/core/session-manager.ts`：追加式 JSONL 树（id/parentId/leaf 指针）——先理解数据结构再读方法
5. `src/core/agent-session.ts`（3478 行）：全模式共享的会话核心。建议分块读：事件定义 → 消息收发 → tool 执行 → compaction 触发 → 分支/树导航
6. `src/core/agent-session-runtime.ts` + `agent-session-services.ts`：runtime 与服务的组装/重建
7. `src/core/sdk.ts`：`createAgentSession()` 把一切串起来的地方，也是 SDK 用户视角的入口

**目标**：理解「为什么三种模式只是 AgentSession 的不同 I/O 壳」。

### 阶段 3：模型与配置体系（1 天）

8. `src/core/model-runtime.ts`（pi-ai 封装）→ `model-resolver.ts`（`provider/model:thinking`、glob `--models`）
9. `src/core/settings-manager.ts`（全局/项目分层）→ `src/config.ts`（路径体系）
10. `src/core/resource-loader.ts`（extensions/skills/prompts/themes 的发现与加载）
11. `src/core/trust-manager.ts`（项目信任安全边界）

### 阶段 4：扩展系统（1 天）⭐ 本包灵魂

12. `src/core/extensions/types.ts`（1769 行）：先通读事件钩子清单（不必背），建立「什么时机能插手什么」的地图
13. `src/core/extensions/loader.ts`（发现 + jiti 加载）→ `runner.ts`（事件分发与拦截器）
14. 对照 `src/extensions/llama/`：一个真实（虽 hidden）的内置扩展如何用这些 API
15. 延伸阅读 `docs/extensions.md`、`docs/skills.md`

### 阶段 5：工具与提示词（半天）

16. `src/core/tools/index.ts`（工厂：createCodingTools/createReadOnlyTools）→ 挑 `read.ts`、`edit.ts`（含 `edit-diff.ts`）、`bash.ts` 精读
17. `src/core/tools/file-mutation-queue.ts`：为什么文件编辑要串行
18. `src/core/system-prompt.ts` + `prompt-templates.ts`
19. `src/core/compaction/`：上下文压缩与分支摘要（`docs/compaction.md` 配套）

### 阶段 6：运行模式与外围（1–2 天）

20. `src/modes/print-mode.ts`（最简单的模式，先读）→ `json-event.ts`
21. `src/modes/rpc/rpc-mode.ts` + `rpc-types.ts`（JSONL 协议）→ `rpc-client.ts`
22. `src/modes/interactive/interactive-mode.ts`（6548 行，全包最大）：不必通读，按功能定位读（slash 命令表、编辑器接线、选择器宿主、事件订阅渲染）
23. 挑 2–3 个 TUI 组件感受 pi-tui 模式：`components/footer.ts`、`components/model-selector.ts`
24. 外围按需：`package-manager-cli.ts` + `core/package-manager.ts`（Pi 包分发）、`client/remote-session.ts`（远程会话）、`server/create-harness.ts`、`core/export-html/`、`utils/`（图片处理链 photon/image-resize* 值得一瞥）

## 关键概念速查

| 概念 | 一句话解释 | 定义处 |
|---|---|---|
| AgentSession | 三种模式共享的会话核心（域层，无 I/O） | `core/agent-session.ts` |
| AgentSessionRuntime | session + cwd 绑定 services 的可重建容器 | `core/agent-session-runtime.ts` |
| SessionManager | 追加式 JSONL 树持久化（fork/clone/树导航） | `core/session-manager.ts` |
| Extension | TS 模块，经 ~35 种事件钩子介入全生命周期 | `core/extensions/types.ts` |
| ExtensionRunner | 事件分发与 before/after 拦截执行器 | `core/extensions/runner.ts` |
| ResourceLoader | 发现并加载 extensions/skills/prompts/themes/AGENTS.md | `core/resource-loader.ts` |
| ModelRuntime | 对 pi-ai 模型目录/认证/流式的统一封装 | `core/model-runtime.ts` |
| streamFn 桥接 | sdk.ts 把 pi-ai streamSimple 注入 pi-agent-core | `core/sdk.ts` |
| Pi Package | 经 npm/git 分发的扩展资源包 | `core/package-manager.ts` |
| 项目信任 | 未信任 cwd 不执行项目级 extension/资源 | `core/trust-manager.ts` |
| Compaction | 上下文超限时压缩为摘要 entry | `core/compaction/` |
| Operations 注入 | 工具定义与实际执行分离以便沙箱/复用 | `core/tools/*.ts` |
| takeOverStdout | 非交互模式接管 stdout 保证输出纯净 | `core/output-guard.ts` |

## 两大主战场提示

- **`interactive-mode.ts`（6548 行）是 UI 编排，`agent-session.ts`（3478 行）是域逻辑**，二者通过 `AgentSessionEvent` 订阅解耦——读前者时忽略域细节，读后者时忽略渲染细节。
- `src/cli.ts`（bin shim 文件）与 `src/cli/`（CLI 子模块目录）是两个不同的东西，别混淆。

## 动手实验建议

1. 用 `-p` 跑一次管道模式，对照 `print-mode.ts` 加断点观察事件流
2. 写一个最小 extension（订阅 `session_start` 打印一行），跑通 loader → runner 链路
3. 手工打开一个 session JSONL 文件，找到 leaf 指针与 parentId 链，再在 `/tree` 里切换分支验证
4. `PI_STARTUP_BENCHMARK=1` 观察各阶段启动耗时（`core/timings.ts`）
