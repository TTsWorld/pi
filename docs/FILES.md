# 源代码文件清单（commit e5aedfed2，upstream 第 39 次）

> 与第 38 次提交相比，仅 ai 包新增 `src/types.ts` 与 `src/providers/anthropic.ts`（另有 `test/examples/anthropic.ts`，按排除规则不入清单）；其余 31 个文件的注释直接复用 #38 已验证版本。

> 排除规则：测试文件（`packages/tui/test/`）、配置（`*.json`、`tsconfig*`、`biome.json`）、文档（`*.md`）、脚本产物（`package-lock.json`）、`models.js`（空文件）、`.husky/`。

## packages/agent — AI Coding Agent（10 个）

| 文件 | 说明 |
|------|------|
| `packages/agent/src/agent.ts` | Agent 核心主循环 |
| `packages/agent/src/args.ts` | 命令行参数解析 |
| `packages/agent/src/cli.ts` | CLI 入口 |
| `packages/agent/src/index.ts` | 包导出入口 |
| `packages/agent/src/main.ts` | 主流程编排 |
| `packages/agent/src/renderers/console-renderer.ts` | 控制台渲染器 |
| `packages/agent/src/renderers/json-renderer.ts` | JSON 流渲染器 |
| `packages/agent/src/renderers/tui-renderer.ts` | TUI 渲染器 |
| `packages/agent/src/session-manager.ts` | 会话管理 |
| `packages/agent/src/tools/tools.ts` | 工具定义 |

## packages/ai — 统一 AI 包（3 个）

| 文件 | 说明 |
|------|------|
| `packages/ai/src/index.ts` | 包入口（仍为占位，导出版本号） |
| `packages/ai/src/types.ts` | 统一类型体系【本次提交新增】 |
| `packages/ai/src/providers/anthropic.ts` | Anthropic provider 实现【本次提交新增】 |

## packages/pods — 远程 GPU Pod 管理（9 个）

| 文件 | 说明 |
|------|------|
| `packages/pods/src/cli.ts` | pods CLI 入口 |
| `packages/pods/src/commands/models.ts` | models 子命令 |
| `packages/pods/src/commands/pods.ts` | pods 子命令 |
| `packages/pods/src/commands/prompt.ts` | prompt 子命令 |
| `packages/pods/src/config.ts` | 配置管理 |
| `packages/pods/src/index.ts` | 包导出入口 |
| `packages/pods/src/model-configs.ts` | 模型配置表 |
| `packages/pods/src/ssh.ts` | SSH 连接封装 |
| `packages/pods/src/types.ts` | 类型定义 |

## packages/tui — 终端 UI 框架（10 个）

| 文件 | 说明 |
|------|------|
| `packages/tui/src/autocomplete.ts` | 自动补全 |
| `packages/tui/src/components/loading-animation.ts` | 加载动画组件 |
| `packages/tui/src/components/markdown-component.ts` | Markdown 渲染组件 |
| `packages/tui/src/components/select-list.ts` | 选择列表组件 |
| `packages/tui/src/components/text-component.ts` | 静态文本组件 |
| `packages/tui/src/components/text-editor.ts` | 文本编辑器组件 |
| `packages/tui/src/components/whitespace-component.ts` | 空白占位组件 |
| `packages/tui/src/index.ts` | 包导出入口 |
| `packages/tui/src/terminal.ts` | 终端底层抽象 |
| `packages/tui/src/tui.ts` | TUI 核心运行时 |

## scripts（1 个）

| 文件 | 说明 |
|------|------|
| `scripts/sync-versions.js` | 各包版本同步脚本 |

**合计：33 个源文件**（31 个复用 #38 注释 + 2 个本次新注释）
