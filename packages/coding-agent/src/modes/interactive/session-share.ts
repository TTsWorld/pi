/**
 * @file session-share.ts —— 交互模式的会话分享 / 上传模块（/share 命令实现）
 *
 * @description
 * 把当前会话导出并分享出去：优先把 JSONL 上传到 Radius 网关（组织内可见的
 * artifact），当 Radius 未配置或未登录时，降级为「导出 HTML + gh 创建私有 Gist」。
 *
 * 主要功能点：
 * - exportSessionForShare：在 JSONL 导出流中插入一条 pi.share 自定义事件，
 *   携带系统提示词与工具清单，供分享查看器还原会话的运行环境信息；
 * - shareSession：分享总入口，负责导出、两级上传链路调度与临时文件清理；
 * - tryShareViaRadius：单文件直传 Radius artifact，上传期间显示加载组件；
 * - shareViaGist：调用 gh CLI 创建 secret gist，并拼出可分享的预览链接；
 * - restoreEditor：上传结束 / 取消后，把编辑器容器与焦点恢复到主输入框。
 */

import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_RADIUS_GATEWAY } from "@earendil-works/pi-ai/providers/radius-config";
import { type Container, type EditorComponent, hyperlink, type TUI } from "@earendil-works/pi-tui";
import { getAuthCredential } from "../../cli/auth-command.ts";
import { getShareViewerUrl } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { exportSessionToJsonl } from "../../core/session-export.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

/**
 * 分享流程依赖的交互环境集合：会话对象、TUI 实例、承载加载组件的编辑器容器，
 * 以及用于向用户反馈结果的两条状态回调。
 */
interface SessionShareContext {
	/** 当前 Agent 会话：提供模型运行时、系统提示词与会话管理器 */
	session: AgentSession;
	/** 终端 UI 实例，用于设置焦点与请求重绘 */
	ui: TUI;
	/** 编辑器所在容器：上传时被清空以放置加载组件，结束后恢复 */
	editorContainer: Container;
	/** 主输入框组件，分享完成后焦点交还给它 */
	editor: EditorComponent;
	/** 状态栏成功提示（如分享链接） */
	showStatus: (message: string) => void;
	/** 状态栏错误提示 */
	showError: (message: string) => void;
}

/**
 * 把当前分支导出为 JSONL，并附加供 Radius 查看器使用的展示元数据。
 *
 * 工作原理：在标准会话导出的基础上额外注入一条 customType 为 "pi.share" 的
 * 自定义事件，记录当时的系统提示词与全部工具的名称 / 描述 / 参数 schema，
 * 让分享链接的查看者能还原会话的运行环境。
 */
export function exportSessionForShare(filePath: string, session: AgentSession): void {
	exportSessionToJsonl(session.sessionManager, filePath, (parentId, timestamp) => [
		{
			type: "custom",
			customType: "pi.share",
			// 事件 ID 取 UUID 前 8 位即可：仅作展示标识，无需保证全局唯一
			id: crypto.randomUUID().slice(0, 8),
			parentId,
			timestamp,
			data: {
				systemPrompt: session.state.systemPrompt,
				tools: session.state.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
			},
		},
	]);
}

/**
 * 分享当前会话：优先走 Radius 上传，失败或未配置时回退到 GitHub 私有 Gist。
 *
 * 完整链路：
 * 1. 导出会话为临时 JSONL（失败则直接报错返回）；
 * 2. 尝试 Radius 上传——返回 true 即结束（内部已自行处理成功 / 失败提示）；
 * 3. 回退路径：先校验 gh CLI 已安装且已登录，再导出 HTML，
 *    最后创建 secret gist 并输出预览链接。
 *
 * 无论走哪条路径，finally 中都会删除临时文件，避免系统临时目录残留
 * 可能含敏感对话内容的文件。
 */
