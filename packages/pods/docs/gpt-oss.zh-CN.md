> 中文版译自 [gpt-oss.md](gpt-oss.md)，如与英文原文有出入，以英文原文为准。

## `gpt-oss` vLLM 使用指南

`gpt-oss-20b` 和 `gpt-oss-120b` 是 OpenAI 开源的强大推理模型。
在 vLLM 中，你可以在 NVIDIA H100、H200、B200，以及 MI300x、MI325x、MI355x 和 Radeon AI PRO R9700 上运行它们。
我们正在积极推进该模型在 Ampere、Ada Lovelace 和 RTX 5090 上的支持工作。
具体而言，vLLM 针对 `gpt-oss` 系列模型做了以下优化：

* **灵活的并行选项**：模型可以在 2、4、8 张 GPU 上分片（sharding），从而提升吞吐量。
* **高性能 attention 与 MoE 内核**：attention 内核针对 attention sinks 机制和滑动窗口形状做了专门优化。
* **异步调度**：通过让 CPU 操作与 GPU 操作重叠执行，最大化利用率和吞吐量。

本文档会持续更新，欢迎贡献、纠错以及编写新的实践方案！

## 快速开始

### 安装

我们强烈建议使用一个全新的虚拟环境，因为本次发布的第一个版本需要依赖各家的前沿（cutting edge）内核，它们可能无法与其他模型兼容。具体来说，我们将安装：vLLM 预发布版、PyTorch nightly、Triton nightly、FlashInfer 预发布版、HuggingFace 预发布版、Harmony 以及 gpt-oss 库工具。

```
uv venv
source .venv/bin/activate

uv pip install --pre vllm==0.10.1+gptoss \
    --extra-index-url https://wheels.vllm.ai/gpt-oss/ \
    --extra-index-url https://download.pytorch.org/whl/nightly/cu128 \
    --index-strategy unsafe-best-match
```

我们还提供了一个内置全部依赖的 docker 容器

```
docker run --gpus all \
    -p 8000:8000 \
    --ipc=host \
    vllm/vllm-openai:gptoss \
    --model openai/gpt-oss-20b
```

### H100 与 H200

你可以使用默认参数来提供模型服务：

* 可以启用 `--async-scheduling` 以获得更高性能。目前它与结构化输出（structured output）不兼容。
* 对于 H100 和 H200，我们推荐 TP=2，这是性能上的最佳平衡点。

```
# openai/gpt-oss-20b should run in single GPU
vllm serve openai/gpt-oss-20b --async-scheduling

# gpt-oss-120b will fit in a single H100/H200, but scaling it to higher TP sizes can help with throughput
vllm serve openai/gpt-oss-120b --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 2 --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 4 --async-scheduling
```

### B200

NVIDIA Blackwell 需要安装 FlashInfer 库并设置若干环境变量才能启用所需的内核。我们推荐以 TP=1 作为起点来获得不错的性能。我们正在积极优化 vLLM 在 Blackwell 上的性能。

```
# All 3 of these are required
export VLLM_USE_TRTLLM_ATTENTION=1
export VLLM_USE_TRTLLM_DECODE_ATTENTION=1
export VLLM_USE_TRTLLM_CONTEXT_ATTENTION=1

# Pick only one out of the two.
# mxfp8 activation for MoE. faster, but higher risk for accuracy.
export VLLM_USE_FLASHINFER_MXFP4_MOE=1
# bf16 activation for MoE. matching reference precision.
export VLLM_USE_FLASHINFER_MXFP4_BF16_MOE=1

# openai/gpt-oss-20b
vllm serve openai/gpt-oss-20b --async-scheduling

# gpt-oss-120b
vllm serve openai/gpt-oss-120b --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 2 --async-scheduling
vllm serve openai/gpt-oss-120b --tensor-parallel-size 4 --async-scheduling
```

### AMD

ROCm 在发布首日即支持在这 3 种不同 GPU 上运行 OpenAI gpt-oss-120b 或 gpt-oss-20b 模型，并同时提供预构建的 docker 容器：

