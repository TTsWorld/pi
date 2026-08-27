/**
 * @file 时间有序 UUIDv7 生成器。
 *
 * 在 UUIDv7 基础上用「计数器法」实现同进程内严格单调递增：
 * 时间戳占高 48 位（字典序即生成顺序），同毫秒内用 32 位序列号自增，
 * 新毫秒用随机值播种序列初值，时钟回拨时也不回退序号。
 */

/** 上次使用的毫秒时间戳（含序列回绕时人为借位 +1 的逻辑时间），初始为 -Infinity */
let lastTimestamp = -Infinity;
/** 同一毫秒内的单调序列号（32 位无符号） */
let sequence = 0;

/**
 * 用随机字节填充传入的字节数组。
 *
 * @param bytes - 待填充的字节数组
 */
function fillRandomBytes(bytes: Uint8Array<ArrayBuffer>): void {
	// 优先使用 WebCrypto（密码学安全随机源）
	if (globalThis.crypto?.getRandomValues) {
		globalThis.crypto.getRandomValues(bytes);
		return;
	}
	// 兜底：Math.random 非加密安全，仅保证在无 crypto 的环境可用
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Math.floor(Math.random() * 256);
	}
}

/**
 * 生成时间有序（单调递增）的 UUIDv7。
 *
 * 位布局：bytes[0..5] 为 48 位毫秒时间戳（大端）；bytes[6] 高 4 位为版本号 7；
 * bytes[8] 高 2 位为 variant；其余位承载 32 位单调序列与随机位。
 *
 * @returns 标准的 8-4-4-4-12 形式 UUID 字符串
 */
export function uuidv7(): string {
	const random = new Uint8Array(16);
	fillRandomBytes(random);
	const timestamp = Date.now();

	if (timestamp > lastTimestamp) {
		// 进入新毫秒：用 4 个随机字节播种 32 位序列初值，
		// 使同一毫秒内首个 UUID 的计数器起点不可预测
		sequence = random[6] * 0x1000000 + random[7] * 0x10000 + random[8] * 0x100 + random[9];
		lastTimestamp = timestamp;
	} else {
		// 同毫秒（或时钟回拨）：序列自增保持单调，>>> 0 维持 32 位无符号回绕
		sequence = (sequence + 1) >>> 0;
		// 回绕到 0 说明本毫秒的 2^32 个序列号耗尽，借位到下一个逻辑毫秒
		if (sequence === 0) lastTimestamp++;
	}

	// 用除法而非位移取字节：48 位时间戳超出位运算的 32 位范围
	const bytes = new Uint8Array(16);
	bytes[0] = (lastTimestamp / 0x10000000000) & 0xff;
	bytes[1] = (lastTimestamp / 0x100000000) & 0xff;
	bytes[2] = (lastTimestamp / 0x1000000) & 0xff;
	bytes[3] = (lastTimestamp / 0x10000) & 0xff;
	bytes[4] = (lastTimestamp / 0x100) & 0xff;
	bytes[5] = lastTimestamp & 0xff;
	// 版本号 7（高 4 位）+ 序列最高 4 位
	bytes[6] = 0x70 | ((sequence >>> 28) & 0x0f);
	bytes[7] = (sequence >>> 20) & 0xff;
	// variant（高 2 位 10）+ 序列的 6 位
	bytes[8] = 0x80 | ((sequence >>> 14) & 0x3f);
	bytes[9] = (sequence >>> 6) & 0xff;
	// 序列最低 6 位 + 2 位随机位，凑满一个字节
	bytes[10] = ((sequence & 0x3f) << 2) | (random[10] & 0x03);
	bytes[11] = random[11];
	bytes[12] = random[12];
	bytes[13] = random[13];
	bytes[14] = random[14];
	bytes[15] = random[15];

	// 每字节转两位十六进制，按 8-4-4-4-12 分组拼接为标准 UUID 形式
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
	return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
