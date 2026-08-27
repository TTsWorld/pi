/**
 * @file Bun 单文件二进制专用的 OAuth 流程静态注册入口。
 * @description OAuth 流程模块默认在 auth/oauth/load.ts 中通过「变量 specifier」动态
 * import 懒加载，以避免打包器顺着静态 import 追进仅 Node 可用的代码（node:fs 回调
 * 服务器、node:crypto PKCE）。但 Bun 的单文件编译产物无法打包这类动态 import，因此
 * 本文件在构建期静态引入全部 7 个内置流程，供 registerBunOAuthFlows() 一次性注册。
 * 常规 Node/浏览器构建不要引用本文件，否则会失去懒加载带来的体积与运行时兼容收益。
 */
import { anthropicOAuth } from "./auth/oauth/anthropic.ts";
import { githubCopilotOAuth } from "./auth/oauth/github-copilot.ts";
import { kimiCodingOAuth } from "./auth/oauth/kimi-coding.ts";
import { registerBundledOAuthFlowLoaders } from "./auth/oauth/load.ts";
import { openaiCodexOAuth } from "./auth/oauth/openai-codex.ts";
import { openRouterOAuth } from "./auth/oauth/openrouter.ts";
import { createRadiusOAuth } from "./auth/oauth/radius.ts";
import { xaiOAuth } from "./auth/oauth/xai.ts";

/**
 * 将 7 个内置 OAuth 流程（anthropic / openaiCodex / githubCopilot / openrouter /
 * kimiCoding / xai / radius）以静态 import 的形式注册进 OAuth 流程加载器
 * （registerBundledOAuthFlowLoaders）。注册后 load.ts 中的各 loadXxxOAuth 会直接
 * 返回这里的静态模块，不再尝试动态 import。
 * 使用场景：仅限 Bun 单文件二进制入口（coding-agent 的 src/bun/cli.ts）启动时调用；
 * 注意 radius 传入的是工厂函数 createRadiusOAuth，因为它需要按网关配置即时创建实例。
 */
export function registerBunOAuthFlows(): void {
	registerBundledOAuthFlowLoaders({
		anthropic: () => anthropicOAuth,
		openaiCodex: () => openaiCodexOAuth,
		githubCopilot: () => githubCopilotOAuth,
		openrouter: () => openRouterOAuth,
		kimiCoding: () => kimiCodingOAuth,
		xai: () => xaiOAuth,
		radius: createRadiusOAuth,
	});
}
