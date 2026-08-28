/**
 * @file model-search.ts —— 模型选择器的搜索文本构造
 *
 * @description
 * 为模型列表项生成模糊匹配文本；选择器场景把 provider 前缀置于裸 ID 之前。
 */

/** 参与搜索匹配的模型条目（跨 provider 的最小统一结构） */
export interface ModelSearchItem {
	id: string;
	provider: string;
	name?: string;
}

/**
 * 构造通用搜索文本：以裸 ID 打头，并重复 provider、provider/id 等组合，
 * 让任意关键字段都有机会被模糊匹配命中。
 */
export function getModelSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${id} ${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/**
 * /model 选择器搜索应让「精确的 provider 前缀查询」排在 openrouter/openai/gpt-5
 * 这类代理 provider 的 ID 之前，因此不让裸模型 ID 出现在开头位置。
 */
export function getModelSelectorSearchText(item: ModelSearchItem): string {
	const { id, provider } = item;
	const name = item.name ? ` ${item.name}` : "";
	return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}
