> 中文版译自 [README.md](README.md)，如与英文原文有出入，以英文原文为准。

# pi-agent

一个通用型 agent，支持 tool calling（工具调用）与会话持久化，整体仿照 Claude Code 设计，但极易魔改（hackable）且保持极简。它内置了一个 TUI（同样仿照 Claude Code），用于交互式操作。

一切设计都以「简单」为目标：
- 在它之上编写自定义 UI（通过任意语言的 JSON 模式，或 TypeScript API）
- 在确定性程序中将其用作推理步骤（通过任意语言的 JSON 模式，或 TypeScript API）
- 提供你自己的 system prompt 与工具
- 配合各种 LLM 提供商或自托管 LLM 使用

## 安装

```bash
npm install -g @mariozechner/pi-agent
```

该命令会将 `pi-agent` 安装为全局命令。

## 快速开始

默认情况下，pi-agent 使用 OpenAI 的 API，模型为 `gpt-5-mini`，并通过 `OPENAI_API_KEY` 环境变量进行认证。任何 OpenAI 兼容端点均可使用，包括 Ollama、vLLM、OpenRouter、Groq、Anthropic 等。

```bash
# Single message
pi-agent "What is 2+2?"

# Multiple messages processed sequentially
pi-agent "What is 2+2?" "What about 3+3?"

# Interactive chat mode (no messages = interactive)
pi-agent

# Continue most recently modified session in current directory
pi-agent --continue "Follow up question"

# GPT-OSS via Groq
pi-agent --base-url https://api.groq.com/openai/v1 --api-key $GROQ_API_KEY --model openai/gpt-oss-120b

# GLM 4.5 via OpenRouter
pi-agent --base-url https://openrouter.ai/api/v1 --api-key $OPENROUTER_API_KEY --model z-ai/glm-4.5

# Claude via Anthropic (no prompt caching support - see https://docs.anthropic.com/en/api/openai-sdk)
pi-agent --base-url https://api.anthropic.com/v1 --api-key $ANTHROPIC_API_KEY --model claude-opus-4-1-20250805
```

## 使用模式

### 单次模式
处理一条或多条消息后退出：
```bash
pi-agent "First question" "Second question"
```

### 交互模式
启动一个交互式聊天会话：
```bash
pi-agent
```
- 输入消息并按 Enter 发送
- 输入 `exit` 或 `quit` 结束会话
- 处理过程中按 Escape 中断
- 按 CTRL+C 清空文本编辑器
- 快速按两次 CTRL+C 退出

### JSON 模式
JSON 模式以 JSONL（JSON Lines）格式输出事件，从而实现程序化集成。

**单次模式：** 为每条消息输出一串 JSON 事件流，然后退出。
```bash
pi-agent --json "What is 2+2?" "And the meaning of life?"
# Outputs: {"type":"session_start","sessionId":"bb6f0acb-80cf-4729-9593-bcf804431a53","model":"gpt-5-mini","api":"completions","baseURL":"https://api.openai.com/v1","systemPrompt":"You are a helpful assistant."} {"type":"user_message","text":"What is 2+2?"} {"type":"assistant_start"} {"type":"token_usage","inputTokens":314,"outputTokens":16,"totalTokens":330,"cacheReadTokens":0,"cacheWriteTokens":0} {"type":"assistant_message","text":"2 + 2 = 4"} {"type":"user_message","text":"And the meaning of life?"} {"type":"assistant_start"} {"type":"token_usage","inputTokens":337,"outputTokens":331,"totalTokens":668,"cacheReadTokens":0,"cacheWriteTokens":0} {"type":"assistant_message","text":"Short answer (pop-culture): 42.\n\nMore useful answers:\n- Philosophical...
```

**交互模式：** 通过 stdin 接收 JSON 命令，并将 JSON 事件输出到 stdout。
```bash
# Start interactive JSON mode
pi-agent --json
# Now send commands via stdin

# Pipe one or more initial messages in
(echo '{"type": "message", "content": "What is 2+2?"}'; cat) | pi-agent --json
# Outputs: {"type":"session_start","sessionId":"bb64cfbe-dd52-4662-bd4a-0d921c332fd1","model":"gpt-5-mini","api":"completions","baseURL":"https://api.openai.com/v1","systemPrompt":"You are a helpful assistant."} {"type":"user_message","text":"What is 2+2?"} {"type":"assistant_start"} {"type":"token_usage","inputTokens":314,"outputTokens":16,"totalTokens":330,"cacheReadTokens":0,"cacheWriteTokens":0} {"type":"assistant_message","text":"2 + 2 = 4"}
```

在交互式 JSON 模式下，可通过 stdin 发送以下命令：
```json
{"type": "message", "content": "Your message here"}  // Send a message to the agent
{"type": "interrupt"}                                 // Interrupt current processing
```

## 配置

### 命令行选项
```
--base-url <url>        API base URL (default: https://api.openai.com/v1)
--api-key <key>         API key (or set OPENAI_API_KEY env var)
--model <model>         Model name (default: gpt-4o-mini)
--api <type>            API type: "completions" or "responses" (default: completions)
--system-prompt <text>  System prompt (default: "You are a helpful assistant.")
--continue              Continue previous session
--json                  JSON mode
--help, -h              Show help message
```

### 环境变量
- `OPENAI_API_KEY` - OpenAI API 密钥（未提供 --api-key 时使用）

## 会话持久化

会话会自动保存到 `~/.pi/sessions/`，内容包括：
- 完整的对话历史
- tool call 结果
- token 用量统计

