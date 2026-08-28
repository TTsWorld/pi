/**
 * @file armin.ts —— "Armin says hi!" 彩蛋动画组件
 *
 * @description
 * 纯装饰性的复活节彩蛋：把内置的 31×36 像素 XBM 位图（人物像素画）解码为
 * 半块字符（half-block）网格，随机选择一种入场动画逐帧播放，最终定格为完整图像，
 * 并在末尾附上 "ARMIN SAYS HI" 字样。
 *
 * 实现要点：
 * - XBM 位图按「每 8 像素一字节、LSB 在前」存储，0 为前景、1 为背景；
 * - 纵向相邻两个像素合并为一个终端字符（█ / ▀ / ▄ / 空格），高度减半以适配行高；
 * - 七种动画效果（打字机 / 扫描线 / 雨落 / 淡入 / CRT 展开 / 故障 / 溶解）共用
 *   「finalGrid 目标网格 + currentGrid 当前网格 + 每帧 tick 推进」的骨架；
 * - render 结果按 (宽度, 网格版本号) 二元组缓存，动画未推进且宽度未变时直接复用；
 * - 动画由 setInterval 驱动，播完自动清理定时器，dispose 时兜底停止。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：Component 接口与 TUI（requestRender 触发重绘）；
 * - `../theme/theme.ts`：accent 前景色。
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// XBM 位图数据：31×36 像素，LSB 在前；1 = 背景，0 = 前景
const WIDTH = 31;
const HEIGHT = 36;
const BITS = [
	0xff, 0xff, 0xff, 0x7f, 0xff, 0xf0, 0xff, 0x7f, 0xff, 0xed, 0xff, 0x7f, 0xff, 0xdb, 0xff, 0x7f, 0xff, 0xb7, 0xff,
	0x7f, 0xff, 0x77, 0xfe, 0x7f, 0x3f, 0xf8, 0xfe, 0x7f, 0xdf, 0xff, 0xfe, 0x7f, 0xdf, 0x3f, 0xfc, 0x7f, 0x9f, 0xc3,
	0xfb, 0x7f, 0x6f, 0xfc, 0xf4, 0x7f, 0xf7, 0x0f, 0xf7, 0x7f, 0xf7, 0xff, 0xf7, 0x7f, 0xf7, 0xff, 0xe3, 0x7f, 0xf7,
	0x07, 0xe8, 0x7f, 0xef, 0xf8, 0x67, 0x70, 0x0f, 0xff, 0xbb, 0x6f, 0xf1, 0x00, 0xd0, 0x5b, 0xfd, 0x3f, 0xec, 0x53,
	0xc1, 0xff, 0xef, 0x57, 0x9f, 0xfd, 0xee, 0x5f, 0x9f, 0xfc, 0xae, 0x5f, 0x1f, 0x78, 0xac, 0x5f, 0x3f, 0x00, 0x50,
	0x6c, 0x7f, 0x00, 0xdc, 0x77, 0xff, 0xc0, 0x3f, 0x78, 0xff, 0x01, 0xf8, 0x7f, 0xff, 0x03, 0x9c, 0x78, 0xff, 0x07,
	0x8c, 0x7c, 0xff, 0x0f, 0xce, 0x78, 0xff, 0xff, 0xcf, 0x7f, 0xff, 0xff, 0xcf, 0x78, 0xff, 0xff, 0xdf, 0x78, 0xff,
	0xff, 0xdf, 0x7d, 0xff, 0xff, 0x3f, 0x7e, 0xff, 0xff, 0xff, 0x7f,
];

// XBM 每行按 8 像素打包为字节，不足 8 像素的行也占满整字节
const BYTES_PER_ROW = Math.ceil(WIDTH / 8);
// 半块字符渲染：纵向两个像素合并成一个终端字符，显示高度只有像素高度的一半
const DISPLAY_HEIGHT = Math.ceil(HEIGHT / 2); // 半块字符渲染

/** 动画效果类型：typewriter 打字机 / scanline 扫描线 / rain 雨落 / fade 淡入 / crt 显像管展开 / glitch 故障 / dissolve 溶解。 */
type Effect = "typewriter" | "scanline" | "rain" | "fade" | "crt" | "glitch" | "dissolve";

