// src/mission/presented-collector.js — 收集 `deliverables/presented` 事件（S5 接线层）。
// 纯逻辑 + 有界内存，零 IO，可离线测试。
//
// 第一性原理：为什么必须在**进入 Mission 之前**就把绝对路径削掉
//
//   官方 `present` 记录的是**绝对路径**（README："records absolute paths"）。
//   而 AGENTS.md §2.4 是硬铁律：
//     "raw sessionId / prompt 正文 / 工具参数原文 / 产物内容 / **绝对路径**
//      不进 Office 快照与事实链"
//
//   所以隐私过滤不能放在 UI 层（那时已经太晚，数据已经进了事实链），
//   必须在**事件被消费的那一刻**就做。本模块就是那道闸门：
//   它把 {path: "/Users/xia/proj/src/a.js"} 削成 {relPath: "src/a.js"}，
//   绝对路径**从不**离开这个函数。
//
//   如果绝对路径只在 UI 层才被隐藏，那么它已经写进了事件日志 ——
//   日志是不可篡改的历史，删不掉。这就是为什么必须在这里做。
'use strict';

/** 有界容量：只保留最近 N 个 turn 的交付声明。 */
const MAX_TURNS_KEPT = 32;

/**
 * 把绝对路径削成工作区相对路径。**越界一律拒绝**（返回 null）。
 *
 * 拒绝规则（保守）：
 *   · 不在 workspace 之下的路径 → null（外部文件不登记，避免泄露用户目录结构）
 *   · 含 `..` 的路径 → null（不"归一化修正"，可疑就拒）
 *   · 空路径 → null
 *
 * @param {string} absolutePath
 * @param {string} workspaceDir  工作区绝对路径
 * @returns {string|null} 相对路径（POSIX 风格），或 null
 */
function toWorkspaceRelative(absolutePath, workspaceDir) {
  if (typeof absolutePath !== 'string' || !absolutePath) return null;
  if (typeof workspaceDir !== 'string' || !workspaceDir) return null;
  // 规范化分隔符，但**不解析** ..（解析会把可疑路径变成合法路径）
  const norm = (s) => s.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs = norm(absolutePath);
  const ws = norm(workspaceDir);

  // 唯一一道穿越检查：**在削之前**查，而不是削完再查。
  //
  // 为什么只保留一处：早期版本在削之前和削之后各查一次，
  // 变异测试证明它们是**冗余的**（去掉任意一处，另一处照样拦住同样的输入），
  // 于是任何一处失效都不会被测试发现。冗余的防线在没有测试覆盖时
  // 反而制造了"看起来有保护"的假象。
  //
  // 现在只查一次，且查的是**输入**。削出来的 rel 因此天然不含 ..。
  if (abs.split('/').includes('..')) return null;

  if (!abs.startsWith(ws + '/')) return null;
  const rel = abs.slice(ws.length + 1);
  if (!rel) return null;
  return rel;
}

/**
 * 从一条 `deliverables/presented` 事件的 payload 提取安全摘要。
 *
 * 官方 payload（读 .d.ts 确认）：{turn, callId, files:[{path, description?}]}
 *
 * @param {object} data     事件 data
 * @param {string} workspaceDir
 * @returns {{turn:number|null, files:Array<{relPath:string, description:string|null}>, dropped:number}|null}
 */
function extractPresented(data, workspaceDir) {
  if (!data || typeof data !== 'object') return null;
  const turn = Number.isFinite(data.turn) ? data.turn : null;
  const files = Array.isArray(data.files) ? data.files : [];
  const out = [];
  let dropped = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') { dropped += 1; continue; }
    const rel = toWorkspaceRelative(f.path, workspaceDir);
    if (!rel) { dropped += 1; continue; } // 越界/非法：静默丢弃但计数
    out.push({
      relPath: rel,
      // description 是模型给的人话描述，不含路径，可以保留（截断防滥用）
      description: typeof f.description === 'string' && f.description
        ? f.description.slice(0, 300) : null,
    });
  }
  return { turn, files: out, dropped };
}

/**
 * 有界收集器：按 turn 累积交付声明。
 *
 * 为什么按 turn 而不是平铺：UI 要回答"这一轮交付了什么"，
 * 平铺会让用户不知道哪次是这次的。
 */
function createPresentedCollector({ cap = MAX_TURNS_KEPT } = {}) {
  const limit = Number.isFinite(cap) && cap > 0 ? cap : MAX_TURNS_KEPT;
  /** turn -> {turn, files:Map<relPath,{relPath,description}>} */
  const byTurn = new Map();
  const order = [];
  let totalDropped = 0;

  return {
    /**
     * 吃一条事件。返回本 turn 累计的交付数（便于调用方判断有无变化）。
     * @returns {{accepted:boolean, turn:number|null, count:number}}
     */
    ingest(data, workspaceDir) {
      const extracted = extractPresented(data, workspaceDir);
      if (!extracted) return { accepted: false, turn: null, count: 0 };
      totalDropped += extracted.dropped;
      const turn = extracted.turn;
      if (turn === null) return { accepted: false, turn: null, count: 0 };

      let bucket = byTurn.get(turn);
      if (!bucket) {
        bucket = { turn, files: new Map() };
        byTurn.set(turn, bucket);
        order.push(turn);
        // 有界：超出丢最旧的 turn
        while (order.length > limit) {
          const old = order.shift();
          byTurn.delete(old);
        }
      }
      for (const f of extracted.files) {
        // 同一 turn 内重复声明同一个文件：后者覆盖（description 可能更准）
        bucket.files.set(f.relPath, f);
      }
      return { accepted: true, turn, count: bucket.files.size };
    },

    /** 某一 turn 的交付清单（按 relPath 稳定排序）。 */
    forTurn(turn) {
      const b = byTurn.get(turn);
      if (!b) return [];
      return [...b.files.values()].sort((a, c) => a.relPath.localeCompare(c.relPath));
    },

    /** 最近一个 turn 的交付清单。 */
    latest() {
      if (order.length === 0) return { turn: null, files: [] };
      const turn = order[order.length - 1];
      return { turn, files: this.forTurn(turn) };
    },

    /** 统计（给诊断用，不含路径）。 */
    stats() {
      return {
        turns: byTurn.size,
        cap: limit,
        dropped: totalDropped,
        files: [...byTurn.values()].reduce((n, b) => n + b.files.size, 0),
      };
    },

    clear() {
      byTurn.clear();
      order.length = 0;
      totalDropped = 0;
    },
  };
}

module.exports = {
  MAX_TURNS_KEPT,
  toWorkspaceRelative,
  extractPresented,
  createPresentedCollector,
};
