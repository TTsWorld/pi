/**
 * @file 注册 AWS Bedrock provider：把 pi-ai 的 Bedrock 实现接入全局 compat 注册表。
 */
import { bedrockProviderModule } from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

setBedrockProviderModule(bedrockProviderModule);