使用 `--continue` 恢复上一次会话：
```bash
pi-agent "Start a story about a robot"
# ... later ...
pi-agent --continue "Continue the story"
```

## 工具

agent 内置了用于文件系统操作的工具：
- **read_file** - 读取文件内容
- **list_directory** - 列出目录内容
- **bash** - 执行 shell 命令
- **glob** - 按模式查找文件
- **ripgrep** - 搜索文件内容

通过 `pi` 命令使用 agent 执行代码导航任务时，这些工具会自动可用。

## JSON 模式事件

使用 `--json` 时，agent 会输出以下事件类型：
- `session_start` - 新会话启动，附带元数据
- `user_message` - 用户输入
- `assistant_start` - 助手开始响应
- `assistant_message` - 助手的响应
- `thinking` - 推理/思考过程（仅支持该能力的模型）
- `tool_call` - 工具调用
- `tool_result` - 工具返回的结果
- `token_usage` - token 用量统计
- `error` - 发生错误
- `interrupted` - 处理被中断

`AgentEvent` 的完整 TypeScript 类型定义见 [`src/agent.ts`](src/agent.ts#L6)。

## 用 JSON 模式构建交互式 UI

以 JSON 模式 spawn 一个 pi-agent 进程并通过 stdin/stdout 与之通信，即可用任意语言构建自定义 UI。

```javascript
import { spawn } from 'child_process';
import { createInterface } from 'readline';

// Start the agent in JSON mode
const agent = spawn('pi-agent', ['--json']);

// Create readline interface for parsing JSONL output from agent
const agentOutput = createInterface({input: agent.stdout, crlfDelay: Infinity});

// Create readline interface for user input
const userInput = createInterface({input: process.stdin, output: process.stdout});

// State tracking
let isProcessing = false, lastUsage, isExiting = false;

// Handle each line of JSON output from agent
agentOutput.on('line', (line) => {
    try {
      const event = JSON.parse(line);

      // Handle all event types
      switch (event.type) {
        case 'session_start':
          console.log(`Session started (${event.model}, ${event.api}, ${event.baseURL})`);
          console.log('Press CTRL + C to exit');
          promptUser();
          break;

        case 'user_message':
          // Already shown in prompt, skip
          break;

        case 'assistant_start':
          isProcessing = true;
          console.log('\n[assistant]');
          break;

        case 'thinking':
          console.log(`[thinking]\n${event.text}\n`);
          break;

        case 'tool_call':
          console.log(`[tool] ${event.name}(${event.args.substring(0, 50)})\n`);
          break;

        case 'tool_result':
            const lines = event.result.split('\n');
            const truncated = lines.length - 5 > 0 ? `\n.  ... (${lines.length - 5} more lines truncated)` : '';
            console.log(`[tool result]\n${lines.slice(0, 5).join('\n')}${truncated}\n`);
          break;

        case 'assistant_message':
          console.log(event.text.trim());
          isProcessing = false;
          promptUser();
          break;

        case 'token_usage':
          lastUsage = event;
          break;

        case 'error':
          console.error('\n❌ Error:', event.message);
          isProcessing = false;
          promptUser();
          break;

        case 'interrupted':
          console.log('\n⚠️  Interrupted by user');
          isProcessing = false;
          promptUser();
          break;
      }
    } catch (e) {
      console.error('Failed to parse JSON:', line, e);
    }
});

// Send a message to the agent
function sendMessage(content) {
  agent.stdin.write(`${JSON.stringify({type: 'message', content: content})}\n`);
}

// Send interrupt signal
function interrupt() {
  agent.stdin.write(`${JSON.stringify({type: 'interrupt'})}\n`);
}

// Prompt for user input
function promptUser() {
  if (isExiting) return;

  if (lastUsage) {
    console.log(`\nin: ${lastUsage.inputTokens}, out: ${lastUsage.outputTokens}, cache read: ${lastUsage.cacheReadTokens}, cache write: ${lastUsage.cacheWriteTokens}`);
  }

  userInput.question('\n[user]\n> ', (answer) => {
    answer = answer.trim();
    if (answer) {
      sendMessage(answer);
    } else {
      promptUser();
    }
  });
}

// Handle Ctrl+C
process.on('SIGINT', () => {
  if (isProcessing) {
    interrupt();
  } else {
    agent.kill();
    process.exit(0);
  }
});

// Handle agent exit
agent.on('close', (code) => {
  isExiting = true;
  userInput.close();
  console.log(`\nAgent exited with code ${code}`);
  process.exit(code);
});

// Handle errors
agent.on('error', (err) => {
  console.error('Failed to start agent:', err);
  process.exit(1);
});

// Start the conversation
console.log('Pi Agent Interactive Chat');
```

## 架构

agent 由以下模块构成：
- **agent.ts** - 核心 Agent 类与 API 函数
- **cli.ts** - CLI 入口、参数解析与 JSON 模式处理器
- **args.ts** - 自定义的类型化参数解析器
- **session-manager.ts** - 会话持久化
- **tools/** - 工具实现
- **renderers/** - 输出格式化器（console、TUI、JSON）

## 开发

```bash
# Run from source
npx tsx src/cli.ts "Hello"

# Build
npm run build

# Run built version
dist/cli.js "Hello"
```

## 作为库使用

```typescript
import { Agent, ConsoleRenderer } from '@mariozechner/pi-agent';

const agent = new Agent({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
  api: 'completions',
  systemPrompt: 'You are a helpful assistant.'
}, new ConsoleRenderer());

await agent.ask('What is 2+2?');
```
