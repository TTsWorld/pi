/**
 * @file rpc-types.ts —— RPC 协议类型定义（无头模式）
 *
 * @description
 * 定义无头 RPC 模式下宿主客户端（IDE / Web UI 等）与编码代理子进程之间
 * 的全部线协议消息类型：
 * - 命令（RpcCommand）：client → server，按 JSONL 写入 stdin；
 * - 响应（RpcResponse）：server → client，按 JSONL 写到 stdout，与命令一一对应；
 * - 会话事件：AgentSessionEvent 的 JSON 投影，随发生随输出（定义见 json-event.ts）；
 * - 扩展 UI 请求/响应：扩展的弹窗等交互在 RPC 下的双向桥接消息。
 *
 * 消息上可选的 `id` 字段用于请求-响应关联：命令带 id，对应响应原样带回。
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent, Model } from "@earendil-works/pi-ai";
import type { SessionStats } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { SessionEntry, SessionTreeNode } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";

// ============================================================================
// RPC 命令（stdin，client → server）
// ============================================================================

/**
 * RPC 命令联合类型（client → server，stdin 上的 JSONL）。
 *
 * 每条命令是一个带 `type` 判别字段的 JSON 对象；可选 `id` 会在对应响应中
 * 原样带回，供客户端做请求-响应关联。
 *
 * 按功能大致分为：提示输入（prompt/steer/follow_up）、状态查询、模型与
 * 思考级别切换、排队模式、上下文压缩、自动重试、Bash、会话管理
 * （切换/fork/导出等）、消息读取与命令枚举。
 */
export type RpcCommand =
	// 提示与输入
	// prompt：注入一条用户消息；streamingBehavior 指定 agent 正在流式输出时该消息改走 steer 还是 followUp
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	// steer：向进行中的回合注入转向消息
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	// follow_up：把消息排队到当前回合结束后再投放
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	// 中断当前回合
	| { id?: string; type: "abort" }
	// 新建会话；parentSession 可指定父会话
	| { id?: string; type: "new_session"; parentSession?: string }

	// 状态查询
	| { id?: string; type: "get_state" }

	// 模型
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// 思考级别
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// 排队模式：多条排队消息是全部投放还是每回合只投一条
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// 上下文压缩
	// compact：手动压缩；customInstructions 可附加到压缩摘要指令中
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// 自动重试
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash：直接执行一条命令；excludeFromContext 为 true 时不计入会话上下文
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// 会话管理
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	// fork：从指定条目分叉出新的会话分支
	| { id?: string; type: "fork"; entryId: string }
	// clone：在当前叶子条目处原地分叉（克隆）会话
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	// get_entries：增量读取条目；since 为排他游标（只返回该条目之后的条目）
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// 消息读取
	| { id?: string; type: "get_messages" }

	// 斜杠命令枚举（返回的命令可通过 prompt 调用）
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC 斜杠命令（用于 get_commands 响应）
// ============================================================================

/**
 * 一个可通过 prompt 调用的命令（get_commands 返回列表中的条目）。
 *
 * 命令来源有三类：扩展注册的命令、prompt 模板、skill（name 带 `skill:` 前缀）。
 */
export interface RpcSlashCommand {
	/** 命令名（不含前导斜杠；skill 命令为 `skill:名称` 形式） */
	name: string;
	/** 人类可读的命令描述 */
	description?: string;
	/** 命令来源类型 */
	source: "extension" | "prompt" | "skill";
	/** 所属资源的来源元信息（来自哪个扩展/文件） */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC 会话状态
// ============================================================================

/**
 * 会话状态快照（get_state 命令响应携带的数据）。
 *
 * 由服务端在响应时现场组装，供客户端渲染状态栏或同步自身 UI。
 */
export interface RpcSessionState {
	/** 当前使用的模型（尚未选定模型时省略） */
	model?: Model<any>;
	/** 当前思考级别 */
	thinkingLevel: ThinkingLevel;
	/** agent 是否正在流式输出（回合进行中） */
	isStreaming: boolean;
	/** 是否正在压缩上下文 */
	isCompacting: boolean;
	/** steering 队列投放策略：all=逐条全部投放，one-at-a-time=每回合只投一条 */
	steeringMode: "all" | "one-at-a-time";
	/** followUp 队列投放策略：语义同上 */
	followUpMode: "all" | "one-at-a-time";
	/** 会话文件路径（新会话尚未落盘时省略） */
	sessionFile?: string;
	/** 会话唯一标识 */
	sessionId: string;
	/** 会话名（未命名时省略） */
	sessionName?: string;
	/** 自动压缩是否开启 */
	autoCompactionEnabled: boolean;
	/** 当前上下文中的消息总数 */
	messageCount: number;
	/** 排队中尚未投放到对话的消息数（steer/followUp 队列长度） */
	pendingMessageCount: number;
}

// ============================================================================
// RPC 响应（stdout，server → client）
// ============================================================================

/**
 * RPC 响应联合类型（server → client，stdout 上的 JSONL）。
 *
 * 每条命令处理后回发一条响应：`command` 回显命令类型；成功时
 * `success: true` 并按命令携带可选 `data`；失败时 `success: false` 且
 * `error` 给出原因（任何命令都可能失败，见末尾的兜底成员）。
 *
 * 注意 prompt / steer / follow_up 等异步命令的响应仅表示「已受理」，
 * 实际执行进度通过会话事件流输出。
 */
export type RpcResponse =
	// 提示输入（异步——后续进度经事件流输出）
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// 状态
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// 模型
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// 思考级别
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// 排队模式
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// 上下文压缩
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// 自动重试
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash 执行
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// 会话管理
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// 消息读取
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// 斜杠命令
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// 错误响应兜底：任何命令失败都落到这一形态
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// 扩展 UI 请求（stdout，server → client）
// ============================================================================

/**
 * 扩展 UI 请求（server → client，stdout）。
 *
 * 扩展调用 select/confirm/input 等交互 API 时，RPC 模式没有 TUI 可弹，
 * 改为发出本请求由宿主客户端代为展示，客户端用相同 id 回发
 * RpcExtensionUIResponse；带 timeout 的请求超时后按默认值收场。
 * notify/setStatus/setWidget/setTitle/set_editor_text 为即发即弃，无需应答。
 */
export type RpcExtensionUIRequest =
	// 单选列表：客户端回发 { value }
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	// 确认框：客户端回发 { confirmed }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	// 文本输入框：客户端回发 { value }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	// 多行编辑器：客户端回发 { value }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	// 通知提示（即发即弃）：info/warning/error 三种级别
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	// 设置状态栏片段（即发即弃）：text 传 undefined 表示清除
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	// 设置小部件内容（即发即弃）：lines 传 undefined 表示清除
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	// 设置终端/窗口标题（即发即弃）
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	// 整体替换编辑器文本（即发即弃）
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// 扩展 UI 响应（stdin，client → server）
// ============================================================================

/**
 * 扩展 UI 响应（client → server，stdin）。
 *
 * 与 RpcExtensionUIRequest 的 id 配对：三种形态分别应答值类请求
 * （select/input/editor）、确认类请求（confirm）与用户取消。
 */
export type RpcExtensionUIResponse =
	// 值类请求的答案
	| { type: "extension_ui_response"; id: string; value: string }
	// 确认类请求的答案
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	// 用户取消：服务端将按各请求的默认值收场
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// 辅助类型：提取命令类型字面量
// ============================================================================

/** 全部 RPC 命令的 type 字面量联合，便于外部做穷举 switch 或类型守卫 */
export type RpcCommandType = RpcCommand["type"];
