# 源码文件清单（packages/coding-agent）

> 共 206 个 TypeScript 源码文件（已排除 test/、examples/、scripts/、构建产物与配置）。
> 注释任务分组与进度见 [ANNOTATION_PLAN.md](./ANNOTATION_PLAN.md)。

## src/ — 根入口与全局配置

| 文件 | 行数 |
|------|------|
| cli.ts | 21 |
| config.ts | 575 |
| index.ts | 420 |
| main.ts | 976 |
| migrations.ts | 316 |
| package-manager-cli.ts | 1102 |
| rpc-entry.ts | 13 |

## src/cli/ — CLI 参数与启动

| 文件 | 行数 |
|------|------|
| args.ts | 447 |
| auth-check.ts | 73 |
| auth-command.ts | 126 |
| config-selector.ts | 56 |
| credential-print.ts | 87 |
| file-processor.ts | 88 |
| initial-message.ts | 43 |
| list-models.ts | 115 |
| project-trust.ts | 62 |
| session-picker.ts | 55 |
| startup-ui.ts | 239 |

## src/cli/experimental/ — CLI 实验特性

| 文件 | 行数 |
|------|------|
| auth.ts | 21 |
| cli.ts | 7 |
| command-options.ts | 38 |
| command.ts | 205 |
| transport-address.ts | 48 |

## src/cli/experimental/commands/ — CLI 实验命令

| 文件 | 行数 |
|------|------|
| client.ts | 44 |
| pi.ts | 47 |
| server.ts | 44 |

## src/core/ — 核心运行时

| 文件 | 行数 |
|------|------|
| agent-session-runtime.ts | 441 |
| agent-session-services.ts | 221 |
| agent-session.ts | 3478 |
| auth-guidance.ts | 25 |
| auth-storage.ts | 506 |
| bash-executor.ts | 156 |
| cache-stats.ts | 164 |
| defaults.ts | 12 |
| diagnostics.ts | 15 |
| event-bus.ts | 33 |
| exec.ts | 107 |
| experimental.ts | 9 |
| footer-data-provider.ts | 388 |
| http-dispatcher.ts | 111 |
| index.ts | 80 |
| keybindings.ts | 396 |
| messages.ts | 195 |
| model-config.ts | 300 |
| model-registry.ts | 157 |
| model-resolver.ts | 782 |
| model-runtime.ts | 787 |
| models-store.ts | 147 |
| output-guard.ts | 108 |
| package-manager.ts | 2699 |
| pi-manifest.ts | 35 |
| project-trust.ts | 96 |
| prompt-templates.ts | 285 |
| provider-attribution.ts | 97 |
| provider-composer.ts | 572 |
| radius.ts | 1 |
| remote-catalog-provider.ts | 137 |
| resolve-config-value.ts | 287 |
| resource-loader.ts | 1097 |
| runtime-credentials.ts | 52 |
| sdk.ts | 410 |
| session-cwd.ts | 59 |
| session-export.ts | 42 |
| session-manager.ts | 1715 |
| settings-diagnostics.ts | 25 |
| settings-manager.ts | 1347 |
| skills.ts | 507 |
| slash-commands.ts | 43 |
| source-info.ts | 40 |
| system-prompt.ts | 169 |
| telemetry.ts | 13 |
| timings.ts | 50 |
| trust-manager.ts | 245 |
| usage-totals.ts | 70 |

## src/core/tools/ — 内置工具

| 文件 | 行数 |
|------|------|
| bash.ts | 544 |
| edit-diff.ts | 556 |
| edit.ts | 461 |
| file-mutation-queue.ts | 61 |
| find.ts | 380 |
| grep.ts | 390 |
| index.ts | 224 |
| ls.ts | 230 |
| output-accumulator.ts | 222 |
| path-utils.ts | 118 |
| powershell.ts | 67 |
| read.ts | 358 |
| render-utils.ts | 85 |
| tool-definition-wrapper.ts | 47 |
| truncate.ts | 276 |
| write.ts | 274 |

## src/core/extensions/ — 扩展系统

| 文件 | 行数 |
|------|------|
| index.ts | 190 |
| loader.ts | 806 |
| runner.ts | 1236 |
| types.ts | 1769 |
| wrapper.ts | 45 |

## src/core/compaction/ — 上下文压缩

| 文件 | 行数 |
|------|------|
| branch-summarization.ts | 380 |
| compaction.ts | 1013 |
| index.ts | 7 |
| utils.ts | 158 |

## src/core/export-html/ — HTML 会话导出

| 文件 | 行数 |
|------|------|
| ansi-to-html.ts | 258 |
| index.ts | 316 |
| tool-renderer.ts | 172 |

## src/modes/ — 运行模式入口

