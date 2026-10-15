#!/usr/bin/env node
'use strict';

// studio/bin/agent.js — the AGENT-FACING entry point (the other half of the workbench).
//
// WHY this exists: the workbench is for a human to build and fine-tune; this CLI is for an
// EXTERNAL coding agent (Codex, Claude Code, …) to do the first pass, after which the human
// polishes in the UI. A skill (studio/skills/workbench/SKILL.md) teaches the agent this file.
//
// The contract it gives an agent, and why each part matters:
//
//   capabilities   what can be done, with the exact parameters — ONE table, in this file, and
//                  a test asserts every operation still maps onto a real service method, so
//                  the skill cannot drift away from the code it drives.
//   diff           dry-run an operation and print a HUMAN diff ("draft-27: 0.5444,0.8093 ->
//                  0.4000,0.5000"). Agents propose; humans read. This is the interface they
//                  share, and it is the same text the journal records.
//   apply          run the SAME operation for real: validate → byte backup → write. Refused
//                  operations exit 1 and print the validator's own reasons — nothing is
//                  written, ever, unless the gate passes.
//   check          run the validators, grouped by code (the same grouping the UI's problems
//                  strip shows), exit 1 when anything is red. A read-only status an agent
//                  can poll before and after it works.
//   log            the journal of what agents did (content/build/agent-log.jsonl) — a human
//                  can see the machine's edits after the fact.
//
// RULES this file obeys (they are also in the skill, and the tests check some of them):
//   * content is written ONLY through the services' validated transactions — this CLI has no
//     write path of its own;
//   * `diff` never writes, `apply` always backs up (byte copy) before it does;
//   * nothing here reads or prints a secret; provider keys stay in the environment.
//
// Exit codes: 0 ok · 1 refused/failed (the reason is printed) · 2 usage.

const path = require('node:path');
const fs = require('node:fs');

const STUDIO_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(STUDIO_ROOT, '..');

const { createStudioServices } = require(path.join(STUDIO_ROOT, 'lib', 'studio-services.js'));
const { createToolServices } = require(path.join(REPO_ROOT, 'src', 'workbench', 'app', 'services.js'));
const actionModel = require(path.join(REPO_ROOT, 'src', 'workbench', 'lib', 'action-model.js'));
// the delivery door's name/containment checks are SHARED with bin/pipeline.js
// (lib/pipeline/intake.js) — one implementation, so the two doors cannot drift
// apart and the hardening from "harden the intake door against hostile delivery
// names" stays the single source of truth.
const intakeLib = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'intake.js'));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; index += 1; }
    } else positional.push(token);
  }
  return { positional, flags };
}

function services() {
  // --content / --resources (or STUDIO_CONTENT_DIR / STUDIO_CHARACTERS_ROOT) let an operation run
  // against a COPY of the tree — that is how the release acceptance rehearses a change end to end
  // (skill -> publish -> product runtime) without touching production bytes, and how an agent
  // would work on an exported project.
  const contentDir = process.env.STUDIO_CONTENT_DIR || path.join(REPO_ROOT, 'content');
  const charactersRoot = process.env.STUDIO_CHARACTERS_ROOT || path.join(REPO_ROOT, 'resources', 'characters');
  // the provenance ledger resolves through repoRoot ('<repoRoot>/content/characters/...'), so a
  // sandbox run needs the sandbox root — otherwise an override would quietly write its records
  // into the REAL tree (the studio's own provenance tests caught exactly that)
  const repoRoot = process.env.STUDIO_CONTENT_DIR ? path.dirname(contentDir) : REPO_ROOT;
  const studio = createStudioServices({ repoRoot, contentDir, charactersRoot, packId: 'deepseek-default' });
  // Frame reorder/duration are NOT in the studio bundle: the action editor drives them through
  // the shared workbench services (src/workbench/app/services.js, the M1 surface) — the same
  // code the UI's own action panel calls, so the CLI cannot diverge from the panel. The skill's
  // reference table names the exact method (`tool.actionOp`) rather than pretending one bundle
  // owns everything.
  const tool = createToolServices({
    repoRoot: REPO_ROOT, contentDir, charactersRoot, characterId: 'whale-girl', scheme: 'workbench',
  });
  return Object.assign(Object.create(null), studio, { tool, studio });
}

// ---- the operation table -----------------------------------------------------------
//
// One row per thing an agent may propose. `params` documents the JSON body `--params` takes;
// `run` maps it onto the service the UI's own panel uses. `dry` and `apply` must be the SAME
// call with save flipped — never two implementations (they would drift and the dry run would
// stop predicting the write).

