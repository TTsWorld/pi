/**
 * @file types.ts
 * @description pods 包核心类型定义 —— GPU / Model / Pod / Config 数据模型
 * @module pi-pods
 *
 * 主要功能：
 * - GPU：单块 GPU 的硬件信息，setup 时通过 nvidia-smi 解析远端 GPU 清单得到
 * - Model：一个已部署的模型服务实例（远端后台运行的 vLLM 进程）的运行时信息
 * - Pod：一台远程 GPU 机器的完整描述（SSH 连接、GPU 清单、已部署模型、vLLM 版本）
 * - Config：本地配置文件（~/.pi/pods.json）的顶层结构，管理 Pod 集合与活跃 Pod
 */

/** 单块 GPU 的硬件信息（setup 时解析远端 nvidia-smi 输出获得） */
export interface GPU {
	/** GPU 序号，对应 nvidia-smi 的 index（从 0 开始） */
	id: number;
	/** GPU 型号名，如 "NVIDIA A100" */
	name: string;
	/** 总显存，如 "81920 MiB"（nvidia-smi 的 memory.total 原样字符串） */
	memory: string;
}

/** 一个已部署的模型服务实例（远端以 setsid 后台方式运行的 vLLM 进程） */
export interface Model {
	/** 模型 ID（HuggingFace 模型标识），用于拉取权重并启动 vLLM */
	model: string;
	/** vLLM 服务的监听端口 */
	port: number;
	gpu: number[]; // 多卡部署时使用的 GPU ID 数组（写入 CUDA_VISIBLE_DEVICES）
	/** 远端模型进程的 PID（启动命令通过 echo $! 回传） */
	pid: number;
}

/** 一台远程 GPU 机器（Pod），通过 SSH 管理其 GPU 资源与模型服务 */
export interface Pod {
	/** SSH 连接命令，如 "ssh root@1.2.3.4" 或 "ssh -p 22 root@1.2.3.4" */
	ssh: string;
	/** 远端 GPU 清单（setup 时执行 nvidia-smi 解析得到） */
	gpus: GPU[];
	/** 已部署的模型服务，key 为部署时指定的服务别名（name），value 为其运行时信息 */
	models: Record<string, Model>;
	/** 远端模型权重存储路径（setup 时由 --models-path 指定或从 --mount 命令末尾提取） */
	modelsPath?: string;
	vllmVersion?: "release" | "nightly" | "gpt-oss"; // 追踪远端安装的 vLLM 版本
}

/** 本地配置文件（~/.pi/pods.json，可用 PI_CONFIG_DIR 覆盖）的顶层结构 */
export interface Config {
	/** 全部已注册的 Pod，key 为 Pod 名称（pods setup 时指定） */
	pods: Record<string, Pod>;
	/** 当前活跃 Pod 的名称（命令未显式指定 --pod 时默认使用；首个注册的 Pod 自动设为活跃） */
	active?: string;
}
