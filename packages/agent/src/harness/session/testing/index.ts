/**
 * session/testing 子模块入口：导出 SessionStorage 后端的 conformance 一致性测试套件，
 * 用于验证任意后端实现的行为与约定保持一致。
 */
export { createSessionBackendConformance } from "./conformance.ts";
export type {
	SessionBackendConformanceCase,
	SessionBackendFixture,
	SessionBackendFixtureFactory,
} from "./types.ts";