const OPERATIONS = [
  {
    domain: 'scene', op: 'move', service: 'sceneEdit', summary: '把一件家具移到新位置（归一化 0..1）',
    params: { itemId: 'draft-27', position: { x: 0.4, y: 0.5 } },
    writes: true,
    run: (svc, params, { save }) => svc.sceneEdit({ sceneId: params.sceneId || 'flat', save, edits: [{ itemId: params.itemId, position: params.position }] }),
  },
  {
    domain: 'scene', op: 'scale', service: 'sceneEdit', summary: '改一件家具的缩放（0.2–3）',
    params: { itemId: 'draft-27', scale: 1.1 },
    writes: true,
    run: (svc, params, { save }) => svc.sceneEdit({ sceneId: params.sceneId || 'flat', save, edits: [{ itemId: params.itemId, scale: params.scale }] }),
  },
  {
    domain: 'scene', op: 'hide', service: 'sceneEdit', summary: '隐藏/显示一件家具（仍留在草稿里）',
    params: { itemId: 'draft-27', hidden: true },
    writes: true,
    run: (svc, params, { save }) => svc.sceneEdit({ sceneId: params.sceneId || 'flat', save, edits: [{ itemId: params.itemId, hidden: Boolean(params.hidden) }] }),
  },
  {
    domain: 'scene', op: 'add', service: 'sceneEdit', summary: '放进一件家具（素材库 id，如 flat-sofa）',
    params: { asset: 'flat-sofa', position: { x: 0.5, y: 0.5 } },
    writes: true,
    run: (svc, params, { save }) => {
      const catalog = svc.sceneFurniture();
      const row = catalog.ok ? catalog.rows.find((entry) => entry.asset === params.asset) : null;
      if (!row) return { ok: false, code: 'FURNITURE_UNKNOWN', message: `unknown asset ${params.asset}（可用：${catalog.ok ? catalog.rows.map((r) => r.asset).slice(0, 8).join(', ') : 'catalog unreadable'} …）` };
      return svc.sceneEdit({
        sceneId: params.sceneId || 'flat', save,
        edits: [{ add: { kind: row.kind, asset: row.asset, direction: row.direction, layer: params.layer || 30, position: params.position || { x: 0.5, y: 0.5 }, scale: params.scale } }],
      });
    },
  },
  {
    domain: 'scene', op: 'remove', service: 'sceneEdit', summary: '从布局里删掉一件家具',
    params: { itemId: 'draft-72' },
    writes: true,
    run: (svc, params, { save }) => svc.sceneEdit({ sceneId: params.sceneId || 'flat', save, edits: [{ itemId: params.itemId, remove: true }] }),
  },
  {
    domain: 'scene', op: 'sync-zones', service: 'sceneSyncZones', summary: '按当前布局重建碰撞区（改了布局后必须）',
    params: { write: true },
    writes: true,
    run: (svc, params, { save }) => svc.sceneSyncZones({ sceneId: params.sceneId || 'flat', write: save && Boolean(params.write) }),
  },
  {
    domain: 'action', op: 'reorder', service: 'tool.actionOp', summary: '把某帧移到新位置（帧序＝数组顺序）',
    params: { actionId: 'walk-left', from: 2, to: 0 },
    writes: true,
    run: (svc, params) => svc.tool.actionOp(params.actionId, 'move', { from: params.from, to: params.to }),
    // the M1 kernel always saves, so the dry run is done on the PURE model instead: same
    // function the kernel calls, minus the write
    dryRun: (svc, params) => {
      const read = svc.actionShow(params.actionId);
      if (!read.ok) return read;
      const outcome = actionModel.moveFrame(read.doc, Number(params.from), Number(params.to));
      return { ok: true, changed: outcome.changed, dry: true };
    },
  },
  {
    domain: 'action', op: 'duration', service: 'tool.actionOp', summary: '改某帧的时长（ms；留空＝包默认）',
    params: { actionId: 'walk-left', index: 3, durationMs: 120 },
    writes: true,
    run: (svc, params) => svc.tool.actionOp(params.actionId, 'duration', { index: params.index, value: params.durationMs === undefined ? null : params.durationMs }),
    dryRun: (svc, params) => {
      const read = svc.actionShow(params.actionId);
      if (!read.ok) return read;
      const outcome = actionModel.setFrameDuration(read.doc, Number(params.index), params.durationMs === undefined ? null : params.durationMs);
      return { ok: true, changed: outcome.changed, dry: true };
    },
  },
  {
    domain: 'action', op: 'tag', service: 'actionTag', summary: '加/去一个标签（如 walk / highlight）',
    params: { actionId: 'walk-left', tag: 'walk', remove: false },
    writes: true,
    run: (svc, params) => svc.actionTag({ actionId: params.actionId, tag: params.tag, remove: Boolean(params.remove) }),
    dryRun: (svc, params) => {
      const read = svc.actionShow(params.actionId);
      if (!read.ok) return read;
      const tags = (read.doc.tags || []);
      const has = tags.includes(params.tag);
      return { ok: true, dry: true, changed: params.remove ? has : !has, message: `标签 ${params.tag}：${has ? '在' : '不在'}（${params.remove ? '去掉' : '加上'}）` };
    },
  },
  {
    domain: 'action', op: 'pingpong', service: 'actionPingPong', summary: '开/关 ping-pong 循环',
    params: { actionId: 'walk-left', pingPong: true },
    writes: true,
    run: (svc, params) => svc.actionPingPong({ actionId: params.actionId, value: Boolean(params.pingPong) }),
    dryRun: (svc, params) => {
      const read = svc.actionShow(params.actionId);
      if (!read.ok) return read;
      return { ok: true, dry: true, changed: Boolean(read.doc.pingPong) !== Boolean(params.pingPong), message: `ping-pong：${read.doc.pingPong ? '开' : '关'} -> ${params.pingPong ? '开' : '关'}` };
    },
  },
  {
    domain: 'action', op: 'note', service: 'actionNoteAdd', summary: '按帧号加一条批注（绑定帧；帧序变了会标失效）',
    params: { actionId: 'walk-left', frame: 2, text: '裙摆被裁', severity: 'fix' },
    writes: true,
    run: (svc, params) => svc.actionNoteAdd({ actionId: params.actionId, frame: params.frame, text: params.text, severity: params.severity || 'note' }),
    // notes live in a SIDECAR file the service writes directly — reading the list is the dry run
    dryRun: (svc, params) => {
      const list = svc.actionNoteList({ actionId: params.actionId });
      if (!list.ok) return list;
      const count = (list.notes || []).length;
      return { ok: true, dry: true, changed: true, message: `第 ${params.frame} 帧加一条批注（${params.severity || 'note'}）：现有 ${count} 条 -> ${count + 1} 条` };
    },
  },
  {
    domain: 'dialogue', op: 'add', service: 'dialogueEdit', summary: '加一条台词（层：base | character）',
    params: { topic: 'pantry', text: '米缸还有半缸', weight: 2 },
    writes: true,
    run: (svc, params, { save }) => runDialogueOp(svc, { ...params, op: 'add' }, save),
  },
  {
    domain: 'dialogue', op: 'update', service: 'dialogueEdit', summary: '改一条台词（按 id）',
    params: { id: 'zz-01', text: '新的台词', weight: 3 },
    writes: true,
    run: (svc, params, { save }) => runDialogueOp(svc, { ...params, op: 'update' }, save),
  },
  {
    domain: 'dialogue', op: 'remove', service: 'dialogueEdit', summary: '删一条台词（按 id）',
    params: { id: 'zz-01' },
    writes: true,
    run: (svc, params, { save }) => runDialogueOp(svc, { ...params, op: 'remove' }, save),
  },
  {
    domain: 'graph', op: 'move-node', service: 'graphMoveNode', summary: '改一个节点的版面位置（只影响画布摆放）',
    params: { file: 'local-behaviour.vgraph.json', nodeId: 'beat', x: 0.2, y: 0.3 },
    writes: true,
    run: (svc, params, { save }) => {
      const file = resolveGraphFile(svc, params.file);
      if (!file.ok) return file;
      const read = svc.graphRead({ file: file.file });
      if (!read.ok) return read;
      const moved = svc.graphMoveNode({ graph: read.graph, nodeId: params.nodeId, x: params.x, y: params.y });
      if (!moved.ok || !save) return { ...moved, dry: !save };
      return svc.graphSave({ file: file.file, graph: moved.graph, dryRun: false });
    },
    // why this is safe: graphMoveNode persists, so the dry run only READS the graph and reports
    // where the node would land
    dryRun: (svc, params) => {
      const fileRef = resolveGraphFile(svc, params.file);
      if (!fileRef.ok) return fileRef;
      const read = svc.graphRead({ file: fileRef.file });
      if (!read.ok) return read;
      const layout = (read.graph.meta && read.graph.meta.layout) || {};
      const before = layout[params.nodeId] || null;
      return { ok: true, dry: true, changed: true, message: `节点 ${params.nodeId}：版面 ${before ? `${before.x},${before.y}` : '（未记录）'} -> ${params.x},${params.y}` };
    },
  },
  {
    domain: 'graph', op: 'save', service: 'graphSave', summary: '写一个图文件（先过校验：闭集/端口/环）',
    params: { file: 'local-behaviour.vgraph.json', graph: { schemaVersion: 1, nodes: [], edges: [] } },
    writes: true,
    run: (svc, params, { save }) => {
      const file = resolveGraphFile(svc, params.file);
      if (!file.ok) return file;
      return svc.graphSave({ file: file.file, graph: params.graph, dryRun: !save });
    },
  },
];

