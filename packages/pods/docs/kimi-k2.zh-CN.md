> 中文版译自 [kimi-k2.md](kimi-k2.md)，如与英文原文有出入，以英文原文为准。

# Kimi-K2 部署指南

> [!Note]
> 本指南仅提供 Kimi-K2 部署命令的一些示例，未必是最优配置。由于推理引擎仍在频繁更新，如需获得更好的推理性能，请持续关注各推理引擎官方主页的指引。


## vLLM 部署
要求 vLLM v0.10.0rc1 或更高版本。

在主流的 H200 或 H20 平台上，部署 Kimi-K2 FP8 权重（128k 序列长度）的最小部署单元是一个包含 16 张 GPU 的集群，可采用 Tensor Parallel（TP，张量并行）或「数据并行 + 专家并行」（DP+EP）方式。
下面给出该环境下的运行参数。你可以扩展到更多节点并增大专家并行度，以扩大推理 batch size 并提升整体吞吐量。

### Tensor Parallelism（张量并行）

当并行度 ≤ 16 时，可以采用纯 Tensor Parallelism 运行推理。示例启动命令如下：

``` bash
# start ray on node 0 and node 1

# node 0:
vllm serve $MODEL_PATH \
  --port 8000 \
  --served-model-name kimi-k2 \
  --trust-remote-code \
  --tensor-parallel-size 16 \
  --enable-auto-tool-choice \
  --tool-call-parser kimi_k2
```

**关键参数说明：**
- `--tensor-parallel-size 16`：如果使用超过 16 张 GPU，需结合流水线并行（pipeline parallelism）。
- `--enable-auto-tool-choice`：启用工具调用时必需。
- `--tool-call-parser kimi_k2`：启用工具调用时必需。

### 数据并行 + 专家并行

你可以按需安装 DeepEP、DeepGEMM 等库。然后运行以下命令（以 H200 为例）：

``` bash
# node 0
vllm serve $MODEL_PATH --port 8000 --served-model-name kimi-k2 --trust-remote-code --data-parallel-size 16 --data-parallel-size-local 8 --data-parallel-address $MASTER_IP --data-parallel-rpc-port $PORT --enable-expert-parallel --max-num-batched-tokens 8192 --max-num-seqs 256 --gpu-memory-utilization 0.85 --enable-auto-tool-choice --tool-call-parser kimi_k2

# node 1
vllm serve $MODEL_PATH --headless --data-parallel-start-rank 8 --port 8000 --served-model-name kimi-k2 --trust-remote-code --data-parallel-size 16 --data-parallel-size-local 8 --data-parallel-address $MASTER_IP --data-parallel-rpc-port $PORT --enable-expert-parallel --max-num-batched-tokens 8192 --max-num-seqs 256 --gpu-memory-utilization 0.85 --enable-auto-tool-choice --tool-call-parser kimi_k2
```

## SGLang 部署

类似地，在 SGLang 中也可以使用 TP 或 DP+EP 进行部署，示例如下。


### Tensor Parallelism（张量并行）

以下是在 H200 上以两个节点运行 TP16 的简单示例代码：

``` bash
# Node 0
python -m sglang.launch_server --model-path $MODEL_PATH --tp 16 --dist-init-addr $MASTER_IP:50000 --nnodes 2 --node-rank 0 --trust-remote-code --tool-call-parser kimi_k2

# Node 1
python -m sglang.launch_server --model-path $MODEL_PATH --tp 16 --dist-init-addr $MASTER_IP:50000 --nnodes 2 --node-rank 1 --trust-remote-code --tool-call-parser kimi_k2
```

**关键参数说明：**
- `--tool-call-parser kimi_k2`：启用工具调用时必需。

### 数据并行 + 专家并行

以下是在 SGLang 中使用 DP+EP 进行大规模 Prefill-Decode 分离部署（4P12D H200）的示例：

``` bash
# for prefill node
MC_TE_METRIC=true SGLANG_DISAGGREGATION_HEARTBEAT_INTERVAL=10000000 SGLANG_DISAGGREGATION_BOOTSTRAP_TIMEOUT=100000 SGLANG_DISAGGREGATION_WAITING_TIMEOUT=100000 PYTHONUNBUFFERED=1 \
python -m sglang.launch_server --model-path $MODEL_PATH \
--trust-remote-code --disaggregation-mode prefill --dist-init-addr $PREFILL_NODE0$:5757 --tp-size 32 --dp-size 32 --enable-dp-attention --host $LOCAL_IP --decode-log-interval 1 --disable-radix-cache --enable-deepep-moe --moe-dense-tp-size 1 --enable-dp-lm-head --disable-shared-experts-fusion --watchdog-timeout 1000000 --enable-two-batch-overlap --disaggregation-ib-device $IB_DEVICE --chunked-prefill-size 131072 --mem-fraction-static 0.85 --deepep-mode normal --ep-dispatch-algorithm dynamic --eplb-algorithm deepseek --max-running-requests 1024 --nnodes 4 --node-rank $RANK --tool-call-parser kimi_k2


# for decode node
SGLANG_DEEPEP_NUM_MAX_DISPATCH_TOKENS_PER_RANK=480 MC_TE_METRIC=true SGLANG_DISAGGREGATION_HEARTBEAT_INTERVAL=10000000 SGLANG_DISAGGREGATION_BOOTSTRAP_TIMEOUT=100000 SGLANG_DISAGGREGATION_WAITING_TIMEOUT=100000 PYTHONUNBUFFERED=1 \
python -m sglang.launch_server --model-path $MODEL_PATH --trust-remote-code --disaggregation-mode decode --dist-init-addr $DECODE_NODE0:5757 --tp-size 96 --dp-size 96 --enable-dp-attention --host $LOCAL_IP --decode-log-interval 1 --context-length 2176 --disable-radix-cache --enable-deepep-moe --moe-dense-tp-size 1 --enable-dp-lm-head --disable-shared-experts-fusion --watchdog-timeout 1000000 --enable-two-batch-overlap --disaggregation-ib-device $IB_DEVICE  --deepep-mode low_latency --mem-fraction-static 0.8 --cuda-graph-bs 480 --max-running-requests 46080 --ep-num-redundant-experts 96 --nnodes 12 --node-rank $RANK --tool-call-parser kimi_k2

# pdlb
PYTHONUNBUFFERED=1 python -m sglang.srt.disaggregation.launch_lb --prefill http://${PREFILL_NODE0}:30000 --decode http://${DECODE_NODE0}:30000
```

