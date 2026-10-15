'use strict';

// studio/lib/zip.js — 零依赖 ZIP 读写器（`.dshpack` 资产包的容器层，纯 Node 实现）。
//
// 立场（为什么存在）：
//   Node 没有内置 zip；仓里的 yauzl / unzipper 是**产品**的传递依赖，不许渗进
//   studio 这条零 install 的工具链。所以这里只站在 node:zlib 的肩膀上，
//   自己写 local file header / central directory / EOCD。无 npm 依赖、无网络。
//
// 支持面（最小的、`.`dshpack` 需要的）：
//   - method 0（stored）与 method 8（deflateRaw）；读时按中心目录解析，
//     因此**别的工具写的带数据描述符（bit 3）的包也能读**（中心目录里的尺寸永远是对的）；
//   - 文件名一律 UTF-8（bit 11 置位；读侧对无标志位的旧包也按 UTF-8 解，
//     非法 UTF-8 逐个字节降级 latin1，保证字节不丢、不乱码成别的字符）；
//   - 读侧跳过 extra field / file comment；写侧一律不写它们（确定性）。
//
// 确定性（写盘的硬约束）：
//   - 默认 mtime 固定为 1980-01-01T00:00:00Z（DOS date=0x21, time=0），
//     显式传 options.mtime 时才落库，且按 **UTC** 换算，与机器时区无关；
//   - 条目按 path 做字典序（JS 字符串 UTF-16 码元比较）稳定排序后写出；
//   - 不写 zip64、不写数据描述符、不写额外字段。同一批 entries + options
//     在同一 Node/zlib 构建下输出逐字节相同（跨 zlib 版本的稳定性不作承诺）。
//
// 路径安全是 API 的一部分（读方 fail-closed 的依据）：
//   readZip / listZip / extractOne 解析出的每一条名字都过 assertSafePath，
//   不合格直接抛 ZIP_UNSAFE_PATH，调用方（dshpack 导入）不再自行复核。
//
// 刻意不支持（以及为什么对我们的用法是安全的）：
//   - zip64：条目 ≤ 65535、单条 < 0xFFFFFFFF，越界即 ZIP_TOO_LARGE（失败要响，
//     不要静默截断）；.dshpack 是角色/场景工程，远够用；
//   - 加密、跨卷/分卷、多磁盘（EOCD 里 disk != 0 即拒）；
//   - 流式/随机写：整体在内存里拼装（资产包量级，几 MB 到几十 MB）；
//   - CP437 → Unicode 字符转写：旧 OEM 编码包名不会转成"好看的"字形，
//     降级 latin1 保证字节级保真（我们自己永远写 UTF-8，macOS zip 也写 UTF-8）；
//   - 目录条目：写侧**不存储**目录条目（readZip 只回文件，isDirectory 恒 false）；
//     读侧别的工具写入的 `sub/` 目录条目会被识别为 isDirectory=true，
//     readZip 跳过它们，listZip 原样列出。

const fs = require('node:fs');
const zlib = require('node:zlib');

// ---------------------------------------------------------------------------
// 常量与错误码
// ---------------------------------------------------------------------------

const SIG_LOCAL_FILE = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const FLAG_UTF8 = 0x0800; // 通用位 11：文件名/注释是 UTF-8

const VERSION_MADE_BY = 0x031e; // 高字节 host=3（Unix），低字节 zip 规范 3.0
const VERSION_NEEDED_STORE = 10; // 2.0 以下即可
const VERSION_NEEDED_DEFLATE = 20; // 2.0（deflate）

const EXTERNAL_ATTR_FILE = (0o100644 << 16) >>> 0; // Unix 普通文件 -rw-r--r--

const MAX_ENTRIES = 65535; // zip16 硬顶，超出即 ZIP_TOO_LARGE（不做 zip64）
const MAX_FILE_SIZE = 0xfffffffe; // 任一条目的 size / compressedSize 必须小于它
const MAX_PATH_LENGTH = 1024; // 工程约定：包内路径上限（比规范窄，fail-closed）