export async function shareSession(context: SessionShareContext): Promise<void> {
	// 两个临时文件：JSONL 必定创建；HTML 仅 gist 回退路径才会生成
	const jsonlFile = path.join(os.tmpdir(), "session.jsonl");
	let htmlFile: string | null = null;

	try {
		try {
			exportSessionForShare(jsonlFile, context.session);
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		if (await tryShareViaRadius(jsonlFile, context)) return;

		try {
			// 同步执行 gh auth status 作前置检查：非零退出码 = 未登录
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				context.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			// 抛异常说明 gh 命令本身不存在（未安装），而不是未登录
			context.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		try {
			htmlFile = path.join(os.tmpdir(), "session.html");
			await context.session.exportToHtml(htmlFile, { themeName: theme.name });
		} catch (error: unknown) {
			context.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}
		await shareViaGist(htmlFile, context);
	} finally {
		// 兜底清理两个临时文件，删除失败也无需上报
		for (const tmpFile of [jsonlFile, htmlFile]) {
			try {
				if (tmpFile !== null) {
					fs.unlinkSync(tmpFile);
				}
			} catch {
				// 清理失败直接忽略：残留的临时文件不影响分享结果
			}
		}
	}
}

/**
 * 尝试通过 Radius 网关上传会话文件；返回 false 表示 Radius 不可用，可走 gist 回退。
 *
 * 前置条件：模型运行时注册了 radius provider，且能取到剩余有效期不小于
 * 5 分钟的 OAuth 凭据（minOAuthValidityMs，避免上传途中 token 过期）；
 * 任一条件不满足都静默返回 false，把机会留给回退路径。
 *
 * 返回 true 表示「本次分享已由 Radius 接管完毕」（无论成功或失败），
 * 调用方不应再降级到 gist。
 */
async function tryShareViaRadius(tmpFile: string, context: SessionShareContext): Promise<boolean> {
	const provider = context.session.modelRuntime.getProvider("radius");
	if (!provider) return false;

	// 5 * 60_000 ms（5 分钟）是上传预计耗时的安全余量，防止上传中途 token 失效
	const token = getAuthCredential(
		await context.session.modelRuntime.getAuth("radius", { minOAuthValidityMs: 5 * 60_000 }),
	);
	if (!token) return false;

	// 用加载组件替换主编辑器：上传期间屏蔽输入，ESC 触发 onAbort 取消上传
	const loader = new BorderedLoader(context.ui, theme, "Uploading to Radius...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();
	loader.onAbort = () => {
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const body = fs.readFileSync(tmpFile);
		// 上传为组织级 artifact：组织内成员可见，标题默认 "Pi session"
		const url = new URL("/v1/artifacts", DEFAULT_RADIUS_GATEWAY);
		url.searchParams.set("visibility", "organization");
		url.searchParams.set("title", "Pi session");
		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/x-ndjson",
				"Content-Length": String(body.byteLength),
			},
			body,
			signal: loader.signal,
		});
		// 用户已取消：fetch 已被中断，静默退出；返回 true 阻止 gist 回退
		if (loader.signal.aborted) return true;
		const json = (await response.json().catch(() => null)) as {
			artifact?: { canonical_url: string };
			error?: string;
		} | null;
		// JSON 解析期间也可能被取消，二次检查避免覆盖用户已触发的取消恢复
		if (loader.signal.aborted) return true;
		restoreEditor(loader, context);
		if (!response.ok || !json?.artifact) {
			context.showError(
				`Failed to upload Radius artifact: ${json?.error || response.statusText || response.status}`,
			);
			return true;
		}
		const shareUrl = json.artifact.canonical_url;
		context.showStatus(`Share URL: ${hyperlink(shareUrl, shareUrl)}`);
		return true;
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(
				`Failed to upload Radius artifact: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		}
		return true;
	}
}

/**
 * 回退路径：通过 gh CLI 把导出的 HTML 创建为 secret gist 并输出分享链接。
 *
 * gh 只返回原始 gist 地址，需从地址末段解析出 gist ID，再用
 * getShareViewerUrl 拼出带渲染样式的查看页链接（两个链接都会展示给用户）。
 * 创建期间同样以 BorderedLoader 遮挡编辑器，ESC 可终止 gh 子进程。
 */
async function shareViaGist(tmpFile: string, context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Creating gist...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let proc: ReturnType<typeof spawn> | null = null;
	// 取消时先杀掉 gh 子进程再恢复编辑器，避免后台残留进行中的创建请求
	loader.onAbort = () => {
		proc?.kill();
		restoreEditor(loader, context);
		context.showStatus("Share cancelled");
	};

	try {
		const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
			// --public=false 即 secret gist：仅持有链接者可见，不会出现在公开列表
			proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
			let stdout = "";
			let stderr = "";
			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.stderr?.on("data", (data) => {
				stderr += data.toString();
			});
			proc.on("close", (code) => resolve({ stdout, stderr, code }));
		});

		if (loader.signal.aborted) return;
		restoreEditor(loader, context);

		if (result.code !== 0) {
			context.showError(`Failed to create gist: ${result.stderr?.trim() || "Unknown error"}`);
			return;
		}

		const gistUrl = result.stdout?.trim();
		// gist URL 形如 https://gist.github.com/<id>，取最后一段即 gist ID
		const gistId = gistUrl?.split("/").pop();
		if (!gistId) {
			context.showError("Failed to parse gist ID from gh output");
			return;
		}

		const previewUrl = getShareViewerUrl(gistId);
		context.showStatus(`Share URL: ${hyperlink(previewUrl, previewUrl)}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
	} catch (error: unknown) {
		if (!loader.signal.aborted) {
			restoreEditor(loader, context);
			context.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}
}

/** 销毁加载组件，把编辑器容器与输入焦点恢复到分享前的主输入框状态。 */
function restoreEditor(loader: BorderedLoader, context: SessionShareContext): void {
	loader.dispose();
	context.editorContainer.clear();
	context.editorContainer.addChild(context.editor);
	context.ui.setFocus(context.editor);
}
