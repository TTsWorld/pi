/**
 * @file edit 工具：基于精确文本替换的单文件编辑工具
 * @description `createEditTool` 工厂产出符合 {@link AgentHarnessTool} 契约（typebox schema +
 * execute，见 ../types.ts）的 "edit" 工具：模型提供 path + edits[]（每条为 oldText/newText
 * 精确替换），所有 edits 均针对同一份原始内容匹配（非增量应用），要求 oldText 在文件中唯一
 * 且互不重叠。匹配与 diff/patch 算法位于 ./edit-diff.ts（先精确匹配、失败后退化为模糊匹配，
 * 多处命中或重叠直接报错）；写入由 ./file-mutation-queue.ts 按规范路径（canonical path）
 * 串行化，避免并发写冲突；所有文件操作均通过 {@link ExecutionToolContext} 的 ExecutionEnv
 * 能力接口完成，不直接依赖 node:fs。
 */
import { type Static, Type } from "typebox";
import type { AgentHarnessTool, FileError } from "../types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToolPath } from "./path-utils.ts";
import type { ExecutionToolContext } from "./tool-context.ts";

/** 单条替换编辑的参数 schema：oldText 为待替换的精确文本，newText 为替换后的文本。 */
const replaceEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{},
);

/** edit 工具的顶层参数 schema：目标文件路径 + 一组替换编辑（edits）。 */
const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
		}),
	},
	{},
);

/** 由 {@link editSchema} 推导出的 edit 工具输入类型。 */
export type EditToolInput = Static<typeof editSchema>;
/** 旧版输入格式：顶层直接携带 oldText/newText，而没有 edits 数组。 */
type LegacyEditToolInput = EditToolInput & { oldText?: unknown; newText?: unknown };
/** 裸的单条编辑对象（模型漏掉外层数组包装时的形状）。 */
type SingleEditInput = { oldText: string; newText: string };

/** 类型守卫：判断 value 是否为同时包含字符串 oldText 与 newText 的单个编辑对象。 */
function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** edit 工具结果携带的结构化详情，供日志与 UI 渲染使用。 */
export interface EditToolDetails {
	/** 人类可读的带行号 diff（较长的上下文区间会截断省略）。 */
	diff: string;
	/** 标准 unified patch，可供外部工具应用或用于回滚。 */
	patch: string;
	/** 新文件中第一处变更所在的行号，供 UI 定位跳转。 */
	firstChangedLine?: number;
}

/**
 * schema 校验前的参数兼容垫片（`AgentTool.prepareArguments`，契约见 ../../types.ts）。
 *
 * 归一化模型常见的参数格式偏差（均原地修改 args 后返回）：
 * - `edits` 被序列化成 JSON 字符串：解析回数组；若解析结果是单个编辑对象则包装成数组；
 * - `edits` 直接给成单个 `{ oldText, newText }` 对象：包装成数组；
 * - 旧版顶层 `oldText`/`newText`：并入 edits 数组并从顶层剥离。
 *
 * @param input 模型产出的原始工具调用参数
 * @returns 形状符合 {@link EditToolInput} 的参数；JSON 解析失败时保持原样，交由后续校验报错
 */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") return input as EditToolInput;
	const args = input as Record<string, unknown>;
	// 兼容：部分模型会把 edits 数组序列化成 JSON 字符串
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	// 兼容：单个编辑对象漏掉了外层数组包装
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	// 兼容：旧版格式把 oldText/newText 放在顶层，这里并入 edits 数组
	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return args as EditToolInput;
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	// 从顶层剥离旧字段，仅保留其余参数
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

/**
 * 校验输入并收窄为可直接执行的 `{ path, edits }`。
 *
 * @throws 当 edits 缺失或为空数组时抛出
 */
function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

/** 把 {@link FileError} 包装成携带文件路径与错误码信息的普通 Error，原始错误挂到 cause 上。 */
function editAccessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

