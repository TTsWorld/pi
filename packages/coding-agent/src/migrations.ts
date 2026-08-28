/**
 * @file migrations.ts —— 启动期执行的一次性数据迁移
 *
 * @description
 * 集中存放 coding-agent 启动时需要执行的一次性迁移逻辑，负责把旧版本遗留的
 * 配置文件与目录结构升级到当前版本的标准布局，包括：
 * - 凭据迁移：合并旧版 oauth.json 与 settings.json 里的 apiKeys 到 auth.json；
 * - 会话迁移：把误存在 ~/.pi/agent 根目录的会话文件挪回 sessions/<编码后的-cwd>/；
 * - 目录更名：commands/ 更名为 prompts/，tools/ 下的 fd/rg 二进制挪到 bin/；
 * - 快捷键配置结构迁移，以及对 hooks/、tools/ 等已废弃目录的告警收集。
 *
 * 所有迁移都设计为幂等或可安全跳过：任何一步失败都不应中断启动流程。
 *
 * 依赖关系：
 * - ./config.ts：提供 agent 根目录、bin 目录等路径计算；
 * - ./core/keybindings.ts：快捷键配置结构的具体迁移实现；
 * - ./utils/text.ts：stripBom，兼容带 BOM 的旧 JSON 文件。
 */

import chalk from "chalk";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir } from "./config.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { stripBom } from "./utils/text.ts";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

/**
 * 把旧版 oauth.json 与 settings.json 中的 apiKeys 迁移到统一的 auth.json。
 *
 * 工作原理：仅当 auth.json 尚不存在时才执行（保证幂等，已迁移过的老用户直接跳过）；
 * 把两处旧凭据统一改写为带 type 标记的凭据对象后合并写出——
 * oauth.json 迁移成功后重命名为 .migrated 留档，settings.json 则原地删除 apiKeys 字段。
 *
 * @returns 已完成迁移的供应商名称列表（供上层向用户提示）
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// auth.json 已存在说明此前迁移过，直接跳过（幂等保证）
	if (existsSync(authPath)) return [];

	// 以供应商为键聚合两处旧凭据，最终整体写入 auth.json
	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];

	// 迁移 oauth.json：逐条补充 type: "oauth" 后并入结果
	if (existsSync(oauthPath)) {
		try {
			const oauth = JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")));
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			// 改名而非删除：保留原始数据以便用户手动回滚
			renameSync(oauthPath, `${oauthPath}.migrated`);
		} catch {
			// 解析或改名失败则放弃该文件的迁移，不中断启动
		}
	}

	// 迁移 settings.json 中的 apiKeys：oauth 中已迁移的供应商不再覆盖
	if (existsSync(settingsPath)) {
		try {
			const content = readFileSync(settingsPath, "utf-8");
			const settings = JSON.parse(stripBom(content));
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
			}
		} catch {
			// 解析或写回失败则跳过，避免损坏用户现有的 settings 文件
		}
	}

	if (Object.keys(migrated).length > 0) {
		mkdirSync(dirname(authPath), { recursive: true });
		// 权限 0o600：auth.json 含凭据，仅限属主读写，防止被同机其他用户读取
		writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	}

	return providers;
}

/**
 * 把会话文件从 ~/.pi/agent/*.jsonl 迁移到规范的会话目录。
 *
 * v0.30.0 版本的 Bug：会话被保存到了 ~/.pi/agent/ 根目录，而不是
 * ~/.pi/agent/sessions/<编码后的-cwd>/。本迁移依据每个会话首行
 * 头部中记录的 cwd，把文件移动到正确的位置。
 *
 * 参见：https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// 只收集 agentDir 顶层（不含子目录）的 .jsonl 会话文件；目录读取失败则放弃迁移
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// 读取首行获得会话头部（其中记录了该会话的工作目录）
			const content = readFileSync(file, "utf8");
			const firstLine = content.split("\n")[0];
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			// 非 session 头部或缺少 cwd 的文件不是历史遗留会话，跳过
			if (header.type !== "session" || !header.cwd) continue;

			const cwd: string = header.cwd;

			// 按与 session-manager.ts 完全一致的规则编码 cwd：去掉首部斜杠、
			// 其余路径分隔符与冒号替换为 -，再以 -- 包裹，得到安全的目录名
			const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
			const correctDir = join(agentDir, "sessions", safePath);

			// 目标目录不存在则先创建
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// 把文件移动到规范位置；文件名兼容 POSIX 与 Windows 两种路径分隔符
			const fileName = file.split("/").pop() || file.split("\\").pop();
			const newPath = join(correctDir, fileName!);

			if (existsSync(newPath)) continue; // 目标已存在则跳过，避免覆盖

			renameSync(file, newPath);
		} catch {
			// 解析或移动失败的文件直接跳过，不影响其余会话的迁移
		}
	}
}

/**
 * 需要时把 commands/ 目录更名为 prompts/（自定义命令已改名为自定义提示词）。
 * rename 对普通目录和符号链接均有效，因此两种形态都可直接处理。
 *
 * @param baseDir - 待检查的配置目录（全局 agent 目录或项目配置目录）
 * @param label - 日志中展示的范围前缀（"Global" / "Project"）
 * @returns 是否实际执行了更名
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	// 仅当 prompts/ 尚不存在时才更名，避免覆盖用户已按新结构创建的目录
	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

/**
 * 迁移用户的 keybindings.json 到新的快捷键配置结构。
 * 文件不存在、内容非法或结构无需变更时都静默跳过，不影响启动。
 */
