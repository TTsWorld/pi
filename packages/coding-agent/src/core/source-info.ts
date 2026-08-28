/**
 * @file source-info.ts —— 资源来源信息
 *
 * @description
 * 描述一个资源（扩展 / skill / prompt / 主题）从哪里加载：
 * 所在路径、来源、作用域与归属形态，用于冲突提示与诊断展示。
 */
import type { PathMetadata } from "./package-manager.ts";

/** 资源作用域：用户级 / 项目级 / 临时 */
export type SourceScope = "user" | "project" | "temporary";
/** 资源来源形态：npm/git 包内 / 顶层直接安装 */
export type SourceOrigin = "package" | "top-level";

/** 资源的来源定位信息 */
export interface SourceInfo {
	/** 资源文件路径 */
	path: string;
	/** 来源描述（如 "npm:foo"、"git:..."、"local"） */
	source: string;
	/** 作用域 */
	scope: SourceScope;
	/** 来源形态 */
	origin: SourceOrigin;
	/** 包的基准目录（package 形态时有值） */
	baseDir?: string;
}

/** 从路径元数据构造 SourceInfo */
export function createSourceInfo(path: string, metadata: PathMetadata): SourceInfo {
	return {
		path,
		source: metadata.source,
		scope: metadata.scope,
		origin: metadata.origin,
		baseDir: metadata.baseDir,
	};
}

/**
 * 构造「合成」的 SourceInfo：用于没有真实包元数据的场景（如内置资源），
 * scope 与 origin 缺省为 temporary / top-level。
 */
export function createSyntheticSourceInfo(
	path: string,
	options: {
		source: string;
		scope?: SourceScope;
		origin?: SourceOrigin;
		baseDir?: string;
	},
): SourceInfo {
	return {
		path,
		source: options.source,
		scope: options.scope ?? "temporary",
		origin: options.origin ?? "top-level",
		baseDir: options.baseDir,
	};
}
