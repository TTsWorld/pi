/**
 * @file login-dialog.ts —— OAuth 登录对话框组件
 *
 * @description
 * provider 认证流程（OAuth 授权码、设备码、手动粘贴 code 等）进行期间，
 * 临时替换输入编辑器的对话框组件：展示授权链接与验证码、收集用户手动输入，
 * 并通过 AbortSignal 把取消操作传回认证流程。
 *
 * 主要功能点：
 * - showAuth / showDeviceCode / showPrompt / showManualInput 等方法分别渲染
 *   认证流程各步骤的界面，由 pi-ai 的 onAuth 等回调触发；
 * - 输入类方法返回 Promise，与认证流程异步串联；提交后输入框原地替换为
 *   只读文本，保留操作痕迹；
 * - 授权链接用 OSC 8 转义序列包装为终端超链接，支持 Cmd/Ctrl+点击打开；
 * - 取消（Esc 或取消键绑定）会 abort 认证流程并 reject 挂起的输入 Promise。
 *
 * 依赖关系：
 * - `@earendil-works/pi-ai`：设备码与认证链接的类型定义；
 * - `@earendil-works/pi-tui`：容器、输入框、文本等基础组件与键绑定；
 * - `./dynamic-border.ts` / `./keybinding-hints.ts` / `../theme/theme.ts`：边框、按键提示与主题配色。
 */
import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * 登录对话框组件 —— 在 OAuth 登录流程期间替换编辑器显示。
 * 既是展示面板（授权链接、验证码、进度），也是输入通道（手动粘贴 code、
 * 逐步提示输入），流程结束或取消后经 onComplete 回调交还控制权。
 */
export class LoginDialogComponent extends Container implements Focusable {
	/** 动态内容区：登录各步骤的文本、输入框都加在这里 */
	private contentContainer: Container;
	/** 复用的单行输入框（提交后原位替换为只读文本） */
	private input: Input;
	/** 宿主 TUI 实例，内容变化后调用 requestRender 触发重绘 */
	private tui: TUI;
	/** 取消登录用的中断信号，认证流程据此中止轮询等异步操作 */
	private abortController = new AbortController();
	/** 挂起的输入 Promise 的 resolve（用户提交时调用） */
	private inputResolver?: (value: string) => void;
	/** 挂起的输入 Promise 的 reject（取消登录时调用） */
	private inputRejecter?: (error: Error) => void;
	/** 登录结束（成功/取消/失败）时的回调 */
	private onComplete: (success: boolean, message?: string) => void;

	// Focusable 实现——把焦点透传给 input，保证 IME 输入时光标定位正确
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/**
	 * @param tui - 宿主 TUI 实例
	 * @param providerId - provider 标识，默认兼作展示名
	 * @param onComplete - 登录流程结束回调（成功/取消/失败均会调用）
	 * @param providerNameOverride - 覆盖展示用的 provider 名称
	 * @param titleOverride - 覆盖对话框标题
	 */
	constructor(
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// 顶部边框
		this.addChild(new DynamicBorder());

		// 标题
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// 动态内容区
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// 输入框（构造时常驻创建，需要时才加入内容区）
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				// 用户提交输入：先把输入框替换为只读文本，再 resolve 挂起的 Promise
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// 底部边框
		this.addChild(new DynamicBorder());
	}

	/** 供认证流程监听的中断信号（取消登录时触发）。 */
	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	/**
	 * 把内容区中的输入框替换为只读的已提交文本（"> 值"）。
	 * 提交后不可再编辑，但作为操作记录保留在界面上。
	 */
	private replaceInputWithSubmittedText(value: string): void {
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	/** 取消登录：abort 认证流程、reject 挂起的输入 Promise，并回调 onComplete。 */
	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * 由 onAuth 回调调用 —— 显示授权 URL 与可选的操作说明。
	 * URL 用 OSC 8 包装成可点击超链接，并自动尝试打开浏览器。
	 */
	showAuth(url: string, instructions?: string): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		// 用 OSC 8 转义序列把 URL 包成终端可点击超链接
		const linkedUrl = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		// macOS 用 Cmd+点击打开，其他平台 Ctrl+点击
		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${url}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

		if (instructions) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
		}

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * 由 onDeviceCode 回调调用 —— 显示验证 URL 与用户码（设备码流程）。
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		const linkedUrl = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

		const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hyperlink = `\x1b]8;;${info.verificationUri}\x07${clickHint}\x1b]8;;\x07`;
		this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));

		this.tui.requestRender();
	}

	/**
	 * 显示手动输入框，收集用户粘贴的 code/URL（用于回调服务器型 provider）。
	 * 返回的 Promise 在用户提交时 resolve、取消登录时 reject。
	 */
	showManualInput(prompt: string): Promise<string> {
		this.input.setValue("");
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", prompt), 1, 0));
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * 由 onPrompt 回调调用 —— 显示提示文案并等待输入。
	 * NOTE: 不清空内容区而是追加显示（保留 showAuth 已展示的 URL）。
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		if (placeholder) {
			this.contentContainer.addChild(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		}
		this.contentContainer.addChild(this.input);
		this.contentContainer.addChild(
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** 在登录的下一步之前显示说明文字（会先清空已有内容）。 */
	showDetails(lines: string[]): void {
		this.contentContainer.clear();
		this.contentContainer.addChild(new Spacer(1));
		for (const line of lines) {
			this.contentContainer.addChild(new Text(line, 1, 0));
		}
		this.tui.requestRender();
	}

	/** 显示 provider 自身的信息与链接，不启动任何认证回调流程。 */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		for (const link of links) {
			const text = link.label ? `${link.label}: ${link.url}` : link.url;
			const hyperlink = `\x1b]8;;${link.url}\x07${text}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * 显示等待消息（用于 GitHub Copilot 这类轮询式流程）。
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.contentContainer.addChild(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * 由 onProgress 回调调用 —— 追加显示一行进度消息。
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	/** 处理按键输入：优先识别取消键，其余透传给输入框。 */
	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// 其余按键透传给输入框
		this.input.handleInput(data);
	}
}
