/**
 * @file edit.ts —— edit 工具：基于精确文本替换的文件编辑
 *
 * @description
 * 本文件实现编码助手的 edit 工具：对单个文件执行一次或多次
 * 「oldText → newText」精确替换。核心流程在 execute 中：
 * 1. prepareEditArguments 先做模型兼容归一——edits 传成 JSON 字符串、
 *    单个对象、或顶层 oldText/newText 的遗留格式，统一归一为 edits 数组；
 * 2. 借助 edit-diff.ts 完成：BOM 剥离 → 行尾归一为 LF → 所有编辑都基于
 *    「原始文件」（而非增量）应用 → 还原原行尾、补回 BOM 后写回；
 * 3. 整个读-改-写过程串行在 withFileMutationQueue 的同文件互斥队列中，
 *    避免与其他并发编辑互相覆盖；
 * 4. 同时生成面向展示的 diff 与标准 unified patch，并附带首个变更行号
 *    供编辑器跳转。
 *
 * 所有 edits[].oldText 都必须匹配原文件中唯一且互不重叠的区域；
 * 匹配失败或编辑重叠时由 edit-diff 抛出 EditDiffError。
 *
 * 渲染层（renderCall / renderResult）在参数流式接收完毕后即异步计算
 * diff 预览，让用户在工具真正执行前就能看到即将发生的改动及其
 * 成功/失败状态（头部背景色随之变化）。
 *
 * 依赖关系：
 * - `./edit-diff.ts`：编辑应用、diff/patch 生成与预览计算；
 * - `./file-mutation-queue.ts`：同文件变更互斥队列；
 * - `./path-utils.ts`：相对路径基于 cwd 解析为绝对路径；
 * - `../../utils/text.ts`：BOM 拆分；
 * - `@earendil-works/pi-tui` 与 diff 组件：终端渲染。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile, writeFile as fsWriteFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { renderDiff } from "../../modes/interactive/components/diff.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { splitBom } from "../../utils/text.ts";
import { getExperimentalToolSampling } from "../experimental.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	applyEditsToNormalizedContent,
	computeEditsDiff,
	detectLineEnding,
	type Edit,
	type EditDiffError,
	type EditDiffResult,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/** 编辑预览：成功为 diff 结果，失败为错误信息（二者判别字段为 error） */
type EditPreview = EditDiffResult | EditDiffError;

/** edit 工具的渲染状态：缓存的调用组件，供 renderCall/renderResult 间复用 */
type EditRenderState = {
	callComponent?: EditCallRenderComponent;
};

/** 单条替换的 schema：oldText 必须在原文件中唯一，且与同调用内其他编辑不重叠 */
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

/** edit 工具的输入 schema：文件路径 + 一组替换编辑 */
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

/** edit 工具注入系统提示词的片段与使用守则 */
export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

export type EditToolInput = Static<typeof editSchema>;

/** 顶层 oldText/newText 的遗留入参形状（旧版单编辑调用格式） */
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

/** 单条编辑的形状：{ oldText, newText } */
type SingleEditInput = { oldText: string; newText: string };

/** 类型守卫：判断未知值是否为单条编辑对象（oldText/newText 均为字符串） */
function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/** edit 工具结果附带的元数据（供渲染层与编辑器跳转使用，不进入模型上下文） */
export interface EditToolDetails {
	/** 已做更改的展示用 diff */
	diff: string;
	/** 已做更改的标准 unified patch */
	patch: string;
	/** 新文件中首个变更所在的行号（用于编辑器导航） */
	firstChangedLine?: number;
}

/**
 * edit 工具的可插拔文件操作。
 * 覆盖这些方法可把文件编辑委托给远程系统（例如 SSH）。
 */
export interface EditOperations {
	/** 以 Buffer 读取文件内容 */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** 把字符串内容写入文件 */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** 检查文件可读且可写（不可则抛错） */
	access: (absolutePath: string) => Promise<void>;
}

