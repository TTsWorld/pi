/**
 * @file custom-editor.ts —— 带应用级键位处理的定制输入编辑器
 *
 * @description
 * 继承 pi-tui 的 Editor，在通用编辑能力之上接入 coding-agent 的
 * 应用级键位体系：扩展快捷键、粘贴图片、中断、退出、历史记录等
 * 优先于编辑器默认按键行为分发。
 * 仅当按键不属于任何应用级动作时，才落入父类的文本编辑处理。
 */
import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";

/**
 * 定制编辑器：在 pi-tui Editor 基础上处理 coding-agent 的应用级键位。
 * 通过 onAction 注册静态处理器，或直接覆写 onEscape 等动态回调。
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	/** 已注册的应用动作 → 处理器映射 */
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// 可被动态替换的特殊处理器
	// 设置后优先于 actionHandlers 中注册的同名动作处理器
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	/** 扩展注册的快捷键处理器。返回 true 表示已消费该按键。 */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		super(tui, theme, options);
		// 保存应用的键位管理器，用于识别全局快捷键
		this.keybindings = keybindings;
	}

	/**
	 * 为指定应用动作注册处理器。
	 * 同一动作重复注册会覆盖旧处理器。
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	/**
	 * 处理一次按键输入。
	 *
	 * 分发优先级从高到低：
	 * 扩展快捷键 → 粘贴图片 → 中断（Escape）→ 退出（Ctrl+D）→
	 * 历史记录键位 → 其余 app 动作 → 父类编辑器默认行为。
	 * 任一环节命中即返回，不再继续向下分发。
	 */
	handleInput(data: string): void {
		// 优先检查扩展注册的快捷键
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// 检查剪贴板粘贴键位
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// 先检查 app 键位

		// Escape/中断——仅在自动补全未激活时生效
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// 优先用动态 onEscape，其次用已注册的处理器
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// 自动补全激活时交给父类处理，用于取消补全
			super.handleInput(data);
			return;
		}

		// 退出（Ctrl+D）——仅在编辑器为空时生效
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				// 同中断：优先动态 onCtrlD，其次注册的处理器
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// 非空时落入编辑器默认行为（向后删除字符）
		}

		// 编辑器聚焦时，显式绑定的历史键位优先于 app 动作。
		// 这样用户可以把 Ctrl+P 绑定到历史记录，即使它默认用于切换模型。
		if (
			this.keybindings.matches(data, "tui.editor.historyPrevious") ||
			this.keybindings.matches(data, "tui.editor.historyNext")
		) {
			super.handleInput(data);
			return;
		}

		// 检查其余所有 app 动作
		for (const [action, handler] of this.actionHandlers) {
			// interrupt/exit 已在上方单独处理，这里跳过避免重复分发
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		// 其余交给父类做编辑器默认处理
		super.handleInput(data);
	}
}
