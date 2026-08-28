/**
 * @file export-html/ansi-to-html.ts —— ANSI 转义码转 HTML 转换器
 *
 * @description
 * 把带终端 ANSI 颜色/样式转义码的文本转换成内联样式的 HTML，
 * 用于会话导出 HTML 时还原工具输出的终端观感（TUI 渲染 → ANSI → HTML 管线）。
 *
 * 核心是 ansiToHtml：扫描 SGR（Select Graphic Rendition）转义序列 ESC[...m，
 * 用一个 TextStyle 状态机跟踪当前样式，在样式变化的位置切换 <span> 包裹。
 *
 * 支持的转义码：
 * - 标准前景色（30-37）及亮色变体（90-97）
 * - 标准背景色（40-47）及亮色变体（100-107）
 * - 256 色调色板（38;5;N 与 48;5;N）
 * - RGB 真彩色（38;2;R;G;B 与 48;2;R;G;B）
 * - 文本样式：粗体（1）、暗淡（2）、斜体（3）、下划线（4）
 * - 重置（0）
 *
 * 依赖关系：无外部依赖，纯函数实现；被 tool-renderer.ts 与
 * 导出模板管线共同使用。
 */

// 标准 ANSI 调色板（0-15）：0-7 为标准色，8-15 为对应的亮色变体
const ANSI_COLORS = [
	"#000000", // 0: 黑
	"#800000", // 1: 红
	"#008000", // 2: 绿
	"#808000", // 3: 黄
	"#000080", // 4: 蓝
	"#800080", // 5: 品红
	"#008080", // 6: 青
	"#c0c0c0", // 7: 白
	"#808080", // 8: 亮黑（灰）
	"#ff0000", // 9: 亮红
	"#00ff00", // 10: 亮绿
	"#ffff00", // 11: 亮黄
	"#0000ff", // 12: 亮蓝
	"#ff00ff", // 13: 亮品红
	"#00ffff", // 14: 亮青
	"#ffffff", // 15: 亮白
];

/**
 * 把 256 色调色板索引转换为 hex 颜色值。
 * 256 色空间由三段构成：0-15 标准色、16-231 的 6x6x6 颜色立方体、232-255 灰度带。
 */
function color256ToHex(index: number): string {
	// 标准 16 色（0-15）：直接查表
	if (index < 16) {
		return ANSI_COLORS[index];
	}

	// 颜色立方体（16-231）：6x6x6 = 216 色，索引按 36/6/1 分解出 RGB 三维坐标
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		// 每维 6 级映射到 0 与 55,95,135,175,215,255（xterm 的固定阶梯：55 + n*40）
		const toComponent = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		const toHex = (n: number) => toComponent(n).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// 灰度带（232-255）：24 级灰，亮度从 8 起步进 10（8,18,...,238），RGB 三通道相同
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}

/**
 * 转义 HTML 特殊字符，防止终端输出里的 HTML 片段被浏览器当成标记执行。
 */
