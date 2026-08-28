/**
 * @file command.ts —— 实验性子命令的解析与执行框架
 *
 * @description
 * 本文件实现一个小型的静态类型命令行框架，供 experimental 目录下的 pi / server /
 * client 子命令共用。核心是 `Command` 类：链式调用 option（注册选项）、build（注册
 * 构造器）、action（注册执行动作）、command（挂载子命令），即可获得
 * 「选项解析 → 子命令分发 → 构造调用对象 → 执行」的完整流水线。
 *
 * 设计要点：
 * - 解析与执行分离：`parse` 纯静态、无副作用；`execute` 才真正分发执行；
 * - 选项自带解析器：值校验内聚在 `CommandOption.parse`，builder 拿到的均为已验证值；
 * - 错误聚合而非抛出：选项与 builder 的错误合并进 `errors` 数组统一返回。
 */

/**
 * 带命令名的调用对象：所有命令最终构造出的「调用」都携带 `command` 字段
 * （值为命令名），作为判别字段供上层区分不同的调用形态。
 */
export interface NamedCommandInvocation {
	readonly command: string;
}

/**
 * 命令解析结果：成功携带构造好的调用对象；失败携带全部用法错误（不抛异常）。
 */
export type CommandParseResult<TInvocation extends NamedCommandInvocation = NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

/**
 * 命令执行结果：与解析结果同构。execute 内部会先解析，解析失败直接返回错误，
 * 不会触发 action。
 */
export type CommandExecutionResult<TInvocation extends NamedCommandInvocation = NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

/** 单个选项值的解析结果：成功携带已验证的值，失败携带单条错误信息。 */
export type CommandOptionParseResult<TValue> =
	| { readonly ok: true; readonly value: TValue }
	| { readonly ok: false; readonly error: string };

/**
 * 命令选项定义：名字（必须以 `--` 开头）+ 值解析函数。
 * 值的类型校验与转换逻辑内聚在 `parse` 中，随选项一同注册到命令上。
 */
export interface CommandOption<TValue> {
	readonly name: `--${string}`;
	parse(value: string): CommandOptionParseResult<TValue>;
}

/** 选项工厂：用自定义解析函数构造选项，适合需要校验/转换的非字符串值。 */
export function valueOption<TValue>(
	name: `--${string}`,
	parse: (value: string) => CommandOptionParseResult<TValue>,
): CommandOption<TValue> {
	return { name, parse };
}

/** 字符串选项工厂：接受任意非空字符串值，不做额外校验。 */
export function stringOption(name: `--${string}`): CommandOption<string> {
	return valueOption(name, (value) => ({ ok: true, value }));
}

/**
 * builder 的输入视图：暴露位置参数（remainingArgs）与按选项取值的访问器。
 * `value` 取首个已验证值，`values` 取全部；以选项对象自身为键，无需重复传参。
 */
export interface ParsedCommandInput {
	readonly remainingArgs: readonly string[];
	value<TValue>(option: CommandOption<TValue>): TValue | undefined;
	values<TValue>(option: CommandOption<TValue>): readonly TValue[];
}

/** builder 的构造结果：成功携带调用对象；失败携带错误列表（与选项解析错误合并上报）。 */
export type CommandBuildResult<TInvocation extends NamedCommandInvocation> =
	| { readonly ok: true; readonly command: TInvocation }
	| { readonly ok: false; readonly errors: readonly string[] };

/**
 * parseOptions 的内部可变产物：选项名 → 已验证值列表、位置参数、解析错误。
 * 仅在解析阶段内部流转，对外以只读的 ParsedCommandInput 形式暴露。
 */
interface MutableParsedCommandInput {
	readonly values: Map<string, unknown[]>;
	readonly remainingArgs: string[];
	readonly errors: string[];
}

/** builder：把解析输入组装为调用对象；可在此做跨选项一致性校验并以 errors 形式返回失败。 */
type CommandBuilder<TInvocation extends NamedCommandInvocation> = (
	input: ParsedCommandInput,
) => CommandBuildResult<TInvocation>;

/**
 * action：命令的执行动作，接收 builder 产出的调用对象与命令上下文，可同步或异步。
 * action 抛出的异常不在框架内捕获，由 execute 的调用方处理。
 */
type CommandAction<TInvocation extends NamedCommandInvocation, TContext> = (
	command: TInvocation,
	context: TContext,
) => void | Promise<void>;

