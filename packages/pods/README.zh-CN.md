> 中文版译自 [README.md](README.md)，如与英文原文有出入，以英文原文为准。

# pi

在 GPU Pod 上部署和管理 LLM，并为 agentic（智能体）工作负载自动配置 vLLM。

## 安装

```bash
npm install -g @mariozechner/pi
```

## pi 是什么？

`pi` 简化了在远程 GPU Pod 上运行大语言模型的工作。它会自动：
- 在全新的 Ubuntu Pod 上安装配置 vLLM
- 为 agentic 模型（Qwen、GPT-OSS、GLM 等）配置工具调用（tool calling）
- 通过"智能" GPU 分配，在同一 Pod 上管理多个模型
- 为每个模型提供 OpenAI 兼容的 API 端点
- 内置一个带文件系统工具的交互式 agent，可用于测试

## 快速开始

```bash
# 设置必需的环境变量
export HF_TOKEN=your_huggingface_token      # 从 https://huggingface.co/settings/tokens 获取
export PI_API_KEY=your_api_key              # 用于 API 鉴权的任意字符串

# 配置一个 DataCrunch Pod 并挂载 NFS 存储（自动提取模型路径）
pi pods setup dc1 "ssh root@1.2.3.4" \
  --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-02.datacrunch.io:/your-pseudo /mnt/hf-models"

# 启动一个模型（已知模型自动配置）
pi start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen

# 向模型发送单条消息
pi agent qwen "What is the Fibonacci sequence?"

# 带文件系统工具的交互式聊天模式
pi agent qwen -i

# 搭配任何 OpenAI 兼容客户端使用
export OPENAI_BASE_URL='http://1.2.3.4:8001/v1'
export OPENAI_API_KEY=$PI_API_KEY
```

## 前置条件

- Node.js 18+
- HuggingFace token（用于下载模型）
- 满足以下条件的 GPU Pod：
  - Ubuntu 22.04 或 24.04
  - SSH root 访问权限
  - 已安装 NVIDIA 驱动
  - 用于存放模型的持久化存储

## 支持的提供商

### 主要支持

**DataCrunch** - 最适合共享模型存储
- NFS 卷可在同一区域内的多个 Pod 之间共享
- 模型只需下载一次，处处可用
- 非常适合团队协作或并行开展多项实验

**RunPod** - 持久化存储良好
- 网络卷独立持久化
- 无法在多个运行中的 Pod 之间同时共享
- 适合单 Pod 工作流

### 也可配合使用
- Vast.ai（卷锁定到特定机器）
- Prime Intellect（无持久化存储）
- AWS EC2（需自行配置 EFS）
- 任何配备 NVIDIA GPU、CUDA 驱动和 SSH 的 Ubuntu 机器

## 命令

### Pod 管理

```bash
pi pods setup <name> "<ssh>" [options]        # 配置新 Pod
  --mount "<mount_command>"                   # 配置期间执行挂载命令
  --models-path <path>                        # 覆盖自动提取的路径（可选）
  --vllm release|nightly|gpt-oss              # vLLM 版本（默认：release）

pi pods                                       # 列出所有已配置的 Pod
pi pods active <name>                         # 切换活跃 Pod
pi pods remove <name>                         # 从本地配置中移除 Pod
pi shell [<name>]                             # 通过 SSH 进入 Pod
pi ssh [<name>] "<command>"                   # 在 Pod 上执行命令
```

**注意**：使用 `--mount` 时，模型路径会自动从挂载命令的目标目录中提取。只有在不用 `--mount` 或需要覆盖提取出的路径时，才需要 `--models-path`。

#### vLLM 版本选项

- `release`（默认）：稳定的 vLLM 发行版，推荐大多数用户使用
- `nightly`：包含 vLLM 最新特性，运行 GLM-4.5 等最新模型时需要
- `gpt-oss`：仅适用于 OpenAI GPT-OSS 模型的特殊构建版本

### 模型管理

```bash
pi start <model> --name <name> [options]  # 启动一个模型
  --memory <percent>      # GPU 显存：30%、50%、90%（默认：90%）
  --context <size>        # 上下文窗口：4k, 8k, 16k, 32k, 64k, 128k
  --gpus <count>          # 使用的 GPU 数量（仅限预定义模型）
  --pod <name>            # 指定目标 Pod（覆盖活跃 Pod）
  --vllm <args...>        # 直接向 vLLM 传递自定义参数

pi stop [<name>]          # 停止模型（不指定名称则停止全部）
pi list                   # 列出运行中的模型及其状态
pi logs <name>            # 流式查看模型日志（tail -f）
```

