/**
 * @file Google Vertex AI provider 定义（google-vertex.ts）
 * @description
 * Vertex AI 是「环境凭据型」provider：认证方式不止一种，登录时可在
 * API key、ADC（Application Default Credentials）与服务账号凭据文件
 * 之间选择。三种方式最终都归一化为 ApiKeyCredential——API key 直接存入
 * key 字段；ADC / 服务账号则把 GOOGLE_CLOUD_PROJECT、
 * GOOGLE_CLOUD_LOCATION（以及可选的 GOOGLE_APPLICATION_CREDENTIALS）
 * 存入 credential.env，由底层 google-vertex API 实现自行完成令牌获取
 * 与请求签名。
 */
import { googleVertexApi } from "../api/google-vertex.lazy.ts";
import type { ApiKeyAuth } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_VERTEX_MODELS } from "./google-vertex.models.ts";

/**
 * gcloud 生成的 ADC 凭据文件默认路径（`gcloud auth application-default
 * login` 的产物）。当未显式设置 GOOGLE_APPLICATION_CREDENTIALS 时，
 * resolve 用它探测本机是否已配置 ADC。
 */
const VERTEX_ADC_PATH = "~/.config/gcloud/application_default_credentials.json";

/**
 * Vertex 接受显式 API key 或 Application Default Credentials
 * （`gcloud auth application-default login`）。ADC 额外要求 project
 * 与 location 环境变量，由底层实现自行读取。
 */
const vertexAuth: ApiKeyAuth = {
	name: "Google Cloud credentials",
	login: async (interaction) => {
		// 开始前先响应中止信号，保证登录流程可被取消
		interaction.signal.throwIfAborted();

		// 三选一：API key / ADC / 服务账号凭据文件
		const method = await interaction.prompt({
			type: "select",
			message: "Select Google Vertex AI authentication method:",
			options: [
				{ id: "api-key", label: "Google Cloud API key" },
				{ id: "adc", label: "Application Default Credentials" },
				{ id: "service-account", label: "Service account credentials file" },
			],
		});
		interaction.signal.throwIfAborted();

		// 分支一：显式 API key，直接作为凭据的 key 存储
		if (method === "api-key") {
			return {
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter Google Cloud API key" }),
			};
		}

		// 剩下的合法选项只有 adc / service-account，其余视为非法输入
		if (method !== "adc" && method !== "service-account") {
			throw new Error(`Unknown Google Vertex AI auth method: ${method}`);
		}

		// 分支二/三：ADC 或服务账号——先给出操作指引与官方文档链接
		interaction.notify({
			type: "info",
			message:
				method === "adc"
					? "Run `gcloud auth application-default login`, then provide the project and location."
					: "Provide a service account credentials file, project, and location.",
			links: [
				{
					label: "Application Default Credentials",
					url: "https://cloud.google.com/docs/authentication/provide-credentials-adc",
				},
			],
		});

		// ADC 与服务账号都需要 project 与 location
		const project = await interaction.prompt({ type: "text", message: "Enter Google Cloud project ID" });
		const location = await interaction.prompt({ type: "text", message: "Enter Google Cloud location" });

		// 仅服务账号方式需要显式的凭据文件路径；ADC 走 gcloud 默认路径
		const credentialsPath =
			method === "service-account"
				? await interaction.prompt({ type: "text", message: "Enter service account credentials file path" })
				: undefined;

		// 统一映射为「无 key、仅 env」的凭据；实际认证由底层实现读取这些变量完成
		return {
			type: "api_key",
			env: {
				GOOGLE_CLOUD_PROJECT: project,
				GOOGLE_CLOUD_LOCATION: location,
				...(credentialsPath ? { GOOGLE_APPLICATION_CREDENTIALS: credentialsPath } : {}),
			},
		};
	},
	resolve: async ({ ctx, credential, signal }) => {
		// 带中止检查的环境变量读取包装：每步 I/O 前后都响应取消
		const env = async (name: string) => {
			signal.throwIfAborted();
			const value = await ctx.env(name);
			signal.throwIfAborted();
			return value;
		};

		// 优先级 1：显式 API key——已存储的凭据 key 优先，其次环境变量 GOOGLE_CLOUD_API_KEY
		const key = credential?.key ?? (await env("GOOGLE_CLOUD_API_KEY"));
		if (key) return { auth: { apiKey: key }, source: credential?.key ? "stored credential" : "GOOGLE_CLOUD_API_KEY" };

		// 优先级 2：ADC——凭据文件路径取已存储值 ?? 环境变量 GOOGLE_APPLICATION_CREDENTIALS，
		// 都没有时回落到 gcloud 的默认 ADC 路径，再用 fileExists 探测文件是否真实存在
		const adcPath = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? (await env("GOOGLE_APPLICATION_CREDENTIALS"));
		signal.throwIfAborted();
		const hasCredentials = await ctx.fileExists(adcPath ?? VERTEX_ADC_PATH);
		signal.throwIfAborted();

		// project 兼容旧变量名 GCLOUD_PROJECT；location 只认标准变量
		const project =
			credential?.env?.GOOGLE_CLOUD_PROJECT ?? (await env("GOOGLE_CLOUD_PROJECT")) ?? (await env("GCLOUD_PROJECT"));
		const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? (await env("GOOGLE_CLOUD_LOCATION"));

		// 凭据文件 + project + location 三者齐备才认为 ADC 可用；
		// auth 为空对象（不带 apiKey），env 原样透传，令牌获取由底层 API 实现完成
		if (hasCredentials && project && location) {
			return {
				auth: {},
				env: credential?.env,
				source: credential ? "stored credential" : "gcloud application default credentials",
			};
		}

		// API key 与 ADC 均不可用 = 该 provider 未配置
		return undefined;
	},
};

/**
 * Google Vertex AI provider 工厂：用 createProvider 组装 provider id /
 * 展示名 / 认证方式 / 模型列表（来自 google-vertex.models.ts）与
 * 懒加载的 google-vertex API 实现。
 */
export function googleVertexProvider(): Provider<"google-vertex"> {
	return createProvider({
		id: "google-vertex",
		name: "Google Vertex AI",
		auth: { apiKey: vertexAuth },
		models: Object.values(GOOGLE_VERTEX_MODELS),
		api: googleVertexApi(),
	});
}
