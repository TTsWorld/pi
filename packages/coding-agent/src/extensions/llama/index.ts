/**
 * @file index.ts —— llama.cpp 内置（hidden）扩展入口
 *
 * @description
 * 本文件向编码助手注册 llama.cpp 扩展：把本地 llama.cpp 服务端暴露的模型注册为
 * pi Provider，并提供 `/llama` 命令，在 TUI 中以交互方式管理模型——
 * 浏览模型目录、加载/卸载模型、从 Hugging Face 搜索并下载 GGUF 模型。
 *
 * 主要功能点：
 * - 启动时注册 Provider（createLlamaProvider），后续按需同步模型目录；
 * - `/llama` 命令主循环：读取目录 → 展示模型列表 → 分发加载/卸载/下载动作 → 刷新目录；
 * - 连接失败可让用户选择重试或关闭；非连接类错误只做通知，不打断主循环；
 * - 下载流程集成 Hugging Face 搜索、gated 模型提示与量化格式（quantization）选择。
 *
 * 依赖关系：
 * - ./client.ts：LlamaClient HTTP 客户端与目录类型、formatBytes 工具；
 * - ./huggingface.ts：Hugging Face 令牌发现、模型搜索与详情；
 * - ./provider.ts：Provider 定义、目录同步（setCatalog）；
 * - ./ui.ts：TUI 进度与选择交互（LlamaUi / runWithProgress / showLlamaUi）。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { formatBytes, LlamaClient, type LlamaModelInfo, normalizeLlamaServerUrl } from "./client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "./huggingface.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "./provider.ts";
import { type LlamaUi, runWithProgress, showLlamaUi } from "./ui.ts";

/** 模型当前是否「可用」：已加载，或空闲休眠（sleeping，请求到达时会自动唤醒）。 */
function modelIsLoaded(model: LlamaModelInfo): boolean {
	return model.status.value === "loaded" || model.status.value === "sleeping";
}

/** 通过错误消息特征（fetch failed / timeout / network）判断是否为网络连接类失败，用于决定可否重试。 */
function isConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const message = `${error.name} ${error.message}`.toLowerCase();
	return message.includes("fetch failed") || message.includes("timeout") || message.includes("network");
}

/** 连接类错误统一替换为更友好的提示文案，其余错误原样透出消息内容。 */
function connectionErrorMessage(error: unknown): string {
	if (isConnectionError(error)) return "Could not connect to the server.";
	return error instanceof Error ? error.message : String(error);
}

/**
 * 解析 `owner/repo:quantization` 形式的模型引用，拆出仓库 id 与量化格式。
 * 只在首个 `/` 之后再寻找 `:`，避免把仓库路径分隔符误当作量化后缀分隔。
 */
function parseHuggingFaceModel(value: string): { repository: string; quantization?: string } {
	const colon = value.indexOf(":", value.indexOf("/") + 1);
	return colon < 0
		? { repository: value }
		: { repository: value.slice(0, colon), quantization: value.slice(colon + 1) };
}

/**
 * 读取已保存的 llama.cpp 凭据并构造 LlamaClient。
 * 未配置凭据时提示用户先执行 `/login llama.cpp` 并返回 undefined；
 * 服务器地址优先取凭据 env 的 LLAMA_BASE_URL，回退到凭据记录的 baseUrl。
 */
async function configuredClient(ctx: ExtensionCommandContext): Promise<LlamaClient | undefined> {
	const result = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER_ID);
	if (!result) {
		ctx.ui.notify(`Configure llama.cpp with /login ${LLAMA_PROVIDER_ID}`, "warning");
		return undefined;
	}
	const configuredUrl = result.env?.LLAMA_BASE_URL;
	const serverUrl = normalizeLlamaServerUrl(
		typeof configuredUrl === "string" && configuredUrl ? configuredUrl : (result.auth.baseUrl ?? ""),
	);
	return new LlamaClient(serverUrl, result.auth.apiKey);
}

/**
 * llama.cpp 扩展入口：注册 Provider 与 `/llama` 命令。
 * 命令仅在 TUI（交互）模式可用，内部运行一个「列目录 → 选动作 → 刷新」的常驻循环，
 * 直到用户关闭面板。
 */
