/**
 * @file json-renderer.ts
 * @description JSON 流渲染器 —— 将每个 AgentEvent 以 JSONL 形式输出到 stdout，供程序化消费
 * @module pi-agent
 *
 * 主要功能：
 * - 实现 AgentEventReceiver 接口，把每个事件原样序列化为单行 JSON 写往 stdout
 * - 不做任何着色 / 截断 / 动画等人向美化，输出即机器可直接解析的 JSONL 事件流
 * - 配合 cli 的 --json 模式使用：stdin 逐行读入 JSONL 命令、stdout 逐行输出 JSONL 事件，
 *   形成双向流协议，便于任意语言的宿主进程（自定义 UI、编排脚本等）程序化驱动 agent
 */
import type { AgentEvent, AgentEventReceiver } from "../agent.js";

/**
 * JSON 流渲染器：面向程序化消费的 AgentEventReceiver 实现。
 *
 * 与面向人类终端的 ConsoleRenderer / TuiRenderer 不同，本渲染器把每个事件
 * 原样 JSON.stringify 后逐行 console.log 到 stdout，每行一个独立 JSON 对象
 * （即 JSONL / NDJSON 格式）。典型使用场景：
 * - cli 的 --json 交互模式：作为子进程被宿主程序调用，stdin 命令 ↔ stdout 事件的双向流
 * - 单次执行模式加 --json 开关：输出可用管道 / jq 等工具直接解析
 */
export class JsonRenderer implements AgentEventReceiver {
	/**
	 * 接收一个 Agent 事件并将其序列化为一行 JSON 写到 stdout。
	 *
	 * console.log 自带换行，因此每个事件恰好独占一行；消费方按行切分后
	 * 逐条 JSON.parse 即可还原完整事件流。
	 *
	 * @param event Agent 产生的任意事件（会话开始/结束、助手消息、思考、工具调用/结果、错误、打断等）
	 */
	async on(event: AgentEvent): Promise<void> {
		console.log(JSON.stringify(event));
	}
}
