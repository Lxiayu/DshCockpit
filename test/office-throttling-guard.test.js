// test/office-throttling-guard.test.js — 防止虚拟办公室再次被节流
//
// ============================================================================
// 这个测试存在的原因（2026-11-02 真机事故）
//
//   有人（就是我）把 office 视图的 backgroundThrottling 改成动态节流，
//   理由是原注释"后台也要保持推送"看起来只是推测。
//
//   后果：用户打开虚拟办公室**一片空白**，切走再切回也不恢复。
//
//   链条：
//     节流 → 渲染循环降到 1Hz → fps-monitor latch LOW_FPS_PERSISTENT
//     → 该状态设计上**不可自动恢复** → 永久白屏
//
//   当时还给出了"主进程 -272MB"的 A/B 数据 —— 那是**假收益**：
//   省下的内存正是把干活的渲染循环掐死了。
//
// ============================================================================
// 为什么用静态断言而不是运行时测试
//
//   这个 bug 的触发条件是"帧率真的掉下来"，在 CI 上既不稳定也很难造。
//   但**错误的代码形状**是确定的：office 的 webPreferences 里
//   backgroundThrottling 必须是 false。
//
//   静态断言能100% 拦住"有人再去改成 true 或改成动态设置"。
// ============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WM = fs.readFileSync(path.join(ROOT, 'src', 'window-manager.js'), 'utf8');

/**
 * 取 officeShellView 的 webPreferences 段。
 *
 * 注意：不能简单按"下一个 WebContentsView"切 —— office 那段带着很长的
 * 中文警示注释，而下一个视图在几百行之后。所以按**括号配对**切，
 * 这样注释再长也不会切错。
 */
function officeViewBlock() {
  const start = WM.indexOf('officeShellView = new WebContentsView({');
  assert.ok(start >= 0, 'officeShellView 的创建代码必须存在');
  // 从 start 起找第一处 backgroundThrottling 声明（中间隔多少注释都不影响）
  const throttling = WM.indexOf('backgroundThrottling:', start);
  assert.ok(throttling > start, 'office 的 webPreferences 里必须有 backgroundThrottling');
  return WM.slice(start, throttling + 40);
}

test('office view MUST keep backgroundThrottling: false', () => {
  const block = officeViewBlock();
  assert.match(
    block,
    /backgroundThrottling:\s*false/,
    '办公室是持续运行的仿真+WebGL 循环；节流会让 fps-monitor latch 到不可恢复的'
      + ' LOW_FPS_PERSISTENT，表现为永久白屏（2026-11-02 真机事故）',
  );
  assert.doesNotMatch(
    block,
    /backgroundThrottling:\s*true/,
    'office 的 backgroundThrottling 绝不能是 true',
  );
});

test('office view must NOT be part of any dynamic throttling loop', () => {
  // 曾经的写法：向一组视图循环调用 setBackgroundThrottling(!visible)
  // 只要 office 在那个数组里，就可能被节流。
  // 只关心**含 setBackgroundThrottling** 的循环体
  const loops = (WM.match(/for \(const view of \[[^\]]*\]\)[\s\S]{0,400}?setBackgroundThrottling/g) || []);
  for (const loop of loops) {
    assert.doesNotMatch(
      loop,
      /officeShellView/,
      'officeShellView 不能出现在 setBackgroundThrottling 的循环里：'
        + '它的降级态不可恢复（见 window-manager.js 顶部注释）',
    );
  }
});

test('if office is ever explicitly un-throttled, it must be by name (never in a loop)', () => {
  // 允许的写法：if (officeShellView) officeShellView.webContents.setBackgroundThrottling(false)
  // 不允许：把 office 塞进按可见性计算的循环
  const idx = WM.indexOf('officeShellView.webContents.setBackgroundThrottling');
  if (idx === -1) return; // 当前版本没有这行，正常
  // 出现在循环体内就是错的
  const before = WM.slice(Math.max(0, idx - 400), idx);
  assert.doesNotMatch(
    before,
    /for \(const view of \[[^\]]*officeShellView/,
    'office 的节流设置必须是显式点名，不能跟着可见性循环走',
  );
});

test('every backgroundThrottling: false carries a Chinese explanation', () => {
  // 注释不是形式主义：这个坑的完整因果链写在那里，删了就会有人再踩。
  const re = /backgroundThrottling:\s*false,/g;
  let m;
  let checked = 0;
  while ((m = re.exec(WM)) !== null) {
    checked += 1;
    const before = WM.slice(Math.max(0, m.index - 900), m.index);
    assert.match(
      before,
      /[\u4e00-\u9fa5]/,
      '每个 backgroundThrottling: false 前面都该有中文说明（为什么不能改）',
    );
  }
  assert.ok(checked >= 3, `expected at least 3 throttling declarations, saw ${checked}`);
});

test('the fps-monitor keeps its "no self recovery" contract', () => {
  // 如果哪天有人给 monitor 加了自动恢复，那 office 白屏的后果就变了；
  // 这个断言保证我们知道自己在改什么。
  const FM = fs.readFileSync(path.join(ROOT, 'src', 'office', 'render', 'fps-monitor.js'), 'utf8');
  assert.match(FM, /latch/i, 'fps-monitor 的 latch 语义必须还在');
  assert.match(FM, /No automatic|never re-arms itself|不可自动恢复/i,
    'fps-monitor 必须继续声明"不自动恢复"，否则白屏的因果链会变');
});
