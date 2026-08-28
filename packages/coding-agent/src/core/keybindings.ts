/**
 * @file keybindings.ts —— 键位绑定体系（默认键位表 + 用户自定义配置的解析与迁移）
 *
 * @description
 * 本文件构建终端 AI 编码助手的完整键位体系，分为四层：
 * - `AppKeybindings`：应用层动作名的类型清单（`app.*`），经 `declare module`
 *   合入 pi-tui 的 `Keybindings` 接口，使键位 ID 在全项目获得类型检查；
 * - `KEYBINDINGS`：默认键位表——继承 pi-tui 的 `TUI_KEYBINDINGS`，
 *   对少量 TUI 基础键位做平台差异覆写，再追加全部应用层键位；
 * - 旧键名迁移：`KEYBINDING_NAME_MIGRATIONS` 把旧版短名（如 cursorUp、
 *   interrupt）迁移到新命名空间键名（如 tui.editor.cursorUp、app.interrupt）；
 * - `KeybindingsManager`：加载 agentDir 下的 keybindings.json 用户自定义配置，
 *   容错解析（损坏/含 BOM 均不致命）、自动迁移旧键名并按默认表排序输出。
 *
 * 依赖关系：
 * - `@earendil-works/pi-tui`：TUI 基础键位表与 KeybindingsManager 基类；
 * - `../config.ts`：getAgentDir（定位用户配置目录）；
 * - `../utils/text.ts`：stripBom（剥离 JSON 文件可能带的 UTF-8 BOM）。
 */
import {
	type Keybinding,
	type KeybindingDefinitions,
	type KeybindingsConfig,
	type KeyId,
	TUI_KEYBINDINGS,
	KeybindingsManager as TuiKeybindingsManager,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "../config.ts";
import { stripBom } from "../utils/text.ts";

/**
 * 应用层动作清单：键为动作 ID（`app.*` 命名空间），值恒为 true。
 * 这里的作用是类型层面的"枚举"——列出所有可绑定键位的动作，
 * 配合下方 `declare module` 并入 pi-tui 的 Keybindings 接口。
 */
export interface AppKeybindings {
	"app.interrupt": true;
	"app.clear": true;
	"app.exit": true;
	"app.suspend": true;
	"app.thinking.cycle": true;
	"app.model.cycleForward": true;
	"app.model.cycleBackward": true;
	"app.model.select": true;
	"app.tools.expand": true;
	"app.thinking.toggle": true;
	"app.session.toggleNamedFilter": true;
	"app.editor.external": true;
	"app.message.copy": true;
	"app.message.followUp": true;
	"app.message.dequeue": true;
	"app.clipboard.pasteImage": true;
	"app.session.new": true;
	"app.session.tree": true;
	"app.session.fork": true;
	"app.session.resume": true;
	"app.tree.foldOrUp": true;
	"app.tree.unfoldOrDown": true;
	"app.tree.editLabel": true;
	"app.tree.toggleLabelTimestamp": true;
	"app.session.togglePath": true;
	"app.session.toggleSort": true;
	"app.session.rename": true;
	"app.session.delete": true;
	"app.session.deleteNoninvasive": true;
	"app.models.save": true;
	"app.models.enableAll": true;
	"app.models.clearAll": true;
	"app.models.toggleProvider": true;
	"app.models.reorderUp": true;
	"app.models.reorderDown": true;
	"app.tree.filter.default": true;
	"app.tree.filter.noTools": true;
	"app.tree.filter.userOnly": true;
	"app.tree.filter.labeledOnly": true;
	"app.tree.filter.all": true;
	"app.tree.filter.cycleForward": true;
	"app.tree.filter.cycleBackward": true;
}

/** 单个应用层动作 ID（`app.*` 键名）。 */
export type AppKeybinding = keyof AppKeybindings;

/**
 * 判断当前环境是否按"Windows 键位习惯"处理：原生 Windows，或 WSL
 * （通过 WSL_DISTRO_NAME / WSL_INTEROP 环境变量识别）。
 * Windows/WSL 下部分组合键（ctrl+z、ctrl+shift+方向键等）被终端占用或
 * 无法上报，需要换成备选键位。
 */
export function useWindowsKeybindings(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return platform === "win32" || (platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP));
}

