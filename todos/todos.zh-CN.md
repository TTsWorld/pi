> 中文版译自 [todos.md](todos.md)，如与英文原文有出入，以英文原文为准。

- pods：如果某个 pod 已挂掉，此时运行 `pi list`，验证进程时仍显示 All processes verified。但这不可能是真的，因为我们已经无法 SSH 进入该 pod 去检查了。
- agent：开启新的 agent 会话后，按下 CTRL+C，"Press Ctrl+C again to exit" 会出现在 text editor 上方，后面还跟着一个空行。大约 1 秒后，这个空行会消失。我们应该要么不显示这个空行，要么始终显示它。也许 Ctrl+C 的提示信息应该显示在 text editor 下方。
- tui：运行 npx tsx test/demo.ts 后，使用 /exit 或按 CTRL+C 都无法退出 demo。
