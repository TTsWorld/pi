/**
 * @file 认证构造辅助函数（auth/helpers.ts）
 * @description
 * 提供两种标准认证实现：
 * - `envApiKeyAuth`：标准的 API key 认证——存储凭据优先、其次按序取
 *   第一个已设置的环境变量；附带提示输入 key 的 login
 * - `lazyOAuth`：包装动态导入的 OAuthAuth，让 provider 定义只声明
 *   OAuth 能力而不引入 Node-only 实现代码（首次调用时才加载）
 */
import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * 标准 API key 认证：存储凭据中的 key 优先，否则用第一个已设置的
 * 环境变量解析。附带提示输入 key 的 `login`。
 * 解析逻辑非标准的 provider（provider env、环境文件、IAM）
 * 应自行编写 `ApiKeyAuth`。
 *
 * @param name 展示名（如 "Anthropic API key"），同时用于登录提示文案
 * @param envVars 候选环境变量名列表，按序取第一个有值者
 * @returns 标准 ApiKeyAuth 实现
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			// 以密钥形式提示用户输入 key（UI 隐藏显示）
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			// 存储的凭据优先于环境变量
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			// 依次尝试候选环境变量，取第一个非空值
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			// 任何来源都未配置
			return undefined;
		},
	};
}

/**
 * 包装动态导入的 `OAuthAuth`，让 provider 定义无需导入实现即可声明
 * OAuth 能力。实现代码在首次 `login`/`refresh`/`toAuth` 调用时加载；
 * 调用方通过 bundler 不透明的动态导入（变量指示符，
 * 见 bedrock 的 lazy 包装）把 Node-only 的流程代码挡在浏览器产物之外。
 *
 * @param input 声明元信息（name / isSubscription / loginLabel）与实现加载器 load
 * @returns 惰性加载实现的 OAuthAuth 包装
 */
export function lazyOAuth(input: {
	/** 展示名 */
	name: string;
	/** 该认证方式下的访问是否由 provider 订阅支撑 */
	isSubscription?: boolean;
	/** OAuth 登录选项的选择器标签 */
	loginLabel?: string;
	/** 惰性加载实际 OAuthAuth 实现的加载器（只应被调用一次） */
	load: () => Promise<OAuthAuth>;
}): OAuthAuth {
	// 缓存首次加载产生的 promise：加载只发生一次；即使失败也不会重试（??= 对已存在的 promise 不生效）
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		isSubscription: input.isSubscription,
		loginLabel: input.loginLabel,
		// 三个方法都先等待实现加载完成，再委托给真实实现
		login: async (interaction) => (await loaded()).login(interaction),
		refresh: async (credential, signal) => (await loaded()).refresh(credential, signal),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
