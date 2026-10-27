'use strict';

// src/work/work.js — 工作台视图（v0.7 P1）。
// 只消费 main 推送的状态载荷；所有用户文本一律走 textContent（不拼 HTML）。

const api = window.workApi;
const $ = (id) => document.getElementById(id);
// 坞模式：同一个页面，窄栏布局 + 「展开全屏」。
const compactMode = new URLSearchParams(location.search).get('compact') === '1';
if (compactMode) document.body.classList.add('compact');

let lang = 'zh';
let state = null;
let selectedKey = null;
let selectedItemId = null;
let busy = false;

function tr(key, vars) {
  const value = api && api.i18n ? api.i18n.t(lang, key, vars) : null;
  return !value || value === key ? '' : value;
}

function applyStaticI18n() {
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const text = tr(el.dataset.i18n);
    if (text) el.textContent = text;
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const text = tr(el.dataset.i18nPlaceholder);
    if (text) el.placeholder = text;
  }
}

function errorText(code) {
  if (!code) return '';
  return tr(`work.error.${code}`) || code;
}

function timeText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function sizeText(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function artifactByKey(key) {
  if (!state || !Array.isArray(state.artifacts)) return null;
  return state.artifacts.find((entry) => entry.key === key) || null;
}

function selectedItem() {
  if (!state) return null;
  if (selectedItemId) {
    const found = state.items.find((item) => item.workItemId === selectedItemId);
    if (found) return found;
  }
  return state.current || state.items[state.items.length - 1] || null;
}

function setNotice(text, bad = false) {
  const el = $('notice');
  el.textContent = text || '';
  el.classList.toggle('bad', !!bad);
}

function setOnboardNotice(text) {
  $('onboardNotice').textContent = text || '';
}

function renderTeamBadge() {
  const team = (state && state.team) || {};
  const running = !!(team.active && team.jobStatus === 'running');
  const attention = !!(team.active && team.jobStatus === 'attention');
  $('teamDot').className = running ? 'live' : attention ? 'busy' : '';
  $('teamText').textContent = attention
    ? tr('work.status.attention')
    : running ? (tr('work.status.running') + (team.progressPhase ? ` · ${tr(`office.staff.currentTool.${team.progressPhase}`)}` : ''))
      : tr('work.status.idle');
}

function render() {
  const hasWorkspace = !!(state && state.workspace);
  $('onboarding').hidden = hasWorkspace;
  $('main').hidden = !hasWorkspace;
  $('changeWs').hidden = !hasWorkspace || compactMode;
  $('expandWork').hidden = !compactMode;
  renderTeamBadge();

  if (!hasWorkspace) {
    if (state && state.code) setOnboardNotice(errorText(state.code));
    return;
  }

  $('wsName').textContent = state.workspace.displayPath.split(/[\\/]/).filter(Boolean).pop() || state.workspace.id;
  $('wsPath').textContent = state.workspace.displayPath;
  $('wsPath').title = state.workspace.displayPath;

  renderItems();
  renderDetail();
}

function renderItems() {
  const list = $('items');
  list.textContent = '';
  const items = (state.items || []).slice().reverse();
  for (const item of items) {
    const li = document.createElement('li');
    li.classList.toggle('on', selectedItem() && selectedItem().workItemId === item.workItemId);
    const goal = document.createElement('span');
    goal.className = 'goal';
    goal.textContent = item.goal;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${tr(`work.status.${item.status}`)}${item.startedAtMs ? ` · ${timeText(item.startedAtMs)}` : ''}`;
    li.append(goal, meta);
    li.addEventListener('click', () => {
      selectedItemId = item.workItemId;
      selectedKey = null;
      hideViewer();
      render();
    });
    list.appendChild(li);
  }
}

function hideViewer() {
  $('viewerWrap').hidden = true;
  $('viewerPre').textContent = '';
  $('viewerTitle').textContent = '';
  $('viewerMeta').textContent = '';
  $('viewerNote').textContent = '';
}

function renderDetail() {
  const item = selectedItem();
  $('emptyDetail').hidden = !!item;
  $('detailBody').hidden = !item;
  if (!item) return;

  $('detailGoal').textContent = item.goal;
  const badge = $('detailStatus');
  badge.className = `badge ${item.status}`;
  badge.textContent = tr(`work.status.${item.status}`);
  const phase = item.phase || (state.team && state.team.active ? state.team.progressPhase : null);
  $('detailPhase').textContent = phase ? tr(`office.staff.currentTool.${phase}`) : '';

  const active = !!(state.active && state.current && state.current.workItemId === item.workItemId);
  $('startBtn').disabled = busy || !!state.active;
  $('cancelBtn').hidden = !active;
  // 被 Team 门禁挡住时"继续"没有意义（缺的是上游产物，不是会话）；只留取消/放弃。
  $('resumeBtn').hidden = !(active && item.status === 'attention' && !item.blockedCode);
  $('blockedNote').hidden = !item.blockedCode;
  $('blockedNote').textContent = item.blockedCode
    ? (tr(`work.blocked.${item.blockedCode}`) || tr('work.blocked.generic'))
    : '';
  $('changeWs').disabled = !!state.active;

  const list = $('artifacts');
  list.textContent = '';
  const refs = Array.isArray(item.artifactRefs) ? item.artifactRefs : [];
  $('artifactEmpty').hidden = refs.length > 0;
  for (const key of refs) {
    const artifact = artifactByKey(key);
    if (!artifact) continue;
    const li = document.createElement('li');
    li.classList.toggle('on', selectedKey === key);
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = tr(`work.kind.${artifact.kind}`) || artifact.kind;
    const producer = document.createElement('span');
    producer.className = 'meta';
    producer.textContent = [artifact.producerRole, sizeText(artifact.bytes), timeText(artifact.createdAtMs)]
      .filter(Boolean).join(' · ');
    li.append(kind, producer);
    li.addEventListener('click', () => readArtifact(key));
    list.appendChild(li);
  }
}

async function readArtifact(key) {
  selectedKey = key;
  renderDetail();
  $('viewerWrap').hidden = false;
  $('viewerNote').textContent = tr('work.artifact.reading');
  try {
    const result = await api.invoke({ action: 'open-artifact', key, verb: 'read' });
    if (!result || !result.ok) {
      $('viewerNote').textContent = errorText(result && result.code);
      $('viewerPre').textContent = '';
      return;
    }
    const artifact = artifactByKey(key);
    $('viewerTitle').textContent = tr(`work.kind.${result.kind}`) || result.kind;
    $('viewerMeta').textContent = artifact
      ? [artifact.producerRole, sizeText(artifact.bytes), timeText(artifact.createdAtMs)].filter(Boolean).join(' · ')
      : '';
    $('viewerPre').textContent = result.text;
    $('viewerNote').textContent = result.truncated ? tr('work.artifact.truncated') : '';
  } catch (error) {
    $('viewerNote').textContent = errorText(error && error.code);
  }
}

async function act(payload) {
  try {
    const result = await api.invoke(payload);
    if (result && result.ok) return result;
    setNotice(errorText(result && result.code), true);
    return null;
  } catch (error) {
    setNotice(errorText(error && error.code), true);
    return null;
  }
}

async function startTask(event) {
  event.preventDefault();
  const goal = $('goal').value.trim();
  if (!goal) return;
  busy = true;
  $('startBtn').disabled = true;
  setNotice('');
  const verifyCommand = ($('verifyCmd').value || '').trim();
  const result = await act({ action: 'start', goal, verifyCommand });
  busy = false;
  if (result) {
    $('goal').value = '';
    $('verifyCmd').value = '';
    apply(result);
  } else {
    renderDetail();
  }
}

async function resumeTask() {
  const result = await act({ action: 'resume' });
  if (result) setNotice('');
}

async function cancelTask() {
  const result = await act({ action: 'cancel' });
  if (!result) return;
  setNotice(result.abandoned ? tr('work.abandoned') : tr('work.cancelRequested'));
}

async function createWorkspace() {
  const name = $('newWsName').value.trim();
  if (!name) return;
  setOnboardNotice('');
  const result = await act({ action: 'select-workspace', create: name });
  if (result) {
    $('newWsName').value = '';
    apply(result);
  }
}

async function openWorkspace() {
  const picked = await api.pickFolder().catch(() => null);
  if (!picked || !picked.path) return;
  setOnboardNotice('');
  const result = await act({ action: 'select-workspace', path: picked.path });
  if (result) apply(result);
}

function apply(next) {
  state = next;
  if (!selectedItemId && state && state.current) selectedItemId = state.current.workItemId;
  render();
}

function bind() {
  $('taskForm').addEventListener('submit', startTask);
  $('cancelBtn').addEventListener('click', cancelTask);
  $('resumeBtn').addEventListener('click', resumeTask);
  $('createWs').addEventListener('click', createWorkspace);
  $('openWs').addEventListener('click', openWorkspace);
  $('changeWs').addEventListener('click', () => { hideViewer(); $('onboarding').hidden = false; $('main').hidden = true; });
  $('expandWork').addEventListener('click', () => act({ action: 'expand' }));
  $('openArtifact').addEventListener('click', () => {
    if (selectedKey) act({ action: 'open-artifact', key: selectedKey, verb: 'open' });
  });
  $('revealArtifact').addEventListener('click', () => {
    if (selectedKey) act({ action: 'open-artifact', key: selectedKey, verb: 'reveal' });
  });
  $('goal').addEventListener('input', renderDetail);
  if (api) api.onUpdate((next) => apply(next));
}

async function boot() {
  applyStaticI18n();
  bind();
  try {
    const theme = await api.getTheme();
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  } catch { /* theme is cosmetic */ }
  try {
    const value = await api.getLanguage();
    if (value === 'zh' || value === 'en') lang = value;
  } catch { /* fallback zh */ }
  applyStaticI18n();
  // 词典是异步拉取的；到货后重填静态文案与状态标签（否则英文用户会看到 HTML 里的中文回退）。
  if (api && api.i18n && api.i18n.loaded) {
    api.i18n.loaded.then(() => { applyStaticI18n(); render(); }).catch(() => {});
  }
  if (api && api.onLanguage) {
    api.onLanguage((value) => {
      if (value !== 'zh' && value !== 'en') return;
      lang = value;
      applyStaticI18n();
      render();
    });
  }
  if (api && api.onTheme) {
    api.onTheme((value) => { document.documentElement.dataset.theme = value === 'light' ? 'light' : 'dark'; });
  }
  try {
    const initial = await api.invoke({ action: 'status' });
    if (initial) apply(initial);
  } catch (error) {
    setOnboardNotice(errorText(error && error.code));
  }
}

boot();