### Agent 与聊天界面

```bash
pi agent <name> "<message>"               # 向模型发送单条消息
pi agent <name> "<msg1>" "<msg2>"         # 按顺序发送多条消息
pi agent <name> -i                        # 交互式聊天模式
pi agent <name> -i -c                     # 继续上一个会话

# 独立的 OpenAI 兼容 agent（可搭配任何 API 使用）
pi-agent --base-url http://localhost:8000/v1 --model llama-3.1 "Hello"
pi-agent --api-key sk-... "What is 2+2?"  # 默认使用 OpenAI
pi-agent --json "What is 2+2?"            # 以 JSONL 输出事件流
pi-agent -i                                # 交互模式
```

该 agent 内置文件操作工具（read、list、bash、glob、rg），用于测试 agentic 能力，尤其适合代码导航与分析任务。

## 预定义模型配置

`pi` 为热门 agentic 模型内置了预定义配置，无需手动指定 `--vllm` 参数。`pi` 还会检查你选择的模型在 GPU 数量和可用 VRAM 方面是否真的能在你的 Pod 上运行。直接运行不带额外参数的 `pi start`，即可查看当前活跃 Pod 上可运行的预定义模型列表。

### Qwen 模型
```bash
# Qwen2.5-Coder-32B - 优秀的编程模型，可装入单张 H100/H200
pi start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen

# Qwen3-Coder-30B - 具备工具调用能力的高级推理模型
pi start Qwen/Qwen3-Coder-30B-A3B-Instruct --name qwen3

# Qwen3-Coder-480B - 在 8xH200 上达到业界领先水平（数据并行模式）
pi start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen-480b
```

### GPT-OSS 模型
```bash
# 配置时需要特殊的 vLLM 构建版本
pi pods setup gpt-pod "ssh root@1.2.3.4" --models-path /workspace --vllm gpt-oss

# GPT-OSS-20B - 16GB+ 显存即可运行
pi start openai/gpt-oss-20b --name gpt20

# GPT-OSS-120B - 需要 60GB+ 显存
pi start openai/gpt-oss-120b --name gpt120
```

### GLM 模型
```bash
# GLM-4.5 - 需要 8-16 张 GPU，支持思考模式
pi start zai-org/GLM-4.5 --name glm

# GLM-4.5-Air - 较小的版本，1-2 张 GPU
pi start zai-org/GLM-4.5-Air --name glm-air
```

### 使用 --vllm 的自定义模型

对于不在预定义列表中的模型，可使用 `--vllm` 直接向 vLLM 传参：

```bash
# 使用自定义设置运行 DeepSeek
pi start deepseek-ai/DeepSeek-V3 --name deepseek --vllm \
  --tensor-parallel-size 4 --trust-remote-code

# 使用流水线并行的 Mistral
pi start mistralai/Mixtral-8x22B-Instruct-v0.1 --name mixtral --vllm \
  --tensor-parallel-size 8 --pipeline-parallel-size 2

# 为任意模型指定特定的工具解析器
pi start some/model --name mymodel --vllm \
  --tool-call-parser hermes --enable-auto-tool-choice
```

## DataCrunch 配置

DataCrunch 通过跨 Pod 共享的 NFS 存储提供最佳体验：

### 1. 创建共享文件系统（SFS）
- 进入 DataCrunch 控制台 → Storage → Create SFS
- 选择容量和数据中心
- 记下挂载命令（例如 `sudo mount -t nfs -o nconnect=16 nfs.fin-02.datacrunch.io:/hf-models-fin02-8ac1bab7 /mnt/hf-models-fin02`）

### 2. 创建 GPU 实例
- 在与 SFS 相同的数据中心创建实例
- 将该 SFS 共享给实例
- 从控制台获取 SSH 命令

### 3. 使用 pi 配置
```bash
# 从 DataCrunch 控制台获取挂载命令
pi pods setup dc1 "ssh root@instance.datacrunch.io" \
  --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-02.datacrunch.io:/your-pseudo /mnt/hf-models"

# 模型自动存储在 /mnt/hf-models（从挂载命令中提取）
```

### 4. 优势
- 模型在实例重启后依然保留
- 可在同一数据中心的多个实例间共享模型
- 一次下载，处处可用
- 下载期间只需为存储付费，无需支付计算时长费用

## RunPod 配置

RunPod 通过网络卷提供良好的持久化存储：

### 1. 创建网络卷（可选）
- 进入 RunPod 控制台 → Storage → Create Network Volume
- 选择容量和区域

