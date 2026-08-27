import type { OAuthAuth } from "../types.ts";

/**
 * @file OAuth 流的 bundler-opaque（对打包器不透明）加载器
 *
 * @description 集中管理 7 个具体 OAuth 流（anthropic / openai-codex / github-copilot /
 * openrouter / kimi-coding / xai / radius）的按需加载。各流实现依赖 node:http 回调
 * server、node:crypto 等 Node-only 模块，不能被静态追踪进浏览器 bundle，因此统一经由
 * 本文件的「变量 specifier 动态 import」加载；Bun 打包单文件二进制时无法使用变量
 * specifier 动态 import，改由 bun-oauth.ts 静态调用 registerBundledOAuthFlowLoaders
 * 注册加载器表兜底。
 */

/**
 * 通过变量 specifier 动态加载 OAuth 流模块，使打包器无法静态追踪这条 import，
 * 从而避免 Node-only 的流实现（`node:http` 回调 server、`node:crypto` PKCE）
 * 被打包进浏览器 bundle。
 * 其中 `.ts` -> `.js` 的后缀改写保证该技巧在源码与构建产物两种形态下都生效。
 */
const importOAuthModule = (specifier: string): Promise<unknown> => {
	// 当前文件是 .js 构建产物时，把源码风格的 .ts 路径改写为 .js 后再 import
	const runtimeSpecifier = import.meta.url.endsWith(".js") ? specifier.replace(/\.ts$/, ".js") : specifier;
	// specifier 是变量而非字符串字面量，打包器静态分析无法解析，因此不会顺带打包目标模块
	return import(runtimeSpecifier);
};

/** 各 OAuth 流的加载器注册表：键为流名称，值为创建对应 OAuthAuth 实例的工厂函数。 */
type OAuthFlowLoaders = {
	anthropic: () => OAuthAuth | Promise<OAuthAuth>;
	openaiCodex: () => OAuthAuth | Promise<OAuthAuth>;
	githubCopilot: () => OAuthAuth | Promise<OAuthAuth>;
	openrouter: () => OAuthAuth | Promise<OAuthAuth>;
	kimiCoding: () => OAuthAuth | Promise<OAuthAuth>;
	xai: () => OAuthAuth | Promise<OAuthAuth>;
	// radius 是按参数实例化的工厂：同一套流程可对接不同的 Radius 网关
	radius: (options: { name: string; gateway: string }) => OAuthAuth | Promise<OAuthAuth>;
};

// 静态注册的加载器表；仅在 Bun 单文件二进制场景由 bun-oauth.ts 填充，其余环境保持 undefined
let bundledLoaders: OAuthFlowLoaders | undefined;

/**
 * 注册静态打包进二进制的 OAuth 流加载器，供独立 Bun 产物使用。
 * Bun 单文件打包后变量 specifier 的动态 import 不可用，必须改走静态注册。
 * @param loaders 各流程的加载器注册表
 */
export function registerBundledOAuthFlowLoaders(loaders: OAuthFlowLoaders): void {
	bundledLoaders = loaders;
}

/**
 * 按需加载 Anthropic 的 OAuth 流。
 * 优先查静态注册表（Bun 二进制场景），否则用 bundler-opaque 动态 import 加载
 * ./anthropic.ts 并取出其导出的 anthropicOAuth 实例。
 * 下面的各 loadXxxOAuth 与此完全同构，仅目标模块与导出名不同。
 * @returns Anthropic OAuth 流实例
 */
export const loadAnthropicOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.anthropic();
	return ((await importOAuthModule("./anthropic.ts")) as { anthropicOAuth: OAuthAuth }).anthropicOAuth;
};

/** 按需加载 OpenAI Codex 的 OAuth 流（静态注册表优先，否则动态 import ./openai-codex.ts）。 */
export const loadOpenAICodexOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openaiCodex();
	return ((await importOAuthModule("./openai-codex.ts")) as { openaiCodexOAuth: OAuthAuth }).openaiCodexOAuth;
};

/** 按需加载 GitHub Copilot 的 OAuth 流（静态注册表优先，否则动态 import ./github-copilot.ts）。 */
export const loadGitHubCopilotOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.githubCopilot();
	return ((await importOAuthModule("./github-copilot.ts")) as { githubCopilotOAuth: OAuthAuth }).githubCopilotOAuth;
};

/** 按需加载 OpenRouter 的 OAuth 流（静态注册表优先，否则动态 import ./openrouter.ts）。 */
export const loadOpenRouterOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.openrouter();
	return ((await importOAuthModule("./openrouter.ts")) as { openRouterOAuth: OAuthAuth }).openRouterOAuth;
};

/** 按需加载 Kimi Coding 的 OAuth 流（静态注册表优先，否则动态 import ./kimi-coding.ts）。 */
export const loadKimiCodingOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.kimiCoding();
	return ((await importOAuthModule("./kimi-coding.ts")) as { kimiCodingOAuth: OAuthAuth }).kimiCodingOAuth;
};

/** 按需加载 xAI 的 OAuth 流（静态注册表优先，否则动态 import ./xai.ts）。 */
export const loadXaiOAuth = async (): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.xai();
	return ((await importOAuthModule("./xai.ts")) as { xaiOAuth: OAuthAuth }).xaiOAuth;
};

/**
 * 按需加载 Radius 网关的 OAuth 流，并按给定参数创建实例。
 * 与其他流不同，radius 模块导出的是工厂函数 createRadiusOAuth 而非单例。
 * @param options 实例配置：显示名称与网关地址
 * @returns 创建好的 Radius OAuth 流实例
 */
export const loadRadiusOAuth = async (options: { name: string; gateway: string }): Promise<OAuthAuth> => {
	if (bundledLoaders) return bundledLoaders.radius(options);
	return (
		(await importOAuthModule("./radius.ts")) as {
			createRadiusOAuth: (input: { name: string; gateway: string }) => OAuthAuth;
		}
	).createRadiusOAuth(options);
};
