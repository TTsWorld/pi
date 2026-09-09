> 中文版译自 [plan.md](plan.md)，如与英文原文有出入，以英文原文为准。

## Pi

Pi 自动化地将 vLLM 部署到来自 DataCrunch、Vast.ai、Prime Intellect、RunPod 的 GPU pod（或任何带 NVIDIA GPU 的 Ubuntu 机器）上。它通过相互独立的 vLLM 实例管理多个并发的模型部署，每个实例都可通过 OpenAI API 协议访问，并采用 API key 认证。

Pod 被视为临时资源——需要时拉起，用完即销毁。为了避免重复下载模型（100GB+ 的模型需要 30 分钟以上），pi 使用持久化网络卷来存储模型，这些卷可以在同一提供商的多个 pod 之间共享。这样既能把成本降到最低（只为使用中的计算资源付费），也能把设置时间降到最低（模型已经缓存）。

## 用法

### Pod
```bash
pi pods setup dc1 "ssh root@1.2.3.4" --mount "mount -t nfs..."  # Setup pod (requires HF_TOKEN, PI_API_KEY env vars)
pi pods                              # List all pods (* = active)
pi pods active dc2                   # Switch active pod
pi pods remove dc1                   # Remove pod
```

### 模型
```bash
pi start Qwen/Qwen2.5-72B-Instruct --name qwen72b          # Known model - pi handles vLLM args
pi start some/unknown-model --name mymodel --vllm --tensor-parallel-size 4 --max-model-len 32768  # Custom vLLM args
pi list                              # List running models with ports
pi stop qwen72b                      # Stop model
pi logs qwen72b                      # View model logs
```

对于已知模型，pi 会根据 pod 的硬件，依据模型文档自动配置合适的 vLLM 参数。对于未知模型或自定义配置，可在 `--vllm` 之后传入 vLLM 参数。

## Pod 管理

Pi 将来自各家提供商（DataCrunch、Vast.ai、Prime Intellect、RunPod）的 GPU pod 作为临时计算资源来管理。用户先通过提供商的控制台手动创建 pod，然后在 pi 中注册，由 pi 进行自动化设置和管理。

核心能力：
- **Pod 设置**：在大约 2 分钟内把一台裸装的 Ubuntu/Debian 机器变成可直接运行 vLLM 的环境
- **模型缓存**：可选的持久化存储，由多个 pod 共享，避免重复下载 100GB+ 的模型
- **多 pod 管理**：注册多个 pod，在它们之间切换，维护各自不同的环境

### Pod 设置

当用户在提供商处创建好一个全新的 pod 后，使用提供商给出的 SSH 命令将其注册到 pi：

```bash
pi pods setup dc1 "ssh root@1.2.3.4" --mount "mount -t nfs..."
```

这条命令会复制并执行 `pod_setup.sh`，该脚本会：
1. 通过 `nvidia-smi` 检测 GPU，并将 GPU 数量/显存存入本地配置
2. 安装与驱动版本匹配的 CUDA 工具包
3. 创建 Python 环境
   - 安装 uv 和 Python 3.12
   - 在 ~/venv 创建 venv 并安装 PyTorch（--torch-backend=auto）
   - 安装 vLLM（需要时安装特定模型对应的版本）
   - 安装 FlashInfer（必要时从源码构建）
   - 安装 huggingface-hub（用于下载模型）
   - 安装 hf-transfer（用于加速下载）
4. 如提供了持久化存储则进行挂载
   - 创建指向 ~/.cache/huggingface 的符号链接，用于模型缓存
5. 持久化配置环境变量

必需的环境变量：
- `HF_TOKEN`：用于下载模型的 HuggingFace token
- `PI_API_KEY`：用于保护 vLLM 端点的 API key

### 模型缓存

模型可能有 100GB+，下载需要 30 分钟以上。`--mount` 标志可启用持久化模型缓存：

- **DataCrunch**：NFS 共享文件系统，可在同一区域的多个运行中的 pod 之间挂载
- **RunPod**：网络卷可独立持久保留，但无法在运行中的 pod 之间共享
- **Vast.ai**：卷锁定在特定机器上——不能共享
- **Prime Intellect**：文档中未提及持久化存储

如果不使用 `--mount`，模型会下载到 pod 本地存储中，pod 终止时随之丢失。

### 多 pod 管理

用户可以注册多个 pod 并在它们之间切换：

