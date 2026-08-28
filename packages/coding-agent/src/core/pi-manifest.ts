/**
 * @file pi-manifest.ts —— package.json 中的 pi 包清单解析
 *
 * @description
 * 读取依赖包 package.json 里的 "pi" 字段，提取其声明的
 * 扩展 / skill / prompt / 主题资源清单，供资源发现使用。
 */
import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

/** package.json 的 "pi" 字段中声明的资源清单 */
export interface PiManifest {
	/** 扩展入口列表 */
	extensions?: string[];
	/** skill 目录列表 */
	skills?: string[];
	/** prompt 文件列表 */
	prompts?: string[];
	/** 主题文件列表 */
	themes?: string[];
}

// "pi" 字段下允许出现的资源字段名
const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

/** 判断值是否为非数组的纯对象（类型收窄守卫） */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取并解析指定 package.json 的 pi 清单。
 * 文件缺失、JSON 解析失败或没有合法 "pi" 字段时返回 null；
 * 各资源字段仅接受纯字符串数组，其余形态直接忽略。
 */
export function readPiManifest(packageJsonPath: string): PiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg) || !isObject(pkg.pi)) {
			return null;
		}

		// 逐个资源字段提取：只有字符串数组才收录
		const manifest: PiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = pkg.pi[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}
		return manifest;
	} catch {
		return null;
	}
}