function findOperation(domain, op) {
  return OPERATIONS.find((entry) => entry.domain === domain && entry.op === op) || null;
}


// ---- dialogue: one process per operation ------------------------------------------
//
// `dialogueEdit` STAGES (it returns the document + a guard verdict) and `dialogueSave` needs
// that document — so a second CLI invocation can never save what the first staged. An agent
// works one command at a time, so the edit ops write by default (the guards run before the
// write; a red finding refuses and nothing lands) and `"stage": true` keeps the change in
// memory for a --json caller that wants to batch.
function runDialogueOp(svc, params, save) {
  const layer = params.layer || 'base';
  // The guard requires a kebab-case id on every entry (corpus.entry-id). Derive a STABLE one
  // from topic+text when the caller does not give one: the same line gets the same id, so an
  // add → remove → add cycle lands on the same id instead of growing a new one each time.
  const crypto = require('node:crypto');
  const autoId = () => `${String(params.topic).slice(0, 12)}-${crypto.createHash('sha1').update(`${params.topic}|${params.text}`).digest('hex').slice(0, 5)}`;
  // update/remove may name only the id: find which topic holds it (agents should not have to)
  let topic = params.topic;
  if (!topic && params.id) {
    const read = svc.dialogueRead({ layer });
    const topics = read.ok ? (layer === 'character' ? (read.doc.overrides || {}) : (read.doc.topics || {})) : {};
    topic = Object.keys(topics).find((name) => (topics[name] || []).some((item) => item.id === params.id)) || null;
    if (!topic) return { ok: false, code: 'DIALOGUE_ENTRY_UNKNOWN', message: `no entry ${params.id} in layer ${layer}` };
  }
  const entry = params.op === 'remove'
    ? undefined
    : (params.op === 'add'
      ? { id: params.id || autoId(), text: params.text, weight: params.weight === undefined ? 1 : params.weight, ...(params.if ? { if: params.if } : {}) }
      : undefined);
  const staged = svc.dialogueEdit({
    layer, op: params.op, topic, id: params.id,
    entry,
    patch: params.op === 'update' ? { ...(params.text === undefined ? {} : { text: params.text }), ...(params.weight === undefined ? {} : { weight: params.weight }), ...(params.if === undefined ? {} : { if: params.if }) } : null,
  });
  if (!staged.ok) return staged;
  if (!save || params.stage === true) return { ...staged, stagedOnly: true };
  const saved = svc.dialogueSave({ layer, doc: staged.doc });
  return { ...saved, changed: true };
}


// A graph may be named by its bare file name (what an agent sees in the tree) or by the path
// graphList reports — resolve both. Bare names that match nothing get a list to choose from,
// instead of a "file missing" that hides the real reason.
function resolveGraphFile(svc, file) {
  const list = svc.graphList();
  const graphs = (list.ok && list.graphs) || [];
  if (!file) return { ok: false, code: 'GRAPH_FILE_REQUIRED', message: `pick one of: ${graphs.map((row) => row.name).join(', ')}` };
  const wanted = String(file);
  const row = graphs.find((entry) => entry.name === wanted || entry.file === wanted || path.basename(entry.file) === path.basename(wanted));
  if (row) return { ok: true, file: row.file };
  return { ok: false, code: 'GRAPH_FILE_MISSING', message: `${wanted}（可用：${graphs.map((entry) => entry.name).join(', ')}）` };
}

// ---- human diffs -------------------------------------------------------------------
//
// The diff is the interface between the agent and the human: it must be readable without
// knowing the JSON shapes. Each domain knows how to describe "what is here now" and the
// change is expressed as before → after.

function sceneItems(svc, sceneId = 'flat') {
  const draft = svc.sceneDraft({ sceneId });
  return draft.ok ? draft.items : [];
}