const DOS_EPOCH_YEAR = 1980;
const DOS_MAX_YEAR = 2107;
const DEFAULT_DOS_TIME = 0x0000; // 00:00:00 —— 固定默认时间戳的一半
const DEFAULT_DOS_DATE = 0x0021; // 1980-01-01  ((0<<9)|(1<<5)|1) —— 固定默认时间戳的另一半

/** 错误码表：值即 `err.code`，也即消息前缀（fail-closed 的匹配面）。 */
const CODES = Object.freeze({
  SAFE_PATH: 'ZIP_UNSAFE_PATH',
  NOT_ARCHIVE: 'ZIP_NOT_ARCHIVE',
  TRUNCATED: 'ZIP_TRUNCATED',
  TOO_LARGE: 'ZIP_TOO_LARGE',
  CRC_MISMATCH: 'ZIP_CRC_MISMATCH',
  CORRUPT: 'ZIP_CORRUPT',
  UNSUPPORTED: 'ZIP_UNSUPPORTED',
  DUPLICATE: 'ZIP_DUPLICATE',
  INVALID_ARGUMENT: 'ZIP_INVALID_ARGUMENT',
});

function zipError(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 长路径在错误消息里只留个头，避免一条错误刷屏一整屏。 */
function previewPath(relPath) {
  return relPath.length > 80 ? `${relPath.slice(0, 77)}...` : relPath;
}

// ---------------------------------------------------------------------------
// CRC-32（IEEE，反射，多项式 0xEDB88320）
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function toBufferData(value, what) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw zipError(
    CODES.INVALID_ARGUMENT,
    `${what} must be a Buffer, Uint8Array or string, got ${Object.prototype.toString.call(value)}`,
  );
}

/**
 * CRC-32，返回无符号 32 位整数。字符串按 UTF-8 计。
 * 已知向量：crc32('123456789') === 0xCBF43926。
 */
function crc32(input) {
  const buf =
    typeof input === 'string' ? Buffer.from(input, 'utf8') : toBufferData(input, 'crc32 input');
  let c = -1; // 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    c = (CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) | 0;
  }
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 校验包内相对路径，合法则返回去掉尾斜杠后的规范名，非法则抛 `ZIP_UNSAFE_PATH`。
 *
 * 拒绝：非字符串、''、纯斜杠、绝对值（'/' 开头）、Windows 盘符（'C:\' / 'C:foo'）、
 *  UNC（'\\\\srv\\share'）、任何反斜杠（包内分隔符只认 '/'）、空段（'a//b'）、
 * '.' / '..' 段、NUL、长度 > 1024。
 * 接受：'manifest.json'、'chars/whale/b.json'、目录形态 'sub/'（尾斜杠会剥掉）。
 */