* gfx950：MI350x 系列，`rocm/vllm-dev:open-mi355-08052025`
* gfx942：MI300x/MI325 系列，`rocm/vllm-dev:open-mi300-08052025`
* gfx1201：Radeon AI PRO R9700，`rocm/vllm-dev:open-r9700-08052025`

运行容器：

```
alias drun='sudo docker run -it --network=host --device=/dev/kfd --device=/dev/dri --group-add=video --ipc=host --cap-add=SYS_PTRACE --security-opt seccomp=unconfined --shm-size 32G -v /data:/data -v $HOME:/myhome -w /myhome'

drun rocm/vllm-dev:open-mi300-08052025
```

针对 MI300x 和 R9700：

```
export VLLM_ROCM_USE_AITER=1
export VLLM_USE_AITER_UNIFIED_ATTENTION=1
export VLLM_ROCM_USE_AITER_MHA=0

vllm serve openai/gpt-oss-120b --compilation-config '{"full_cuda_graph": true}'
```

针对 MI355x：

```
# MoE preshuffle, fusion and Triton GEMM flags
export VLLM_USE_AITER_TRITON_FUSED_SPLIT_QKV_ROPE=1
export VLLM_USE_AITER_TRITON_FUSED_ADD_RMSNORM_PAD=1
export VLLM_USE_AITER_TRITON_GEMM=1
export VLLM_ROCM_USE_AITER=1
export VLLM_USE_AITER_UNIFIED_ATTENTION=1
export VLLM_ROCM_USE_AITER_MHA=0
export TRITON_HIP_PRESHUFFLE_SCALES=1

vllm serve openai/gpt-oss-120b --compilation-config '{"compile_sizes": [1, 2, 4, 8, 16, 24, 32, 64, 128, 256, 4096, 8192], "full_cuda_graph": true}' --block-size 64
```

## 使用方法

一旦 `vllm serve` 运行起来并且显示了 `INFO: Application startup complete`，你就可以通过 HTTP 请求或 OpenAI SDK 向以下端点发送请求：

* `/v1/responses` 端点可以在思维链（chain-of-thought）之间执行工具调用（浏览、python、mcp）并给出最终响应。该端点使用 `openai-harmony` 库来进行输入渲染和输出解析。有状态操作和完整的流式 API 正在开发中。OpenAI 推荐使用 Responses API 与该模型交互。
* `/v1/chat/completions` 端点为该模型提供了一个大家熟悉的接口。它不会真正调用工具，但会以结构化方式返回 reasoning 和最终文本输出。Function calling 正在开发中。你还可以在请求参数中设置 `include_reasoning: false`，以在输出中跳过 CoT。
* `/v1/completions` 端点提供简单的输入输出接口，不做任何模板渲染。

所有端点都接受 `stream: true` 参数以启用增量 token 流式输出。请注意，vLLM 目前尚未覆盖 Responses API 的全部范围，更多细节请参见下文的「已知限制」一节。

### 工具使用（Tool Use）

gpt-oss 的一项首要特性是能够直接调用工具，即所谓的「内置工具（built-in tools）」。在 vLLM 中，我们提供以下几种选择：

