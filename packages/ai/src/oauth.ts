/**
 * @file 面向 coding-agent 扩展的 OAuth 类型纯 re-export 壳。
 * @description 本文件不含任何运行时代码，仅从 compat/extension-oauth-types.ts 转发
 * 旧版回调式 OAuth 登录接口的类型声明。coding-agent 的扩展加载器
 * （core/extensions/loader.ts）会把本模块注入为 `@earendil-works/pi-ai/oauth`
 * （及旧包名 `@mariozechner/pi-ai/oauth`）的 import 映射，供第三方扩展做类型标注；
 * 保持纯类型（type-only）是为了不让仅 Node 可用的 OAuth 实现代码被牵连进扩展运行环境。
 */
export type {
	OAuthAuthInfo,
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
