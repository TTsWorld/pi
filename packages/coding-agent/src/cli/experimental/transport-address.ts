/**
 * @file transport-address.ts —— RPC 传输地址的解析与校验
 *
 * @description
 * 实验性 client/server 命令通过 --listen/--connect 指定通信地址，目前仅支持
 * Unix domain socket（唯一合法形态：unix:/// 加绝对路径）。本文件负责把地址
 * 字符串严格解析为 TransportAddress，逐层拒绝各类变体写法（其他协议、
 * 带 authority、带 query/fragment、非绝对路径、含 NUL 等）。
 */
import { posix } from "node:path";

/** Unix domain socket 传输地址：socket 文件的绝对路径。 */
export interface UnixTransportAddress {
	readonly transport: "unix";
	readonly path: string;
}

/** 传输地址联合类型：当前仅有 unix 一种成员，未来可扩展 tcp 等。 */
export type TransportAddress = UnixTransportAddress;

/**
 * 解析并严格校验 --listen/--connect 的传输地址字符串。
 *
 * 只接受形如 `unix:///<绝对路径>` 的地址，其余任何写法都报错；
 * 返回 address / error 二选一的对象，解析失败不抛异常，
 * 由调用方决定如何呈现错误信息。
 */
export function parseTransportAddress(
	value: string,
	option: "--listen" | "--connect",
): { address?: TransportAddress; error?: string } {
	// 先用标准 URL 构造器做语法级校验，连合法 URL 都不是则直接报错
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	// 目前仅支持 unix 协议；tcp 等其他传输方式待未来扩展
	if (url.protocol !== "unix:") {
		return { error: `Unsupported ${option} transport "${url.protocol}"` };
	}
	// unix 地址没有 authority 概念，host/port/用户名/密码任一出现即视为写错
	if (url.hostname || url.port || url.username || url.password) {
		return { error: "Unix transport address must not include an authority" };
	}
	// 严格限定唯一合法形态 unix:///<绝对路径>：
	// 必须以三个斜杠开头且不是四个、不带 ?query 与 #fragment，
	// 且规范化后的 href 必须与原文逐字一致（挡住 URL 解析器会改写的变体）
	if (
		!value.startsWith("unix:///") ||
		value.startsWith("unix:////") ||
		value.includes("?") ||
		value.includes("#") ||
		url.href !== value
	) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	// 对路径做百分号解码；非法编码序列（如孤立的 %）会抛 URIError，需捕获转为错误
	let path: string;
	try {
		path = decodeURIComponent(url.pathname);
	} catch {
		return { error: `Invalid ${option} address "${value}"` };
	}
	// 路径不允许包含 NUL 字符，防止被底层 C 字符串语义截断引发歧义
	if (path.includes("\0")) {
		return { error: `Invalid ${option} address "${value}"` };
	}
	// 必须是绝对路径；统一按 posix 规则判断，保证跨平台行为一致
	if (!posix.isAbsolute(path)) {
		return { error: "Unix transport address requires an absolute path" };
	}
	return { address: { transport: "unix", path } };
}
