'use strict';

// 2026-10-30（用户提问："闲聊状态下出现工作任务，能否正常中断闲聊→走到工位？"）：
// 这个问题之前只有 scheduler 层的 interruptForTask 单测，没有端到端覆盖。
// 本用例验证完整链路：两人 seated 闲聊 → 给其中一人派任务 → 它退出闲聊、
// 走到自己的工位、进入 work 相位。三个 seed 都要通过。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const officeModule = require('../src/office/office-module.js');
const assetPack = require('../src/office/runtime/asset-pack.js');

const ROOT = path.join(__dirname, '..');
const PACK_ROOT = path.join(ROOT, 'resources', 'characters', 'deepseek-default');
const PACK = assetPack.createAssetPack({
  manifest: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'manifest.json'), 'utf8')),
  anchors: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'animation', 'anchors.json'), 'utf8')),
  animations: JSON.parse(fs.readFileSync(path.join(PACK_ROOT, 'animation', 'animations.json'), 'utf8')),
}).pack;
const CORPUS_ROOT = path.join(ROOT, 'resources', 'dialogue');
const DIALOGUE = {
  base: JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, 'base.json'), 'utf8')),
  characterOverrides: JSON.parse(fs.readFileSync(path.join(CORPUS_ROOT, 'characters', 'deepseek-default.json'), 'utf8')),
};
const FLAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'office', 'fixtures', 'office-layout-flat.json'), 'utf8'));
const TICK_MS = officeModule.TICK_MS;

test('a seated chat is interrupted by a new task and the member reaches work', () => {
  for (const seed of ['ci-a', 'ci-b', 'ci-c']) {
    const module = officeModule.createOfficeModule({
      pack: PACK, layout: FLAT, seed, dialogue: DIALOGUE,
      config: { sleepAfterMs: 600000 },
    });
    // 1) 等到真的 seated 闲聊
    let seated = null;
    for (let i = 0; i < Math.round(300000 / TICK_MS); i += 1) {
      module.tickOnce();
      const pair = module.state().employees.filter((e) => e.chatPhase === 'seated');
      if (pair.length >= 2) { seated = pair.map((e) => e.employeeId); break; }
    }
    assert.ok(seated, `${seed}: a seated chat forms within 5 simulated minutes`);
    const target = seated[0];

    // 2) 闲聊中派任务
    let seq = 0;
    const feed = (type, data) => { seq += 1; module.ingestHarnessEvent({ sessionId: 's', type, seq, time: seq, data }); };
    feed('agent/status', { status: 'running' });
    feed('subagent/start', { id: 'c-x', runId: 'run-x', role: target, mode: 'one-shot', label: target });

    // 3) 必须退出闲聊并到达 work
    let leftChat = false;
    let reachedWork = false;
    for (let i = 0; i < Math.round(240000 / TICK_MS); i += 1) {
      module.tickOnce();
      const me = module.state().employees.find((e) => e.employeeId === target);
      if (me.chatPhase === null) leftChat = true;
      if (me.transition && me.transition.kind === 'task-start' && me.transition.phase === 'work') { reachedWork = true; break; }
    }
    assert.equal(leftChat, true, `${seed}: ${target} leaves the chat when a task arrives`);
    assert.equal(reachedWork, true, `${seed}: ${target} reaches the work phase at the own desk`);
  }
});