### 2. 创建 GPU Pod
- 创建 Pod 时选择"Network Volume"（如果使用）
- 将卷挂载到 `/runpod-volume`
- 从 Pod 详情页获取 SSH 命令

### 3. 使用 pi 配置
```bash
# 使用网络卷
pi pods setup runpod "ssh root@pod.runpod.io" --models-path /runpod-volume

# 或者使用 workspace（随 Pod 持久化，但不可共享）
pi pods setup runpod "ssh root@pod.runpod.io" --models-path /workspace
```


## 多 GPU 支持

### 自动 GPU 分配
运行多个模型时，pi 会自动将它们分配到不同的 GPU：
```bash
pi start model1 --name m1  # 自动分配到 GPU 0
pi start model2 --name m2  # 自动分配到 GPU 1
pi start model3 --name m3  # 自动分配到 GPU 2
```

### 为预定义模型指定 GPU 数量
对于拥有多种配置的预定义模型，可使用 `--gpus` 控制 GPU 用量：
```bash
# 让 Qwen 只使用 1 张 GPU，而不是所有可用 GPU
pi start Qwen/Qwen2.5-Coder-32B-Instruct --name qwen --gpus 1

# 让 GLM-4.5 使用 8 张 GPU（前提是有 8-GPU 配置）
pi start zai-org/GLM-4.5 --name glm --gpus 8
```

如果模型没有所请求 GPU 数量的对应配置，你会看到可用选项列表。

### 大模型的张量并行
对于无法装入单张 GPU 的模型：
```bash
# 使用所有可用 GPU
pi start meta-llama/Llama-3.1-70B-Instruct --name llama70b --vllm \
  --tensor-parallel-size 4

# 指定 GPU 数量
pi start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen480 --vllm \
  --data-parallel-size 8 --enable-expert-parallel
```

## API 集成

所有模型都暴露 OpenAI 兼容端点：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://your-pod-ip:8001/v1",
    api_key="your-pi-api-key"
)

# 带工具调用的聊天补全
response = client.chat.completions.create(
    model="Qwen/Qwen2.5-Coder-32B-Instruct",
    messages=[
        {"role": "user", "content": "Write a Python function to calculate fibonacci"}
    ],
    tools=[{
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Execute Python code",
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string"}
                },
                "required": ["code"]
            }
        }
    }],
    tool_choice="auto"
)
```

## 独立 Agent CLI

`pi` 内含一个独立的 OpenAI 兼容 agent，可搭配任何 API 使用：

```bash
# 全局安装以获得 pi-agent 命令
npm install -g @mariozechner/pi

# 搭配 OpenAI 使用
pi-agent --api-key sk-... "What is machine learning?"

# 搭配本地 vLLM 使用
pi-agent --base-url http://localhost:8000/v1 \
         --model meta-llama/Llama-3.1-8B-Instruct \
         --api-key dummy \
         "Explain quantum computing"

# 交互模式
pi-agent -i

# 继续上一个会话
pi-agent --continue "Follow up question"

# 自定义系统提示词
pi-agent --system-prompt "You are a Python expert" "Write a web scraper"

# 使用 responses API（用于 GPT-OSS 模型）
pi-agent --api responses --model openai/gpt-oss-20b "Hello"
```

该 agent 支持：
- 跨对话的会话持久化
- 带语法高亮的交互式 TUI 模式
- 用于代码导航的文件系统工具（read、list、bash、glob、rg）
- 同时支持 Chat Completions 和 Responses 两种 API 格式
- 自定义系统提示词

## 工具调用支持

`pi` 会自动为已知模型配置合适的工具调用解析器：

- **Qwen 模型**：`hermes` 解析器（Qwen3-Coder 使用 `qwen3_coder`）
- **GLM 模型**：`glm4_moe` 解析器，支持推理（reasoning）
- **GPT-OSS 模型**：使用 `/v1/responses` 端点，因为工具调用（OpenAI 术语中的 function calling）目前在 [`v1/chat/completions` 端点上仍是 WIP（开发中）](https://docs.vllm.ai/projects/recipes/en/latest/OpenAI/GPT-OSS.html#tool-use)
- **自定义模型**：通过 `--vllm --tool-call-parser <parser> --enable-auto-tool-choice` 指定

禁用工具调用：
```bash
pi start model --name mymodel --vllm --disable-tool-call-parser
```

## 显存与上下文管理

### GPU 显存分配
控制 vLLM 预分配多少 GPU 显存：
- `--memory 30%`：高并发，上下文受限
- `--memory 50%`：均衡（默认）
- `--memory 90%`：最大上下文，低并发

### 上下文窗口
设置最大的输入 + 输出 token 数：
- `--context 4k`：总计 4,096 tokens
- `--context 32k`：总计 32,768 tokens
- `--context 128k`：总计 131,072 tokens

面向编程工作负载的示例：
```bash
# 大上下文用于代码分析，中等并发
pi start Qwen/Qwen2.5-Coder-32B-Instruct --name coder \
  --context 64k --memory 70%
