/**
 * @file 生成模型数据目录的"契约"模块:清单(manifest)格式定义与一致性校验。
 *
 * 在构建期代码生成流水线中处于核心位置:
 * - generate-models.ts 从 models.dev 等数据源生成
 *   src/providers/data/<provider>.json(gitignored 的本地缓存,支持离线构建)
 *   及各 *.models.ts 分片,写入时调用本模块生成 .manifest.json 并就地校验;
 * - check-model-data.ts(build:offline 第一步)再用本模块校验本地缓存
 *   是否完整、schema 版本是否过期、hash 是否与清单一致。
 * 校验思路:以 src/models.generated.ts 聚合器声明的 provider 列表为"期望结构",
 * 逐一核对数据目录里的文件、清单 hash 与模型字段,任何不一致都会抛错,
 * 提示需要重新执行 `npm run hydrate:model-data`。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 生成数据的 schema 版本。生成器与校验器共享此常量:
 * 数据结构或生成规则变化时递增,让旧版本生成的本地缓存立即判为过期。
 */
export const MODEL_DATA_SCHEMA_VERSION = 3;

/** 数据目录内的清单文件名(隐藏文件,不参与 provider 文件枚举) */
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

/** 期望的目录结构:providerId → (modelId → 所属 API 分组名) */
export type ModelDataStructure = Record<string, Record<string, string>>;

/** 数据目录清单:记录 schema 版本、生成时间、结构 hash 与每个文件的 sha256 */
export interface ModelDataManifest {
	schemaVersion: number;
	generatedAt: string;
	structureHash: string;
	files: Record<string, string>;
}

/**
 * 从 src/models.generated.ts 中提取 provider 分片 import 的正则。
 * 形如 `import { OPENAI_MODELS } from "./providers/openai.models.ts";`,
 * 捕获组 1 即 providerId —— 聚合器因此是"哪些 provider 有生成数据"的唯一事实来源。
 */
const MODEL_DATA_IMPORT_PATTERN =
	/^import \{ [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;

/** 计算字符串的 sha256 十六进制摘要,用于结构 hash 与文件 hash */
function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 把键值对列表按 key 字典序排序后还原为对象,保证序列化结果稳定(hash 才可比) */
function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 两个字符串数组是否完全相等(顺序敏感,调用前需各自排好序) */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 生成"期望 vs 实际"的差集描述:哪些缺失(missing)、哪些多余(extra),用于报错信息 */
function describeSetDifference(expected: readonly string[], actual: readonly string[]): string {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	const missing = expected.filter((value) => !actualSet.has(value));
	const extra = actual.filter((value) => !expectedSet.has(value));
	return [missing.length > 0 ? `missing: ${missing.join(", ")}` : "", extra.length > 0 ? `extra: ${extra.join(", ")}` : ""]
		.filter(Boolean)
		.join("; ");
}

/**
 * 断言两组模型 ID 完全一致(去重排序后比较),不一致则抛出缺失/多余明细。
 * generate-models.ts 用它保证写出的模型分片与数据目录收录的模型一一对应,
 * 防止两边悄悄漂移。
 */
export function assertExactModelIds(label: string, expected: Iterable<string>, actual: Iterable<string>): void {
	const expectedIds = Array.from(new Set(expected)).sort();
	const actualIds = Array.from(new Set(actual)).sort();
	if (sameStrings(expectedIds, actualIds)) return;
	throw new Error(`${label} model IDs do not match (${describeSetDifference(expectedIds, actualIds)})`);
}

/** 类型守卫:值是否为非数组、非 null 的普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 读取并解析一个 JSON 对象文件。解析失败或顶层不是对象时不直接抛出,
 * 而是把错误信息累积进 errors 数组并返回 undefined —— 校验流程希望
 * 一次性收集全部问题再统一报告。
 */
function readJsonObject(path: string, description: string, errors: string[]): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(parsed)) {
		errors.push(`${description} must contain a JSON object`);
		return undefined;
	}
	return parsed;
}

