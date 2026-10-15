'use strict';

// studio/test/zip.test.js — 零依赖 ZIP 读写器测试（`node --test studio/test/zip.test.js`）。
//
// 纪律（与其它 studio 测试一致）：
//   - 一切写操作只进 fs.mkdtempSync(os.tmpdir()) 沙箱，t.after 里清掉；
//     绝不写仓库任何路径（git status 除本文件外必须干净）；
//   - 不联网、不装包；二进制夹具用可复现的 LCG 伪随机生成（无需 node:crypto）；
//   - 互操作一律 execFileSync + 数组参数（绝不拼 shell 字符串），目标是
//     /usr/bin/zip 与 /usr/bin/unzip。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const zip = require('../lib/zip.js');

const ZIP_CLI = '/usr/bin/zip';
const UNZIP_CLI = '/usr/bin/unzip';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** mkdtemp 沙箱 + t.after 清理（失败路径上也一定清）。 */
function withSandbox(t, prefix = 'zip-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 可复现的伪随机字节（LCG）："不可压缩"就够用，且每次跑都一样。 */
function pseudoRandom(n, seed = 0x9e3779b9) {
  const buf = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    buf[i] = (s >>> 16) & 0xff;
  }
  return buf;
}

/** 从字节流里读出第 n 条中央目录记录（测试自己验我们的产物，不靠被测代码）。 */
function centralEntryAt(buf, n) {
  const eocd = buf.length - 22;
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'fixture: EOCD signature');
  let offset = buf.readUInt32LE(eocd + 16); // central dir offset
  for (let i = 0; i <= n; i++) {
    assert.equal(buf.readUInt32LE(offset), 0x02014b50, `fixture: CD entry ${i} signature`);
    const nameLength = buf.readUInt16LE(offset + 28);
    const entry = {
      name: buf.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: buf.readUInt16LE(offset + 10),
      dosTime: buf.readUInt16LE(offset + 12),
      dosDate: buf.readUInt16LE(offset + 14),
      externalAttrs: buf.readUInt32LE(offset + 38),
      localOffset: buf.readUInt32LE(offset + 42),
    };
    if (i === n) return entry;
    offset += 46 + nameLength + buf.readUInt16LE(offset + 30) + buf.readUInt16LE(offset + 32);
  }
  return null;
}

/** 读出某条 local header 的 DOS 时间字段（验证 mtime 落库）。 */
function localDosTime(buf, localOffset) {
  return { time: buf.readUInt16LE(localOffset + 10), date: buf.readUInt16LE(localOffset + 12) };
}

function expectThrowCode(fn, code) {
  try {
    fn();
  } catch (err) {
    assert.equal(err.code, code, `expected error code ${code}, got ${err.code} (${err.message})`);
    assert.match(err.message, new RegExp(`^${code}: `), 'message leads with the code');
    return err;
  }
  assert.fail(`expected a throw with code ${code}`);
}

// ---------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------

