# packages/ai 项目概览（@earendil-works/pi-ai）

> 生成时间：2026-08-26 · 由 /code-annotator 流程自动生成

## 1. 项目简介

`@earendil-works/pi-ai` 是 pi monorepo 中的**底层 LLM 抽象层**：一套与厂商无关的消息 / 流式 / 工具调用协议，附带：

- **自动模型目录发现**：从 models.dev 等数据源生成 40 个 provider 的强类型模型目录
- **provider 认证解析**：API key / OAuth / 环境凭据（AWS、GCP ADC）三层
- **token 与成本核算**：含缓存读写、分层计价（tiers）
- **跨 provider 上下文接力**（handoff）：thinking / 工具调用结果跨厂商改写

README 明确：**只收录支持 tool calling 的模型**（面向 agentic 工作流）。

在 monorepo（根 `/Users/zhihu/code/m_code/ai/pi`，workspaces `packages/*`）中，编译顺序为 tui → telemetry → **ai** → agent → …，即本包是整个 agent 栈的地基，被 `agent`、`coding-agent`、`server`、`evals`、`session-backends/sqlite-node` 五个包直接依赖。

### 入口面（package.json exports）

| 入口 | 用途 |
|------|------|
| `.` | 核心：纯类型 + models + auth 基础，无副作用、可 tree-shake、浏览器可用 |
| `./compat` | 旧版全局 API 兼容层 |
| `./providers/*` | 每个 provider 一个工厂函数 |
| `./api/*` | 每条 wire protocol 一个实现（含 `.lazy` 变体） |
| `./oauth` | 仅 OAuth 类型（为 coding-agent 扩展保留） |
| `./bedrock-provider` | 显式打包 AWS SDK 用 |
| `./bun-oauth` | Bun 单文件二进制用 |
| `bin: pi-ai` | CLI 登录工具（`pi-ai login [provider]` / `list`） |

`sideEffects` 仅三个文件：`compat.js`、`images.js`、`providers/images/register-builtins.js`。

## 2. 技术栈

| 维度 | 内容 |
|------|------|
| 运行时 | Node ≥ 22.19（ESM，源码用 `.ts` 后缀 import + NodeNext）；核心兼容浏览器；支持 Bun 编译二进制 |
| 构建 | `tsgo`（`@typescript/native-preview`，TS 原生预览编译器）+ `tsconfig.build.json`；build 前先跑模型代码生成 |
| 测试 | Vitest（node 环境，30s 超时），137 个测试文件 |
| Lint | Biome（根级 `biome.json`） |
| 关键依赖 | `@anthropic-ai/sdk`、`openai`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`（Node-only）、`typebox`（工具参数 schema）、`partial-json`（流式增量解析）、`http(s)-proxy-agent`、`@earendil-works/pi-telemetry` |

## 3. 目录结构

```
packages/ai/
├── src/
│   ├── index.ts              # 根入口：仅核心、零副作用
│   ├── types.ts              # 全部核心类型（消息/流/模型/工具/compat 开关）
│   ├── models.ts             # Models/Provider 运行时 + createProvider + calculateCost
│   ├── model-catalog.ts      # flattenModelCatalog：JSON → 强类型目录
│   ├── models-store.ts       # 动态目录持久化接口（ETag/Last-Modified）
│   ├── models.generated.ts   # [生成] MODELS：40 provider 目录注册表
│   ├── compat.ts             # 旧全局 API 兼容层
│   ├── legacy-api-aliases.ts # @deprecated 旧命名（streamAnthropic 等）
│   ├── env-api-keys.ts       # provider → 环境变量映射 + AWS/Vertex 凭据探测
│   ├── oauth.ts              # 纯类型壳
│   ├── bun-oauth.ts          # Bun 二进制：静态注册 7 个 OAuth 流
│   ├── bedrock-provider.ts   # AWS SDK 显式打包的模块句柄
│   ├── cli.ts                # pi-ai login/list 命令行
│   ├── session-resources.ts  # 按 sessionId 的资源清理注册表
│   ├── image-models.ts       # 旧全局图像目录读取
│   ├── image-models.generated.ts # [生成] IMAGE_MODELS
│   ├── images-models.ts      # 新版图像集合（Models 的镜像）
│   ├── images-api-registry.ts# 图像 API 全局注册表
│   ├── images.ts             # 旧全局 generateImages() 入口（side-effect）
│   ├── api/                  # 10 条 wire protocol 实现 + 支撑模块
│   ├── auth/                 # 认证抽象 + oauth/ 子目录（7 个 OAuth 流）
│   ├── compat/               # 扩展 OAuth 遗留类型
│   ├── providers/            # ~40 个内置 provider + data/*.json（gitignored）
│   └── utils/                # 22 个小工具（event-stream/json-parse/validation/...）
├── scripts/                  # 构建期代码生成（models.dev → data/*.json）
└── test/                     # 137 个测试文件，扁平按主题命名
```

## 4. 核心模块

### 4.1 类型体系（types.ts）

- 标识：`KnownApi`（10 条协议）、`Api = KnownApi | string`、`KnownProvider`（~40 个）
- 消息模型：`Context { systemPrompt?, messages, tools? }`；`Message = UserMessage | AssistantMessage | ToolResultMessage`；内容块 `TextContent / ThinkingContent / ImageContent / ToolCall`（thinking/toolcall 带 provider 不透明 signature 供回放）
- `Usage`：cacheRead/Write、cacheWrite1h、reasoning、cost 明细
- `StopReason`：pending/stop/length/toolUse/error/aborted/deferred
- 流协议：`AssistantMessageEvent`（start/text_*/thinking_*/toolcall_*/done/error，均带 `partial` 或终态 message）
- `Tool`：TypeBox `parameters` + `constrainedSampling`（json_schema strict / grammar 变体）
- `Model<TApi>`：纯数据（id/api/provider/baseUrl/reasoning/thinkingLevelMap/cost/contextWindow/`compat` 按 API 条件类型）
- 流契约：`ProviderStreams`、`ApiOptionsMap`、`StreamOptions`/`SimpleStreamOptions`
- compat 开关：`OpenAICompletionsCompat`（30+ 开关、thinkingFormat 十余种方言）等

### 4.2 模型目录管线

```
models.dev API ──(scripts/generate-models.ts)──▶ src/providers/data/<id>.json [gitignored]
                                                      │ flattenModelCatalog()（model-catalog.ts）
                                                      ▼
                              <id>.models.ts [生成] ──▶ models.generated.ts 的 MODELS
                                                      │
                                                      ▼
                              providers/all.ts：builtinProviders()/getBuiltinModel('openai','gpt-4o-mini')
