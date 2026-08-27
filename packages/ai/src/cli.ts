#!/usr/bin/env node
/**
 * @file packages/ai 的命令行入口
 * @description OAuth 相关的命令行工具：
 *   - `login [provider]`：对指定（或交互选择的）provider 走 OAuth 登录流程，凭据写入 auth.json
 *   - `list`：列出所有支持 OAuth 的内置 provider
 *   - 无命令 / help / --help / -h：打印用法帮助
 * 登录得到的凭据以 `{ [providerId]: OAuthCredential }` 的结构持久化到当前目录的 auth.json。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { AuthPrompt, OAuthCredential, Provider } from "./index.ts";
import { builtinProviders } from "./providers/all.ts";

// ========== 常量 ==========

// OAuth 凭据的持久化文件（相对当前工作目录）
const AUTH_FILE = "auth.json";

// 从全部内置 provider 中筛出配置了 OAuth 的子集；
// 类型谓词将 auth.oauth 收窄为非空，后续调用 provider.auth.oauth.login 时 TS 不会报"可能为 undefined"
const PROVIDERS = builtinProviders().filter(
	(provider): provider is Provider & { auth: { oauth: NonNullable<Provider["auth"]["oauth"]> } } =>
		provider.auth.oauth !== undefined,
);

/**
 * 将 readline 的回调式 question 封装为 Promise，便于在 async 流程中 await 用户输入
 * @param rl readline 交互实例
 * @param question 展示给用户的提示文本
 * @returns 用户输入的一行内容
 */
function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

/**
 * 读取 auth.json 中已保存的凭据表
 * @returns 以 provider id 为键的凭据映射；文件不存在或 JSON 解析失败时返回空对象（不抛错）
 */
function loadAuth(): Record<string, OAuthCredential> {
	if (!existsSync(AUTH_FILE)) return {};
	try {
		return JSON.parse(readFileSync(AUTH_FILE, "utf-8")) as Record<string, OAuthCredential>;
	} catch {
		return {};
	}
}

/**
 * 将凭据表整体写回 auth.json（覆盖式写入，2 空格缩进格式化）
 * @param auth 以 provider id 为键的凭据映射
 */
function saveAuth(auth: Record<string, OAuthCredential>): void {
	writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");
}

/**
 * 响应 OAuth 流程中的交互提示
 * @param rl readline 交互实例
 * @param authPrompt provider 下发的提示：select 类型渲染编号菜单，其余为普通文本输入
 * @returns select 提示返回所选选项的 id；文本提示返回用户的原始输入
 */
async function answerPrompt(rl: ReturnType<typeof createInterface>, authPrompt: AuthPrompt): Promise<string> {
	if (authPrompt.type === "select") {
		// 选择题：打印编号菜单，读取用户输入的序号并换算成下标
		console.log(`\n${authPrompt.message}`);
		for (let index = 0; index < authPrompt.options.length; index++) {
			console.log(`  ${index + 1}. ${authPrompt.options[index].label}`);
		}
		const choice = Number.parseInt(await prompt(rl, `Enter number (1-${authPrompt.options.length}): `), 10) - 1;
		const selected = authPrompt.options[choice];
		// 序号越界（NaN 或超出范围）视为无效选择
		if (!selected) throw new Error("Invalid selection");
		return selected.id;
	}
	// 文本题：有 placeholder 时附在提示语后作为输入示例
	return prompt(rl, `${authPrompt.message}${authPrompt.placeholder ? ` (${authPrompt.placeholder})` : ""}: `);
}

/**
 * 对指定 provider 执行 OAuth 登录，并将凭据保存到 auth.json
 * @param providerId provider 标识（必须存在于 PROVIDERS 列表中）
 */
async function login(providerId: string): Promise<void> {
	const provider = PROVIDERS.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const credential = await provider.auth.oauth.login({
			// 传入一个永不触发的 AbortSignal，仅为满足接口签名
			signal: new AbortController().signal,
			// 登录过程中的交互提示统一交给 answerPrompt 处理（菜单选择 / 文本输入）
			prompt: (authPrompt) => answerPrompt(rl, authPrompt),
			// 流程事件（授权链接、设备码、进度信息）打印到终端，引导用户完成操作
			notify: (event) => {
				switch (event.type) {
					// 授权码流程：打印需要用户在浏览器中打开的授权链接
					case "auth_url":
						console.log(`\nOpen this URL in your browser:\n${event.url}`);
						if (event.instructions) console.log(event.instructions);
						break;
					// 设备码流程：打印验证链接 + 用户需手动输入的码
					case "device_code":
						console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
						console.log(`Enter code: ${event.userCode}`);
						break;
					// 普通提示与进度信息
					case "info":
					case "progress":
						console.log(event.message);
						break;
				}
			},
		});
		// 合并写回：先读现有凭据表，覆盖当前 provider 的条目后再整体落盘
		const auth = loadAuth();
		auth[providerId] = credential;
		saveAuth(auth);
		console.log(`\nCredentials saved to ${AUTH_FILE}`);
	} finally {
		// 无论登录成败都关闭 readline，避免进程因未关闭的输入流挂起
		rl.close();
	}
}

/**
 * CLI 主入口：解析 argv 并分发子命令
 * 支持的命令：help（默认）/ list / login；未知命令抛错，由顶层 catch 统一处理
 */
async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];
	// 无命令或帮助命令：打印用法说明与支持 OAuth 的 provider 列表
	if (!command || command === "help" || command === "--help" || command === "-h") {
		const providerList = PROVIDERS.map((provider) => `  ${provider.id.padEnd(20)} ${provider.name}`).join("\n");
		console.log(
			`Usage: npx @earendil-works/pi-ai <command> [provider]\n\nCommands:\n  login [provider]  Login to an OAuth provider\n  list              List available providers\n\nProviders:\n${providerList}`,
		);
		return;
	}
	// list：逐行打印支持 OAuth 的 provider（id 对齐 20 列 + 名称）
	if (command === "list") {
		for (const provider of PROVIDERS) console.log(`${provider.id.padEnd(20)} ${provider.name}`);
		return;
	}
	if (command === "login") {
		let providerId = args[1];
		// 未显式指定 provider：打印编号菜单让用户交互选择
		if (!providerId) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				for (let index = 0; index < PROVIDERS.length; index++) {
					console.log(`  ${index + 1}. ${PROVIDERS[index].name}`);
				}
				const index = Number.parseInt(await prompt(rl, `Enter number (1-${PROVIDERS.length}): `), 10) - 1;
				// 序号越界（NaN 或超出范围）时得到 undefined
				providerId = PROVIDERS[index]?.id;
			} finally {
				rl.close();
			}
		}
		// 最终校验：id 必须存在于 PROVIDERS，否则视为未知 provider
		if (!providerId || !PROVIDERS.some((provider) => provider.id === providerId)) {
			throw new Error(`Unknown provider: ${providerId ?? ""}`);
		}
		await login(providerId);
		return;
	}
	throw new Error(`Unknown command: ${command}`);
}

// 顶层兜底：统一打印 main 抛出的错误并以非零退出码结束进程
main().catch((error: unknown) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