test('crc32: known vector, empty input, unsigned range, string input', () => {
  assert.equal(zip.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(zip.crc32(Buffer.alloc(0)), 0);
  const crc = zip.crc32(Buffer.from('whale-girl walk-left'));
  assert.ok(crc >= 0 && crc <= 0xffffffff, 'crc32 must be an unsigned 32-bit int');
  assert.equal(crc, zip.crc32(Buffer.from('whale-girl walk-left', 'utf8')), 'string input = utf8 bytes');
  assert.notEqual(crc, zip.crc32(Buffer.from('whale-girl walk-righ')));
});

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

test('assertSafePath: accepts relative file paths and directory-shaped names', () => {
  assert.equal(zip.assertSafePath('manifest.json'), 'manifest.json');
  assert.equal(zip.assertSafePath('chars/whale-girl/b.json'), 'chars/whale-girl/b.json');
  assert.equal(zip.assertSafePath('a/b/c/d/e/f.txt'), 'a/b/c/d/e/f.txt');
  assert.equal(zip.assertSafePath('sub/'), 'sub', 'trailing slash is stripped (directory shape)');
  assert.equal(zip.assertSafePath('sub///'), 'sub');
  assert.equal(zip.assertSafePath('角色.json'), '角色.json');
  const deep = `${'d/'.repeat(500)}leaf.txt`; // 512 段，仍在 1024 字符内
  assert.ok(deep.length <= 1024);
  assert.equal(zip.assertSafePath(deep), deep);
});

test('assertSafePath: rejects unsafe paths with ZIP_UNSAFE_PATH', () => {
  const cases = [
    ['empty string', ''],
    ['absolute posix', '/etc/passwd'],
    ['absolute posix (dir)', '/abs/'],
    ['parent traversal', '../escape.txt'],
    ['traversal in the middle', 'chars/../../escape.txt'],
    ['bare parent', '..'],
    ['current dir', '.'],
    ['dot segment', './manifest.json'],
    ['dot segment mid', 'a/./b'],
    ['double slash', 'a//b'],
    ['only slashes', '///'],
    ['windows drive', 'C:\\Windows\\system32'],
    ['drive-relative', 'C:foo'],
    ['UNC path', '\\\\srv\\share\\file'],
    ['backslash separator', 'a\\b'],
    ['NUL byte', 'mani\u0000fest.json'],
    ['too long', 'x'.repeat(1025)],
    ['10427 byte name', `mani${'f'.repeat(1020)}est.json`],
  ];
  for (const [label, value] of cases) {
    expectThrowCode(() => zip.assertSafePath(value), 'ZIP_UNSAFE_PATH');
  }
  for (const [label, value] of [['null', null], ['number', 7], ['object', {}], ['undefined', undefined], ['array', []]]) {
    expectThrowCode(() => zip.assertSafePath(value), 'ZIP_UNSAFE_PATH');
  }
});

// ---------------------------------------------------------------------------
// 写侧基本行为
// ---------------------------------------------------------------------------

test('writeZip: rejects malformed entry specs', () => {
  expectThrowCode(() => zip.writeZip([{ path: '../evil.txt', data: 'x' }]), 'ZIP_UNSAFE_PATH');
  expectThrowCode(() => zip.writeZip([{ path: '', data: 'x' }]), 'ZIP_UNSAFE_PATH');
  expectThrowCode(() => zip.writeZip([{ path: 'sub/', data: 'x' }]), 'ZIP_INVALID_ARGUMENT'); // 不产目录条目
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt' }]), 'ZIP_INVALID_ARGUMENT'); // data / srcPath 缺一个
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 'x', srcPath: '/tmp/x' }]), 'ZIP_INVALID_ARGUMENT'); // 两个都给
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 42 }]), 'ZIP_INVALID_ARGUMENT'); // 数据不是 buffer/string
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 'x' }, { path: 'a.txt', data: 'y' }]), 'ZIP_DUPLICATE');
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 'x' }, 'nope']), 'ZIP_INVALID_ARGUMENT');
  expectThrowCode(() => zip.writeZip('nope'), 'ZIP_INVALID_ARGUMENT');
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 'x' }], { level: 99 }), 'ZIP_INVALID_ARGUMENT');
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 'x' }], { level: 'high' }), 'ZIP_INVALID_ARGUMENT');
  expectThrowCode(() => zip.writeZip([{ path: 'a.txt', data: 'x' }], { mtime: 'not-a-date' }), 'ZIP_INVALID_ARGUMENT');
});

