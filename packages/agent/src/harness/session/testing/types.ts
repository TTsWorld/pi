/**
 * session/testing 子模块的类型定义：conformance 一致性测试所需的后端 fixture
 * 与测试用例结构。
 */
import type { SessionRepo } from "../types.ts";

/** 由单个 conformance 用例独占的一个全新后端实例。 */
export interface SessionBackendFixture extends AsyncDisposable {
	/** 该 fixture 持有的会话仓储实例。 */
	readonly repository: SessionRepo;
}

/** 为单个 conformance 用例创建一个相互隔离的 fixture。 */
export type SessionBackendFixtureFactory = () => Promise<SessionBackendFixture>;

/** 与测试运行器（runner）无关的 conformance 用例，可注册到任意测试框架。 */
export interface SessionBackendConformanceCase {
	/** 用例所属分组。 */
	readonly group: string;
	/** 用例名称。 */
	readonly name: string;
	run(): Promise<void>;
}
