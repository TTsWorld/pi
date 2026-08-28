# 注释进度（packages/coding-agent）

> 启动时间：2026-08-27
> 目标：`packages/coding-agent` 全部 206 个源码文件（共 60746 行）
> 注释语言：中文（现有英文注释同步翻译为中文）
> 完成标准：三层注释（文件头 / 类型与函数 JSDoc / 关键逻辑行内注释）+ 机械校验通过

## 统计
- 总任务数: 82
- 已完成: 82
- 进行中: 0
- 待处理: 0
- 失败: 0（T28 组与 T57~T60 组曾因 API 429 限额中断，均已重跑成功）

## 完成时间

2026-08-28：82/82 任务组全部完成，206 个文件全量机械校验通过（代码零改动）。

## 执行方式

按「任务组」分批并发执行（每任务组 = 1 个注释 agent，约 700 行/组）。
超大文件（interactive-mode.ts / agent-session.ts / package-manager-cli.ts）拆片**顺序**执行。
因账户 API 速率限制，**并发控制在 3**。

## 机械校验方式

每批完成后运行 `node docs/verify-annotations.mjs`：剥离注释与空白后，
文件必须与 git HEAD 版本的纯代码行序列完全一致（即「只加注释、不改代码」）。

状态标记：⏳ 待处理 ｜ 🔄 进行中 ｜ ✅ 已完成 ｜ ❌ 失败（附原因）

## 任务列表

