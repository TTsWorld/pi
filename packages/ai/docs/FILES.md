# 源代码文件清单

> 扫描时间：2026-08-26
> 范围：`packages/ai`（src/、scripts/）
> 排除规则：测试、配置、文档、资源、自动生成产物

## 排除说明（共 45 个，不参与注释）

| 类别 | 文件 | 原因 |
|------|------|------|
| 自动生成 | `src/models.generated.ts`、`src/image-models.generated.ts` | 文件头标注 auto-generated，`npm run generate-models` 会覆盖 |
| 自动生成 | `src/providers/*.models.ts`（39 个） | 同上，由 `scripts/generate-models.ts` 生成 |
| 构建转发 | 根目录 `bedrock-provider.js` / `bedrock-provider.d.ts` | 1 行 dist 转发 shim，无可注释内容 |
| 配置 | `*.json` / `*.md` / `tsconfig.*` / `vitest.config.ts` / `package.json` | 非源码 |
| 测试 | `test/` 整目录 | 测试代码 |

## 待注释文件（143 个）

### src/ 顶层（17 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/index.ts` | 47 | 包入口 |
| `src/types.ts` | 857 | 核心类型定义 |
| `src/models.ts` | 944 | 模型定义主逻辑 |
| `src/model-catalog.ts` | 27 | 模型目录工具 |
| `src/models-store.ts` | 45 | 模型存储 |
| `src/compat.ts` | 298 | 兼容层 |
| `src/legacy-api-aliases.ts` | 108 | 旧版 API 别名 |
| `src/cli.ts` | 119 | CLI 入口 |
| `src/env-api-keys.ts` | 188 | 环境变量 API Key 解析 |
| `src/oauth.ts` | 10 | OAuth 入口转发 |
| `src/bun-oauth.ts` | 21 | Bun 环境 OAuth |
| `src/images.ts` | 21 | 图像入口 |
| `src/images-models.ts` | 275 | 图像模型逻辑 |
| `src/images-api-registry.ts` | 53 | 图像 API 注册表 |
| `src/image-models.ts` | 42 | 图像模型类型 |
| `src/session-resources.ts` | 24 | 会话资源管理 |
| `src/bedrock-provider.ts` | 6 | Bedrock provider 转发 |

### src/api/（32 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/api/openai-completions.ts` | 1695 | OpenAI Completions API 流式实现 |
| `src/api/openai-codex-responses.ts` | 1650 | OpenAI Codex Responses API |
| `src/api/anthropic-messages.ts` | 1391 | Anthropic Messages API |
| `src/api/bedrock-converse-stream.ts` | 1325 | AWS Bedrock Converse 流式 |
| `src/api/mistral-conversations.ts` | 936 | Mistral Conversations API |
| `src/api/openai-responses-shared.ts` | 792 | OpenAI Responses 共享逻辑 |
| `src/api/google-vertex.ts` | 598 | Google Vertex AI |
| `src/api/google-generative-ai.ts` | 526 | Google Generative AI |
| `src/api/google-shared.ts` | 452 | Google 共享逻辑 |
| `src/api/pi-messages.ts` | 433 | pi Messages API |
| `src/api/openai-responses.ts` | 376 | OpenAI Responses API |
| `src/api/azure-openai-responses.ts` | 338 | Azure OpenAI Responses |
| `src/api/constrained-sampling.ts` | 277 | 约束采样 |
| `src/api/transform-messages.ts` | 223 | 消息格式转换 |
| `src/api/openrouter-images.ts` | 196 | OpenRouter 图像 |
| `src/api/cloudflare-gateway-binding.ts` | 192 | Cloudflare Gateway binding |
| `src/api/lazy.ts` | 98 | 懒加载 API 基建 |
| `src/api/simple-options.ts` | 95 | 简化选项 |
| `src/api/github-copilot-headers.ts` | 37 | Copilot 请求头 |
| `src/api/cloudflare.ts` | 15 | Cloudflare 入口 |
| `src/api/openai-prompt-cache.ts` | 8 | Prompt 缓存常量 |
| `src/api/*.lazy.ts`（11 个） | 4~30 | 各 API 懒加载 shim |

