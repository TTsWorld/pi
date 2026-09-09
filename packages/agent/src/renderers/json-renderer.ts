/**
 * @file JSONL 渲染器
 * @description 将 agent 产生的每个事件逐条 JSON.stringify 后输出到 stdout，
 *              形成 JSONL（每行一个 JSON 对象）流，供下游程序化消费（如管道、日志解析）。
 */
import type { AgentEvent, AgentEventReceiver } from "../agent.js";

/** JSON 渲染器：实现 AgentEventReceiver 接口，把每个事件序列化为一行 JSON 输出 */
export class JsonRenderer implements AgentEventReceiver {
	/** 接收一个 agent 事件，并将其序列化为单行 JSON 打印到控制台 */
	async on(event: AgentEvent): Promise<void> {
		console.log(JSON.stringify(event));
	}
}
