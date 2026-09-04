# 源代码文件清单

> 扫描规则：排除测试文件（`packages/tui/test/`）、依赖目录（`node_modules/`）、构建产物（`dist/`）、配置文件（`*.json` / `*.config.*`）、文档与资源文件。

## 统计

- 源代码文件总数：29（其中 1 个为空文件）
- 代码总行数：6182

## 文件列表

### packages/tui — 终端 UI 组件库（9 个文件，2490 行）

| 文件路径 | 行数 | 说明 |
|----------|------|------|
| `packages/tui/src/index.ts` | 29 | 包入口，导出所有公共 API |
| `packages/tui/src/tui.ts` | 473 | TUI 核心运行时，组件容器与事件循环 |
| `packages/tui/src/text-editor.ts` | 802 | 文本编辑器组件（最大的单文件） |
| `packages/tui/src/autocomplete.ts` | 549 | 自动补全组件 |
| `packages/tui/src/markdown-component.ts` | 260 | Markdown 渲染组件 |
| `packages/tui/src/select-list.ts` | 154 | 选择列表组件 |
| `packages/tui/src/text-component.ts` | 104 | 静态文本组件 |
| `packages/tui/src/logger.ts` | 95 | 日志组件 |
| `packages/tui/src/whitespace-component.ts` | 24 | 空白占位组件 |

### packages/agent — 编码代理核心（9 个文件，1925 行）

| 文件路径 | 行数 | 说明 |
|----------|------|------|
| `packages/agent/src/index.ts` | 15 | 包入口 |
| `packages/agent/src/agent.ts` | 484 | Agent 核心循环 |
| `packages/agent/src/cli.ts` | 294 | CLI 入口 |
| `packages/agent/src/args.ts` | 204 | 命令行参数解析 |
| `packages/agent/src/session-manager.ts` | 176 | 会话管理器 |
| `packages/agent/src/tools/tools.ts` | 264 | 工具系统 |
| `packages/agent/src/renderers/tui-renderer.ts` | 353 | TUI 交互式渲染器 |
| `packages/agent/src/renderers/console-renderer.ts` | 130 | 控制台渲染器 |
| `packages/agent/src/renderers/json-renderer.ts` | 7 | JSON 流渲染器 |

### packages/pods — Pods 远程执行 CLI（9 个文件，1746 行）

| 文件路径 | 行数 | 说明 |
|----------|------|------|
| `packages/pods/src/index.ts` | 2 | 包入口 |
| `packages/pods/src/cli.ts` | 362 | CLI 入口与子命令分发 |
| `packages/pods/src/commands/models.ts` | 703 | models 子命令（最大的单文件） |
| `packages/pods/src/commands/pods.ts` | 205 | pods 子命令 |
| `packages/pods/src/commands/prompt.ts` | 85 | prompt 子命令 |
| `packages/pods/src/ssh.ts` | 151 | SSH 连接封装 |
| `packages/pods/src/config.ts` | 80 | 配置读写 |
| `packages/pods/src/model-configs.ts` | 111 | 模型配置定义 |
| `packages/pods/src/types.ts` | 27 | 类型定义 |

### 根目录与脚本（2 个文件，39 行）

| 文件路径 | 行数 | 说明 |
|----------|------|------|
| `scripts/sync-versions.js` | 39 | monorepo 版本号同步脚本 |
| `models.js` | 0 | 空文件，无可注释内容，跳过 |

## 排除项

- `packages/tui/test/demo.ts` — 演示/测试文件
- `node_modules/`、`dist/`、`package-lock.json` — 依赖与构建产物
- `*.json`、`tsconfig*.json`、`biome.json`、`.npmrc` — 配置文件
- `README.md`、`PUBLISHING.md`、`LICENSE` — 文档