### src/auth/（16 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/auth/types.ts` | 240 | 认证类型 |
| `src/auth/resolve.ts` | 205 | 凭据解析 |
| `src/auth/context.ts` | 45 | 认证上下文 |
| `src/auth/credential-store.ts` | 67 | 凭据存储 |
| `src/auth/helpers.ts` | 59 | 认证工具函数 |
| `src/auth/oauth/openai-codex.ts` | 544 | OpenAI Codex OAuth |
| `src/auth/oauth/github-copilot.ts` | 507 | GitHub Copilot OAuth |
| `src/auth/oauth/radius.ts` | 403 | Radius OAuth |
| `src/auth/oauth/anthropic.ts` | 364 | Anthropic OAuth |
| `src/auth/oauth/openrouter.ts` | 311 | OpenRouter OAuth |
| `src/auth/oauth/kimi-coding.ts` | 296 | Kimi Coding OAuth |
| `src/auth/oauth/xai.ts` | 239 | xAI OAuth |
| `src/auth/oauth/oauth-page.ts` | 109 | OAuth 授权页面 |
| `src/auth/oauth/device-code.ts` | 98 | 设备码流程 |
| `src/auth/oauth/load.ts` | 68 | OAuth 模块加载 |
| `src/auth/oauth/pkce.ts` | 34 | PKCE 工具 |

### src/providers/（48 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/providers/faux.ts` | 708 | 测试用 faux provider |
| `src/providers/all.ts` | 155 | 全部 provider 注册表 |
| `src/providers/cloudflare-auth.ts` | 103 | Cloudflare 认证 |
| `src/providers/google-vertex.ts` | 100 | Vertex provider 定义 |
| `src/providers/radius-config.ts` | 96 | Radius 配置 |
| `src/providers/amazon-bedrock.ts` | 90 | Bedrock provider 定义 |
| `src/providers/radius.ts` | 82 | Radius provider 定义 |
| `src/providers/anthropic.ts` | 59 | Anthropic provider 定义 |
| `src/providers/images/register-builtins.ts` | 50 | 内置图像 provider 注册 |
| `src/providers/github-copilot.ts` | 34 | Copilot provider 定义 |
| `src/providers/cloudflare-stream.ts` | 28 | Cloudflare 流转发 |
| `src/providers/{xai,opencode,kimi-coding,openrouter,...}.ts`（36 个，14~24 行） | ~600 | 各厂商 provider 小定义文件 |

### src/utils/（22 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/utils/validation.ts` | 350 | 参数校验 |
| `src/utils/retry.ts` | 228 | 重试逻辑 |
| `src/utils/overflow.ts` | 180 | 溢出处理 |
| `src/utils/error-body.ts` | 149 | 错误体解析 |
| `src/utils/estimate.ts` | 143 | token 估算 |
| `src/utils/provider-retry.ts` | 125 | provider 级重试 |
| `src/utils/json-parse.ts` | 124 | JSON 解析容错 |
| `src/utils/node-http-proxy.ts` | 112 | Node HTTP 代理 |
| `src/utils/event-stream.ts` | 88 | 事件流解析 |
| `src/utils/provider-env.ts` | 52 | provider 环境变量 |
| `src/utils/abort.ts` 等 12 个小文件 | 12~50 | abort/uuid/diagnostics/hash/sleep 等工具 |

### src/compat/（1 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/compat/extension-oauth-types.ts` | 45 | 扩展 OAuth 类型 |

### scripts/（7 个）

| 文件 | 行数 | 说明 |
|------|------|------|
| `scripts/generate-models.ts` | 3078 | 模型数据代码生成（最大文件） |
| `scripts/model-data.ts` | 280 | 模型数据源 |
| `scripts/generate-image-models.ts` | 162 | 图像模型代码生成 |
| `scripts/generate-test-image.ts` | 32 | 测试图片生成 |
| `scripts/models-dev-reasoning-options.ts` | 30 | models.dev 推理选项拉取 |
| `scripts/openrouter-reasoning-options.ts` | 23 | OpenRouter 推理选项拉取 |
| `scripts/check-model-data.ts` | 16 | 模型数据校验 |
