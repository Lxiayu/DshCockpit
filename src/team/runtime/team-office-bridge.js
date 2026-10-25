'use strict';

// src/team/runtime/team-office-bridge.js — Team Runtime facts → Office 的驱动桥。
//
// 纯 CommonJS：零依赖（只有同目录的纯映射器），无 Electron / DOM / Pixi / fs /
// 网络 / office 模块 import。office 侧以**注入**方式给出（只有一个窄入口
// `ingestTeamProjectionFact`），因此本模块既不知道 office 内部结构，也不会反向依赖它。
//
// 契约：docs/specs/TEAM-RUNTIME-CONTRACT-v0.md §13
//
// 职责：
//   - `pump()` 把 Team Runtime 日志里**尚未消费**的 fact 逐条经 adapter 映射后交给 office；
//   - `replay()` 把游标归零后重新消费整条日志（用于证明"replay / 乱序 / 重复与顺序投递
//     结果一致"——因为 adapter 是纯函数、office 侧幂等由既有不变式保证）；
//   - `summary()` 给出**只读、只含计数与枚举**的粗粒度摘要（不含任何 id / 文本）。
//
// 边界（§13.1）：它不判断依赖、不创建/关闭 WorkerRun、不读 label/prompt、不从 UI 文本猜 Role。
// Team Runtime 是唯一事实作者；本模块只做搬运与翻译。

const { createTeamOfficeAdapter, TEAM_ROLE_TO_SEAT } = require('./team-office-adapter.js');

function createTeamOfficeBridge(options = {}) {
  const teamRuntime = options.teamRuntime;
  const office = options.office;
  if (!teamRuntime || typeof teamRuntime.facts !== 'function') {
    throw new Error('createTeamOfficeBridge requires a teamRuntime with facts()');
  }
  if (!office || typeof office.ingestTeamProjectionFact !== 'function') {
    throw new Error('createTeamOfficeBridge requires an office with ingestTeamProjectionFact()');
  }
  const log = typeof options.log === 'function' ? options.log : () => {};
  const adapter = createTeamOfficeAdapter({
    roleToSeat: options.roleToSeat,
    knownSeats: options.knownSeats,
  });

  let cursor = 0;
  const counters = {
    consumed: 0,
    mapped: 0,
    noEffect: 0,
    rejected: 0,
    officeApplied: 0,
    officeRejected: 0,
    duplicates: 0,
  };
  const rejectedCodes = new Map();  // 稳定码 -> 次数（有界：码本身是白名单枚举）
  const artifactKinds = new Map();  // 白名单 kind -> 次数（只计数，不留 id）

  function noteRejected(code) {
    counters.rejected += 1;
    rejectedCodes.set(code, (rejectedCodes.get(code) || 0) + 1);
    log(`[team-office] mapping rejected: ${code}`);
  }

  /** 消费 Team 日志里 cursor 之后的 fact。返回本轮结果数组（结构化，供测试断言）。 */
  function pump() {
    const facts = teamRuntime.facts();
    const results = [];
    for (; cursor < facts.length; cursor += 1) {
      const teamFact = facts[cursor];
      counters.consumed += 1;
      const mapped = adapter.mapFact(teamFact);
      if (!mapped.ok) {
        noteRejected(mapped.code);
        // fail-closed 但**可观测**：把稳定码交给 office 的诊断环（白名单校验在 office 侧）。
        office.ingestTeamProjectionFact({ kind: 'adapter-rejected', code: mapped.code });
        results.push(Object.freeze({ seq: teamFact.seq, type: teamFact.type, mapped: false, code: mapped.code }));
        continue;
      }
      if (mapped.officeFacts.length === 0) {
        counters.noEffect += 1;
        results.push(Object.freeze({ seq: teamFact.seq, type: teamFact.type, mapped: true, officeFacts: 0 }));
        continue;
      }
      counters.mapped += 1;
      if (teamFact.type === 'artifact/available') {
        const kind = teamFact.kind;
        artifactKinds.set(kind, (artifactKinds.get(kind) || 0) + 1);
      }
      for (const officeFact of mapped.officeFacts) {
        const applied = office.ingestTeamProjectionFact(officeFact);
        if (applied && applied.ok) {
          counters.officeApplied += 1;
          if (applied.status === 'duplicate') counters.duplicates += 1;
        } else {
          counters.officeRejected += 1;
          if (applied && applied.code) rejectedCodes.set(applied.code, (rejectedCodes.get(applied.code) || 0) + 1);
        }
      }
      results.push(Object.freeze({
        seq: teamFact.seq, type: teamFact.type, mapped: true, officeFacts: mapped.officeFacts.length,
      }));
    }
    return Object.freeze(results);
  }

  /** 从日志头重放整条链（游标归零）。adapter 无状态 + office 幂等 ⇒ 结果与顺序投递一致。 */
  function replay() {
    cursor = 0;
    return pump();
  }

  /** 只读摘要：计数 + 固定枚举 + 白名单 artifact kind 计数。**不含任何 id/文本**。 */
  function summary() {
    return Object.freeze({
      cursor,
      facts: teamRuntime.facts().length,
      counters: Object.freeze({ ...counters }),
      rejectedCodes: Object.freeze(Object.fromEntries([...rejectedCodes].sort((a, b) => a[0].localeCompare(b[0])))),
      artifactKinds: Object.freeze(Object.fromEntries([...artifactKinds].sort((a, b) => a[0].localeCompare(b[0])))),
      jobStatus: typeof teamRuntime.state === 'function' ? teamRuntime.state().status : null,
    });
  }

  return Object.freeze({
    pump,
    replay,
    summary,
    seatForRole: adapter.seatForRole,
    describe: () => Object.freeze({
      bridge: 'team-office-bridge-1',
      adapter: adapter.describe(),
      roleToSeat: Object.freeze({ ...(options.roleToSeat || TEAM_ROLE_TO_SEAT) }),
    }),
  });
}

module.exports = { createTeamOfficeBridge };
