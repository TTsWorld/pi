/**
 * @file client.ts —— llama.cpp 服务端 API 客户端
 *
 * @description
 * 本文件实现与 llama.cpp 服务端（router 模式）通信的 HTTP 客户端：
 * 封装模型目录查询（/models）、服务端属性（/props）、加载/卸载（/models/load、/models/unload）、
 * 下载提交（POST /models）以及基于 SSE 的模型事件订阅（/models/sse），
 * 并在这些原语之上提供「加载并等待完成」（loadAndWait）与「下载并等待完成」（downloadAndWait）
 * 两个可靠的复合操作。
 *
 * 主要功能点：
 * - 统一请求管道：自动 JSON 序列化、可选 Bearer 鉴权、15 秒超时，
 *   请求失败时尽量从响应体提取友好错误信息；
 * - 双通道等待策略：SSE 事件提供实时进度，目录轮询兜底 SSE 丢失的场景；
 * - 进度归一化：加载进度按阶段折算、下载进度按文件字节数汇总；
 * - 所有等待均支持 AbortSignal，取消后立即以 rejection 收尾。
 *
 * 依赖关系：
 * - 仅依赖标准 Web API（fetch / Headers / AbortSignal / TextDecoder / URL），无第三方库；
 * - 被 index.ts（扩展入口与 UI 流程）和 provider.ts（模型注册）消费。
 */

/** llama.cpp 模型的生命周期状态：未加载 / 加载中 / 已加载 / 下载中 / 空闲自动休眠（sleeping）。 */
export type LlamaModelStatus = "unloaded" | "loading" | "loaded" | "downloading" | "sleeping";

/**
 * llama.cpp 模型目录中的单个模型元数据。
 * `source === "preset"` 表示服务端内置的预设模型；`status.progress` 记录下载阶段
 * 各文件的已下载/总字节数；加载失败时 `failed` 为真，`exit_code` 携带模型进程退出码。
 */
export interface LlamaModelInfo {
	id: string;
	aliases?: string[];
	status: {
		value: LlamaModelStatus;
		args?: string[];
		failed?: boolean;
		exit_code?: number;
		progress?: Record<string, { done: number; total: number }>;
	};
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	source?: string;
	meta?: {
		n_ctx?: number;
		n_ctx_train?: number;
		size?: number;
		ftype?: string;
	};
}

/** GET /models 的响应结构：`data` 数组包含 router 可见的全部模型。 */
export interface LlamaModelsResponse {
	data: LlamaModelInfo[];
	object?: string;
}

/** GET /props 返回的服务端属性；`models_autoload` 表示 router 是否允许按需自动加载预设模型。 */
export interface LlamaServerProps {
	models_autoload?: boolean;
}

/** /models/sse 事件流推送的单条事件：目标模型名 + 事件类型 + JSON 形式的 `data` 载荷。 */
export interface LlamaModelEvent {
	model: string;
	event: string;
	data?: unknown;
}

/** 归一化后的进度回调载荷：`ratio` 为 [0,1] 的整体进度，`detail` 为人类可读明细（如已下载字节数）。 */
export interface LlamaProgress {
	message: string;
	ratio?: number;
	detail?: string;
}

/**
 * 从响应载荷中提取 `{ error: { message } }` 形式的错误文案，结构不符时回退到默认消息。
 * llama.cpp 的错误通常包在 error.message 里，此函数让调用方免于逐层判空。
 */
function errorMessage(payload: unknown, fallback: string): string {
	if (typeof payload !== "object" || payload === null) return fallback;
	const error = (payload as { error?: unknown }).error;
	if (typeof error !== "object" || error === null) return fallback;
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" && message ? message : fallback;
}

/** 类型守卫：仅要求 `id` 与 `status.value` 两个必备字段存在，用于校验目录数组项的合法性。 */
function isModelInfo(value: unknown): value is LlamaModelInfo {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { id?: unknown; status?: { value?: unknown } };
	return typeof candidate.id === "string" && typeof candidate.status?.value === "string";
}

/**
 * 把外部 AbortSignal 级联到内部 AbortController，返回解绑函数。
 * 源信号已中止时立即中止目标；否则监听 abort 事件（once），
 * 返回的函数用于清理阶段移除监听，避免泄漏。
 */
function linkSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	if (source.aborted) {
		target.abort(source.reason);
		return () => {};
	}
	const abort = () => target.abort(source.reason);
	source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

