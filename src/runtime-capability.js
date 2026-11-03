// src/runtime-capability.js — 用能力探测替代版本号门禁（S1 / TD-29）。
//
// 第一性原理：为什么"版本号"是错误的兼容性判据
//
//   壳层真正依赖的是**一组具体能力**：
//     · /api/remote.mux 能连、$events 能收到 ready
//     · session/list、session/create、session/page 存在且参数形状稳定
//     · 事件词表能喂给办公室翻译层
//
//   而版本号与这些能力之间**没有因果必然性**：
//     · 0.1.5-rc.2 在矩阵内，但矩阵是在 2026-09 用当时的四个 gate 测的
//     · 0.2.1-rc.5 在矩阵外，但 POC（docs/research/runtime-poc-report-2026-11-01.md）
//       已实测 16/16 通过——mux、三个 session RPC、6 个能力包全部可用
//
//   换句话说：`semver.satisfies(v, '<0.2.0-0')` 这个判据在 0.2.1 上给出
//   "不支持"的结论，而这个结论是**错的**。它的语义已经从"兼容性门禁"
//   退化为"上次更新这个常量时的版本快照"。
//
//   正确做法是探测能力本身。本模块提供：
//     1. 能力声明（壳层需要什么，以及每项的判据）
//     2. 探测结果的判定（required 缺失 → 不可用；optional 缺失 → 降级但仍可用）
//     3. 保留版本号作为**提示**（"这个版本没被测过"），而不是**判决**
//
//   为什么不做成"在线探测"：探测需要启动 runtime 并连 mux（POC 就是这么做的，
//   要 3 分钟）。日常更新检查不可能每次都跑。所以这里做的是**声明式能力矩阵**：
//   维护一份"哪些版本/范围满足哪些能力"的事实表，由 POC 与 CI 的结果填充，
//   检查时查表 + 对未知版本给出诚实的"未验证"而不是"不支持"。
//
//   `SUPPORTED_RUNTIME_RANGE` 保留但**语义收窄**为"已验证矩阵"的展示用字符串，
//   不再作为安装/运行的判定依据。
'use strict';

const semver = require('semver');

/**
 * 壳层依赖的能力声明。
 *
 * required = 缺失则壳层核心功能不可用（拒绝运行 / 强烈警告）
 * optional = 缺失则降级（记录 + 提示，但可运行）
 *
 * `since` 是该能力首次出现的版本（来自官方包清单与 POC 实测）。
 */
const CAPABILITIES = Object.freeze([
  Object.freeze({
    id: 'remote.mux',
    required: true,
    since: '0.1.2-rc.1',
    why: '事件面与 RPC 的唯一传输；缺失则办公室、任务板、审批全部失效，壳层只剩空窗口',
    evidence: 'POC 2026-11-01 实测 0.1.5-rc.2 / 0.2.1-rc.5 / 0.2.2-alpha.2 全部可用',
  }),
  Object.freeze({
    id: 'session.list',
    required: true,
    since: '0.1.0',
    why: '会话列表与历史恢复；Mission 需要枚举 Workstream 的底层会话',
    evidence: 'POC 2026-11-01 三版本实测 items 返回正常',
  }),
  Object.freeze({
    id: 'session.create',
    required: true,
    since: '0.1.0',
    why: '新建会话（Mission 的 Workstream 需要它）；缺失则无法启动任何工作',
    evidence: 'POC 2026-11-01 三版本实测均返回 sessionId',
  }),
  Object.freeze({
    id: 'session.page',
    required: true,
    since: '0.1.0',
    why: 'journal 重放与断线恢复；缺失则重启后丢失全部过程事实',
    evidence: 'POC 2026-11-01 三版本实测 records/hasMore 结构一致',
  }),
  Object.freeze({
    id: 'agent-team',
    required: false,
    since: '0.2.0',
    why: '官方 Agent Teams（Mission Core 的团队层依赖）',
    evidence: 'POC 2026-11-01 实测：0.2.1-rc.5 / 0.2.2-alpha.2 有 dsh-experimental-agent-team；0.1.5 无',
    // S0 第二轮（2026-11-04）实测补充：**包存在 ≠ 能力生效**。
    // `dsh-experimental-agent-team` 只是领域服务；要让 session/projections 真正下发
    // `agentTeam`，profile 的 dsh.profile.bundles 必须包含
    // `@deepseek-ai/dsh-experimental-agent-team-profile`。
    // 实测：bundles 仅 base+web-app 时 projections 20 键（无 agentTeam）；
    //       加入 team-profile 后 21 键（含 agentTeam，值为 {members:[lead], tasks:[]}）。
    // 证据：docs/quality/harness-agent-team-probe-2026-11-04.md §1
    activation: {
      kind: 'profile-bundle',
      bundle: '@deepseek-ai/dsh-experimental-agent-team-profile',
      observable: 'session/projections 的 values.agentTeam 存在',
      note: '仅安装包不会生效；官方默认关闭，需在 Plugins 页启用或写入 profile bundles',
      evidence: 'docs/quality/harness-agent-team-probe-2026-11-04.md §1（bundles 20 键 → 加 team-profile 后 21 键）',
    },
  }),
  Object.freeze({
    id: 'workspace.changes',
    required: false,
    since: '0.2.0',
    why: 'per-turn 文件变更捕获（Mission 产物登记依赖）',
    evidence: 'POC 2026-11-01 实测：0.2.x 有 dsh-workspace-changes，0.1.5 无',
  }),
  Object.freeze({
    id: 'permission.read',
    required: false,
    since: '0.2.1',
    why: '右栏显示当前权限档位（"现在是不是完全权限"是用户最关心的风险信号之一）',
    evidence: 'S0 第四轮实测：session/projections 的 values.permissions.currentValue；'
      + 'permissionPresets/catalog 返回 options/defaultPreset',
  }),
  Object.freeze({
    id: 'permission.write',
    required: false,
    since: null, // 从未存在过：不是"还没到版本"，是"官方不提供"
    why: '是否能由壳层修改会话权限（D8 控件的可用性前提）',
    evidence: 'S0 第四轮实测：不可用。权威依据 dsh-permission-presets/lib/typert.host.js '
      + '只注册 permissionPresets/catalog（只读）；SessionCreateRequest 无权限字段；'
      + '试 set/select/apply 全部 HTTP 404',
    // 这条能力**故意**永远不满足。写在这里是为了让"为什么没有权限开关"
    // 成为一条可查的、有证据的结论，而不是后人以为"忘了做"。
    unavailable: {
      reason: '官方不提供第三方写权限的接口',
      consequence: 'D8 改为只读显示 + 跳转官方设置，不提供切换开关',
    },
  }),
  Object.freeze({
    id: 'session.goal',
    required: false,
    since: '0.1.0',
    why: 'Session 级目标（Mission 与 Session 的对应关系）',
    evidence: '官方 README：dsh-goal 提供每会话至多一个当前 goal',
  }),
]);