// 模块扩充：把应用层动作并入 pi-tui 的 Keybindings 接口，
// 使 KEYBINDINGS 表与用户配置里的键名都能获得编译期类型检查
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends AppKeybindings {}
}

// 模块加载时判定一次，供下方默认键位表按平台取值
const windowsKeybindings = useWindowsKeybindings();

/**
 * 完整的默认键位表：TUI 内置键位 + 平台差异覆写 + 应用层键位。
 *
 * 写法约定：先展开 TUI_KEYBINDINGS 继承全部基础键位；对个别条目用展开运算符
 * 覆写 defaultKeys（保留原 description 等字段）；`as const satisfies
 * KeybindingDefinitions` 保证表内容在编译期与 pi-tui 的键位定义类型完全吻合。
 * defaultKeys 既可以是单个键（string），也可以是一组候选键（string[]，依次尝试）。
 */
export const KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	// ===== 平台差异覆写：TUI 编辑器 / 备屏（alt screen）的基础键位 =====
	"tui.editor.undo": {
		...TUI_KEYBINDINGS["tui.editor.undo"],
		defaultKeys: process.platform === "win32" ? "ctrl+z" : windowsKeybindings ? "alt+z" : "ctrl+-",
	},
	"tui.altScreen.previousPrompt": {
		...TUI_KEYBINDINGS["tui.altScreen.previousPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+up" : ["ctrl+shift+up", "ctrl+up"],
	},
	"tui.altScreen.nextPrompt": {
		...TUI_KEYBINDINGS["tui.altScreen.nextPrompt"],
		defaultKeys: windowsKeybindings ? "ctrl+down" : ["ctrl+shift+down", "ctrl+down"],
	},
	"tui.altScreen.search": {
		...TUI_KEYBINDINGS["tui.altScreen.search"],
		defaultKeys: windowsKeybindings ? "ctrl+f" : "ctrl+shift+f",
	},
	// ===== 应用层键位（主界面）=====
	"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
	"app.clear": { defaultKeys: "ctrl+c", description: "Clear editor" },
	"app.exit": { defaultKeys: "ctrl+d", description: "Exit when editor is empty" },
	"app.suspend": {
		defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
		description: "Suspend to background",
	},
	"app.thinking.cycle": {
		defaultKeys: "shift+tab",
		description: "Cycle thinking level",
	},
	"app.model.cycleForward": {
		defaultKeys: "ctrl+p",
		description: "Cycle to next model",
	},
	"app.model.cycleBackward": {
		defaultKeys: windowsKeybindings ? "alt+p" : "shift+ctrl+p",
		description: "Cycle to previous model",
	},
	"app.model.select": { defaultKeys: "ctrl+l", description: "Open model selector" },
	"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
	"app.thinking.toggle": {
		defaultKeys: "ctrl+t",
		description: "Toggle thinking blocks",
	},
	"app.session.toggleNamedFilter": {
		defaultKeys: "ctrl+n",
		description: "Toggle named session filter",
	},
	"app.editor.external": {
		defaultKeys: "ctrl+g",
		description: "Open external editor",
	},
	"app.message.copy": {
		defaultKeys: "ctrl+x",
		description: "Copy message to clipboard",
	},
	"app.message.followUp": {
		defaultKeys: windowsKeybindings ? "ctrl+q" : "alt+enter",
		description: "Queue follow-up message",
	},
	"app.message.dequeue": {
		defaultKeys: windowsKeybindings ? "alt+q" : "alt+up",
		description: "Restore queued messages",
	},
	"app.clipboard.pasteImage": {
		defaultKeys: windowsKeybindings ? "alt+v" : "ctrl+v",
		description: "Paste image from clipboard (text fallback)",
	},
	// 以下会话操作不设默认全局键位：动作本身存在（可由用户自定义绑定，
	// 或由界面代码直接 onAction 触发），但默认不占用任何快捷键
	"app.session.new": { defaultKeys: [], description: "Start a new session" },
	"app.session.tree": { defaultKeys: [], description: "Open session tree" },
	"app.session.fork": { defaultKeys: [], description: "Fork current session" },
	"app.session.resume": { defaultKeys: [], description: "Resume a session" },
	"app.tree.foldOrUp": {
		defaultKeys: process.platform === "darwin" ? ["alt+left", "ctrl+left"] : ["ctrl+left", "alt+left"],
		description: "Fold tree branch or move up",
	},
	"app.tree.unfoldOrDown": {
		defaultKeys: process.platform === "darwin" ? ["alt+right", "ctrl+right"] : ["ctrl+right", "alt+right"],
		description: "Unfold tree branch or move down",
	},
	"app.tree.editLabel": {
		defaultKeys: "shift+l",
		description: "Edit tree label",
	},
	"app.tree.toggleLabelTimestamp": {
		defaultKeys: "shift+t",
		description: "Toggle tree label timestamps",
	},
	// ===== 会话浏览器视图 =====
	// 注意这些键与主界面键存在复用（如 ctrl+p / ctrl+s / ctrl+d）：
	// 各视图互斥显示，同一按键在不同视图中承担不同动作不会冲突
	"app.session.togglePath": {
		defaultKeys: "ctrl+p",
		description: "Toggle session path display",
	},
	"app.session.toggleSort": {
		defaultKeys: "ctrl+s",
		description: "Toggle session sort mode",
	},
	"app.session.rename": {
		defaultKeys: "ctrl+r",
		description: "Rename session",
	},
	"app.session.delete": {
		defaultKeys: "ctrl+d",
		description: "Delete session",
	},
	"app.session.deleteNoninvasive": {
		defaultKeys: "ctrl+backspace",
		description: "Delete session when query is empty",
	},
	// ===== 模型选择视图 =====
	"app.models.save": {
		defaultKeys: "ctrl+s",
		description: "Save model selection",
	},
	"app.models.enableAll": {
		defaultKeys: "ctrl+a",
		description: "Enable all models",
	},
	"app.models.clearAll": {
		defaultKeys: "ctrl+x",
		description: "Clear all models",
	},
	"app.models.toggleProvider": {
		defaultKeys: "ctrl+p",
		description: "Toggle all models for provider",
	},
	"app.models.reorderUp": {
		defaultKeys: "alt+up",
		description: "Move model up in order",
	},
	"app.models.reorderDown": {
		defaultKeys: "alt+down",
		description: "Move model down in order",
	},
	// ===== 会话树过滤器 =====
	"app.tree.filter.default": {
		defaultKeys: "ctrl+d",
		description: "Tree filter: default view",
	},
	"app.tree.filter.noTools": {
		defaultKeys: "ctrl+t",
		description: "Tree filter: hide tool results",
	},
	"app.tree.filter.userOnly": {
		defaultKeys: "ctrl+u",
		description: "Tree filter: user messages only",
	},
	"app.tree.filter.labeledOnly": {
		defaultKeys: "ctrl+l",
		description: "Tree filter: labeled entries only",
	},
	"app.tree.filter.all": {
		defaultKeys: "ctrl+a",
		description: "Tree filter: show all entries",
	},
	"app.tree.filter.cycleForward": {
		defaultKeys: "ctrl+o",
		description: "Tree filter: cycle forward",
	},
	"app.tree.filter.cycleBackward": {
		defaultKeys: "shift+ctrl+o",
		description: "Tree filter: cycle backward",
	},
} as const satisfies KeybindingDefinitions;

