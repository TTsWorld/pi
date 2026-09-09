> 中文版译自 [qwen3-coder.md](qwen3-coder.md)，如与英文原文有出入，以英文原文为准。

# Qwen3-Coder 使用指南

[Qwen3-Coder](https://github.com/QwenLM/Qwen3-Coder) 是阿里云 Qwen 团队推出的先进大语言模型。vLLM 已支持 Qwen3-Coder，`tool-call` 功能在 vLLM v0.10.0 及更高版本中可用。你可以通过以下方式安装支持 `tool-call` 的 vLLM：

## 安装 vLLM

```bash
uv venv
source .venv/bin/activate
uv pip install -U vllm --torch-backend auto
```

## 使用 vLLM 启动 Qwen3-Coder

### 在 8 张 H200（或 H20）GPU 上部署（141GB × 8）

**BF16 模型**

```bash
vllm serve Qwen/Qwen3-Coder-480B-A35B-Instruct \
  --tensor-parallel-size 8 \
  --max-model-len 32000 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder
```

**FP8 模型**

```bash
VLLM_USE_DEEP_GEMM=1 vllm serve Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 \
  --max-model-len 131072 \
  --enable-expert-parallel \
  --data-parallel-size 8 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_coder
```

## 性能指标

### 评测
我们使用 vLLM 启动了 `Qwen3-Coder-480B-A35B-Instruct-FP8`，并使用 [EvalPlus](https://github.com/evalplus/evalplus) 对其性能进行了评测，结果如下：

| 数据集 | 测试类型 | Pass@1 得分 |
|-----------|-----------|--------------|
| HumanEval | 基础测试 | 0.939 |
| HumanEval+ | 基础 + 额外测试 | 0.902 |
| MBPP | 基础测试 | 0.918 |
| MBPP+ | 基础 + 额外测试 | 0.794 |

### 基准测试
我们使用以下脚本对 `Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8` 进行了基准测试

```bash
vllm bench serve \
  --backend vllm \
  --model Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 \
  --endpoint /v1/completions \
  --dataset-name random \
  --random-input 2048 \
  --random-output 1024 \
  --max-concurrency 10 \
  --num-prompt 100
```
如果成功，你将看到如下输出。

```shell
============ Serving Benchmark Result ============
Successful requests:                     100
Benchmark duration (s):                  776.49
Total input tokens:                      204169
Total generated tokens:                  102400
Request throughput (req/s):              0.13
Output token throughput (tok/s):         131.88
Total Token throughput (tok/s):          394.81
---------------Time to First Token----------------
Mean TTFT (ms):                          7639.31
Median TTFT (ms):                        6935.71
P99 TTFT (ms):                           13766.68
-----Time per Output Token (excl. 1st token)------
Mean TPOT (ms):                          68.43
Median TPOT (ms):                        67.23
P99 TPOT (ms):                           72.14
---------------Inter-token Latency----------------
Mean ITL (ms):                           68.43
Median ITL (ms):                         66.34
P99 ITL (ms):                            69.38
==================================================

```


## 使用技巧

### BF16 模型
- **上下文长度限制**：单个 H20 节点无法承载原始上下文长度（262144）。你可以调低 `max-model-len` 或调高 `gpu-memory-utilization`，以在显存限制内运行。

### FP8 模型
- **上下文长度限制**：单个 H20 节点无法承载原始上下文长度（262144）。你可以调低 `max-model-len` 或调高 `gpu-memory-utilization`，以在显存限制内运行。
- **DeepGEMM 使用**：如需使用 [DeepGEMM](https://github.com/deepseek-ai/DeepGEMM)，请设置 `VLLM_USE_DEEP_GEMM=1`，并按照[安装说明](https://github.com/vllm-project/vllm/blob/main/benchmarks/kernels/deepgemm/README.md#setup)进行安装。
- **张量并行问题**：使用 `tensor-parallel-size 8` 时，出现以下报错属于预期行为。请改用 `--data-parallel-size` 切换到数据并行模式。
- **更多资源**：如需了解更多并行组配置，请参阅 [Data Parallel Deployment 文档](https://docs.vllm.ai/en/latest/serving/data_parallel_deployment.html)。

```shell
ERROR [multiproc_executor.py:511]   File "/vllm/vllm/model_executor/models/qwen3_moe.py", line 336, in <lambda>
ERROR [multiproc_executor.py:511]     lambda prefix: Qwen3MoeDecoderLayer(config=config,
ERROR [multiproc_executor.py:511]                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ERROR [multiproc_executor.py:511]   File "/vllm/vllm/model_executor/models/qwen3_moe.py", line 278, in __init__
ERROR [multiproc_executor.py:511]     self.mlp = Qwen3MoeSparseMoeBlock(config=config,
ERROR [multiproc_executor.py:511]                ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ERROR [multiproc_executor.py:511]   File "/vllm/vllm/model_executor/models/qwen3_moe.py", line 113, in __init__
ERROR [multiproc_executor.py:511]     self.experts = FusedMoE(num_experts=config.num_experts,
ERROR [multiproc_executor.py:511]                    ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
ERROR [multiproc_executor.py:511]   File "/vllm/vllm/model_executor/layers/fused_moe/layer.py", line 773, in __init__
ERROR [multiproc_executor.py:511]     self.quant_method.create_weights(layer=self, **moe_quant_params)
ERROR [multiproc_executor.py:511]   File "/vllm/vllm/model_executor/layers/quantization/fp8.py", line 573, in create_weights
ERROR [multiproc_executor.py:511]   raise ValueError(
ERROR [multiproc_executor.py:511]   ValueError: The output_size of gate's and up's weight = 320 is not divisible by weight quantization block_n = 128.
```

### 工具调用
- **启用工具调用**：添加 `--tool-call-parser qwen3_coder` 即可启用工具调用解析功能，详情请参阅：[tool_calling](https://docs.vllm.ai/en/latest/features/tool_calling.html)

## Roadmap

- [x] 添加基准测试结果


## 补充资源

- [EvalPlus](https://github.com/evalplus/evalplus)
- [Qwen3-Coder](https://github.com/QwenLM/Qwen3-Coder)
- [vLLM 文档](https://docs.vllm.ai/)
