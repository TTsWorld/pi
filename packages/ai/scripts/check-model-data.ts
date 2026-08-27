#!/usr/bin/env node
/**
 * @file 构建前校验脚本:确认本地已生成的模型数据存在且未过期。
 *
 * 在 packages/ai 的离线构建流水线中,本脚本是 `build:offline` 的第一步
 * (对应 npm script `check:model-data`),保证后续 tsgo 编译时
 * src/models.generated.ts、src/providers/*.models.ts 以及
 * src/providers/data/*.json(gitignored 的本地数据缓存)三者一致可用。
 * 它只做本地校验、不发任何网络请求;校验失败时提示先执行
 * `npm run hydrate:model-data` 重新拉取生成数据,并以非零退出码中断构建。
 *
 * 运行方式:node scripts/check-model-data.ts(或 npm run check:model-data)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGeneratedModelData } from "./model-data.ts";

// 包根目录:scripts/ 的上一级
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
	validateGeneratedModelData(packageRoot);
	console.log("Generated model data is valid.");
} catch (error) {
	// 校验失败(数据缺失、schema 版本不符、hash 与清单不一致等):
	// 原样输出错误信息,并提示用水合命令重新生成数据;
	// 用 exitCode 而非 process.exit(),让 stdout/stderr 先正常刷完再退出
	console.error(error instanceof Error ? error.message : String(error));
	console.error("\nModel data is missing or stale. Run `npm run hydrate:model-data` from the repository root.");
	process.exitCode = 1;
}