function humanDiff(domain, op, params, svc, result) {
  const lines = [];
  if (domain === 'scene') {
    const items = sceneItems(svc, params.sceneId || 'flat');
    const find = (id) => items.find((item) => item.id === id);
    if (op === 'move' && params.itemId) {
      const item = find(params.itemId);
      const before = item ? `${item.position.x.toFixed(4)},${item.position.y.toFixed(4)}` : '（不存在）';
      const after = params.position ? `${Number(params.position.x).toFixed(4)},${Number(params.position.y).toFixed(4)}` : '（未给）';
      lines.push(`${params.itemId}: 位置 ${before} -> ${after}`);
    } else if (op === 'scale' && params.itemId) {
      const item = find(params.itemId);
      lines.push(`${params.itemId}: 缩放 ${item ? (item.scale ?? 1).toFixed(2) : '（不存在）'} -> ${Number(params.scale).toFixed(2)}`);
    } else if (op === 'hide' && params.itemId) {
      const item = find(params.itemId);
      lines.push(`${params.itemId}: 可见 ${item && item.hidden ? '隐藏' : '显示'} -> ${params.hidden ? '隐藏' : '显示'}`);
    } else if (op === 'remove' && params.itemId) {
      const item = find(params.itemId);
      lines.push(`${params.itemId}: 删除${item ? `（${item.kind} ${item.asset}）` : '（不存在）'}`);
    } else if (op === 'add') {
      lines.push(`新增一件：${params.asset} @ ${params.position ? `${params.position.x},${params.position.y}` : '中心'}（当前 ${items.length} 件 -> ${items.length + 1} 件）`);
    } else if (op === 'sync-zones') {
      const changes = result && result.changes ? result.changes : null;
      lines.push(changes
        ? `碰撞区：+${(changes.added || []).length} ~${(changes.moved || []).length} -${(changes.removed || []).length}`
        : '碰撞区：按当前布局重建');
    }
  } else if (domain === 'action') {
    // `actionShow` is the studio bundle's reader (the M1 surface calls it actionRead — one name
    // per bundle; the CLI must use the one that exists, which is what the contract test checks)
    const read = svc.actionShow(params.actionId);
    const frames = read.ok && read.doc ? (read.doc.frames || []).map((frame) => frame.file) : [];
    if (op === 'reorder') {
      lines.push(`${params.actionId}: 帧序 ${frames.join(' ')}`);
      lines.push(`  -> 把第 ${params.from} 帧移到位置 ${params.to}（顺序写进数组，不是文件名）`);
    } else if (op === 'duration') {
      const frame = read.ok && read.doc ? (read.doc.frames || [])[params.index] : null;
      lines.push(`${params.actionId} 第 ${params.index} 帧（${frame ? frame.file : '?'}）：时长 ${frame && frame.durationMs ? `${frame.durationMs}ms` : '默认'} -> ${params.durationMs === undefined || params.durationMs === null ? '默认' : `${params.durationMs}ms`}`);
    } else if (op === 'tag') {
      lines.push(`${params.actionId}: 标签 ${params.remove ? `去掉 ${params.tag}` : `加上 ${params.tag}`}`);
    } else if (op === 'pingpong') {
      lines.push(`${params.actionId}: ping-pong -> ${params.pingPong ? '开' : '关'}`);
    } else if (op === 'note') {
      lines.push(`${params.actionId} 第 ${params.frame} 帧：批注「${params.text}」（${params.severity || 'note'}）`);
    }
  } else if (domain === 'dialogue') {
    const read = svc.dialogueRead({ layer: params.layer || 'base' });
    const topics = read.ok && read.doc ? (read.doc.topics || {}) : {};
    const count = Object.values(topics).reduce((sum, list) => sum + list.length, 0);
    if (op === 'add') lines.push(`${params.layer || 'base'} · topic ${params.topic}: 新增「${params.text}」（共 ${count} 条 -> ${count + 1} 条）`);
    else if (op === 'update') lines.push(`${params.layer || 'base'} · 条目 ${params.id}: 更新为「${params.text}」`);
    else if (op === 'remove') lines.push(`${params.layer || 'base'} · 条目 ${params.id}: 删除`);
    else if (op === 'save') lines.push(`${params.layer || 'base'}: 把暂存改动写盘（${count} 条）`);
  } else if (domain === 'graph') {
    if (op === 'move-node') lines.push(`${params.file} · 节点 ${params.nodeId}: 版面位置 -> ${params.x},${params.y}（只影响摆放）`);
    else if (op === 'save') lines.push(`${params.file}: 写入 ${(params.graph && params.graph.nodes ? params.graph.nodes.length : 0)} 节点 / ${(params.graph && params.graph.edges ? params.graph.edges.length : 0)} 边`);
  }
  return lines;
}

// ---- the journal -------------------------------------------------------------------
//
// A machine's edits should be visible afterwards. One JSON line per apply/diff under
// content/build/ (tool output, not content), so a human can read what happened and when.

function journalPath(contentDir) {
  return path.join(contentDir, 'build', 'agent-log.jsonl');
}

function appendJournal(contentDir, entry) {
  try {
    fs.mkdirSync(path.dirname(journalPath(contentDir)), { recursive: true });
    fs.appendFileSync(journalPath(contentDir), `${JSON.stringify(entry)}\n`);
  } catch { /* the journal is a courtesy; never fail an operation over it */ }
}

