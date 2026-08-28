/** @file cli.ts —— 实验性子命令入口 shim：组合 pi / server / client 子命令并暴露聚合上下文类型。 */
import { type ClientCommandContext, clientCommand } from "./commands/client.ts";
import { type PiCommandContext, piCommand } from "./commands/pi.ts";
import { type ServerCommandContext, serverCommand } from "./commands/server.ts";

/** 实验性 CLI 聚合上下文：pi / server / client 三个子命令所需上下文的交集。 */
export type ExperimentalCliContext = PiCommandContext & ServerCommandContext & ClientCommandContext;

/** 实验性 CLI 顶层命令树：以 piCommand 为根节点，链式挂载 server / client 子命令。 */
export const experimentalCli = piCommand.command(serverCommand).command(clientCommand);