/** 全部可选效果，组件构造时从中随机挑选一个。 */
const EFFECTS: Effect[] = ["typewriter", "scanline", "rain", "fade", "crt", "glitch", "dissolve"];

/**
 * 读取 (x, y) 处的像素：true = 前景，false = 背景。
 * XBM 按「行号 × 每行字节数」定位字节，再按 x % 8 定位具体位（LSB 在前）；
 * XBM 约定 0 为前景，因此位值为 0 时返回 true。
 */
function getPixel(x: number, y: number): boolean {
	// y 越界（半块渲染会访问末行像素的下一行）时按背景处理
	if (y >= HEIGHT) return false;
	const byteIndex = y * BYTES_PER_ROW + Math.floor(x / 8);
	const bitIndex = x % 8;
	return ((BITS[byteIndex] >> bitIndex) & 1) === 0;
}

/**
 * 把一个终端字符格（上下两个纵向像素）映射为半块字符：
 * 上下都亮 → █，仅上亮 → ▀，仅下亮 → ▄，都不亮 → 空格。
 */
function getChar(x: number, row: number): string {
	const upper = getPixel(x, row * 2);
	const lower = getPixel(x, row * 2 + 1);
	if (upper && lower) return "█";
	if (upper) return "▀";
	if (lower) return "▄";
	return " ";
}

/** 构建动画的定格目标网格：每个显示行 × 每列的半块字符矩阵。 */
function buildFinalGrid(): string[][] {
	const grid: string[][] = [];
	for (let row = 0; row < DISPLAY_HEIGHT; row++) {
		const line: string[] = [];
		for (let x = 0; x < WIDTH; x++) {
			line.push(getChar(x, row));
		}
		grid.push(line);
	}
	return grid;
}

/**
 * "Armin says hi!" 彩蛋组件：随机选择一种动画效果，把 XBM 像素画逐帧呈现出来。
 *
 * 工作方式：构造时随机挑选效果并初始化其私有状态，setInterval 每帧调用对应的
 * tick* 方法推进 currentGrid，动画完成（tick 返回 true）后自动停止定时器。
 * 渲染输出 = 当前网格的着色行 + 末尾追加的 "ARMIN SAYS HI" 提示行。
 *
 * 使用场景：作为庆祝 / 打趣彩蛋挂到交互界面（一次性组件，播完即定格）。
 */
export class ArminComponent implements Component {
	private ui: TUI;
	// 动画定时器句柄；播完或 dispose 后置 null
	private interval: ReturnType<typeof setInterval> | null = null;
	// 本次实例随机选中的动画效果
	private effect: Effect;
	// 动画完成后的定格网格（各效果逐帧收敛的目标）
	private finalGrid: string[][];
	// 当前帧网格；多数效果逐步向 finalGrid 靠拢，glitch 则先破坏再还原
	private currentGrid: string[][];
	// 效果私有状态（打字机光标位置、雨滴数组等），具体形状由各效果自行约定
	private effectState: Record<string, unknown> = {};
	// render 结果缓存：宽度与网格版本都未变时直接复用
	private cachedLines: string[] = [];
	private cachedWidth = 0;
	// 网格版本号，每帧 +1，用于让缓存失效
	private gridVersion = 0;
	// 缓存对应的网格版本号；初值 -1 保证首帧一定不命中缓存
	private cachedVersion = -1;

	constructor(ui: TUI) {
		this.ui = ui;
		// 从效果列表中均匀随机挑选
		this.effect = EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
		this.finalGrid = buildFinalGrid();
		this.currentGrid = this.createEmptyGrid();

		// 初始化效果私有状态，随后启动逐帧动画
		this.initEffect();
		this.startAnimation();
	}

	/** 缓存失效（终端尺寸 / 主题变化等）：清零缓存宽度，下次 render 强制重建。 */
	invalidate(): void {
		this.cachedWidth = 0;
	}

