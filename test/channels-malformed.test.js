// test/channels-malformed.test.js — TD-32：IM 通道的恶意输入与准入风险。
//
// 第一性原理：协议解析的失效模式不是"崩溃"，而是"静默产错数据"
//
//   `pbbp2.js` 是零依赖自研的二进制帧编解码，处理的是**来自网络**的字节。
//   审计指出它"无 fuzz 测试"——原有的 channels-c6 只做 encode/decode 往返。
//
//   往返测试证明的是"我们自己编的能自己解"，完全不覆盖"别人编的恶意帧"。
//   而真实的攻击面正是后者：WebSocket 上收到的字节不由我们控制。
//
//   这里覆盖三类恶意输入：
//     1. 截断（声明长度 > 实际可用）
//     2. 超长（varint 无限续位）
//     3. 不支持的 wire type
//
//   重点不是"会不会抛"，而是**不能静默产错数据**。
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { encodeFrame, decodeFrame, headerMap } = require('../src/channels/pbbp2.js');
const allowlist = require('../src/channels/allowlist.js');

// ============================================================ pbbp2 编解码

test('pbbp2: a legitimate frame round-trips (baseline — the codec must still work)', () => {
  const frame = {
    SeqID: 42, LogID: 7, service: 1, method: 1,
    headers: [{ key: 'type', value: 'event' }, { key: 'sum', value: '1' }],
    payloadEncoding: 'json', payloadType: 'application/json',
    payload: new Uint8Array([123, 125]),
  };
  const decoded = decodeFrame(encodeFrame(frame));
  assert.strictEqual(decoded.SeqID, 42);
  assert.strictEqual(decoded.service, 1);
  assert.strictEqual(decoded.method, 1);
  assert.deepStrictEqual(headerMap(decoded), { type: 'event', sum: '1' });
  assert.strictEqual(decoded.payloadEncoding, 'json');
  assert.deepStrictEqual([...decoded.payload], [123, 125]);
});

test('pbbp2: an EMPTY buffer decodes to a zeroed frame (no crash)', () => {
  const decoded = decodeFrame(Buffer.alloc(0));
  assert.strictEqual(decoded.SeqID, 0);
  assert.deepStrictEqual(decoded.headers, []);
});

// ---------------------------------------------------------- 截断类恶意输入

test('pbbp2: a truncated varint is rejected, not silently zeroed', () => {
  // 0x08 = field 1 varint, 然后给一个续位字节但不给后续
  assert.throws(() => decodeFrame(Buffer.from([0x08, 0x80])), /truncated varint/);
});

test('pbbp2: a length-delimited field claiming more bytes than available is rejected', () => {
  // 0x2a = field 5 (headers), wireType 2; len=100 但只给 3 字节
  assert.throws(() => decodeFrame(Buffer.from([0x2a, 0x64, 0x0a, 0x01, 0x41])),
    /truncated length-delimited field/);
});

test('pbbp2: a truncated HEADER field is rejected (TD-32 fix — was silently truncated)', () => {
  // 外层 header 切片是 2 字节 [0x0a, 0x32]：
  // 内部 field 1 声明 len=50，但切片内只剩 0 字节。
  // 修复前：subarray 静默截断 → 返回 {key:'',value:''}，且 pos.i 越界后循环退出。
  // 修复后：抛 truncated header field —— 损坏必须可见。
  assert.throws(() => decodeFrame(Buffer.from([0x2a, 0x02, 0x0a, 0x32])),
    /truncated header field/);
});

test('pbbp2: a header whose own declared length exceeds the slice is rejected', () => {
  // header 切片 1 字节 [0x0a]：tag 完整但 len 字节缺失。
  // 抛的是 truncated varint（比 truncated header field 更精确）——
  // 断言只要求「被拒绝」，不锁死具体消息：两者都是正确的拒绝方式。
  assert.throws(() => decodeFrame(Buffer.from([0x2a, 0x01, 0x0a])), /truncated/);
});

// -------------------------------------------------------- 畸形 varint

test('pbbp2: an over-long varint (63+ bits) is rejected', () => {
  // 10 个续位字节 → shift 超过 63
  const bytes = Buffer.from([0x08, ...Array(10).fill(0x80)]);
  assert.throws(() => decodeFrame(bytes), /varint too long/);
});

test('pbbp2: a varint with excessive continuation bytes does not hang', () => {
  // 这条测的是"不会无限循环"——超时就是失败
  const bytes = Buffer.from([0x08, ...Array(20).fill(0xff), 0x01]);
  assert.throws(() => decodeFrame(bytes));
});