/**
 * 读取单个 provider 数据文件,把"按 API 分组的模型表"压平成
 * modelId → api 映射(与 ModelDataStructure 的内层结构一致)。
 * 结构性错误(非法 JSON、分组不是对象、模型跨组重复、空文件)立即抛错。
 */
function readProviderStructure(path: string, providerId: string): Record<string, string> {
	const errors: string[] = [];
	const groups = readJsonObject(path, `${providerId}.json`, errors);
	if (!groups) throw new Error(errors.join("\n"));

	// 数据文件顶层 key 是 API 分组名(如 openai-completions / anthropic-messages),
	// 这里压平成 modelId → api,并顺带检测同一模型出现在多个分组的情况
	const models = new Map<string, string>();
	for (const [api, value] of Object.entries(groups)) {
		if (!isRecord(value)) throw new Error(`${path} API group ${JSON.stringify(api)} must be an object`);
		for (const modelId of Object.keys(value)) {
			if (models.has(modelId)) throw new Error(`${path} contains model ${modelId} in more than one API group`);
			models.set(modelId, api);
		}
	}
	if (models.size === 0) throw new Error(`${path} contains no generated model data`);
	return sortedRecord(models);
}

/**
 * 从 src/models.generated.ts(生成器写出的聚合器)解析出 provider ID 列表(已排序)。
 * 聚合器是 provider 集合的唯一事实来源;import 缺失或有重复都视为生成结果损坏,直接抛错。
 */
export function readModelDataProviderIds(packageRoot: string): string[] {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	const aggregator = readFileSync(aggregatorPath, "utf8");
	const providerIds = Array.from(aggregator.matchAll(MODEL_DATA_IMPORT_PATTERN), (match) => match[1]).sort();
	if (providerIds.length === 0) throw new Error(`No generated provider imports found in ${aggregatorPath}`);
	if (new Set(providerIds).size !== providerIds.length) {
		throw new Error(`Generated model aggregator contains duplicate provider imports: ${aggregatorPath}`);
	}
	return providerIds;
}

/**
 * 构建期望目录结构:以聚合器声明的 provider 为准,逐一读取
 * src/providers/data/<provider>.json,得到 providerId → (modelId → api) 的完整映射。
 * 同时交叉校验:providers/ 目录下实际的 *.models.ts 分片必须与聚合器
 * import 的集合完全一致,多一个少一个都抛错(防止残留旧分片)。
 */
export function readModelDataStructure(packageRoot: string): ModelDataStructure {
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	const providerIds = readModelDataProviderIds(packageRoot);
	// 期望的分片集合(由聚合器 import 推出)与目录中实际存在的分片对比
	const expectedShards = providerIds.map((providerId) => `${providerId}.models.ts`).sort();
	const actualShards = readdirSync(providersDir)
		.filter((entry) => entry.endsWith(".models.ts"))
		.sort();
	if (!sameStrings(expectedShards, actualShards)) {
		throw new Error(
			`Generated model aggregator and provider shards do not match (${describeSetDifference(expectedShards, actualShards)})`,
		);
	}

	return sortedRecord(
		providerIds.map((providerId) => [
			providerId,
			readProviderStructure(join(dataDir, `${providerId}.json`), providerId),
		]),
	);
}

/**
 * 计算目录结构的规范化 hash:对 provider 层与模型层都先排序再序列化,
 * 使 hash 只取决于"收录了哪些模型、各属哪个 API 分组",与写入顺序无关。
 * 清单用它检测本地缓存与当前生成目录是否结构级漂移。
 */
export function modelDataStructureHash(structure: ModelDataStructure): string {
	const normalized = sortedRecord(
		Object.entries(structure).map(
			([providerId, models]) => [providerId, sortedRecord(Object.entries(models))] as const,
		),
	);
	return sha256(JSON.stringify(normalized));
}