function assertSafePath(relPath) {
  if (typeof relPath !== 'string') {
    throw zipError(CODES.SAFE_PATH, `path must be a string, got ${typeof relPath}`);
  }
  if (relPath.length === 0) {
    throw zipError(CODES.SAFE_PATH, 'empty path is not allowed');
  }
  if (relPath.length > MAX_PATH_LENGTH) {
    throw zipError(
      CODES.SAFE_PATH,
      `path "${previewPath(relPath)}" is ${relPath.length} characters, over the ${MAX_PATH_LENGTH} limit`,
    );
  }
  if (relPath.indexOf('\u0000') !== -1) {
    throw zipError(CODES.SAFE_PATH, `path "${previewPath(relPath)}" contains NUL`);
  }
  if (relPath.indexOf('\\') !== -1) {
    // 一条规则同时挡住 'C:\\Windows'、'\\\\srv\\share' 与 'a\\b'：
    // 本模块只认 '/' 作为包内分隔符（APPNOTE 规定）。
    throw zipError(
      CODES.SAFE_PATH,
      `path "${previewPath(relPath)}" contains a backslash (only "/" is a valid separator)`,
    );
  }
  if (relPath.startsWith('/')) {
    throw zipError(CODES.SAFE_PATH, `absolute path "${previewPath(relPath)}" is not allowed`);
  }
  const stripped = relPath.replace(/\/+$/, ''); // 目录条目 'sub/' → 'sub'
  if (stripped === '') {
    throw zipError(CODES.SAFE_PATH, `path "${previewPath(relPath)}" is only slashes`);
  }
  if (/^[A-Za-z]:/.test(stripped)) {
    throw zipError(CODES.SAFE_PATH, `path "${previewPath(relPath)}" has a Windows drive prefix`);
  }
  for (const segment of stripped.split('/')) {
    if (segment === '') {
      throw zipError(CODES.SAFE_PATH, `path "${previewPath(relPath)}" has an empty segment (double slash)`);
    }
    if (segment === '.') {
      throw zipError(CODES.SAFE_PATH, `path "${previewPath(relPath)}" has a "." segment`);
    }
    if (segment === '..') {
      throw zipError(CODES.SAFE_PATH, `path "${previewPath(relPath)}" has a ".." segment`);
    }
  }
  return stripped;
}

// ---------------------------------------------------------------------------
// DOS 时间戳（写侧；固定默认 1980-01-01T00:00:00Z，显式 mtime 才落值）
// ---------------------------------------------------------------------------

function toDosDateTime(mtime) {
  if (mtime === undefined || mtime === null) {
    return { time: DEFAULT_DOS_TIME, date: DEFAULT_DOS_DATE };
  }
  let date;
  if (mtime instanceof Date) date = mtime;
  else if (typeof mtime === 'number' || typeof mtime === 'string') date = new Date(mtime);
  else {
    throw zipError(
      CODES.INVALID_ARGUMENT,
      'options.mtime must be a Date, a number (ms epoch) or a date string',
    );
  }
  if (Number.isNaN(date.getTime())) {
    throw zipError(CODES.INVALID_ARGUMENT, 'options.mtime is not a parseable date');
  }
  // UTC 换算：无论跑在哪个时区，同一个时刻落出的 DOS 字段都一样。
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1;
  let day = date.getUTCDate();
  let hour = date.getUTCHours();
  let minute = date.getUTCMinutes();
  let second = date.getUTCSeconds();
  if (year < DOS_EPOCH_YEAR) {
    // 早于 DOS 纪元：夹回 1980-01-01T00:00:00Z（否则会回绕出 2107 年）
    year = DOS_EPOCH_YEAR; month = 1; day = 1; hour = 0; minute = 0; second = 0;
  } else if (year > DOS_MAX_YEAR) {
    // 晚于 DOS 上限：夹到 2107-12-31T23:59:58Z（DOS 秒字段只存 /2）
    year = DOS_MAX_YEAR; month = 12; day = 31; hour = 23; minute = 59; second = 58;
  }
  const time = (hour << 11) | (minute << 5) | (second >> 1); // 奇数秒向下取整
  const dosDate = ((year - DOS_EPOCH_YEAR) << 9) | (month << 5) | day;
  return { time: time & 0xffff, date: dosDate & 0xffff };
}

// ---------------------------------------------------------------------------
// 写侧
// ---------------------------------------------------------------------------

function writeLocalHeader(fields, name) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(SIG_LOCAL_FILE, 0);
  head.writeUInt16LE(fields.versionNeeded, 4);
  head.writeUInt16LE(FLAG_UTF8, 6);
  head.writeUInt16LE(fields.method, 8);
  head.writeUInt16LE(fields.dosTime, 10);
  head.writeUInt16LE(fields.dosDate, 12);
  head.writeUInt32LE(fields.crc, 14);
  head.writeUInt32LE(fields.compressedSize, 18);
  head.writeUInt32LE(fields.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28); // extra length：恒定 0（无额外字段）
  return head;
}