// ---------------------------------------------------- 不支持的 wire type

test('pbbp2: unsupported wire types are rejected explicitly', () => {
  // wireType 3 (start group), 4 (end group), 5 (fixed32), 6/7
  for (const wt of [3, 4, 5, 6, 7]) {
    const tag = (1 * 8) + wt;
    assert.throws(() => decodeFrame(Buffer.from([tag])), /unsupported wire type/,
      `wireType ${wt} must be rejected`);
  }
});

test('pbbp2: unknown FIELDS are skipped, not rejected (protobuf forward-compat)', () => {
  // 与"不支持的 wire type"不同：未知字段号 + 已知 wire type 应被跳过。
  // 这是必须保留的行为——服务端加字段不能让连接断掉。
  const buf = encodeFrame({ SeqID: 5 });
  const extra = Buffer.concat([buf, Buffer.from([0x50, 0x01])]); // field 10 varint
  const decoded = decodeFrame(extra);
  assert.strictEqual(decoded.SeqID, 5, 'the known field still parsed');
});

// ---------------------------------------------------------- 边界值

test('pbbp2: a very large seq id round-trips without precision loss beyond 2^53', () => {
  // 协议里 SeqID 是 uint64，JS number 只能精确到 2^53。
  // 这里不做"修复"，只记录行为：小于 2^53 必须精确。
  const big = Number.MAX_SAFE_INTEGER;
  assert.strictEqual(decodeFrame(encodeFrame({ SeqID: big })).SeqID, big);
});

test('pbbp2: zero-length payload and payloadType are handled', () => {
  const decoded = decodeFrame(encodeFrame({ SeqID: 1, payload: new Uint8Array(0) }));
  assert.strictEqual(decoded.SeqID, 1);
  assert.strictEqual(decoded.payload.length, 0);
});

// ========================================================== allowlist 风险

test('allowlist: three distinct admission modes are reported honestly', () => {
  assert.strictEqual(allowlist.describeRisk([]).mode, 'pairing');
  assert.strictEqual(allowlist.describeRisk(['u1', 'grp_*']).mode, 'allowlist');
  assert.strictEqual(allowlist.describeRisk(['*']).mode, 'open');
  assert.strictEqual(allowlist.describeRisk(['*']).open, true);
});

test('allowlist: empty list rejects everyone (pairing mode is the default)', () => {
  // 这一点原实现就做得好，锁住它防止回退。
  assert.strictEqual(allowlist.isAllowed([], 'anyone'), false);
  assert.strictEqual(allowlist.isAllowed(null, 'anyone'), false);
  assert.strictEqual(allowlist.isAllowed(undefined, 'anyone'), false);
});

test('allowlist: a stranger is rejected by an explicit list', () => {
  assert.strictEqual(allowlist.isAllowed(['u1', 'u2'], 'stranger'), false);
  assert.strictEqual(allowlist.isAllowed(['grp_*'], 'user_1'), false);
});

test('allowlist: `*` opens the gate to ANYONE (this is the risk TD-32 names)', () => {
  // 后果不是"方便一点"：任何知道这个 bot 的人都能用 runPrompt
  // 在用户工作区里跑任意 prompt。所以它必须是一个需要二次确认的开关。
  assert.strictEqual(allowlist.isAllowed(['*'], 'total-stranger'), true);
});

test('allowlist: widensToOpen is true ONLY when moving into open mode', () => {
  // 二次确认只在这一种情况下打扰用户；其他改动都是收敛或持平。
  assert.strictEqual(allowlist.widensToOpen(['u1'], ['u1', '*']), true);
  assert.strictEqual(allowlist.widensToOpen([], ['*']), true);

  assert.strictEqual(allowlist.widensToOpen(['u1'], ['u1', 'u2']), false, 'adding an id is not a widening to open');
  assert.strictEqual(allowlist.widensToOpen(['*'], []), false, 'closing the gate needs no warning');
  assert.strictEqual(allowlist.widensToOpen(['*'], ['*']), false, 'still open is not a new widening');
  assert.strictEqual(allowlist.widensToOpen(['*'], ['u1']), false, 'narrowing is always fine');
});

test('allowlist: the OPEN_MARKER is a named constant (no scattered "*" literals)', () => {
  assert.strictEqual(allowlist.OPEN_MARKER, '*');
});

test('allowlist: parseAllowFrom dedupes and caps entries', () => {
  const parsed = allowlist.parseAllowFrom('u1, u2\nu1;u3');
  assert.deepStrictEqual(parsed, ['u1', 'u2', 'u3'], 'dedupe + split on comma/newline/semicolon');

  const many = Array.from({ length: 300 }, (_, i) => `u${i}`).join(',');
  assert.strictEqual(allowlist.parseAllowFrom(many).length, allowlist.MAX_ENTRIES,
    'a human-edited card must not grow without bound');
});