/**
 * 创建 "edit" 工具：对单个文件执行一组精确文本替换。
 *
 * 产出的工具符合 {@link AgentHarnessTool} 契约（typebox schema + execute，见 ../types.ts），
 * 所有文件操作都经由 context 中的 ExecutionEnv 能力接口完成，不直接使用 node:fs，因此可
 * 运行在任意可替换的执行环境上。核心匹配与 diff/patch 算法位于 ./edit-diff.ts，同一文件的
 * 写入串行化由 ./file-mutation-queue.ts 保证。
 *
 * @template TContext 工具执行时接收的 context 类型，须兼容 {@link ExecutionToolContext}
 * @returns edit 工具实例，details 携带 diff / patch / 首个变更行号
 */
export function createEditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<
	TContext,
	typeof editSchema,
	EditToolDetails | undefined
> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal, _onUpdate, { env }) {
			// ========== 参数校验与路径解析 ==========
			// resolveToolPath 会归一化 Unicode 空格、剥离 "@" 前缀并解析为绝对路径；
			// 该绝对路径同时作为下方写队列的排队键来源。
			const { path, edits } = validateEditInput(input);
			const absolutePath = await resolveToolPath(env, path, signal);
			// 写入串行化（Why）：整个「读取→匹配→写回」的读改写临界区都在队列回调内执行，
			// 队列按 canonical path 对同一文件的变更排队，避免并发的 edit/write 基于过期
			// 内容互相覆盖。进入临界区后先检查中止信号，排队等待期间已取消则直接放弃。
			return withFileMutationQueue(env, absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				// ========== 目标校验（路径校验） ==========
				// 只允许编辑已存在的普通文件或符号链接，把目录等非文件目标挡在写入之前。
				const info = await env.fileInfo(absolutePath, signal);
				if (!info.ok) throw editAccessError(path, info.error);
				if (info.value.kind !== "file" && info.value.kind !== "symlink") {
					throw new Error(`Could not edit file: ${path}. Path is not a file.`);
				}

				const readResult = await env.readTextFile(absolutePath, signal);
				if (!readResult.ok) throw editAccessError(path, readResult.error);
				if (signal?.aborted) throw new Error("Operation aborted");

				// ========== 归一化（BOM / 行尾处理） ==========
				// 匹配与替换统一在「无 BOM + LF」的规范空间进行，避免 CRLF 或 BOM 破坏
				// 精确匹配；同时记录原始 BOM 与主流行尾，写回时原样还原。
				const { bom, text: content } = stripBom(readResult.value);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				// ========== 应用替换（匹配策略） ==========
				// 所有 edits 都对同一份原始内容匹配，而非逐条增量应用。oldText 先做精确匹配，
				// 失败后退化为模糊匹配（忽略行尾空白与 Unicode 引号/破折号差异）；任一
				// oldText 命中多处、各 edits 互相重叠或替换后内容无变化都会抛错，逼模型
				// 补充更多上下文使匹配唯一。
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				if (signal?.aborted) throw new Error("Operation aborted");

				// 还原 BOM 与原始行尾后写回，未编辑部分保持原有字节不变
				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				const writeResult = await env.writeFile(absolutePath, finalContent, signal);
				if (!writeResult.ok) throw editAccessError(path, writeResult.error);
				if (signal?.aborted) throw new Error("Operation aborted");

				// ========== 生成 diff / patch ==========
				// diff 与 patch 都基于归一化后的 base/new 内容：diff 带行号供 UI 展示与定位，
				// patch 为标准 unified 格式，可供外部工具应用或回滚。
				const diffResult = generateDiffString(baseContent, newContent);
				return {
					content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
					details: {
						diff: diffResult.diff,
						patch: generateUnifiedPatch(path, baseContent, newContent),
						firstChangedLine: diffResult.firstChangedLine,
					},
				};
			});
		},
	};
}