| 文件 | 行数 |
|------|------|
| index.ts | 16 |
| json-event.ts | 61 |
| print-mode.ts | 169 |

## src/modes/interactive/ — TUI 交互模式

| 文件 | 行数 |
|------|------|
| external-editor.ts | 46 |
| interactive-mode.ts | 6548 |
| model-catalog-refresh.ts | 51 |
| model-search.ts | 21 |
| session-share.ts | 210 |

## src/modes/interactive/components/ — TUI 组件

| 文件 | 行数 |
|------|------|
| armin.ts | 382 |
| assistant-message.ts | 197 |
| bash-execution.ts | 220 |
| bordered-loader.ts | 68 |
| branch-summary-message.ts | 58 |
| compaction-summary-message.ts | 59 |
| config-selector.ts | 942 |
| countdown-timer.ts | 39 |
| custom-editor.ts | 90 |
| custom-entry.ts | 62 |
| custom-message.ts | 113 |
| daxnuts.ts | 164 |
| diff.ts | 147 |
| dynamic-border.ts | 25 |
| earendil-announcement.ts | 53 |
| extension-editor.ts | 132 |
| extension-input.ts | 87 |
| extension-selector.ts | 112 |
| first-time-setup.ts | 145 |
| footer.ts | 245 |
| index.ts | 38 |
| keybinding-hints.ts | 48 |
| login-dialog.ts | 233 |
| markdown-transform.ts | 29 |
| mermaid.ts | 89 |
| model-selector.ts | 423 |
| oauth-selector.ts | 214 |
| scoped-models-selector.ts | 403 |
| session-selector-search.ts | 194 |
| session-selector.ts | 1031 |
| settings-selector.ts | 929 |
| settings-submenu.ts | 258 |
| show-images-selector.ts | 50 |
| skill-invocation-message.ts | 55 |
| status-indicator.ts | 114 |
| theme-selector.ts | 67 |
| thinking-selector.ts | 146 |
| tool-execution.ts | 388 |
| tree-selector.ts | 1427 |
| trust-selector.ts | 134 |
| user-message-selector.ts | 155 |
| user-message.ts | 70 |
| visual-truncate.ts | 50 |

## src/modes/interactive/theme/ — TUI 主题

| 文件 | 行数 |
|------|------|
| theme-controller.ts | 166 |
| theme.ts | 1336 |

## src/modes/rpc/ — RPC 模式

| 文件 | 行数 |
|------|------|
| jsonl.ts | 58 |
| rpc-client.ts | 601 |
| rpc-mode.ts | 817 |
| rpc-types.ts | 289 |

## src/utils/ — 通用工具函数

| 文件 | 行数 |
|------|------|
| abort.ts | 48 |
| ansi.ts | 60 |
| changelog.ts | 196 |
| child-process.ts | 137 |
| clipboard-image.ts | 300 |
| clipboard-native.ts | 33 |
| clipboard.ts | 175 |
| deprecation.ts | 14 |
| exif-orientation.ts | 183 |
| frontmatter.ts | 40 |
| fs-watch.ts | 30 |
| git.ts | 226 |
| highlight-js.d.ts | 36 |
| html.ts | 51 |
| image-convert.ts | 49 |
| image-process.ts | 119 |
| image-resize-core.ts | 164 |
| image-resize-worker.ts | 42 |
| image-resize.ts | 123 |
| json.ts | 6 |
| management-http.ts | 78 |
| mime.ts | 116 |
| open-browser.ts | 24 |
| paths.ts | 139 |
| photon.ts | 139 |
| pi-user-agent.ts | 4 |
| shell.ts | 241 |
| sleep.ts | 18 |
| syntax-highlight.ts | 212 |
| text.ts | 9 |
| tool-result-images.ts | 62 |
| tools-manager.ts | 374 |
| version-check.ts | 109 |
| windows-self-update.ts | 84 |

## src/client/ — 远程客户端

| 文件 | 行数 |
|------|------|
| index.ts | 15 |
| remote-session.ts | 420 |
| transcript.ts | 101 |

## src/server/ — 服务端 harness

| 文件 | 行数 |
|------|------|
| create-harness.ts | 161 |

## src/extensions/ — 内置扩展入口

| 文件 | 行数 |
|------|------|
| index.ts | 4 |

## src/extensions/llama/ — llama.cpp 本地模型扩展

| 文件 | 行数 |
|------|------|
| client.ts | 343 |
| huggingface.ts | 158 |
| index.ts | 230 |
| provider.ts | 180 |
| ui.ts | 542 |

## src/bun/ — Bun 运行时适配

| 文件 | 行数 |
|------|------|
| cli.ts | 15 |
| register-bedrock.ts | 4 |
| restore-sandbox-env.ts | 36 |

