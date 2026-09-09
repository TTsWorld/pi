/**
 * @file packages/ai/src/index.ts
 * @description
 * 统一 AI 包（@mariozechner/ai）的入口文件。
 *
 * 【历史背景】本提交（f064ea0e1）时，该包处于「调研完成、代码为零」的占位状态：
 * 对 OpenAI / Anthropic / Google Gemini 三家 SDK 的差异调研已经结束，完整的设计
 * 蓝图写在同目录的 plan.md 中，但 src 下还没有任何实际实现，入口仅导出一个
 * 版本号常量作为占位。后续提交才按照蓝图逐步实现：
 *   - 统一的 AI 类（adapter 模式，屏蔽三家 provider 的 API 差异）
 *   - stream() 流式优先：一切接口以流式为基础，非流式只是对流式事件的收集
 *   - 统一事件格式（Event）：start / text / thinking / toolCall / usage / done / error
 *     在所有 provider 上保持一致，便于上层以相同方式处理
 *
 * TODO 注释反映了当时的待办：类型定义与实现完成后再从这里导出。
 */

// @mariozechner/ai - OpenAI、Anthropic、Google Gemini 的统一 API
// 本包提供一套通用接口，用于对接多家 LLM provider

// TODO: 类型与实现定义完成后再导出
export const version = "0.5.8";