/**
 * 可中断的 sleep：ms 毫秒后 resolve，或在中止时以 signal.reason reject。
 * 超时与中止监听互相清理，避免泄漏定时器或事件监听。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("Cancelled"));
			return;
		}
		const abort = () => {
			clearTimeout(timeout);
			reject(signal?.reason ?? new Error("Cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/**
 * 把模型加载进度事件解析为 LlamaProgress。
 * 事件携带阶段列表（stages）、当前阶段（current/stage）与阶段内比例（value）；
 * 整体比例 = (当前阶段下标 + 阶段内比例) / 阶段总数，从而得到单调递增的整体进度。
 */
function parseLoadProgress(data: unknown): LlamaProgress | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const progress = (data as { progress?: unknown }).progress;
	if (typeof progress !== "object" || progress === null) return undefined;
	const value = progress as { stages?: unknown; current?: unknown; stage?: unknown; value?: unknown };
	// 阶段名随 llama.cpp 版本不同出现在 current 或 stage 字段，均缺失时退回通用文案
	const stage =
		typeof value.current === "string" ? value.current : typeof value.stage === "string" ? value.stage : undefined;
	const stages = Array.isArray(value.stages)
		? value.stages.filter((entry): entry is string => typeof entry === "string")
		: [];
	// 阶段内比例收敛到 [0,1]，防止服务端返回越界数值
	const stageRatio = typeof value.value === "number" ? Math.max(0, Math.min(1, value.value)) : undefined;
	let ratio = stageRatio;
	// 有阶段表时可折算出单调递增的整体进度：(所在阶段下标 + 阶段内比例) / 阶段总数
	if (stage && stages.length > 0) {
		const index = stages.indexOf(stage);
		if (index >= 0) ratio = (index + (stageRatio ?? 0)) / stages.length;
	}
	return {
		message: stage ? `Loading ${stage.replaceAll("_", " ")}` : "Loading model",
		ratio,
	};
}

/**
 * 把下载进度事件解析为 LlamaProgress：把所有文件的 done/total 字节数累加成整体比例。
 * 事件中的文件表可能嵌套在 progress 之下，也可能直接位于顶层，两种形态均兼容。
 */
function parseDownloadProgress(data: unknown): LlamaProgress | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	// 文件进度表兼容嵌套与顶层两种形态
	const nested = (data as { progress?: unknown }).progress;
	const files = typeof nested === "object" && nested !== null ? nested : data;
	let done = 0;
	let total = 0;
	for (const value of Object.values(files as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as { done?: unknown; total?: unknown };
		if (typeof entry.done !== "number" || typeof entry.total !== "number") continue;
		done += entry.done;
		total += entry.total;
	}
	// total <= 0 说明没有有效文件条目，视为「无进度」而不是误报 0%
	if (total <= 0) return undefined;
	return {
		message: "Downloading model",
		ratio: done / total,
		detail: `${formatBytes(done)} / ${formatBytes(total)}`,
	};
}

/** 把字节数格式化为人类可读的二进制单位字符串（KiB/MiB/GiB/TiB）；数值 ≥10 保留一位小数，否则两位。 */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = units[0]!;
	for (let index = 1; index < units.length && value >= 1024; index++) {
		value /= 1024;
		unit = units[index]!;
	}
	return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

/**
 * 归一化服务器 URL：仅接受 http/https 协议，去掉 fragment 与 query，
 * 并移除末尾斜杠与多余的 /v1 后缀（构造推理端点时会统一重新追加 /v1）。
 */
export function normalizeLlamaServerUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Server URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "") || "/";
	// 根路径「/」也归一成无尾斜杠形式，便于调用方直接拼接子路径
	return url.toString().replace(/\/$/u, "");
}

/** 构造 OpenAI 兼容推理端点：恒为「归一化后的服务器地址 + /v1」。 */
export function llamaInferenceUrl(serverUrl: string): string {
	return `${normalizeLlamaServerUrl(serverUrl)}/v1`;
}

/**
 * llama.cpp 服务端的 HTTP 客户端。
 *
 * 所有请求都经由 {@link request} 统一管道：JSON body 自动携带 Content-Type、
 * 可选 Bearer 鉴权、15 秒超时，失败时尽量从响应体提取错误信息。
 * 加载/下载等长耗时操作采用「SSE 事件 + 目录轮询」双通道：
 * 事件流提供实时进度，轮询兜底 SSE 丢失的场景。
 */
export class LlamaClient {
	readonly serverUrl: string;
	private readonly apiKey: string | undefined;

	/** @param serverUrl - 服务器地址（内部会做归一化） @param apiKey - 可选的 Bearer 鉴权密钥 */
	constructor(serverUrl: string, apiKey?: string) {
		this.serverUrl = normalizeLlamaServerUrl(serverUrl);
		this.apiKey = apiKey;
	}

