'use strict';

// scripts/office-regen-flat-layout.js
//
// 重新生成 `src/office/fixtures/office-layout-flat.json` —— 这是 flat 投影的
// 运行时布局 fixture，由 office-layout-compiler.js 从
// 「编辑草稿 + 等距拓扑」编译而来，**不要手改**（文件头也这么写着）。
//
// 什么时候需要跑：
//   - 改了 office-layout-compiler.js（节点/边/坐标/座位分配逻辑）
//   - 改了 test/fixtures/office-layout-flat-draft.json（家具/工位草稿）
//   - 改了 src/office/fixtures/office-layout.json（等距拓扑）
//
// 用法：node scripts/office-regen-flat-layout.js
//
// 2026-10-30：这个脚本原先只以 /tmp/gen-flat.js 的形式存在于开发机临时目录，
// 一旦 /tmp 被清理就无法重新生成布局。这里收编进仓库并改为基于 __dirname
// 的相对路径，任何人 clone 后都能跑。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.join(__dirname, '..');
const { compileOfficeLayout } = require(path.join(REPO, 'src/office/runtime/office-layout-compiler.js'));
const { LAYOUT_ASSETS, DRAFT_WIDTHS, CHARACTER_FOOT_RATIO } = require(path.join(REPO, 'src/office/layout-assets.js'));

const DRAFT_PATH = path.join(REPO, 'test/fixtures/office-layout-flat-draft.json');
const TOPOLOGY_PATH = path.join(REPO, 'src/office/fixtures/office-layout.json');
const OUTPUT_PATH = path.join(REPO, 'src/office/fixtures/office-layout-flat.json');

const draft = JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
const topology = JSON.parse(fs.readFileSync(TOPOLOGY_PATH, 'utf8'));
const sourceDraftSha256 = crypto.createHash('sha256').update(fs.readFileSync(DRAFT_PATH)).digest('hex');

const result = compileOfficeLayout({
  draft,
  assets: LAYOUT_ASSETS,
  draftWidths: DRAFT_WIDTHS,
  characterFoot: CHARACTER_FOOT_RATIO,
  topology: { nodes: topology.nodes, edges: topology.edges },
  sourceDraftSha256,
});

if (!result.ok) {
  console.error('FAILED', result.code, JSON.stringify(result.detail));
  process.exit(1);
}
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(result.layout, null, 2)}\n`);
const { nodes, edges } = result.layout;
console.log(`GENERATED ${path.relative(REPO, OUTPUT_PATH)} (${nodes.length} nodes, ${edges.length} edges)`);
