/**
 * @file daxnuts.ts —— "Powered by daxnuts" 彩蛋组件
 *
 * POWERED BY DAXNUTS —— OpenCode + Kimi K2.5 的 Easter egg（彩蛋）。
 * 谨以此向 dax（@thdxr）致敬，感谢其通过 OpenCode 免费提供 Kimi K2.5 访问。
 *
 * @description
 * 在终端里播放一段约 2 秒的开机动画：把内置的 32x32 RGB 像素图（十六进制编码）
 * 用半块字符（▄）压成 16 行带 ANSI 真彩色的文本，先以"扫描线"效果逐行显现头像，
 * 随后分阶段淡入致谢与推广文案。动画由 80ms 间隔的 setInterval 驱动，
 * 渲染结果按「终端宽度 + 帧号」缓存，避免每帧重复构建转义序列。
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// dax 头像的 32x32 RGB 图像数据，十六进制编码（每像素 3 字节 = R/G/B 各 2 个 hex 字符）
const DAX_HEX =
	"bbbab8b9b9b6b9b8b5bcbbb8b8b7b4b7b5b2b6b5b2b8b7b4b7b6b3b6b4b1bdbcb8bab8b6bbb8b5b8b5b1bbb8b4c2bebbc1bebac0bdbabfbcb9c1bebabfbebbc0bfbcc0bdbabbb8b5c1bfbcbfbcb8bbb9b6bfbcb8c2bfbcc1bfbcbfbbb8bdb9b6b8b7b5b9b8b5b8b8b5b5b5b2b6b5b2b8b7b4b9b8b5b9b8b5b6b5b3bab8b5bcbab7bbb9b6bbb8b5bfb9b5bdb2abbcb0a8beb2aabeb5afbfbab6bebab7c0bfbcbebdbabebbb8c0bdbabfbebbc2bebbbdbab7c3c0bdc3c0bdc1bebbc2bebabfbcb8bab9b6b7b6b3b2b1aeb6b5b2b5b4b1b5b4b2b6b5b2b7b6b4b9b8b6b7b6b3bbbab7b2afaba5988fb49e90b09481b79a88b39683b09583b7a395bfb6b0c0bdbabdbbb8bebcb9c1bfbcc0bebbbdbab7bebbb8c2bfbcc0bdbac0bcb9bdb9b6c0bcb8b5b4b2b4b3b0bab9b6b9b9b6b5b4b1b5b4b1b6b5b3b9b8b5b9b8b6b9b8b6b2aeaa968174a6836eaa856eab846eaf8973ac8973b08f79b18f7ab39786b7a89dbbb3aebfbab6c2c0bdbebcb9bfbdbac3c1bdc2bebbc0bcb9bdb9b6c1bdbabfbbb8b4b3b0b9b8b5b8b7b5b4b3b1b5b4b1b8b7b4b8b7b5bab9b6bbbab7b1afad8c7a719d735ca47860a87d65a98069ae8972ae8c75af8d77aa826ba98067aa8974b39e90b6a79dbbb2adc0bdbac1bfbdbfbbb8c1bdb9bebab6c0bdb9bfbbb8c1bdbab4b2b0b7b6b4b7b6b3b4b2b0bab9b7b6b5b2b6b5b2bab9b6bab9b6958c87977663aa836bac8772b08f7aad8c77b2917db0917db0907cac8971a77d64a87f67ac8972b29887b8a89dbfbab5bfbdbac1bebac0bcb9c0bcb9c0bcb9c1bebabebab7b8b7b4b7b6b4b5b4b1b5b4b2b7b6b3b5b4b2bab9b7bab9b6b4b1ada88f7fad8973ae8d78b19684b19685b29786b69a89b29582b1917daa856ea87e66a97e66ad866ea9826baf9280b8ada6bdbbb8bebab7bfbbb8c1bdbabfbbb8bcb8b4bcb8b5b6b4b2b7b5b3b6b5b2b8b7b4b3b2afb8b7b4b6b5b2b3b2b0b3a59aab856fad8d78b0917eb19886b49b8bb49a89b39785b0917eaf8f7cab866fa77d65a77a61a87d64a9816ab08f79b5a296c1bcb8c3bfbcc2bebbbebab7bfbbb7bdbab6c2bebab8b7b4b7b6b4b6b5b3b7b6b3b6b5b2b9b8b6b4b3b1b6b1acac8f7ca9826bae8f7aaf9583b49c8cb49c8bb79d8cb59987b19380ad8e79ae8c77af8e78ac8771a3775faa826bae8972b39888bbb6b2bebbb8bfbbb8bfbbb8c0bdb9bebbb7c0bdb9b6b5b2b9b8b5b4b3b1b8b7b5b4b3b0b7b6b4b6b5b3b1a7a0aa8772a77d65a88570b49887b19b8d9c887c907a6d987f71aa907faf917daf8e7aad8c78ac8b77a8836ca9836cac8770b49b8abdb6b2c0bcb9c0bdb9bfbbb8bebab7bfbcb9bebab7b9b8b6b5b4b2b9b8b5b8b7b5b8b7b4b7b6b4b5b4b2b3a9a2ad8973a1755da9856fb398858c776a65544b776358725d526e594d9c7f6eb1907ba68672ad8e7aab8771ac856db18f79b3a092beb9b5c1bdbabdb9b5bebab7bfbbb7bebab7bcb9b6b7b6b4b6b6b3b8b7b4b5b4b2b8b6b4b7b6b3b4b3b0b4aba4a6826ba3775fb08e79b19584a88e7daa8e7db29481ad8f7c997e6da38674ac8d79ac8e7aae917f9a7c6a896a599a7c6ab3a398c1bdbabdb9b6bcb8b5bebab6bebab7bdb9b5bdb9b6b5b4b1b7b5b3b5b4b2b7b6b3b7b6b4b3b3b0b3b2b0b4aca5a7846fa97f68ae8f7bae9383b59c8bb2937fae8e79ac8b76af927eaf927eb29683b39885b2988891786a72594c6e594d978d86bdbab7bab7b3c0bcb9c0bcb9bebab7bebbb7bdb9b6b3b2b0b4b3b0b5b4b2b4b4b1b4b3b1b4b3b1b4b3b0b6ada5aa8670a57a62ad8e7ab29b8cb69d8dab856fa9826aa88069ab8771af907db49987b19684b29886b59987b39480b09787b5a9a1bcb8b5bebab7bdb9b5bebab7bfbbb8bfbbb7bbb7b4b3b2afb8b7b5b8b7b5b3b2b0b5b4b2b6b5b3b6b4b1afa299a98975a9826baf907cb39988b49a89af8e7aac8973aa856eaf8c74b1917dae907dac907db39988b29785b49785b7a090b9aca3bfbab7bcb8b5bdb9b6bcb8b4bcb8b5bdb9b5bcb8b4b5b4b2b6b5b3b4b3b0b4b3b0b9b8b5b8b6b4908b88887467aa8f7ea78976ad8973b08b74b59885b69e8eb29888b1917cb1917db1937fae907cb19686b39a8ab29886b59b8ab8a192b6aaa3b7b2afbcb8b4bcb8b5bbb7b4c0bcb9bebab7c0bcb9b6b5b2b6b5b3b4b3b0bab9b7b7b6b4b1b0ae7b716ba083709b806f716158967764b08870b29481b69b8ab69f8fb39a89b69f90b49d8db39a89b29988b49c8cb6a090b8a496baa49593867f8f8986bfbbb7bdb9b5bcb7b4bab6b3b9b5b2bab6b2b4b3b1b3b3b0b6b5b3b8b7b5b4b2b0a7a5a38f837dae917ea084725a504c63544da28370b39784b59e8db2a093a698909b918b998e8790857e95877dad998bb39c8cb5a091b9a2938d827c95908dbebab6bbb7b3bdbab7bbb7b4bdb9b6bbb7b4b4b3b0b5b4b1b8b7b5b6b5b3b8b8b5b4b2af968f8ab29a8bab9485544b483a323073655d96887f70655f61595547403e453e3c453f3d57504f655e5b90847db39c8db7a090b6a09189807aaba6a3bdb9b6c0bcb9bebab7bcb7b4bebab7bbb7b4b3b2b0b6b5b3b2b1afb7b6b4b8b7b4b5b4b1aeaba8b5a89fac998d4d44412d25244d46444e4744322b293a3230423937433a37352d2a59504c534b48524a48988a81b59f8fb19c8d827974b2afacbdb9b5bcb8b4bdb9b5bcb8b5bdb9b6bab6b2b8b7b5b5b4b2b6b6b3b9b8b5b7b6b3b6b5b2b8b6b3b9b4b1b2a9a26c64612d25242d2625312a28352d2c453d3a78675c8d7a6ea09792aea6a0615854332b29524a479f8e82b09d90a49b96c1bdb9bebab7bfbbb8bbb8b4b9b5b1b8b4b0b9b4b0b7b6b4b8b7b5b8b7b4b6b5b3b8b6b3bab9b6b9b8b5b4b3b0b7b5b2a5a29f453d3b261e1d261f1e2e2625413936857268977865b19482b5a69caca5a07c7572453d3b746963a0948cc5bfbbc0bbb8beb9b6bbb7b3bbb6b3b7b3afb8b4b0b9b5b1b7b6b3b6b5b3b5b4b2b5b4b2b7b6b3b7b6b3b8b6b3b4b2afb7b6b3b3b1ae6d6765251f1e1e18172a22212d2523443b3971625ab19888b09482a89182877e792c25243e3634766d6abeb9b5bfbbb7bebab6bcb7b3bbb6b3b9b5b1b7b3afb8b4b0b4b3b0b5b4b1b5b4b1b4b3b1b5b4b2b8b6b4b5b3b0b9b6b4b5b4b1b6b4b27f79762a2322221c1b2d2524221b1a443e3c47413f6f676281766f867971675e5a3e37352a222166605dbab7b3bdb9b5beb9b5bcb7b3bcb7b3b9b4b0bab6b2bab6b2b5b3b0b6b4b2b3b2afb7b6b3b4b4b1b4b3b0b6b4b1b5b4b1b4b3b0b9b6b29a8c8252474230292828201f181212322c2c231e1d1c16162c26252923222d26252d2523332b2a8e8885bcb8b5bcb7b3bbb6b2bcb7b3b9b4b1b9b5b1b7b2afb7b2ae7a838e9b9b9caeadacb3b2b0b3b2afb7b7b4b6b5b3b6b6b3b7b6b3b9ada4a991808e7b6f50453f2b24231a14142923221f19181d17161f18182620201d17162a22215d5654b7b3b0bbb7b3bbb6b2b8b4b0bab5b1bbb6b2bab5b1b8b4b0bab6b22c496b4c5d735f68766e727a828285929090adaba8b7b2aeb6a59ab39682a28470a387748e76674e403a1a14141d1716181211221c1c1f1918221c1b2f2827342d2c8d8884bab6b3b9b5b2bab5b1bab5b1b9b4b0bab6b2b8b4b0b9b4b0b7b2ae325e8b365f8a3a5d833f5b7a545f70646469706b6aa08f84b08e78b18e769f7e689e7f6b9e816d907766584940362d2a1c1615201b1a1a1413201a1a251e1d393331a39e9bbab5b1bcb7b3bab6b2b8b3afb8b4b0b9b4b0b9b4b1bab5b2b5b0ac3d6c9843729d44719c426e98415f805a64716f6a699d8677b1927eb3947faa89749d7a649f7f6ba487749e837186716454463f2c25231e181837302e3a33317a7471beb9b6bcb8b4bbb6b2b6b2aebab5b1b9b5b1b8b3afbab6b2b6b1adb5aeaa4877a14c7aa44e7ba345719a3a5d80586b7f767475927b6eb1927faf8e79b08e78a78169a07861a17f6aa58570a688749b83738270666f66618a8480a49e99b7b2aebab6b2bcb8b4b9b5b1b7b2aebab5b1b9b4b0b6b1aeb6b1adb2aca8b2aca84876a04a78a2517fa74771973a5d80405c7a6161677c695fac8a75b08d77b4917aaf8971ad876fa5816aa6846ea78670a98a76ac9484ab9f96b2aca8bdb8b4bcb7b3bcb8b4bcb8b4b8b3afb7b2aeb9b4b0b8b3afb8b2aeb6afabb3aeaab2aeaa4878a14b7aa34c7ba44a759b3d63873b5f825b67766f5f569c7e6caf8c77b18f79b28f78b5927caf8e78a98872aa8a76a98a76ac917fada199b7b0acb9b3afbfb9b5c1bab6bdb6b2b8b3afbab5b1b9b4b0b6afabb7b1adb3ada9b3aeaab0aba8";

const WIDTH = 32; // 图像宽度（像素）
const HEIGHT = 32; // 图像高度（像素）

/**
 * 把 DAX_HEX 十六进制字符串解析为二维像素矩阵，返回 pixels[y][x] = [r, g, b]。
 */