function writeCentralHeader(entry, name) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(SIG_CENTRAL_DIR, 0);
  head.writeUInt16LE(VERSION_MADE_BY, 4);
  head.writeUInt16LE(entry.versionNeeded, 6);
  head.writeUInt16LE(FLAG_UTF8, 8);
  head.writeUInt16LE(entry.method, 10);
  head.writeUInt16LE(entry.dosTime, 12);
  head.writeUInt16LE(entry.dosDate, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.compressedSize, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30); // extra length：0
  head.writeUInt16LE(0, 32); // comment length：0
  head.writeUInt16LE(0, 34); // disk number start：0
  head.writeUInt16LE(0, 36); // internal attributes：0
  head.writeUInt32LE(EXTERNAL_ATTR_FILE, 38);
  head.writeUInt32LE(entry.offset, 42);
  return head;
}

/**
 * 写 zip。返回 Buffer（同一输入 → 逐字节相同）。
 *
 * @param {Array<{path:string, data?:Buffer|Uint8Array|string, srcPath?:string}>} entries
 *   - path：包内相对 POSIX 路径（过 assertSafePath；写侧额外拒绝尾斜杠——
 *     本写器不产出目录条目）；
 *   - data 与 srcPath 二选一；srcPath 是**懒读**的（排序后逐条现场 fs.readFileSync，
 *     不会先把整个树读进内存）。
 * @param {{mtime?:Date|number|string, compress?:boolean, level?:number}} [options]
 *   - compress 默认 true；level 默认 9（0..9 整数；deflate 反而变大时回退 stored）；
 *   - mtime 缺省即固定 1980-01-01T00:00:00Z，保证确定性。
 * @throws {Error} ZIP_UNSAFE_PATH / ZIP_INVALID_ARGUMENT / ZIP_DUPLICATE / ZIP_TOO_LARGE
 */