/**
 * 旧键名 → 新键名 的迁移表。
 * 早期版本键位配置使用短名（cursorUp、interrupt 等），后来引入了
 * 命名空间（tui.editor.* / tui.input.* / tui.select.* / app.*），
 * 该表用于把用户旧配置文件里的键名自动升级，避免配置失效。
 */
const KEYBINDING_NAME_MIGRATIONS = {
	cursorUp: "tui.editor.cursorUp",
	cursorDown: "tui.editor.cursorDown",
	cursorLeft: "tui.editor.cursorLeft",
	cursorRight: "tui.editor.cursorRight",
	cursorWordLeft: "tui.editor.cursorWordLeft",
	cursorWordRight: "tui.editor.cursorWordRight",
	cursorLineStart: "tui.editor.cursorLineStart",
	cursorLineEnd: "tui.editor.cursorLineEnd",
	jumpForward: "tui.editor.jumpForward",
	jumpBackward: "tui.editor.jumpBackward",
	pageUp: "tui.editor.pageUp",
	pageDown: "tui.editor.pageDown",
	deleteCharBackward: "tui.editor.deleteCharBackward",
	deleteCharForward: "tui.editor.deleteCharForward",
	deleteWordBackward: "tui.editor.deleteWordBackward",
	deleteWordForward: "tui.editor.deleteWordForward",
	deleteToLineStart: "tui.editor.deleteToLineStart",
	deleteToLineEnd: "tui.editor.deleteToLineEnd",
	yank: "tui.editor.yank",
	yankPop: "tui.editor.yankPop",
	undo: "tui.editor.undo",
	newLine: "tui.input.newLine",
	submit: "tui.input.submit",
	tab: "tui.input.tab",
	copy: "tui.input.copy",
	selectUp: "tui.select.up",
	selectDown: "tui.select.down",
	selectPageUp: "tui.select.pageUp",
	selectPageDown: "tui.select.pageDown",
	selectConfirm: "tui.select.confirm",
	selectCancel: "tui.select.cancel",
	interrupt: "app.interrupt",
	clear: "app.clear",
	exit: "app.exit",
	suspend: "app.suspend",
	cycleThinkingLevel: "app.thinking.cycle",
	cycleModelForward: "app.model.cycleForward",
	cycleModelBackward: "app.model.cycleBackward",
	selectModel: "app.model.select",
	expandTools: "app.tools.expand",
	toggleThinking: "app.thinking.toggle",
	toggleSessionNamedFilter: "app.session.toggleNamedFilter",
	externalEditor: "app.editor.external",
	followUp: "app.message.followUp",
	dequeue: "app.message.dequeue",
	pasteImage: "app.clipboard.pasteImage",
	newSession: "app.session.new",
	tree: "app.session.tree",
	fork: "app.session.fork",
	resume: "app.session.resume",
	treeFoldOrUp: "app.tree.foldOrUp",
	treeUnfoldOrDown: "app.tree.unfoldOrDown",
	treeEditLabel: "app.tree.editLabel",
	treeToggleLabelTimestamp: "app.tree.toggleLabelTimestamp",
	toggleSessionPath: "app.session.togglePath",
	toggleSessionSort: "app.session.toggleSort",
	renameSession: "app.session.rename",
	deleteSession: "app.session.delete",
	deleteSessionNoninvasive: "app.session.deleteNoninvasive",
} as const satisfies Record<string, Keybinding>;