function escapeHtml(text: string): string {
	// & 必须最先替换：后面几步生成的实体自身就含有 & 字符
	// 覆盖 &、<、>、"、' 五个字符，足以防止标签注入与属性逃逸
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/** 当前累积的文本样式（SGR 状态机的可变状态，随转义码逐步更新） */
interface TextStyle {
	/** 前景色（CSS 颜色值），null 表示跟随终端默认 */
	fg: string | null;
	/** 背景色（CSS 颜色值），null 表示跟随终端默认 */
	bg: string | null;
	/** 粗体 */
	bold: boolean;
	/** 暗淡（用降低不透明度近似） */
	dim: boolean;
	/** 斜体 */
	italic: boolean;
	/** 下划线 */
	underline: boolean;
}

/** 创建一个全空（无任何修饰）的 TextStyle 初始状态。 */
function createEmptyStyle(): TextStyle {
	return {
		fg: null,
		bg: null,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
	};
}

/** 把 TextStyle 拼成内联 CSS 声明串（分号分隔）；无任何样式时返回空字符串。 */
function styleToInlineCSS(style: TextStyle): string {
	const parts: string[] = [];
	if (style.fg) parts.push(`color:${style.fg}`);
	if (style.bg) parts.push(`background-color:${style.bg}`);
	if (style.bold) parts.push("font-weight:bold");
	// HTML 没有原生「暗淡」样式，用 60% 不透明度近似终端的 dim 效果
	if (style.dim) parts.push("opacity:0.6");
	if (style.italic) parts.push("font-style:italic");
	if (style.underline) parts.push("text-decoration:underline");
	return parts.join(";");
}

/** 判断样式是否含任何可视化属性——决定是否需要为后续文本开启 span。 */
function hasStyle(style: TextStyle): boolean {
	return style.fg !== null || style.bg !== null || style.bold || style.dim || style.italic || style.underline;
}

/**
 * 解析一组 ANSI SGR（Select Graphic Rendition）参数并就地更新样式状态。
 * 一个序列可能同时携带多个码（如 "1;31" = 粗体 + 红前景），
 * 38/48 扩展色还会额外消耗 2 或 4 个后续参数。
 */
function applySgrCode(params: number[], style: TextStyle): void {
	let i = 0;
	// 手动推进下标 i：普通码前进 1 步，38/48 扩展色码需额外跳过其携带的参数
	while (i < params.length) {
		const code = params[i];

		if (code === 0) {
			// 0：全部重置
			style.fg = null;
			style.bg = null;
			style.bold = false;
			style.dim = false;
			style.italic = false;
			style.underline = false;
		} else if (code === 1) {
			style.bold = true;
		} else if (code === 2) {
			style.dim = true;
		} else if (code === 3) {
			style.italic = true;
		} else if (code === 4) {
			style.underline = true;
		} else if (code === 22) {
			// 22：重置粗体与暗淡
			style.bold = false;
			style.dim = false;
		} else if (code === 23) {
			style.italic = false;
		} else if (code === 24) {
			style.underline = false;
		} else if (code >= 30 && code <= 37) {
			// 标准前景色（30-37），映射到调色板前 8 项
			style.fg = ANSI_COLORS[code - 30];
		} else if (code === 38) {
			// 扩展前景色：按第二个参数区分子模式
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256 色：38;5;N（额外消耗 2 个参数）
				style.fg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB 真彩：38;2;R;G;B（额外消耗 4 个参数）
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.fg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 39) {
			// 39：恢复默认前景色
			style.fg = null;
		} else if (code >= 40 && code <= 47) {
			// 标准背景色（40-47）
			style.bg = ANSI_COLORS[code - 40];
		} else if (code === 48) {
			// 扩展背景色：与 38 同构，只是作用于背景
			if (params[i + 1] === 5 && params.length > i + 2) {
				// 256 色：48;5;N
				style.bg = color256ToHex(params[i + 2]);
				i += 2;
			} else if (params[i + 1] === 2 && params.length > i + 4) {
				// RGB 真彩：48;2;R;G;B
				const r = params[i + 2];
				const g = params[i + 3];
				const b = params[i + 4];
				style.bg = `rgb(${r},${g},${b})`;
				i += 4;
			}
		} else if (code === 49) {
			// 49：恢复默认背景色
			style.bg = null;
		} else if (code >= 90 && code <= 97) {
			// 亮色前景（90-97），对应调色板 8-15 项
			style.fg = ANSI_COLORS[code - 90 + 8];
		} else if (code >= 100 && code <= 107) {
			// 亮色背景（100-107）
			style.bg = ANSI_COLORS[code - 100 + 8];
		}
		// 未识别的码静默忽略：真实终端也是如此，不应因出现新码导致导出失败

		i++;
	}
}

// 匹配 ANSI 转义序列：ESC[ 开头、中间为数字与分号、以 m 结尾（即 SGR 序列）。
// 带 g 标志、会被跨调用复用，lastIndex 是有状态的，每次转换前必须重置
const ANSI_REGEX = /\x1b\[([\d;]*)m/g;

/**
 * 把带 ANSI 转义码的文本转换为内联样式的 HTML。
 *
 * 工作原理：逐个扫描 SGR 转义序列；每遇到一个序列，先输出此前累积的
 * 普通文本（HTML 转义后），再闭合旧 span、按新样式重开一个 span——
 * 即每段文本都由一个承载「当时样式快照」的 span 包裹，
 * 不做跨序列的 span 合并，实现简单且不依赖 CSS 继承细节。
 *
 * 注意：只识别 SGR（颜色/样式）序列；其他 ANSI 转义（光标移动、清屏等）
 * 不在处理范围内，会作为普通字符原样保留在输出里。
 *
 * @param text - 可能含 ANSI SGR 转义码的原始终端文本
 * @returns 转换后的 HTML 片段（只含 span 与转义后的文本，不含换行标签）
 */
export function ansiToHtml(text: string): string {
	const style = createEmptyStyle();
	let result = "";
	let lastIndex = 0;
	let inSpan = false;

	// 重置正则状态：g 标志正则的 lastIndex 会记住上次匹配结束的位置
	ANSI_REGEX.lastIndex = 0;

	let match = ANSI_REGEX.exec(text);
	while (match !== null) {
		// 先输出该转义序列之前的普通文本（需做 HTML 转义）
		const beforeText = text.slice(lastIndex, match.index);
		if (beforeText) {
			result += escapeHtml(beforeText);
		}

		// 解析 SGR 参数：空参数串（ESC[m）等价于 [0] 即整体重置；
		// 解析出 NaN 的参数也归一为 0
		const paramStr = match[1];
		const params = paramStr ? paramStr.split(";").map((p) => parseInt(p, 10) || 0) : [0];

		// 若上一个 span 尚未闭合，先闭合它，保证标签总是配对的
		if (inSpan) {
			result += "</span>";
			inSpan = false;
		}

		// 应用这批转义码，更新样式状态机
		applySgrCode(params, style);

		// 新样式非空时再重开 span；重置到全空样式则回到「裸文本」状态
		if (hasStyle(style)) {
			result += `<span style="${styleToInlineCSS(style)}">`;
			inSpan = true;
		}

		lastIndex = match.index + match[0].length;
		match = ANSI_REGEX.exec(text);
	}

	// 补上最后一个转义序列之后的剩余文本
	const remainingText = text.slice(lastIndex);
	if (remainingText) {
		result += escapeHtml(remainingText);
	}

	// 收尾：闭合尚未关闭的 span
	if (inSpan) {
		result += "</span>";
	}

	return result;
}

/**
 * 把多行 ANSI 文本转换为 HTML：每行包一层 div.ansi-line。
 * 空行输出 &nbsp; 占位——HTML 会把空 div 的高度折叠掉，
 * 用不间断空格保住空行的视觉高度，还原终端里的行距。
 */
export function ansiLinesToHtml(lines: string[]): string {
	// div 是块级元素、天然换行，拼接时无需额外分隔符；空行兜底成 &nbsp;
	return lines.map((line) => `<div class="ansi-line">${ansiToHtml(line) || "&nbsp;"}</div>`).join("");
}
