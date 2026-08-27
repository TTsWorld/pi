/**
 * @file AWS Bedrock provider 的静态模块句柄。
 * @description Bedrock 实现默认经 api/bedrock-converse-stream.lazy.ts 以「变量 specifier」
 * 动态 import 懒加载（约 1300 行、依赖仅 Node 可用的 AWS SDK），浏览器冒烟测试等
 * 场景因此不会被牵入这些依赖。但 Bun 单文件二进制打包不了这种动态 import，所以
 * 本文件静态引入 stream/streamSimple 并整体导出，由 coding-agent 的 Bun 构建入口
 * （src/bun/register-bedrock.ts）调用 compat 里的 setBedrockProviderModule 注入覆盖，
 * 从而把 AWS SDK 显式打进 bundle。常规构建无需引用本文件。
 */
import { stream, streamSimple } from "./api/bedrock-converse-stream.ts";

/**
 * Bedrock Converse Stream API 的静态模块句柄（stream / streamSimple）。
 * 之所以做成独立导出而不放进主入口，是为了让只有 Bun 构建显式依赖它，
 * 其他构建不受 AWS SDK 的体积与运行环境影响。
 */
export const bedrockProviderModule = {
	stream,
	streamSimple,
};