/**
 * 已注册子命令的内部封装：把类型化 Command 擦除为 context: unknown 的统一接口，
 * 便于父命令在同一个 Map 中存储并分发。
 */
interface RegisteredCommand {
	parse(argv: readonly string[]): CommandParseResult;
	execute(argv: readonly string[], context: unknown): Promise<CommandExecutionResult>;
}

/**
 * 命令节点：一个可独立解析与执行的（子）命令。
 *
 * 泛型：TOwnInvocation 为自身 builder 构造的调用对象；TContext 为执行自身 action
 * 所需上下文；TInvocation 为对外调用对象类型（挂载子命令后为联合），默认为 TOwnInvocation。
 * parse / execute 会根据 argv 首个 token 自动路由到命中的子命令。
 */
export class Command<
	TOwnInvocation extends NamedCommandInvocation,
	TContext,
	TInvocation extends NamedCommandInvocation = TOwnInvocation,
> {
	readonly name: string;
	private readonly options = new Map<string, CommandOption<unknown>>();
	private readonly subcommands = new Map<string, RegisteredCommand>();
	private builder?: CommandBuilder<TOwnInvocation>;
	private commandAction?: CommandAction<TOwnInvocation, TContext>;

	constructor(name: string) {
		this.name = name;
	}

	/** 注册一个选项；同名重复注册属编程错误，直接抛出。返回 this 以支持链式配置。 */
	option<TValue>(option: CommandOption<TValue>): this {
		if (this.options.has(option.name)) {
			throw new Error(`Option ${option.name} is already registered for ${this.name}`);
		}
		this.options.set(option.name, option);
		return this;
	}

	/** 注册 builder：把解析输入转换为自身调用对象。 */
	build(builder: CommandBuilder<TOwnInvocation>): this {
		this.builder = builder;
		return this;
	}

	/** 注册 action：命令的执行动作；execute 时若未注册则抛错。 */
	action(action: CommandAction<TOwnInvocation, TContext>): this {
		this.commandAction = action;
		return this;
	}

	/**
	 * 挂载子命令并返回组合后的命令对象。组合后上下文取交集
	 * （`TContext & TSubcommandContext`，同一上下文可喂给自身与子命令），
	 * 对外调用对象变为联合（parse / execute 可能路由到任一子命令）。
	 *
	 * NOTE: 子命令重名直接抛出；内部以类型擦除的 RegisteredCommand 存储，
	 * 分发时再把 unknown 上下文强转回子命令类型（故需双重断言）。
	 */
	command<
		TSubcommandOwnInvocation extends NamedCommandInvocation,
		TSubcommandContext,
		TSubcommandInvocation extends NamedCommandInvocation,
	>(
		command: Command<TSubcommandOwnInvocation, TSubcommandContext, TSubcommandInvocation>,
	): Command<TOwnInvocation, TContext & TSubcommandContext, TInvocation | TSubcommandInvocation> {
		if (this.subcommands.has(command.name)) throw new Error(`Command ${command.name} is already registered`);
		this.subcommands.set(command.name, {
			parse: (argv) => command.parse(argv),
			execute: (argv, context) => command.execute(argv, context as TSubcommandContext),
		});
		return this as unknown as Command<
			TOwnInvocation,
			TContext & TSubcommandContext,
			TInvocation | TSubcommandInvocation
		>;
	}

	/**
	 * 静态解析入口：argv 首个 token 命中子命令则递归下钻，否则按自身选项规则解析。
	 * 无副作用、不执行 action。
	 */
	parse(argv: readonly string[]): CommandParseResult<TInvocation> {
		const selected = this.select(argv);
		if (selected) return selected.command.parse(selected.argv) as CommandParseResult<TInvocation>;
		return this.parseOwn(argv) as CommandParseResult<TInvocation>;
	}

	/**
	 * 解析并执行：先尝试路由子命令（命中则整段委托，上下文原样透传）；
	 * 否则解析自身参数，失败直接返回错误（不执行 action），成功则调用 action 后回传。
	 */
	async execute(argv: readonly string[], context: TContext): Promise<CommandExecutionResult<TInvocation>> {
		const selected = this.select(argv);
		if (selected) {
			return selected.command.execute(selected.argv, context) as Promise<CommandExecutionResult<TInvocation>>;
		}

		const parsed = this.parseOwn(argv);
		if (!parsed.ok) return parsed;
		if (!this.commandAction) throw new Error(`Command ${this.name} does not define an action`);
		await this.commandAction(parsed.command, context);
		return { ok: true, command: parsed.command as unknown as TInvocation };
	}

	/** 检查 argv[0] 是否命中已注册子命令；命中则返回子命令与剥去子命令名后的剩余参数。 */
	private select(argv: readonly string[]): { command: RegisteredCommand; argv: readonly string[] } | undefined {
		const candidate = argv[0];
		if (candidate === undefined) return undefined;
		const command = this.subcommands.get(candidate);
		return command ? { command, argv: argv.slice(1) } : undefined;
	}

	/**
	 * 解析自身路径（未命中子命令时）：先做选项解析，再把结果交给 builder 组装。
	 * 选项错误与 builder 错误合并后统一返回；builder 失败却未给出错误属编程错误，抛出。
	 */
	private parseOwn(argv: readonly string[]): CommandParseResult<TOwnInvocation> {
		if (!this.builder) throw new Error(`Command ${this.name} does not define a builder`);
		const parsed = this.parseOptions(argv);
		const input: ParsedCommandInput = {
			remainingArgs: parsed.remainingArgs,
			// value 取该选项首个（因选项唯一性，也即唯一一个）已验证值
			value: <TValue>(option: CommandOption<TValue>) => parsed.values.get(option.name)?.[0] as TValue | undefined,
			// values 返回全部出现值；当前每选项至多一次，保留数组形式以备将来放开
			values: <TValue>(option: CommandOption<TValue>) => (parsed.values.get(option.name) ?? []) as readonly TValue[],
		};
		const built = this.builder(input);
		// 合并选项解析错误与 builder 构造错误，一次性全部上报
		const errors = [...parsed.errors, ...(built.ok ? [] : built.errors)];
		if (errors.length > 0) return { ok: false, errors };
		if (!built.ok) throw new Error(`Command ${this.name} failed without an error`);
		return { ok: true, command: built.command };
	}

	/**
	 * 逐个解析 argv 中的选项，产出可变的解析结果。
	 * 支持 `--opt=value` 与 `--opt value` 两种写法（下一个参数仅当不以 `-` 开头
	 * 才被当作值）；遇到 `--` 或首个未注册 token 即终止选项解析，
	 * 其后所有参数（含 `--` 自身）原样进入 remainingArgs；每选项至多一次且值非空。
	 */
	private parseOptions(argv: readonly string[]): MutableParsedCommandInput {
		const parsed: MutableParsedCommandInput = {
			values: new Map(),
			remainingArgs: [],
			errors: [],
		};
		for (let index = 0; index < argv.length; index++) {
			const argument = argv[index]!;
			// "--" 是选项结束分隔符：其后所有参数（含自身）视为位置参数
			if (argument === "--") {
				parsed.remainingArgs.push(...argv.slice(index));
				break;
			}

			// 拆出选项名，兼容 --opt=value 写法（equals 为 "=" 的下标，-1 表示不存在）
			const equals = argument.indexOf("=");
			const name = equals === -1 ? argument : argument.slice(0, equals);
			const option = this.options.get(name);
			// 首个未注册 token：选项区到此结束，余下全部视为位置参数
			if (!option) {
				parsed.remainingArgs.push(...argv.slice(index));
				break;
			}

			// "=" 形式直接取值；否则尝试消费下一个参数作为值（以 "-" 开头的视为选项而非值）
			let value = equals === -1 ? undefined : argument.slice(equals + 1);
			if (value === undefined) {
				const next = argv[index + 1];
				if (next !== undefined && !next.startsWith("-")) {
					value = next;
					index++;
				}
			}
			// 取不到值或值为空串（含 --opt= 的空值）都视为缺值错误
			if (value === undefined || value === "") {
				parsed.errors.push(`${name} requires a value`);
				continue;
			}

			// 选项唯一性：重复指定直接报错并跳过本次值
			const values = parsed.values.get(name) ?? [];
			if (values.length > 0) {
				parsed.errors.push(`${name} may only be specified once`);
				continue;
			}
			// 交由选项自带的解析器做校验/转换；失败只记录错误，继续收集后续问题
			const result = option.parse(value);
			if (!result.ok) {
				parsed.errors.push(result.error);
				continue;
			}
			values.push(result.value);
			parsed.values.set(name, values);
		}
		return parsed;
	}
}
