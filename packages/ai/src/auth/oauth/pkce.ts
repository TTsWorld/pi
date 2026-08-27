/**
 * @file PKCE 工具（code_verifier / code_challenge 生成）
 *
 * @description 基于 Web Crypto API 实现 PKCE（Proof Key for Code Exchange，RFC 7636），
 * Node.js 20+ 与浏览器中均可运行（两端都提供全局 crypto.getRandomValues 与 subtle.digest）。
 */

/**
 * 将字节序列编码为 base64url 字符串。
 * base64url 用 `-`/`_` 替换 `+`/`/` 并去掉 `=` 填充，使结果可安全放进 URL 查询参数。
 * @param bytes 待编码的字节
 * @returns base64url 编码结果（无填充）
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * 生成 PKCE 的 code_verifier 与 code_challenge。
 * 使用 Web Crypto API 以获得跨平台兼容性。
 *
 * 原理（防御授权码拦截 / CSRF）：verifier 是只保存在客户端的随机密钥，授权请求中
 * 只发送它的 SHA-256 摘要（即 challenge）；换取 token 时才提交 verifier，由服务端
 * 校验摘要匹配。这样即使授权码在重定向过程中被截获，攻击者没有 verifier 也无法兑换 token。
 *
 * @returns 包含 verifier 与 challenge 的对象，分别用于后续的 token 请求与授权请求
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// 生成 32 字节（256 位）高熵随机 verifier；base64url 编码后约 43 字符，
	// 恰好落在 RFC 7636 要求的 43~128 字符范围内
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// 计算 S256 方式的 challenge：对 verifier 的 UTF-8 编码取 SHA-256 再做 base64url 编码
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