/** 默认实现：直接读写本地文件系统 */
const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

/** edit 工具的配置项 */
export interface EditToolOptions {
	/** 自定义文件编辑操作。默认：本地文件系统 */
	operations?: EditOperations;
}

/**
 * 归一化模型传入的 edit 参数，兼容多种偏离 schema 的写法：
 * 1. edits 被序列化成 JSON 字符串（数组或单个对象）→ 解析还原为数组；
 * 2. edits 直接传了单个编辑对象 → 包装为单元素数组；
 * 3. 遗留格式：顶层 oldText/newText → 合并为 edits 数组的一项。
 */
function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// 有些模型（Opus 4.6、GLM-5.1）会把 edits 发成 JSON 字符串而非数组。
	// 还有些会发单个编辑对象而非单元素的 edits 数组。
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	// 无遗留顶层 oldText/newText：归一化到此结束
	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	// 遗留字段合并进 edits，并从顶层剥离，避免重复执行
	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

/** 校验归一化后的输入：edits 必须是非空数组，否则执行时无法应用任何编辑 */
function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

/** 渲染层可见的编辑参数（兼容 path/file_path 命名与遗留顶层 oldText/newText） */
type RenderableEditArgs = {
	path?: string;
	file_path?: string;
	edits?: Edit[];
	oldText?: string;
	newText?: string;
};

/** edit 工具结果的形状（渲染时只关心 content 与 details） */
type EditToolResultLike = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: EditToolDetails;
};

/** 调用渲染组件：Box 头部 + 预览 diff/错误体，并携带预览缓存状态 */
type EditCallRenderComponent = Box & {
	/** 当前 diff 预览（或预览阶段的错误信息） */
	preview?: EditPreview;
	/** 预览对应的参数键（JSON 串）：参数变化时据此失效旧预览 */
	previewArgsKey?: string;
	/** 是否有预览计算进行中（防止对流式参数重复发起计算） */
	previewPending?: boolean;
	/** 工具执行已结束且结果为错误（驱动头部背景色） */
	settledError?: boolean;
};

/** 创建带预览状态的调用渲染组件（Box：1 行/1 列内边距，文本原样透传） */
function createEditCallRenderComponent(): EditCallRenderComponent {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreview | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
	});
}

/**
 * 获取（或复用）调用渲染组件：
 * 优先复用上次渲染返回的组件（可能是别的工具留下的 Box，重置引用即可）；
 * 其次复用状态里缓存的；两者都没有才新建。
 */
function getEditCallRenderComponent(state: EditRenderState, lastComponent: unknown): EditCallRenderComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as EditCallRenderComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = createEditCallRenderComponent();
	state.callComponent = component;
	return component;
}

/**
 * 从渲染参数中提取「足以计算预览」的输入：path（或 file_path）+ 合法的 edits 数组，
 * 兼容遗留顶层 oldText/newText（视为单条编辑）。
 * 任一必要字段缺失或形状不对则返回 null——表示参数尚不完整，无法预览。
 */
function getRenderablePreviewInput(args: RenderableEditArgs | undefined): { path: string; edits: Edit[] } | null {
	if (!args) {
		return null;
	}

	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) {
		return null;
	}

	// 标准格式：非空 edits 数组且每项 oldText/newText 均为字符串
	if (
		Array.isArray(args.edits) &&
		args.edits.length > 0 &&
		args.edits.every((edit) => typeof edit?.oldText === "string" && typeof edit?.newText === "string")
	) {
		return { path, edits: args.edits };
	}

	// 遗留格式：顶层 oldText/newText 视为单条编辑
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		return { path, edits: [{ oldText: args.oldText, newText: args.newText }] };
	}

	return null;
}

