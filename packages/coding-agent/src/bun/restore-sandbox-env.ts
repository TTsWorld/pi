/**
 * 针对 https://github.com/oven-sh/bun/issues/27802 的临时规避方案。
 *
 * Bun 编译出的单文件二进制在沙箱环境（如 Linux/macOS 上的 nono）中运行时，
 * `process.env` 可能为空。Linux 上可以从 `/proc/self/environ` 恢复环境变量
 * （macOS 没有 /proc，读取会失败并被静默忽略，因此实际只在 Linux 生效）。
 *
 * 注意与 packages/ai/src/utils/provider-env.ts 中的 getBunSandboxEnvValue()
 * 保持同步：ai 包为不走 coding-agent 入口的直接使用者复制了同样的查找逻辑。
 *
 * 本还原只处理「env 完全为空」的异常场景；正常环境下不做任何事。
 */

import { readFileSync } from "node:fs";

/**
 * 当运行在沙箱内且 Bun 的 `process.env` 为空时，从 `/proc/self/environ`
 * 逐条恢复环境变量。
 *
 * 必须在任何读取环境变量的初始化（如 provider 凭据解析）之前调用
 * （典型调用点是 src/bun/cli.ts，即 Bun 二进制入口）；
 * 非 Bun 运行时或 env 正常时为 no-op。恢复失败（如 /proc 不可读）
 * 也会静默跳过，不阻断启动。
 */
export function restoreSandboxEnv(): void {
	// 仅在 Bun 运行时生效（Node 等环境不受该 bug 影响）
	if (!process.versions?.bun) return;

	// process.env 已有内容说明环境正常，无需修复。
	if (Object.keys(process.env).length > 0) return;

	try {
		// /proc/self/environ 以 NUL（\0）分隔各条 KEY=VALUE 记录
		const data = readFileSync("/proc/self/environ", "utf-8");
		// 逐条拆出键值写回 process.env
		for (const entry of data.split("\0")) {
			const idx = entry.indexOf("=");
			// idx > 0：key 非空才写入（跳过缺 key 的畸形段）；value 允许为空字符串
			if (idx > 0) {
				// 用 indexOf + slice 手动拆分：value 中可能含有 "="，不能用 split("=")
				process.env[entry.slice(0, idx)] = entry.slice(idx + 1);
			}
		}
	} catch {
		// /proc/self/environ 可能不可读（非 Linux 或权限不足）；忽略即可。
	}
}