const CAPABILITY_IDS = Object.freeze(CAPABILITIES.map((c) => c.id));

/**
 * 已知版本 → 能力集。**只记录有实测证据的结论**，不猜测。
 *
 * 新增条目必须附 evidence（哪次 POC / CI 得出的），否则不要加。
 * 未知版本走 `judge()` 的"未验证"分支，而不是"不支持"。
 */
const KNOWN_MATRIX = Object.freeze([
  Object.freeze({
    // 0.1.2+ 的 Remote API 改造由兼容层覆盖（2026-09-22 拍板），
    // CI upstream-compat 持续验证 install/dump-config/health；
    // POC 2026-11-01 对 0.1.5-rc.2 做了协议级实测。
    // 范围保留 minor 线是因为 CI 每天都在跑这条线上的新版本；
    // 但 0.1.0/0.1.1（Remote API 改造之前）**不在**此列——它们没有 mux。
    range: '>=0.1.2-rc.1 <0.2.0-0',
    satisfied: ['remote.mux', 'session.list', 'session.create', 'session.page', 'session.goal'],
    missing: ['agent-team', 'workspace.changes'],
    evidence: 'POC 2026-11-01（0.1.5-rc.2 实测 10 pass）+ CI upstream-compat 每日验证',
    verifiedAt: '2026-11-01',
  }),
  Object.freeze({
    // **只列实测过的具体版本**，不用 '>=0.2.0-0 <0.3.0-0' 这种宽范围。
    // 理由：宽范围会把从未测过的 0.2.99 也说成 supported —— 那就是撒谎。
    // 新增一个 0.2.x 版本被验证后，在这里用 '||' 追加（semver 支持 disjunction）。
    range: '0.2.1-rc.5 || 0.2.2-alpha.2',
    satisfied: ['remote.mux', 'session.list', 'session.create', 'session.page',
      'agent-team', 'workspace.changes', 'permission.read', 'session.goal'],
    missing: [],
    evidence: 'POC 2026-11-01（0.2.1-rc.5 与 0.2.2-alpha.2 各 16 pass / 0 fail）',
    verifiedAt: '2026-11-01',
  }),
]);

/** 判定结论的等级。 */
const VERDICTS = Object.freeze({
  SUPPORTED: 'supported',        // 全部 required + optional 都在
  DEGRADED: 'degraded',          // required 都在，但部分 optional 缺失
  UNSUPPORTED: 'unsupported',    // 有 required 缺失
  UNVERIFIED: 'unverified',      // 版本未被测过——**不等于不支持**
});

/** 某个版本落在哪条矩阵条目里；没有则 null。 */
function matrixEntryFor(version) {
  const v = String(version || '').trim();
  if (!semver.valid(v)) return null;
  for (const entry of KNOWN_MATRIX) {
    try {
      if (semver.satisfies(v, entry.range, { includePrerelease: true })) return entry;
    } catch { /* malformed range: skip */ }
  }
  return null;
}

