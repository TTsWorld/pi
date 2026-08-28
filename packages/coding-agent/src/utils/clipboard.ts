/**
 * @file clipboard.ts —— 跨平台剪贴板读写（多实现逐级降级）
 *
 * @description
 * 统一的剪贴板入口：
 * - 写入（copyToClipboard）：优先原生 addon（非 Linux）→ 平台命令
 *   （pbcopy / clip / termux-clipboard-set / wl-copy / xclip / xsel）→ OSC 52 转义序列兜底；
 * - 读取（readClipboardText）：Wayland 会话先试 wl-paste，否则走原生 addon；
 * - 远程会话（SSH/Mosh）下额外发 OSC 52，让本地终端代替远端写剪贴板。
 *
 * 依赖关系：
 * - `./clipboard-native.ts`：可选加载的原生剪贴板 addon（clipboard-rs）；
 * - `./clipboard-image.ts`：`isWaylandSession` 判断当前 Linux 会话类型；
 * - `node:child_process` / `node:os`：调用各平台剪贴板命令。
 */
import { type ExecFileSyncOptionsWithStringEncoding, execFileSync, execSync, spawn } from "child_process";
import { platform } from "os";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

/** 调用外部剪贴板命令的统一执行参数：文本经 stdin 传入、忽略子进程输出、限时防挂起 */
type NativeClipboardExecOptions = {
	input: string;
	timeout: number;
	stdio: ["pipe", "ignore", "ignore"];
};

/** 向 X11 剪贴板写入：优先 xclip，未安装时退回 xsel */
function copyToX11Clipboard(options: NativeClipboardExecOptions): void {
	try {
		execSync("xclip -selection clipboard", options);
	} catch {
		execSync("xsel --clipboard --input", options);
	}
}

// OSC 52 载荷上限（base64 编码后的字符数）：过大会卡住或错乱终端渲染
const MAX_OSC52_ENCODED_LENGTH = 100_000;

/** 判断是否处于远程会话（SSH / Mosh）：此时需借助 OSC 52 让本地终端代写剪贴板 */
function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

/**
 * 通过 OSC 52 转义序列让终端自身把文本写入剪贴板。
 * 载荷超过上限时放弃（返回 false），由调用方决定是否报错。
 */
function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	// ESC ] 52 ; c ; <base64> BEL，其中 c 表示系统剪贴板
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/** wl-paste 读取结果：ok=true 时 text 为剪贴板文本（空剪贴板为 null）；ok=false 表示命令不可用或失败 */
type ClipboardReadResult = { ok: true; text: string | null } | { ok: false };

const READ_CLIPBOARD_OPTIONS: ExecFileSyncOptionsWithStringEncoding = {
	encoding: "utf8",
	// 剪贴板内容可能很大（如用户复制了整个文件），给足缓冲；同时限时防挂起
	maxBuffer: 50 * 1024 * 1024,
	timeout: 5000,
};

/** 在 Wayland 会话下用 wl-paste 读取纯文本剪贴板 */
function readWaylandClipboardText(): ClipboardReadResult {
	try {
		const text = execFileSync("wl-paste", ["--no-newline", "--type", "text"], READ_CLIPBOARD_OPTIONS);
		return { ok: true, text: text || null };
	} catch {
		return { ok: false };
	}
}

/**
 * 读取系统剪贴板中的纯文本。
 * Linux Wayland 会话优先走 wl-paste（原生 addon 在 Wayland 下不可靠），
 * 其余情况走原生 addon；读不到或失败统一返回 null，不向上抛错。
 */
export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux" && isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		const result = readWaylandClipboardText();
		if (result.ok) {
			return result.text;
		}
	}

	// 原生 addon 未加载（可选依赖）时无从读取
	if (!clipboard) {
		return null;
	}

	try {
		const text = await clipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

/**
 * 把文本写入系统剪贴板，按「原生 addon → 平台命令 → OSC 52」逐级降级；
 * 远程会话下即使已写入成功也会追加 OSC 52，让本地终端同步剪贴板。
 * 所有途径都失败时抛出错误。
 */
export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();

	// 优先直接写原生剪贴板。若先发 OSC 52，终端可能与 addon 并发写同一个
	// 原生剪贴板；而且超大的 OSC 52 载荷会错乱终端渲染。
	//
	// Linux 上跳过原生 addon：其底层 `clipboard-rs` crate 只支持 X11，
	// 且 `set_text` resolve 后不保留 selection 所有权——在纯 Wayland 合成器
	// （Hyprland、Niri……）甚至部分 X11 会话上，调用成功返回但剪贴板实际
	// 没有内容。下面的平台工具（wl-copy、xclip、xsel）会正确地守护进程化
	// 并保持所有权。
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// 失败则继续尝试平台特定的剪贴板命令。
	}

	const remote = isRemoteSession();
	// 本地会话且已写入成功：直接完成，无需 OSC 52
	if (copied && !remote) {
		return;
	}

	const options: NativeClipboardExecOptions = { input: text, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] };

	if (!copied) {
		// ===== 平台命令降级链：macOS pbcopy / Windows clip / Linux 多工具 =====
		try {
			if (p === "darwin") {
				execSync("pbcopy", options);
				copied = true;
			} else if (p === "win32") {
				execSync("clip", options);
				copied = true;
			} else {
				// Linux：依次尝试 Termux、Wayland、X11 的剪贴板工具。
				if (process.env.TERMUX_VERSION) {
					try {
						execSync("termux-clipboard-set", options);
						copied = true;
					} catch {
						// 退回到 Wayland 或 X11 工具。
					}
				}

				if (!copied) {
					const hasWaylandDisplay = Boolean(process.env.WAYLAND_DISPLAY);
					const hasX11Display = Boolean(process.env.DISPLAY);
					const isWayland = isWaylandSession();
					if (isWayland && hasWaylandDisplay) {
						try {
							// 先确认 wl-copy 存在（spawn 的报错是异步事件，不会被外层 try 捕获）
							execSync("which wl-copy", { stdio: "ignore" });
							// execSync 跑 wl-copy 会因 fork 行为挂起，改用 spawn；
							// 等待退出码，只有干净退出（0）才算成功，
							// 这样失败的 wl-copy 能继续落到 xclip / OSC 52 兜底。
							const wlCopyExit = await new Promise<number>((resolve) => {
								const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
								proc.on("error", () => resolve(1));
								proc.on("close", (code) => resolve(code ?? 1));
								proc.stdin.on("error", () => {
									// wl-copy 提前退出时忽略 EPIPE 错误
								});
								proc.stdin.write(text);
								proc.stdin.end();
							});
							if (wlCopyExit === 0) {
								copied = true;
							} else if (hasX11Display) {
								// wl-copy 失败但存在 XWayland：退回 X11 工具
								copyToX11Clipboard(options);
								copied = true;
							}
						} catch {
							if (hasX11Display) {
								copyToX11Clipboard(options);
								copied = true;
							}
						}
					} else if (hasX11Display) {
						copyToX11Clipboard(options);
						copied = true;
					}
				}
			}
		} catch {
			// 继续落到 OSC 52 兜底。
		}
	}

	// 远程会话（或以上途径全部失败）时发 OSC 52，让本地终端写入剪贴板
	if (remote || !copied) {
		const osc52Copied = emitOsc52(text);
		copied = copied || osc52Copied;
	}

	// 一个途径都没成功：明确报错而非静默丢弃
	if (!copied) {
		throw new Error("Failed to copy to clipboard");
	}
}
