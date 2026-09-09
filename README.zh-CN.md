> 中文版译自 [README.md](README.md)，如与英文原文有出入，以英文原文为准。

# Pi Monorepo

一组用于管理 LLM 部署和构建 AI agent（智能体）的工具集合。

## 包

- **[@mariozechner/pi-tui](packages/tui)** - 终端 UI 库，支持差分渲染（differential rendering）
- **[@mariozechner/pi-agent](packages/agent)** - 通用 agent，支持工具调用（tool calling）与会话持久化
- **[@mariozechner/pi](packages/pods)** - 用于管理 GPU pod 上 vLLM 部署的 CLI

## 开发

本仓库是一个 monorepo，使用 npm workspaces 进行包管理，并采用双重 TypeScript 配置来支持开发与构建。

### 环境准备

```bash
# Install all dependencies
npm install

# Build all packages (required for production use)
npm run build

# Or run directly with tsx during development (no build needed)
cd packages/pods && npx tsx src/cli.ts
cd packages/agent && npx tsx src/cli.ts
```

### 常用命令

```bash
# Clean all build artifacts and tsconfig.tsbuildinfo files
npm run clean

# Build all packages in dependency order
npm run build

# Run biome checks and TypeScript type checking (no build required)
npm run check

# Run tests (if present)
npm run test
```

### 包依赖

各包之间具有如下依赖结构：

`pi-tui` -> `pi-agent` -> `pi`

### TypeScript 配置

本 monorepo 采用双重 TypeScript 配置方案：
- **根目录 `tsconfig.json`**：包含所有包的路径映射（path mappings），用于类型检查以及配合 `tsx` 进行开发
- **各包内的 `tsconfig.build.json`**：带有 `rootDir` 和 `outDir` 的纯净构建配置，用于生产构建

这种配置方案可以实现：
- 无需构建即可进行类型检查（`npm run check` 可直接运行）
- 开发期间使用 `tsx` 直接运行源码文件
- 产出干净、规整的构建产物，便于发布

### 版本管理

所有包均采用**同步升版（lockstep versioning）**——即共享同一个版本号：

```bash
# Bump patch version (0.5.0 -> 0.5.1)
npm run version:patch

# Bump minor version (0.5.0 -> 0.6.0)
npm run version:minor

# Bump major version (0.5.0 -> 1.0.0)
npm run version:major
```

这些命令会自动完成以下操作：
1. 更新所有包的版本号
2. 同步包间依赖的版本号
3. 更新 package-lock.json

### 发布

完整的发布流程参见 [PUBLISHING.md](PUBLISHING.md)。

简要流程如下：
```bash
# Dry run to see what would be published
npm run publish:dry

# Publish all packages to npm
npm run publish:all
```

## 许可证

MIT
