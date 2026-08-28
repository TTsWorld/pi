/**
 * @file auth.ts —— 实验性命令的认证参数解析
 * @description 把 --auth-token / --auth-token-file 两个原始 CLI 选项归一为统一的 AuthInput（token 字面量或文件路径二选一）。
 */

/** 认证凭据输入：token 字面量或 token 文件路径二选一（判别字段为 type）。 */
export type AuthInput =
	| { readonly type: "token"; readonly token: string }
	| { readonly type: "file"; readonly path: string };

/** 原始认证选项：均非必填，互斥与缺省语义由 parseAuthInput 统一裁决。 */
export interface RawAuthOptions {
	readonly authToken?: string;
	readonly authTokenFile?: string;
}

/** 把原始选项解析为 AuthInput：二者互斥（同时给出即报错）；都未给出时返回不带 auth 的结果。 */
export function parseAuthInput(options: RawAuthOptions): { auth?: AuthInput; errors: string[] } {
	// 互斥校验：token 与 token 文件只能二选一
	if (options.authToken !== undefined && options.authTokenFile !== undefined) {
		return { errors: ["--auth-token and --auth-token-file are mutually exclusive"] };
	}
	if (options.authToken !== undefined) {
		return { auth: { type: "token", token: options.authToken }, errors: [] };
	}
	if (options.authTokenFile !== undefined) {
		return { auth: { type: "file", path: options.authTokenFile }, errors: [] };
	}
	return { errors: [] };
}