```

- **`models.ts`**：运行时集合 `Models`（`ModelsImpl`）持有 `Provider` 实例，与静态目录解耦；`refresh()` 支持动态 provider
- **`models-store.ts`**：动态目录持久化（read/write/delete + ETag freshness）

> ⚠️ **重要前置知识**：`src/providers/data/` 被 gitignore，新 clone 后必须先跑 `npm run hydrate:model-data` 才能编译。

### 4.3 API 实现层（api/）

每条 wire protocol 一个模块，职责：统一 `Context` → 该协议请求体（消息/工具/thinking 转换）→ 官方 SDK 或 fetch → 响应事件流标准化为 `AssistantMessageEvent` → 按 `Model.cost` 填 `Usage.cost`。

| 文件 | 说明 |
|------|------|
| `anthropic-messages.ts` | Anthropic Messages（含 Claude Code 工具名伪装） |
| `openai-completions.ts` | 被最多 provider 共享的一条 |
| `openai-responses.ts` + `-shared` | OpenAI Responses |
| `openai-codex-responses.ts` | SSE/WebSocket 双传输 |
| `azure-openai-responses.ts` / `google-generative-ai.ts` / `google-vertex.ts` + `google-shared` / `mistral-conversations.ts` | 各厂商 |
| `bedrock-converse-stream.ts` | Node-only，bundler-opaque import |
| `pi-messages.ts` | pi 自有协议（Radius 网关使用） |
| `constrained-sampling.ts` | strict JSON-schema / Lark-regex 语法约束 |
| `transform-messages.ts` | 跨 provider 消息改写（thinking→`<thinking>` 文本、非视觉模型图片占位） |
| `simple-options.ts` | 统一 `reasoning` level → 各 provider 参数 |
| `lazy.ts` + 11 个 `*.lazy.ts` | 惰性加载，让 SDK 落进懒 chunk |

### 4.4 认证体系（auth/）

分层设计：

- `ProviderAuth = { apiKey?: ApiKeyAuth; oauth?: OAuthAuth }` —— 每个 provider 至少声明其一
- `ApiKeyAuth`：`login`/`check`/`resolve` 三段；标准实现 `envApiKeyAuth(name, envVars)`
- `OAuthAuth`：`login`/`refresh`/`toAuth`；**refresh 在 CredentialStore.modify 锁内执行**，防并发双重刷新
- `CredentialStore`：`read/list/modify/delete`，`modify` 是唯一写路径（串行化 read-modify-write）
- `AuthContext`：可注入 env/fileExists 抽象（浏览器安全）
- `resolveProviderAuth`（resolve.ts）：**存储凭据独占 provider**——有存储凭据时不查环境变量；refresh 失败不静默回退 env

oauth/ 子目录：anthropic、openai-codex、github-copilot、openrouter、kimi-coding、xai、radius 七个流 + 共享设施（pkce/device-code/oauth-page/load）。

### 4.5 Provider 组织（providers/）

三层复用：**provider（运行时单元）→ API 实现（wire protocol）→ 官方 SDK**。

- 40 个内置 provider 按统一模板（`openrouter.ts` 是最简范例）：`createProvider({ id, name, baseUrl, auth, models, api })`
- 混合 API provider（github-copilot、opencode）传 `api` 映射表按 `model.api` dispatch
- `all.ts`：聚合 `builtinProviders()`/`builtinModels()` + 静态 typed 读函数
- 特殊：`amazon-bedrock.ts`（AWS 凭据链）、`google-vertex.ts`（ADC）、`radius.ts`（动态目录 + ModelsStore 持久化）、`faux.ts`（脚本化测试 provider）、`cloudflare-*`（租户端点占位符）

### 4.6 兼容层

- `compat.ts`：旧全局 API 完整保留（全局 api-registry + 全局 stream/complete；文件头注明随 coding-agent ModelManager 迁移后删除）
- `legacy-api-aliases.ts`：旧的每 API 命名（`streamAnthropic` 等）
- `compat/extension-oauth-types.ts`：coding-agent 扩展的遗留 OAuth 回调类型

### 4.7 图像体系（双轨）

- **旧全局面**：`image-models.generated.ts` → `image-models.ts` → `images-api-registry.ts`（全局注册表）→ `images.ts` 的 `generateImages()`
- **新集合面**：`images-models.ts` 的 `ImagesProvider`/`ImagesModels`/`createImagesModels()`——chat 侧 `Models` 的镜像（永不 reject，失败以 `stopReason: "error"` 返回）

## 5. 核心数据流：`models.stream()` 调用链

以 `models.stream(model, context, options)` 为例（`src/models.ts:667`）：

1. **同步返回流**：`stream()` 立即经 `lazyStream()` 返回 `AssistantMessageEventStream`，异步 setup 在幕后执行；setup 失败以 error 事件终止而非抛出
2. **provider 定位**：`requireProvider()` 按 `model.provider` 查 Map，未知抛 `ModelsError`
3. **auth 解析**：`applyAuth()` → `resolveProviderAuth`：CredentialStore → OAuth（modify 锁内 refresh + toAuth 派生 `ModelAuth`）或 API key（存储 key > 环境变量）；显式 `options.apiKey` 最高优先
4. **合并**：headers 按 provider auth → model.headers → options.headers → transformHeaders（大小写不敏感合并）；auth.baseUrl 覆盖 model.baseUrl
5. **provider dispatch**：`provider.stream()` 按 `apiFor(model)` 找到 `ProviderStreams`
6. **惰性加载**：provider 工厂传的是 `lazyApi(() => import("./anthropic-messages.ts"))`，首次请求才加载 SDK
7. **协议转换与发出**：消息/工具转换 → 官方 SDK（经 provider-retry 重试、代理）→ SSE 解析 → 推入事件流 → 终态 `calculateCost()` 填 usage

## 6. 构建期代码生成（scripts/）

- `generate-models.ts`（3078 行）：拉取 models.dev API 及 NVIDIA/OpenRouter/Vercel 的 /models，应用大量手工修正（定价、preview 退役、Copilot 目录窄化、thinking level 映射），生成 `data/*.json` + manifest + `<id>.models.ts` + `models.generated.ts`
- `generate-image-models.ts`：同流程生成图像目录
- `check-model-data.ts` + `model-data.ts`：构建前校验生成数据存在且未过期
- `*-reasoning-options.ts`：reasoning 元数据 → thinkingLevelMap

## 7. 测试组织（test/）

137 个测试文件，扁平单层按主题命名：provider 前缀分组（`anthropic-*`、`openai-completions-*`…）+ 横切特性（`abort`、`cache-retention`、`context-overflow`、`cross-provider-handoff`、`deferred-tools`…）。混合真实 API e2e 与 payload 回放单测。
