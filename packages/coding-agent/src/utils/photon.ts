/**
 * @file photon.ts —— Photon 图像处理模块的加载封装
 *
 * @description
 * 为 @silvia-odwyer/photon-node 提供统一加载入口，同时兼容两种运行环境：
 * 1. Node.js（开发环境，npm run build）
 * 2. Bun 编译出的单文件二进制（standalone 发行版）
 *
 * 难点：photon-node 的 CJS 入口使用
 * fs.readFileSync(__dirname + '/photon_rs_bg.wasm')，
 * 这会把构建机的绝对路径固化进 Bun 编译的二进制，运行时按该路径读取必然失败。
 *
 * 解决方案：
 * 1. 给 fs.readFileSync 打补丁，把读不到的 photon_rs_bg.wasm 重定向到候选路径
 * 2. 在 build:binary 时把 photon_rs_bg.wasm 拷贝到可执行文件旁边
 */

import type { PathOrFileDescriptor } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";

// 通过 createRequire 拿到可变的 fs 模块对象（ESM 命名空间是只读快照，无法打补丁）
const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");

// 从主包重新导出类型
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type ReadFileSync = typeof fs.readFileSync;

// photon 的 WASM 二进制文件名，补丁按文件名识别需要重定向的读取
const WASM_FILENAME = "photon_rs_bg.wasm";

// 懒加载的 photon 模块（单例缓存）
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
// 进行中的加载 Promise：并发调用共享同一次加载，避免重复打补丁
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

/**
 * 把 readFileSync 的 file 参数还原为可判定的路径字符串。
 * 字符串与 URL 可转换；文件描述符等其他类型返回 null（无法按文件名匹配）。
 */
function pathOrNull(file: PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

/** WASM 的候选查找路径：可执行文件同目录、其下 photon/ 子目录、当前工作目录 */
function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);
	return [
		path.join(execDir, WASM_FILENAME),
		path.join(execDir, "photon", WASM_FILENAME),
		path.join(process.cwd(), WASM_FILENAME),
	];
}

/**
 * 给 fs.readFileSync 打补丁：读取 photon_rs_bg.wasm 失败（ENOENT）时，
 * 依次尝试候选路径重定向；其余读取不受影响。
 * 返回恢复函数，调用后还原 readFileSync，不留全局副作用。
 */
function patchPhotonWasmRead(): () => void {
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const fallbackPaths = getFallbackWasmPaths();
	const mutableFs = fs as { readFileSync: ReadFileSync };

	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file);

		// 只拦截文件名以 photon_rs_bg.wasm 结尾的读取
		if (resolvedPath?.endsWith(WASM_FILENAME)) {
			try {
				return originalReadFileSync(...args);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				// 非 ENOENT 错误（如权限问题）如实抛出，不做重定向
				if (err?.code && err.code !== "ENOENT") {
					throw error;
				}

				// 依次尝试候选路径，找到存在的即用相同 options 读取
				for (const fallbackPath of fallbackPaths) {
					if (!fs.existsSync(fallbackPath)) {
						continue;
					}
					if (options === undefined) {
						return originalReadFileSync(fallbackPath);
					}
					return originalReadFileSync(fallbackPath, options);
				}

				// 候选路径全部不存在：抛回原始错误
				throw error;
			}
		}

		return originalReadFileSync(...args);
	}) as ReadFileSync;

	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		// fs 模块可能被冻结，直接赋值失败时退回 defineProperty 强行改写
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		// 恢复原始 readFileSync，写法与打补丁时对称
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * 异步加载 photon 模块。
 * 后续调用返回缓存；并发调用共享同一个加载 Promise。
 * 加载失败（如 WASM 文件缺失）返回 null，由调用方决定降级行为。
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	// 已加载成功：直接返回缓存
	if (photonModule) {
		return photonModule;
	}

	// 正在加载中：共享同一次加载，不重复打补丁
	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		// 动态 import 期间补丁生效（模块初始化会同步读 WASM），结束后立即还原
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			// 加载失败置为 null：下次调用会重新尝试完整加载流程
			photonModule = null;
			return photonModule;
		} finally {
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}
