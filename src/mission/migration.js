// src/mission/migration.js — schema 版本迁移（P1）。
//
// 第一性原理：为什么迁移必须是"纯函数 + 显式版本链"而不是"就地改文件"
//
//   对照 src/work/workspace-store.js 的失败模式（Issue #12 记录）：
//     · `schemaVersion !== 1` 直接 fail-closed（`:78-80`）——用户升级后旧数据不可读
//     · 索引损坏 → `WORK_INDEX_INVALID` 且**刻意不重建**（`:211-215`）——数据永久不可读
//     · 无 `.bak`
//   这套组合的后果是：**版本一变就等于数据丢失**，而且没有任何逃生路径。
//
//   Mission Core 不能重犯这个错。所以：
//     1. 迁移是**纯函数**：输入旧事件 → 输出新事件，不碰磁盘
//        （可穷举测试、可 dry-run、可在写之前预览结果）
//     2. 版本链是**显式**的：每一步 1→2、2→3 单独可测，
//        而不是一个巨大的"任意版本 → 最新"函数
//     3. **未知（更高）版本不猜测**：返回明确失败，让上层提示用户升级壳层
//        ——而不是"尽力而为"地把未来的数据改坏
//     4. 迁移**永不丢弃**事件：无法理解的字段**保留**（前向兼容），
//        只补必需的默认值
//
//   本模块只做事件流的版本转换；备份与写回由 store 负责（职责分离）。
'use strict';

const eventLog = require('./event-log');

/** 当前 schema 版本。与 schema.js 的 SCHEMA_VERSION 保持一致。 */
const CURRENT_VERSION = 1;

/**
 * 迁移步骤注册表。
 *
 * 结构：{ from: <源版本>, to: <目标版本>, migrate(events) => events }
 * 必须**连续**（1→2、2→3…），由 `chainOf()` 校验。
 */
const STEPS = Object.freeze({
  // v0（无 schemaVersion 的早期日志）→ v1：只是给每个事件补 schemaVersion 字段。
  // 目前还没有真实的 v0 数据，但保留这一步让"版本链必须连续"的机制可被测试。
  0: Object.freeze({
    to: 1,
    migrate(events) {
      return events.map((e) => (e && typeof e === 'object' ? { ...e, schemaVersion: 1 } : e));
    },
  }),
});

/** 从某个版本到当前版本的步骤链。缺环返回 null。 */
function chainOf(fromVersion) {
  // 更高的版本没有降级路径。必须**显式**返回 null，而不是空数组——
  // 空数组会被误读为"无需迁移"，于是未来数据会被当成当前数据使用。
  if (Number(fromVersion) > CURRENT_VERSION) return null;
  const chain = [];
  let v = Number(fromVersion);
  const guard = new Set();
  while (v < CURRENT_VERSION) {
    if (guard.has(v)) return null; // 环（不该发生，但防御）
    guard.add(v);
    const step = STEPS[v];
    if (!step) return null; // 缺环
    chain.push({ from: v, to: step.to, migrate: step.migrate });
    v = step.to;
  }
  return chain;
}

/**
 * 探测一批事件的 schema 版本。
 *
 * 规则：
 *   · 所有事件都带同版本 → 返回该版本
 *   · 有事件无版本字段   → 视为 0（早期数据）
 *   · 版本混杂           → 返回 mixed（调用方必须谨慎）
 */
function detectVersion(events) {
  const versions = new Set();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue;
    versions.add(Number.isInteger(e.schemaVersion) ? e.schemaVersion : 0);
  }
  if (versions.size === 0) return { version: CURRENT_VERSION, mixed: false, versions: [] };
  if (versions.size === 1) {
    const [v] = [...versions];
    return { version: v, mixed: false, versions: [v] };
  }
  return { version: null, mixed: true, versions: [...versions].sort() };
}

/**
 * 迁移事件流到当前版本（**纯函数**，不碰磁盘）。
 *
 * @returns {{
 *   ok:boolean,
 *   events:Array,
 *   from:number|null,
 *   to:number,
 *   steps:Array<string>,
 *   reason?:string,
 *   needsWrite?:boolean,
 * }}
 */
function migrateEvents(events) {
  const list = Array.isArray(events) ? events : [];
  const detected = detectVersion(list);

  if (detected.mixed) {
    // 混杂版本说明日志被不同版本的壳写过——继续迁移会掩盖真实问题。
    // 交给用户/开发者判断，而不是猜。
    return {
      ok: false,
      events: list,
      from: null,
      to: CURRENT_VERSION,
      steps: [],
      reason: `mixed schema versions in one log (${detected.versions.join(', ')}) — refusing to guess`,
    };
  }

  const from = detected.version;
  if (from > CURRENT_VERSION) {
    // 未来版本：**不猜测**。尽力而为只会把未来数据改坏。
    return {
      ok: false,
      events: list,
      from,
      to: CURRENT_VERSION,
      steps: [],
      reason: `log schema v${from} is NEWER than this build supports (v${CURRENT_VERSION}) — upgrade the app instead of downgrading the data`,
    };
  }
  if (from === CURRENT_VERSION) {
    return { ok: true, events: list, from, to: CURRENT_VERSION, steps: [], needsWrite: false };
  }

  const chain = chainOf(from);
  if (!chain) {
    return {
      ok: false,
      events: list,
      from,
      to: CURRENT_VERSION,
      steps: [],
      reason: `no migration path from v${from} to v${CURRENT_VERSION}`,
    };
  }

  let working = list;
  const steps = [];
  for (const step of chain) {
    working = step.migrate(working);
    steps.push(`v${step.from}→v${step.to}`);
  }

  return {
    ok: true,
    events: working,
    from,
    to: CURRENT_VERSION,
    steps,
    needsWrite: true,
  };
}

/**
 * dry-run：只报告会发生什么，不返回改后的数据。
 * 用于 UI 显示"升级会迁移 N 条事件"。
 */
function plan(eventsRaw) {
  const list = Array.isArray(eventsRaw) ? eventsRaw : [];
  const r = migrateEvents(list);
  return {
    ok: r.ok,
    from: r.from,
    to: r.to,
    steps: r.steps,
    eventCount: list.length,
    needsWrite: !!r.needsWrite,
    reason: r.reason || null,
  };
}

/**
 * 从磁盘日志做 dry-run（只读）。
 * 便于"打开设置页时提示：有 N 条事件需要迁移"。
 */
function planFile(file) {
  const read = eventLog.readLog(file);
  const p = plan(read.events);
  return {
    ...p,
    badLines: read.badLines.length,
    // 有坏行时迁移结果不可信——必须让调用方先处理损坏
    blocked: read.badLines.length > 0,
    reason: read.badLines.length > 0
      ? `log has ${read.badLines.length} unreadable line(s); repair before migrating`
      : p.reason,
  };
}

module.exports = {
  CURRENT_VERSION,
  STEPS,
  chainOf,
  detectVersion,
  migrateEvents,
  plan,
  planFile,
};
