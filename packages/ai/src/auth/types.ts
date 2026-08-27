/**
 * @file 认证体系核心类型定义（auth/types.ts）
 * @description
 * 多厂商 AI SDK 的认证核心抽象：
 * - ProviderAuth：provider 声明的认证方式，apiKey / oauth 至少声明其一
 * - ApiKeyAuth 三段式：login（交互输入）/ check（无副作用探测）/
 *   resolve（存储凭据优先，其次环境变量等 ambient 来源）
 * - OAuthAuth 三段式：login / refresh / toAuth；refresh 必须在
 *   CredentialStore.modify 的锁内执行，防止并发请求或多进程对已轮换
 *   的 token 做双重刷新
 * - CredentialStore：应用持有的凭据存储，modify 是唯一写路径
 *   （串行化 read-modify-write）
 * - AuthContext：可注入的 env / fileExists 抽象，保证浏览器安全
 * - AuthInteraction / AuthPrompt / AuthEvent：登录过程中的交互协议
 */
import type { ProviderEnv, ProviderHeaders } from "../types.ts";

/**
 * 单次模型请求所用的认证信息。若某个值无法用 `apiKey`、`headers` 或
 * `baseUrl` 表达，则它属于 provider 配置（provider config）而非认证。
 */
export interface ModelAuth {
	/** Bearer 风格 API key，按 provider 约定写入请求头 */
	apiKey?: string;
	/** 附加请求头（如自定义 Authorization 方案） */
	headers?: ProviderHeaders;
	/** 覆盖本次请求的 baseUrl */
	baseUrl?: string;
}

/**
 * 存储的 API key 凭据。`env` 保存 provider 作用域的环境/配置值，
 * 例如 Cloudflare 的 account/gateway id。
 */
export interface ApiKeyCredential {
	/** 类型标签，与 OAuthCredential 相区分 */
	type: "api_key";
	/** API key 本体；可缺省（例如仅配置了 env 附加值） */
	key?: string;
	/** provider 作用域的附加配置值 */
	env?: ProviderEnv;
}

/** OAuth token 数据，由扩展兼容流程返回。 */
export interface OAuthCredentials {
	/** 刷新令牌，用于换取新的 access token */
	refresh: string;
	/** 访问令牌 */
	access: string;
	/** access token 的过期时间（epoch 毫秒） */
	expires: number;
	/** 允许 provider 附加自定义字段（如 id token、scope 等） */
	[key: string]: unknown;
}

/** 存储的规范 OAuth 凭据。 */
export interface OAuthCredential extends OAuthCredentials {
	/** 类型标签，与 ApiKeyCredential 相区分 */
	type: "oauth";
}

/** 每个 provider 至多一条带类型标签的凭据——即当前 auth.json 的存储形态。 */
export type Credential = ApiKeyCredential | OAuthCredential;

/** 用于账号/状态枚举的非敏感凭据元数据。 */
export interface CredentialInfo {
	/** 凭据所属的 provider id */
	providerId: string;
	/** 凭据类型：api_key 或 oauth */
	type: Credential["type"];
}

/** 公开认证与凭据操作的可选取消参数。 */
export interface AuthOperationOptions {
	/** 中止信号，用于取消进行中的操作 */
	signal?: AbortSignal;
}

/**
 * 应用持有的凭据存储，以 `Provider.id` 为键、每个 provider 一条凭据。
 * `modify` 是唯一写路径，因此每次变更都是串行化的 read-modify-write；
 * `Models.getAuth()` 在 `modify` 内执行 OAuth 刷新，避免并发请求对已
 * 轮换的 token 双重刷新。应用在登录完成后通过
 * `modify(provider.id, async () => credential)` 持久化凭据。
 * 登录/登出的编排由应用负责。
 *
 * 错误语义：条目缺失时 `read` 以 `undefined` resolve。各方法仅在存储
 * 故障时 reject；`Models` 会把这类拒绝包装为 code 为 "auth" 的
 * `ModelsError`。「尽力而为」型存储——以内存视图即时生效、把持久化
 * 错误记录在内部（如 coding-agent 的 AuthStorage）——也是合法实现。
 */
