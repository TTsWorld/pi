/**
 * @file list-models.ts —— 列出可用模型（`--list-models` 的底层实现）
 *
 * @description
 * 从 ModelRuntime 读取全部可用模型，可选做模糊搜索过滤，
 * 再以对齐的表格打印 provider / 模型 / 上下文窗口 / 最大输出 / 是否思考 / 是否支持图片。
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";

/**
 * 把 token 数格式化为人类可读缩写（如 200000 → "200K"，1000000 → "1M"）。
 * 整除时省略小数位，否则保留一位小数；不足一千时原样输出。
 */
function formatTokenCount(count: number): string {
	// 从大到小匹配数量级，保证使用尽可能大的单位
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		// 用 % 1 判断是否整除：整除时省略小数位（如 "2M"），否则保留一位（如 "1.3M"）
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

/**
 * 列出可用模型，可按搜索模式模糊过滤后打印对齐的表格。
 *
 * @param modelRuntime 模型运行时，提供可用模型与 models.json 加载错误
 * @param searchPattern 可选模糊搜索词，匹配 "provider id" 拼接串
 * @param signal 中断信号，用于中止加载模型列表的网络请求
 */
export async function listModels(
	modelRuntime: ModelRuntime,
	searchPattern?: string,
	signal?: AbortSignal,
): Promise<void> {
	// models.json 加载失败只告警不中断，继续展示已经加载到的模型
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: errors loading models.json:\n${loadError}`));
	}

	// 拷贝一份：后面排序会原地修改数组
	const models = [...(await modelRuntime.getAvailable(undefined, { signal }))];

	// 一个模型都没有：多半是还没配置任何认证，展示引导配置的消息
	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	// 提供搜索词时按 "provider id" 拼接串做模糊过滤
	// 未提供搜索词时保留全量列表
	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	// 搜索词过滤后为空：提示未匹配并正常返回
	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	// 先按 provider、再按模型 id 排序，保证输出稳定有序
	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	// 先把每个模型格式化成一行数据：token 数用缩写，布尔列用 yes/no
	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	// 表头文案；列宽计算以表头长度为下限，避免表头被挤变形
	const headers = {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	// 每列宽度取「表头与所有行」中的最大长度，用 padEnd 对齐成表格
	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	// 打印表头行（与数据行用同样的拼接方式，保证列对齐）
	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
	].join("  ");
	console.log(headerLine);

	// 逐行打印模型数据
	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
		].join("  ");
		console.log(line);
	}
}
