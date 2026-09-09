> 中文版译自 [README.md](README.md)，如与英文原文有出入，以英文原文为准。

# @mariozechner/pi-tui

带有差分渲染（differential rendering）能力的终端 UI 框架，用于构建交互式 CLI 应用。

## 特性

- **差分渲染**：只重新渲染发生变化的内容，以获得最佳性能
- **交互式组件**：文本编辑器、自动补全、选择列表以及 Markdown 渲染
- **可组合架构**：基于 Container 的 component（组件）系统，具备完善的生命周期管理
- **文本编辑器自动补全系统**：通过 provider 接口支持文件补全和斜杠命令（slash command）

## 快速开始

```typescript
import { TUI, Container, TextComponent, TextEditor } from "@mariozechner/pi-tui";

// Create TUI manager
const ui = new TUI();

// Create components
const header = new TextComponent("🚀 My TUI App");
const chatContainer = new Container();
const editor = new TextEditor();

// Add components to UI
ui.addChild(header);
ui.addChild(chatContainer);
ui.addChild(editor);

// Set focus to the editor
ui.setFocus(editor);

// Handle editor submissions
editor.onSubmit = (text: string) => {
	if (text.trim()) {
		const message = new TextComponent(`💬 ${text}`);
		chatContainer.addChild(message);
		ui.requestRender();
	}
};

// Start the UI
ui.start();
```

## 核心组件

### TUI

TUI 主管理器，负责渲染、输入处理和组件协调。

**方法：**

- `addChild(component)` - 向 TUI 添加一个组件
- `removeChild(component)` - 从 TUI 中移除一个组件
- `setFocus(component)` - 设置哪个组件接收键盘输入（获得焦点）
- `start()` - 启动 TUI（启用 raw mode）
- `stop()` - 停止 TUI（禁用 raw mode）
- `requestRender()` - 请求在下一次 tick 时重新渲染
- `configureLogging(config)` - 配置调试日志
- `cleanupSentinels()` - 在移除操作之后清理占位组件
- `findComponent(component)` - 检查组件是否存在于层级结构中（私有）
- `findInContainer(container, component)` - 在容器中搜索组件（私有）

### Container

管理子组件并使用差分渲染的容器组件。

**构造函数：**

```typescript
new Container(parentTui?: TUI | undefined)
```

**方法：**

- `addChild(component)` - 添加一个子组件
- `removeChild(component)` - 移除一个子组件
- `getChild(index)` - 获取指定索引处的子组件
- `getChildCount()` - 获取子组件的数量
- `clear()` - 移除所有子组件
- `setParentTui(tui)` - 设置父 TUI 引用
- `cleanupSentinels()` - 清理已移除组件的占位符
- `render(width)` - 渲染所有子组件（返回 ContainerRenderResult）

### TextEditor

交互式多行文本编辑器，支持光标操作和完善的键盘快捷键。

**构造函数：**

```typescript
new TextEditor(config?: TextEditorConfig)
```

**配置：**

```typescript
interface TextEditorConfig {
	// Configuration options for text editor
}

editor.configure(config: Partial<TextEditorConfig>)
```

**属性：**

- `onSubmit?: (text: string) => void` - 用户按下 Enter 时的回调
- `onChange?: (text: string) => void` - 文本内容发生变化时的回调

**方法：**

- `getText()` - 获取当前文本内容
- `setText(text)` - 设置文本内容并将光标移到末尾
- `setAutocompleteProvider(provider)` - 设置用于 Tab 补全的自动补全 provider
- `render(width)` - 按当前状态渲染编辑器
- `handleInput(data)` - 处理键盘输入

**键盘快捷键：**

**导航：**

- `Arrow Keys` - 移动光标
- `Home` / `Ctrl+A` - 移动到行首
- `End` / `Ctrl+E` - 移动到行尾

**编辑：**

- `Backspace` - 删除光标前的一个字符
- `Delete` / `Fn+Backspace` - 删除光标处的一个字符
- `Ctrl+K` - 删除当前行
- `Enter` - 提交文本（调用 onSubmit）
- `Shift+Enter` / `Option+Enter` - 插入新行
- `Tab` - 触发自动补全

**自动补全（激活时）：**

- `Tab` - 应用选中的补全项
- `Arrow Up/Down` - 在候选项之间移动
- `Escape` - 取消自动补全
- `Enter` - 取消自动补全并提交

**粘贴检测：**

- 自动处理多行粘贴
- 将制表符（tab）转换为 4 个空格
- 过滤不可打印字符

### TextComponent

简单的文本组件，支持自动换行和差分渲染。

**构造函数：**

```typescript
new TextComponent(text: string, padding?: Padding)

interface Padding {
	top?: number;
	bottom?: number;
	left?: number;
	right?: number;
}
```

**方法：**

- `setText(text)` - 更新文本内容
- `getText()` - 获取当前文本内容
- `render(width)` - 按词换行进行渲染

**特性：**

- 自动换行以适配终端宽度
- 四个方向的内边距（padding）均可配置
- 保留源文本中的换行符
- 使用差分渲染避免不必要的更新

