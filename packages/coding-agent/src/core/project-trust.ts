/**
 * @file project-trust.ts —— 项目信任（Project Trust）决策流程
 *
 * @description
 * 决定是否信任当前项目目录：只有被信任的项目才允许加载项目级配置/资源、
 * 安装项目依赖并执行项目扩展。决策链依次为：显式覆盖 → 目录无可信资源 →
 * 扩展 project_trust 事件 → 已保存的决定 → 默认策略 → 交互式询问用户。
 */
import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	type ProjectTrustStore,
} from "./trust-manager.ts";

/** 运行模式：交互式 TUI / 非交互 print / JSON 流 / RPC 服务 */
export type AppMode = "interactive" | "print" | "json" | "rpc";

/** resolveProjectTrusted 的入参选项 */
export interface ResolveProjectTrustedOptions {
	/** 待判定信任的项目目录 */
	cwd: string;
	/** 已保存的信任决定存储 */
	trustStore: ProjectTrustStore;
	/** 显式覆盖（如命令行参数），非空时直接生效 */
	trustOverride?: boolean;
	/** 默认策略：always / never / ask */
	defaultProjectTrust?: DefaultProjectTrust;
	/** 已加载的扩展结果，用于触发 project_trust 事件 */
	extensionsResult?: LoadExtensionsResult;
	/** 决策上下文（UI 能力等） */
	projectTrustContext: ProjectTrustContext;
	/** 扩展处理失败时的错误上报回调 */
	onExtensionError?: (message: string) => void;
}

/** 构造信任询问弹窗的提示文案 */
function formatProjectTrustPrompt(cwd: string): string {
	return `Trust project folder?\n${cwd}\n\nThis allows ${APP_NAME} to load ${CONFIG_DIR_NAME} settings and resources, install missing project packages, and execute project extensions.`;
}

/** 弹出交互式选择框，让用户挑选一个信任选项（含「仅本次会话」档位） */
async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

/** 把用户选择中需要持久化的更新写入信任存储（「仅本次会话」档位不含更新） */
function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

/**
 * 解析当前项目目录是否被信任，返回最终的布尔决定。
 * 各分支按优先级短路返回，决策顺序见文件头 @description。
 */
export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	// 显式覆盖（命令行参数）优先
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	// 目录里没有需要信任才能加载的资源，默认放行
	if (!hasTrustRequiringProjectResources(options.cwd)) {
		return true;
	}

	// 给扩展一个通过 project_trust 事件接管决策的机会
	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionPath}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	// 已保存过决定：直接沿用
	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	// 没有历史决定时按默认策略行事（缺省为 ask）
	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	// 策略为 ask 但没有可用 UI（如非交互模式）：保守起见视为不信任
	if (!options.projectTrustContext.hasUI) {
		return false;
	}

	// 最后手段：弹窗询问用户，并保存其选择中需要持久化的更新
	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}