function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(stripBom(readFileSync(configPath, "utf-8"))) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		// 写回时补一个结尾换行符，符合 POSIX 文本文件约定
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// 格式损坏的文件直接忽略，不做迁移
	}
}

/**
 * 把 fd/rg 搜索工具的二进制文件从 tools/ 移动到 bin/。
 * bin/ 是当前版本存放托管（managed）二进制的标准目录。
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	// 历史上由 pi 自动解压的四个二进制名（fd/rg 及其 Windows .exe 变体）
	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// 移动失败可忽略，下次启动会再次尝试
				}
			} else {
				// bin/ 下已有同名文件：删除旧目录里的冗余副本即可
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// 删除失败同样可忽略
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * 检查已废弃的 hooks/ 与 tools/ 目录，生成给用户的告警文案。
 * Note：tools/ 中可能含有由 pi 自动解压的 fd/rg 二进制，这属于正常情况；
 * 只有当目录里还存在其他自定义文件时才发出告警。
 *
 * @param baseDir - 待检查的配置目录
 * @param label - 告警文案中的范围前缀（"Global" / "Project"）
 * @returns 告警文案列表（为空表示无需告警）
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	// hooks/ 机制已整体更名为 extensions/，目录存在即提示用户迁移
	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// 检查 tools/ 是否包含 fd/rg 之外的文件（fd/rg 是自动解压的二进制，不算自定义工具）
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // 忽略 .DS_Store 等隐藏文件
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// 目录读取失败则不产生告警
		}
	}

	return warnings;
}

/**
 * 执行扩展体系相关的迁移（commands/ → prompts/），并收集已废弃目录的告警。
 * 全局（agent 目录）与项目级（cwd 下的配置目录）两处都会处理。
 *
 * @param cwd - 当前工作目录，用于定位项目级配置目录
 * @returns 需要展示给用户的废弃告警列表
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// 更名：全局与项目两级都尝试 commands/ → prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// 检查两级目录中的 hooks/、tools/ 等已废弃目录并收集告警
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * 打印废弃告警，并等待用户按任意键后继续启动。
 *
 * @param warnings - 待展示的告警文案列表；为空时直接返回
 * @returns 用户按键后 resolve 的 Promise
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	// 进入 raw 模式监听任意单次按键：无需回车、按键也不会回显到终端；
	// 恢复 raw 模式并 pause，确保把终端状态交还给后续的 TUI 界面
	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * 依次执行全部迁移。启动时调用一次。
 *
 * @returns 迁移结果：已迁移的认证供应商列表，以及需要展示给用户的废弃告警
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	// 认证 → 会话 → 二进制 → 快捷键 → 扩展体系，各项互不依赖、逐个执行
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
