/**
 * @file 模型目录的类型基建（model-catalog）。
 *
 * @description 供自动生成的 `*.models.ts` 使用。生成的文件里，模型数据以
 * 「按 API 分组」的 JSON 形式书写（外层 key 是 API 名、内层 key 是模型 ID）；
 * 本文件提供 ModelGroups/ModelCatalog 类型与 flattenModelCatalog 函数，把这种
 * 分组结构在运行时摊平成一张「模型 ID -> 模型定义」的平表，并在类型层面把
 * 每个模型 ID 收窄成字面量类型、反查出它所属的 API，从而让 `Model<Api>` 的
 * 泛型参数精确到具体 API 而非宽泛的 string。
 */

import type { Api, Model, ProviderId } from "./types.ts";

/**
 * 「按 API 分组」的模型数据形状：外层 key 为 API 名（如 "openai-completions"），
 * 内层 key 为模型 ID，值为该模型的元数据对象。
 * 刻意用宽泛的 Record/object 而非具体字段，让字面量类型由调用处传入的常量推断。
 */
export type ModelGroups = Record<string, Record<string, object>>;

/**
 * 从分组结构中提取「所有模型 ID 的联合类型」。
 * 先对每个 API 取其内层 key（即该组下的模型 ID），再用 `[keyof TGroups]`
 * 索引把各组的结果并成一个联合；结尾 `& string` 保证最终是字符串字面量
 * 联合而非宽化的 string。
 */
type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

/**
 * 反查：给定模型 ID，求出「包含该模型的那些 API」的联合类型。
 * 对每个 API 判断该 ID 是否为其内层 key：是则保留该 API 名，否则映射为 never，
 * 最后索引合并时 never 自动被丢弃；`& Api` 把结果约束为合法的 API 名。
 */
type ModelApi<TGroups extends ModelGroups, TModelId extends ModelId<TGroups>> = {
	[TApi in keyof TGroups]: TModelId extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups] &
	Api;

/**
 * 摊平后的模型目录：把每个模型 ID 映射为 `Model<该模型所属的 API>`，
 * 并用交叉类型强制 `id` 为该模型 ID 的字面量、`provider` 为给定的 provider 字面量。
 * 这样目录中的每个条目都带有精确的字面量类型，而非宽泛的 string。
 *
 * @template TGroups 分组结构的字面量类型（由 flattenModelCatalog 的 const 泛型推断）
 * @template TProvider provider ID 的字面量类型
 */
export type ModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TModelId in ModelId<TGroups>]: Model<ModelApi<TGroups, TModelId>> & {
		id: TModelId;
		provider: TProvider;
	};
};

/**
 * 把「按 API 分组」的模型数据摊平成一张模型目录。
 * 运行时仅做一次浅合并；繁重的类型收窄全部发生在返回类型 ModelCatalog 上。
 *
 * @param _provider provider ID。运行时不使用（故加下划线前缀），
 * 仅用于在类型层面捕获 provider 字面量，写进目录中每个条目的 provider 字段
 * @param groups 按 API 分组的模型数据
 * @returns 摊平后的模型目录，每个条目带精确的模型 ID / API / provider 字面量类型
 */
export function flattenModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ModelCatalog<TGroups, TProvider> {
	// Object.values 取出各 API 分组下的「模型 ID -> 元数据」对象，
	// Object.assign 把它们合并成一张平表；
	// TS 无法自动验证映射类型的对应关系，故用 as 断言收窄回 ModelCatalog
	return Object.assign({}, ...Object.values(groups)) as ModelCatalog<TGroups, TProvider>;
}