/** 类型守卫：判断键名是否为旧版短名（即存在于迁移表中）。 */
function isLegacyKeybindingName(key: string): key is keyof typeof KEYBINDING_NAME_MIGRATIONS {
	return key in KEYBINDING_NAME_MIGRATIONS;
}

/**
 * 把任意 JSON 对象规整为合法的 KeybindingsConfig：
 * 只保留值为「单个字符串」或「全为字符串的数组」的键位条目，
 * 其余形状（数字、布尔、嵌套对象等非法配置）一律静默丢弃。
 */
function toKeybindingsConfig(value: Record<string, unknown>): KeybindingsConfig {
	const config: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		// 形状一：单个键，如 "cursorUp": "ctrl+a"
		if (typeof binding === "string") {
			config[key] = binding as KeyId;
			continue;
		}
		// 形状二：候选键数组，如 "cursorUp": ["ctrl+a", "alt+a"]
		if (Array.isArray(binding) && binding.every((entry) => typeof entry === "string")) {
			config[key] = binding as KeyId[];
		}
	}
	return config;
}

/**
 * 迁移键位配置中的旧键名，并按默认键位表的顺序重排键。
 *
 * @param rawConfig - 从用户 JSON 文件读出的原始键值对象
 * @returns config 为迁移并排序后的配置；migrated 表示是否发生了任何变更
 *   （有旧名被改写，或旧名与新名同时存在导致旧名条目被丢弃），调用方可据此决定是否回写文件
 */
