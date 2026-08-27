/**
 * @file Amazon Bedrock provider 定义（amazon-bedrock.ts）
 * @description
 * Bedrock 是「环境凭据型」provider：登录时可在 Bearer token、AWS profile
 * 与既有 AWS 凭据链之间选择；resolve 按 AWS SDK 标准凭据链的顺序探测
 * 环境来源（Bearer token 环境变量 → profile → 静态 access key →
 * ECS 容器凭据 → Web Identity）。探测到的 ambient 凭据不会拷贝进 pi 的
 * 凭据存储——auth 返回空对象，实际签名由 bedrock-converse-stream API
 * 实现借助 AWS SDK 完成。
 */
import { bedrockConverseStreamApi } from "../api/bedrock-converse-stream.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { AMAZON_BEDROCK_MODELS } from "./amazon-bedrock.models.ts";

/**
 * Bedrock 接受 Bearer token 或 AWS SDK 的默认凭据链。
 * 登录流程可以存储 token / profile 的选择；resolve 还能探测 ambient
 * 的 AWS 凭据，而无需把它们拷贝进 pi 的凭据存储。
 */
const bedrockAuth: ApiKeyAuth = {
	name: "AWS credentials or bearer token",
	login: async (interaction) => {
		// 开始前先响应中止信号，保证登录流程可被取消
		interaction.signal.throwIfAborted();

		// 三选一：Bearer token / AWS profile / 既有 AWS 凭据链
		const method = await interaction.prompt({
			type: "select",
			message: "Select Amazon Bedrock authentication method:",
			options: [
				{ id: "bearer-token", label: "Bearer token" },
				{ id: "aws-profile", label: "AWS profile" },
				{ id: "credential-chain", label: "Existing AWS credential chain" },
			],
		});
		interaction.signal.throwIfAborted();

		// 分支一：Bearer token，直接作为凭据的 key 存储
		if (method === "bearer-token") {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Amazon Bedrock bearer token" }),
			};
		}

		// 分支二/三：附上 AWS 凭据链官方文档链接的提示
		interaction.notify({
			type: "info",
			message: "Amazon Bedrock supports AWS profiles, IAM credentials, and role-based credentials.",
			links: [
				{
					label: "AWS credential provider chain",
					url: "https://docs.aws.amazon.com/sdkref/latest/guide/standardized-credentials.html",
				},
			],
		});

		// 分支二：AWS profile——只把 profile 名存入 credential.env
		if (method === "aws-profile") {
			return {
				type: "api_key",
				env: { AWS_PROFILE: await interaction.prompt({ type: "text", message: "Enter AWS profile name" }) },
			};
		}

		// 剩下的合法选项只有 credential-chain，其余视为非法输入
		if (method !== "credential-chain") throw new Error(`Unknown Amazon Bedrock auth method: ${method}`);

		// 分支三：让用户先自行配置好 AWS 凭据（env vars / shared config / SSO 等），
		// 按回车确认后返回一个「空」凭据，作为「已确认使用环境凭据链」的标记
		await interaction.prompt({
			type: "text",
			message: "Configure AWS credentials, then press Enter to continue",
		});
		return { type: "api_key" };
	},
	resolve: async ({ ctx, credential, signal }) => {
		// 带中止检查的环境变量读取包装：每步 I/O 前后都响应取消
		const env = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};

		// 优先级 1：已存储的 Bearer token（凭据 key），env 一并透传
		if (credential?.key) {
			return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
		}

		// 优先级 2：环境变量 AWS_BEARER_TOKEN_BEDROCK——auth 为空，
		// 由底层 API 实现自行读取该变量
		if (await env("AWS_BEARER_TOKEN_BEDROCK")) return { auth: {}, source: "AWS_BEARER_TOKEN_BEDROCK" };

		// 优先级 3：AWS profile——已存储值 ?? 环境变量 AWS_PROFILE；
		// env 透传以便 AWS SDK 按 profile 解析 shared config
		if (credential?.env?.AWS_PROFILE ?? (await env("AWS_PROFILE"))) {
			return {
				auth: {},
				env: credential?.env,
				source: credential?.env?.AWS_PROFILE ? "stored credential" : "AWS_PROFILE",
			};
		}

		// 优先级 4：静态 access key 对（AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY）
		if ((await env("AWS_ACCESS_KEY_ID")) && (await env("AWS_SECRET_ACCESS_KEY"))) {
			return { auth: {}, source: "AWS access keys" };
		}

		// 优先级 5：ECS 容器凭据——相对 URI 形式（容器内元数据代理）
		if (await env("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")) return { auth: {}, source: "ECS task role" };
		// 优先级 6：ECS 容器凭据——完整 URI 形式（自建 agent / EKS 场景）
		if (await env("AWS_CONTAINER_CREDENTIALS_FULL_URI")) return { auth: {}, source: "ECS task role" };

		// 优先级 7：Web Identity token 文件（IRSA / k8s 服务账号角色假设常见）
		if (await env("AWS_WEB_IDENTITY_TOKEN_FILE")) return { auth: {}, source: "web identity token" };

		// 所有来源均未命中 = 该 provider 未配置
		return undefined;
	},
};

/**
 * Amazon Bedrock provider 工厂：用 createProvider 组装 provider id /
 * 展示名 / 认证方式 / 模型列表（来自 amazon-bedrock.models.ts）与
 * 懒加载的 bedrock-converse-stream API 实现。
 * 注意泛型参数是 API 类型 id（"bedrock-converse-stream"），与 provider
 * id（"amazon-bedrock"）不同。
 */
export function amazonBedrockProvider(): Provider<"bedrock-converse-stream"> {
	return createProvider({
		id: "amazon-bedrock",
		name: "Amazon Bedrock",
		auth: { apiKey: bedrockAuth },
		models: Object.values(AMAZON_BEDROCK_MODELS),
		api: bedrockConverseStreamApi(),
	});
}
