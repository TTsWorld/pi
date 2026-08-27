/**
 * @file Provider 环境变量统一读取入口
 * @description 按「作用域覆盖 → 常规 process.env → Bun 沙箱兜底」三级优先级
 * 解析 provider 相关的环境变量。API key、账号/项目 ID、代理、区域等各类配置
 * 均经由 getProviderEnvValue 取值；Bun 兜底用于规避 Bun 编译产物在 Linux
 * 沙箱中 process.env 为空的问题（此时从 /proc/self/environ 直接读取）。
 */
import type { ProviderEnv } from "../types.ts";

// /proc/self/environ 的解析结果缓存：整个进程只读盘解析一次
let procEnvCache: Map<string, string> | null = null;

/**
 * 针对 https://github.com/oven-sh/bun/issues/27802 的兜底。
 * Bun 编译出的二进制在 Linux 沙箱内可能暴露空的 process.env，
 * 尽管 /proc/self/environ 中实际包含环境变量。
 *
 * 这里有意与 packages/coding-agent/src/bun/restore-sandbox-env.ts 中的
 * restoreSandboxEnv() 重复实现：ai 包可以被直接使用、不经过那个入口，
 * 因此 provider 环境变量查找不能依赖 process.env 已被修补这一前提。
 */
function getBunSandboxEnvValue(name: string): string | undefined {
	// 非 Bun 运行时，或 process.env 正常非空：无需此兜底
	if (typeof process === "undefined" || !process.versions?.bun || Object.keys(process.env).length > 0) {
		return undefined;
	}

	if (procEnvCache === null) {
		// 惰性解析 /proc/self/environ（NUL 分隔的 KEY=VALUE 列表）并写入缓存
		procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as {
				readFileSync(path: string, encoding: BufferEncoding): string;
			};
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ 可能不存在或不可读，忽略即可。
		}
	}

	return procEnvCache.get(name);
}

/**
 * 按三级优先级解析一个 provider 环境变量：
 * 作用域覆盖（ProviderEnv）→ 常规 process.env → Bun 沙箱兜底
 * （供直接使用 pi-ai 包、process.env 未被修补的消费方使用）。
 * 各级用 || 串联：空字符串同样视为未设置而继续回退。
 * @param name 环境变量名
 * @param env 可选的 ProviderEnv 作用域覆盖
 * @returns 变量值；三级均未命中时为 undefined
 */
export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
	return (
		env?.[name] ||
		(typeof process !== "undefined" ? process.env[name] : undefined) ||
		getBunSandboxEnvValue(name) ||
		undefined
	);
}
