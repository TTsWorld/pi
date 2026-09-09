> 中文版译自 [PUBLISHING.md](PUBLISHING.md)，如与英文原文有出入，以英文原文为准。

# 发布指南

## 发布流程

### 1. 发布前检查

```bash
# Clean everything and rebuild from scratch
npm run clean
npm run build

# Run all checks
npm run check

# Test packages work correctly
cd packages/agent && npx tsx src/cli.ts --help
cd packages/pods && npx tsx src/cli.ts --help
```

### 2. 版本号提升

所有包采用 lockstep 版本策略（统一版本号，即所有包始终使用相同的版本号）：

```bash
# Patch version bump (0.5.0 -> 0.5.1)
npm run version:patch

# Minor version bump (0.5.0 -> 0.6.0)
npm run version:minor  

# Major version bump (0.5.0 -> 1.0.0)
npm run version:major
```

该命令会自动完成：
- 更新所有包的版本号
- 同步包与包之间的依赖版本

### 3. 提交并打标签

```bash
# Commit the version bump
git add -A
git commit -m "Release v0.5.1"

# Tag the release
git tag -a v0.5.1 -m "Release v0.5.1"

# Push to GitHub
git push origin main --tags
```

### 4. 发布到 npm

```bash
# Dry run first (see what would be published)
npm run publish:dry

# If everything looks good, publish for real
npm run publish:all
```

该命令会：
1. 清理所有 dist 目录
2. 按依赖顺序构建所有包
3. 运行所有检查
4. 以 public access 将所有包发布到 npm

### 5. 验证发布结果

```bash
# Check npm registry
npm view @mariozechner/pi-tui
npm view @mariozechner/pi-agent  
npm view @mariozechner/pi

# Test installation
npx @mariozechner/pi --help
npx @mariozechner/pi-agent --help
```

## 备注

- 所有包发布时均带 `--access public` 标志
- 每个包中的 `prepublishOnly` 脚本会确保构建前先做干净构建
- 包之间的依赖使用 `^` 版本范围，以保留灵活性
- monorepo 本身（`pi-monorepo`）是私有包，不会发布
