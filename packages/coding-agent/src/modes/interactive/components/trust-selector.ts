/**
 * @file trust-selector.ts —— 项目信任确认对话框
 *
 * @description
 * 在（新）目录启动时弹出的信任选择组件：展示当前目录、已保存的信任决策与
 * 本次会话状态，让用户选择"信任并更新/仅本次信任/不信任"等选项并保存决策。
 * 信任决策由 core/trust-manager 统一管理（含从父目录继承的情形）。
 */

import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import {
	getProjectTrustOptions,
	type ProjectTrustOption,
	type ProjectTrustStoreEntry,
} from "../../../core/trust-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

/** 用户在本对话框中做出的信任选择（信任与否 + 是否更新已保存的决策）。 */
export type TrustSelection = Pick<ProjectTrustOption, "trusted" | "updates">;

/** 信任选择器的宿主回调与初始参数。 */
export interface TrustSelectorOptions {
	cwd: string; // 当前工作目录（对话框顶部展示，也用于计算可选信任项）
	savedDecision: ProjectTrustStoreEntry | null; // 之前保存的信任决策（可能来自父目录）
	projectTrusted: boolean; // 当前会话是否已处于受信任状态
	onSelect: (selection: TrustSelection) => void; // 用户确认选择后的回调
	onCancel: () => void; // 取消回调
}

/**
 * 把已保存的信任决策格式化为展示文本，如 "trusted (/path)"。
 * 决策路径与当前信任路径不一致时，说明决策是从父目录继承的，标注继承来源。
 */
function formatDecision(trustPath: string | undefined, decision: ProjectTrustStoreEntry | null): string {
	if (decision === null) {
		return "none";
	}
	const label = decision.decision ? "trusted" : "untrusted";
	// 保存路径与当前可用信任路径不同 => 决策继承自父目录
	if (trustPath !== undefined && decision.path !== trustPath) {
		return `${label} (inherited from ${decision.path})`;
	}
	return `${label} (${decision.path})`;
}

/**
 * 项目信任选择器组件。
 *
 * 结构：顶部边框 + 标题/路径/已存决策/会话状态说明 + 选项列表容器 + 按键提示 + 底部边框。
 * 选项列表放入独立的 listContainer，每次移动选中项时只重建该容器而非整个对话框。
 */
export class TrustSelectorComponent extends Container {
	private selectedIndex: number;
	private readonly listContainer: Container;
	private readonly trustOptions: ProjectTrustOption[];
	private readonly savedDecision: ProjectTrustStoreEntry | null;
	private readonly onSelectCallback: (selection: TrustSelection) => void;
	private readonly onCancelCallback: () => void;

	constructor(options: TrustSelectorOptions) {
		super();

		this.savedDecision = options.savedDecision;
		// 根据 cwd 计算可选的信任选项（例如是否包含"仅本次"等），默认选中已保存决策对应的项
		this.trustOptions = getProjectTrustOptions(options.cwd);
		this.selectedIndex = Math.max(
			0,
			this.trustOptions.findIndex((option) => this.isSavedOption(option)),
		);
		this.onSelectCallback = options.onSelect;
		this.onCancelCallback = options.onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Project trust")), 1, 0));
		this.addChild(new Text(theme.fg("muted", options.cwd), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"muted",
					`Saved decision: ${formatDecision(this.trustOptions[0]?.savedPath, options.savedDecision)}`,
				),
				1,
				0,
			),
		);
		this.addChild(
			new Text(theme.fg("muted", `Current session: ${options.projectTrusted ? "trusted" : "untrusted"}`), 1, 0),
		);
		this.addChild(new Spacer(1));

		// 选项列表放在独立容器里，之后移动选中项时只需重建这个子容器
		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "save") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	/**
	 * 判断某个选项是否就是"已保存决策"对应的选项：
	 * 要求选项带有保存路径，且信任值与保存路径都与 savedDecision 完全一致。
	 * 命中的选项在列表中会打上 ✓ 标记。
	 */
	private isSavedOption(option: ProjectTrustOption): boolean {
		return (
			option.savedPath !== undefined &&
			this.savedDecision?.decision === option.trusted &&
			this.savedDecision.path === option.savedPath
		);
	}

	/** 清空并重建选项列表：选中项高亮，当前已保存决策对应的选项加 ✓。 */
	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.trustOptions.length; i++) {
			const option = this.trustOptions[i];
			if (!option) {
				continue; // 防御：跳过稀疏数组中的空洞
			}

			const isSelected = i === this.selectedIndex;
			const isCurrent = this.isSavedOption(option);
			const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", option.label) : theme.fg("text", option.label);
			this.listContainer.addChild(new Text(`${prefix}${label}${checkmark}`, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// 上下移动（兼容 vim 风格 k/j），确认后回调所选的信任决策，Esc 取消
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.trustOptions.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.trustOptions[this.selectedIndex];
			if (selected) {
				this.onSelectCallback({ trusted: selected.trusted, updates: selected.updates });
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}
}