| 状态 | 任务 | 主题 | 文件 | 行数 | 备注 |
|------|------|------|------|------|------|
| ✅ | T01 | 根入口与全局配置 | `src/package-manager-cli.ts`（1102 行） | 1102 | ⚠️ 超大文件拆 2 片顺序执行，禁并发 |
| ✅ | T02 | 根入口与全局配置 | `src/main.ts`（976 行） | 976 |  |
| ✅ | T03 | 根入口与全局配置 | `src/config.ts`（575 行） | 575 |  |
| ✅ | T04 | 根入口与全局配置 | `src/index.ts`（420 行） | 420 |  |
| ✅ | T05 | 根入口与全局配置 | `src/migrations.ts`（316 行）、`src/cli.ts`（21 行）、`src/rpc-entry.ts`（13 行） | 350 |  |
| ✅ | T06 | CLI 参数与启动 | `src/cli/args.ts`（447 行）、`src/cli/startup-ui.ts`（239 行） | 686 |  |
| ✅ | T07 | CLI 参数与启动 | `src/cli/auth-command.ts`（126 行）、`src/cli/list-models.ts`（115 行）、`src/cli/file-processor.ts`（88 行）、`src/cli/credential-print.ts`（87 行）、`src/cli/auth-check.ts`（73 行）、`src/cli/project-trust.ts`（62 行）、`src/cli/config-selector.ts`（56 行）、`src/cli/session-picker.ts`（55 行） | 662 |  |
| ✅ | T08 | CLI 参数与启动 | `src/cli/initial-message.ts`（43 行） | 43 |  |
| ✅ | T09 | CLI 实验特性 | `src/cli/experimental/command.ts`（205 行）、`src/cli/experimental/transport-address.ts`（48 行）、`src/cli/experimental/command-options.ts`（38 行）、`src/cli/experimental/auth.ts`（21 行）、`src/cli/experimental/cli.ts`（7 行） | 319 |  |
| ✅ | T10 | CLI 实验命令 | `src/cli/experimental/commands/pi.ts`（47 行）、`src/cli/experimental/commands/client.ts`（44 行）、`src/cli/experimental/commands/server.ts`（44 行） | 135 |  |
| ✅ | T11 | 核心运行时 | `src/core/agent-session.ts`（3478 行） | 3478 | ⚠️ 超大文件拆 2 片顺序执行，禁并发 |
| ✅ | T12 | 核心运行时 | `src/core/package-manager.ts`（2699 行） | 2699 |  |
| ✅ | T13 | 核心运行时 | `src/core/session-manager.ts`（1715 行） | 1715 |  |
| ✅ | T14 | 核心运行时 | `src/core/settings-manager.ts`（1347 行） | 1347 |  |
| ✅ | T15 | 核心运行时 | `src/core/resource-loader.ts`（1097 行） | 1097 |  |
| ✅ | T16 | 核心运行时 | `src/core/model-runtime.ts`（787 行） | 787 |  |
| ✅ | T17 | 核心运行时 | `src/core/model-resolver.ts`（782 行） | 782 |  |
| ✅ | T18 | 核心运行时 | `src/core/provider-composer.ts`（572 行） | 572 |  |
| ✅ | T19 | 核心运行时 | `src/core/skills.ts`（507 行） | 507 |  |
| ✅ | T20 | 核心运行时 | `src/core/auth-storage.ts`（506 行） | 506 |  |
| ✅ | T21 | 核心运行时 | `src/core/agent-session-runtime.ts`（441 行） | 441 |  |
| ✅ | T22 | 核心运行时 | `src/core/sdk.ts`（410 行） | 410 |  |
| ✅ | T23 | 核心运行时 | `src/core/keybindings.ts`（396 行） | 396 |  |
| ✅ | T24 | 核心运行时 | `src/core/footer-data-provider.ts`（388 行）、`src/core/model-config.ts`（300 行） | 688 |  |
| ✅ | T25 | 核心运行时 | `src/core/resolve-config-value.ts`（287 行）、`src/core/prompt-templates.ts`（285 行） | 572 |  |
| ✅ | T26 | 核心运行时 | `src/core/trust-manager.ts`（245 行）、`src/core/agent-session-services.ts`（221 行）、`src/core/messages.ts`（195 行） | 661 |  |
| ✅ | T27 | 核心运行时 | `src/core/system-prompt.ts`（169 行）、`src/core/cache-stats.ts`（164 行）、`src/core/model-registry.ts`（157 行）、`src/core/bash-executor.ts`（156 行） | 646 |  |
| ✅ | T28 | 核心运行时 | `src/core/models-store.ts`（147 行）、`src/core/remote-catalog-provider.ts`（137 行）、`src/core/http-dispatcher.ts`（111 行）、`src/core/output-guard.ts`（108 行）、`src/core/exec.ts`（107 行） | 610 |  |
| ✅ | T29 | 核心运行时 | `src/core/provider-attribution.ts`（97 行）、`src/core/project-trust.ts`（96 行）、`src/core/index.ts`（80 行）、`src/core/usage-totals.ts`（70 行）、`src/core/session-cwd.ts`（59 行）、`src/core/runtime-credentials.ts`（52 行）、`src/core/timings.ts`（50 行）、`src/core/slash-commands.ts`（43 行）、`src/core/session-export.ts`（42 行）、`src/core/source-info.ts`（40 行）、`src/core/pi-manifest.ts`（35 行）、`src/core/event-bus.ts`（33 行） | 697 |  |
| ✅ | T30 | 核心运行时 | `src/core/auth-guidance.ts`（25 行）、`src/core/settings-diagnostics.ts`（25 行）、`src/core/diagnostics.ts`（15 行）、`src/core/telemetry.ts`（13 行）、`src/core/defaults.ts`（12 行）、`src/core/experimental.ts`（9 行）、`src/core/radius.ts`（1 行） | 100 |  |
| ✅ | T31 | 内置工具 | `src/core/tools/edit-diff.ts`（556 行） | 556 |  |
| ✅ | T32 | 内置工具 | `src/core/tools/bash.ts`（544 行） | 544 |  |
| ✅ | T33 | 内置工具 | `src/core/tools/edit.ts`（461 行） | 461 |  |
| ✅ | T34 | 内置工具 | `src/core/tools/grep.ts`（390 行） | 390 |  |
| ✅ | T35 | 内置工具 | `src/core/tools/find.ts`（380 行） | 380 |  |
| ✅ | T36 | 内置工具 | `src/core/tools/read.ts`（358 行）、`src/core/tools/truncate.ts`（276 行） | 634 |  |
| ✅ | T37 | 内置工具 | `src/core/tools/write.ts`（274 行）、`src/core/tools/ls.ts`（230 行） | 504 |  |
| ✅ | T38 | 内置工具 | `src/core/tools/index.ts`（224 行）、`src/core/tools/output-accumulator.ts`（222 行）、`src/core/tools/path-utils.ts`（118 行）、`src/core/tools/render-utils.ts`（85 行） | 649 |  |
| ✅ | T39 | 内置工具 | `src/core/tools/powershell.ts`（67 行）、`src/core/tools/file-mutation-queue.ts`（61 行）、`src/core/tools/tool-definition-wrapper.ts`（47 行） | 175 |  |
| ✅ | T40 | 扩展系统 | `src/core/extensions/types.ts`（1769 行） | 1769 |  |
| ✅ | T41 | 扩展系统 | `src/core/extensions/runner.ts`（1236 行） | 1236 |  |
| ✅ | T42 | 扩展系统 | `src/core/extensions/loader.ts`（806 行） | 806 |  |
| ✅ | T43 | 扩展系统 | `src/core/extensions/index.ts`（190 行）、`src/core/extensions/wrapper.ts`（45 行） | 235 |  |
| ✅ | T44 | 上下文压缩 | `src/core/compaction/compaction.ts`（1013 行） | 1013 |  |
| ✅ | T45 | 上下文压缩 | `src/core/compaction/branch-summarization.ts`（380 行）、`src/core/compaction/utils.ts`（158 行）、`src/core/compaction/index.ts`（7 行） | 545 |  |
| ✅ | T46 | HTML 会话导出 | `src/core/export-html/index.ts`（316 行）、`src/core/export-html/ansi-to-html.ts`（258 行） | 574 |  |
| ✅ | T47 | HTML 会话导出 | `src/core/export-html/tool-renderer.ts`（172 行） | 172 |  |
| ✅ | T48 | 运行模式入口 | `src/modes/print-mode.ts`（169 行）、`src/modes/json-event.ts`（61 行）、`src/modes/index.ts`（16 行） | 246 |  |
| ✅ | T49 | TUI 交互模式 | `src/modes/interactive/interactive-mode.ts`（6548 行） | 6548 | ⚠️ 超大文件拆 3 片顺序执行，禁并发 |
| ✅ | T50 | TUI 交互模式 | `src/modes/interactive/session-share.ts`（210 行）、`src/modes/interactive/model-catalog-refresh.ts`（51 行）、`src/modes/interactive/external-editor.ts`（46 行）、`src/modes/interactive/model-search.ts`（21 行） | 328 |  |
| ✅ | T51 | TUI 组件 | `src/modes/interactive/components/tree-selector.ts`（1427 行） | 1427 |  |
| ✅ | T52 | TUI 组件 | `src/modes/interactive/components/session-selector.ts`（1031 行） | 1031 |  |
| ✅ | T53 | TUI 组件 | `src/modes/interactive/components/config-selector.ts`（942 行） | 942 |  |
| ✅ | T54 | TUI 组件 | `src/modes/interactive/components/settings-selector.ts`（929 行） | 929 |  |
| ✅ | T55 | TUI 组件 | `src/modes/interactive/components/model-selector.ts`（423 行） | 423 |  |
| ✅ | T56 | TUI 组件 | `src/modes/interactive/components/scoped-models-selector.ts`（403 行） | 403 |  |
| ✅ | T57 | TUI 组件 | `src/modes/interactive/components/tool-execution.ts`（388 行） | 388 |  |
| ✅ | T58 | TUI 组件 | `src/modes/interactive/components/armin.ts`（382 行）、`src/modes/interactive/components/settings-submenu.ts`（258 行） | 640 |  |
| ✅ | T59 | TUI 组件 | `src/modes/interactive/components/footer.ts`（245 行）、`src/modes/interactive/components/login-dialog.ts`（233 行）、`src/modes/interactive/components/bash-execution.ts`（220 行） | 698 |  |
| ✅ | T60 | TUI 组件 | `src/modes/interactive/components/oauth-selector.ts`（214 行）、`src/modes/interactive/components/assistant-message.ts`（197 行）、`src/modes/interactive/components/session-selector-search.ts`（194 行） | 605 |  |
| ✅ | T61 | TUI 组件 | `src/modes/interactive/components/daxnuts.ts`（164 行）、`src/modes/interactive/components/user-message-selector.ts`（155 行）、`src/modes/interactive/components/diff.ts`（147 行）、`src/modes/interactive/components/thinking-selector.ts`（146 行） | 612 |  |
| ✅ | T62 | TUI 组件 | `src/modes/interactive/components/first-time-setup.ts`（145 行）、`src/modes/interactive/components/trust-selector.ts`（134 行）、`src/modes/interactive/components/extension-editor.ts`（132 行）、`src/modes/interactive/components/status-indicator.ts`（114 行）、`src/modes/interactive/components/custom-message.ts`（113 行） | 638 |  |
| ✅ | T63 | TUI 组件 | `src/modes/interactive/components/extension-selector.ts`（112 行）、`src/modes/interactive/components/custom-editor.ts`（90 行）、`src/modes/interactive/components/mermaid.ts`（89 行）、`src/modes/interactive/components/extension-input.ts`（87 行）、`src/modes/interactive/components/user-message.ts`（70 行）、`src/modes/interactive/components/bordered-loader.ts`（68 行）、`src/modes/interactive/components/theme-selector.ts`（67 行）、`src/modes/interactive/components/custom-entry.ts`（62 行） | 645 |  |
| ✅ | T64 | TUI 组件 | `src/modes/interactive/components/compaction-summary-message.ts`（59 行）、`src/modes/interactive/components/branch-summary-message.ts`（58 行）、`src/modes/interactive/components/skill-invocation-message.ts`（55 行）、`src/modes/interactive/components/earendil-announcement.ts`（53 行）、`src/modes/interactive/components/show-images-selector.ts`（50 行）、`src/modes/interactive/components/visual-truncate.ts`（50 行）、`src/modes/interactive/components/keybinding-hints.ts`（48 行）、`src/modes/interactive/components/countdown-timer.ts`（39 行）、`src/modes/interactive/components/index.ts`（38 行）、`src/modes/interactive/components/markdown-transform.ts`（29 行）、`src/modes/interactive/components/dynamic-border.ts`（25 行） | 504 |  |
| ✅ | T65 | TUI 主题 | `src/modes/interactive/theme/theme.ts`（1336 行） | 1336 |  |
| ✅ | T66 | TUI 主题 | `src/modes/interactive/theme/theme-controller.ts`（166 行） | 166 |  |
| ✅ | T67 | RPC 模式 | `src/modes/rpc/rpc-mode.ts`（817 行） | 817 |  |
| ✅ | T68 | RPC 模式 | `src/modes/rpc/rpc-client.ts`（601 行） | 601 |  |
| ✅ | T69 | RPC 模式 | `src/modes/rpc/rpc-types.ts`（289 行）、`src/modes/rpc/jsonl.ts`（58 行） | 347 |  |
| ✅ | T70 | 通用工具函数 | `src/utils/tools-manager.ts`（374 行）、`src/utils/clipboard-image.ts`（300 行） | 674 |  |
| ✅ | T71 | 通用工具函数 | `src/utils/shell.ts`（241 行）、`src/utils/git.ts`（226 行）、`src/utils/syntax-highlight.ts`（212 行） | 679 |  |
| ✅ | T72 | 通用工具函数 | `src/utils/changelog.ts`（196 行）、`src/utils/exif-orientation.ts`（183 行）、`src/utils/clipboard.ts`（175 行） | 554 |  |
| ✅ | T73 | 通用工具函数 | `src/utils/image-resize-core.ts`（164 行）、`src/utils/paths.ts`（139 行）、`src/utils/photon.ts`（139 行）、`src/utils/child-process.ts`（137 行） | 579 |  |
| ✅ | T74 | 通用工具函数 | `src/utils/image-resize.ts`（123 行）、`src/utils/image-process.ts`（119 行）、`src/utils/mime.ts`（116 行）、`src/utils/version-check.ts`（109 行）、`src/utils/windows-self-update.ts`（84 行）、`src/utils/management-http.ts`（78 行）、`src/utils/tool-result-images.ts`（62 行） | 691 |  |
| ✅ | T75 | 通用工具函数 | `src/utils/ansi.ts`（60 行）、`src/utils/html.ts`（51 行）、`src/utils/image-convert.ts`（49 行）、`src/utils/abort.ts`（48 行）、`src/utils/image-resize-worker.ts`（42 行）、`src/utils/frontmatter.ts`（40 行）、`src/utils/highlight-js.d.ts`（36 行）、`src/utils/clipboard-native.ts`（33 行）、`src/utils/fs-watch.ts`（30 行）、`src/utils/open-browser.ts`（24 行）、`src/utils/sleep.ts`（18 行）、`src/utils/deprecation.ts`（14 行）、`src/utils/text.ts`（9 行）、`src/utils/json.ts`（6 行）、`src/utils/pi-user-agent.ts`（4 行） | 464 |  |
| ✅ | T76 | 远程客户端 | `src/client/remote-session.ts`（420 行）、`src/client/transcript.ts`（101 行）、`src/client/index.ts`（15 行） | 536 |  |
| ✅ | T77 | 服务端 harness | `src/server/create-harness.ts`（161 行） | 161 |  |
| ✅ | T78 | 内置扩展入口 | `src/extensions/index.ts`（4 行） | 4 |  |
| ✅ | T79 | llama.cpp 本地模型扩展 | `src/extensions/llama/ui.ts`（542 行） | 542 |  |
| ✅ | T80 | llama.cpp 本地模型扩展 | `src/extensions/llama/client.ts`（343 行）、`src/extensions/llama/index.ts`（230 行） | 573 |  |
| ✅ | T81 | llama.cpp 本地模型扩展 | `src/extensions/llama/provider.ts`（180 行）、`src/extensions/llama/huggingface.ts`（158 行） | 338 |  |
| ✅ | T82 | Bun 运行时适配 | `src/bun/restore-sandbox-env.ts`（36 行）、`src/bun/cli.ts`（15 行）、`src/bun/register-bedrock.ts`（4 行） | 55 |  |