export function migrateKeybindingsConfig(rawConfig: Record<string, unknown>): {
	config: Record<string, unknown>;
	migrated: boolean;
} {
	const config: Record<string, unknown> = {};
	let migrated = false;

	for (const [key, value] of Object.entries(rawConfig)) {
		// 旧名 → 新名；不是旧名则原样保留
		const nextKey = isLegacyKeybindingName(key) ? KEYBINDING_NAME_MIGRATIONS[key] : key;
		if (nextKey !== key) {
			migrated = true;
		}
		// 同一配置里旧名与新名并存时，新名优先：丢弃旧名条目（也标记为已迁移）
		if (key !== nextKey && Object.hasOwn(rawConfig, nextKey)) {
			migrated = true;
			continue;
		}
		config[nextKey] = value;
	}

	return { config: orderKeybindingsConfig(config), migrated };
}

/**
 * 按默认键位表（KEYBINDINGS）的定义顺序重排配置键，
 * 未知的额外键按字母序追加在末尾。仅影响输出文件的可读性，不影响语义。
 */
function orderKeybindingsConfig(config: Record<string, unknown>): Record<string, unknown> {
	const ordered: Record<string, unknown> = {};
	// 先按默认表顺序挑出已知键位
	for (const keybinding of Object.keys(KEYBINDINGS)) {
		if (Object.hasOwn(config, keybinding)) {
			ordered[keybinding] = config[keybinding];
		}
	}

	// 再把默认表之外的所有键排序后追加
	const extras = Object.keys(config)
		.filter((key) => !Object.hasOwn(ordered, key))
		.sort();
	for (const key of extras) {
		ordered[key] = config[key];
	}

	return ordered;
}

/**
 * 读取并解析键位 JSON 文件，任何失败都返回 undefined：
 * 文件不存在、JSON 语法损坏、根不是对象均视为"没有配置"，不抛错。
 * 读取时先 stripBom，兼容带 UTF-8 BOM 的编辑器产物。
 */
function loadRawConfig(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(stripBom(readFileSync(path, "utf-8"))) as unknown;
		// JSON.parse 的合法根还可能是数组/数字/字符串，这里只接受对象
		if (typeof parsed !== "object" || parsed === null) return undefined;
		return parsed as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * 应用层的键位管理器：在 pi-tui 的 KeybindingsManager 基础上，
 * 固定使用本文件的 KEYBINDINGS 作为默认表，并接管用户配置文件的
 * 加载（容错 + 旧键名迁移）与热重载。
 */
export class KeybindingsManager extends TuiKeybindingsManager {
	// 用户配置文件路径；未提供时（纯内存构造）reload 为空操作
	private configPath: string | undefined;

	constructor(userBindings: KeybindingsConfig = {}, configPath?: string) {
		super(KEYBINDINGS, userBindings);
		this.configPath = configPath;
	}

	/**
	 * 从 agentDir（默认 ~/.pi 之类的用户目录）读取 keybindings.json 创建实例。
	 * 文件缺失或损坏时得到一个全默认键位的实例，不会报错。
	 */
	static create(agentDir: string = getAgentDir()): KeybindingsManager {
		const configPath = join(agentDir, "keybindings.json");
		const userBindings = KeybindingsManager.loadFromFile(configPath);
		return new KeybindingsManager(userBindings, configPath);
	}

	/** 重新从磁盘读取配置并应用（用于用户编辑配置文件后的热更新）。 */
	reload(): void {
		if (!this.configPath) return;
		this.setUserBindings(KeybindingsManager.loadFromFile(this.configPath));
	}

	/**
	 * 导出当前生效的完整键位配置（用户配置覆盖默认值后的结果），
	 * 供写入文件或展示使用。
	 */
	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	/**
	 * 读取并规整配置文件：loadRawConfig 容错解析 →
	 * migrateKeybindingsConfig 迁移旧键名并排序 → toKeybindingsConfig 过滤非法形状。
	 */
	private static loadFromFile(path: string): KeybindingsConfig {
		const rawConfig = loadRawConfig(path);
		if (!rawConfig) return {};
		return toKeybindingsConfig(migrateKeybindingsConfig(rawConfig).config);
	}
}

// 透传导出 pi-tui 的键位相关类型，外部无需直接依赖 pi-tui
export type { Keybinding, KeyId, KeybindingsConfig };