```bash
pi pods                    # List all pods (* = active)
pi pods active dc2         # Switch active pod
pi pods remove dc1         # Remove pod from local config but doesn't destroy pod remotely.
```

所有模型命令（`pi start`、`pi stop` 等）都作用于当前活跃的 pod；除非显式指定 `--pod <podname>`，该参数会为这条命令覆盖活跃 pod。

## 模型部署

Pi 使用直接的 SSH 命令管理 pod 上的 vLLM 实例。无需任何远程管理组件——一切都由本地 pi CLI 控制。

### 架构
pi CLI 将所有状态保存在本地的 `~/.pi/pods.json` 中：
```json
{
  "pods": {
    "dc1": {
      "ssh": "ssh root@1.2.3.4",
      "gpus": [
        {"id": 0, "name": "H100", "memory": "80GB"},
        {"id": 1, "name": "H100", "memory": "80GB"}
      ],
      "models": {
        "qwen": {
          "model": "Qwen/Qwen2.5-72B",
          "port": 8001,
          "gpu": "0",
          "pid": 12345
        }
      }
    }
  },
  "active": "dc1"
}
```

pi 配置目录的位置也可以通过 `PI_CONFIG_DIR` 环境变量指定，例如用于测试。

Pi 假定 pod 完全由自己管理——没有其他进程竞争端口或 GPU。

### 启动模型
当用户运行 `pi start Qwen/Qwen2.5-72B --name qwen` 时：
1. CLI 确定下一个可用端口（从 8001 开始）
2. 选择 GPU（依据已存储的 GPU 信息按轮询方式分配）
3. 若模型未缓存则先下载：
   - 设置 `HF_HUB_ENABLE_HF_TRANSFER=1` 以加快下载速度
   - 通过 SSH 运行，输出实时管道传回本地终端
   - Ctrl+C 取消下载并交回控制权
4. 构建带有相应参数和 PI_API_KEY 的 vLLM 命令
5. 通过 SSH 执行：`ssh pod "nohup vllm serve ... > ~/.vllm_logs/qwen.log 2>&1 & echo $!"`
6. 等待 vLLM 就绪（检查健康检查端点）
7. 成功时：将端口、GPU、PID 存入本地状态
8. 失败时：显示 vLLM 日志中的具体错误，不写入配置

### 管理模型
- **List（列出）**：显示本地状态中的模型，可选验证 PID 是否仍在运行
- **Stop（停止）**：通过 SSH 按 PID 终止进程
- **Logs（日志）**：通过 SSH 执行 tail -f 跟踪日志文件（Ctrl+C 只停止跟踪，不会杀掉 vLLM）

### 错误处理
- **SSH 失败**：提示用户检查连接，或从配置中移除该 pod
- **状态过期**：命令因 "process not found" 失败时，自动清理本地状态
- **设置失败**：设置过程中按 Ctrl+C 会终止远程脚本并干净退出

### 测试模型
`pi prompt` 命令提供了一种快速测试已部署模型的方式：
```bash
pi prompt qwen "What is 2+2?"                    # Simple prompt
pi prompt qwen "Read file.txt and summarize"     # Uses built-in tools
```

用于 agentic 测试的内置工具：
- `ls(path, ignore?)`：列出指定路径下的文件和目录，支持可选的忽略模式
- `read(file_path, offset?, limit?)`：读取文件内容，支持可选的行偏移/行数限制
- `glob(pattern, path?)`：查找匹配 glob 模式的文件（如 "**/*.py"、"src/**/*.ts"）
- `rg(args)`：以任意参数运行 ripgrep（如 "pattern -t py -C 3"、"TODO --type-not test"）

所提供的 prompt 会自动附加当前本地工作目录的信息。文件工具要求传入绝对路径。

这样无需配置任何外部工具，即可测试基本的 agent 能力。

`prompt` 使用最新版的 NodeJS OpenAI SDK 实现。它会输出思考内容（thinking）、工具调用及其结果，以及普通的助手消息。

## 模型
我们希望专门支持下面这些模型，其他备选模型会被标记为 "possibly works"（可能可用）。该列表会定期更新、加入新模型。勾选的复选框表示「已支持」。

请查看 [models.md](./models.md)，其中列出了我们希望开箱即用支持的模型（只需一条简单的 `pi start <model-name> --name <local-name>` 命令），以及各模型的硬件要求、vLLM 参数和备注。