function readJournal(contentDir, limit = 20) {
  try {
    return fs.readFileSync(journalPath(contentDir), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}


// ---- GENERATION HANDOFF ------------------------------------------------------------------
//
// The user's own AI agent does the video generation (whatever model/protocol it has) and the
// workbench takes over from S4. That decision lives here as two commands:
//
//   prompts   the recipe the agent must READ before generating: the guardrails (green screen,
//             no depth words, first/last = clean standing, feet locked, prop loop, safe margin),
//             the per-second beat sheet and the negative list — all built from the SAME
//             buildPromptPlan() the pipeline's own model stages use, so the recipe cannot drift
//             from what the pipeline would have asked for.
//   intake    the delivery door: verify the clips the agent brings (container/duration/fps/
//             resolution + green backdrop + a subject present in the first and last frame),
//             record the generation parameters in the provenance ledger (the breakpoint that
//             was never written before) and tell the caller which workbench command comes next.
//
// Nothing here calls a model provider, and no key is read.

const generationModule = require(path.join(STUDIO_ROOT, 'lib', 'pipeline', 'stages.js'));
const { spawnSync } = require('node:child_process');

function probeVideo(abs) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,codec_name,duration', '-of', 'json', abs], { encoding: 'utf8' });
  if (result.status !== 0) return { ok: false, code: 'FFPROBE_FAILED', message: String(result.stderr || '').slice(0, 200) };
  try {
    const parsed = JSON.parse(result.stdout);
    const stream = (parsed.streams || [])[0] || {};
    const [num, den] = String(stream.r_frame_rate || '0/1').split('/').map(Number);
    return {
      ok: true,
      codec: stream.codec_name || null,
      width: Number(stream.width) || null,
      height: Number(stream.height) || null,
      fps: den ? Number((num / den).toFixed(3)) : null,
      durationSec: stream.duration ? Number(Number(stream.duration).toFixed(3)) : null,
    };
  } catch (error) {
    return { ok: false, code: 'FFPROBE_UNPARSEABLE', message: String((error && error.message) || error) };
  }
}

// Two frames, analysed as RAW RGB straight out of ffmpeg (no PNG decoder in the path: a
// delivery from an agent may be any codec/scaling, and the raw path cannot silently fail on it).
// What the contract promises and this checks: a green backdrop must dominate, and something must
// be standing on it — in BOTH the first and the last frame (the "same clean standing pose" rule).
function rawFrameStats(abs, atSecond, tmpLabel, tmpDir) {
  const size = '160x90';
  const result = spawnSync('ffmpeg', [
    '-v', 'error', ...(atSecond === null ? ['-sseof', '-0.15'] : ['-ss', String(atSecond)]),
    '-i', abs, '-frames:v', '1', '-vf', `scale=${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout || result.stdout.length < 160 * 90 * 3) {
    return { ok: false, code: 'FRAME_READ_FAILED', message: String(result.stderr || '').slice(0, 160), label: tmpLabel };
  }
  const pixels = result.stdout;
  const total = 160 * 90;
  let green = 0;
  let backgroundish = 0;
  let subject = 0;
  let minX = 160;
  let maxX = -1;
  let minY = 90;
  let maxY = -1;
  for (let index = 0; index < total; index += 1) {
    const r = pixels[index * 3];
    const g = pixels[index * 3 + 1];
    const b = pixels[index * 3 + 2];
    const isGreen = g > 120 && g - r > 60 && g - b > 60;
    if (isGreen) green += 1;
    else backgroundish += 1;
    // "subject" = anything that is NOT the green backdrop. A saturation test would miss pale
    // characters (whale-girl is white/blue — the first version of this check called a real
    // subject "no subject"), so the honest criterion is simply "not green".
    if (!isGreen) {
      subject += 1;
      const x = index % 160;
      const y = Math.floor(index / 160);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bounds = maxX >= minX ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
  const marginRatio = bounds
    ? Math.min(bounds.x, bounds.y, 160 - (bounds.x + bounds.width), 90 - (bounds.y + bounds.height)) / 160
    : null;
  const footLine = bounds ? Math.round(((bounds.y + bounds.height) / 90) * 360) : null;   // back to source scale
  return {
    ok: true,
    label: tmpLabel,
    greenRatio: Number((green / total).toFixed(4)),
    nonGreenRatio: Number((backgroundish / total).toFixed(4)),
    subjectRatio: Number((subject / total).toFixed(4)),
    marginRatio: marginRatio === null ? null : Number(marginRatio.toFixed(4)),
    footLine,
    bounds,
  };
}

function inspectFrames(abs) {
  return {
    first: rawFrameStats(abs, 0, 'first'),
    last: rawFrameStats(abs, null, 'last'),
  };
}

function generationRecipe(kind, params) {
  const plan = generationModule.buildPromptPlan({
    kind: kind || 's3', action: params.action || 'walk-left', direction: params.direction || 'left',
    referenceHash: params.referenceHash || null, beatSeconds: params.beatSeconds || 10,
  });
  return plan;
}

function assembledPrompt(plan) {
  // the pipeline's plan is structured (guardrails + per-second beats + negatives); a generation
  // model needs one block of prose, so assemble it HERE, from that structure — the recipe and the
  // pipeline therefore always ask for the same thing
  const lines = [];
  lines.push(`参考图中的角色（保持同一设定：配色、服装、描边、比例、画风），拍一段 ${plan.action}${plan.direction ? `（朝 ${plan.direction}）` : ''} 的动作素材。`);
  lines.push('');
  lines.push('镜头与背景：固定机位，16:9，纯绿幕背景 #00FF00，画面里不出现地面、不出现投影、不出现文字或水印。');
  lines.push('运动约束：双脚锁定画布锚点，原地完成动作（只允许原地转身），不能有横向位移。');
  lines.push('');
  lines.push('按秒分节拍（第 1 秒与最后一秒都必须是干净的站姿）：');
  for (const beat of plan.beats || []) lines.push(`  第 ${beat.second} 秒：${beat.instruction}`);
  lines.push('');
  lines.push('必须满足：');
  for (const row of plan.guardrails || []) lines.push(`  - ${row}`);
  lines.push('');
  lines.push('不要出现：');
  for (const row of plan.negative || []) lines.push(`  - ${row}`);
  lines.push('');
  lines.push('交付规格：640×360 级、~24fps、10 秒级；给绿幕原片（不要自己抠像），放进 content/incoming/<动作>/。');
  return lines.join('\n');
}

function commandPrompts(flags) {
  const plan = generationRecipe(flags.kind, { action: flags.action, direction: flags.direction, beatSeconds: flags.beats ? Number(flags.beats) : 10 });
  plan.prompt = assembledPrompt(plan);
  if (flags.json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
  const lines = [];
  lines.push(`# 生成配方（${plan.kind} · ${plan.action}${plan.direction ? ` · ${plan.direction}` : ''}）`, '');
  lines.push('把你手上任何模型/工具都能用的提示词（下面整段照抄）：', '', '```text', plan.prompt, '```', '');
  if (plan.guardrails) lines.push('护栏：', ...plan.guardrails.map((row) => `- ${row}`), '');
  if (plan.negative) lines.push('负面词：', ...plan.negative.map((row) => `- ${row}`), '');
  if (plan.beats) lines.push('按秒分节拍：', ...plan.beats.map((row) => `- ${typeof row === 'string' ? row : JSON.stringify(row)}`), '');
  lines.push('交付：绿幕原片（不要自己抠像）放进 content/incoming/<动作>/，然后 `node bin/agent.js intake --dir content/incoming/<动作> --action <动作>`。');
  console.log(lines.join('\n'));
  return 0;
}

function sceneIntakeArtifacts(format, plan, videos) {
  return format === 'json' ? JSON.stringify({ plan, videos }, null, 2) : `${plan}\n\n${videos}`;
}

function commandIntake(flags) {
  const svc = services();
  const contentDir = process.env.STUDIO_CONTENT_DIR || path.join(REPO_ROOT, 'content');
  const dir = flags.dir ? path.resolve(String(flags.dir)) : path.join(contentDir, 'incoming');
  if (!fs.existsSync(dir)) { console.error(`交付目录不存在：${dir}`); return 2; }
  // A delivery door takes names from outside, and a name becomes a COMMAND-LINE VALUE for ffprobe
  // and ffmpeg below. So names are validated HERE, strictly: plain file names only — no path
  // separators, no leading dash or space, no control characters. An unsafe name is reported and
  // never reaches a spawned process (verified: `--` is not a usable terminator for this ffprobe,
  // it prints its banner instead — so the gate is the defence, not the terminator).
  const allNames = fs.readdirSync(dir).sort();
  const videoNames = allNames.filter((name) => /\.(mp4|mov|webm|mkv)$/i.test(name));
  // plain names only (letter/digit first, letters/digits/._- after, known video
  // extension) — the shared check, see lib/pipeline/intake.js
  const isSafe = (name) => intakeLib.isSafeDeliveryName(name, { extensions: intakeLib.VIDEO_EXTENSIONS });
  const unsafeNames = videoNames.filter((name) => !isSafe(name));
  const entries = videoNames.filter((name) => isSafe(name));
  const unsafeFindings = unsafeNames.map((name) => ({
    severity: 'red', code: 'INTAKE_UNSAFE_NAME',
    message: `文件名 ${JSON.stringify(name)} 不安全（只接受字母/数字开头、不含路径分隔符与空格的普通文件名）`,
    fix: 'rename the file to a plain name (letters/digits/._- only) and deliver it again',
  }));
  if (entries.length === 0 && unsafeNames.length === 0) { console.error(`交付目录里没有视频：${dir}`); return 2; }
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'intake-'));
  const report = { dir, at: new Date().toISOString(), action: flags.action || null, clips: [] };
  let ok = true;
  for (const name of entries) {
    const abs = path.join(dir, name);
    // containment: the file must really sit inside the delivery dir and be a regular file — a
    // symlink pointing elsewhere would otherwise smuggle in a path from outside the door
    // (the shared check from lib/pipeline/intake.js)
    const inside = intakeLib.isRegularFileInside(dir, abs);
    if (!inside.ok) {
      ok = false;
      report.clips.push({ file: name, probe: { ok: false, code: inside.code }, frames: {}, findings: [{ severity: 'red', code: inside.code, message: `${name} 不在交付目录内（或不是普通文件）` }], ledger: null });
      continue;
    }
    const probe = probeVideo(abs);
    const frames = inspectFrames(abs);
    const findings = [];
    if (!probe.ok) findings.push({ severity: 'red', code: probe.code, message: probe.message || '' });
    if (probe.ok) {
      if (!probe.durationSec || probe.durationSec < 2) findings.push({ severity: 'red', code: 'INTAKE_TOO_SHORT', message: `时长 ${probe.durationSec}s（至少 2s）` });
      if (probe.durationSec && probe.durationSec > 20) findings.push({ severity: 'yellow', code: 'INTAKE_TOO_LONG', message: `时长 ${probe.durationSec}s（10s 级更省体积）` });
      if (probe.fps && Math.abs(probe.fps - 24) > 2) findings.push({ severity: 'yellow', code: 'INTAKE_FPS_OFF', message: `${probe.fps}fps（建议 ~24）` });
    }
    for (const label of ['first', 'last']) {
      const frame = frames[label];
      if (!frame || !frame.ok) { findings.push({ severity: 'yellow', code: `INTAKE_FRAME_${label.toUpperCase()}_UNREADABLE`, message: `${label} 帧读不出来` }); continue; }
      if (frame.greenRatio !== null && frame.greenRatio < 0.25) findings.push({ severity: 'red', code: 'INTAKE_NOT_GREEN_SCREEN', message: `${label} 帧绿幕占比 ${(frame.greenRatio * 100).toFixed(1)}%（要求明显绿幕底色）` });
      if (frame.subjectRatio !== null && frame.subjectRatio < 0.01) findings.push({ severity: 'red', code: 'INTAKE_NO_SUBJECT', message: `${label} 帧里看不到主体（几乎全是背景）` });
      if (frame.marginRatio !== null && frame.marginRatio < 0.05) findings.push({ severity: 'yellow', code: 'INTAKE_MARGIN_TIGHT', message: `${label} 帧主体离边 ${(frame.marginRatio * 100).toFixed(1)}%（护栏要求 ≥10%）` });
    }
    const first = frames.first || {};
    const last = frames.last || {};
    if (first.ok && last.ok && first.footLine !== null && last.footLine !== null && Math.abs(first.footLine - last.footLine) > 3) {
      findings.push({ severity: 'yellow', code: 'INTAKE_FEET_DRIFT', message: `首尾帧脚线差 ${Math.abs(first.footLine - last.footLine)}px（首尾应是同一站姿）` });
    }
    const reds = findings.filter((row) => row.severity === 'red');
    if (reds.length > 0) ok = false;

    // the ledger: generation parameters recorded where the passport looks for them (this is the
    // "call params were never recorded" breakpoint the P0 work opened)
    const actionId = flags.action || /^([a-z0-9-]+)/.exec(name)[1];
    // the ledger hashes the prompt itself and keeps a fixed field set (kind/provider/model/tool/
    // promptHash/seed/references/outputs), so speak THAT schema: `references` carries the clip we
    // received (with its hash), `tool` says who recorded it
    const clipHash = require('node:crypto').createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    const recorded = svc.recordParams({
      actionId, kind: 'video',
      model: flags.model ? String(flags.model) : 'external-agent',
      provider: flags.provider ? String(flags.provider) : 'external-agent',
      tool: 'studio/bin/agent.js intake',
      // if the caller does not hand over the prompt text, record the RECIPE we told them to use
      // (assembled from the same plan) — "which prompt produced this clip" is the provenance value,
      // and silently recording nothing would reopen the very breakpoint this closes
      prompt: flags['prompt-file']
        ? fs.readFileSync(String(flags['prompt-file']), 'utf8')
        : (flags.prompt ? String(flags.prompt) : assembledPrompt(generationRecipe(flags.kind, { action: flags.action, direction: flags.direction }))),
      seed: flags.seed === undefined ? null : Number(flags.seed),
      references: [{ path: name, role: 'source-video', sha256: clipHash }],
      outputs: [],
    });
    report.clips.push({ file: name, probe, frames: { first: { greenRatio: first.greenRatio, opaqueRatio: first.opaqueRatio, footLine: first.footLine }, last: { greenRatio: last.greenRatio, footLine: last.footLine } }, findings, ledger: recorded.ok ? recorded.fileRelative : null, actionId });
  }
  if (unsafeFindings.length > 0) {
    ok = false;
    console.error(`拒绝 ${unsafeFindings.length} 个不安全的文件名（未交给 ffprobe/ffmpeg）`);
    for (const finding of unsafeFindings) report.clips.push({ file: finding.message, probe: { ok: false, code: finding.code }, frames: {}, findings: [finding], ledger: null });
  }
  report.ok = ok;
  const outDir = path.join(contentDir, 'build', 'intake');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${report.action || 'delivery'}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`${report.ok ? '接收通过' : '有问题'} · ${report.clips.length} 个片段 · 记录 ${path.relative(REPO_ROOT, outFile)}`);
    for (const clip of report.clips) {
      // null-safe: an entry that was refused BEFORE probing (an unsafe name) has no frames and
      // no probe details — the first version of this line crashed while reporting such a refusal
      const first = (clip.frames && clip.frames.first) || {};
      const measured = clip.probe && clip.probe.ok
        ? `${clip.probe.width}×${clip.probe.height} ${clip.probe.fps}fps ${clip.probe.durationSec}s`
        : '探测失败';
      const green = first.greenRatio === null || first.greenRatio === undefined ? '?' : `${(first.greenRatio * 100).toFixed(0)}%`;
      console.log(`  ${clip.file}: ${measured} · 绿幕 ${green} · 台账 ${clip.ledger ? '已记录' : '未记录'}`);
      for (const finding of clip.findings) console.log(`    [${finding.severity}] ${finding.code}: ${finding.message}`);
    }
    console.log('下一步（工作台接手）：node bin/pipeline.js matte <png> → qc video → run --action <id> → 发布');
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return report.ok ? 0 : 1;
}