### MarkdownComponent

渲染 Markdown 内容，支持语法高亮和规范的格式化。

**构造函数：**

```typescript
new MarkdownComponent(text?: string)
```

**方法：**

- `setText(text)` - 更新 Markdown 内容
- `render(width)` - 渲染解析后的 Markdown

**特性：**

- **标题**：带有颜色和格式样式
- **代码块**：语法高亮，灰色背景
- **列表**：项目符号列表（•）和有序列表
- **强调**：**粗体**和 _斜体_ 文本
- **链接**：加下划线并显示 URL
- **引用块**：带有左侧边框样式
- **行内代码**：带背景高亮
- **水平分割线**：与终端等宽的分隔线
- 采用差分渲染以保证性能

### SelectList

用于在多个选项中进行选择的交互式选择组件。

**构造函数：**

```typescript
new SelectList(items: SelectItem[], maxVisible?: number)

interface SelectItem {
	value: string;
	label: string;
	description?: string;
}
```

**属性：**

- `onSelect?: (item: SelectItem) => void` - 选中某个条目时调用
- `onCancel?: () => void` - 取消选择时调用

**方法：**

- `setFilter(filter)` - 按 value 过滤条目
- `getSelectedItem()` - 获取当前选中的条目
- `handleInput(keyData)` - 处理键盘导航
- `render(width)` - 渲染选择列表

**特性：**

- 键盘导航（方向键、Enter）
- 搜索/过滤功能
- 长列表滚动
- 支持描述信息的自定义选项渲染
- 可视化选中指示符（→）
- 滚动位置指示器

### 自动补全系统

功能完善的自动补全系统，支持斜杠命令和文件路径。

#### AutocompleteProvider 接口

```typescript
interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): {
		items: AutocompleteItem[];
		prefix: string;
	} | null;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
}

interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}
```

#### CombinedAutocompleteProvider

内置的 provider，支持斜杠命令和文件补全。

**构造函数：**

```typescript
new CombinedAutocompleteProvider(
	commands: (SlashCommand | AutocompleteItem)[] = [],
	basePath: string = process.cwd()
)

interface SlashCommand {
	name: string;
	description?: string;
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}
```

**特性：**

**斜杠命令：**

- 输入 `/` 触发命令补全
- 命令名称自动补全
- 为支持参数的命令提供参数补全
- 命令名后输入空格即进入参数输入

**文件补全：**

- `Tab` 键触发文件补全
- `@` 前缀用于附加文件
- 支持主目录展开（`~/`）
- 支持相对路径和绝对路径
- 目录优先排序
- 使用 `@` 前缀时过滤出可附加的文件

**路径模式：**

- `./` 和 `../` - 相对路径
- `~/` - 用户主目录
- `@path` - 文件附加语法
- 在任意上下文中均可使用 Tab 补全

**方法：**

- `getSuggestions()` - 获取当前上下文的补全项
- `getForceFileSuggestions()` - 强制进行文件补全（Tab 键）
- `shouldTriggerFileCompletion()` - 检查是否应触发文件补全
- `applyCompletion()` - 应用选中的补全项

## 差分渲染

核心概念：组件返回 `{lines: string[], changed: boolean, keepLines?: number}`：

- `lines`：组件应显示的所有行
- `changed`：组件自上次渲染以来是否发生了变化
- `keepLines`：（仅容器）从开头起未发生变化的行数

**工作原理：**

1. TUI 计算从顶部开始的总未变化行数（`keepLines`）
2. 将光标向上移动 `(totalLines - keepLines)` 个位置
3. 使用 `\x1b[0J` 清除光标位置及其以下的内容
4. 只打印发生变化的行：`result.lines.slice(keepLines)`

这种方式能将屏幕更新降到最少，即使文本量很大也能保持流畅的性能。

**重要**：打印之后不要添加额外的光标定位——这会干扰终端滚动并导致渲染残影。

## 进阶示例

### 带自动补全的聊天应用

```typescript
import { TUI, Container, TextEditor, MarkdownComponent, CombinedAutocompleteProvider } from "@mariozechner/pi-tui";

const ui = new TUI();
const chatHistory = new Container();
const editor = new TextEditor();

// Set up autocomplete with slash commands
const autocompleteProvider = new CombinedAutocompleteProvider([
	{ name: "clear", description: "Clear chat history" },
	{ name: "help", description: "Show help information" },
	{
		name: "attach",
		description: "Attach a file",
		getArgumentCompletions: (prefix) => {
			// Return file suggestions for attach command
			return null; // Use default file completion
		},
	},
]);

editor.setAutocompleteProvider(autocompleteProvider);

editor.onSubmit = (text) => {
	// Handle slash commands
	if (text.startsWith("/")) {
		const [command, ...args] = text.slice(1).split(" ");
		if (command === "clear") {
			chatHistory.clear();
			return;
		}
		if (command === "help") {
			const help = new MarkdownComponent(`