test('writeZip → readZip: round trip of mixed entries with full metadata', () => {
  const text = Buffer.from('{"schemaVersion":1,"id":"whale-girl"}');
  const blob = Buffer.concat([pseudoRandom(512), Buffer.from('walk-left-b01'.repeat(400))]); // 整体明显可压缩
  const archive = zip.writeZip([
    { path: 'manifest.json', data: text },
    { path: 'chars/whale-girl/walk-left/frame-b01.png', data: blob },
    { path: 'dialogues/opening.json', data: 'const x = 1;' },
  ]);

  const entries = zip.readZip(archive);
  assert.equal(entries.length, 3);
  // 写侧排序：按 path 字典序
  assert.deepEqual(
    entries.map((e) => e.path),
    ['chars/whale-girl/walk-left/frame-b01.png', 'dialogues/opening.json', 'manifest.json'],
  );
  const blobEntry = entries[0];
  const dialogueEntry = entries[1];
  const jsonEntry = entries[2];
  assert.ok(blobEntry.data.equals(blob), 'binary bytes survive');
  assert.equal(blobEntry.method, 8, 'compressible payload → deflate');
  assert.ok(blobEntry.compressedSize < blobEntry.size, 'deflate chosen only when smaller');
  assert.equal(blobEntry.size, blob.length);
  assert.equal(blobEntry.crc32, zip.crc32(blob));
  assert.equal(blobEntry.isDirectory, false);
  assert.equal(dialogueEntry.data.toString(), 'const x = 1;', 'string data is stored as utf-8');
  assert.equal(dialogueEntry.crc32, zip.crc32('const x = 1;'));
  assert.ok(jsonEntry.data.equals(text), 'buffer data survives byte-exactly');
  assert.equal(jsonEntry.size, text.length);
  for (const e of entries) {
    assert.ok(e.method === 0 || e.method === 8);
    assert.equal(typeof e.crc32, 'number');
    assert.equal(typeof e.compressedSize, 'number');
  }
});

test('writeZip: bytes are deterministic for identical entries and options', () => {
  const entries = [
    { path: 'manifest.json', data: Buffer.from('{"schemaVersion":1}') },
    { path: 'chars/whale.png', data: pseudoRandom(2048) },
  ];
  const a = zip.writeZip(entries);
  const b = zip.writeZip(entries);
  assert.ok(a.equals(b), 'same entries + options → byte-identical');

  const changed = zip.writeZip([
    { path: 'manifest.json', data: '{"schemaVersion":1}' },
    { path: 'chars/whale.png', data: pseudoRandom(2048).map((byte) => (byte + 1) & 0xff) },
  ]);
  assert.ok(!a.equals(changed), 'one entry byte changed → output must change');

  const withMtime = { mtime: new Date('2021-03-04T05:06:07Z') };
  assert.ok(zip.writeZip(entries, withMtime).equals(zip.writeZip(entries, withMtime)));
  assert.ok(!zip.writeZip(entries, withMtime).equals(a), 'mtime changes the bytes');
  assert.ok(zip.writeZip(entries, { mtime: '2021-03-04T05:06:07Z' }).equals(zip.writeZip(entries, withMtime)), 'Date and date-string mtime agree');

  const stored = zip.writeZip(entries, { compress: false });
  assert.deepEqual(
    zip.listZip(stored).map((e) => e.method),
    [0, 0],
    'compress:false stores everything',
  );
  const storedRead = zip.readZip(stored);
  assert.ok(storedRead.find((e) => e.path === 'chars/whale.png').data.equals(entries[1].data));
  assert.ok(storedRead.find((e) => e.path === 'manifest.json').data.equals(entries[0].data));
});

test('writeZip: default mtime is the fixed 1980 DOS stamp; explicit mtime is honored (UTC, clamped)', () => {
  const defaulted = zip.writeZip([{ path: 'a.txt', data: 'A' }]);
  assert.deepEqual(localDosTime(defaulted, centralEntryAt(defaulted, 0).localOffset), {
    time: 0x0000,
    date: 0x0021,
  }, 'default = 1980-01-01T00:00:00Z');

  const dated = zip.writeZip([{ path: 'a.txt', data: 'A' }], { mtime: new Date('2020-05-06T07:08:09Z') });
  const record = centralEntryAt(dated, 0);
  // time = (7<<11)|(8<<5)|(9>>1) = 14596；date = ((2020-1980)<<9)|(5<<5)|6 = 20646
  assert.deepEqual(localDosTime(dated, record.localOffset), { time: 14596, date: 20646 });

  const beforeEpoch = zip.writeZip([{ path: 'a.txt', data: 'A' }], { mtime: new Date('1969-12-31T23:59:59Z') });
  assert.deepEqual(localDosTime(beforeEpoch, 0), { time: 0, date: 0x21 }, 'pre-1980 clamps to the DOS epoch');

  const farFuture = zip.writeZip([{ path: 'a.txt', data: 'A' }], { mtime: new Date('2200-06-01T00:00:00Z') });
  // 2107-12-31T23:59:58Z → time (23<<11)|(59<<5)|(58>>1) = 49021；date (127<<9)|(12<<5)|31 = 65439
  assert.deepEqual(localDosTime(farFuture, 0), { time: 49021, date: 65439 }, 'post-2107 clamps to the DOS ceiling');

  const fromNumber = zip.writeZip([{ path: 'a.txt', data: 'A' }], { mtime: new Date('2020-05-06T07:08:09Z').getTime() });
  assert.deepEqual(localDosTime(fromNumber, 0), { time: 14596, date: 20646 }, 'numeric epoch ms accepted');
});

