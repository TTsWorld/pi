/**
 * @file 会话级资源的清理回调注册表。
 * @description packages/ai 内部有些 provider 会按会话持有需要显式释放的资源
 * （例如 OpenAI Codex 适配器按 sessionId 维护的 WebSocket 连接池），但 SDK 本身并不
 * 知道宿主（coding-agent）的会话生命周期。本文件用一组「清理回调」解耦两侧：
 * provider 侧调用 registerSessionResourceCleanup 登记清理函数；宿主侧在会话结束
 * （如 agent-session 销毁时）调用 cleanupSessionResources(sessionId) 统一释放。
 */

/**
 * 会话资源清理回调：接收可选的 sessionId——指定时只释放该会话关联的资源，
 * 省略时释放全部会话的资源。
 */
export type SessionResourceCleanup = (sessionId?: string) => void;

// 所有已登记的清理回调；用 Set 便于反注册函数以 O(1) 移除
const sessionResourceCleanups = new Set<SessionResourceCleanup>();

/**
 * 登记一个会话资源清理回调，返回反注册函数供调用方卸载时移除自身。
 * 调用方：packages/ai 内持有会话态资源的模块，例如 openai-codex-responses.ts
 * 用它登记 closeOpenAICodexWebSocketSessions 以关闭 Codex WebSocket 连接池。
 */
export function registerSessionResourceCleanup(cleanup: SessionResourceCleanup): () => void {
	sessionResourceCleanups.add(cleanup);
	return () => {
		sessionResourceCleanups.delete(cleanup);
	};
}

/**
 * 执行所有已登记的清理回调；传入 sessionId 时由各回调自行只释放该会话的资源，
 * 省略则释放全部。单个回调抛错不会中断其余清理——错误先收集，最后以 AggregateError
 * 一次性抛出，保证尽可能多的资源得到释放。调用方：coding-agent 的 agent-session
 * 在会话结束时。
 */
export function cleanupSessionResources(sessionId?: string): void {
	const errors: unknown[] = [];
	for (const cleanup of sessionResourceCleanups) {
		try {
			cleanup(sessionId);
		} catch (error) {
			errors.push(error);
		}
	}
	if (errors.length > 0) {
		throw new AggregateError(errors, "Failed to cleanup session resources");
	}
}