export default function llamaExtension(pi: ExtensionAPI): void {
	const provider = createLlamaProvider();
	pi.registerProvider(provider.provider);

	/**
	 * 拉取最新模型目录，推送给 Provider 并刷新模型注册表。
	 * 每个目录操作（加载/卸载/下载）完成后都会调用它，保证 UI 与注册表一致。
	 */
	const syncCatalog = async (
		ctx: ExtensionCommandContext,
		client: LlamaClient,
		catalog?: LlamaModelInfo[],
	): Promise<LlamaModelInfo[]> => {
		const signal = AbortSignal.timeout(15_000);
		const current = catalog ?? (await client.list({ signal }));
		provider.setCatalog(current, client.serverUrl);
		const result = await ctx.modelRegistry.refresh({
			providers: [LLAMA_PROVIDER_ID],
			// /llama 已访问过配置的 llama.cpp 服务器，因此即便处于 PI_OFFLINE 也让这次刷新保持联网。
			allowNetwork: true,
			signal,
		});
		if (result.aborted) throw new Error("Model catalog refresh timed out.");
		const refreshError = result.errors.get(LLAMA_PROVIDER_ID);
		if (refreshError) throw refreshError;
		return current;
	};

	/**
	 * 加载目标模型；若已有其他模型处于加载态，先询问用户「卸载后加载」还是「并存加载」。
	 * 选择替换时先卸载旧模型；后续加载失败或被取消时尽力恢复原有模型，
	 * 恢复过程中出现的异常被吞掉，以免掩盖原始的加载错误。
	 */
	const loadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		client: LlamaClient,
		catalog: LlamaModelInfo[],
		target: LlamaModelInfo,
	): Promise<void> => {
		// 目录中除目标外已加载（或休眠）的其他模型，用于决定是否需要替换加载
		const loaded = catalog.filter((model) => model.id !== target.id && modelIsLoaded(model));
		let replace = false;
		if (loaded.length > 0) {
			const choice = await ui.select(`${loaded.length} model${loaded.length === 1 ? " is" : "s are"} loaded`, [
				"Unload all and load",
				"Keep loaded and load",
				"Cancel",
			]);
			if (!choice || choice === "Cancel") return;
			replace = choice === "Unload all and load";
		}

		// 恢复现场：重新加载此前被卸载的模型并同步目录
		const restoreLoaded = async (): Promise<void> => {
			ctx.ui.notify("Restoring previously loaded models");
			for (const model of loaded) await client.loadAndWait(model.id, () => {});
			await syncCatalog(ctx, client);
		};
		if (replace) {
			for (const model of loaded) await client.unloadAndWait(model.id);
		}

		try {
			const result = await runWithProgress(ui, {
				title: "Loading model",
				model: target.id,
				initialMessage: "Starting…",
				cancelTitle: "Stop loading?",
				cancelMessage: target.id,
				run: (signal, update) => client.loadAndWait(target.id, update, signal),
				cancel: () => client.unload(target.id),
			});
			if (result.cancelled) {
				if (replace) await restoreLoaded();
				return;
			}
			const refreshed = await syncCatalog(ctx, client);
			const loadedModel = refreshed.find((model) => model.id === target.id);
			ctx.ui.notify(
				loadedModel?.status.value === "loaded" ? `Loaded ${target.id}` : `Load started for ${target.id}`,
			);
		} catch (error) {
			if (replace) {
				try {
					await restoreLoaded();
				} catch {
					// 吞掉恢复现场的异常，保留并抛出原始的加载错误。
				}
			}
			throw error;
		}
	};

	/** 经用户确认后卸载模型，并同步目录与注册表。 */
	const unloadModel = async (
		ctx: ExtensionCommandContext,
		ui: LlamaUi,
		client: LlamaClient,
		model: LlamaModelInfo,
	): Promise<void> => {
		if (!(await ui.confirm("Unload model?", model.id))) return;
		await client.unloadAndWait(model.id);
		await syncCatalog(ctx, client);
		ctx.ui.notify(`Unloaded ${model.id}`);
	};

	/**
	 * 交互式下载流程：Hugging Face 搜索 → 选择模型 → gated 访问提示 →
	 * 选择量化格式 → 由 llama.cpp 服务端下载，完成后同步目录。
	 */
	const downloadModel = async (ctx: ExtensionCommandContext, ui: LlamaUi, client: LlamaClient): Promise<void> => {
		const huggingFace = new HuggingFaceClient(await findHuggingFaceToken());
		const selected = await ui.searchModels((query, signal) => huggingFace.search(query, signal));
		if (!selected) return;
		const parsed = parseHuggingFaceModel(selected);
		ui.showStatus("Loading model details", parsed.repository);
		const details = await huggingFace.details(parsed.repository);
		// gated 仓库需要先在网页上申请访问权限，且服务端的 HF_TOKEN 必须已获得授权
		if (details.gated) {
			const approval = details.gated === "manual" ? "Manual approval is required" : "Accept the access terms";
			const choice = await ui.select(
				`Hugging Face access required\n${details.id}\n\n${approval} at:\nhttps://huggingface.co/${details.id}\n\nThe llama.cpp server needs HF_TOKEN with access.`,
				["Continue", "Back"],
			);
			if (choice !== "Continue") return;
		}
		let quantization = parsed.quantization;
		// 引用未携带量化后缀且仓库提供多种量化时，让用户挑选；Q4_K_M 额外标注为推荐项
		if (!quantization && details.quantizations.length > 0) {
			const options = details.quantizations.map((entry) => {
				const detail = [
					entry.size === undefined ? undefined : formatBytes(entry.size),
					entry.name === "Q4_K_M" ? "recommended" : undefined,
				]
					.filter((value): value is string => Boolean(value))
					.join(" · ");
				return detail ? `${entry.name} · ${detail}` : entry.name;
			});
			const choice = await ui.select(`Select quantization\n${details.id}`, options);
			if (!choice) return;
			quantization = details.quantizations[options.indexOf(choice)]?.name;
			if (!quantization) return;
		}
		const model = quantization ? `${details.id}:${quantization}` : details.id;
		const result = await runWithProgress(ui, {
			title: "Downloading model",
			model,
			initialMessage: "Starting…",
			cancelTitle: "Stop download?",
			cancelMessage: model,
			run: (signal, update) => client.downloadAndWait(model, update, signal),
			cancel: () => client.unload(model),
		});
		if (result.cancelled) return;
		await syncCatalog(ctx, client, result.value);
		ctx.ui.notify(`Downloaded ${model}`);
	};

	/**
	 * `/llama` 命令：仅在 TUI（交互）模式下可用。
	 * 主循环每执行一个动作后都强制重读目录再渲染；连接失败时交给用户选择重试或关闭，
	 * 其他错误只做通知，不中断循环。
	 */
	pi.registerCommand("llama", {
		description: "Manage llama.cpp router models",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/llama is available in interactive mode", "warning");
				return;
			}
			const client = await configuredClient(ctx);
			if (!client) return;
			await showLlamaUi(ctx, async (ui) => {
				// 读取目录；连接失败时由用户决定重试还是关闭面板（返回 undefined 表示关闭）
				const readCatalog = async (): Promise<LlamaModelInfo[] | undefined> => {
					while (true) {
						try {
							return await syncCatalog(ctx, client);
						} catch (error) {
							if ((await ui.connectionError(client.serverUrl, connectionErrorMessage(error))) === "close") {
								return undefined;
							}
						}
					}
				};

				let catalog = await readCatalog();
				if (!catalog) return;
				// 模型列表主循环：渲染目录 → 处理一个动作 → 重新读取目录，直到用户关闭
				while (true) {
					const action = await ui.showModels(client.serverUrl, catalog);
					if (action.type === "close") return;
					let actionError: unknown;
					try {
						if (action.type === "download") await downloadModel(ctx, ui, client);
						else if (modelIsLoaded(action.model)) await unloadModel(ctx, ui, client, action.model);
						else if (action.model.status.value === "unloaded")
							await loadModel(ctx, ui, client, catalog, action.model);
						else ctx.ui.notify(`${action.model.id} is ${action.model.status.value}`, "warning");
					} catch (error) {
						actionError = error;
					}
					const refreshed = await readCatalog();
					if (!refreshed) return;
					catalog = refreshed;
					if (actionError && !isConnectionError(actionError)) {
						ctx.ui.notify(actionError instanceof Error ? actionError.message : String(actionError), "error");
					}
				}
			});
		},
	});
}