// ---- commands ----------------------------------------------------------------------

const USAGE = `usage:
  agent capabilities [--json|--md]             what an agent may do (one table, mapped onto real services)
  agent check [--domain scene|action|dialogue|graph|all] [--json]   validators, grouped by code
  agent diff  --domain <d> --op <o> --params '<json>'               dry run + human diff (writes nothing)
  agent apply --domain <d> --op <o> --params '<json>'               the same operation, for real
  agent log [--n 20] [--json]                  what agents changed (content/build/agent-log.jsonl)

  GENERATION IS YOURS, NOT OURS — the workbench does not hold provider keys:
  agent prompts [--action <id>] [--direction left] [--json]   the recipe to READ before generating
  agent intake --dir <delivery dir> [--action <id>] [--model <name>] [--prompt-file <f>] [--seed <n>]
                                               verify delivered clips + record generation params

env: STUDIO_CONTENT_DIR / STUDIO_CHARACTERS_ROOT point the operations at a COPY of the tree
     (the release acceptance uses this to rehearse a change before it touches production).

exit codes: 0 ok · 1 refused/failed · 2 usage`;

function parseParams(flags) {
  if (flags.params === undefined) return {};
  if (typeof flags.params === 'object') return {};
  try {
    return JSON.parse(flags.params);
  } catch (error) {
    console.error(`--params 不是合法 JSON：${error.message}`);
    process.exit(2);
  }
}