/**
 * 组装数据目录的清单对象:写入 schema 版本、生成时间、结构 hash,
 * 以及"文件名 → 内容 sha256"映射(全部排序,保证清单字节级可复现)。
 * generate-models.ts 在数据落盘时调用它写入 .manifest.json。
 */
export function createModelDataManifest(
	structure: ModelDataStructure,
	fileContents: Readonly<Record<string, string>>,
	generatedAt: string,
): ModelDataManifest {
	return {
		schemaVersion: MODEL_DATA_SCHEMA_VERSION,
		generatedAt,
		structureHash: modelDataStructureHash(structure),
		files: sortedRecord(Object.entries(fileContents).map(([file, content]) => [file, sha256(content)] as const)),
	};
}

/**
 * 校验单个模型条目的必要字段:id/provider/api 必须与所在文件和分组自洽,
 * name、baseUrl、reasoning、输入模态(仅 text|image 且非空)、
 * contextWindow/maxTokens(正有限数)以及 cost 四项价格均为有限数字。
 * 问题不抛出而是累积进 errors,最后由 validateModelDataDirectory 统一上报。
 */
function validateModelValue(
	value: unknown,
	providerId: string,
	modelId: string,
	expectedApi: string,
	errors: string[],
): void {
	const label = `${providerId}/${modelId}`;
	if (!isRecord(value)) {
		errors.push(`${label} must be an object`);
		return;
	}
	if (value.id !== modelId) errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
	if (value.provider !== providerId) {
		errors.push(`${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(providerId)}`);
	}
	if (value.api !== expectedApi) {
		errors.push(`${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`);
	}
	if (typeof value.name !== "string" || value.name.length === 0) errors.push(`${label} has no model name`);
	if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
	if (typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
	if (
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		value.input.some((entry) => entry !== "text" && entry !== "image")
	) {
		errors.push(`${label} has invalid input modalities`);
	}
	if (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow) || value.contextWindow <= 0) {
		errors.push(`${label} has invalid contextWindow`);
	}
	if (typeof value.maxTokens !== "number" || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0) {
		errors.push(`${label} has invalid maxTokens`);
	}
	if (!isRecord(value.cost)) {
		errors.push(`${label} has invalid cost metadata`);
	} else {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const cost = value.cost[field];
			if (typeof cost !== "number" || !Number.isFinite(cost)) {
				errors.push(`${label} has invalid cost.${field}`);
			}
		}
	}
}

/** 把累积的校验错误格式化后抛出;最多展示前 30 条,其余折叠为计数,避免报错刷屏 */
function throwValidationErrors(errors: string[]): never {
	const visible = errors.slice(0, 30);
	const suffix = errors.length > visible.length ? `\n  ... and ${errors.length - visible.length} more` : "";
	throw new Error(`Invalid generated model data:\n${visible.map((error) => `  - ${error}`).join("\n")}${suffix}`);
}

/**
 * 全量校验数据目录(generate-models.ts 写入后自检、check-model-data.ts 构建前复检都走这里):
 * 1. 文件集合:目录里的 *.json(排除清单自身)必须与期望结构给出的 provider 集合一致;
 * 2. 清单:存在且为对象、schema 版本为当前版本、生成时间是合法日期、
 *    structureHash 与期望结构一致、files 哈希表覆盖全部数据文件;
 * 3. 内容:每个文件 hash 与清单一致、逐模型跑字段校验、模型 ID 集合与
 *    期望结构一致、每个模型所处的 API 分组也与期望一致。
 * 所有问题累积后一次性抛出;任何一项失败即视为本地缓存过期/损坏,
 * 需要重新 hydrate。
 */
