/**
 * @file client 包出口（barrel）
 *
 * @description
 * 把远程会话客户端的公开 API 汇总为 `pi-coding-agent/client` 单一入口，
 * 供 TUI 与外部集成方使用：RemoteSession 状态机、转录纯函数及其类型。
 */

// RemoteSession：远程会话状态机（生命周期管理 + 转录维护）
export {
	type CreateRemoteSessionOptions,
	RemoteSession,
	type RemoteSessionLifecycle,
	type RemoteSessionOperation,
	type RemoteSessionOptions,
	type RemoteSessionState,
} from "./remote-session.ts";
// 转录状态的纯函数工具（快照合并 / 增量应用 / 有序选择）
export {
	applyTranscriptProgress,
	applyTranscriptSnapshot,
	createTranscriptState,
	selectTranscript,
	type TranscriptState,
} from "./transcript.ts";
