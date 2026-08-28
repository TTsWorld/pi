/**
 * @file huggingface.ts —— Hugging Face 模型元数据客户端
 *
 * @description
 * 本文件为 /llama 下载流程提供 Hugging Face 侧支持：
 * - findHuggingFaceToken：按「HF_TOKEN 环境变量 → HF_TOKEN_PATH → HF_HOME →
 *   XDG 缓存 → 默认用户缓存」的顺序发现本机已有的访问令牌；
 * - HuggingFaceClient：封装 /api/models 搜索与详情查询，从仓库文件列表中
 *   归纳出可用的 GGUF 量化格式（名称与总大小），并处理限流（429）提示。
 *
 * 依赖关系：
 * - 仅依赖 Node 标准库（fs/promises、os、path）与 Web fetch API；
 * - 由 index.ts 的下载流程消费（searchModels 搜索 / details 详情）。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_HUGGING_FACE_URL = "https://huggingface.co";
/** 从 GGUF 文件名主干中提取量化格式的正则，覆盖 Q4_K_M、IQ3_XS、UD-Q4_K_XL、BF16、MXFP4 等形态。 */
const QUANTIZATION_PATTERN =
	/(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)+|Q\d(?:_[A-Z0-9]+)+|BF16|F16|F32|MXFP\d(?:_[A-Z0-9]+)*))$/iu;
/** 去掉分片后缀（如 -00001-of-00003）的正则，使同一模型的多个分片归并到同一量化条目。 */
const SHARD_SUFFIX_PATTERN = /-\d{5}-of-\d{5}$/u;

/** 搜索结果中的模型条目：仓库 id 与下载量（用于排序展示）。 */
export interface HuggingFaceModel {
	id: string;
	downloads: number;
}

/** 一种可用的量化格式：名称（如 Q4_K_M）与全部文件的总字节数（任一分片缺 size 时为 undefined）。 */
export interface HuggingFaceQuantization {
	name: string;
	size?: number;
}

/** 模型详情：gated 取值 false / "auto"（自动通过）/ "manual"（需人工审批），以及可用量化列表。 */
export interface HuggingFaceModelDetails {
	id: string;
	gated: false | "auto" | "manual";
	quantizations: HuggingFaceQuantization[];
}

/**
 * 从响应载荷中提取 error 字符串，结构不符时回退默认消息。
 * Hugging Face 的错误载荷形如 { error: "..." }，与 llama.cpp 的嵌套结构不同。
 */
function payloadError(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error = (payload as { error?: unknown }).error;
	return typeof error === "string" && error ? error : fallback;
}

/** 从 x-ratelimit 头解析下次可用秒数（形如 `...,t=30`）；Retry-After 缺失时用它生成限流提示。 */
function parseRateLimitDelay(value: string | null): number | undefined {
	const match = value?.match(/(?:^|;)t=(\d+)/u);
	return match ? Number(match[1]) : undefined;
}