function parseImage(): number[][][] {
	const pixels: number[][][] = [];
	for (let y = 0; y < HEIGHT; y++) {
		const row: number[][] = [];
		for (let x = 0; x < WIDTH; x++) {
			// 每像素占 6 个十六进制字符（R/G/B 各 2 个），据此换算出当前像素的起始下标
			const idx = (y * WIDTH + x) * 6;
			const r = parseInt(DAX_HEX.slice(idx, idx + 2), 16);
			const g = parseInt(DAX_HEX.slice(idx + 2, idx + 4), 16);
			const b = parseInt(DAX_HEX.slice(idx + 4, idx + 6), 16);
			row.push([r, g, b]);
		}
		pixels.push(row);
	}
	return pixels;
}

/**
 * 生成 24 位真彩色（truecolor）的 ANSI 转义序列。
 * @param bg - 为 true 时设置背景色（SGR 48），否则设置前景色（SGR 38）
 */
function rgb(r: number, g: number, b: number, bg = false): string {
	return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
}

const RESET = "\x1b[0m"; // ANSI 样式重置序列，用于结束一段着色

/**
 * 把像素矩阵渲染为带 ANSI 颜色的文本行数组（16 行，每行 32 个半块字符）。
 */
function buildImage(): string[] {
	const pixels = parseImage();
	const lines: string[] = [];

	// 使用半块字符 ▄：上半格用背景色画"上排像素"，下半格用前景色画"下排像素"，
	// 从而把 32 行像素纵向压缩为 16 行文本
	for (let row = 0; row < HEIGHT; row += 2) {
		let line = "";
		for (let x = 0; x < WIDTH; x++) {
			const top = pixels[row][x];
			// 边界兜底：若下排像素越界（不会发生于偶数高度），复用上排像素避免 undefined
			const bottom = pixels[row + 1]?.[x] ?? top;
			line += `${rgb(bottom[0], bottom[1], bottom[2])}${rgb(top[0], top[1], top[2], true)}▄`;
		}
		line += RESET;
		lines.push(line);
	}
	return lines;
}