function writeZip(entries, options = {}) {
  if (options === null || typeof options !== 'object') {
    throw zipError(CODES.INVALID_ARGUMENT, 'options must be an object');
  }
  if (!Array.isArray(entries)) {
    throw zipError(CODES.INVALID_ARGUMENT, `entries must be an array, got ${typeof entries}`);
  }
  if (entries.length > MAX_ENTRIES) {
    throw zipError(
      CODES.TOO_LARGE,
      `${entries.length} entries exceeds MAX_ENTRIES=${MAX_ENTRIES} (no zip64, by design)`,
    );
  }
  const compress = options.compress !== false; // 默认 true
  let level = 9;
  if (options.level !== undefined) {
    if (!Number.isInteger(options.level) || options.level < 0 || options.level > 9) {
      throw zipError(CODES.INVALID_ARGUMENT, 'options.level must be an integer 0..9');
    }
    level = options.level;
  }
  const dos = toDosDateTime(options.mtime);

  // 1) 归一化 + 安全校验 + 稳定排序（同 path 按入参先后，纯函数、可复现）
  const normalized = entries.map((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      throw zipError(CODES.INVALID_ARGUMENT, `entries[${index}] must be an object`);
    }
    if (typeof entry.path !== 'string' || entry.path.endsWith('/')) {
      // 尾斜杠 = 目录条目：本写器不产出（读侧才认）
      throw zipError(
        CODES.INVALID_ARGUMENT,
        `entries[${index}].path must be a file path (no trailing "/")`,
      );
    }
    assertSafePath(entry.path);
    const hasData = entry.data !== undefined && entry.data !== null;
    const hasSrc = entry.srcPath !== undefined && entry.srcPath !== null;
    if (hasData === hasSrc) {
      throw zipError(
        CODES.INVALID_ARGUMENT,
        `entries[${index}] ("${entry.path}") needs exactly one of data or srcPath`,
      );
    }
    if (hasSrc && (typeof entry.srcPath !== 'string' || entry.srcPath === '')) {
      throw zipError(CODES.INVALID_ARGUMENT, `entries[${index}].srcPath must be a non-empty string`);
    }
    return { path: entry.path, index, data: entry.data, srcPath: entry.srcPath, hasData };
  });
  normalized.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return a.index - b.index; // 稳定
  });
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].path === normalized[i - 1].path) {
      throw zipError(
        CODES.DUPLICATE,
        `two entries share the path "${normalized[i].path}" (second one silently wins on extract, so it is rejected)`,
      );
    }
  }

  // 2) 顺序拼装：local header + name + payload，逐条落中央目录记录
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const item of normalized) {
    const data = item.hasData ? toBufferData(item.data, `entry "${item.path}" data`) : fs.readFileSync(item.srcPath);
    if (data.length > MAX_FILE_SIZE) {
      throw zipError(
        CODES.TOO_LARGE,
        `entry "${item.path}" is ${data.length} bytes, over the ${MAX_FILE_SIZE + 1}-byte ceiling (no zip64, by design)`,
      );
    }
    const crc = crc32(data);
    let method = METHOD_STORED;
    let payload = data;
    if (compress && data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level });
      if (deflated.length < data.length) {
        method = METHOD_DEFLATE; // 只有"确实更小"才用 deflate，否则回退 stored
        payload = deflated;
      }
    }
    const name = Buffer.from(item.path, 'utf8');
    const record = {
      path: item.path,
      name,
      method,
      crc,
      size: data.length,
      compressedSize: payload.length,
      dosTime: dos.time,
      dosDate: dos.date,
      versionNeeded: method === METHOD_DEFLATE ? VERSION_NEEDED_DEFLATE : VERSION_NEEDED_STORE,
      offset,
    };
    chunks.push(writeLocalHeader(record, name), name, payload);
    central.push(record);
    offset += 30 + name.length + payload.length;
  }

  // 3) 中央目录 + EOCD（comment 长度恒 0）
  const centralStart = offset;
  const centralChunks = [];
  let centralSize = 0;
  for (const record of central) {
    const head = writeCentralHeader(record, record.name);
    centralChunks.push(head, record.name);
    centralSize += head.length + record.name.length;
  }
  for (const chunk of centralChunks) chunks.push(chunk);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // 本磁盘编号
  eocd.writeUInt16LE(0, 6); // 中央目录起始磁盘
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length：0
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// 读侧（一律走中央目录：带数据描述符的外部包也能读）
// ---------------------------------------------------------------------------

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (typeof input === 'string') return fs.readFileSync(input);
  throw zipError(
    CODES.INVALID_ARGUMENT,
    `expected a Buffer or a file path, got ${Object.prototype.toString.call(input)}`,
  );
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes /*, flags */) {
  if (bytes.length === 0) return '';
  try {
    return utf8Strict.decode(bytes); // 含置位/未置位 bit 11 的 UTF-8 名
  } catch {
    // 旧 OEM/原生字节名：不转写、不猜字形，逐字节 latin1 保真降级。
    return bytes.toString('latin1');
  }
}

function findEocd(buf) {
  if (buf.length < 22) {
    throw zipError(
      CODES.NOT_ARCHIVE,
      `no EOCD: buffer is ${buf.length} bytes, too small to hold one`,
    );
  }
  const windowStart = Math.max(0, buf.length - 22 - 0xffff); // 注释最长 65535
  let fallback = -1;
  for (let i = buf.length - 22; i >= windowStart; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLength = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLength === buf.length) return i; // 注释长度自洽
    if (fallback === -1) fallback = i; // 容忍尾随垃圾，记住最后一个候选
  }
  if (fallback !== -1) return fallback;
  throw zipError(
    CODES.NOT_ARCHIVE,
    `no EOCD signature found in the last ${buf.length - windowStart} bytes — not a zip archive`,
  );
}

