#!/usr/bin/env node
/**
 * @file 测试辅助脚本:生成一张 200x200 的白底红圆 PNG 小图。
 *
 * 输出到 test/data/red-circle.png,供多个测试用例作为图片输入使用
 * (如 images.test.ts、image-tool-result.test.ts、stream.test.ts、
 * openai-responses-tool-result-images.test.ts),用于验证图片消息的
 * 编码与多模态请求逻辑。图片文件不入库时需要重新生成本文件。
 *
 * 运行方式:node scripts/generate-test-image.ts(依赖 node-canvas)
 */

import { createCanvas } from "canvas";
import { mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 创建 200x200 的画布
const canvas = createCanvas(200, 200);
const ctx = canvas.getContext("2d");

// 用白色填充背景
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 200, 200);

// 在画布中心画一个红色圆
ctx.fillStyle = "red";
ctx.beginPath();
ctx.arc(100, 100, 50, 0, Math.PI * 2);
ctx.fill();

// 编码为 PNG 并确定输出路径
const buffer = canvas.toBuffer("image/png");
const outputPath = join(__dirname, "..", "test", "data", "red-circle.png");

// 确保目标目录存在(首次生成时 test/data 可能还不存在)
mkdirSync(join(__dirname, "..", "test", "data"), { recursive: true });

writeFileSync(outputPath, buffer);
console.log(`Generated test image at: ${outputPath}`);