test('writeZip: entry ordering is a documented stable sort (path lexicographic)', () => {
  const archive = zip.writeZip([
    { path: 'zzz.txt', data: 'z' },
    { path: 'aaa/bbb.txt', data: 'b' },
    { path: 'manifest.json', data: 'm' },
    { path: 'AAA.txt', data: 'A' },
  ]);
  assert.deepEqual(
    zip.listZip(archive).map((e) => e.path),
    ['AAA.txt', 'aaa/bbb.txt', 'manifest.json', 'zzz.txt'],
    'sorted by JS string (UTF-16 code unit) comparison',
  );
});

test('writeZip: empty archive', () => {
  const archive = zip.writeZip([]);
  assert.equal(archive.length, 22, 'empty archive = EOCD only');
  assert.equal(archive.readUInt32LE(0), 0x06054b50);
  assert.equal(archive.readUInt16LE(10), 0, 'zero entries');
  assert.deepEqual(zip.readZip(archive), []);
  assert.deepEqual(zip.listZip(archive), []);
  assert.equal(zip.extractOne(archive, 'anything.json'), null);
});

test('writeZip: zero-byte file', () => {
  const archive = zip.writeZip([{ path: 'empty.bin', data: Buffer.alloc(0) }, { path: 'empty.txt', data: '' }]);
  const [a, b] = zip.readZip(archive);
  for (const entry of [a, b]) {
    assert.equal(entry.size, 0);
    assert.equal(entry.compressedSize, 0);
    assert.equal(entry.method, 0, 'empty payload is stored (deflate could only add 2 bytes)');
    assert.equal(entry.crc32, 0);
    assert.equal(entry.data.length, 0);
  }
});

test('writeZip: deflate larger than input falls back to stored; one archive mixes both methods', () => {
  const incompressible = pseudoRandom(1024);
  assert.ok(
    zlib.deflateRawSync(incompressible, { level: 9 }).length >= incompressible.length,
    'fixture: this payload really does not benefit from deflate',
  );
  const compressible = Buffer.from('walk-left'.repeat(500));
  const archive = zip.writeZip([
    { path: 'binary.dat', data: incompressible },
    { path: 'text.txt', data: compressible },
  ]);
  const [bin, text] = zip.readZip(archive);
  assert.equal(bin.method, 0, 'incompressible → stored fallback');
  assert.equal(bin.compressedSize, bin.size);
  assert.equal(text.method, 8, 'compressible → deflate');
  assert.ok(text.compressedSize < text.size);
  assert.ok(bin.data.equals(incompressible) && text.data.equals(compressible), 'reader handles both methods');
});

test('writeZip: srcPath entries are read from disk and round-trip', (t) => {
  const dir = withSandbox(t);
  const payload = pseudoRandom(3000);
  const filePath = path.join(dir, 'frame.png');
  fs.writeFileSync(filePath, payload);
  const archive = zip.writeZip([
    { path: 'frames/frame.png', srcPath: filePath },
    { path: 'inline.json', data: '{"a":1}' },
  ]);
  const entries = zip.readZip(archive);
  assert.equal(entries.length, 2);
  const frame = entries.find((e) => e.path === 'frames/frame.png');
  assert.ok(frame.data.equals(payload));
  assert.equal(frame.crc32, zip.crc32(payload));
  expectThrowCode(() => zip.writeZip([{ path: 'missing.bin', srcPath: path.join(dir, 'nope') }]), 'ENOENT');
});