/** 读取令牌文件并去空白；文件不存在或读取失败一律返回 undefined（令牌是可选项）。 */
async function readToken(path: string): Promise<string | undefined> {
	try {
		const token = (await readFile(path, "utf8")).trim();
		return token || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 发现本机 Hugging Face 访问令牌：优先 HF_TOKEN 环境变量，
 * 再依次探测 HF_TOKEN_PATH、HF_HOME/token、XDG_CACHE_HOME/huggingface/token、
 * ~/.cache/huggingface/token（与 huggingface-cli 的令牌存储位置保持一致）。
 */
export async function findHuggingFaceToken(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	const fromEnvironment = env.HF_TOKEN?.trim();
	if (fromEnvironment) return fromEnvironment;

	const paths = [
		env.HF_TOKEN_PATH,
		env.HF_HOME ? join(env.HF_HOME, "token") : undefined,
		env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, "huggingface", "token") : undefined,
		join(homedir(), ".cache", "huggingface", "token"),
	].filter((path): path is string => Boolean(path));
	for (const path of new Set(paths)) {
		const token = await readToken(path);
		if (token) return token;
	}
	return undefined;
}

/**
 * Hugging Face Hub 的只读 API 客户端。
 * 全部请求统一带 15 秒超时与可选 Bearer 令牌；命中 429 限流时，
 * 尽量把需要等待的秒数带进错误消息，方便用户决定是否稍后重试。
 */
export class HuggingFaceClient {
	private readonly token: string | undefined;
	private readonly baseUrl: string;

	constructor(token?: string, baseUrl = DEFAULT_HUGGING_FACE_URL) {
		this.token = token;
		this.baseUrl = baseUrl.replace(/\/+$/u, "");
	}

	/** 发起 GET 请求并解析 JSON；调用方 signal 与 15 秒超时取先触发者，非 2xx 时抛出友好错误。 */
	private async request(path: string, signal?: AbortSignal): Promise<unknown> {
		const headers = new Headers();
		if (this.token) headers.set("Authorization", `Bearer ${this.token}`);
		const timeout = AbortSignal.timeout(15_000);
		const response = await fetch(`${this.baseUrl}${path}`, {
			headers,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) {
			const fallback = `Hugging Face returned HTTP ${response.status}`;
			if (response.status === 429) {
				const delay =
					Number(response.headers.get("retry-after")) || parseRateLimitDelay(response.headers.get("ratelimit"));
				throw new Error(
					delay ? `Hugging Face rate limit reached; retry in ${delay}s` : "Hugging Face rate limit reached",
				);
			}
			throw new Error(payloadError(payload, fallback));
		}
		return payload;
	}

	/** 按关键词搜索 GGUF 模型，按下载量降序取前 20 条；载荷不是数组时视为非法响应。 */
	async search(query: string, signal?: AbortSignal): Promise<HuggingFaceModel[]> {
		// filter=gguf 只返回带 GGUF 文件的仓库，direction=-1 配合 sort 按下载量降序
		const params = new URLSearchParams({
			search: query,
			filter: "gguf",
			sort: "downloads",
			direction: "-1",
			limit: "20",
		});
		const payload = await this.request(`/api/models?${params}`, signal);
		if (!Array.isArray(payload)) throw new Error("Hugging Face returned invalid search results");
		return payload.flatMap((value) => {
			if (typeof value !== "object" || value === null || typeof (value as { id?: unknown }).id !== "string")
				return [];
			const model = value as { id: string; downloads?: unknown };
			return [{ id: model.id, downloads: typeof model.downloads === "number" ? model.downloads : 0 }];
		});
	}

	/**
	 * 查询模型详情（含文件列表 blobs），并从 GGUF 文件名归纳出量化列表：
	 * - 跳过 mmproj 开头的多模态投影文件（不是语言模型本体，不应计入体积）；
	 * - 去掉分片后缀后，同一量化的多个分片累加字节数，任一分片缺 size 则该量化体积未知；
	 * - 排序：Q4_K_M 置顶（通用推荐档），其余按体积升序，体积未知者排最后。
	 */
	async details(id: string, signal?: AbortSignal): Promise<HuggingFaceModelDetails> {
		// 仓库 id 的每一段单独编码，防止名称中的特殊字符破坏 URL
		const encodedId = id.split("/").map(encodeURIComponent).join("/");
		const payload = await this.request(`/api/models/${encodedId}?blobs=true`, signal);
		if (typeof payload !== "object" || payload === null) {
			throw new Error("Hugging Face returned invalid model details");
		}
		const model = payload as { id?: unknown; gated?: unknown; siblings?: unknown };
		const sizes = new Map<string, { total: number; complete: boolean }>();
		if (Array.isArray(model.siblings)) {
			for (const value of model.siblings) {
				if (typeof value !== "object" || value === null) continue;
				const file = value as { rfilename?: unknown; size?: unknown };
				if (typeof file.rfilename !== "string" || !file.rfilename.toLowerCase().endsWith(".gguf")) continue;
				const filename = file.rfilename.split("/").at(-1)!;
				if (filename.toLowerCase().startsWith("mmproj")) continue;
				// 去掉 .gguf 扩展名与分片后缀得到主干，再从主干提取量化名（统一大写）
				const stem = filename.slice(0, -5).replace(SHARD_SUFFIX_PATTERN, "");
				const quantization = stem.match(QUANTIZATION_PATTERN)?.[1]?.toUpperCase();
				if (!quantization) continue;
				const current = sizes.get(quantization) ?? { total: 0, complete: true };
				if (typeof file.size === "number") current.total += file.size;
				else current.complete = false;
				sizes.set(quantization, current);
			}
		}
		const quantizations = [...sizes]
			.map(([name, size]) => ({ name, size: size.complete ? size.total : undefined }))
			.sort((left, right) => {
				if (left.name === "Q4_K_M") return -1;
				if (right.name === "Q4_K_M") return 1;
				return (
					(left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER) ||
					left.name.localeCompare(right.name)
				);
			});
		return {
			id: typeof model.id === "string" ? model.id : id,
			gated: model.gated === "auto" || model.gated === "manual" ? model.gated : false,
			quantizations,
		};
	}
}
