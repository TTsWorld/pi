/**
 * @file slash-commands.ts —— slash 命令的定义与元数据
 *
 * @description
 * 描述 slash 命令的来源类型（扩展 / prompt / skill）与信息结构，
 * 并集中列出 CLI 内建的 slash 命令清单，供输入补全与帮助展示使用。
 */
import { APP_NAME } from "../config.ts";
import type { SourceInfo } from "./source-info.ts";

/** slash 命令的来源：扩展注册 / prompt 文件 / skill */
export type SlashCommandSource = "extension" | "prompt" | "skill";

/** 一个 slash 命令的描述信息 */
export interface SlashCommandInfo {
	/** 命令名（不含斜杠前缀） */
	name: string;
	/** 展示用描述 */
	description?: string;
	/** 命令来源 */
	source: SlashCommandSource;
	/** 来源定位信息（文件路径等） */
	sourceInfo: SourceInfo;
}

/** 内建 slash 命令的静态描述 */
export interface BuiltinSlashCommand {
	/** 命令名（不含斜杠前缀） */
	name: string;
	/** 展示用描述 */
	description: string;
	/** 参数提示（如 "<provider/model>"） */
	argumentHint?: string;
}

/** 内建 slash 命令清单（补全与帮助界面共用） */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "trust", description: "Save project trust decision for future sessions" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes, and context files" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];