// ---------------------------------------------------------------------------
// 读侧错误处理
// ---------------------------------------------------------------------------

test('readZip: fails closed on an unsafe entry name inside an archive (ZIP_UNSAFE_PATH)', () => {
  const archive = zip.writeZip([{ path: 'payload.bin', data: Buffer.from('pawn') }]);
  const evil = Buffer.from(archive); // 复制一份，原地把条目名改成穿越路径
  const name = Buffer.from('payload.bin');
  const localPos = evil.indexOf(name);
  assert.ok(localPos >= 0);
  evil.fill(Buffer.from('../evil.txt'), localPos, localPos + name.length);
  const centralPos = evil.indexOf(name);
  assert.ok(centralPos > 0, 'the same name also lives in the central directory');
  evil.fill(Buffer.from('../evil.txt'), centralPos, centralPos + name.length);

  const err = expectThrowCode(() => zip.readZip(evil), 'ZIP_UNSAFE_PATH');
  assert.match(err.message, /\.\./);
  expectThrowCode(() => zip.listZip(evil), 'ZIP_UNSAFE_PATH');
  expectThrowCode(() => zip.extractOne(evil, 'payload.bin'), 'ZIP_UNSAFE_PATH');
  expectThrowCode(() => zip.extractOne(evil, '../payload.bin'), 'ZIP_UNSAFE_PATH');
});

test('readZip: truncated archives throw ZIP_TRUNCATED, missing EOCD throws ZIP_NOT_ARCHIVE', () => {
  const archive = zip.writeZip([
    { path: 'a.txt', data: 'A'.repeat(800) },
    { path: 'b.txt', data: 'B'.repeat(800) },
  ]);
  const eocd = archive.length - 22;
  const cdStart = archive.readUInt32LE(eocd + 16);
  const cdSize = archive.readUInt32LE(eocd + 12);
  assert.ok(cdStart + cdSize <= archive.length);

  // 形状一：EOCD 完好，但中央目录只剩 5 字节（下载断在目录区）
  const cutCd = Buffer.concat([archive.subarray(0, cdStart + 5), archive.subarray(eocd)]);
  expectThrowCode(() => zip.readZip(cutCd), 'ZIP_TRUNCATED');

  // 形状二：EOCD 声称中央目录在文件末尾之外（偏移越界）
  const shiftedCd = Buffer.from(archive);
  shiftedCd.writeUInt32LE(archive.length + 5000, eocd + 16);
  expectThrowCode(() => zip.readZip(shiftedCd), 'ZIP_TRUNCATED');

  // 形状三：中央目录里第一条的 local header 偏移被指到文件外
  const shiftedLocal = Buffer.from(archive);
  shiftedLocal.writeUInt32LE(0x7ffffff0, cdStart + 42);
  expectThrowCode(() => zip.readZip(shiftedLocal), 'ZIP_TRUNCATED');

  // 形状四：EOCD 整块没了（流被截断的常见形态）——连目录都找不到
  expectThrowCode(() => zip.readZip(archive.subarray(0, archive.length - 22)), 'ZIP_NOT_ARCHIVE');
});

test('readZip: non-zip input throws ZIP_NOT_ARCHIVE with a clear message', () => {
  expectThrowCode(() => zip.readZip(Buffer.alloc(0)), 'ZIP_NOT_ARCHIVE');
  expectThrowCode(() => zip.readZip(Buffer.alloc(10, 7)), 'ZIP_NOT_ARCHIVE');
  expectThrowCode(() => zip.readZip(pseudoRandom(4096)), 'ZIP_NOT_ARCHIVE');
  expectThrowCode(() => zip.readZip(Buffer.from('this is plainly not a zip archive at all!')), 'ZIP_NOT_ARCHIVE');
  expectThrowCode(() => zip.readZip({ not: 'a buffer' }), 'ZIP_INVALID_ARGUMENT');
});