/** 解析中央目录；每条都过 assertSafePath（读方 fail-closed 的核心）。 */
function parseCentralDirectory(buf) {
  const eocd = findEocd(buf);
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdStartDisk = buf.readUInt16LE(eocd + 6);
  const entriesThisDisk = buf.readUInt16LE(eocd + 8);
  const entriesTotal = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesThisDisk !== entriesTotal) {
    throw zipError(
      CODES.UNSUPPORTED,
      'multi-disk / split archives are not supported (EOCD reports more than one disk)',
    );
  }
  if (entriesTotal > MAX_ENTRIES) {
    throw zipError(CODES.TOO_LARGE, `archive claims ${entriesTotal} entries (no zip64, by design)`);
  }
  if (cdOffset > buf.length || cdOffset + cdSize > buf.length) {
    throw zipError(
      CODES.TRUNCATED,
      `central directory claims [${cdOffset}, ${cdOffset + cdSize}) but the buffer is ${buf.length} bytes — truncated archive`,
    );
  }

  const entries = [];
  let offset = cdOffset;
  const cdEnd = cdOffset + cdSize;
  for (let index = 0; index < entriesTotal; index++) {
    if (offset + 46 > buf.length) {
      throw zipError(CODES.TRUNCATED, `central directory is truncated at entry ${index} (offset ${offset})`);
    }
    if (buf.readUInt32LE(offset) !== SIG_CENTRAL_DIR) {
      throw zipError(
        CODES.NOT_ARCHIVE,
        `central directory entry ${index} at offset ${offset} has a bad signature`,
      );
    }
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > buf.length) {
      throw zipError(CODES.TRUNCATED, `central directory entry ${index} overruns the buffer`);
    }
    const name = decodeName(buf.subarray(offset + 46, offset + 46 + nameLength));
    const method = buf.readUInt16LE(offset + 10);
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw zipError(
        CODES.UNSUPPORTED,
        `entry "${name}" uses method ${method} (only 0/stored and 8/deflate are supported)`,
      );
    }
    // 尾斜杠即目录条目（APPNOTE：目录名以 '/' 结尾）
    const isDirectory = name.endsWith('/');
    try {
      assertSafePath(name); // 目录名在此也走同一道闸（内部会剥尾斜杠）
    } catch (err) {
      throw zipError(
        CODES.SAFE_PATH,
        `entry ${index} (central directory offset ${offset}) — ${err.message}`,
      );
    }
    if (localHeaderOffset + 30 > buf.length) {
      throw zipError(
        CODES.TRUNCATED,
        `entry "${name}" points its local header at offset ${localHeaderOffset}, past the end of the buffer (${buf.length} bytes)`,
      );
    }
    entries.push({
      path: name,
      method,
      crc32: buf.readUInt32LE(offset + 16),
      compressedSize: buf.readUInt32LE(offset + 20),
      size: buf.readUInt32LE(offset + 24),
      isDirectory,
      localHeaderOffset,
    });
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > cdEnd) {
      throw zipError(CODES.CORRUPT, `central directory entries overrun their declared size at index ${index}`);
    }
  }
  return entries;
}

