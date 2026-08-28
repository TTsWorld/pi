/**
 * @file clipboard-image.ts —— 跨平台读取剪贴板中的图片
 *
 * @description
 * 用于「粘贴截图给 AI」功能：把系统剪贴板里的图片读出为
 * `{ bytes, mimeType }`，供后续作为多模态消息内容发给模型。
 *
 * 主要功能点：
 * - Linux：按会话类型分流——Wayland 用 wl-paste，X11 用 xclip，
 *   WSL 下额外用 PowerShell 直读 Windows 剪贴板兜底（Linux 侧剪贴板
 *   收不到 Win+Shift+S 的截图数据）；
 * - macOS / Windows：走原生剪贴板绑定（clipboard-native）；
 * - 格式协商：从剪贴板提供的多个 MIME target 中按支持优先级挑选；
 * - 格式转换：模型不支持的格式（如 WSLg 的 BMP）经 Photon（WASM）
 *   转码为 PNG，失败则放弃本次读取。
 *
 * 依赖关系：
 * - `./clipboard-native.ts`：Node 原生剪贴板绑定；
 * - `./photon.ts`：懒加载的 Photon WASM 图像编解码库。
 */

import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { readFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { clipboard } from "./clipboard-native.ts";
import { loadPhoton } from "./photon.ts";

/** 剪贴板图片的统一表示：原始字节 + MIME 类型 */
export type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

/** 模型侧支持的图片 MIME 类型，按优先级排列（靠前的优先读取） */
const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** 探测剪贴板可用格式列表的超时时间（探测命令应当立即返回） */
const DEFAULT_LIST_TIMEOUT_MS = 1000;
/** 读取剪贴板图片数据的默认超时时间 */
const DEFAULT_READ_TIMEOUT_MS = 3000;
/** PowerShell（WSL 场景）读写剪贴板的超时时间（进程启动较慢，给更长时间） */
const DEFAULT_POWERSHELL_TIMEOUT_MS = 5000;
/** 命令输出缓冲上限：50MB，防止超大图片撑爆内存 */
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

/**
 * 判断当前会话是否为 Wayland 图形会话。
 * 除显式的 WAYLAND_DISPLAY 外，还检查 XDG_SESSION_TYPE，
 * 因为部分环境只设置后者。
 */
export function isWaylandSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

/**
 * 归一化 MIME 类型：去掉 ";" 后的参数部分（如 charset）、
 * 去首尾空白并转小写，便于与支持列表精确比较。
 */
function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

/**
 * 根据图片 MIME 类型返回常用文件扩展名（jpeg 映射为 jpg）。
 * 不认识的类型返回 null。
 */
export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

/**
 * 从剪贴板提供的多个 MIME target 中选出最合适的一个。
 * 先按 SUPPORTED_IMAGE_MIME_TYPES 的优先级匹配；都不命中时
 * 退而求其次接受任意 image/*（读取后再决定是否转码）。
 * 返回原始（未归一化的）target 字符串，因为调用方要把它
 * 原样传回剪贴板命令。
 */
function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((t) => t.trim())
		.filter(Boolean)
		.map((t) => ({ raw: t, base: baseMimeType(t) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((t) => t.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	// 兜底：接受任何图片类型（如 image/bmp），后续走转码流程
	const anyImage = normalized.find((t) => t.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

/** 判断（归一化后的）MIME 类型是否在模型支持列表中 */
function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.some((t) => t === base);
}

/**
 * 用 Photon（WASM）把不支持的图片格式转码为 PNG。
 * Photon 未加载成功或转码失败时返回 null（调用方据此放弃本次读取）。
 */
async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			// get_bytes 默认输出 PNG 编码
			return image.get_bytes();
		} finally {
			// WASM 侧的内存不会自动回收，必须显式 free 避免泄漏
			image.free();
		}
	} catch {
		// 解码失败（数据不是有效图片等）时静默放弃
		return null;
	}
}

/**
 * 同步执行外部命令并收集 stdout。
 * 统一施加超时与缓冲上限；spawn 出错或退出码非 0 都返回 ok: false
 * 与空 Buffer，调用方据此尝试下一种读取途径。
 */
function runCommand(
	command: string,
	args: string[],
	options?: { timeoutMs?: number; maxBufferBytes?: number; env?: NodeJS.ProcessEnv },
): { stdout: Buffer; ok: boolean } {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
		env: options?.env,
	});

	if (result.error) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	if (result.status !== 0) {
		return { ok: false, stdout: Buffer.alloc(0) };
	}

	// 个别环境可能返回字符串而非 Buffer，这里统一转回 Buffer（保证二进制安全）
	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);

	return { ok: true, stdout };
}

/**
 * 通过 wl-paste（Wayland 剪贴板工具）读取图片。
 * 分两步：先 `--list-types` 枚举可用格式并挑选最合适的，
 * 再用 `--type <mime>` 按所选格式读出原始字节。
 */
function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((t) => t.trim())
		.filter(Boolean);

	const selectedType = selectPreferredImageMimeType(types);
	if (!selectedType) {
		// 剪贴板里没有任何图片格式
		return null;
	}

	// --no-newline：避免工具在输出末尾追加换行符破坏二进制数据
	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

/**
 * 判断当前 Linux 环境是否运行在 WSL 下。
 * 优先检查 WSL 特有的环境变量；都没有时读 /proc/version
 * 检查其中是否含有 microsoft 字样（WSL 内核版本串的标志）。
 */