export function validateModelDataDirectory(structure: ModelDataStructure, dataDir: string): void {
	// 数据目录本身不存在:典型的"从未生成过/被 clean 掉"场景,直接抛错
	if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
		throw new Error(`Generated model data directory does not exist: ${dataDir}`);
	}

	const errors: string[] = [];
	// 期望的数据文件集合(由期望结构推出),用于与目录实际内容对比
	const expectedFiles = Object.keys(structure)
		.map((providerId) => `${providerId}.json`)
		.sort();
	const actualFiles = readdirSync(dataDir)
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		.sort();
	if (!sameStrings(expectedFiles, actualFiles)) {
		errors.push(`provider data files do not match the generated catalog (${describeSetDifference(expectedFiles, actualFiles)})`);
	}

	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	const manifest = readJsonObject(manifestPath, "model data manifest", errors);
	// 清单四项检查:schema 版本(旧版本缓存判过期)、生成时间合法、
	// 结构 hash 与当前目录一致、文件 hash 表覆盖全部数据文件
	if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) {
		errors.push(
			`model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`,
		);
	}
	if (typeof manifest?.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt))) {
		errors.push("model data manifest has an invalid generation timestamp");
	}
	const expectedStructureHash = modelDataStructureHash(structure);
	if (manifest?.structureHash !== expectedStructureHash) {
		errors.push("model data generation stamp does not match the generated catalog");
	}
	const manifestFiles = isRecord(manifest?.files) ? manifest.files : undefined;
	if (!manifestFiles) errors.push("model data manifest has no file hashes");
	else {
		const manifestFileNames = Object.keys(manifestFiles).sort();
		if (!sameStrings(expectedFiles, manifestFileNames)) {
			errors.push(`manifest file hashes do not match provider data files (${describeSetDifference(expectedFiles, manifestFileNames)})`);
		}
	}

	// 逐 provider 校验数据文件内容(文件缺失的情况上面已按集合差集记过错,这里跳过即可)
	for (const [providerId, expectedModels] of Object.entries(structure)) {
		const filename = `${providerId}.json`;
		const path = join(dataDir, filename);
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf8");
		// 文件级防篡改:内容 sha256 必须与清单里记录的完全一致(缓存被手改即失效)
		if (manifestFiles && manifestFiles[filename] !== sha256(content)) {
			errors.push(`${filename} does not match its manifest hash`);
		}
		const groups = readJsonObject(path, filename, errors);
		if (!groups) continue;

		// 压平"API 分组 → 模型"两层结构,同时逐模型跑字段校验
		const actualModels = new Map<string, string>();
		for (const [api, value] of Object.entries(groups)) {
			if (!isRecord(value)) {
				errors.push(`${filename} API group ${JSON.stringify(api)} must be an object`);
				continue;
			}
			for (const [modelId, model] of Object.entries(value)) {
				if (actualModels.has(modelId)) {
					errors.push(`${providerId}/${modelId} appears in more than one API group`);
					continue;
				}
				actualModels.set(modelId, api);
				validateModelValue(model, providerId, modelId, api, errors);
			}
		}

		// 模型 ID 集合必须与期望结构(生成目录)完全一致,多退少补都不允许
		const expectedModelIds = Object.keys(expectedModels).sort();
		const actualModelIds = Array.from(actualModels.keys()).sort();
		if (!sameStrings(expectedModelIds, actualModelIds)) {
			errors.push(`${filename} model IDs do not match the generated catalog (${describeSetDifference(expectedModelIds, actualModelIds)})`);
		}
		for (const [modelId, expectedApi] of Object.entries(expectedModels)) {
			const actualApi = actualModels.get(modelId);
			if (actualApi !== undefined && actualApi !== expectedApi) {
				errors.push(
					`${providerId}/${modelId} is grouped under API ${JSON.stringify(actualApi)}, expected ${JSON.stringify(expectedApi)}`,
				);
			}
		}
	}

	if (errors.length > 0) throwValidationErrors(errors);
}

/**
 * 对外的完整校验入口:先从聚合器与数据文件读出期望结构,
 * 再对 src/providers/data/ 做全量校验。
 * check-model-data.ts 直接调用本函数作为 build:offline 的第一道门。
 */
export function validateGeneratedModelData(packageRoot: string): void {
	const structure = readModelDataStructure(packageRoot);
	validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}
