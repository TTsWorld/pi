#!/usr/bin/env node
/**
 * 机械校验：确认注释 agent 只加了注释、没改代码。
 *
 * 原理：把「注释行与空行」从 HEAD 版本和当前版本中都过滤掉，
 * 剩下的纯代码行序列必须完全一致，否则说明代码被改动。
 *
 * 用法：
 *   node docs/verify-annotations.mjs            # 校验 src/ scripts/ 下所有 git 改动文件
 *   node docs/verify-annotations.mjs <file...>  # 校验指定文件
 *
 * 退出码：0 = 全部通过；1 = 存在违规（附明细）
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const pkgRoot = new URL("..", import.meta.url).pathname;

/** 判断一行是否为「注释行或空行」（JSDoc 每行均有星号前缀；块注释首行有斜杠星号、尾行有星号斜杠） */
const isCommentOrBlank = (line) => {
	const t = line.trim();
	return (
		t === "" ||
		t.startsWith("//") ||
		t.startsWith("/*") ||
		t.startsWith("*") ||
		t.startsWith("*/")
	);
};

/** 过滤掉注释行与空行，返回纯代码行序列 */
const codeLines = (text) => text.split("\n").filter((l) => !isCommentOrBlank(l));

/**
 * 去掉代码行行尾的 `// ...` 注释：取行内「最后一个」`//` 起始的位置截断。
 * 为什么用 lastIndexOf 而不是第一个：正则字面量可能含引号（如 /model'?s/）会骗过
 * 简单的字符串扫描；而正则内的 `/` 必须转义为 `\/`，字符串里的 URL（http://x）
 * 也不是行内最后一个 `//`。用于二级宽松比较：允许翻译行尾英文注释，
 * 代码部分必须逐字相同。差异行会全部打印供人工确认。
 */
const stripTrailingComment = (line) => {
	const idx = line.lastIndexOf("//");
	return idx >= 0 ? line.slice(0, idx).trimEnd() : line;
};

const args = process.argv.slice(2);
const targets = args.length
	? args
	: execSync("git diff --name-only HEAD -- src scripts", { cwd: pkgRoot })
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean);

if (targets.length === 0) {
	console.log("没有待校验的改动文件");
	process.exit(0);
}

let failures = 0;
for (const file of targets) {
	let headText;
	try {
		headText = execSync(`git show ${JSON.stringify(`HEAD:./${file}`)}`, {
			cwd: pkgRoot,
			maxBuffer: 20 * 1024 * 1024,
		}).toString();
	} catch {
		console.log(`⚠️  ${relative(pkgRoot, file)}: 不在 HEAD 中（新文件），跳过`);
		continue;
	}
	const curText = readFileSync(`${pkgRoot}/${file}`, "utf8");
	const headCode = codeLines(headText);
	const curCode = codeLines(curText);

	const added = curText.split("\n").length - headText.split("\n").length;
	const exactMatch =
		headCode.length === curCode.length && headCode.every((l, i) => l === curCode[i]);
	if (exactMatch) {
		console.log(`✅ ${file}（+${added} 行，代码零改动）`);
	} else {
		// 二级宽松比较：允许代码行的「行尾注释」被翻译/增删（代码前缀必须逐字相同）
		const trailingOnly =
			headCode.length === curCode.length &&
			headCode.every((l, i) => stripTrailingComment(l) === stripTrailingComment(curCode[i]));
		if (trailingOnly) {
			console.log(`✅ ${file}（+${added} 行，代码零改动；${headCode.filter((l, i) => l !== curCode[i]).length} 行仅行尾注释变化：）`);
			headCode.forEach((l, i) => {
				if (l !== curCode[i]) {
					console.log(`     - ${l.trim().slice(0, 100)}`);
					console.log(`     + ${curCode[i].trim().slice(0, 100)}`);
				}
			});
		} else {
		failures++;
		console.log(`❌ ${file}: 代码行序列与 HEAD 不一致！`);
		// 定位第一处差异，便于人工复查
		const max = Math.max(headCode.length, curCode.length);
		for (let i = 0; i < max; i++) {
			if (headCode[i] !== curCode[i]) {
				console.log(`   首个差异在第 ${i + 1} 个代码行：`);
				console.log(`   HEAD: ${headCode[i] ?? "<无>"}`);
				console.log(`   当前: ${curCode[i] ?? "<无>"}`);
				break;
			}
		}
	}
	}
}

console.log(
	`\n共校验 ${targets.length} 个文件，${failures === 0 ? "全部通过 ✅" : `${failures} 个违规 ❌`}`,
);
process.exit(failures === 0 ? 0 : 1);
