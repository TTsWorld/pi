/**
 * @file user-message-selector.ts —— 历史用户消息选择器（"Fork from Message" 分叉入口）
 *
 * @description
 * 实现「从某条消息分叉」的交互界面：列出当前会话中的全部用户消息，
 * 用户选中某一条后，把活跃路径上截止到该消息为止的历史复制到一个新会话继续。
 *
 * 结构分两层：
 * - UserMessageList：内部列表组件，负责消息渲染、窗口滚动与键盘导航（上下移动/确认/取消）；
 * - UserMessageSelectorComponent：外层对话框容器，负责标题、说明文字、动态边框等装饰，
 *   并把确认/取消回调透传给列表。
 */

import { type Component, Container, getKeybindings, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/** 列表中一条用户消息的展示数据 */
interface UserMessageItem {
	id: string; // 该消息在会话中的条目 ID（用于回溯定位原始消息）
	text: string; // 消息文本
	timestamp?: string; // 可选的时间戳（如果会话数据里带有）
}

/**
 * 自定义用户消息列表组件（带选中态）。
 *
 * 按时间顺序（旧→新）渲染消息，每条占两行（消息正文 + 位置元信息）外加一个空行；
 * 通过 maxVisible 控制可见窗口并在长列表时滚动，同时支持上下键循环换行。
 */
class UserMessageList implements Component {
	private messages: UserMessageItem[] = []; // 全部待选消息（按时间序，旧→新）
	private selectedIndex: number = 0; // 当前选中项下标
	public onSelect?: (entryId: string) => void; // 确认选择回调（携带所选消息的条目 ID）
	public onCancel?: () => void; // 取消回调
	private maxVisible: number = 10; // 可见窗口内最多展示的消息条数（超出则滚动）

	/**
	 * @param messages - 按时间序（旧→新）排列的用户消息列表
	 * @param initialSelectedId - 初始选中的消息条目 ID（可选）
	 */
	constructor(messages: UserMessageItem[], initialSelectedId?: string) {
		// 消息按时间顺序存储（从旧到新）
		this.messages = messages;
		const initialIndex = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		// 若给定初始选中 ID 则从它开始，否则默认选中最近的一条（列表末尾）
		this.selectedIndex = initialIndex >= 0 ? initialIndex : Math.max(0, messages.length - 1);
	}

	invalidate(): void {
		// 当前没有需要失效的缓存状态（render 每次都即时计算）
	}

	/** 渲染当前可见窗口内的消息列表（含空态提示与滚动指示器）。 */
	render(width: number): string[] {
		const lines: string[] = [];

		// 空态：会话中没有任何可分叉的用户消息
		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		// ===== 计算滚动窗口的可见范围 =====
		// 让选中项尽量居中：起点取「选中项 - 半屏」，同时夹在 [0, length - maxVisible] 之间，
		// 保证滚到列表首尾时窗口不会越界
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.messages.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.messages.length); // 可见窗口结束下标（不含）

		// 渲染可见消息：每条 2 行（正文 + 元信息）再加一个空行
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.messages[i];
			const isSelected = i === this.selectedIndex;

			// 把多行消息压成单行：换行替换为空格并去首尾空白
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// 第一行：光标 + 消息正文
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = width - 2; // 预留 2 字符宽度的光标前缀
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			lines.push(messageLine);

			// 第二行：元信息（该消息在历史中的位置，1 起始）
			const position = i + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			lines.push(metadataLine);
			lines.push(""); // 消息之间的空行分隔
		}

		// 存在未显示的上下内容时，追加 "当前位置/总数" 滚动指示器
		if (startIndex > 0 || endIndex < this.messages.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.messages.length})`);
			lines.push(scrollInfo);
		}

		return lines;
	}

	/** 处理键盘输入：上下键移动选中项（循环换行）、Enter 确认、Esc 取消。 */
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// 上箭头 —— 移到上一条（更早的）消息，已在顶部时循环跳到底部
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.messages.length - 1 : this.selectedIndex - 1;
		}
		// 下箭头 —— 移到下一条（更新的）消息，已在底部时循环跳到顶部
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = this.selectedIndex === this.messages.length - 1 ? 0 : this.selectedIndex + 1;
		}
		// 回车 —— 确认选中该消息并触发分叉
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.messages[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
		// Esc —— 取消
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}
}

/**
 * 用户消息选择器对话框组件（用于会话分叉）。
 *
 * 用边框、标题与说明文字把 UserMessageList 包成完整弹层：
 * 用户确认某条历史消息后，宿主会把活跃路径复制到该点为止并开启新会话。
 */
export class UserMessageSelectorComponent extends Container {
	private messageList: UserMessageList;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
	) {
		super();

		// ===== 添加头部：标题 + 用途说明 + 分隔边框 =====
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("Fork from Message"), 1, 0));
		this.addChild(
			new Text(
				theme.fg("muted", "Select a user message to copy the active path up to that point into a new session"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// 创建消息列表并挂接确认/取消回调
		this.messageList = new UserMessageList(messages, initialSelectedId);
		this.messageList.onSelect = onSelect;
		this.messageList.onCancel = onCancel;

		// 列表主体：占据剩余全部空间
		this.addChild(this.messageList);

		// 底部收尾：空行 + 结束边框
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		// 边界情形：没有可选消息时直接自动取消（延迟 100ms 等组件先完成渲染，
		// 避免在构造同步流程里就触发回调导致的状态错乱）
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	/** 暴露内部列表（宿主可借此查询当前选中项等）。 */
	getMessageList(): UserMessageList {
		return this.messageList;
	}
}