	/**
	 * 渲染当前帧：把网格每行裁剪到可用宽度、着 accent 前景色并右侧补齐，
	 * 末尾追加 "ARMIN SAYS HI" 提示行；结果按 (width, gridVersion) 缓存。
	 */
	render(width: number): string[] {
		// 宽度与网格版本均未变化 → 动画未推进，直接复用上次结果
		if (width === this.cachedWidth && this.cachedVersion === this.gridVersion) {
			return this.cachedLines;
		}

		// 左侧固定留 1 格内边距
		const padding = 1;
		const availableWidth = width - padding;

		this.cachedLines = this.currentGrid.map((row) => {
			// 先裁剪到可用宽度再着色，保证输出行宽与终端对齐
			const clipped = row.slice(0, availableWidth).join("");
			const padRight = Math.max(0, width - padding - clipped.length);
			return ` ${theme.fg("accent", clipped)}${" ".repeat(padRight)}`;
		});

		// 末尾追加问候语
		const message = "ARMIN SAYS HI";
		const msgPadRight = Math.max(0, width - padding - message.length);
		this.cachedLines.push(` ${theme.fg("accent", message)}${" ".repeat(msgPadRight)}`);

		this.cachedWidth = width;
		this.cachedVersion = this.gridVersion;

		return this.cachedLines;
	}

	/** 创建全空格的初始网格（rain / crt 等每帧全量重绘的效果用作空白画布）。 */
	private createEmptyGrid(): string[][] {
		return Array.from({ length: DISPLAY_HEIGHT }, () => Array(WIDTH).fill(" "));
	}