test('allowlist: whitespace-only entries are dropped (an empty entry must not match anyone)', () => {
  assert.deepStrictEqual(allowlist.parseAllowFrom('  ,  , u1 , '), ['u1']);
  assert.strictEqual(allowlist.isAllowed(['  '], 'anyone'), false);
});

// ------------------------------------------------- 与 receivers 的接线

test('allowlist: admission runs BEFORE runPrompt (the gate cannot be bypassed)', () => {
  // 这是整套机制的关键：如果 isAllowed 在 runPrompt 之后，白名单就是装饰品。
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'channels', 'receivers', 'base.js'), 'utf8');
  const gateAt = src.indexOf('d.isAllowed(');
  const runAt = src.indexOf('d.runPrompt(');
  assert.ok(gateAt !== -1, 'the admission check must exist');
  assert.ok(runAt !== -1, 'the runner call must exist');
  assert.ok(gateAt < runAt, 'admission MUST be checked before the prompt runs');
});

// ============================================ 两阶段写入（channel-manager）

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChannelManager } = require('../src/channels/channel-manager.js');

function mkManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-td32-'));
  // 注意：settings 桩必须**真的保存** imChannels，否则 saveConfig 的写入会消失，
  // 表现为"setAllowFrom 返回 ok 但 statusAll 读不到"。这是测试桩的陷阱，
  // 不是产品代码的问题——真实的 SettingsStore 会持久化。
  const state = { imChannels: [] };
  const settings = {
    get: () => ({ imChannels: state.imChannels }),
    patch: (p) => { if (p && p.imChannels) state.imChannels = p.imChannels; },
  };
  return createChannelManager({
    userDataDir: dir, settings, safeStorage: null, log: () => {}, lang: () => 'zh',
  });
}

test('manager TD-32: opening a channel to `*` REQUIRES explicit confirmation', () => {
  const mgr = mkManager();
  mgr.setAllowFrom('feishu', 'user_1'); // start closed-ish

  const denied = mgr.setAllowFrom('feishu', 'user_1, *');
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.code, 'OPEN_MODE_CONFIRM_REQUIRED');
  assert.match(denied.reason, /any sender/i);
  assert.deepStrictEqual(denied.pending.allowFrom, ['user_1', '*'],
    'the intended value is returned so the UI can retry without re-parsing');

  // 关键：拒绝时**没有写入**
  const after = mgr.statusAll().find((c) => c.id === 'feishu');
  assert.strictEqual(after.admissionOpen, false, 'a refused widening must not persist');
});

test('manager TD-32: a confirmed widening is persisted', () => {
  const mgr = mkManager();
  mgr.setAllowFrom('feishu', 'user_1');
  const ok = mgr.setAllowFrom('feishu', 'user_1, *', { confirmOpen: true });
  assert.strictEqual(ok.ok, true);
  const after = mgr.statusAll().find((c) => c.id === 'feishu');
  assert.strictEqual(after.admissionOpen, true);
  assert.strictEqual(after.admissionMode, 'open');
});

test('manager TD-32: NON-widening changes need no confirmation (no alert fatigue)', () => {
  // 频繁确认会让用户养成"闭眼确认"的习惯，那样真正的危险提示也会失效。
  const mgr = mkManager();
  assert.strictEqual(mgr.setAllowFrom('feishu', 'user_1').ok, true, 'adding an id is fine');
  assert.strictEqual(mgr.setAllowFrom('feishu', 'user_1, user_2').ok, true, 'adding more ids is fine');
  assert.strictEqual(mgr.setAllowFrom('feishu', '').ok, true, 'closing back to pairing is fine');
});

test('manager TD-32: statusAll reports the admission mode for every channel', () => {
  const mgr = mkManager();
  const initial = mgr.statusAll().find((c) => c.id === 'feishu');
  assert.strictEqual(initial.admissionMode, 'pairing', 'default is pairing (reject all)');
  assert.strictEqual(initial.admissionOpen, false);

  mgr.setAllowFrom('feishu', 'user_1');
  assert.strictEqual(mgr.statusAll().find((c) => c.id === 'feishu').admissionMode, 'allowlist');
});

test('manager TD-32: an unknown channel is rejected before any confirmation logic', () => {
  const mgr = mkManager();
  const r = mgr.setAllowFrom('not-a-channel', '*');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown-channel');
});
