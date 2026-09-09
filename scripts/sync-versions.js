#!/usr/bin/env node

/**
 * @file monorepo 包间依赖版本锁步同步脚本
 * @description 同步 monorepo 内各包之间的依赖版本：将下游包中
 *   @mariozechner/pi-tui 和 @mariozechner/pi-agent 的依赖声明
 *   更新为对应包当前的版本号，保证各包版本锁步一致。
 *   配合 `npm run version:patch/minor/major` 在提升版本后使用。
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// monorepo 各子包所在目录
const packagesDir = join(process.cwd(), 'packages');

// 读取 tui / agent / pods 三个包的 package.json，获取各自当前版本
const tui = JSON.parse(readFileSync(join(packagesDir, 'tui/package.json'), 'utf8'));
const agent = JSON.parse(readFileSync(join(packagesDir, 'agent/package.json'), 'utf8'));
const pods = JSON.parse(readFileSync(join(packagesDir, 'pods/package.json'), 'utf8'));

// 打印当前各包版本，便于人工核对
console.log('Current versions:');
console.log(`  @mariozechner/pi-tui: ${tui.version}`);
console.log(`  @mariozechner/pi-agent: ${agent.version}`);
console.log(`  @mariozechner/pi: ${pods.version}`);

// 更新 agent 包对 tui 的依赖：改为 ^<tui 当前版本> 并写回 package.json
if (agent.dependencies['@mariozechner/pi-tui']) {
  const oldVersion = agent.dependencies['@mariozechner/pi-tui'];
  agent.dependencies['@mariozechner/pi-tui'] = `^${tui.version}`;
  writeFileSync(join(packagesDir, 'agent/package.json'), JSON.stringify(agent, null, '\t') + '\n');
  console.log(`\nUpdated agent's dependency on pi-tui: ${oldVersion} → ^${tui.version}`);
}

// 更新 pods 包对 agent 的依赖：改为 ^<agent 当前版本> 并写回 package.json
if (pods.dependencies['@mariozechner/pi-agent']) {
  const oldVersion = pods.dependencies['@mariozechner/pi-agent'];
  pods.dependencies['@mariozechner/pi-agent'] = `^${agent.version}`;
  writeFileSync(join(packagesDir, 'pods/package.json'), JSON.stringify(pods, null, '\t') + '\n');
  console.log(`Updated pods' dependency on pi-agent: ${oldVersion} → ^${agent.version}`);
}

// 同步完成提示
console.log('\n✅ Version sync complete!');