## Available Commands
- \`/clear\` - Clear chat history
- \`/help\` - Show this help
- \`/attach <file>\` - Attach a file
			`);
			chatHistory.addChild(help);
			ui.requestRender();
			return;
		}
	}

	// Regular message
	const message = new MarkdownComponent(`**You:** ${text}`);
	chatHistory.addChild(message);

	// Add AI response (simulated)
	setTimeout(() => {
		const response = new MarkdownComponent(`**AI:** Response to "${text}"`);
		chatHistory.addChild(response);
		ui.requestRender();
	}, 1000);
};

ui.addChild(chatHistory);
ui.addChild(editor);
ui.setFocus(editor);
ui.start();
```

### 文件浏览器

```typescript
import { TUI, SelectList } from "@mariozechner/pi-tui";
import { readdirSync, statSync } from "fs";
import { join } from "path";

const ui = new TUI();
let currentPath = process.cwd();

function createFileList(path: string) {
	const entries = readdirSync(path).map((entry) => {
		const fullPath = join(path, entry);
		const isDir = statSync(fullPath).isDirectory();
		return {
			value: entry,
			label: entry,
			description: isDir ? "directory" : "file",
		};
	});

	// Add parent directory option
	if (path !== "/") {
		entries.unshift({
			value: "..",
			label: "..",
			description: "parent directory",
		});
	}

	return entries;
}

function showDirectory(path: string) {
	ui.clear();

	const entries = createFileList(path);
	const fileList = new SelectList(entries, 10);

	fileList.onSelect = (item) => {
		if (item.value === "..") {
			currentPath = join(currentPath, "..");
			showDirectory(currentPath);
		} else if (item.description === "directory") {
			currentPath = join(currentPath, item.value);
			showDirectory(currentPath);
		} else {
			console.log(`Selected file: ${join(currentPath, item.value)}`);
			ui.stop();
		}
	};

	ui.addChild(fileList);
	ui.setFocus(fileList);
}

showDirectory(currentPath);
ui.start();
```

### 多组件布局

```typescript
import { TUI, Container, TextComponent, TextEditor, MarkdownComponent } from "@mariozechner/pi-tui";

const ui = new TUI();

// Create layout containers
const header = new TextComponent("📝 Advanced TUI Demo", { bottom: 1 });
const mainContent = new Container();
const sidebar = new Container();
const footer = new TextComponent("Press Ctrl+C to exit", { top: 1 });

// Sidebar content
sidebar.addChild(new TextComponent("📁 Files:", { bottom: 1 }));
sidebar.addChild(new TextComponent("- config.json"));
sidebar.addChild(new TextComponent("- README.md"));
sidebar.addChild(new TextComponent("- package.json"));

// Main content area
const chatArea = new Container();
const inputArea = new TextEditor();

// Add welcome message
chatArea.addChild(
	new MarkdownComponent(`
# Welcome to the TUI Demo

This demonstrates multiple components working together:

- **Header**: Static title with padding
- **Sidebar**: File list (simulated)
- **Chat Area**: Scrollable message history
- **Input**: Interactive text editor
- **Footer**: Status information

Try typing a message and pressing Enter!
`),
);

inputArea.onSubmit = (text) => {
	if (text.trim()) {
		const message = new MarkdownComponent(`
**${new Date().toLocaleTimeString()}:** ${text}
		`);
		chatArea.addChild(message);
		ui.requestRender();
	}
};

// Build layout
mainContent.addChild(chatArea);
mainContent.addChild(inputArea);

ui.addChild(header);
ui.addChild(mainContent);
ui.addChild(footer);
ui.setFocus(inputArea);

// Configure debug logging
ui.configureLogging({
	enabled: true,
	level: "info",
	logFile: "tui-debug.log",
});

ui.start();
```

## 接口与类型

### 核心类型

```typescript
interface ComponentRenderResult {
	lines: string[];
	changed: boolean;
}

interface ContainerRenderResult extends ComponentRenderResult {
	keepLines: number;
}

interface Component {
	render(width: number): ComponentRenderResult;
	handleInput?(keyData: string): void;
}

interface Padding {
	top?: number;
	bottom?: number;
	left?: number;
	right?: number;
}
```

### 自动补全类型

```typescript
interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

interface SlashCommand {
	name: string;
	description?: string;
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

interface AutocompleteProvider {
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): {
		items: AutocompleteItem[];
		prefix: string;
	} | null;

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
}
```

### 选择类型

```typescript
interface SelectItem {
	value: string;
	label: string;
	description?: string;
}
```

## 开发

```bash
# Install dependencies (from monorepo root)
npm install

# Build the package
npm run build

# Run type checking
npm run check
```

**测试：**
创建一个测试文件并使用 tsx 运行：

```bash
# From packages/tui directory
npx tsx test/demo.ts
```

用于模拟的特殊输入关键字："TAB"、"ENTER"、"SPACE"、"ESC"

**调试：**
启用日志可以查看组件的详细行为：

```typescript
ui.configureLogging({
	enabled: true,
	level: "debug", // "error" | "warn" | "info" | "debug"
	logFile: "tui-debug.log",
});
```

查看日志文件可以排查渲染问题、输入处理以及组件生命周期相关的问题。
