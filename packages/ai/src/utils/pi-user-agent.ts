/**
 * @file 生成 pi SDK 的 User-Agent 字符串。
 * Node/Bun 环境下读取 os 内置模块拼出平台信息，浏览器环境降级为 "pi (browser)"，供各 provider 请求标识客户端。
 */
import type * as NodeOs from "node:os";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

/**
 * 运行时按需加载 node:os 内置模块。
 * 仅在 Node/Bun 运行时且 process 上存在 getBuiltinModule 时返回模块，其余情况返回 null。
 * @returns node:os 模块；浏览器等不支持的环境返回 null
 */
function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// 保持 OS 模块的运行时加载对浏览器安全：顶层直接 import node:os 会破坏浏览器/Vite 构建。
const nodeOs = loadNodeOs();

/**
 * 获取 pi 的 User-Agent 字符串。
 * @returns Node/Bun 下形如 "pi (darwin 25.6.0; arm64)"；浏览器或无法加载 os 模块时为 "pi (browser)"
 */
export function getPiUserAgent(): string {
	return nodeOs ? `pi (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : "pi (browser)";
}