* 默认情况下，我们集成了参考实现库的浏览器（使用 `ExaBackend`）以及通过 docker 容器提供的演示用 Python 解释器。要使用搜索后端，你需要获取 [exa.ai](http://exa.ai) 的访问权限，并将 `EXA_API_KEY=` 设置为环境变量。至于 Python，要么保证 docker 可用，要么设置 `PYTHON_EXECUTION_BACKEND=UV`，以（有风险地）允许模型生成的代码片段在同一台机器上执行。

```
uv pip install gpt-oss

vllm serve ... --tool-server demo
```

* 请注意，默认选项仅用于演示目的。在生产环境中，vLLM 本身可以作为 MCP 客户端连接多个服务。
下面是一个 vLLM 可以配合使用的[示例工具服务器](https://github.com/openai/gpt-oss/tree/main/gpt-oss-mcp-server)，它们封装了演示工具：

```
mcp run -t sse browser_server.py:mcp
mcp run -t sse python_server.py:mcp

vllm serve ... --tool-server ip-1:port-1,ip-2:port-2
```

这些 URL 应当是 MCP SSE 服务器，需在服务器信息中实现 `instructions` 字段，并提供文档完善的工具。这些工具会被注入到系统提示词（system prompt）中，使模型能够使用它们。

## 精度评测（Accuracy Evaluation Panels）

OpenAI 推荐使用 gpt-oss 参考实现库来执行评测。例如：

```
python -m gpt_oss.evals --model 120b-low --eval gpqa --n-threads 128
python -m gpt_oss.evals --model 120b --eval gpqa --n-threads 128
python -m gpt_oss.evals --model 120b-high --eval gpqa --n-threads 128
```
要在 AIME2025 上评测，把 `gpqa` 换成 `aime25` 即可。
基于 vLLM 部署后：

```
# Example deployment on 8xH100
vllm serve openai/gpt-oss-120b \
  --tensor_parallel_size 8 \
  --max-model-len 131072 \
  --max-num-batched-tokens 10240 \
  --max-num-seqs 128 \
  --gpu-memory-utilization 0.85 \
  --no-enable-prefix-caching
```

以下是我们在不使用工具的情况下能够复现的分数，我们也鼓励你尝试复现！
我们观察到不同运行之间的数值可能会有轻微波动，因此不妨多跑几次评测来了解方差情况。
若要做快速的正确性检查，我们建议从低 reasoning effort 设置（120b-low）开始，它应该在几分钟内即可完成。

模型：120B

| Reasoning Effort | GPQA | AIME25 |
| :---- | :---- | :---- |
| Low  | 65.3 | 51.2 |
| Mid  | 72.4 | 79.6 |
| High  | 79.4 | 93.0 |

模型：20B

| Reasoning Effort | GPQA | AIME25 |
| :---- | :---- | :---- |
| Low  | 56.8 | 38.8 |
| Mid  | 67.5 | 75.0 |
| High  | 70.9 | 85.8  |

## 已知限制

* 在 H100 上使用 tensor parallel size 1、默认 GPU 显存利用率和默认 batched token 会导致 CUDA 显存溢出（Out-of-memory）。运行 tp1 时，请提高 GPU 显存利用率或降低 batched token

```
vllm serve openai/gpt-oss-120b --gpu-memory-utilization 0.95 --max-num-batched-tokens 1024
```

* 在 H100 上运行 TP2 时，请将 GPU 显存利用率设置在 0.95 以下，否则同样会导致 OOM
* Responses API 目前存在若干限制；我们非常欢迎对 vLLM 中该服务的贡献与维护
* 用量统计（usage accounting）目前有问题，只会返回全零。
* 不支持 Annotations（引用搜索结果中的 URL）。
* 通过 `max_tokens` 截断时，可能无法保留已完成的部分分块（partial chunks）。
* 流式输出目前还相当简陋，例如：
  * Item id 和索引还需要完善
  * 工具调用及其输出无法正确流式返回，而是按批次（batched）返回。
  * 缺少完善的错误处理。

## 故障排查

- Blackwell 上出现 attention sink dtype 错误：

```
  ERROR 08-05 07:31:10 [multiproc_executor.py:559]     assert sinks.dtype == torch.float32, "Sinks must be of type float32"
  **(VllmWorker TP0 pid=174579)** ERROR 08-05 07:31:10 [multiproc_executor.py:559]            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  **(VllmWorker TP0 pid=174579)** ERROR 08-05 07:31:10 [multiproc_executor.py:559] AssertionError: Sinks must be of type float32
```

**解决方案：请参考 Blackwell 一节，检查相关环境变量是否已添加。**

- 与 `tl.language` 未定义相关的 Triton 问题：

**解决方案：确保你的环境中没有安装其他 triton（如 pytorch-triton 等）。**
