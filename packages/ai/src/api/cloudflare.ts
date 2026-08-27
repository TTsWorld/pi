/**
 * @file Cloudflare 相关的 API 端点 URL 常量。
 * @description 覆盖 Workers AI 直连与 AI Gateway 的多种透传端点；URL 中
 * {CLOUDFLARE_ACCOUNT_ID} / {CLOUDFLARE_GATEWAY_ID} 占位符由调用方替换。
 */

/** Workers AI 直连端点。 */
export const CLOUDFLARE_WORKERS_AI_BASE_URL =
	"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

/** AI Gateway 统一 API（Unified API）。文档：https://developers.cloudflare.com/ai-gateway/usage/unified-api/ */
export const CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat";

/** AI Gateway 的 OpenAI 透传端点。在 /compat 端点支持 /v1/responses 之前先走这里。 */
export const CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/openai";

/** AI Gateway 的 Anthropic 透传端点。 */
export const CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL =
	"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic";
