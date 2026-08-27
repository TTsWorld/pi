/**
 * @file 快速确定性字符串哈希工具。
 * 为各 provider 适配层提供 shortHash，把长字符串折叠成短哈希后缀（如缓存 key、幂等标识）。
 */

/**
 * 计算字符串的快速确定性哈希（cyrb53 风格双重 32 位哈希，非加密安全），用于缩短长字符串。
 * @param str 待哈希的字符串
 * @returns h2、h1 两个 32 位无符号整数按 base36 编码后拼接成的短字符串
 */
export function shortHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}