/** 取一条的文件内容（拷贝，不和入参 buffer 共享内存）。 */
function readEntryData(buf, entry) {
  const lho = entry.localHeaderOffset;
  if (lho + 30 > buf.length) {
    throw zipError(CODES.TRUNCATED, `entry "${entry.path}": local header past end of buffer`);
  }
  if (buf.readUInt32LE(lho) !== SIG_LOCAL_FILE) {
    throw zipError(
      CODES.NOT_ARCHIVE,
      `entry "${entry.path}": no local file header signature at offset ${lho}`,
    );
  }
  const nameLength = buf.readUInt16LE(lho + 26);
  const extraLength = buf.readUInt16LE(lho + 28);
  const start = lho + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > buf.length) {
    throw zipError(
      CODES.TRUNCATED,
      `entry "${entry.path}": needs bytes [${start}, ${end}) but the buffer is ${buf.length} bytes — truncated archive`,
    );
  }
  const raw = buf.subarray(start, end);
  let data;
  if (entry.method === METHOD_STORED) {
    data = Buffer.from(raw); // 拷贝，避免调用方改到入参
  } else {
    try {
      data = zlib.inflateRawSync(raw);
    } catch (err) {
      throw zipError(CODES.CORRUPT, `entry "${entry.path}": deflate stream is corrupt (${err.message})`);
    }
  }
  if (data.length !== entry.size) {
    throw zipError(
      CODES.CORRUPT,
      `entry "${entry.path}": inflates to ${data.length} bytes but the central directory says ${entry.size}`,
    );
  }
  const crc = crc32(data);
  if (crc !== entry.crc32) {
    throw zipError(
      CODES.CRC_MISMATCH,
      `entry "${entry.path}": crc32 ${crc.toString(16)} != ${entry.crc32.toString(16)} recorded in the central directory`,
    );
  }
  return data;
}

/**
 * 读 zip，返回条目数组（中央目录序；**目录条目被跳过**，故 isDirectory 恒 false）。
 * 每条目录名都过 assertSafePath，不合格抛 ZIP_UNSAFE_PATH。
 */
function readZip(bufferOrPath) {
  const buf = toBuffer(bufferOrPath);
  const entries = parseCentralDirectory(buf);
  const out = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue; // 文档化选择：读侧只交付文件
    out.push({
      path: entry.path,
      data: readEntryData(buf, entry),
      crc32: entry.crc32,
      method: entry.method,
      compressedSize: entry.compressedSize,
      size: entry.size,
      isDirectory: false,
    });
  }
  return out;
}

/** 只列目录（不解压内容），含目录条目（isDirectory=true）。 */
function listZip(bufferOrPath) {
  const entries = parseCentralDirectory(toBuffer(bufferOrPath));
  return entries.map((entry) => ({
    path: entry.path,
    size: entry.size,
    compressedSize: entry.compressedSize,
    method: entry.method,
    crc32: entry.crc32,
    isDirectory: entry.isDirectory,
  }));
}

/** 取单条文件内容；不存在（或要的是目录条目）返回 null。 */
function extractOne(bufferOrPath, path) {
  const wanted = assertSafePath(path);
  const buf = toBuffer(bufferOrPath);
  for (const entry of parseCentralDirectory(buf)) {
    if (entry.isDirectory) continue;
    if (entry.path.replace(/\/+$/, '') === wanted) {
      return readEntryData(buf, entry);
    }
  }
  return null;
}

module.exports = {
  writeZip,
  readZip,
  listZip,
  extractOne,
  assertSafePath,
  crc32,

  // 常量与错误码（调用方 fail-closed 时按 code 匹配，不要按消息文案匹配）
  MAX_ENTRIES,
  MAX_FILE_SIZE,
  METHODS: { STORED: METHOD_STORED, DEFLATE: METHOD_DEFLATE },
  SAFE_PATH_ERROR: CODES.SAFE_PATH,
  NOT_ARCHIVE_ERROR: CODES.NOT_ARCHIVE,
  TRUNCATED_ERROR: CODES.TRUNCATED,
  TOO_LARGE_ERROR: CODES.TOO_LARGE,
  CRC_MISMATCH_ERROR: CODES.CRC_MISMATCH,
  CORRUPT_ERROR: CODES.CORRUPT,
  UNSUPPORTED_ERROR: CODES.UNSUPPORTED,
  DUPLICATE_ERROR: CODES.DUPLICATE,
  INVALID_ARGUMENT_ERROR: CODES.INVALID_ARGUMENT,
};
