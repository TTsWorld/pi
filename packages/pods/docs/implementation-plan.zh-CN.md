> 中文版译自 [implementation-plan.md](implementation-plan.md)，如与英文原文有出入，以英文原文为准。

# 实现计划

## 核心原则
- 全程使用 TypeScript
- 干净、精简的代码
- 自包含的模块
- 直接通过 SSH 执行（不使用远程管理器）
- 所有状态保存在本地 JSON 中

## 包 1：Pod 初始化脚本生成
通过 SSH 生成并执行 pod_setup.sh

- [ ] `src/setup/generate-setup-script.ts` - 以字符串形式生成 bash 脚本
  - [ ] 检测 CUDA 驱动版本
  - [ ] 确定所需的 CUDA toolkit 版本
  - [ ] 生成 uv/Python 安装命令
  - [ ] 生成 venv 创建命令
  - [ ] 生成 pip install 命令（torch、vLLM 等）
  - [ ] 处理特定模型所需的 vLLM 版本（例如 gpt-oss 需要 0.10.1+gptoss）
  - [ ] 若提供 --mount 则生成挂载命令
  - [ ] 生成环境变量设置（HF_TOKEN、PI_API_KEY）

- [ ] `src/setup/detect-hardware.ts` - 运行 nvidia-smi 并解析 GPU 信息
  - [ ] 通过 SSH 执行 nvidia-smi
  - [ ] 解析 GPU 数量、名称、显存
  - [ ] 返回结构化的 GPU 信息

- [ ] `src/setup/execute-setup.ts` - 初始化主编排器
  - [ ] 生成初始化脚本
  - [ ] 通过 SSH 复制并执行
  - [ ] 将输出流式打印到控制台
  - [ ] 正确处理 Ctrl+C
  - [ ] 将 GPU 信息保存到本地配置

## 包 2：配置管理
本地 JSON 状态管理

- [ ] `src/config/types.ts` - TypeScript 接口
  - [ ] Pod 接口（ssh、gpus、models、mount）
  - [ ] Model 接口（model、port、gpu、pid）
  - [ ] GPU 接口（id、name、memory）

- [ ] `src/config/store.ts` - 读写 ~/.pi/pods.json
  - [ ] 加载配置（处理文件缺失的情况）
  - [ ] 保存配置（原子写入）
  - [ ] 获取当前活跃的 pod
  - [ ] 添加/移除 pod
  - [ ] 更新模型状态

## 包 3：SSH 执行器
简洁的 SSH 命令执行

- [ ] `src/ssh/executor.ts` - SSH 命令封装
  - [ ] 执行命令并流式输出
  - [ ] 执行命令并捕获输出
  - [ ] 优雅地处理 SSH 错误
  - [ ] 支持 Ctrl+C 信号传递
  - [ ] 支持后台进程（nohup）

## 包 4：Pod 命令
Pod 管理 CLI 命令

- [ ] `src/commands/pods-setup.ts` - pi pods setup
  - [ ] 解析参数（name、ssh、mount）
  - [ ] 检查环境变量（HF_TOKEN、PI_API_KEY）
  - [ ] 调用初始化执行器
  - [ ] 将 pod 保存到配置

- [ ] `src/commands/pods-list.ts` - pi pods
  - [ ] 加载配置
  - [ ] 展示所有 pod 并标记活跃的那一个

- [ ] `src/commands/pods-active.ts` - pi pods active
  - [ ] 切换活跃的 pod
  - [ ] 更新配置

- [ ] `src/commands/pods-remove.ts` - pi pods remove
  - [ ] 从配置中移除（不影响远端）

## 包 5：模型管理
模型生命周期管理

- [ ] `src/models/model-config.ts` - 已知模型配置
  - [ ] 加载 models.md 数据结构
  - [ ] 将硬件匹配到 vLLM 参数
  - [ ] 获取模型专属的环境变量

- [ ] `src/models/download.ts` - 通过 HF 下载模型
  - [ ] 检查模型是否已缓存
  - [ ] 运行 huggingface-cli download
  - [ ] 将下载进度流式打印到控制台
  - [ ] 处理 Ctrl+C

- [ ] `src/models/vllm-builder.ts` - 构建 vLLM 命令
  - [ ] 获取模型的基础命令
  - [ ] 添加硬件相关参数
  - [ ] 添加用户传入的 --vllm 参数
  - [ ] 添加端口和 API key

## 包 6：模型命令
模型管理 CLI 命令

- [ ] `src/commands/start.ts` - pi start
  - [ ] 解析模型和参数
  - [ ] 寻找下一个可用端口
  - [ ] 选择 GPU（轮询调度）
  - [ ] 需要时先下载模型
  - [ ] 构建并执行 vLLM 命令
  - [ ] 等待健康检查通过
  - [ ] 成功后更新配置

- [ ] `src/commands/stop.ts` - pi stop
  - [ ] 在配置中查找模型
  - [ ] 通过 PID 终止进程
  - [ ] 清理配置

- [ ] `src/commands/list.ts` - pi list
  - [ ] 展示配置中的模型
  - [ ] 可选地校验 PID

- [ ] `src/commands/logs.ts` - pi logs
  - [ ] 通过 SSH tail 日志文件
  - [ ] 处理 Ctrl+C（仅停止 tail）

## 包 7：模型测试
使用工具快速测试模型

- [ ] `src/prompt/tools.ts` - 工具定义
  - [ ] 定义 ls、read、glob、rg 工具
  - [ ] 按 OpenAI API 格式化

- [ ] `src/prompt/client.ts` - OpenAI 客户端封装
  - [ ] 为模型端点创建客户端
  - [ ] 处理流式响应
  - [ ] 展示 thinking、tools、content

- [ ] `src/commands/prompt.ts` - pi prompt
  - [ ] 从配置获取模型端点
  - [ ] 用 CWD 信息增强 prompt
  - [ ] 携带工具发送请求
  - [ ] 展示格式化后的响应

## 包 8：CLI 入口
基于 commander.js 的主 CLI

- [ ] `src/cli.ts` - 主入口
  - [ ] 配置 commander 程序
  - [ ] 注册所有命令
  - [ ] 处理全局选项（--pod 覆盖）
  - [ ] 错误处理

- [ ] `src/index.ts` - 包导出

## 测试策略
- [ ] 在本地测试 pod_setup.sh 的生成
- [ ] 在带 GPU 的本地机器上测试
- [ ] 用 mock 命令测试 SSH 执行器
- [ ] 用临时文件测试配置管理
- [ ] 在真实 pod 上做集成测试

## 依赖
```json
{
  "dependencies": {
    "commander": "^12.0.0",
    "@commander-js/extra-typings": "^12.0.0",
    "openai": "^4.0.0",
    "chalk": "^5.0.0",
    "ora": "^8.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0",
    "tsx": "^4.0.0"
  }
}
```

## 构建与分发
- [ ] 面向 Node.js target 的 TypeScript 配置
- [ ] 构建到 dist/
- [ ] 带 bin 入口的 npm 包
- [ ] 支持 npx