test('readZip: tolerates trailing garbage after the EOCD', () => {
  const archive = zip.writeZip([{ path: 'a.txt', data: 'hello' }]);
  const padded = Buffer.concat([archive, Buffer.from([0x00, 0x01, 0x02])]);
  assert.equal(archive.readUInt16LE(archive.length - 2), 0, 'fixture: our comment length is 0');
  const [entry] = zip.readZip(padded);
  assert.equal(entry.path, 'a.txt');
  assert.equal(entry.data.toString(), 'hello');
});

test('readZip: reads archives with data descriptors (bit 3) because it trusts the central directory', () => {
  const payloadA = pseudoRandom(2048);
  const payloadB = Buffer.from('walk-left'.repeat(64));
  const archive = zip.writeZip([
    { path: 'a.bin', data: payloadA },
    { path: 'b.txt', data: payloadB },
  ]);

  // 把我们的"老实包"改写成流式工具（Info-ZIP 边写边发）的形态：
  // local header 的 crc/尺寸清零并置 bit 3，数据尾追加 [PK\x07\x08, crc, csize, usize]；
  // 中央目录里的真值不动，所有 local offset / 目录偏移随之平移。
  const eocd = archive.length - 22;
  const cdStart = archive.readUInt32LE(eocd + 16);
  const count = archive.readUInt16LE(eocd + 10);
  const records = [];
  let off = cdStart;
  for (let i = 0; i < count; i++) {
    const nlen = archive.readUInt16LE(off + 28);
    const elen = archive.readUInt16LE(off + 30);
    const clen = archive.readUInt16LE(off + 32);
    records.push({
      crc: archive.readUInt32LE(off + 16),
      csize: archive.readUInt32LE(off + 20),
      usize: archive.readUInt32LE(off + 24),
      localOffset: archive.readUInt32LE(off + 42),
      cdRecord: Buffer.from(archive.subarray(off, off + 46 + nlen + elen + clen)),
    });
    off += 46 + nlen + elen + clen;
  }
  records.sort((a, b) => a.localOffset - b.localOffset); // 写侧顺序 = local 顺序

  const parts = [];
  let cursor = 0; // 已消费到的原包位置
  let emitted = 0; // 新包当前位置
  for (const r of records) {
    const nameLen = archive.readUInt16LE(r.localOffset + 26);
    const extraLen = archive.readUInt16LE(r.localOffset + 28);
    const localEnd = r.localOffset + 30 + nameLen + extraLen;
    parts.push(archive.subarray(cursor, r.localOffset));
    emitted += r.localOffset - cursor;

    const localHeader = Buffer.from(archive.subarray(r.localOffset, localEnd));
    localHeader.writeUInt16LE(localHeader.readUInt16LE(6) | 0x0008, 6); // bit 3 = 数据描述符
    localHeader.writeUInt32LE(0, 14); // crc 清零
    localHeader.writeUInt32LE(0, 18); // compressed size 清零
    localHeader.writeUInt32LE(0, 22); // uncompressed size 清零
    parts.push(localHeader, archive.subarray(localEnd, localEnd + r.csize));

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0); // PK\x07\x08
    descriptor.writeUInt32LE(r.crc, 4);
    descriptor.writeUInt32LE(r.csize, 8);
    descriptor.writeUInt32LE(r.usize, 12);
    parts.push(descriptor);

    r.cdRecord.writeUInt32LE(emitted, 42); // 中央目录记新的 local 偏移
    cursor = localEnd + r.csize;
    emitted += (localEnd - r.localOffset) + r.csize + 16;
  }

  let cdSize = 0;
  for (const r of records) {
    parts.push(r.cdRecord);
    cdSize += r.cdRecord.length;
  }
  const newEocd = Buffer.from(archive.subarray(eocd));
  newEocd.writeUInt32LE(cdSize, 12);
  newEocd.writeUInt32LE(emitted, 16);
  parts.push(newEocd);
  const withDescriptors = Buffer.concat(parts);

  // 夹具自检：bit 3 真的置上了，local header 尺寸真的是 0
  assert.equal(withDescriptors.readUInt16LE(6) & 0x0008, 0x0008);
  assert.equal(withDescriptors.readUInt32LE(18), 0);

  const entries = zip.readZip(withDescriptors);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['a.bin', 'b.txt'],
  );
  assert.ok(entries[0].data.equals(payloadA));
  assert.ok(entries[1].data.equals(payloadB));
  assert.equal(entries[0].crc32, zip.crc32(payloadA));
  assert.equal(entries[1].crc32, zip.crc32(payloadB));
});

