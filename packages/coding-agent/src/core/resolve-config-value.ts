/**
 * @file resolve-config-value.ts —— 配置值解析（shell 命令 / 环境变量 / 字面量）
 *
 * @description
 * 配置文件里的值（API key、header、baseUrl 等）允许写成三种形式：
 * 1. 以 "!" 开头 → 其余部分作为 shell 命令执行，取 stdout 作为值（如 "!pass show api/key"）；
 * 2. 含 "$VAR" / "${VAR}" 引用 → 用环境变量插值展开；
 * 3. 其余 → 按字面量处理。
 * 本文件实现这套解析协议：先把值解析成「命令 | 模板」引用结构（一次解析、多处查询复用），
 * 再按需执行/展开。shell 命令结果在进程生命周期内缓存，避免重复执行。
 *
 * 依赖关系：
 * - 被 auth-storage.ts 与 model-registry.ts 使用；
 * - `../utils/shell.ts`：读取用户配置的 shell（Windows 上用它替代默认 shell 执行命令）。
 */

import { execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// shell 命令结果的进程级缓存：key 为含 "!" 前缀的原始配置值
const commandResultCache = new Map<string, string | undefined>();
// 完整匹配：整串必须是合法环境变量名（用于校验 ${...} 内的名字）
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 前缀匹配：从头截取最长的一段合法变量名（用于裸 $VAR 形式的变量名定界）
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/** 模板的组成片段：要么是字面文本，要么是一个环境变量引用。 */
type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

/** 配置值解析结果：命令引用（原始串以 "!" 开头）或由片段序列组成的插值模板。 */
type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

/**
 * 向片段序列追加一段字面文本；若末尾已是字面片段则直接合并，
 * 保证相邻字面量不会产生多余片段。
 */
function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

/**
 * 把配置值解析为模板片段序列。识别以下语法：
 * - "$$" / "$!"：转义出字面 $ / !；
 * - "${NAME}"：花括号变量引用，NAME 必须是合法变量名，否则整体按字面量保留；
 * - "$NAME"：裸变量引用，按最长合法变量名定界；
 * - 无法识别的 "$"（后跟非法字符）：按字面 $ 保留。
 */
function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			// 再无 $：剩余部分整体作为字面量
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			// 转义序列：$$ → 字面 $；$! → 字面 !
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			// 花括号形式 ${...}
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				// 未闭合：$ 按字面量处理，从 $ 之后继续解析
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				// 内容不是合法变量名（如 ${a-b}）：整个 ${...} 原样保留
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		// 裸变量形式：按最长合法变量名前缀定界（如 $ABC123def 中匹配到 ABC123def... 的边界）
		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		// $ 后面跟的不是变量名起始字符：$ 按字面量处理
		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

/**
 * 判定配置值的引用类型：以 "!" 开头的是 shell 命令，其余是插值模板。
 */
function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

/**
 * 读取单个环境变量：优先取调用方显式传入的 env 记录（如测试注入），
 * 其次取进程真实环境；均无（或为空串）时返回 undefined。
 */
function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

/** 收集模板中引用的全部环境变量名（去重，保持出现顺序）。 */
function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

/**
 * 逐片段展开模板。任一环境变量缺失/为空时整体失败，返回 undefined——
 * 「全有或全无」语义，避免产出半展开的值（如 key 拼了一半）被误用。
 */
function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

/**
 * 若配置值「恰好是单个环境变量引用」（如 "$API_KEY"），返回该变量名；
 * 否则（含命令、混合模板、纯字面量）返回 undefined。
 * 用于把配置项归因为某个具体环境变量做展示或诊断。
 */
export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

/** 列出配置值引用的全部环境变量名（命令形式返回空数组）。 */
export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

/** 列出配置值引用但当前取不到值的环境变量名（用于提示用户缺了哪些变量）。 */
export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

/** 判断配置值是否为 shell 命令形式（以 "!" 开头）。 */
export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

/** 判断配置值当前是否已可解析（命令恒为 true；模板要求引用的变量全部就绪）。 */
export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * 把配置值（API key、header 值等）解析为实际值：
 * - 以 "!" 开头：其余部分作为 shell 命令执行，取 stdout 作为值（结果会缓存）；
 * - 展开 "$ENV_VAR" / "${ENV_VAR}" 引用为对应环境变量的值；
 * - 非命令值中 "$$" 转义字面 "$"、"$!" 转义字面 "!"；
 * - 其余按字面量处理。
 * 解析失败（命令失败或变量缺失）时返回 undefined。
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/**
 * 用用户配置的 shell（来自 getShellConfig）执行命令。
 * 返回 executed 标记配置的 shell 是否成功启动——false 时调用方可回退到默认 shell。
 * commandTransport 为 "stdin" 时命令经 stdin 传入（可避开引号/转义问题），否则作为参数追加。
 */
function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const result = spawnSync(shell, commandFromStdin ? args : [...args, command], {
			encoding: "utf-8",
			input: commandFromStdin ? command : undefined,
			timeout: 10000, // 命令硬超时 10s，防止交互式命令挂死 CLI
			stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
			shell: false, // 显式传 shell 数组，不依赖 /bin/sh
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				// 配置的 shell 不存在：算「未执行」，允许回退默认 shell
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			// 命令执行了但退出码非 0：视为执行失败（值为空），不再回退
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

/** 用系统默认 shell（execSync）执行命令；失败或输出为空时返回 undefined。 */
function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000, // 同样 10s 硬超时
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * 真正执行命令（绕过缓存）。commandConfig 是含 "!" 前缀的原始串，去掉前缀后执行。
 * Windows 上优先用用户配置的 shell（可带自定义启动参数），该 shell 不可用时
 * 才回退到默认 shell；非 Windows 直接用默认 shell。
 */
function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				// executed=false 表示配置的 shell 没跑起来（如未找到可执行文件），才走回退
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

/** 带缓存的命令执行：同一命令串整个进程生命周期只执行一次，命中缓存直接复用。 */
function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	// 注意：失败结果（undefined）也会被缓存，避免反复重跑注定失败的命令
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * 与 resolveConfigValue 语义相同，但命令形式不经过缓存、每次真实执行。
 * NOTE: 原注释为 "Resolve all header values using the same resolution logic as API keys."
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

/**
 * 解析配置值，失败时抛出带上下文的错误（而非返回 undefined）。
 * 错误信息按引用类型细分：命令失败 / 缺单个变量 / 缺多个变量，
 * 方便用户直接看出该修哪里；description 用于指明是哪个配置项（如 "api key"）。
 */
export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValueUncached(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	// ===== 构造针对性的错误信息 =====
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	// 兜底：值非空但解析结果为空串等情形
	throw new Error(`Failed to resolve ${description}`);
}

/**
 * 批量解析 header 表：对每个值走与 API key 相同的解析逻辑；
 * 解析失败的条目直接丢弃。全部失败（或入参为空）时返回 undefined。
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * resolveHeaders 的严格版：任一 header 解析失败即抛错（错误信息带上 header 名），
 * 用于必须完整的场景（如显式要求的认证头）。
 */
export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** 清空配置值命令缓存。导出仅供测试使用。 */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