## KTransformers 部署

请将所有配置文件（即除 .safetensors 文件之外的全部文件）复制到 GGUF checkpoint 目录 /path/to/K2 中。然后运行：
``` bash
python ktransformers/server/main.py  --model_path /path/to/K2 --gguf_path /path/to/K2 --cache_lens 30000
```

如需启用 AMX 优化，请运行：

``` bash
python ktransformers/server/main.py  --model_path /path/to/K2 --gguf_path /path/to/K2 --cache_lens 30000 --optimize_config_path ktransformers/optimize/optimize_rules/DeepSeek-V3-Chat-fp8-linear-ggml-experts-serve-amx.yaml
```

## TensorRT-LLM 部署
### 前置条件
请参考[该指南](https://nvidia.github.io/TensorRT-LLM/installation/build-from-source-linux.html)从源码构建 TensorRT-LLM v1.0.0-rc2，并启动 TRT-LLM docker 容器。

通过以下命令安装 blobfile：
```bash
pip install blobfile
```
### 多节点服务
TensorRT-LLM 支持多节点推理。你可以使用 mpirun 以多节点任务启动 Kimi-K2。本示例使用两个节点。

#### mpirun
mpirun 要求每个节点都能免密 ssh 访问其他节点。我们需要在 docker 容器内部搭建该环境。启动容器时使用 host 网络，并将当前目录和模型目录挂载到容器中。

```bash
# use host network
IMAGE=<YOUR_IMAGE>
NAME=test_2node_docker
# host1
docker run -it --name ${NAME}_host1 --ipc=host --gpus=all --network host --privileged --ulimit memlock=-1 --ulimit stack=67108864 -v ${PWD}:/workspace -v <YOUR_MODEL_DIR>:/models/DeepSeek-V3 -w /workspace ${IMAGE}
# host2
docker run -it --name ${NAME}_host2 --ipc=host --gpus=all --network host --privileged --ulimit memlock=-1 --ulimit stack=67108864 -v ${PWD}:/workspace -v <YOUR_MODEL_DIR>:/models/DeepSeek-V3 -w /workspace ${IMAGE}
```

在容器内设置 ssh

```bash
apt-get update && apt-get install -y openssh-server

# modify /etc/ssh/sshd_config
PermitRootLogin yes
PubkeyAuthentication yes
# modify /etc/ssh/sshd_config, change default port 22 to another unused port
port 2233

# modify /etc/ssh
```

在 host1 上生成 ssh 密钥并复制到 host2，反之亦然。

```bash
# on host1
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<HOST2>
# on host2
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
ssh-copy-id -i ~/.ssh/id_ed25519.pub root@<HOST1>

# restart ssh service on host1 and host2
service ssh restart # or
/etc/init.d/ssh restart # or
systemctl restart ssh
```

为 trtllm serve 生成额外的配置。
```bash
cat >/path/to/TensorRT-LLM/extra-llm-api-config.yml <<EOF
cuda_graph_config:
  padding_enabled: true
  batch_sizes:
    - 1
    - 2
    - 4
    - 8
    - 16
    - 32
    - 64
    - 128
print_iter_log: true
enable_attention_dp: true
EOF
```


完成准备工作后，即可使用 mpirun 在两个节点上运行 trtllm-serve：

```bash
mpirun -np 16 \
-H <HOST1>:8,<HOST2>:8 \
-mca plm_rsh_args "-p 2233" \
--allow-run-as-root \
trtllm-llmapi-launch trtllm-serve serve \
--backend pytorch \
--tp_size 16 \
--ep_size 8 \
--kv_cache_free_gpu_memory_fraction 0.95 \
--trust_remote_code \
--max_batch_size 128 \
--max_num_tokens 4096 \
--extra_llm_api_options /path/to/TensorRT-LLM/extra-llm-api-config.yml \
--port 8000 \
<YOUR_MODEL_DIR>
```

## 其他

Kimi-K2 复用了 `DeepSeekV3CausalLM` 架构，并将其权重转换为合适的形状，以节省重复开发的成本。为了让推理引擎能将其与 DeepSeek-V3 区分开并应用最优优化，我们在 `config.json` 中设置了 `"model_type": "kimi_k2"`。

如果你使用的框架不在推荐列表中，仍可以通过手动将 `config.json` 中的 `model_type` 改为 "deepseek_v3" 来运行模型，作为临时解决方案。如果你的框架中没有可用的 tool call parser，你可能需要手动解析工具调用（tool call）。