	/**
	 * 按选中的效果初始化私有状态 effectState；
	 * dissolve 还会把 currentGrid 直接铺成随机噪点作为动画起点。
	 */
	private initEffect(): void {
		switch (this.effect) {
			case "typewriter":
				// 已揭示到的线性位置（pos = row * WIDTH + x）
				this.effectState = { pos: 0 };
				break;
			case "scanline":
				// 已揭示（扫描过）的行号
				this.effectState = { row: 0 };
				break;
			case "rain":
				// 每列一个雨滴：y 为下落位置（负值表示还在屏幕上方），settled 为已落定高度
				this.effectState = {
					drops: Array.from({ length: WIDTH }, () => ({
						y: -Math.floor(Math.random() * DISPLAY_HEIGHT * 2),
						settled: 0,
					})),
				};
				break;
			case "fade": {
				// 收集全部像素坐标
				const positions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						positions.push([row, x]);
					}
				}
				// Fisher-Yates 洗牌，得到随机揭示顺序
				for (let i = positions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[positions[i], positions[j]] = [positions[j], positions[i]];
				}
				this.effectState = { positions, idx: 0 };
				break;
			}
			case "crt":
				// 自中线向上下扩展的半径（每帧 +1）
				this.effectState = { expansion: 0 };
				break;
			case "glitch":
				// phase 为已播出的故障帧数，glitchFrames 为故障总帧数（8 帧）
				this.effectState = { phase: 0, glitchFrames: 8 };
				break;
			case "dissolve": {
				// 初始帧铺满随机噪点字符，随后逐步替换为真实像素
				this.currentGrid = Array.from({ length: DISPLAY_HEIGHT }, () =>
					Array.from({ length: WIDTH }, () => {
						const chars = [" ", "░", "▒", "▓", "█", "▀", "▄"];
						return chars[Math.floor(Math.random() * chars.length)];
					}),
				);
				// 同样洗牌出随机揭示顺序
				const dissolvePositions: [number, number][] = [];
				for (let row = 0; row < DISPLAY_HEIGHT; row++) {
					for (let x = 0; x < WIDTH; x++) {
						dissolvePositions.push([row, x]);
					}
				}
				for (let i = dissolvePositions.length - 1; i > 0; i--) {
					const j = Math.floor(Math.random() * (i + 1));
					[dissolvePositions[i], dissolvePositions[j]] = [dissolvePositions[j], dissolvePositions[i]];
				}
				this.effectState = { positions: dissolvePositions, idx: 0 };
				break;
			}
		}
	}

	/**
	 * 启动逐帧动画：glitch 用 60fps 制造密集抖动感，其余效果 30fps。
	 * 每帧流程：tick 推进网格 → 版本号 +1（缓存失效）→ 请求 TUI 重绘；
	 * tick 报告完成后自动停止定时器。
	 */
	private startAnimation(): void {
		const fps = this.effect === "glitch" ? 60 : 30;
		this.interval = setInterval(() => {
			const done = this.tickEffect();
			this.updateDisplay();
			this.ui.requestRender();
			if (done) {
				this.stopAnimation();
			}
		}, 1000 / fps);
	}

	/** 停止动画定时器（幂等：已停止时不重复 clear）。 */
	private stopAnimation(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}

	/** 推进一帧：分派到当前效果对应的 tick 实现；返回 true 表示动画已完成。 */
	private tickEffect(): boolean {
		switch (this.effect) {
			case "typewriter":
				return this.tickTypewriter();
			case "scanline":
				return this.tickScanline();
			case "rain":
				return this.tickRain();
			case "fade":
				return this.tickFade();
			case "crt":
				return this.tickCrt();
			case "glitch":
				return this.tickGlitch();
			case "dissolve":
				return this.tickDissolve();
			default:
				return true;
		}
	}

	/**
	 * 打字机效果：按「行优先」线性顺序逐像素揭示最终图像，
	 * 每帧固定推进 3 个像素（pixelsPerFrame）控制总时长。
	 */
	private tickTypewriter(): boolean {
		const state = this.effectState as { pos: number };
		const pixelsPerFrame = 3;

		for (let i = 0; i < pixelsPerFrame; i++) {
			const row = Math.floor(state.pos / WIDTH);
			const x = state.pos % WIDTH;
			// 线性位置越出网格 → 全部像素已揭示完
			if (row >= DISPLAY_HEIGHT) return true;
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.pos++;
		}
		return false;
	}

	/**
	 * 扫描线效果：模拟 CRT 扫描，每帧自上而下完整揭示一行，
	 * 扫完全部行即完成。
	 */
	private tickScanline(): boolean {
		const state = this.effectState as { row: number };
		if (state.row >= DISPLAY_HEIGHT) return true;

		// 整行拷贝到当前网格
		for (let x = 0; x < WIDTH; x++) {
			this.currentGrid[state.row][x] = this.finalGrid[state.row][x];
		}
		state.row++;
		return false;
	}

	/**
	 * 雨落效果：每列一个雨滴自顶部落下，触到该列最下方的目标像素后「落定」，
	 * 落定部分永久保留在网格上；全部列落定后完成。
	 * 每帧全量重建网格：先画各列已落定部分，再画仍在下落的滴头。
	 */
	private tickRain(): boolean {
		const state = this.effectState as {
			drops: { y: number; settled: number }[];
		};

		let allSettled = true;
		this.currentGrid = this.createEmptyGrid();

		for (let x = 0; x < WIDTH; x++) {
			const drop = state.drops[x];

			// 画出该列已落定的像素（自底部向上 settled 格）
			for (let row = DISPLAY_HEIGHT - 1; row >= DISPLAY_HEIGHT - drop.settled; row--) {
				if (row >= 0) {
					this.currentGrid[row][x] = this.finalGrid[row][x];
				}
			}

			// 本列已全部落定，跳过后续下落逻辑
			if (drop.settled >= DISPLAY_HEIGHT) continue;

			allSettled = false;

			// 在尚未落定的范围内找该列最下方的非空像素行（本列的落定目标）
			let targetRow = -1;
			for (let row = DISPLAY_HEIGHT - 1 - drop.settled; row >= 0; row--) {
				if (this.finalGrid[row][x] !== " ") {
					targetRow = row;
					break;
				}
			}

			// 雨滴下移一格
			drop.y++;

			// 绘制下落中的雨滴
			if (drop.y >= 0 && drop.y < DISPLAY_HEIGHT) {
				if (targetRow >= 0 && drop.y >= targetRow) {
					// 到达目标：整列一次性落定，雨滴重置回屏幕上方（-1..-5 行，制造错落感）
					drop.settled = DISPLAY_HEIGHT - targetRow;
					drop.y = -Math.floor(Math.random() * 5) - 1;
				} else {
					// 仍在下落：画一个 ▓ 滴头
					this.currentGrid[drop.y][x] = "▓";
				}
			}
		}

		return allSettled;
	}

	/**
	 * 淡入效果：像素按洗牌后的随机顺序逐个浮现，
	 * 每帧揭示 15 个像素（pixelsPerFrame），全部揭示完即完成。
	 */
	private tickFade(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 15;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.idx++;
		}
		return false;
	}

	/**
	 * CRT 开机效果：从屏幕中线一行开始，每帧向上下各扩一行，
	 * 模拟显像管「自中心撑开画面」的过程；每帧全量重建网格。
	 */
	private tickCrt(): boolean {
		const state = this.effectState as { expansion: number };
		const midRow = Math.floor(DISPLAY_HEIGHT / 2);

		this.currentGrid = this.createEmptyGrid();

		// 自中线向上下扩展的绘制范围
		const top = midRow - state.expansion;
		const bottom = midRow + state.expansion;

		// 裁剪到网格边界内的行区间逐行拷贝
		for (let row = Math.max(0, top); row <= Math.min(DISPLAY_HEIGHT - 1, bottom); row++) {
			for (let x = 0; x < WIDTH; x++) {
				this.currentGrid[row][x] = this.finalGrid[row][x];
			}
		}

		state.expansion++;
		// 扩展半径超过总高度 → 全部行都已画到，动画完成
		return state.expansion > DISPLAY_HEIGHT;
	}

	/**
	 * 故障效果：前 8 帧每帧随机破坏图像（整行水平位移 / 随机换行），
	 * 最后一帧定格为干净图像，营造「信号错乱后恢复」的观感。
	 */
	private tickGlitch(): boolean {
		const state = this.effectState as { phase: number; glitchFrames: number };

		if (state.phase < state.glitchFrames) {
			// 故障阶段：逐行生成被破坏的版本
			this.currentGrid = this.finalGrid.map((row) => {
				// 预生成 -3..3 的随机位移量（不一定用到）
				const offset = Math.floor(Math.random() * 7) - 3;
				const glitchRow = [...row];

				// 30% 概率：整行按 offset 循环水平位移
				if (Math.random() < 0.3) {
					const shifted = glitchRow.slice(offset).concat(glitchRow.slice(0, offset));
					return shifted.slice(0, WIDTH);
				}

				// 20% 概率：用随机一行的内容顶替本行（垂直错位）
				if (Math.random() < 0.2) {
					const swapRow = Math.floor(Math.random() * DISPLAY_HEIGHT);
					return [...this.finalGrid[swapRow]];
				}

				return glitchRow;
			});
			state.phase++;
			return false;
		}

		// 收尾帧：展示干净的完整图像
		this.currentGrid = this.finalGrid.map((row) => [...row]);
		return true;
	}

	/**
	 * 溶解效果：初始为满屏随机噪点，随后按洗牌顺序每帧把 20 个噪点格
	 * （pixelsPerFrame）替换为最终像素，噪点逐渐「溶解」成真实图像。
	 */
	private tickDissolve(): boolean {
		const state = this.effectState as { positions: [number, number][]; idx: number };
		const pixelsPerFrame = 20;

		for (let i = 0; i < pixelsPerFrame; i++) {
			if (state.idx >= state.positions.length) return true;
			const [row, x] = state.positions[state.idx];
			this.currentGrid[row][x] = this.finalGrid[row][x];
			state.idx++;
		}
		return false;
	}

	/** 网格版本号 +1，使 render 缓存失效（下一帧强制重算）。 */
	private updateDisplay(): void {
		this.gridVersion++;
	}

	/** 组件销毁：停止动画定时器，避免组件移除后仍触发重绘。 */
	dispose(): void {
		this.stopAnimation();
	}
}