test('extractOne: hit, miss, directory request', (t) => {
  const dir = withSandbox(t);
  const archive = zip.writeZip([{ path: 'manifest.json', data: '{"a":1}' }]);
  const archivePath = path.join(dir, 'pack.zip');
  fs.writeFileSync(archivePath, archive);

  const hit = zip.extractOne(archivePath, 'manifest.json');
  assert.ok(Buffer.isBuffer(hit));
  assert.equal(hit.toString(), '{"a":1}');
  assert.ok(zip.extractOne(archive, 'manifest.json').equals(hit), 'path and buffer agree');
  assert.equal(zip.extractOne(archive, 'nope.json'), null);
});

test('listZip: reports method, sizes, crc32 and isDirectory without decompressing', () => {
  const archive = zip.writeZip([
    { path: 'binary.dat', data: pseudoRandom(4096) },
    { path: 'manifest.json', data: 'x'.repeat(2000) },
  ]);
  const listing = zip.listZip(archive);
  assert.deepEqual(
    listing.map((e) => [e.path, e.method, e.size, e.crc32]),
    [
      ['binary.dat', 0, 4096, zip.crc32(pseudoRandom(4096))],
      ['manifest.json', 8, 2000, zip.crc32('x'.repeat(2000))],
    ],
  );
  assert.ok(listing.every((e) => e.compressedSize >= 0 && e.isDirectory === false));
  assert.ok(listing.every((e) => !('data' in e)), 'listZip must not decompress');
});

// ---------------------------------------------------------------------------
// 互操作（必须过 /usr/bin/zip 与 /usr/bin/unzip）
// ---------------------------------------------------------------------------

test('interop: /usr/bin/unzip -p extracts our entries byte-exactly', (t) => {
  const dir = withSandbox(t);
  const text = Buffer.from('hello .dshpack 🐋');
  const binary = pseudoRandom(200000);
  const utf8 = Buffer.from('{"角色":"鲸鱼娘"}');
  const archivePath = path.join(dir, 'ours.zip');
  fs.writeFileSync(
    archivePath,
    zip.writeZip([
      { path: 'sub/a.txt', data: text },
      { path: 'sub/binary.bin', data: binary },
      { path: '角色.json', data: utf8 },
    ]),
  );

  const extractedText = execFileSync(UNZIP_CLI, ['-p', archivePath, 'sub/a.txt'], { maxBuffer: 1 << 22 });
  const extractedBinary = execFileSync(UNZIP_CLI, ['-p', archivePath, 'sub/binary.bin'], { maxBuffer: 1 << 22 });
  const extractedUtf8 = execFileSync(UNZIP_CLI, ['-p', archivePath, '角色.json'], { maxBuffer: 1 << 22 });

  assert.ok(extractedText.equals(text), 'text round-trips through unzip -p');
  assert.ok(extractedBinary.equals(binary), 'binary round-trips through unzip -p');
  assert.ok(extractedUtf8.equals(utf8), 'utf-8 filename round-trips through unzip -p');
  console.log('[hb] interop 1/3: unzip -p reads our archive (text, 200KB binary, UTF-8 name)');
});