function isWSL(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.WSL_DISTRO_NAME || env.WSLENV) {
		return true;
	}

	try {
		const release = readFileSync("/proc/version", "utf-8");
		return /microsoft|wsl/i.test(release);
	} catch {
		return false;
	}
}

/**
 * 在 WSL 环境下通过 PowerShell 直读 Windows 剪贴板。
 *
 * 背景：Linux 侧剪贴板（Wayland/X11）收不到 Windows 截图
 * （Win+Shift+S）的图片数据；而 PowerShell 能直接访问 Windows
 * 剪贴板，故作为兜底方案：让 PowerShell 把剪贴板图片以 PNG
 * 写入 Linux 可见的临时文件，再从该文件读回字节。
 */
function readClipboardImageViaPowerShell(): ClipboardImage | null {
	const tmpFile = join(tmpdir(), `pi-wsl-clip-${randomUUID()}.png`);

	try {
		// wslpath 把 Linux 路径转换为 Windows 路径，PowerShell 才能访问该文件
		const winPathResult = runCommand("wslpath", ["-w", tmpFile], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
		if (!winPathResult.ok) {
			return null;
		}

		const winPath = winPathResult.stdout.toString("utf-8").trim();
		if (!winPath) {
			return null;
		}

		// PowerShell 单引号字符串中用双单号转义单引号
		const psQuotedWinPath = winPath.replaceAll("'", "''");
		const psScript = [
			"Add-Type -AssemblyName System.Windows.Forms",
			"Add-Type -AssemblyName System.Drawing",
			`$path = '${psQuotedWinPath}'`,
			"$img = [System.Windows.Forms.Clipboard]::GetImage()",
			"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
		].join("; ");

		const result = runCommand("powershell.exe", ["-NoProfile", "-Command", psScript], {
			timeoutMs: DEFAULT_POWERSHELL_TIMEOUT_MS,
		});
		if (!result.ok) {
			return null;
		}

		const output = result.stdout.toString("utf-8").trim();
		if (output !== "ok") {
			// "empty" 表示 Windows 剪贴板里没有图片，其他输出视为失败
			return null;
		}

		const bytes = readFileSync(tmpFile);
		if (bytes.length === 0) {
			return null;
		}

		return { bytes: new Uint8Array(bytes), mimeType: "image/png" };
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(tmpFile);
		} catch {
			// 忽略清理临时文件的错误（文件可能未被创建）。
		}
	}
}

/**
 * 通过 xclip 读取 X11 剪贴板中的图片。
 * 先用 `-t TARGETS` 枚举可用格式；若枚举失败（部分环境不支持），
 * 则退化为逐个尝试所有受支持的 MIME 类型直接读取。
 */
function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((t) => t.trim())
			.filter(Boolean);
	}

	// 优先尝试剪贴板声明的最佳格式，其后依次兜底尝试所有支持格式
	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];

	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

/**
 * 通过原生绑定（macOS / Windows）读取剪贴板图片。
 * 原生接口总是返回 PNG 编码，故 MIME 固定为 image/png。
 */
async function readClipboardImageViaNativeClipboard(): Promise<ClipboardImage | null> {
	// clipboard 为空表示当前平台的原生模块不可用（如 Linux 未编译）
	if (!clipboard || !clipboard.hasImage()) {
		return null;
	}

	const imageData = await clipboard.getImageBinary();
	if (!imageData || imageData.length === 0) {
		return null;
	}

	// 兼容旧接口返回普通数组的情况
	const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
	return { bytes, mimeType: "image/png" };
}

/**
 * 读取剪贴板图片的统一入口（跨平台）。
 *
 * 读取策略按平台分发：
 * - Termux：剪贴板无图片 API，直接返回 null；
 * - Linux：Wayland/WSL 先试 wl-paste 再试 xclip；WSL 下两者都失败
 *   再走 PowerShell 直读 Windows 剪贴板；纯 X11 会话先试原生绑定
 *   （可能由 X11 转发提供）再试 xclip；
 * - 其他平台（macOS/Windows）：仅原生绑定。
 *
 * 读到图片后若格式不受支持（如 WSLg 产生的 BMP），统一转码为 PNG；
 * 转码失败视为本次读取失败。
 *
 * @param options - 可注入 env 与 platform，便于测试模拟不同环境
 * @returns 图片字节与 MIME 类型；剪贴板无图片或读取失败返回 null
 */
export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;

	// Termux 环境下没有可用的剪贴板图片读取途径
	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;

	if (platform === "linux") {
		const wsl = isWSL(env);
		const wayland = isWaylandSession(env);

		// Wayland 会话用 wl-paste；WSLg 桌面也是 Wayland 合成器，同样先走这条路
		if (wayland || wsl) {
			image = readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip();
		}

		// WSL 下 Linux 侧剪贴板可能拿不到 Windows 截图，用 PowerShell 兜底
		if (!image && wsl) {
			image = readClipboardImageViaPowerShell();
		}

		// 纯 X11 会话：原生绑定（X11 转发场景）优先，xclip 兜底
		if (!image && !wayland) {
			image = (await readClipboardImageViaNativeClipboard()) ?? readClipboardImageViaXclip();
		}
	} else {
		image = await readClipboardImageViaNativeClipboard();
	}

	if (!image) {
		return null;
	}

	// 把不支持的格式（如来自 WSLg 的 BMP）转码为 PNG
	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
