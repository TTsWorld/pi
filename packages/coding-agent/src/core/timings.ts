/**
 * @file timings.ts —— 启动链路计时打点
 *
 * @description
 * 启动性能分析的统一计时插桩：以环境变量 PI_TIMING=1 开启，
 * 按命名空间（主流程 / 扩展加载）记录相邻打点间的耗时，
 * 进程启动结束后统一打印到 stderr。
 */

// 是否启用计时（未开启时下方所有函数都是空操作）
const ENABLED = process.env.PI_TIMING === "1";

/** 单个命名空间的计时状态 */
interface TimingNamespace {
	/** 已记录的打点列表（label + 距上一打点的毫秒数） */
	timings: Array<{ label: string; ms: number }>;
	/** 上次打点的时间戳 */
	lastTime: number;
}

/** 计时命名空间：主流程 / 扩展加载 */
type TimingLabel = "main" | "extensions";

// 命名空间 → 计时状态
const timingNamespaces = new Map<TimingLabel, TimingNamespace>();

/** 重置某命名空间的计时：清空已有打点并重新起算 */
export function resetTimings(namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	timingNamespaces.set(namespace, { timings: [], lastTime: Date.now() });
}

/** 记录一个打点：耗时取当前时间与上一打点的差值 */
export function time(label: string, namespace: TimingLabel = "main"): void {
	if (!ENABLED) return;
	const now = Date.now();

	if (!timingNamespaces.has(namespace)) {
		resetTimings(namespace);
	}

	const timingNamespace = timingNamespaces.get(namespace)!;
	timingNamespace.timings.push({ label, ms: now - timingNamespace.lastTime });
	timingNamespace.lastTime = now;
}

/** 打印一组计时到 stderr（含各项耗时与合计），没有任何可打印项时跳过 */
function printTimingGroup(title: string, timings: TimingNamespace["timings"]): void {
	const printableTimings = timings.filter((timing) => timing.ms >= 0);
	if (printableTimings.length === 0) return;
	console.error(`\n--- ${title} ---`);
	for (const t of printableTimings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${printableTimings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error(`${"-".repeat(title.length + 8)}\n`);
}

/** 按命名空间分组打印全部启动计时 */
export function printTimings(): void {
	if (!ENABLED) return;
	for (const [namespace, timingNamespace] of timingNamespaces) {
		printTimingGroup(`Startup Timings: ${namespace}`, timingNamespace.timings);
	}
}
