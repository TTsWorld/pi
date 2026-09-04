#!/usr/bin/env node

/**
 * @file sync-versions.js
 * @description monorepo 版本同步脚本 —— 三包 lockstep 发版后回写内部依赖的 ^version
 *
 * 主要功能：
 * - 读取 packages/tui、packages/agent、packages/pods 三个包 package.json 中的当前版本号
 * - 将 agent 对 @mariozechner/pi-tui 的依赖改写为 `^<tui.version>`
 * - 将 pods 对 @mariozechner/pi-agent 的依赖改写为 `^<agent.version>`
 * - 将修改后的 package.json 回写到磁盘
 *
 * 使用场景：`npm version patch -ws --no-git-tag-version` 只会 bump 各包自身的
 * version 字段，不会更新包与包之间的内部依赖版本，因此每次 lockstep 发版后
 * 需要运行本脚本补齐（见根 package.json 中的 version:patch/minor/major 脚本）。
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** packages 目录的绝对路径（基于脚本运行时的工作目录，须在仓库根目录下执行） */
const packagesDir = join(process.cwd(), 'packages');

// 读取三个包当前的 package.json（含刚被 npm version bump 过的 version 字段）。
// 三包采用 lockstep（统一版本号）策略，因此这里读到的版本即本次发版的新版本，
// 可直接用作内部依赖改写的目标版本
const tui = JSON.parse(readFileSync(join(packagesDir, 'tui/package.json'), 'utf8'));
const agent = JSON.parse(readFileSync(join(packagesDir, 'agent/package.json'), 'utf8'));
const pods = JSON.parse(readFileSync(join(packagesDir, 'pods/package.json'), 'utf8'));

// 打印当前版本，便于发版时人工核对
console.log('Current versions:');
console.log(`  @mariozechner/pi-tui: ${tui.version}`);
console.log(`  @mariozechner/pi-agent: ${agent.version}`);
console.log(`  @mariozechner/pi: ${pods.version}`);

// 更新 agent 包对 tui 的内部依赖：改写为 `^<tui.version>`。
// lockstep 下两者版本号始终一致，加 `^` 前缀表示允许同一主版本内的小版本/补丁更新
if (agent.dependencies['@mariozechner/pi-tui']) {
  const oldVersion = agent.dependencies['@mariozechner/pi-tui'];
  agent.dependencies['@mariozechner/pi-tui'] = `^${tui.version}`;
  // 回写 package.json：缩进保持 '\t'（与仓库 JSON 风格一致），并在文件末尾补换行符
  writeFileSync(join(packagesDir, 'agent/package.json'), JSON.stringify(agent, null, '\t') + '\n');
  console.log(`\nUpdated agent's dependency on pi-tui: ${oldVersion} → ^${tui.version}`);
}

// 更新 pods 包对 agent 的内部依赖：改写为 `^<agent.version>`（与上面对 tui 的处理同理）
if (pods.dependencies['@mariozechner/pi-agent']) {
  const oldVersion = pods.dependencies['@mariozechner/pi-agent'];
  pods.dependencies['@mariozechner/pi-agent'] = `^${agent.version}`;
  // 回写 pods 的 package.json，格式要求同上
  writeFileSync(join(packagesDir, 'pods/package.json'), JSON.stringify(pods, null, '\t') + '\n');
  console.log(`Updated pods' dependency on pi-agent: ${oldVersion} → ^${agent.version}`);
}

// 全部同步完成
console.log('\n✅ Version sync complete!');