/**
 * daxnuts 彩蛋的 TUI 组件：构造后立即播放约 2 秒的扫描显现动画。
 *
 * 工作原理：内部以 80ms 的 setInterval 推进帧计数 tick，每帧使渲染缓存失效并
 * 请求 TUI 重绘；render() 按「终端宽度 + tick」双键缓存输出行，宽度不变且
 * 帧号未变时直接返回上次结果。动画播完自动停表，但最终帧保持显示。
 */
export class DaxnutsComponent implements Component {
	private ui: TUI;
	private image: string[];
	private interval: ReturnType<typeof setInterval> | null = null; // 动画定时器句柄，未运行时为 null
	private tick = 0; // 当前帧计数（每 80ms 自增 1）
	private maxTicks = 25; // 最大帧数：80ms/帧 × 25 帧 ≈ 2 秒
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	private cachedTick = -1;

	constructor(ui: TUI) {
		this.ui = ui;
		this.image = buildImage();
		this.startAnimation();
	}

	/** 使渲染缓存失效（Component 接口要求）：把缓存宽度清零，强制下次 render 重建。 */
	invalidate(): void {
		this.cachedWidth = 0;
	}

	/**
	 * 启动动画定时器：每 80ms 推进一帧，累计到 maxTicks 后自动停止；
	 * 每帧都使缓存失效并请求 TUI 重绘。
	 */
	private startAnimation(): void {
		this.interval = setInterval(() => {
			this.tick++;
			if (this.tick >= this.maxTicks) {
				this.stopAnimation();
			}
			this.cachedWidth = 0;
			this.ui.requestRender();
		}, 80);
	}

