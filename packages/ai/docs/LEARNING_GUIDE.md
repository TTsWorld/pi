# packages/ai 学习指南

> 生成时间：2026-08-26 · 配套阅读：[PROJECT_OVERVIEW.md](./PROJECT_OVERVIEW.md)

## 前置准备

1. **先读 `README.md`**——该包文档极其完备（模型目录、auth 解析、事件表、compat 迁移表），先建立概念框架
2. **必须 hydrate 数据才能编译**：`src/providers/data/` 是 gitignored 的生成物，新 clone 后先在仓库根目录跑 `npm run hydrate:model-data`，否则 `models.generated.ts` 引用的 JSON 不存在、编译不过

## 推荐学习顺序（12 步）

### 第一阶段：词汇表（理解协议）

**1. `src/types.ts`（857 行）**
全部核心词汇：`Context` / `Message` / `AssistantMessageEvent` / `Model` / `ProviderStreams` / `ApiOptionsMap`。只读类型就能理解整个协议。**不必逐字读完**，重点读消息模型与流协议两节，其余当字典查。

**2. `src/utils/event-stream.ts`（88 行）**
流原语：`AssistantMessageEventStream` 可 `for await` 消费、也可 `result()` 拿终态。这是全包「流 + 结果」双消费模型的基础，短小但关键。

### 第二阶段：核心运行时

**3. `src/models.ts`（944 行）**
`Provider` / `Models`（`ModelsImpl`）/ `createProvider` / `calculateCost`。重点两处：`applyAuth`（models.ts:636）与 `createProvider` 的 api dispatch（models.ts:762）。

**4. `src/auth/types.ts` → `src/auth/resolve.ts` → `src/auth/helpers.ts`**
认证模型三件套。核心思想：**存储凭据独占 provider**（有存储凭据就不查环境变量）；OAuth 的 `refresh` 在 `CredentialStore.modify` 锁内执行，防多进程双重刷新。

### 第三阶段：模型目录如何变成强类型

**5. 一条最简 provider 全链（5 个小文件）**
```
providers/openrouter.ts        # 最简 provider 范例：createProvider({...})
  → providers/openrouter.models.ts   # [生成] OPENROUTER_MODELS
    → model-catalog.ts          # flattenModelCatalog：JSON key → 字面量类型
      → models.generated.ts     # [生成] MODELS 注册表
        → providers/all.ts      # builtinProviders() / getBuiltinModel('openai','gpt-4o-mini')
```
读完这条链就理解「models.dev 数据 → 强类型目录」的完整魔法。

### 第四阶段：一条 API 实现的解剖

**6. `src/api/anthropic-messages.ts`（1391 行）或 `src/api/openai-completions.ts`（1695 行）**
挑一条读透：统一 Context → 协议请求体 → 官方 SDK → SSE → 标准化事件流 → calculateCost。`openai-completions` 被最多 provider 共享，通用性最强。

**7. 支撑模块三件**：`simple-options.ts`（统一 reasoning level）、`transform-messages.ts`（跨 provider 改写：thinking→文本、非视觉模型图片占位）、`constrained-sampling.ts`（JSON-schema / grammar 约束采样）

### 第五阶段：工程化技巧

**8. 惰性加载体系**
`api/lazy.ts` + 任一 `.lazy.ts` + `auth/oauth/load.ts` + `bedrock-converse-stream.lazy.ts`。理解三重约束下的 import 技巧：tree-shake（浏览器）、Node-only 模块隔离（AWS SDK）、Bun 单文件打包。注意「bundler-opaque import」（用变量做 specifier 骗过打包器的静态分析）。

**9. 特殊 provider 四例**
- `providers/amazon-bedrock.ts`——AWS 环境凭据链
- `providers/google-vertex.ts`——API key / ADC 登录
- `providers/radius.ts`——动态目录 + ModelsStore 持久化（动态 provider 范例）
- `providers/faux.ts`——脚本化测试替身（写测试时必用）

### 第六阶段：外围

**10. 图像面（双轨对照）**：新轨 `images-models.ts`（`ImagesModels`，chat 侧镜像）；旧轨 `image-models.ts` → `images-api-registry.ts` → `images.ts`

**11. 兼容层**：`compat.ts` + `legacy-api-aliases.ts` + `env-api-keys.ts`——读旧代码库（如 coding-agent 的 ModelManager）时会遇到

**12. 代码生成**：`scripts/generate-models.ts`（3078 行）——models.dev → `data/*.json` → `.models.ts` 的流水线，理解模型数据如何维护

## 关键概念速查

| 概念 | 一句话解释 | 定义处 |
|------|-----------|--------|
| API vs Provider | API = wire protocol（10 条）；Provider = 厂商运行时单元（目录+auth+stream），多个 provider 共享一条 API | `types.ts` |
| `AssistantMessageEvent` | 标准化流事件（text_delta/thinking_delta/toolcall_delta/...），带 `partial` 或终态 message | `types.ts` |
| thinking signature | provider 不透明签名，回放 thinking 块时原样传回（防缓存失效） | `types.ts` |
| `KnownApi` | 10 条协议：openai-completions/-responses、azure-、codex-、anthropic-messages、bedrock-converse-stream、google-generative-ai、google-vertex、mistral-conversations、pi-messages | `types.ts` |
| 存储凭据独占 | 有 CredentialStore 凭据时不查环境变量；refresh 失败不静默回退 env | `auth/resolve.ts:50` |
| modify 锁 | CredentialStore.modify 是唯一写路径，串行化 read-modify-write | `auth/credential-store.ts` |
| lazyApi / lazyStream | 动态 import 包装：同步返回流、异步加载实现，SDK 落懒 chunk | `api/lazy.ts` |
| bundler-opaque import | import specifier 用变量，避免打包器把 Node-only 依赖打进浏览器 bundle | `bedrock-converse-stream.lazy.ts` |
| `flattenModelCatalog` | 把「按 API 分组」的 JSON 摊平成带字面量类型的目录 | `model-catalog.ts` |
| `<authenticated>` 哨兵 | env-api-keys 对 AWS/GCP 环境凭据的标记值，表示「已通过环境认证，无明文 key」 | `env-api-keys.ts` |
| thinkingLevelMap | reasoning 元数据 → 各档位（low/medium/high）的 max_tokens 映射 | scripts/*-reasoning-options.ts |
| handoff / transform-messages | 跨 provider 上下文接力：thinking→文本、图片占位符等改写 | `api/transform-messages.ts` |

## 常见困惑

- **为什么 `import "./foo.ts"` 带后缀？** NodeNext ESM 风格，tsgo 直接跑源码
- **为什么 `models.generated.ts` 里 import 的 JSON 不存在？** `data/` 是 gitignored 生成物，先 `npm run hydrate:model-data`
- **`stream()` 为什么不抛异常？** 它同步返回流，异步 setup 失败转成流上的 error 事件
- **`.lazy.ts` 和本体什么关系？** provider 工厂引用 lazy 包装，首次请求才 dynamic import 本体（大文件 + SDK 依赖）

## 与本 monorepo 其他包的关系

```
tui → telemetry → ai（本包）→ agent → coding-agent / server / evals / session-backends
```

本包被 `agent`、`coding-agent`、`server`、`evals`、`session-backends/sqlite-node` 直接依赖；`packages/agent/docs/` 下已有一份该包消费者的注释文档可对照阅读。
