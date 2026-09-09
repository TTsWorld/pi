/**
 * @file pi 核心类型定义
 * @description 定义 pods 包的核心数据结构：GPU 硬件信息、模型部署信息、Pod 远程节点以及全局配置。
 */

/**
 * GPU 硬件信息
 */
export interface GPU {
	/** GPU 的唯一标识 ID */
	id: number;
	/** GPU 型号名称，如 "NVIDIA H100" */
	name: string;
	/** 显存大小，如 "80GB" */
	memory: string;
}

/**
 * 模型部署信息
 */
export interface Model {
	/** 模型名称 */
	model: string;
	/** 模型服务监听的端口号 */
	port: number;
	/** GPU ID 数组，用于多卡（multi-GPU）部署 */
	gpu: number[];
	/** 模型服务进程的 PID */
	pid: number;
}

/**
 * Pod 远程节点信息
 */
export interface Pod {
	/** SSH 连接地址（主机名或 IP） */
	ssh: string;
	/** 该节点上的 GPU 列表 */
	gpus: GPU[];
	/** 已部署的模型映射，key 为模型名称 */
	models: Record<string, Model>;
	/** 模型文件存放路径（可选） */
	modelsPath?: string;
	/** 已安装的 vLLM 版本（可选）：release 正式版 / nightly 每日构建版 / gpt-oss 专用版 */
	vllmVersion?: "release" | "nightly" | "gpt-oss";
}

/**
 * 全局配置
 */
export interface Config {
	/** Pod 映射，key 为 Pod 名称 */
	pods: Record<string, Pod>;
	/** 当前活跃（选中）的 Pod 名称（可选） */
	active?: string;
}