function commandCapabilities(flags) {
  if (flags.md) {
    const lines = ['# 代理可用的操作（由 `node studio/bin/agent.js capabilities --md` 生成，勿手改）', ''];
    const byDomain = new Map();
    for (const entry of OPERATIONS) {
      if (!byDomain.has(entry.domain)) byDomain.set(entry.domain, []);
      byDomain.get(entry.domain).push(entry);
    }
    for (const [domain, entries] of byDomain) {
      lines.push(`## ${domain}`, '', '| op | 作用 | 走的服务 | 参数示例 |', '|---|---|---|---|');
      for (const entry of entries) {
        lines.push(`| \`${entry.op}\` | ${entry.summary} | \`${entry.service}\` | \`${JSON.stringify(entry.params)}\` |`);
      }
      lines.push('');
    }
    lines.push('> `diff` 用同样的参数做一次**试算**（不写盘），`apply` 校验通过才写（先做字节备份）。', '');
    console.log(lines.join('\n'));
    return 0;
  }
  if (flags.json) {
    console.log(JSON.stringify({ operations: OPERATIONS.map((entry) => ({ domain: entry.domain, op: entry.op, summary: entry.summary, service: entry.service, params: entry.params, writes: entry.writes })) }, null, 2));
    return 0;
  }
  for (const entry of OPERATIONS) {
    console.log(`${entry.domain}.${entry.op}  ${entry.summary}\n    参数：${JSON.stringify(entry.params)}`);
  }
  return 0;
}