```

**注意**：使用 `--vllm` 时，`--memory`、`--context` 和 `--gpus` 参数会被忽略。同时使用时会看到警告。

## 会话持久化

交互式 agent 模式（`-i`）会按项目目录保存会话：

```bash
# 开始新会话
pi agent qwen -i

# 继续上一个会话（保留聊天历史）
pi agent qwen -i -c
```

会话存储在 `~/.pi/sessions/` 中，按项目路径组织，包含：
- 完整的对话历史
- 工具调用结果
- token 用量统计

## 架构与事件系统

该 agent 采用统一的事件驱动架构，所有交互都经由 `AgentEvent` 类型流转。由此实现：
- 控制台与 TUI 模式下一致的 UI 渲染
- 会话录制与回放
- API 调用与 UI 更新的清晰分离
- 面向程序化集成的 JSON 输出模式

事件会根据模型类型自动转换为相应的 API 格式（Chat Completions 或 Responses）。

### JSON 输出模式

使用 `--json` 标志可将事件流以 JSONL（JSON Lines）输出，便于程序化消费：
```bash
pi-agent --api-key sk-... --json "What is 2+2?"
```

每行都是一个完整的 JSON 对象，代表一个事件：
```jsonl
{"type":"user_message","text":"What is 2+2?"}
{"type":"assistant_start"}
{"type":"assistant_message","text":"2 + 2 = 4"}
{"type":"token_usage","inputTokens":10,"outputTokens":5,"totalTokens":15,"cacheReadTokens":0,"cacheWriteTokens":0}
```

## 故障排查

### OOM（显存不足）错误
- 降低 `--memory` 百分比
- 改用更小的模型或量化版本（FP8）
- 减小 `--context`

### 模型无法启动
```bash
# 检查 GPU 使用情况
pi ssh "nvidia-smi"

# 检查端口是否被占用
pi list

# 强制停止所有模型
pi stop
```

### 工具调用问题
- 并非所有模型都能可靠地支持工具调用
- 尝试换用其他解析器：`--vllm --tool-call-parser mistral`
- 或直接禁用：`--vllm --disable-tool-call-parser`

### 模型访问被拒绝
部分模型（Llama、Mistral）需要先在 HuggingFace 上获得访问授权。请前往模型页面点击"Request access"。

### vLLM 构建问题
如果使用 `--vllm nightly` 失败，可以尝试：
- 使用 `--vllm release` 获得稳定版本
- 用 `pi ssh "nvidia-smi"` 检查 CUDA 兼容性

### Agent 未识别到消息
如果 agent 显示的是配置信息而不是你的消息，请确保为包含特殊字符的消息加上引号：
```bash
# 正确
pi agent qwen "What is this file about?"

# 错误（shell 可能解释其中的特殊字符）
pi agent qwen What is this file about?
```

## 高级用法

### 使用多个 Pod
```bash
# 任何命令都可以覆盖活跃 Pod
pi start model --name test --pod dev-pod
pi list --pod prod-pod
pi stop test --pod dev-pod
```

### 自定义 vLLM 参数
```bash
# 在 --vllm 之后可以传递任意 vLLM 参数
pi start model --name custom --vllm \
  --quantization awq \
  --enable-prefix-caching \
  --max-num-seqs 256 \
  --gpu-memory-utilization 0.95
```

### 监控
```bash
# 监视 GPU 利用率
pi ssh "watch -n 1 nvidia-smi"

# 检查模型下载进度
pi ssh "du -sh ~/.cache/huggingface/hub/*"

# 查看所有日志
pi ssh "ls -la ~/.vllm_logs/"

# 查看 agent 会话历史
ls -la ~/.pi/sessions/
```

## 环境变量

- `HF_TOKEN` - 用于下载模型的 HuggingFace token
- `PI_API_KEY` - vLLM 端点的 API 密钥
- `PI_CONFIG_DIR` - 配置目录（默认：`~/.pi`）
- `OPENAI_API_KEY` - 未提供 `--api-key` 时 `pi-agent` 使用

## 许可证

MIT
