/**
 * @file config.ts
 * @description 本地配置持久化 —— ~/.pi/pods.json 的读写与 Pod 注册表管理
 * @module pi-pods
 *
 * 主要功能：
 * - 定位配置目录（可通过 PI_CONFIG_DIR 环境变量覆盖默认的 ~/.pi）
 * - 加载/保存配置文件 pods.json（Pod 注册表 + 当前激活的 Pod 名称）
 * - 维护 Pod 生命周期：注册（addPod）、注销（removePod）、切换激活（setActivePod）
 * - 读取当前激活的 Pod（getActivePod）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Config, Pod } from "./types.js";

/**
 * 获取配置目录路径：优先读取 PI_CONFIG_DIR 环境变量，未设置时回退到 ~/.pi
 *
 * 目录不存在时递归创建，保证后续写入 pods.json 时目录一定存在
 */
const getConfigDir = (): string => {
	// PI_CONFIG_DIR 环境变量可覆盖默认根目录，便于测试或隔离多套配置
	const configDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
	if (!existsSync(configDir)) {
		// recursive: true 确保父目录也缺失时能一次建齐
		mkdirSync(configDir, { recursive: true });
	}
	return configDir;
};

/**
 * 获取配置文件完整路径：<配置目录>/pods.json
 */
const getConfigPath = (): string => {
	return join(getConfigDir(), "pods.json");
};

/**
 * 从磁盘加载配置；任何异常情况（文件不存在、内容损坏）都降级为空配置而非抛错
 */
export const loadConfig = (): Config => {
	const configPath = getConfigPath();
	if (!existsSync(configPath)) {
		// 首次运行：配置文件尚不存在，返回空注册表
		return { pods: {} };
	}
	try {
		const data = readFileSync(configPath, "utf-8");
		return JSON.parse(data);
	} catch (e) {
		// 文件损坏（JSON 解析失败）等读取异常：打印错误并回退到空配置，避免 CLI 直接崩溃
		console.error(`Error reading config: ${e}`);
		return { pods: {} };
	}
};

/**
 * 将配置整体写回磁盘（JSON、2 空格缩进，便于人工检视与 diff）
 *
 * 与 loadConfig 的容错策略不同：写失败属于严重错误，打印日志后直接退出进程
 */
export const saveConfig = (config: Config): void => {
	const configPath = getConfigPath();
	try {
		writeFileSync(configPath, JSON.stringify(config, null, 2));
	} catch (e) {
		// 写入失败意味着状态可能丢失，继续运行会产生不一致，因此直接终止进程
		console.error(`Error saving config: ${e}`);
		process.exit(1);
	}
};

/**
 * 获取当前激活的 Pod（名称 + 完整定义）
 *
 * @returns 激活 Pod 的名称与定义；未设置 active、或 active 指向的 Pod 已被删除时返回 null
 */
export const getActivePod = (): { name: string; pod: Pod } | null => {
	const config = loadConfig();
	// 双重校验：active 字段存在，且注册表中确实有对应条目（防止悬空引用）
	if (!config.active || !config.pods[config.active]) {
		return null;
	}
	return { name: config.active, pod: config.pods[config.active] };
};

/**
 * 注册（同名时覆盖）一个 Pod，并立即持久化
 *
 * 若当前没有激活的 Pod，则自动把新注册的 Pod 设为激活，省去首次使用时手动切换
 */
export const addPod = (name: string, pod: Pod): void => {
	const config = loadConfig();
	config.pods[name] = pod;
	// 首个注册的 Pod 自动激活，保证开箱即用
	if (!config.active) {
		config.active = name;
	}
	saveConfig(config);
};

/**
 * 从注册表中删除指定 Pod，并立即持久化
 *
 * 若删除的正是当前激活的 Pod，则同时清空 active 字段（回到无激活状态）
 */
export const removePod = (name: string): void => {
	const config = loadConfig();
	delete config.pods[name];
	// 避免 active 悬空指向已删除的 Pod
	if (config.active === name) {
		config.active = undefined;
	}
	saveConfig(config);
};

/**
 * 切换当前激活的 Pod，并立即持久化
 *
 * 目标 Pod 必须已在注册表中，否则打印错误并以退出码 1 终止进程
 */
export const setActivePod = (name: string): void => {
	const config = loadConfig();
	// 只允许激活已注册的 Pod
	if (!config.pods[name]) {
		console.error(`Pod '${name}' not found`);
		process.exit(1);
	}
	config.active = name;
	saveConfig(config);
};
