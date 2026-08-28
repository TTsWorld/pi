/**
 * @file windows-self-update.ts —— Windows 自更新时原生依赖的隔离处理
 *
 * @description
 * Windows 上已被进程加载的原生 .node 模块处于锁定状态，无法被更新覆盖。
 * 自更新前把这些文件「改名挪走 + 复制回原位」，使磁盘上的文件可被替换，
 * 挪走的副本集中放在 node_modules 下的 .pi-native-quarantine 隔离目录，
 * 更新完成后由 {@link cleanupWindowsSelfUpdateQuarantine} 清理。
 */

import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, toNamespacedPath } from "node:path";
import { getCwdRelativePath } from "./paths.ts";

/** node_modules 下存放被隔离原生模块的目录名。 */
const QUARANTINE_DIR_NAME = ".pi-native-quarantine";

/** 解析为绝对路径并转成 Windows 命名空间路径（\\?\ 前缀），便于后续不区分大小写比较。 */
function normalizePath(path: string): string {
	return toNamespacedPath(resolve(path));
}

/**
 * 从包目录向上查找最近的 node_modules，返回其下的隔离目录路径。
 * 包不在任何 node_modules 内时返回 undefined（表示无需隔离）。
 */
function getQuarantineRoot(packageDir: string): string | undefined {
	let current = resolve(packageDir);
	while (true) {
		if (basename(current).toLowerCase() === "node_modules") {
			return join(current, QUARANTINE_DIR_NAME);
		}
		const parent = dirname(current);
		if (parent === current) {
			return undefined;
		}
		current = parent;
	}
}

/**
 * 从 Node 进程诊断报告（process.report）中找出位于指定包目录内、
 * 已被加载的共享对象（原生模块）文件列表，按路径去重。
 */
function getLoadedSharedObjectsInPackageDir(packageDir: string): string[] {
	const sharedObjects = (process.report.getReport() as { sharedObjects?: unknown }).sharedObjects;
	if (!Array.isArray(sharedObjects)) {
		return [];
	}

	const root = normalizePath(packageDir).toLowerCase();
	const seen = new Set<string>();
	const loadedFiles: string[] = [];
	for (const value of sharedObjects) {
		if (typeof value !== "string") {
			continue;
		}
		const filePath = normalizePath(value);
		const comparisonPath = filePath.toLowerCase();
		if (getCwdRelativePath(comparisonPath, root) === undefined || seen.has(comparisonPath)) {
			continue;
		}
		seen.add(comparisonPath);
		loadedFiles.push(filePath);
	}
	return loadedFiles;
}

/** 删除自更新留下的隔离目录；删除失败静默忽略。 */
export function cleanupWindowsSelfUpdateQuarantine(packageDir: string): void {
	const quarantineRoot = getQuarantineRoot(packageDir);
	if (!quarantineRoot) {
		return;
	}
	try {
		rmSync(quarantineRoot, { recursive: true, force: true });
	} catch {
		// 可能上一个 pi 进程仍在退出过程中、还占用着某个原生模块，留待下次清理
	}
}

/**
 * 自更新前隔离包内已加载的原生依赖：把每个文件 rename 进隔离目录，再复制回原路径。
 * rename 后磁盘上出现的是「未被锁定的新文件」，更新流程即可覆盖它。
 */
export function quarantineWindowsNativeDependencies(packageDir: string): void {
	const resolvedPackageDir = normalizePath(packageDir);
	const quarantineRoot = getQuarantineRoot(resolvedPackageDir);
	if (!quarantineRoot) {
		return;
	}

	const loadedFiles = getLoadedSharedObjectsInPackageDir(resolvedPackageDir);
	if (loadedFiles.length === 0) {
		return;
	}

	const quarantineRunDir = join(quarantineRoot, `${Date.now()}-${process.pid}-${randomUUID()}`);
	for (const loadedFile of loadedFiles) {
		if (!existsSync(loadedFile)) {
			continue;
		}
		const quarantinePath = join(quarantineRunDir, relative(resolvedPackageDir, loadedFile));
		mkdirSync(dirname(quarantinePath), { recursive: true });
		renameSync(loadedFile, quarantinePath);
		copyFileSync(quarantinePath, loadedFile);
	}
}