/**
 * 判定一个版本的能力状况。
 *
 * 关键：未知版本返回 UNVERIFIED 而**不是** UNSUPPORTED。
 * 它表达的是"我们没测过"，而不是"它不能用"——这两件事必须分开，
 * 否则每次上游发版都会把壳层变成"不支持"状态，而实际上很可能完全可用。
 *
 * @returns {{verdict, satisfied:string[], missing:string[], unknown:string[], evidence, reason}}
 */
function judge(version) {
  const v = String(version || '').trim();

  // 非 semver（本地 dev 安装、git 构建）：不阻断，标记未验证
  if (!semver.valid(v)) {
    return {
      verdict: VERDICTS.UNVERIFIED,
      satisfied: [],
      missing: [],
      unknown: [...CAPABILITY_IDS],
      evidence: null,
      reason: 'version is not semver (local/dev build) — capabilities unknown, not blocked',
    };
  }

  const entry = matrixEntryFor(v);
  if (!entry) {
    return {
      verdict: VERDICTS.UNVERIFIED,
      satisfied: [],
      missing: [],
      unknown: [...CAPABILITY_IDS],
      evidence: null,
      reason: `no verified capability record for ${v} — would need a POC run; this is NOT a "unsupported" verdict`,
    };
  }

  const satisfied = entry.satisfied.slice();
  const missing = entry.missing.slice();
  const requiredMissing = CAPABILITIES
    .filter((c) => c.required && missing.includes(c.id))
    .map((c) => c.id);

  if (requiredMissing.length > 0) {
    return {
      verdict: VERDICTS.UNSUPPORTED,
      satisfied,
      missing,
      unknown: [],
      evidence: entry.evidence,
      reason: `required capabilities missing: ${requiredMissing.join(', ')}`,
    };
  }
  if (missing.length > 0) {
    return {
      verdict: VERDICTS.DEGRADED,
      satisfied,
      missing,
      unknown: [],
      evidence: entry.evidence,
      reason: `optional capabilities missing: ${missing.join(', ')}`,
    };
  }
  return {
    verdict: VERDICTS.SUPPORTED,
    satisfied,
    missing: [],
    unknown: [],
    evidence: entry.evidence,
    reason: 'all required and optional capabilities present',
  };
}

/**
 * 壳层是否允许在该版本上运行。
 *
 * 守住一条底线：**只有 required 缺失才拒绝**。
 * 未验证版本一律放行（容器姿态：harness 可以坏，壳不能坏；
 * 真正的保护由 watchdog + 回滚 + 降级态承担）。
 */
function canRun(version) {
  const j = judge(version);
  return {
    allowed: j.verdict !== VERDICTS.UNSUPPORTED,
    verdict: j.verdict,
    degraded: j.verdict === VERDICTS.DEGRADED,
    unverified: j.verdict === VERDICTS.UNVERIFIED,
    reason: j.reason,
    judge: j,
  };
}

/**
 * 是否应该把某个版本标记为"未在测试矩阵内"。
 * 保留给设置页/诊断显示用——**是提示，不是判决**。
 */
function needsCompatibilityNote(version) {
  return judge(version).verdict === VERDICTS.UNVERIFIED;
}

/**
 * 按 id 取能力声明（找不到返回 null）。
 * @param {string} id 能力 id
 */
function capabilityById(id) {
  return CAPABILITIES.find((c) => c.id === id) || null;
}

/**
 * 该能力是否需要"额外的启用动作"才能生效。
 *
 * 第一性原理：为什么"包在"与"能用"必须分开
 *
 *   0.2.1 安装了 dsh-experimental-agent-team，但 session/projections 里**没有**
 *   agentTeam —— 因为它只是一个领域服务插件，默认没有挂进 profile 的 bundle 层。
 *   这类差异如果不建模，壳层就会把"读不到 agentTeam"误判成"团队不支持"，
 *   进而把一个**可修复的配置问题**报成**能力缺失**。两者对用户的含义完全不同：
 *     · 能力缺失 → 升级运行时
 *     · 未启用   → 去设置里打开一个开关
 *
 * @param {string} id 能力 id
 * @returns {boolean}
 */
function requiresActivation(id) {
  const cap = capabilityById(id);
  return !!(cap && cap.activation);
}

/**
 * 描述某个能力的启用要求，供设置页/诊断/右栏空态使用。
 * 无启用要求时返回 null。
 *
 * @param {string} id 能力 id
 * @returns {{kind:string, bundle?:string, observable:string, note:string}|null}
 */
function describeActivation(id) {
  const cap = capabilityById(id);
  if (!cap || !cap.activation) return null;
  return { ...cap.activation };
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_IDS,
  KNOWN_MATRIX,
  VERDICTS,
  matrixEntryFor,
  judge,
  canRun,
  needsCompatibilityNote,
  capabilityById,
  requiresActivation,
  describeActivation,
};