	/** 停止动画并清理定时器（幂等，可安全重复调用）。 */
	private stopAnimation(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/**
	 * 渲染当前帧：居中输出头像（未显现的行用扫描线或占位空行补齐）与分阶段淡入的文案。
	 * 以「终端宽度 + 帧号」为缓存键，两者均未变化时直接复用上次结果。
	 */
	render(width: number): string[] {
		if (width === this.cachedWidth && this.cachedTick === this.tick) {
			return this.cachedLines;
		}

		const t = theme;
		const lines: string[] = [];

		// 居中辅助：先剔除 ANSI 转义序列得到"可见宽度"，再据此填充左侧空格，
		// 否则转义字符会被计入长度导致居中偏移
		const center = (s: string) => {
			const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length;
			const left = Math.max(0, Math.floor((width - visible) / 2));
			return " ".repeat(left) + s;
		};

		lines.push("");

		// ===== 扫描线显现效果：随 tick 推进逐渐显示更多行 =====
		// 分母多加 3（image.length + 3）让显现进度略快于线性，确保动画结束前扫描线能掠过全部行
		const revealedRows = Math.min(
			this.image.length,
			Math.floor((this.tick / this.maxTicks) * (this.image.length + 3)),
		);

		for (let i = 0; i < this.image.length; i++) {
			if (i < revealedRows) {
				lines.push(center(this.image[i]));
			} else {
				// 正在扫描的那一行显示一条高亮扫描线，其余未显现行用等宽空行占位
				if (i === revealedRows) {
					const scanline = "▓".repeat(WIDTH);
					lines.push(center(rgb(100, 200, 255) + scanline + RESET));
				} else {
					lines.push(center(" ".repeat(WIDTH)));
				}
			}
		}

		lines.push("");

		// ===== 文案分阶段淡入 =====
		// 0.6 表示头像显现到约 60% 进度后才开始出文案；textPhase 为文案出现后经过的帧数
		const textPhase = Math.max(0, this.tick - this.maxTicks * 0.6);
		if (textPhase > 0 || this.tick >= this.maxTicks) {
			lines.push(center(t.fg("accent", "Free Kimi K2.5 via OpenCode Zen")));
			lines.push(center(t.fg("success", '"Powered by daxnuts"')));
			lines.push(center(t.fg("muted", "— @thdxr")));
		} else {
			lines.push("");
			lines.push("");
			lines.push("");
		}

		lines.push("");
		// 第二阶段：文案出现 2 帧之后再补上最后一组链接文案
		if (textPhase > 2 || this.tick >= this.maxTicks) {
			lines.push(center(t.fg("dim", "Try OpenCode")));
			lines.push(center(t.fg("mdLink", "https://mistral.ai/news/mistral-vibe-2-0")));
		} else {
			lines.push("");
			lines.push("");
		}
		lines.push("");

		// 写回三级缓存（内容 / 宽度 / 帧号），供下次 render 短路复用
		this.cachedLines = lines;
		this.cachedWidth = width;
		this.cachedTick = this.tick;
		return lines;
	}

	/** 组件销毁：停止动画定时器，防止组件移除后仍触发重绘（泄漏）。 */
	dispose(): void {
		this.stopAnimation();
	}
}
