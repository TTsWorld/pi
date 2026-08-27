/**
 * @file 懒加载 API 基建（lazyApi / lazyStream）。
 * @description 各 provider 的完整实现文件动辄数百上千行，直接静态引入会拖慢启动。
 * 这里把「动态 import 实现模块」包装成统一的 ProviderStreams 形状，首次真正调用流方法时才加载。
 */
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderStreams } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";

/** 构造一条 setup 阶段出错（如鉴权失败、模块加载失败）时的错误 AssistantMessage，作为流的终止结果。 */
function createSetupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

/** 类型守卫：判断事件源是否带 result() 方法（可获取最终聚合结果）。 */
function hasResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/** 把内层源的事件逐个转发到目标流，结束时透传最终 result（如有）。 */
async function forwardStream(
	target: AssistantMessageEventStream,
	source: AsyncIterable<AssistantMessageEvent>,
): Promise<void> {
	for await (const event of source) {
		target.push(event);
	}
	target.end(hasResult(source) ? await source.result() : undefined);
}

/**
 * 同步返回一个事件流，同时在背后异步执行 setup（鉴权解析、懒加载模块），
 * setup 完成后把内层流的事件转发进来。setup 失败时以错误事件终止该流。
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
}

/**
 * 声明动态加载的实现模块额外支持哪些「延迟响应（deferred）」能力，
 * 供 lazyApi 决定在返回的 ProviderStreams 上暴露 fetchDeferred / cancelDeferred。
 */
export interface LazyApiCapabilities {
	/** 实现模块是否提供 fetchDeferred（拉取延迟响应）。 */
	fetchDeferred?: boolean;
	/** 实现模块是否提供 cancelDeferred（取消延迟响应）。 */
	cancelDeferred?: boolean;
}

/**
 * 把「动态加载实现模块」包装成 ProviderStreams：首次调用流方法时才真正 import，
 * 宿主的 import 缓存会对重复加载去重；加载失败时以错误事件终止返回的流。
 */
export function lazyApi(load: () => Promise<ProviderStreams>, capabilities?: LazyApiCapabilities): ProviderStreams {
	const api: ProviderStreams = {
		stream: (model, context, options) =>
			lazyStream(model, async () => (await load()).stream(model, context, options)),
		streamSimple: (model, context, options) =>
			lazyStream(model, async () => (await load()).streamSimple(model, context, options)),
	};

	if (capabilities?.fetchDeferred) {
		// 声明了 fetchDeferred 能力：同样经 lazyStream 懒加载转发，模块缺失该能力时报错
		api.fetchDeferred = (model, handle, options) =>
			lazyStream(model, async () => {
				const implementation = await load();
				if (!implementation.fetchDeferred) throw new Error("API does not support deferred responses");
				return implementation.fetchDeferred(model, handle, options);
			});
	}
	if (capabilities?.cancelDeferred) {
		// 取消延迟响应是一次性动作而非流：直接 await 加载后调用
		api.cancelDeferred = async (model, handle, options) => {
			const implementation = await load();
			if (!implementation.cancelDeferred) throw new Error("API cannot cancel deferred responses");
			await implementation.cancelDeferred(model, handle, options);
		};
	}

	return api;
}