/** 格式化调用标题行：`edit <相对路径>`（路径相对 cwd 展示） */
function formatEditCall(args: RenderableEditArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${pathDisplay}`;
}

/**
 * 格式化结果渲染文本；仅在「有调用区预览之外的新信息」时返回内容，
 * 否则返回 undefined（表示结果区留空，直接复用调用区已渲染的预览）。
 * - 错误：展示错误文本；为空或与预览错误完全相同时跳过，避免重复；
 * - 成功：结果的 diff 与预览 diff 不一致时才再渲染一次 diff。
 */
function formatEditResult(
	args: RenderableEditArgs | undefined,
	preview: EditPreview | undefined,
	result: EditToolResultLike,
	theme: Theme,
	isError: boolean,
): string | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	const previewDiff = preview && !("error" in preview) ? preview.diff : undefined;
	const previewError = preview && "error" in preview ? preview.error : undefined;
	if (isError) {
		const errorText = result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text || "")
			.join("\n");
		if (!errorText || errorText === previewError) {
			return undefined;
		}
		return theme.fg("error", errorText);
	}

	const resultDiff = result.details?.diff;
	if (resultDiff && resultDiff !== previewDiff) {
		return renderDiff(resultDiff, { filePath: rawPath ?? undefined });
	}

	return undefined;
}

/**
 * 选择调用头部背景色，按优先级：
 * 预览失败 → 错误色；预览成功 → 成功色；无预览但执行已结束且出错 → 错误色；
 * 其余（执行中且无预览）→ 待定色。
 */
function getEditHeaderBg(
	preview: EditPreview | undefined,
	settledError: boolean | undefined,
	theme: Theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}

/**
 * 构建（重建）调用渲染组件：先按预览/错误状态设定头部背景，
 * 再依次放入标题行与预览体（diff 或错误文本）。
 */
function buildEditCallComponent(
	component: EditCallRenderComponent,
	args: RenderableEditArgs | undefined,
	theme: Theme,
	cwd: string,
): EditCallRenderComponent {
	component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	component.clear();
	component.addChild(new Text(formatEditCall(args, theme, cwd), 0, 0));

	// 尚无预览：只渲染标题行
	if (!component.preview) {
		return component;
	}

	const body =
		"error" in component.preview ? theme.fg("error", component.preview.error) : renderDiff(component.preview.diff);
	component.addChild(new Spacer(1));
	component.addChild(new Text(body, 0, 0));
	return component;
}

/**
 * 更新组件上的预览，并返回内容是否发生变化（调用方据此决定是否重建/刷新）。
 *
 * changed 判定：从无到有、错误文本变化、成功/失败互切，
 * 或（同为成功时）diff / 首变更行发生变化。
 */
function setEditPreview(
	component: EditCallRenderComponent,
	preview: EditPreview,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

/**
 * 创建 edit 工具定义。
 *
 * execute 在同文件互斥队列中完成「校验 → access → 读取 → 归一行尾并应用编辑 →
 * 还原行尾回写 → 生成 diff/patch」；渲染层在参数接收完毕后即计算 diff 预览，
 * 执行前就把改动与匹配成败呈现给用户。
 *
 * @param cwd 工作目录（相对路径基于它解析为绝对路径）
 * @param options 可选配置（自定义文件操作后端）
 */
export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: getExperimentalToolSampling(),
		renderShell: "self",
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, _ctx?) {
			const { path, edits } = validateEditInput(input);
			const absolutePath = resolveToCwd(path, cwd);

			// 同文件互斥执行：并发 edit/write 对同一文件的读-改-写不会交错覆盖
			return withFileMutationQueue(absolutePath, async () => {
				// 不要在这里从 abort 事件监听器中 reject：那会让一个可能仍在
				// 进行中的文件系统操作结束时，互斥队列已被释放。
				// 在每个 await 之后检查 signal.aborted 能观察到同样的中断，
				// 同时保持队列锁定，直到当前操作落定。
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();

				// 检查文件是否存在（且可读可写）。
				try {
					await ops.access(absolutePath);
				} catch (error: unknown) {
					// access 失败也可能是 abort 引发的取消：优先按中断处理
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();

				// 读取文件。
				const buffer = await ops.readFile(absolutePath);
				const rawContent = buffer.toString("utf-8");
				throwIfAborted();

				// 匹配前先剥离 BOM。模型给出的 oldText 不会包含不可见的 BOM。
				const { bom, text: content } = splitBom(rawContent);
				const originalEnding = detectLineEnding(content);
				const normalizedContent = normalizeToLF(content);
				// 所有编辑都基于归一后的「原始」内容匹配应用（而非增量叠加），
				// 匹配失败 / 重叠在此处抛出 EditDiffError
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
				throwIfAborted();

				// 写回前还原原文件的行尾风格并补回 BOM，保持文件原有格式不变
				const finalContent = bom + restoreLineEndings(newContent, originalEnding);
				await ops.writeFile(absolutePath, finalContent);
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [
						{
							type: "text",
							text: `Successfully replaced ${edits.length} block(s) in ${path}.`,
						},
					],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
		renderCall(args, theme, context) {
			const component = getEditCallRenderComponent(context.state, context.lastComponent);
			const previewInput = getRenderablePreviewInput(args as RenderableEditArgs | undefined);
			// 参数键 = 路径 + 编辑数组的 JSON 串：流式接收参数期间逐次变化，
			// 用于判断旧预览是否已过期
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;

			// 参数变化：丢弃旧预览并重置状态（含上次执行遗留的错误标记）
			if (component.previewArgsKey !== argsKey) {
				component.preview = undefined;
				component.previewArgsKey = argsKey;
				component.previewPending = false;
				component.settledError = false;
			}

			// 参数接收完毕且尚无预览：异步计算 diff 预览。
			// 回调中先校验参数键未变，防止过期结果覆盖新参数的预览
			if (context.argsComplete && previewInput && !component.preview && !component.previewPending) {
				component.previewPending = true;
				const requestKey = argsKey;
				void computeEditsDiff(previewInput.path, previewInput.edits, context.cwd).then((preview) => {
					if (component.previewArgsKey === requestKey) {
						setEditPreview(component, preview, requestKey);
						context.invalidate();
					}
				});
			}

			return buildEditCallComponent(component, args, theme, context.cwd);
		},
		renderResult(result, _options, theme, context) {
			const callComponent = context.state.callComponent;
			const previewInput = getRenderablePreviewInput(context.args as RenderableEditArgs | undefined);
			const argsKey = previewInput
				? JSON.stringify({ path: previewInput.path, edits: previewInput.edits })
				: undefined;
			const typedResult = result as EditToolResultLike;
			// 成功结果携带权威 diff：优先用它覆盖执行前的预览
			const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
			let changed = false;
			if (callComponent) {
				if (typeof resultDiff === "string") {
					changed =
						setEditPreview(
							callComponent,
							{ diff: resultDiff, firstChangedLine: typedResult.details?.firstChangedLine },
							argsKey,
						) || changed;
				}
				// 记录执行结束的错误状态（驱动头部背景色从待定转成功/错误）
				if (callComponent.settledError !== context.isError) {
					callComponent.settledError = context.isError;
					changed = true;
				}
				// 调用组件展示的内容有变时才重建
				if (changed) {
					buildEditCallComponent(
						callComponent,
						context.args as RenderableEditArgs | undefined,
						theme,
						context.cwd,
					);
				}
			}

			// 结果区：仅在存在预览之外的新内容时才渲染，否则复用调用区的预览
			const output = formatEditResult(context.args, callComponent?.preview, typedResult, theme, context.isError);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			component.clear();
			if (!output) {
				return component;
			}
			component.addChild(new Spacer(1));
			component.addChild(new Text(output, 1, 0));
			return component;
		},
	};
}

/**
 * 创建 edit 工具（AgentTool 形式，可直接挂到 Agent 循环）。
 *
 * @param cwd 工作目录
 * @param options 可选配置（自定义文件操作后端）
 */
export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