test('interop: reads an archive written by /usr/bin/zip (subdir + 200KB binary + UTF-8 name)', (t) => {
  const dir = withSandbox(t);
  const text = Buffer.from('hello');
  const binary = pseudoRandom(200000);
  const utf8 = Buffer.from('{"schemaVersion":1}');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), text);
  fs.writeFileSync(path.join(dir, 'sub', 'binary.bin'), binary);
  fs.writeFileSync(path.join(dir, '角色.json'), utf8);
  const archivePath = path.join(dir, 'theirs.zip');
  execFileSync(ZIP_CLI, ['-q', '-r', 'theirs.zip', 'sub', '角色.json'], { cwd: dir });

  const entries = zip.readZip(archivePath);
  assert.deepEqual(
    entries.map((e) => e.path),
    ['sub/a.txt', 'sub/binary.bin', '角色.json'],
    'directory entries are skipped; UTF-8 name decoded correctly',
  );
  const [a, b, c] = entries;
  assert.ok(a.data.equals(text));
  assert.equal(a.crc32, zip.crc32(text));
  assert.ok(b.data.equals(binary), 'a ~200KB binary file survives byte-exactly');
  assert.equal(b.size, 200000);
  assert.ok(b.method === 0 || b.method === 8);
  assert.ok(c.data.equals(utf8));

  const listing = zip.listZip(archivePath);
  const dirEntry = listing.find((e) => e.isDirectory);
  assert.equal(listing.filter((e) => e.isDirectory).length, 1, 'zip -r stores one directory entry');
  assert.equal(dirEntry.path, 'sub/');
  assert.equal(dirEntry.size, 0);
  console.log('[hb] interop 2/3: readZip parses /usr/bin/zip output (subdir, 200KB binary, UTF-8 name)');
});

test('interop: /usr/bin/unzip -t passes on our output', (t) => {
  const dir = withSandbox(t);
  const archivePath = path.join(dir, 'ours.zip');
  fs.writeFileSync(
    archivePath,
    zip.writeZip([
      { path: 'manifest.json', data: '{"schemaVersion":1}' },
      { path: 'chars/whale-girl/walk-left/frame-b01.png', data: pseudoRandom(60000) },
      { path: 'dialogues/opening.json', data: 'const x = 1;' },
    ]),
  );
  const output = execFileSync(UNZIP_CLI, ['-t', archivePath], { maxBuffer: 1 << 22 });
  assert.match(output.toString(), /No errors detected/, 'unzip -t must report a clean archive');
  const listing = execFileSync(UNZIP_CLI, ['-l', archivePath], { maxBuffer: 1 << 22 });
  assert.match(listing.toString(), /3 files/, 'unzip sees exactly 3 files');
  console.log('[hb] interop 3/3: unzip -t + unzip -l accept our archive');
});

// ---------------------------------------------------------------------------
// 体积上限（不支持的 zip64，fail-closed）
// ---------------------------------------------------------------------------

test('MAX_ENTRIES: exported as 65535; 65536 entries throw ZIP_TOO_LARGE', () => {
  assert.equal(zip.MAX_ENTRIES, 65535);
  const tooMany = Array.from({ length: 65536 }, (_, i) => ({ path: `e/${i}.bin`, data: 'x' }));
  const err = expectThrowCode(() => zip.writeZip(tooMany), 'ZIP_TOO_LARGE');
  assert.match(err.message, /65535/);
});

test('MAX_ENTRIES: the 65535 ceiling itself still round-trips', (t) => {
  const dir = withSandbox(t);
  const count = 65535;
  const entries = Array.from({ length: count }, (_, i) => ({ path: `e/${i.toString().padStart(5, '0')}.bin`, data: 'x' }));
  const archive = zip.writeZip(entries, { compress: false });
  const archivePath = path.join(dir, 'ceiling.zip');
  fs.writeFileSync(archivePath, archive);
  assert.equal(zip.readZip(archivePath).length, count);
  assert.equal(zip.listZip(archive).length, count);
  const output = execFileSync(UNZIP_CLI, ['-t', archivePath], { maxBuffer: 1 << 24 });
  assert.match(output.toString(), /No errors detected/, 'even the ceiling archive is a valid zip');
});