export interface CredentialStore {
	/**
	 * 读取已存储的凭据，可能已过期。用于展示/状态查询；
	 * 请求实际使用的认证来自 `Models.getAuth()`。
	 */
	read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined>;

	/**
	 * 列出已存凭据的元数据，不解析、不暴露机密。
	 * 实现不得在列举过程中执行配置的 API-key 命令。
	 */
	list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]>;

	/**
	 * 串行化写入——唯一写路径。`fn` 能看到当前凭据，
	 * 因为正确的写入（刷新、刷新中触发登录）依赖它；
	 * 返回新凭据，返回 undefined 则保持条目不变。
	 * 互斥按 provider id 粒度，若底层存储支持（如文件锁）则跨进程互斥。
	 * 以写入后的凭据 resolve。`fn` 的拒绝会原样传播。
	 */
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined>;

	/** 移除凭据（登出）。实现需将本操作与 `modify` 串行化。 */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void>;
}

/** 认证解析用的环境访问抽象。可注入，便于测试与浏览器环境。 */
export interface AuthContext {
	/** 读取环境变量；不存在时返回 undefined */
	env(name: string): Promise<string | undefined>;
	/** 检查文件是否存在。支持前导 `~`。浏览器中恒为 false。 */
	fileExists(path: string): Promise<boolean>;
}

/** 为某个模型解析认证的结果。 */
export interface AuthResult {
	/** 请求认证信息（apiKey / headers / baseUrl） */
	auth: ModelAuth;
	/** 从凭据与环境上下文解析出的 provider 作用域环境/配置值。 */
	env?: ProviderEnv;
	/** 状态 UI 用的人类可读来源标签："ANTHROPIC_API_KEY"、"OAuth"、"~/.aws/credentials"。 */
	source?: string;
}

/** 认证可用性探测的结果。 */
export interface AuthCheck {
	/** 来源标签（如环境变量名或凭据文件路径） */
	source?: string;
	/** 认证类型 */
	type: "api_key" | "oauth";
}

/** 认证方式类型：API key 或 OAuth。 */
export type AuthType = "api_key" | "oauth";

/**
 * 登录期间展示给用户的提示。`signal` 允许在带外事件完成该步骤时
 * 取消挂起的提示，例如 `manual_code` 提示与回调服务器竞速，
 * 回调先到达时中止该提示。
 */
export type AuthPrompt = { signal?: AbortSignal } & (
	// 文本输入
	| { type: "text"; message: string; placeholder?: string }
	// 密钥输入（输入内容隐藏显示）
	| { type: "secret"; message: string; placeholder?: string }
	// 选项选择；prompt 返回所选选项的 id
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
	// 手工粘贴授权码（与回调/设备码流程配合）
	| { type: "manual_code"; message: string; placeholder?: string }
);

/** 认证信息里展示给用户的参考链接。 */
export interface AuthInfoLink {
	/** 链接地址 */
	url: string;
	/** 展示文案；缺省时 UI 可直接展示 url */
	label?: string;
}

/** 登录流程向 UI 推送的通知事件。 */
export type AuthEvent =
	// 一般信息提示，可附参考链接
	| { type: "info"; message: string; links?: readonly AuthInfoLink[] }
	// 需要用户在浏览器中打开并完成授权的 URL
	| { type: "auth_url"; url: string; instructions?: string }
	// 设备码授权：展示用户码与验证页地址
	| {
			type: "device_code";
			// 用户在验证页输入的码
			userCode: string;
			// 验证页地址
			verificationUri: string;
			// 轮询间隔（秒）
			intervalSeconds?: number;
			// 设备码有效期（秒）
			expiresInSeconds?: number;
	  }
	// 进度提示（如等待用户授权中）
	| { type: "progress"; message: string };

