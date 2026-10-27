'use strict';

// src/work/work-ipc.js — 工作台 IPC 的**纯**部分（v0.7 P1）。
//
// 这里只做三件事：载荷校验、调用注入的回调、把结果冻结。
// 不碰 Electron、不碰 fs、不碰 Team —— 因此可以离线单测（main.js 只负责装配）。
//
// 通道命名空间 `shell:work:*`（壳自有）。office:* 仍冻结为 8 个。

const GOAL_MAX_CHARS = 2000;
const PATH_MAX_CHARS = 1024;
const KEY_MAX_CHARS = 200;
const VERIFY_COMMAND_MAX_CHARS = 500;
const ARTIFACT_ACTIONS = Object.freeze(['read', 'open', 'reveal']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function refuse(code) {
  return Object.freeze({ ok: false, code });
}

function validate(payload) {
  if (!isPlainObject(payload)) return { ok: false, code: 'PAYLOAD_INVALID' };
  const action = payload.action;
  if (action === 'status') return { ok: true, action };
  if (action === 'select-workspace') {
    const hasPath = typeof payload.path === 'string' && payload.path.trim() !== '';
    const hasCreate = typeof payload.create === 'string' && payload.create.trim() !== '';
    if (hasPath === hasCreate) return { ok: false, code: 'WORKSPACE_TARGET_AMBIGUOUS' };
    if (hasPath) {
      const p = payload.path.trim();
      if (p.length > PATH_MAX_CHARS) return { ok: false, code: 'WORKSPACE_PATH_TOO_LONG' };
      return { ok: true, action, target: { path: p } };
    }
    const name = payload.create.trim();
    if (name.length > 40) return { ok: false, code: 'WORK_NAME_TOO_LONG' };
    return { ok: true, action, target: { create: name } };
  }
  if (action === 'start') {
    const goal = typeof payload.goal === 'string' ? payload.goal.trim() : '';
    if (goal === '') return { ok: false, code: 'WORK_GOAL_REQUIRED' };
    if (goal.length > GOAL_MAX_CHARS) return { ok: false, code: 'WORK_GOAL_TOO_LONG' };
    const verifyCommand = typeof payload.verifyCommand === 'string' ? payload.verifyCommand.trim() : '';
    if (verifyCommand.length > VERIFY_COMMAND_MAX_CHARS) return { ok: false, code: 'WORK_VERIFY_COMMAND_TOO_LONG' };
    return { ok: true, action, goal, verifyCommand };
  }
  if (action === 'cancel') return { ok: true, action };
  if (action === 'resume') return { ok: true, action };
  if (action === 'expand') return { ok: true, action };
  if (action === 'retry') return { ok: true, action };
  if (action === 'open-artifact') {
    const key = typeof payload.key === 'string' ? payload.key.trim() : '';
    if (key === '' || key.length > KEY_MAX_CHARS) return { ok: false, code: 'ARTIFACT_KEY_INVALID' };
    const verb = payload.verb;
    if (!ARTIFACT_ACTIONS.includes(verb)) return { ok: false, code: 'ARTIFACT_ACTION_INVALID' };
    return { ok: true, action, key, verb };
  }
  return { ok: false, code: 'ACTION_UNKNOWN' };
}

/** 只接受工作台视图的 sender（file://.../work/work.html）。 */
function isTrustedWorkSender(event, expectedFile = 'work.html') {
  const url = event && event.senderFrame && event.senderFrame.url;
  if (typeof url !== 'string' || url === '') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'file:') return false;
  return parsed.pathname.endsWith(`/work/${expectedFile}`);
}

/**
 * @param {object} deps
 * @param {() => object} deps.status
 * @param {(target: {path?: string, create?: string}) => Promise<object>} deps.selectWorkspace
 * @param {(goal: string) => Promise<object>} deps.start
 * @param {() => Promise<object>} deps.cancel
 * @param {(args: {key: string, verb: string}) => Promise<object>} deps.openArtifact
 */
function createWorkIpc({ status, selectWorkspace, start, cancel, resume, retry, expand, openArtifact } = {}) {
  for (const [name, fn] of Object.entries({ status, selectWorkspace, start, cancel, resume, retry, expand, openArtifact })) {
    if (typeof fn !== 'function') throw new Error(`createWorkIpc requires ${name}()`);
  }

  async function handle(payload, senderOk) {
    if (!senderOk) return refuse('SENDER_UNTRUSTED');
    const checked = validate(payload);
    if (!checked.ok) return refuse(checked.code);
    switch (checked.action) {
      case 'status': return status();
      case 'select-workspace': return selectWorkspace(checked.target);
      case 'start': return start(checked.goal, checked.verifyCommand);
      case 'cancel': return cancel();
      case 'resume': return resume();
      case 'retry': return retry();
      case 'expand': return expand();
      case 'open-artifact': return openArtifact({ key: checked.key, verb: checked.verb });
      default: return refuse('ACTION_UNKNOWN');
    }
  }

  /** 注册到 ipcMain（main.js 调用）；信任判断与校验都在这里。 */
  function register(ipcMain) {
    ipcMain.handle('shell:work', async (event, payload) => handle(payload, isTrustedWorkSender(event)));
  }

  return Object.freeze({ handle, register, validate });
}

module.exports = { createWorkIpc, isTrustedWorkSender, validate, GOAL_MAX_CHARS, ARTIFACT_ACTIONS };
