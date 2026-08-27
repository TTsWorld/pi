/**
 * @file AWS Bedrock Converse Stream API 的懒加载 shim。
 * @description 实现位于 bedrock-converse-stream.ts（约 1300 行），依赖仅 Node 可用的 AWS SDK；
 * 因此这里改用「变量 specifier」做动态 import，并支持 Bun 二进制构建注入静态模块覆盖。
 */
import type { ProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

/**
 * 通过变量形式的 specifier 加载 bedrock 实现，让打包器（浏览器冒烟测试、Bun compile）
 * 无法顺着 import 静态追踪进仅 Node 可用的 AWS SDK。`.ts`/`.js` 后缀改写
 * 保证这个技巧在源码和构建产物两种形态下都生效。
 */
const importNodeOnlyApi = (specifier: string): Promise<unknown> => {
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	return import(runtimeSpecifier);
};

// 可选的模块级覆盖：由 Bun 二进制构建通过 setBedrockProviderModule 注册
let bedrockModuleOverride: ProviderStreams | undefined;

/**
 * 覆盖动态导入的 bedrock 实现。供 Bun 二进制构建使用：那种场景下
 * 变量 specifier 的 import 无法被打包，构建时改为注册一个静态导入的模块。
 */
export function setBedrockProviderModule(module: ProviderStreams): void {
	bedrockModuleOverride = module;
}

/** 工厂函数：返回懒加载版 Bedrock Converse Stream API（stream / streamSimple）；优先使用已注册的模块覆盖。 */
export const bedrockConverseStreamApi = (): ProviderStreams =>
	lazyApi(
		async () =>
			bedrockModuleOverride ?? ((await importNodeOnlyApi("./bedrock-converse-stream.ts")) as ProviderStreams),
	);