/**
 * 登录交互回调，同时服务于 api-key 与 OAuth 流程。
 *
 * `prompt()` 返回用户输入/选择的字符串（`select` 返回选项 id）。
 * 取消/中止时 reject。`signal` 中止整个登录流程；
 * 单个提示的取消使用 `AuthPrompt.signal`。
 */
export interface AuthInteraction {
	/** 中止整个登录流程的信号 */
	signal?: AbortSignal;

	/** 向用户发起提示并等待输入结果 */
	prompt(prompt: AuthPrompt): Promise<string>;
	/** 向用户推送事件通知（信息、授权 URL、设备码、进度） */
	notify(event: AuthEvent): void;
}

/** 传给 provider 登录实现的规范化交互（signal 必填）。 */
export type ProviderAuthInteraction = AuthInteraction & { signal: AbortSignal };

/**
 * API key 认证：存储的 key/provider env 加上环境来源（环境变量、AWS
 * profile、ADC 文件）。仅靠环境来源的 provider 可省略 `login`。
 */
export interface ApiKeyAuth {
	/** 展示名，如 "Anthropic API key"。 */
	name: string;

	/** 交互式设置（提示输入 key/provider env）。缺省 = 仅环境来源。 */
	login?(interaction: ProviderAuthInteraction): Promise<ApiKeyCredential>;

	/**
	 * 可选的无副作用可用性探测。当 `resolve()` 可能执行命令或做其他
	 * 请求期工作时使用。缺省时 Models 以「能否解析出认证」判断可用性。
	 */
	check?(input: {
		/** 环境访问上下文 */
		ctx: AuthContext;
		/** 已存储的凭据（可能不存在） */
		credential?: ApiKeyCredential;
		/** 中止信号 */
		signal: AbortSignal;
	}): Promise<AuthCheck | undefined>;

	/**
	 * 从已存储凭据和/或环境来源解析认证，按字段合并
	 * （`credential.key ?? env("...")`、`credential.env?.NAME ?? env("...")`）。
	 * 返回 undefined = 未配置。解析是 provider 作用域的；模型级
	 * endpoint 准备发生在认证解析之后。
	 */
	resolve(input: {
		/** 环境访问上下文 */
		ctx: AuthContext;
		/** 已存储的凭据（可能不存在） */
		credential?: ApiKeyCredential;
		/** 中止信号 */
		signal: AbortSignal;
	}): Promise<AuthResult | undefined>;
}

/**
 * OAuth 认证。`refresh`/`toAuth` 的拆分让 `Models` 掌控加锁刷新
 * 模式：`refresh` 产出新凭据，`toAuth` 从最终落库的凭据推导请求
 * 认证。
 */
export interface OAuthAuth {
	/** 展示名，如 "Anthropic (Claude Pro/Max)"。 */
	name: string;

	/** 该认证方式下的访问是否由 provider 订阅支撑。 */
	isSubscription?: boolean;

	/** OAuth 登录选项的选择器标签，如 "Sign in with SuperGrok or X Premium"。 */
	loginLabel?: string;

	/** 交互式 OAuth 登录，产出可存储的凭据。 */
	login(interaction: ProviderAuthInteraction): Promise<OAuthCredential>;

	/**
	 * 用 refresh token 换取新凭据。网络调用；失败时抛错
	 * （invalid_grant 等）。`Models` 在存储锁内执行本方法。
	 */
	refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;

	/**
	 * 从有效凭据无副作用地推导请求认证。
	 * 覆盖按凭据变化的 baseUrl（GitHub Copilot）。设计为 async，
	 * 以便 lazy 包装器在首次使用时才加载实现。
	 */
	toAuth(credential: OAuthCredential): Promise<ModelAuth>;
}

/**
 * Provider 认证声明。`apiKey`/`oauth` 至少存在其一：即使是纯环境
 * 凭据的 provider 与免 key 的本地服务，也要提供 `apiKey` 认证，
 * 由其 `resolve()` 报告该 provider 是否已配置。
 */
export interface ProviderAuth {
	/** API key 认证方式 */
	apiKey?: ApiKeyAuth;
	/** OAuth 认证方式 */
	oauth?: OAuthAuth;
}
