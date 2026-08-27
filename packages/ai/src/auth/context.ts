/**
 * @file 默认 AuthContext 实现（auth/context.ts）
 * @description
 * `defaultProviderAuthContext()` 提供默认的环境访问上下文：
 * - 环境变量读取自 `process.env`（浏览器等无 process 的环境下视为未设置）
 * - 文件存在性经 node:fs/promises 的 access 检查（浏览器中恒为 false）
 * Node 内置模块通过「变量指示符」动态导入（对 bundler 不透明），
 * 避免浏览器打包器在构建期尝试静态解析 Node 内置模块。
 */
import type { AuthContext } from "./types.ts";

/** 本实现用到的 node:fs/promises 最小接口面（避免静态引入 Node 类型）。 */
interface NodeFsModule {
	access(path: string): Promise<void>;
}

/** 本实现用到的 node:os 最小接口面。 */
interface NodeOsModule {
	homedir(): string;
}

// 用变量作模块指示符，让浏览器打包器不去尝试解析 Node 内置模块。
const importNodeModule = (specifier: string): Promise<unknown> => import(specifier);

/** 安全读取 globalThis.process.env；无 process 的环境（如浏览器）返回 undefined。 */
function getProcessEnv(): Record<string, string | undefined> | undefined {
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env;
}

/**
 * 默认认证上下文：环境变量来自 `process.env`（浏览器中为 undefined），
 * 文件存在性经 node:fs 检查（浏览器中恒为 false）。
 */
export function defaultProviderAuthContext(): AuthContext {
	return {
		async env(name: string): Promise<string | undefined> {
			const value = getProcessEnv()?.[name];
			// 空串与纯空白视为未设置
			return typeof value === "string" && value.trim().length > 0 ? value : undefined;
		},

		async fileExists(path: string): Promise<boolean> {
			try {
				const fs = (await importNodeModule("node:fs/promises")) as NodeFsModule;
				let resolved = path;
				// 前导 ~ 展开为用户 home 目录
				if (resolved.startsWith("~")) {
					const os = (await importNodeModule("node:os")) as NodeOsModule;
					resolved = os.homedir() + resolved.slice(1);
				}
				await fs.access(resolved);
				return true;
			} catch {
				// 模块不可用、路径不存在或权限不足等一律按「不存在」处理
				return false;
			}
		},
	};
}