function commandCheck(flags) {
  const svc = services();
  const domain = flags.domain || 'all';
  const findings = [];
  const push = (source, rows) => { for (const row of rows) findings.push({ source, ...row }); };
  if (domain === 'all' || domain === 'scene') {
    const report = svc.sceneReport({});
    push('scene', (report.violations || []).map((v) => ({ severity: v.severity, code: v.code, message: v.message, itemId: v.itemId })));
    if (report.ok === false && (report.violations || []).length === 0) push('scene', [{ severity: 'red', code: report.code || 'SCENE_INVALID', message: report.message || '' }]);
  }
  if (domain === 'all' || domain === 'dialogue') {
    const outcome = svc.dialogueValidate();
    push('dialogue', (outcome.findings || []).map((f) => ({ severity: f.severity, code: f.code, message: f.detail || '' })));
  }
  if (domain === 'all' || domain === 'action') {
    const gaps = svc.actionGaps();
    push('action', (gaps.capabilities || []).filter((row) => row.required && row.status !== 'complete').map((row) => ({ severity: 'red', code: `GAP_${row.id}`, message: `${row.label}（${row.status}）` })));
  }
  if (domain === 'all' || domain === 'graph') {
    for (const file of svc.graphList().files || []) {
      const read = svc.graphRead({ file: file.name || file });
      if (!read.ok) { push('graph', [{ severity: 'red', code: read.code || 'GRAPH_UNREADABLE', message: String(file) }]); continue; }
      const outcome = svc.graphValidate({ graph: read.graph });
      push('graph', (outcome.violations || []).map((v) => ({ severity: v.severity || 'red', code: v.check || 'GRAPH_INVALID', message: v.detail || '' })));
    }
  }
  const groups = new Map();
  for (const finding of findings) {
    const key = `${finding.source}|${finding.severity}|${finding.code}`;
    if (!groups.has(key)) groups.set(key, { source: finding.source, severity: finding.severity, code: finding.code, count: 0, examples: [] });
    const group = groups.get(key);
    group.count += 1;
    if (group.examples.length < 3 && finding.message) group.examples.push(finding.message);
  }
  const counts = { red: 0, yellow: 0, note: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] || 0) + 1;
  const payload = { ok: counts.red === 0, counts, groups: [...groups.values()] };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`${payload.ok ? 'OK' : 'RED'} · 错误 ${counts.red} · 提醒 ${counts.yellow} · 说明 ${counts.note}`);
    for (const group of payload.groups) console.log(`  [${group.severity}] ${group.source} ${group.code}${group.count > 1 ? ` ×${group.count}` : ''}${group.examples[0] ? ` — ${group.examples[0]}` : ''}`);
  }
  return payload.ok ? 0 : 1;
}

function runOperation(command, flags) {
  const svc = services();
  const domain = flags.domain;
  const op = flags.op;
  if (!domain || !op) { console.error(USAGE); return 2; }
  const entry = findOperation(String(domain), String(op));
  if (!entry) {
    console.error(`未知操作：${domain}.${op}（可用：node studio/bin/agent.js capabilities）`);
    return 2;
  }
  const params = parseParams(flags);
  const dry = command === 'diff';
  // graph.save takes a whole document: --params must carry it, and a dry run asks the
  // service's own validator (graphSave has dryRun) rather than writing.
  let result;
  try {
    // DIFF MUST NOT WRITE. Some rows drive services with no dry-run mode (the M1 action kernel
    // always saves), so a row can provide its own `dryRun` — and the contract test proves the
    // promise by hashing the files it could touch before and after a diff.
    result = dry && entry.dryRun ? entry.dryRun(svc, params) : entry.run(svc, params, { save: !dry, dry });
  } catch (error) {
    result = { ok: false, code: 'OPERATION_THREW', message: String((error && error.message) || error) };
  }
  const diff = humanDiff(entry.domain, entry.op, params, svc, result);
  const payload = {
    domain: entry.domain, op: entry.op, mode: dry ? 'diff' : 'apply',
    ok: Boolean(result && result.ok !== false),
    code: (result && result.code) || null,
    message: (result && result.message) || null,
    noop: Boolean(result && result.noop),
    backup: (result && result.backup) || null,
    violations: (result && result.violations) || (result && result.findings) || [],
    diff,
  };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`${payload.ok ? (payload.noop ? 'NO-OP' : dry ? '试算通过' : '已写入') : `被拒绝：${payload.code}`} · ${entry.domain}.${entry.op}`);
    for (const line of diff) console.log(`  ${line}`);
    if (payload.message) console.log(`  ${payload.message}`);
    for (const violation of payload.violations.slice(0, 5)) console.log(`  ! ${violation.code}: ${violation.message || violation.detail || ''}`);
    if (payload.backup) console.log(`  备份：${payload.backup}`);
  }
  appendJournal(svc.info().contentDir, {
    at: new Date().toISOString(), mode: payload.mode, domain: payload.domain, op: payload.op,
    ok: payload.ok, code: payload.code, diff, params: Object.keys(params).length ? params : undefined,
  });
  return payload.ok ? 0 : 1;
}

function commandLog(flags) {
  const svc = services();
  const rows = readJournal(svc.info().contentDir, Number(flags.n) || 20);
  if (flags.json) console.log(JSON.stringify({ entries: rows }, null, 2));
  else if (rows.length === 0) console.log('（还没有代理改动记录）');
  else for (const row of rows) console.log(`${row.at}  ${row.mode}  ${row.domain}.${row.op}  ${row.ok ? 'ok' : `拒:${row.code}`}\n    ${(row.diff || []).join('；')}`);
  return 0;
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (!command || flags.help) { console.log(USAGE); return command ? 0 : 2; }
  if (command === 'capabilities') return commandCapabilities(flags);
  if (command === 'check') return commandCheck(flags);
  if (command === 'diff' || command === 'apply') return runOperation(command, flags);
  if (command === 'log') return commandLog(flags);
  if (command === 'prompts') return commandPrompts(flags);
  if (command === 'intake') return commandIntake(flags);
  console.error(USAGE);
  return 2;
}

if (require.main === module) process.exit(main());

// `services` is exported so the skill's contract test builds the SAME bundle the CLI does
// (a test that assembles its own would happily pass while the CLI resolved nothing).
module.exports = { OPERATIONS, findOperation, humanDiff, services, main, USAGE };
