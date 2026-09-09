/**
 * @file pods 包的配置管理模块
 * @description 负责 ~/.pi/pods.json 配置文件的读写与维护：
 *              加载/保存配置（loadConfig/saveConfig）、查询当前激活的
 *              pod（getActivePod）、增删 pod（addPod/removePod）以及
 *              切换激活 pod（setActivePod）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config, Pod } from "./types.js";

// 从环境变量读取配置目录，未设置则使用默认值
const getConfigDir = (): string => {
	const configDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
	if (!existsSync(configDir)) {
		// 目录不存在时递归创建
		mkdirSync(configDir, { recursive: true });
	}
	return configDir;
};

/**
 * 获取配置文件的完整路径（<配置目录>/pods.json）
 * @returns 配置文件路径
 */
const getConfigPath = (): string => {
	return join(getConfigDir(), "pods.json");
};

/**
 * 加载配置文件
 * @description 文件不存在或解析失败时返回空配置（pods 为空对象），
 *              不抛出异常
 * @returns 解析后的 Config 对象
 */
export const loadConfig = (): Config => {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		// 文件不存在时返回空配置
		return { pods: {} };
	}
	try {
		const data = readFileSync(configPath, "utf-8");
		return JSON.parse(data);
	} catch (e) {
		console.error(`Error reading config: ${e}`);
		return { pods: {} };
	}
};

/**
 * 保存配置到文件
 * @description 以 2 空格缩进的 JSON 格式写入；写入失败时打印错误
 *              并直接退出进程（exit code 1）
 * @param config - 要保存的配置对象
 */
export const saveConfig = (config: Config): void => {
	const configPath = getConfigPath();
	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	} catch (e) {
		console.error(`Error saving config: ${e}`);
		process.exit(1);
	}
};

/**
 * 获取当前激活的 pod
 * @returns 包含 pod 名称与配置的对象；未设置 active 或 active
 *          指向的 pod 不存在时返回 null
 */
export const getActivePod = (): { name: string; pod: Pod } | null => {
	const config = loadConfig();
	if (!config.active || !config.pods[config.active]) {
		return null;
	}
	return { name: config.active, pod: config.pods[config.active] };
};

/**
 * 添加一个 pod 到配置
 * @description 若当前没有激活的 pod，则将新添加的 pod 设为激活
 * @param name - pod 名称
 * @param pod - pod 配置对象
 */
export const addPod = (name: string, pod: Pod): void => {
	const config = loadConfig();
	config.pods[name] = pod;
	// 如果当前没有激活的 pod，则将这个设为激活
	if (!config.active) {
		config.active = name;
	}
	saveConfig(config);
};

/**
 * 从配置中移除一个 pod
 * @description 若移除的正是当前激活的 pod，则同时清空 active 字段
 * @param name - pod 名称
 */
export const removePod = (name: string): void => {
	const config = loadConfig();
	delete config.pods[name];
	// 如果移除的是激活的 pod，则清空 active
	if (config.active === name) {
		config.active = undefined;
	}
	saveConfig(config);
};

/**
 * 设置激活的 pod
 * @description pod 不存在时打印错误并退出进程（exit code 1）
 * @param name - pod 名称
 */
export const setActivePod = (name: string): void => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(`Pod '${name}' not found`);
		process.exit(1);
	}
	config.active = name;
	saveConfig(config);
};