	/**
	 * 向服务器发送请求并解析 JSON 响应，是全部 API 调用的公共入口。
	 * 调用方 signal 与 15 秒超时信号取「先触发者」；JSON 解析失败容忍为空载荷，
	 * 此时错误信息退化为 HTTP 状态码描述。
	 */
	private async request(path: string, init: RequestInit = {}): Promise<unknown> {
		const headers = new Headers(init.headers);
		// 仅在有请求体时才附带 Content-Type，避免 GET 请求带上多余头
		if (init.body !== undefined) headers.set("Content-Type", "application/json");
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const timeout = AbortSignal.timeout(15_000);
		const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
		const response = await fetch(`${this.serverUrl}${path}`, { ...init, headers, signal });
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (!response.ok) throw new Error(errorMessage(payload, `llama.cpp returned HTTP ${response.status}`));
		return payload;
	}

	/**
	 * 拉取模型目录；`reload: true` 时先让服务端重扫模型目录（用于发现新下载的文件）。
	 * @throws 响应形状不符或数据项缺少 id/status 时抛错——后者说明目标不是 router 模式的 llama.cpp 服务
	 */
	async list(options: { reload?: boolean; signal?: AbortSignal } = {}): Promise<LlamaModelInfo[]> {
		const payload = await this.request(`/models${options.reload ? "?reload=1" : ""}`, { signal: options.signal });
		if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
			throw new Error("llama.cpp returned an invalid model catalog");
		}
		const data = (payload as { data: unknown[] }).data;
		if (!data.every(isModelInfo)) throw new Error("Server is not running in llama.cpp router mode");
		return data;
	}

	/** 读取服务端属性（/props）；`models_autoload` 表示 router 是否允许按需自动加载预设模型。 */
	async props(options: { signal?: AbortSignal } = {}): Promise<LlamaServerProps> {
		const payload = await this.request("/props", { signal: options.signal });
		if (typeof payload !== "object" || payload === null) return {};
		const { models_autoload: modelsAutoload } = payload as Record<string, unknown>;
		return typeof modelsAutoload === "boolean" ? { models_autoload: modelsAutoload } : {};
	}

	/** 异步触发模型加载；是否完成仍需配合 loadAndWait 轮询确认。 */
	async load(model: string, signal?: AbortSignal): Promise<void> {
		await this.request("/models/load", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	/** 异步触发模型卸载；是否完成仍需轮询确认。 */
	async unload(model: string, signal?: AbortSignal): Promise<void> {
		await this.request("/models/unload", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	/**
	 * 卸载模型并轮询目录，直到该模型消失或状态变为 unloaded 才返回。
	 * 100ms 轮询间隔是响应速度与服务端负载之间的折中。
	 */
	async unloadAndWait(model: string, signal?: AbortSignal): Promise<void> {
		await this.unload(model, signal);
		while (true) {
			const entry = (await this.list({ signal })).find((candidate) => candidate.id === model);
			if (!entry || entry.status.value === "unloaded") return;
			await sleep(100, signal);
		}
	}

	/** 向服务器提交下载任务（POST /models）；实际下载发生在服务端，配合 downloadAndWait 等待完成。 */
	async download(model: string, signal?: AbortSignal): Promise<void> {
		await this.request("/models", { method: "POST", body: JSON.stringify({ model }), signal });
	}

	/**
	 * 订阅 /models/sse 事件流，对每条有效模型事件调用回调，直到流结束或被取消。
	 * 手工实现 SSE 分帧：以空行（\n\n）为事件边界，把同一事件的多行 data: 合并成一段 JSON；
	 * 读取时先把 CRLF 归一为 LF，以兼容不同服务端的换行风格。
	 */
	async watch(onEvent: (event: LlamaModelEvent) => void, signal?: AbortSignal): Promise<void> {
		const headers = new Headers();
		if (this.apiKey) headers.set("Authorization", `Bearer ${this.apiKey}`);
		const response = await fetch(`${this.serverUrl}/models/sse`, { headers, signal });
		if (!response.ok || !response.body) throw new Error(`llama.cpp SSE returned HTTP ${response.status}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			// 一个分块可能包含多条完整事件，循环逐条切出
			while (boundary >= 0) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data) {
					try {
						const event = JSON.parse(data) as LlamaModelEvent;
						if (event && typeof event.model === "string" && typeof event.event === "string") onEvent(event);
					} catch {
						// 忽略无法解析的事件；目录轮询仍是状态的权威来源。
					}
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	}

	/**
	 * 加载模型并阻塞等待其完成（或失败/取消），返回最终的目录条目。
	 *
	 * 双通道设计：SSE 事件流提供实时阶段进度与「已加载」信号；目录轮询兜底 SSE 丢失的场景，
	 * 且能读到 failed / exit_code 等错误细节。SSE 已报 loaded 但目录尚未刷新的竞态
	 * 由本地构造的兜底条目兜住，避免永久等待。
	 *
	 * @param model - 模型 id
	 * @param onProgress - 进度回调（message + ratio，可能被多次调用）
	 * @param signal - 取消信号；取消时以 signal.reason reject
	 * @returns 加载完成的模型条目
	 * @throws 加载失败（含进程退出码）或被取消时抛错
	 */
	async loadAndWait(
		model: string,
		onProgress: (progress: LlamaProgress) => void,
		signal?: AbortSignal,
	): Promise<LlamaModelInfo> {
		const watcher = new AbortController();
		const unlink = linkSignal(signal, watcher);
		// SSE 通道观察到的状态翻转：loaded 视为成功；反之在加载请求之后出现 unloaded 视为失败
		let eventLoaded = false;
		let eventError: string | undefined;
		// 事件通道：只关心目标模型的 model_status / status_change 事件；流断开由轮询兜底，故吞掉异常
		void this.watch((event) => {
			if (event.model !== model) return;
			if (event.event !== "model_status" && event.event !== "status_change") return;
			const data = event.data as { status?: unknown } | undefined;
			if (data?.status === "loaded") eventLoaded = true;
			if (data?.status === "unloaded") eventError = "Model failed to load";
			const progress = parseLoadProgress(event.data);
			if (progress) onProgress(progress);
		}, watcher.signal).catch(() => {});
		try {
			await this.load(model, signal);
			onProgress({ message: "Loading model" });
			while (true) {
				if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
				const entry = (await this.list({ signal })).find((candidate) => candidate.id === model);
				if (entry?.status.value === "loaded") return entry;
				// 竞态兜底：SSE 已报 loaded 但目录尚未出现该模型，直接构造最小条目返回
				if (eventLoaded && !entry) return { id: model, status: { value: "loaded" } };
				if (entry?.status.failed || eventError) {
					throw new Error(
						entry?.status.exit_code === undefined
							? (eventError ?? "Model failed to load")
							: `Model exited with code ${entry.status.exit_code}`,
					);
				}
				await sleep(250, signal);
			}
		} finally {
			unlink();
			watcher.abort();
		}
	}

	/**
	 * 下载模型并等待完成，返回重新拉取的目录（带 reload）。
	 *
	 * 完成条件（满足其一）：
	 * - SSE 传来 download_finished 事件；
	 * - 轮询时状态已不是 downloading，且此前观察到过下载中
	 *   （或至少轮询满 2 次，兜底没有 SSE 事件的服务端）。
	 * 完成后必须重新执行 `list({ reload: true })`，让服务端重扫模型目录，
	 * 新下载的文件才会出现在目录里。
	 *
	 * @param model - 模型 id（可携带 `repo:quantization` 形式的量化后缀）
	 * @param onProgress - 进度回调（含已下载字节数明细）
	 * @param signal - 取消信号
	 * @returns 下载完成后重新拉取的模型目录
	 * @throws 下载失败（download_failed 事件）或被取消时抛错
	 */
	async downloadAndWait(
		model: string,
		onProgress: (progress: LlamaProgress) => void,
		signal?: AbortSignal,
	): Promise<LlamaModelInfo[]> {
		const watcher = new AbortController();
		const unlink = linkSignal(signal, watcher);
		let finished = false;
		let failure: string | undefined;
		let sawDownloading = false;
		// 轮询计数：SSE 缺失时，至少轮询 2 次且从未见到下载中，才认为「并非在下载」，
		// 避免首次轮询撞上旧目录而误判为已完成
		let polls = 0;
		// 事件通道：只处理目标模型的下载完成/失败/进度事件；流断开由轮询兜底
		void this.watch((event) => {
			if (event.model !== model) return;
			if (event.event === "download_finished") finished = true;
			if (event.event === "download_failed") failure = errorMessage(event.data, "Download failed");
			if (event.event === "download_progress") {
				sawDownloading = true;
				const progress = parseDownloadProgress(event.data);
				if (progress) onProgress(progress);
			}
		}, watcher.signal).catch(() => {});
		try {
			await this.download(model, signal);
			onProgress({ message: "Downloading model" });
			while (true) {
				if (signal?.aborted) throw signal.reason ?? new Error("Cancelled");
				if (failure) throw new Error(failure);
				const models = await this.list({ signal });
				polls++;
				const entry = models.find((candidate) => candidate.id === model);
				if (entry?.status.value === "downloading") {
					sawDownloading = true;
					const progress = parseDownloadProgress(entry.status.progress);
					if (progress) onProgress(progress);
				} else if (finished || (entry && (sawDownloading || polls >= 2))) {
					return this.list({ reload: true, signal });
				}
				await sleep(500, signal);
			}
		} finally {
			unlink();
			watcher.abort();
		}
	}
}
