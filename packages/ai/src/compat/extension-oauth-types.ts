/**
 * @file 浏览器扩展（coding-agent extension）的 OAuth 兼容类型
 * @description 旧版扩展使用回调式的 OAuth 登录接口（onAuth / onDeviceCode / onPrompt 等），
 * 与新的事件流式接口（AuthPrompt + notify 事件）不同。本文件仅为保持扩展兼容而保留这些类型。
 */

import type { OAuthCredentials } from "../auth/types.ts";

/** 旧版扩展的 OAuth 文本输入提示。 */
export interface OAuthPrompt {
	/** 提示给用户的消息 */
	message: string;
	/** 输入框占位文本 */
	placeholder?: string;
	/** 是否允许提交空输入 */
	allowEmpty?: boolean;
}

/** 旧版扩展的 OAuth 授权链接通知。 */
export interface OAuthAuthInfo {
	/** 需要用户在浏览器中打开的授权链接 */
	url: string;
	/** 附加的操作说明 */
	instructions?: string;
}

/** 旧版扩展的 OAuth 设备码通知。 */
export interface OAuthDeviceCodeInfo {
	/** 用户需在验证页面手动输入的码 */
	userCode: string;
	/** 设备码验证链接 */
	verificationUri: string;
	/** 轮询令牌状态的间隔（秒） */
	intervalSeconds?: number;
	/** 设备码的有效期（秒） */
	expiresInSeconds?: number;
}

/** 选择题提示的单个选项。 */
export interface OAuthSelectOption {
	/** 选项标识（回传给 provider 的值） */
	id: string;
	/** 展示给用户的选项文本 */
	label: string;
}

/** 选择题式提示：让用户从固定选项中挑一个。 */
export interface OAuthSelectPrompt {
	/** 提示给用户的消息 */
	message: string;
	/** 可选项列表 */
	options: OAuthSelectOption[];
}

/** 仅为兼容 coding-agent 扩展而保留的回调接口。 */
export interface OAuthLoginCallbacks {
	/** 收到授权链接时回调（授权码流程） */
	onAuth(info: OAuthAuthInfo): void;
	/** 收到设备码时回调（设备码流程） */
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	/** 需要用户输入文本（如账号、实例地址）时回调；resolve 返回用户输入 */
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	/** 进度提示回调 */
	onProgress?(message: string): void;
	/** 用户手动输入/粘贴授权码时回调；resolve 返回输入内容 */
	onManualCodeInput?(): Promise<string>;
	/** 选择题提示回调；resolve 返回所选选项 id，取消时返回 undefined */
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	/** 用于中断登录流程的中止信号 */
	signal?: AbortSignal;
}

/** 透传 OAuthCredentials 类型，便于扩展侧从本兼容模块统一导入 */
export type { OAuthCredentials };
