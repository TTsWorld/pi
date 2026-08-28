/**
 * @file extension-editor.ts —— 扩展的多行编辑器组件
 *
 * @description
 * 为扩展（extensions）弹出的多行文本编辑对话框：标题 + 多行 Editor + 按键提示。
 * Enter 提交、Shift+Enter 换行（与主输入框一致），并支持通过快捷键
 * （默认 Ctrl+G）把内容暂存到临时文件、调用外部编辑器（$VISUAL/$EDITOR 等）编辑，
 * 保存后再把内容带回内联编辑器。
 */

import {
	Container,
	Editor,
	type EditorOptions,
	type Focusable,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { editInExternalEditor } from "../external-editor.ts";
import { getEditorTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * 扩展多行编辑器组件。
 *
 * 实现 Focusable：焦点状态与内部 Editor 联动；除常规输入直接透传给 Editor 外，
 * 还拦截两类快捷键——取消（Esc/Ctrl+C）与打开外部编辑器。
 */
export class ExtensionEditorComponent extends Container implements Focusable {
	private editor: Editor; // 内联多行编辑器本体
	private onSubmitCallback: (value: string) => void; // 提交回调（携带编辑后的全文）
	private onCancelCallback: () => void; // 取消回调
	private tui: TUI; // TUI 实例：打开外部编辑器前后需要停启终端
	private keybindings: KeybindingsManager; // 应用级键绑定（识别"外部编辑器"快捷键）
	private externalEditorCommand: string; // 外部编辑器启动命令

	private _focused = false;
	/** 当前是否获得焦点（Focusable 接口）。 */
	get focused(): boolean {
		return this._focused;
	}
	/** 设置焦点时同步联动内部编辑器，保证光标显隐正确。 */
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value;
	}

	constructor(
		tui: TUI,
		keybindings: KeybindingsManager,
		title: string,
		prefill: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		options?: EditorOptions,
		externalEditorCommand?: string,
	) {
		/**
		 * 组装顺序固定为：上边框 → 标题 → 编辑器 → 按键提示 → 下边框。
		 * title/prefill/externalEditorCommand 均由调用方决定，
		 * 例如编辑已存在的扩展内容时会传入其源码作为 prefill。
		 */
		super();

		this.tui = tui;
		this.keybindings = keybindings;
		// 外部编辑器命令的兜底优先级：显式参数 > $VISUAL > $EDITOR > 平台默认（Windows 记事本 / 其他 nano）
		this.externalEditorCommand =
			externalEditorCommand ||
			process.env.VISUAL ||
			process.env.EDITOR ||
			(process.platform === "win32" ? "notepad" : "nano");
		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;

		// 顶部：边框 + 标题
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));

		// 创建多行编辑器；有预填内容则先填入（常用于编辑已有扩展内容）
		this.editor = new Editor(tui, getEditorTheme(), options);
		if (prefill) {
			this.editor.setText(prefill);
		}
		// Enter 提交；换行走 Shift+Enter，与主输入框的行为保持一致
		this.editor.onSubmit = (text: string) => {
			this.onSubmitCallback(text);
		};
		// 编辑器本体加入容器
		this.addChild(this.editor);

		this.addChild(new Spacer(1));

		// 底部按键提示：提交 / 换行 / 取消 / 打开外部编辑器
		const hint =
			keyHint("tui.select.confirm", "submit") +
			"  " +
			keyHint("tui.input.newLine", "newline") +
			"  " +
			keyHint("tui.select.cancel", "cancel") +
			`  ${keyHint("app.editor.external", "external editor")}`;
		this.addChild(new Text(hint, 1, 0));

		this.addChild(new Spacer(1));

		// 底部边框收尾
		this.addChild(new DynamicBorder());
	}

	/** 处理按键：优先拦截"取消"与"外部编辑器"快捷键，其余透传给内联编辑器。 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Esc 或 Ctrl+C：取消编辑
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
			return;
		}

		// 外部编辑器快捷键（应用级键绑定，默认 Ctrl+G）
		if (this.keybindings.matches(keyData, "app.editor.external")) {
			void this.handleOpenExternalEditor();
			return;
		}

		// 其余按键全部转发给内联编辑器
		this.editor.handleInput(keyData);
	}

	/**
	 * 打开外部编辑器编辑当前内容。
	 *
	 * 先暂停 TUI（把终端还给外部编辑器），等待其退出后再恢复 TUI 并强制全量重绘；
	 * 用户正常保存退出（status === "complete"）时才把编辑结果写回内联编辑器，
	 * 中途异常或放弃则保留原内容。finally 保证无论成败终端都会恢复。
	 */
	private async handleOpenExternalEditor(): Promise<void> {
		const content = this.editor.getText();
		// 暂停 TUI，把终端控制权让给外部编辑器进程
		this.tui.stop();
		try {
			const result = await editInExternalEditor({
				command: this.externalEditorCommand,
				content,
			});
			if (result.status === "complete") {
				this.editor.setText(result.content);
			}
		} finally {
			this.tui.start();
			this.tui.requestRender(true);
		}
	}
}
