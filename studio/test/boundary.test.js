'use strict';

// studio/test/boundary.test.js — the studio's structural contracts.
//
// These are the invariants a future phase must not silently break:
//   1. one implementation per concern — both entry points share the app layer
//      (src/workbench/app/**) instead of duplicating protocol/IPC boot code;
//   2. the product never reaches into the tool (src/main.js dependency graph
//      excludes studio/** and src/workbench/**);
//   3. the studio's bridge and its IPC handlers declare the same channels;
//   4. the studio's own artifacts are gitignored, its scripts resolve, and
//      every JS file parses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const STUDIO_ROOT = path.join(__dirname, '..');
const ROOT = path.resolve(STUDIO_ROOT, '..');

function read(file) {
  return fs.readFileSync(path.join(STUDIO_ROOT, file), 'utf8');
}

test('both entry points share the app layer instead of duplicating it', () => {
  const studioMain = read('main.js');
  const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'office-workbench.js'), 'utf8');
  for (const [label, source] of [['studio/main.js', studioMain], ['scripts/office-workbench.js', launcher]]) {
    assert.match(source, /require\([^)]*src['"],\s*['"]workbench['"],\s*['"]app['"],\s*['"]boot\.js['"]\)|require\(path\.join\(__dirname, '\.\.', 'src', 'workbench', 'app', 'boot\.js'\)\)/,
      `${label} boots through src/workbench/app/boot.js`);
    assert.doesNotMatch(source, /protocol\.handle\(/, `${label} never registers protocol handlers itself (boot.js owns them)`);
    assert.doesNotMatch(source, /ipcMain\.handle\('workbench:/, `${label} never registers tool IPC itself (ipc.js owns it)`);
  }
});

test('the legacy entry keeps the vocabulary its evidence probes pin', () => {
  const launcher = fs.readFileSync(path.join(ROOT, 'scripts', 'office-workbench.js'), 'utf8');
  assert.match(launcher, /OFFICE_WORKBENCH_READY/);
  assert.match(launcher, /'Office Workbench'/);
  assert.match(launcher, /\.workbench-data/);
  assert.match(launcher, /OFFICE_WORKBENCH_LAYOUT_READONLY/);
  assert.match(launcher, /WORKBENCH_EVIDENCE_DIR/);
  assert.match(launcher, /WORKBENCH_M1_EVIDENCE_DIR/);
});

test('the product entry dependency graph never reaches the tool trees', () => {
  const visited = new Set();
  const queue = [path.join(ROOT, 'src', 'main.js')];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)) {
      const base = path.resolve(path.dirname(file), match[2]);
      const resolved = fs.existsSync(base) && fs.statSync(base).isFile() ? base : `${base}.js`;
      if (!resolved.startsWith(path.join(ROOT, 'src') + path.sep) || !resolved.endsWith('.js')) continue;
      queue.push(resolved);
    }
  }
  assert.ok(visited.size >= 20, `the require walk traversed the product graph (${visited.size} files)`);
  const offenders = [...visited].filter((file) => (
    file.includes(`${path.sep}src${path.sep}workbench${path.sep}`) || file.includes(`${path.sep}content${path.sep}`)
  ));
  assert.deepEqual(offenders, [], 'product graph excludes src/workbench/** and content/**');

  // the studio is a tool tree as well: no product file may IMPORT it. The scan
  // looks for real dependency shapes (require/import of a studio path) — a plain
  // mention in prose or in a vendor URL is not a dependency. (grep exits 1 when
  // there is no match, which is the expected, passing case.)
  const grep = spawnSync('grep', [
    '-rlE',
    String.raw`(require\(['"][^'"]*studio/|from ['"][^'"]*studio/)`,
    path.join(ROOT, 'src'), path.join(ROOT, 'scripts'), path.join(ROOT, 'test'),
  ], { encoding: 'utf8' });
  assert.ok(grep.status === 0 || grep.status === 1, `grep ran (status ${grep.status}: ${grep.stderr})`);
  const productGrep = String(grep.stdout || '').split('\n').filter(Boolean)
    .filter((file) => !file.includes(`${path.sep}src${path.sep}workbench${path.sep}`));
  assert.deepEqual(productGrep, [], 'no product file imports the studio tree');
});

test('the studio bridge and the studio IPC handlers declare the same channels', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench-preload.js'), 'utf8');
  const studioMain = read('main.js');
  const bridgeBlock = preload.slice(preload.indexOf('studioBridge'));
  const bridged = [...bridgeBlock.matchAll(/ipcRenderer\.invoke\('(studio:[a-z-]+)'/g)].map((match) => match[1]);
  const handled = [...studioMain.matchAll(/ipcMain\.handle\('(studio:[a-z-]+)'/g)].map((match) => match[1]);
  assert.ok(bridged.length >= 5, `the bridge carries the studio surface (${bridged.length} channels)`);
  assert.deepEqual([...bridged].sort(), [...handled].sort(), 'every bridged channel has exactly one handler');
});

test('the tool IPC channel list matches what the renderer bridges', () => {
  const { CHANNELS } = require(path.join(ROOT, 'src', 'workbench', 'app', 'ipc.js'));
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench-preload.js'), 'utf8');
  const bridged = new Set([...preload.matchAll(/ipcRenderer\.invoke\('(workbench:[a-z-]+)'/g)].map((match) => match[1]));
  assert.deepEqual(CHANNELS.filter((channel) => !bridged.has(channel)), [], 'every declared channel is bridged');
  assert.deepEqual([...bridged].filter((channel) => !CHANNELS.includes(channel)), [], 'every bridged channel is declared');
});

test('the studio artifacts are gitignored and its scripts resolve', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.studio-data\/$/m, 'the studio userData is ignored');
  assert.match(ignore, /^studio\/build\/$/m, 'regenerable studio output is ignored');

  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.studio, /electron/, 'npm run studio launches Electron');
  const electronCli = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
  const referenced = path.resolve(STUDIO_ROOT, pkg.scripts.studio.replace(/^node\s+/, '').split(' ')[0]);
  assert.equal(referenced, electronCli, 'the studio script points at the repo Electron');
  assert.ok(fs.existsSync(electronCli), 'the Electron dev dependency is installed');
  assert.match(pkg.scripts.test, /node --test test\/\*\.test\.js/, 'npm test runs the studio suite');
  assert.match(pkg.scripts.provenance, /bin\/provenance\.js/, 'npm run provenance exposes the passport CLI');
});

test('every studio JS file parses', () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'build' || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.js')) files.push(abs);
    }
  };
  walk(STUDIO_ROOT);
  assert.ok(files.length >= 7, `studio JS files scanned (${files.length})`);
  for (const file of files) execFileSync(process.execPath, ['--check', file]);
});

test('the docs the phase promises exist and name the real contracts', () => {
  for (const doc of ['docs/architecture.md', 'docs/contracts.md', 'docs/providers.md', 'docs/provenance.md']) {
    const abs = path.join(STUDIO_ROOT, doc);
    assert.ok(fs.existsSync(abs), `${doc} exists`);
    assert.ok(fs.readFileSync(abs, 'utf8').length > 800, `${doc} has real content`);
  }
  const contracts = read('docs/contracts.md');
  assert.match(contracts, /content\/characters\/<id>\/character\.json/);
  assert.match(contracts, /schemaVersion/);
});

// ---- the shell's workspace affordances (UI/UX pass, 2026-09-28) ---------------

test('the shell offers a collapsible three-pane workspace with a rail tab switcher', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  // the pinned surfaces survive the redesign
  for (const id of ['wb-left', 'wb-center', 'wb-right', 'preview-slot', 'panel-geometry', 'panel-assets', 'panel-gallery', 'geometry-table', 'asset-table']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} still exists`);
  }
  // collapse controls + rails for both sides
  for (const id of ['btn-toggle-left', 'btn-toggle-right', 'wb-rail-left', 'wb-rail-right']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  assert.match(css, /\.wb-left-collapsed/, 'the collapsed left state has a rule');
  assert.match(css, /\.wb-right-collapsed/, 'the collapsed right state has a rule');
  assert.match(css, /--wb-rail-w/, 'the rail width is a token');
  // every tab has a rail counterpart, so the rail can switch tabs while collapsed
  const tabs = [...html.matchAll(/id="tab-([a-z-]+)" class="wb-tab"/g)].map((match) => `tab-${match[1]}`);
  assert.ok(tabs.length >= 8, `the tab strip carries every domain (${tabs.length})`);
  for (const tab of tabs) assert.match(html, new RegExp(`data-tab="${tab}"`), `the rail has an entry for ${tab}`);
  // keyboard affordances and remembered state
  assert.match(js, /event\.key === 'b'/, '⌘/Ctrl+B toggles the tree');
  assert.match(js, /event\.key === 'j'/, '⌘/Ctrl+J toggles the inspector');
  assert.match(js, /localStorage/, 'UI state (panes, tab, tree) is remembered');
  assert.match(js, /wb-shell-state-v1/, 'the shell state key is versioned');
  assert.match(js, /wb-tree-state-v1/, 'the tree state key is versioned');
});

test('the file tree behaves like an editor explorer, not a decorative list', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  // rows carry a twisty, an icon, a name, a size and a depth-driven indent
  for (const cls of ['tree-row', 'tree-twisty', 'tree-icon', 'tree-name', 'tree-size', 'tree-children']) {
    assert.match(js + fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8'), new RegExp(cls), `${cls} is styled/created`);
  }
  assert.match(js, /paddingLeft = `\$\{2 \+ depth \* 12\}px`/, 'indentation follows depth');
  // keyboard navigation: arrows move/expand/collapse, Enter selects
  for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter']) {
    assert.match(js, new RegExp(`event\\.key === '${key}'`), `${key} is handled`);
  }
  // filter + expand/collapse all
  assert.match(js, /filterTree\(/, 'the filter walks the tree');
  assert.match(html, /id="tree-filter"/, 'the filter input exists');
  assert.match(html, /id="btn-tree-collapse"/, 'collapse-all exists');
  assert.match(html, /id="btn-tree-expand"/, 'expand-all exists');
  // selecting a file still drives the inspector (the old behaviour is preserved)
  assert.match(js, /refreshFileGeometry\(entry\.path\)/, 'clicking a file still hands it to the inspector');
});

// ---- the review bench timeline (UI #3) ---------------------------------------

test('the review bench carries a scrubbable timeline with event and annotation markers', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  for (const id of ['bench-timeline', 'timeline-track', 'timeline-playhead', 'timeline-readout', 'btn-timeline-play', 'btn-timeline-step', 'btn-timeline-reset', 'timeline-speed']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  // the timeline is a slider for assistive tech
  assert.match(html, /id="bench-timeline"[^>]*role="slider"/, 'the timeline exposes the slider role');
  // segments are proportional to the frame durations, and both marker kinds exist
  assert.match(js, /function timelineModelOf/, 'the model derives from the bench data');
  assert.match(js, /segment\.style\.flex = `\$\{duration\} 0 0`/, 'segment width is the frame duration');
  assert.match(css, /\.timeline-event\b/, 'event markers are styled');
  assert.match(css, /\.timeline-note\b/, 'annotation markers are styled');
  // playback: play/pause, scrub by pointer, step, reset, speed, and the ping-pong fold
  assert.match(js, /function startPlaying/, 'playback exists');
  assert.match(js, /function scrubTo/, 'scrubbing exists');
  assert.match(js, /function frameAtMs/, 'the playhead maps to a frame index');
  assert.match(js, /timeline\.pingPong\s*\n?\s*\?/, 'ping-pong folds the cycle');
  assert.match(js, /event\.key === ' '/, 'space toggles playback from the keyboard');
  assert.match(js, /event\.key === 'ArrowLeft'[\s\S]{0,200}ArrowRight|ArrowRight'\)/, 'arrow keys step frames');
  // the playhead drives the frame strip, so the two views cannot disagree
  assert.match(js, /classList\.toggle\('current'/, 'the current frame is highlighted');
});

// ---- the visual pass (2026-09-28): themes, contrast tokens, empty states ---------

test('the shell ships two themes through one token set, with a toggle', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  assert.match(html, /id="btn-theme"/, 'the theme control exists');
  assert.match(css, /@media \(prefers-color-scheme: dark\)/, 'the system preference is honoured');
  assert.match(css, /body\[data-theme="light"\]/, 'an explicit light override exists');
  assert.match(css, /body\[data-theme="dark"\]/, 'an explicit dark override exists');
  assert.match(css, /--wb-on-accent/, 'the label colour for the accent surface is a token');
  assert.match(js, /THEME_ORDER/, 'the toggle cycles through the modes');
  assert.match(js, /wb-shell-state-v1/, 'the choice is remembered with the rest of the shell state');
  assert.match(js, /applyTheme/, 'the theme is applied on boot, not only on click');
});

test('lists that can be empty say what to do next', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  assert.match(css, /\.wb-empty/, 'the empty-state block is styled');
  const emptyBlocks = [...js.matchAll(/className = 'wb-empty'/g)].length;
  assert.ok(emptyBlocks >= 3, `the tree, the preview table and the dialogue table have empty states (${emptyBlocks})`);
  // the copy itself lives in the i18n dictionary now (one place, two languages); the
  // renderer references the keys, and the dictionary's both-sides-non-empty check plus
  // the i18n suite carry the wording
  for (const key of ['empty.tree', 'empty.preview', 'empty.dialogue']) {
    assert.match(js, new RegExp(`t\\('${key.replace('.', '\\.')}'\\)`), `the ${key} empty state comes from the dictionary`);
  }
});

// ---- the R1 restructure: the canvas is the middle, one tool at a time ---------------

test('the middle of the window is a stage: one canvas, view + edit + run on its own toolbar', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  // since R2-B the stage lives in its own module (app/stage.js, a classic script that is
  // also require()-able); the renderer keeps the wiring
  const stageModule = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'app', 'stage.js'), 'utf8');
  // the stage and its parts
  for (const id of ['stage', 'stage-toolbar', 'stage-viewport', 'stage-world', 'stage-scene-layer', 'stage-empty', 'stage-statusbar', 'stage-zoom']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  // the two layers share the stage, and the mode decides which one is live
  assert.match(html, /id="stage-scene-layer"[\s\S]{0,400}id="scene-canvas"/, 'the edit layer holds the scene canvas');
  assert.match(html, /id="preview-slot"[\s\S]{0,1200}id="preview-frame"/, 'the run layer holds the office page');
  assert.match(css, /#stage\[data-mode="edit"\] #preview-slot \{ display: none; \}/, 'edit mode hides the office layer');
  assert.match(css, /#stage\[data-mode="run"\] #stage-scene-layer \{ display: none; \}/, 'run mode hides the edit layer');
  // what you do TO the canvas lives on its toolbar — not buried in a side panel.
  // T11 moved the RUN controls off it (播放/单步/重开/倍速 now live on the dock's own
  // toolbar, once — see the T11 test below), so the canvas toolbar keeps exactly what it
  // is for: modes, the view, and the edit layer's save/reload.
  const toolbar = html.slice(html.indexOf('id="stage-toolbar"'), html.indexOf('id="stage-viewport"'));
  for (const id of ['btn-stage-fit', 'btn-stage-zoom-in', 'btn-stage-zoom-out', 'btn-stage-reset', 'btn-stage-mode-edit', 'btn-stage-mode-run', 'btn-canvas-save', 'btn-canvas-reload']) {
    assert.ok(toolbar.includes(`id="${id}"`), `${id} is on the canvas toolbar`);
  }
  for (const id of ['btn-preview-play', 'btn-preview-step', 'btn-preview-restart', 'preview-speed', 'preview-status']) {
    assert.ok(!toolbar.includes(`id="${id}"`), `${id} is no longer split onto the canvas toolbar (T11: one host, the dock's)`);
  }
  // the view maths exist, and fitting is what a mode switch does — so "运行" cannot land
  // on an empty view
  for (const fn of ['function stageApply', 'function stageFit', 'function stageReset', 'function stageZoomBy', 'function stageSetMode', 'function stageAnnounce']) {
    assert.ok(stageModule.includes(fn), `${fn} exists in the stage module`);
  }
  assert.match(stageModule, /function stageSetMode\(mode[\s\S]{0,1100}stageFit\(\);/, 'switching mode fits the view');
  assert.match(js, /stage\.setMode\('run', \{ silent: true \}\)/, 'play/step/restart bring the run layer up');
  assert.match(stageModule, /wheel[\s\S]{0,200}stageZoomBy/, 'the wheel zooms');
  assert.match(stageModule, /stageViewport\.addEventListener\('pointermove'[\s\S]{0,300}stageState\.x =/, 'dragging the background pans');
  assert.match(stageModule, /window\.wbStage = wbStageApi/, 'the stage module exposes itself to the page');
  assert.match(html, /<script src="\.\/app\/stage\.js"><\/script>/, 'the page loads the stage module before the renderer');
});

test('the work area is one page at a time, and the stage never leaves the DOM', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  // six pages in an activity bar, each naming itself and the layout it wants
  const pages = [...html.matchAll(/id="page-([a-z]+)" class="wb-page-btn" data-page="([a-z]+)"/g)];
  assert.equal(pages.length, 7, 'seven activity-bar pages (the generation page joined in R5)');
  assert.equal([...html.matchAll(/id="page-view-/g)].length, 7, 'seven page containers');
  for (const page of ['scene', 'animation', 'behaviour', 'dialogue', 'generation', 'quality', 'observe']) {
    assert.ok(new RegExp(`PAGES = \\[[^\\]]*'${page}'`).test(js) || js.includes(`'${page}'`), `${page} is a known page`);
  }
  // exactly one panel is open in the markup (the canvas page's inspector), and every panel
  // still exists somewhere in the page tree (ten from the R2-B re-layout + the scene page's
  // property panel, T6 — the count is a floor, not a ceiling)
  const panels = [...html.matchAll(/<section id="panel-([a-z-]+)" class="wb-panel"([^>]*)>/g)];
  for (const id of ['panel-geometry', 'panel-actions', 'panel-assets', 'panel-gallery', 'panel-passport', 'panel-scene', 'panel-bench', 'panel-graph', 'panel-dialogue', 'panel-preview']) {
    assert.ok(panels.some((match) => match[1] === id.replace('panel-', '')), `${id} survives the re-layout`);
  }
  assert.ok(panels.length >= 11, `the panels survive the re-layout (${panels.length}, incl. #panel-item)`);
  assert.equal(panels.filter((m) => !/hidden/.test(m[2])).length, 1, 'one panel starts visible');
  // the stage lives in the dock and is NEVER removed: its ids are pinned. (T11 inserts the
  // dock's own toolbar between the dock and the stage — the window is wide enough for the
  // comment that explains why.)
  assert.match(html, /id="wb-dock"[\s\S]{0,1600}id="stage"/, 'the stage is inside the dock');
  assert.match(css, /body:not\(\[data-page="scene"\]\):not\(\[data-page="observe"\]\) #wb-dock/, 'non-canvas pages dock the stage');
  assert.match(js, /function setPage\(/, 'page switching exists');
  assert.match(js, /document\.body\.dataset\.page = page/, 'the layout is driven by body[data-page]');
  assert.match(js, /lastTabOfPage/, 'each page remembers its own sub-view');
  // the chips keep the id + class contract and gain the page that owns them
  assert.equal([...html.matchAll(/id="tab-[a-z-]+" class="wb-tab" data-page="[a-z]+"/g)].length, 11, 'eleven chips, each bound to a page');
  assert.match(css, /#wb-tabs \.wb-tab \{ display: none; \}/, 'chips are filtered by page');
  // noise: the standing discipline sentence and the filled obstacle boxes are gone (T12)
  assert.ok(!html.includes('wb-theme-note'), 'the topbar discipline sentence is gone');
  assert.ok(!html.includes('id="tree-hint"'), 'the standing tree hints are gone');
  assert.match(js, /obstacles are stroke-only|strokeStyle = 'rgba\(194, 58, 58, 0\.35\)'/, 'obstacles are a thin stroke, not a fill');
  // the palette is a scene-page tool (T13)
  assert.match(css, /body:not\(\[data-page="scene"\]\) #library-root/, 'the furniture palette is scene-scoped');
});

test('the tree is a palette you can drag onto the canvas, and a drop is routed by file type', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  // tree rows are draggable and carry their path
  assert.match(js, /row\.draggable = true/, 'tree rows drag');
  assert.match(js, /setData\('application\/x-wb-path', entry\.path\)/, 'a drag carries the file path');
  // the furniture library renders as draggable tiles from the PRODUCT catalog
  assert.match(html, /id="library-root"/, 'the library lives in the left pane');
  assert.match(js, /studio\.sceneFurniture/, 'the tiles come from the catalog service');
  assert.match(js, /application\/x-wb-furniture/, 'a tile drag is a furniture drag');
  assert.match(css, /\.library-tile/, 'the tiles are styled');
  // the drop surface exists and refuses unknown types with a reason (app/stage.js since R2-B)
  const stageModule = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'app', 'stage.js'), 'utf8');
  assert.match(stageModule, /addEventListener\('dragover'/, 'the stage accepts drags');
  assert.match(stageModule, /DROP_UNSUPPORTED/, 'an unsupported drop is refused by a stable code');
  assert.match(stageModule, /DOCUMENT_TOOLS/, 'documents are routed to their tool');
  // the only drop that writes content goes through the validated transaction
  assert.match(js, /stage\.setFurnitureDropHandler\(async/, 'the furniture drop has its own handler');
  assert.match(js, /const edit = \{ add: \{/, 'a drop is an add edit');
  assert.match(js, /const trial = await studio\.sceneEdit\(\{ sceneId: sceneState\.sceneId, edits: \[edit\], save: false \}\)[\s\S]{0,900}save: true/, 'the drop dry-runs before it writes');
  assert.match(js, /已放进布局/, 'and it says so in the canvas status line');
});

// ---- the P8 UX pass: palette, splitters, hot reload, telemetry ---------------------

test('one command table drives the palette and the keyboard map', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  for (const id of ['wb-palette', 'wb-palette-input', 'wb-palette-list', 'wb-palette-hint']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  assert.match(html, /role="dialog"/, 'the palette is a dialog for assistive tech');
  assert.match(css, /#wb-palette\[hidden\]/, 'the palette hides without layout leftovers');
  // the command table covers the domains, and each command has an id + group + run
  const table = js.slice(js.indexOf('function commands()'), js.indexOf('function renderPalette()'));
  for (const group of ['cmd.group.tab', 'cmd.group.pane', 'cmd.group.content', 'cmd.group.check', 'cmd.group.preview', 'cmd.group.data']) {
    assert.ok(table.includes(group), `${group} appears in the command table`);
  }
  // ids come in two shapes: literals and the tab loop's template literal
  const commands = [
    ...[...table.matchAll(/id: '([a-z:.-]+)'/g)].map((match) => match[1]),
    ...[...table.matchAll(/id: `([a-z:.-]+)\$\{/g)].map((match) => match[1]),
  ];
  // the tab loop and the scenario loop generate their ids from templates, so the count is
  // of id SHAPES: ten tabs in one loop + the explicit commands
  assert.ok(commands.length >= 16, `the palette carries the whole surface (${commands.length} id shapes)`);
  assert.ok(table.includes('`tab:${tabId}`'), 'the ten tab commands come from the loop');
  assert.ok(table.includes('preview:scenario:${scenario}'), 'the scenario commands come from the loop');
  // shortcuts exist for the palette, the panes, the tabs and a reload
  for (const key of ["event.key === 'k'", "event.key === 'b'", "event.key === 'j'", "event.key === 'r'", "event.key === 'Escape'"]) {
    assert.ok(js.includes(key), `${key} is handled`);
  }
  assert.match(js, /\/\^\[0-9\]\$\/\.test\(event\.key\)/, 'digit shortcuts jump between tabs');
  assert.match(js, /ArrowDown[\s\S]{0,120}ArrowUp|ArrowUp[\s\S]{0,120}ArrowDown/, 'arrows move the palette selection');
});

test('the pane widths are draggable, keyboard-adjustable and remembered', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  for (const id of ['wb-splitter-left', 'wb-splitter-right']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
    assert.match(html, new RegExp(`id="${id}"[^>]*role="separator"`), `${id} is a separator`);
    assert.match(html, new RegExp(`id="${id}"[^>]*tabindex="0"`), `${id} is focusable`);
  }
  assert.match(css, /\.wb-splitter/, 'the splitter is styled');
  assert.match(js, /WIDTH_LIMITS/, 'the widths are clamped');
  assert.match(js, /--wb-left-w/, 'the left width drives the grid token');
  assert.match(js, /dblclick/, 'a double click restores the default width');
  assert.match(js, /widths: \{ left: 268, right: 440 \}/, 'defaults are declared');
  assert.match(js, /wb-shell-state-v1/, 'widths persist with the shell state');
});

test('content changes are watched and re-read, without silently swapping the simulation', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const services = fs.readFileSync(path.join(ROOT, 'studio', 'lib', 'studio-services.js'), 'utf8');
  assert.match(services, /fs\.watch\(/, 'the service watches the content tree');
  assert.match(services, /CONTENT_WATCH_UNAVAILABLE/, 'a platform without recursive watching degrades loudly');
  assert.match(services, /build\//, 'tool output is excluded from the watcher');
  assert.match(js, /onContentChanged/, 'the renderer subscribes');
  assert.match(js, /async function reloadContent/, 'there is a manual reload too');
  assert.match(js, /panelRefresh/, 'the active panel re-reads its own data');
  assert.match(js, /运行预览需/, 'the status says the preview needs a restart instead of swapping it');
  assert.match(js, /⌘\/Ctrl\+R|event\.key === 'r'/, 'a keyboard shortcut reloads content');
});

test('the preview diagnostics bundle carries the page telemetry', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const services = fs.readFileSync(path.join(ROOT, 'studio', 'lib', 'studio-services.js'), 'utf8');
  assert.match(html, /id="btn-preview-telemetry"/, 'the telemetry button exists');
  assert.match(html, /id="preview-telemetry"/, 'the telemetry readout exists');
  assert.match(js, /rafPerSecond/, 'idle repaint is measured in the page');
  assert.match(js, /rendererTelemetry/, 'the telemetry travels with the bundle');
  assert.match(services, /setTelemetryReader/, 'the main process attaches the frame reader');
  assert.match(services, /TELEMETRY_READER_MISSING/, 'a missing reader is a stable code, not a crash');
});

// ---- the scene page's selected-item property panel (T6) --------------------------

test('the scene page inspects the selected item, and every edit goes through the scene transaction', () => {
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const i18n = require(path.join(ROOT, 'src', 'workbench', 'i18n.js'));
  // the panel lives in the inspector, under its head, next to the scene check it joins
  const inspector = html.slice(html.indexOf('id="wb-right"'), html.indexOf('id="wb-splitter-left"'));
  assert.ok(inspector.indexOf('id="panel-item"') > inspector.indexOf('id="wb-inspector-head"'),
    '#panel-item sits inside the inspector, below its head');
  assert.ok(inspector.includes('id="panel-item"') && inspector.includes('id="panel-scene"'),
    'the scene page owns the property panel AND the scene check');
  assert.ok(inspector.indexOf('id="panel-item"') < inspector.indexOf('id="panel-scene"'),
    'the property panel sits above the scene check');
  assert.match(html, /<section id="panel-item" class="wb-panel" hidden/, 'the property panel starts hidden');
  // the form itself: numbers for the numeric properties, a toggle for hidden, a
  // read-only line for what is selected
  for (const id of ['item-prop-form', 'item-prop-x', 'item-prop-y', 'item-prop-scale', 'item-prop-layer', 'item-prop-name', 'item-prop-hidden', 'item-prop-meta', 'item-prop-apply', 'item-prop-reset', 'item-prop-status']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  assert.match(html, /type="number" id="item-prop-x" step="0\.001" min="0" max="1"/, 'x is a normalized stepped number input');
  assert.match(html, /type="number" id="item-prop-y" step="0\.001" min="0" max="1"/, 'y is a normalized stepped number input');
  assert.match(html, /type="number" id="item-prop-scale" step="0\.01" min="0\.2" max="3"/, 'scale carries the editor clamp');
  assert.match(html, /type="number" id="item-prop-layer" step="1"/, 'the layer is an integer');
  assert.match(html, /type="text" id="item-prop-name"/, 'the name is a text field');
  assert.match(html, /type="checkbox" id="item-prop-hidden"/, 'hidden is a checkbox');
  // the write path is the canvas' own: stageEdit (dry run → validate → redraw), never a
  // direct service call from the panel and never a file
  assert.match(js, /async function stageEdit\(itemId, patch\)/, 'the shared edit path exists');
  assert.match(js, /await stageEdit\(item\.id, patch\)/, 'the apply goes through stageEdit');
  const applyBlock = js.slice(js.indexOf('async function applyItemProps'), js.indexOf("document.getElementById('item-prop-apply')"));
  assert.doesNotMatch(applyBlock, /studio\.sceneEdit|writeFileSync|save: true/,
    'the panel never calls the service or writes a file itself');
  assert.doesNotMatch(js, /writeFileSync/, 'the renderer has no file writing at all');
  assert.match(applyBlock, /ITEM_LIMITS/, 'the panel applies the editor\'s own clamps, not the browser\'s');
  // the clamps are the canvas' own, applied on apply (not per keystroke, so a half-typed
  // number cannot be staged)
  assert.match(js, /const ITEM_LIMITS = \{[\s\S]*?position: \{ min: 0, max: 1 \}[\s\S]*?scale: \{ min: 0\.2, max: 3 \}/, 'the clamps match the editor');
  assert.match(js, /itemForm\.addEventListener\('submit'/, 'Enter applies — a deliberate press');
  assert.doesNotMatch(js, /propX\.addEventListener\('input'/, 'typing never stages an edit');
  // the panel follows the selection, and pending values are what it shows
  assert.match(js, /function syncItemPanel\(/, 'the form is refilled from the selection');
  assert.match(js, /function currentItem\(\)/, 'the panel reads the selected item through one door');
  assert.match(js, /pending\.has\(panelItem\.id\) \? ` · \$\{t\('item\.pending'\)\}`/, 'an unsaved item says so in the panel');
  // the panel is scene-page scoped
  const setPageBlock = js.slice(js.indexOf('function setPage('), js.indexOf('function activateTab('));
  assert.match(setPageBlock, /itemPanel\.hidden = page !== 'scene'/, 'the property panel follows the scene page');
  assert.match(setPageBlock, /INSPECTOR_PANELS\[page\]/, 'the inspector-empty rule names the panels a page owns');
  const workArea = html.slice(html.indexOf('id="wb-mainview"'), html.indexOf('id="wb-dock"'));
  assert.ok(!workArea.includes('id="panel-item"'), 'the property panel is not a work-area panel: it follows the page, not a tab');
  // every string the panel shows is a dictionary key, in both languages
  for (const key of ['head.item', 'item.none', 'item.hint', 'item.x', 'item.y', 'item.scale', 'item.layer',
    'item.name', 'item.hidden', 'item.nameNote', 'item.pending', 'item.clamped', 'item.ignored',
    'item.applied', 'item.noChange', 'item.refill', 'item.refused', 'item.nameLocked', 'item.crashed',
    'btn.itemApply', 'btn.itemReset']) {
    assert.ok(i18n.DICT[key], `${key} is declared`);
    assert.ok(i18n.DICT[key].zh.trim().length > 0 && i18n.DICT[key].en.trim().length > 0, `${key} carries both languages`);
    assert.notEqual(i18n.DICT[key].zh, i18n.DICT[key].en, `${key} is really translated`);
  }
  assert.match(css, /#panel-item \{ flex: 0 0 auto; \}/, 'the form takes only the height it needs');
  assert.match(css, /#item-prop-status\.bad \{ color: var\(--wb-bad\)/, 'a refused edit is coloured with a token');
});

// ---- T7: ONE timeline on the 动作 page, and a danger zone for its production writes ---

test('the 动作 page has exactly one timeline: the duplicate frame list is gone', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const services = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'app', 'services.js'), 'utf8');
  // the editor's frame-card timeline is deleted — markup, plumbing AND its styles
  assert.ok(!html.includes('id="action-timeline"'), '#action-timeline is gone from the markup');
  assert.ok(!html.includes('class="action-frame"') && !js.includes("className = 'action-frame'"), 'the frame cards are gone');
  assert.ok(!js.includes("getElementById('action-timeline')"), 'no code looks the removed timeline up');
  assert.ok(!css.includes('.action-frame') && !css.includes('.action-insert'), 'the frame-card styles are gone');
  assert.ok(!html.includes('id="btn-action-publish" title="校验全绿才写 resources/**；先备份，失败不落盘">发布到 resources/**</button>\n            <button type="button" id="btn-action-step"'), 'the publish button is no longer in the action toolbar');
  // exactly one timeline of the #bench-timeline kind, and it is a slider
  assert.equal([...html.matchAll(/id="bench-timeline"/g)].length, 1, 'exactly one #bench-timeline exists');
  const timelineIds = [...html.matchAll(/id="(bench-timeline|timeline-track|timeline-playhead|timeline-readout|timeline-speed)"/g)].map((match) => match[1]);
  assert.equal(timelineIds.length, 5, `one node per timeline part (${timelineIds.join(', ')})`);
  assert.match(html, /id="bench-timeline"[^>]*role="slider"/, 'the timeline exposes the slider role');
  // it lives in the PAGE, not in one of the two sub-views: both chips share it
  const page = html.slice(html.indexOf('id="page-view-animation"'), html.indexOf('id="page-view-behaviour"'));
  assert.ok(page.indexOf('id="action-timeline-block"') < page.indexOf('id="panel-actions"'), 'the timeline block precedes the sub-views');
  assert.ok(page.indexOf('id="action-timeline-block"') < page.indexOf('id="panel-bench"'), 'and is not inside the bench sub-view');
  assert.ok(!page.slice(page.indexOf('id="panel-bench"')).includes('id="bench-timeline"'), 'the bench sub-view keeps no second timeline');
  for (const id of ['btn-timeline-play', 'btn-timeline-step', 'btn-timeline-reset', 'timeline-speed']) {
    assert.ok(page.includes(`id="${id}"`), `the timeline keeps ${id}`);
  }
  // the editing affordances the frame cards had now live ON the timeline
  assert.match(js, /segment\.draggable = true/, 'segments are draggable (reorder)');
  assert.match(js, /segment\.style\.flex = `\$\{duration\} 0 0`/, 'segment width is that frame\'s duration');
  assert.match(js, /durationInput\.addEventListener\('change'/, 'the selected frame\'s duration is editable');
  assert.match(js, /actionTimeline\.onMove\(/, 'the editor registers the reorder writer');
  assert.match(js, /actionTimeline\.onDuration\(/, 'the editor registers the duration writer');
  assert.match(js, /actionTimeline\.onInsert\(/, 'the editor registers the insert-position writer');
  // the scrubbing behaviour the bench timeline had is preserved
  for (const fn of ['function timelineModelOf', 'function frameAtMs', 'function scrubTo', 'function startPlaying']) {
    assert.ok(js.includes(fn), `${fn} exists`);
  }
  assert.match(js, /classList\.toggle\('current'/, 'the playhead still drives the frame strip');

  testFrameOrderRule(js, services);

  // the danger zone: publishing and migration write production, so they are marked and
  // each needs a second click (never a native confirm(), which blocks the probe path)
  assert.match(html, /id="action-danger-zone"/, 'the danger zone exists');
  assert.ok(page.indexOf('id="action-danger-zone"') > page.indexOf('id="panel-bench"'), 'it sits after the two sub-views, inside the page');
  const zone = page.slice(page.indexOf('id="action-danger-zone"'));
  const toolbar = page.slice(page.indexOf('id="action-toolbar"'), page.indexOf('id="action-import"'));
  for (const id of ['btn-action-publish', 'btn-bench-migrate', 'btn-bench-publish']) {
    assert.ok(zone.includes(`id="${id}"`), `${id} is inside the danger zone`);
  }
  assert.ok(!toolbar.includes('id="btn-action-publish"'), 'the publish button is no longer in the action toolbar');
  const benchToolbar = page.slice(page.indexOf('id="bench-toolbar"'), page.indexOf('id="bench-strip"'));
  assert.ok(!benchToolbar.includes('id="btn-bench-migrate"') && !benchToolbar.includes('id="btn-bench-publish"'),
    'nor the migrate/publish pair in the bench toolbar');
  assert.match(html, /id="action-danger-zone" class="wb-danger-zone"/, 'the zone carries its class');
  assert.match(css, /\.wb-danger-zone \{[\s\S]*?border: 1px solid var\(--wb-bad\)/, 'the zone is red-bordered with a token');
  assert.match(css, /#danger-buttons button\.armed \{ background: var\(--wb-bad\)/, 'the armed state is marked');
  assert.doesNotMatch(js, /window\.confirm\(|confirm\(/, 'no native confirm() is used');
  assert.match(js, /function wireDangerButton/, 'the two-click confirm helper exists');
  assert.match(js, /button\.classList\.add\('armed'\)/, 'the first click only arms the button');
  assert.match(js, /timer = setTimeout\(disarm, DANGER_ARM_MS\)/, 'an armed button disarms itself');
  // every danger button goes through it
  for (const id of ['btn-action-publish', 'btn-bench-migrate', 'btn-bench-publish']) {
    assert.match(js, new RegExp(`wireDangerButton\\(document\\.getElementById\\('${id}'\\)`), `${id} is wired to the confirm`);
  }

  // findings land in the problems strip under 'actions', aimed at the 动作 tab
  assert.match(js, /problems\?\.set\('actions'/, "the action validators feed the 'actions' source");
  assert.match(js, /target: \{ page: 'animation', tab: 'tab-actions' \}/, 'their target is the 动作 sub-view');
  assert.match(js, /function collectActionProblems/, 'the publish validation is mapped');
  assert.match(js, /function collectFrameGeometryProblems/, 'the frame geometry is mapped');
  assert.match(js, /\[\.\.\.actionPublishProblems, \.\.\.frameGeometryProblems\]/, 'both halves share the source without erasing each other');
  assert.match(js, /window\.__wbProblems/, 'the store is reached through the window handle');

  // the chips stay: eleven chips, eleven rail tabs — the id contract is untouched
  assert.equal([...html.matchAll(/id="tab-[a-z-]+" class="wb-tab" data-page="[a-z]+"/g)].length, 11, 'eleven chips, each bound to a page');
  const chips = [...html.matchAll(/id="tab-([a-z-]+)" class="wb-tab"/g)].map((match) => `tab-${match[1]}`);
  for (const chip of chips) assert.match(html, new RegExp(`data-tab="${chip}"`), `the rail has an entry for ${chip}`);
  for (const id of ['panel-actions', 'panel-bench', 'action-select', 'bench-action', 'action-playback', 'btn-action-play', 'bench-strip', 'bench-notes', 'bench-gaps', 'action-validation-table', 'action-publish-result', 'btn-action-validate']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} survives the merge`);
  }
});

// 帧序＝数组序: the timeline renders the doc's array order and every reorder goes through
// the action op (dry-run → save) — a filename sort can never reorder the animation.
function testFrameOrderRule(js, services) {
  assert.match(js, /applyActionState\([\s\S]{0,1200}actionTimeline\.setFrames\(actionFrames, \{/, 'the timeline is fed from the frames read (array order)');
  assert.match(js, /onMove\(\(from, to\) => runActionOp\('move', \{ from, to \}\)\)/, 'a reorder writes through the action-op path');
  assert.match(js, /onDuration\(\(index, value\) => runActionOp\('duration', \{ index, value \}\)\)/, 'a duration edit writes through the action-op path');
  // nothing in the shell sorts the frame list by name (the scene canvas still sorts its
  // LAYER, which is a different concern)
  assert.doesNotMatch(js, /actionFrames\.sort\(|frames\.sort\(/, 'no code sorts the frames by name');
  assert.match(services, /frames: doc\.frames\.map\(\(frame, index\)/, 'the panel read maps the doc frames in order, never a sorted list');
  assert.match(js, /async function runActionOp\([\s\S]{0,400}bridge\.actionOp\(/, 'an op goes through the validated service call');
}

// ---- T8: the behaviour page is a full-width graph editor ---------------------------

test('the behaviour page is a graph editor: view, creation, wiring, and an inspector', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const i18n = require(path.join(ROOT, 'src', 'workbench', 'i18n.js'));
  // the schema is the authority on what a node is; the renderer MIRRORS it
  const schema = require(path.join(ROOT, 'src', 'office', 'behavior-graph', 'schema.js'));

  // the renderer's graph block, sliced once — everything below is about THAT code
  const graphBlock = js.slice(js.indexOf('behaviour-graph canvas (UI #2'), js.indexOf('dialogue corpus (P7)'));
  assert.ok(graphBlock.length > 2000, `the graph block was located (${graphBlock.length} chars)`);

  // 1) THE VIEW: fit + a zoom readout, wheel zoom at the cursor, empty-canvas pan — the
  //    stage's interaction vocabulary, in the graph's own coordinate space
  for (const id of ['btn-graph-fit', 'graph-zoom']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} exists`);
  }
  const toolbar = html.slice(html.indexOf('id="graph-toolbar"'), html.indexOf('id="graph-add-form"'));
  assert.ok(toolbar.includes('id="btn-graph-fit"'), '适应 sits on the graph panel\'s toolbar row');
  assert.match(graphBlock, /graphCanvas\.addEventListener\('wheel'[\s\S]{0,260}graphZoomBy\(/, 'the wheel zooms');
  assert.match(graphBlock, /graphZoomBy\(event\.deltaY < 0 \? 1\.1 : 1 \/ 1\.1, graphPixel\(event\)\)/, 'and it zooms AT THE CURSOR (the anchor is the pointer, not the centre)');
  assert.match(graphBlock, /const gx = \(anchor\.x - graphView\.x\) \/ graphView\.zoom;[\s\S]{0,160}graphView\.x = anchor\.x - gx \* graphView\.zoom/, 'the point under the cursor stays put');
  assert.match(graphBlock, /graphPan = \{ id: event\.pointerId, clientX: event\.clientX/, 'the pan gesture starts on the empty canvas');
  assert.match(graphBlock, /if \(graphPan && event\.pointerId === graphPan\.id\)[\s\S]{0,420}graphView\.x = graphPan\.x \+/, 'dragging the empty canvas pans the view');
  assert.match(graphBlock, /function graphFit\(\)[\s\S]{0,600}centres\.map\(\(point\) => point\.x\)\)/, 'the fit looks at every node');
  assert.match(graphBlock, /if \(zoomReadout\) zoomReadout\.textContent = `\$\{Math\.round\(graphView\.zoom \* 100\)\}%`/, 'a visible zoom readout travels with the view');
  // the positions stay presentation: the layout is normalized and the file is untouched
  assert.match(graphBlock, /graphState\.graph\.meta\.layout\[graphDrag\.nodeId\] = \{ x: Number\(x\.toFixed\(5\)\)/, 'a drag still records positions in meta.layout');
  // the ONLY writer is the validated save — never a file write, never an override
  assert.doesNotMatch(graphBlock, /writeFileSync|allowInvalid/, 'the graph block writes no file and never bypasses validation');
  assert.match(graphBlock, /studio\.graphSave\(\{ name: graphState\.name, graph: graphState\.graph, dryRun: false \}\)/, '保存 stays the validated writer');

  // 2) NODE CREATION: a toolbar entry and a palette command, offering EXACTLY the
  //    schema's vocabulary with the schema's defaults
  assert.match(html, /id="btn-graph-add-node"/, 'the toolbar entry exists');
  assert.match(html, /id="graph-add-form"/, 'the create step exists');
  assert.match(graphBlock, /getElementById\('btn-graph-add-node'\)/, 'the toolbar entry is wired');
  assert.match(js, /id: 'graph:add-node'[\s\S]{0,220}getElementById\('btn-graph-add-node'\)/, 'the command palette can add a node');

  // the mirrored vocabulary equals the schema's — type for type, field for field, port for
  // port — so a type the validator accepts can never be missing from the dialog, and one
  // it refuses can never be offered
  function parseMirror(name) {
    const start = graphBlock.indexOf(`const ${name} = {`);
    assert.ok(start >= 0, `GRAPH_NODE_FIELDS/GRAPH_NODE_PORTS-style table ${name} is declared in the renderer`);
    let depth = 0;
    let index = graphBlock.indexOf('{', start);
    for (; index < graphBlock.length; index += 1) {
      if (graphBlock[index] === '{') depth += 1;
      else if (graphBlock[index] === '}') { depth -= 1; if (depth === 0) break; }
    }
    // eslint-disable-next-line no-new-func
    return Function(`"use strict"; return (${graphBlock.slice(graphBlock.indexOf('{', start), index + 1)});`)();
  }
  const fields = parseMirror('GRAPH_NODE_FIELDS');
  const ports = parseMirror('GRAPH_NODE_PORTS');
  assert.deepEqual(Object.keys(fields).sort(), Object.keys(schema.NODE_TYPES).sort(), 'the offered node types are exactly the schema\'s');
  for (const [type, spec] of Object.entries(schema.NODE_TYPES)) {
    assert.deepEqual(fields[type], spec.fields, `${type} offers the schema's fields`);
    assert.deepEqual(ports[type], spec.ports, `${type} carries the schema's ports`);
  }
  const actions = /const GRAPH_ACTIONS = \[([^\]]+)\]/.exec(graphBlock)[1]
    .split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(actions, [...schema.ACTIONS], 'the action vocabulary is the closed set');
  const defaults = parseMirror('GRAPH_NODE_DEFAULTS');
  // every required field of every type has a default here ('a|b' needs either branch)
  for (const [type, spec] of Object.entries(schema.NODE_TYPES)) {
    for (const requirement of spec.required) {
      const anyOf = requirement.split('|');
      assert.ok(anyOf.some((name) => defaults[type] && name in defaults[type]),
        `${type} defaults fill its ${anyOf.join('/')} requirement`);
    }
  }
  // it is placed where the user can see it, and the go button is a deliberate press
  assert.match(graphBlock, /const spot = graphFreeSpot\(graphViewCentre\(\)\);/, 'a new node is placed at the centre of the current view');

  // 3) WIRING: drag from an output port to an input port, and Delete removes an edge
  assert.match(graphBlock, /function graphPortPoints\(node\)/, 'ports have positions on the node edges');
  assert.match(graphBlock, /function graphPortHit\(point\)/, 'the drag starts on an OUTPUT port');
  assert.match(graphBlock, /function graphInHit\(point\)/, 'and lands on an INPUT port');
  assert.match(graphBlock, /graphAddEdge\(pending\.from, pending\.port, target\.id\)/, 'the drop creates the edge');
  assert.match(graphBlock, /function graphConnectRefusal\(/, 'a connection is checked before it is staged');
  assert.match(graphBlock, /if \(!ports\[port\]\) return `\$\{fromId\} has no port/, 'the source must own the port');
  assert.match(graphBlock, /if \(!\('in' in toPorts\) && GRAPH_NODE_KIND\[to\.type\] !== 'trigger'\)/, 'the target must accept incoming flow (the validator\'s own rule)');
  assert.match(graphBlock, /function graphEdgeHit\(point\)/, 'an edge can be clicked to select it');
  assert.match(html, /id="btn-graph-delete"/, 'the delete button exists');
  assert.match(graphBlock, /getElementById\('btn-graph-delete'\)/, 'and is wired');
  assert.match(graphBlock, /event\.key !== 'Delete' && event\.key !== 'Backspace'/, 'Delete/Backspace removes the selection');
  assert.match(graphBlock, /if \(graphSelectedEdge !== null && edges\[graphSelectedEdge\]\)/, 'the selected edge goes first');

  // 4) THE INSPECTOR owns the node's fields — the work area does not
  const inspector = html.slice(html.indexOf('id="wb-right"'), html.indexOf('id="wb-splitter-left"'));
  assert.match(html, /<section id="panel-item-graph" class="wb-panel" hidden/, 'the node panel starts hidden');
  assert.ok(inspector.includes('id="panel-item-graph"'), '#panel-item-graph sits inside the inspector');
  for (const id of ['graph-node-none', 'graph-node-body', 'graph-node-meta', 'graph-node-form', 'graph-node-apply', 'graph-node-refill', 'graph-node-status', 'graph-node-detail']) {
    assert.ok(inspector.includes(`id="${id}"`), `${id} lives in the inspector`);
  }
  const workArea = html.slice(html.indexOf('id="wb-mainview"'), html.indexOf('id="wb-dock"'));
  assert.ok(!workArea.includes('graph-node-detail'), 'the node field editor is not a work-area panel');
  assert.ok(!workArea.includes('id="panel-item-graph"'), 'the node editor follows the page, not a tab');
  const setPageBlock = js.slice(js.indexOf('function setPage('), js.indexOf('function activateTab('));
  assert.match(setPageBlock, /graphNodePanel\.hidden = page !== 'behaviour'/, 'the node editor follows the behaviour page');
  assert.match(js, /behaviour: \['panel-item-graph'\]/, 'the inspector-empty rule names the panel the behaviour page owns');
  // a row per schema field, applied through the validated path
  assert.match(graphBlock, /GRAPH_NODE_FIELDS\[node\.type\] \|\| \{\}/, 'the form is generated from the node type\'s fields');
  assert.match(graphBlock, /GRAPH_ACTIONS\)/, '`do` is a picker over the closed vocabulary');
  assert.match(graphBlock, /await studio\.graphValidate\(\{ graph: graphState\.graph \}\)/, 'applying a field validates the graph first');
  assert.match(graphBlock, /const restored = JSON\.parse\(snapshot\);/, 'a refused patch is rolled back, so nothing invalid is staged');

  // 5) THE PROBLEMS STRIP carries the run and diff outcomes
  assert.match(graphBlock, /problems\?\.set\('graph'/, 'the validation findings still feed the strip');
  assert.match(graphBlock, /function graphReportRunProblems\(/, 'the run outcome is reported');
  assert.match(graphBlock, /function graphReportDiffProblems\(/, 'so is the diff');
  assert.match(graphBlock, /graphReportRunProblems\(\[\]\);/, 'a CLEAN run adds no noise: it clears its own source');
  assert.match(graphBlock, /graphReportDiffProblems\(report\.ok \? \[\]/, 'so does a clean diff');
  assert.match(graphBlock, /const GRAPH_TARGET = \{ page: 'behaviour', tab: 'tab-graph' \}/, 'the findings aim at the graph tab');

  // 6) the pinned surfaces survive: the ids, the eleven chips, the eleven rail tabs
  for (const id of ['panel-graph', 'graph-canvas', 'graph-canvas-wrap', 'graph-file', 'graph-status', 'graph-toolbar',
    'graph-show-ports', 'btn-graph-reload', 'btn-graph-save', 'btn-graph-validate', 'btn-graph-run', 'btn-graph-diff',
    'btn-graph-layout', 'graph-run-result', 'graph-diff-result', 'graph-unavailable']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} survives`);
  }
  assert.equal([...html.matchAll(/id="tab-[a-z-]+" class="wb-tab" data-page="[a-z]+"/g)].length, 11, 'eleven chips, each bound to a page');
  assert.equal([...html.matchAll(/class="wb-rail-tab" data-tab="tab-[a-z-]+"/g)].length, 11, 'eleven rail tabs');
  for (const tab of ['tab-scene', 'tab-preview', 'tab-actions', 'tab-bench', 'tab-graph', 'tab-dialogue', 'tab-assets', 'tab-geometry', 'tab-gallery', 'tab-passport']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `the rail has an entry for ${tab}`);
  }
  // the ids the studio probe reads keep their meaning (studio/main.js evidence path)
  assert.match(graphBlock, /runResult\.textContent = \[/, 'the run result pre is still filled');
  assert.match(graphBlock, /diffResult\.textContent = \[/, 'the diff result pre is still filled');

  // 7) every new string is a dictionary key, in both languages
  for (const key of ['head.graphNode', 'graph.node.none', 'graph.node.hint', 'graph.node.detailHint',
    'btn.graphNodeApply', 'btn.graphNodeRefill', 'btn.graphFit', 'btn.graphAddNode', 'btn.graphDelete',
    'btn.graphAddConfirm', 'btn.graphAddCancel', 'graph.add.type', 'graph.add.id', 'graph.add.note',
    'graph.canvas.hint', 'cmd.graphAddNode', 'cmd.graphFit', 'cmd.group.behaviour']) {
    assert.ok(i18n.DICT[key], `${key} is declared`);
    assert.ok(i18n.DICT[key].zh.trim().length > 0 && i18n.DICT[key].en.trim().length > 0, `${key} carries both languages`);
    assert.notEqual(i18n.DICT[key].zh, i18n.DICT[key].en, `${key} is really translated`);
  }
  // and the new chrome is styled with tokens, not literals
  assert.match(css, /#panel-item-graph \{ flex: 1 1 auto; \}/, 'the node panel fills the inspector column it alone owns');
  assert.match(css, /#graph-canvas-wrap\.wb-panning #graph-canvas \{ cursor: grabbing; \}/, 'panning is visible on the canvas');
  assert.match(css, /#graph-canvas-wrap \{[\s\S]{0,220}var\(--wb-panel\)/, 'the wrap is painted with a token');
});

// ---- T10: the 质检 page merges the four read-only reports ------------------------

test('the 质检 page is ONE page with four read-only sub-views, one run-all action and a collapsed pack menu', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const i18n = require(path.join(ROOT, 'src', 'workbench', 'i18n.js'));

  // the page's own slice of markup — everything below is about THAT page
  const page = html.slice(html.indexOf('id="page-view-quality"'), html.indexOf('id="page-view-observe"'));

  // 1) THE FOUR REPORTS SURVIVE, each with the table (or gallery) it pins
  for (const id of ['panel-assets', 'panel-geometry', 'panel-gallery', 'panel-passport',
    'asset-table', 'geometry-table', 'gallery-diff', 'gallery-files', 'passport-table']) {
    assert.ok(page.includes(`id="${id}"`), `${id} survives the merge`);
  }
  // each pinned table belongs to the sub-view it belongs to, in order
  const order = ['panel-assets', 'asset-table', 'panel-geometry', 'geometry-table',
    'panel-gallery', 'gallery-diff', 'panel-passport', 'passport-table'];
  let cursor = -1;
  for (const id of order) {
    assert.ok(page.indexOf(`id="${id}"`) > cursor, `${id} keeps its place in the page order`);
    cursor = page.indexOf(`id="${id}"`);
  }
  // the rest of each sub-view's furniture: the per-entry block, the params ledger, the
  // per-view run buttons and the publish-validation block
  for (const id of ['entry-geometry', 'passport-findings', 'passport-ledger', 'btn-refresh-assets',
    'btn-refresh-geometry', 'btn-generate-gallery', 'btn-publish', 'publish-result',
    'asset-summary', 'geometry-summary', 'gallery-progress', 'passport-project', 'passport-summary',
    'passport-asset', 'btn-project-refresh', 'btn-passport-report']) {
    assert.ok(page.includes(`id="${id}"`), `${id} survives the merge`);
  }
  // each sub-view stays runnable on its own: the merge ADDS one action, it removes none
  for (const button of ['btn-refresh-assets', 'btn-refresh-geometry', 'btn-publish']) {
    assert.match(js, new RegExp(`getElementById\\('${button}'\\)\\.addEventListener\\('click'`), `${button} is still wired to its own validator`);
  }
  assert.match(js, /const galleryButton = document\.getElementById\('btn-generate-gallery'\);[\s\S]{0,3000}galleryButton\.addEventListener\('click'/, 'the visual baseline keeps its own button too');
  assert.match(js, /bridge\.generateGallery\(\)/, 'and it still calls the gallery service itself');

  // 2) THE FOUR CHIPS ARE ONE PAGE'S SEGMENTED CONTROL (same ids, same class)
  assert.match(html, /<div class="wb-tab-group" role="group"[^>]*aria-label="[^"]*质检/, 'the four chips are wrapped as one segmented group');
  const group = html.slice(html.indexOf('<div class="wb-tab-group"'), html.indexOf('</div>', html.indexOf('id="tab-passport"')));
  for (const tab of ['tab-assets', 'tab-geometry', 'tab-gallery', 'tab-passport']) {
    assert.ok(group.includes(`id="${tab}"`), `${tab} is a segment of the group`);
    assert.ok(new RegExp(`id="${tab}" class="wb-tab" data-page="quality"`).test(group), `${tab} keeps the chip contract`);
  }
  assert.equal((group.match(/class="wb-tab"/g) || []).length, 4, 'the group carries exactly the four chips');
  // the whole chip contract is untouched: eleven chips, eleven rail entries
  assert.equal([...html.matchAll(/id="tab-[a-z-]+" class="wb-tab" data-page="[a-z]+"/g)].length, 11, 'eleven chips, each bound to a page');
  assert.equal([...html.matchAll(/class="wb-rail-tab" data-tab="tab-[a-z-]+"/g)].length, 11, 'eleven rail tabs');
  for (const tab of ['tab-assets', 'tab-geometry', 'tab-gallery', 'tab-passport']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `the rail still reaches ${tab}`);
  }
  // each sub-view says what it checks and when to run it (dictionary-backed, not hard-coded)
  for (const notes of [['qa.note.assets', 'panel-assets'], ['qa.note.geometry', 'panel-geometry'],
    ['qa.note.gallery', 'panel-gallery'], ['qa.note.passport', 'panel-passport']]) {
    const [key, panel] = notes;
    const panelSlice = page.slice(page.indexOf(`id="${panel}"`), page.indexOf('</section>', page.indexOf(`id="${panel}"`)));
    assert.match(panelSlice, new RegExp(`data-i18n="${key.replace('.', '\\.')}"`), `${panel} explains itself with ${key}`);
  }
  assert.match(page, /id="qa-page-bar"[\s\S]{0,1200}data-i18n="qa\.pageHint"/, 'the page itself says it is read-only');
  assert.match(css, /#wb-tabs \.wb-tab-group \{\s*display: none;/, 'the group is hidden on pages that do not own it');
  assert.match(css, /body\[data-page="quality"\] #wb-tabs \.wb-tab-group \{ display: flex; \}/, 'the group is the quality page\'s chip row');
  assert.match(css, /#wb-tabs \.wb-tab-group \{[^}]*var\(--wb-line\)/, 'the group is painted with tokens');

  // 3) ONE "RUN ALL CHECKS" ACTION, at the page level (visible on all four sub-views)
  assert.match(page, /id="btn-qa-run-all"/, 'the page-level action exists');
  assert.match(page, /id="qa-run-status"/, 'and it owns a status span');
  // page chrome: it sits BEFORE the sub-views and inside NONE of them, so pressing a chip
  // never hides it
  assert.ok(page.indexOf('id="btn-qa-run-all"') < page.indexOf('id="panel-assets"'), 'the action precedes the sub-views');
  for (const panel of ['panel-assets', 'panel-geometry', 'panel-gallery', 'panel-passport']) {
    const panelSlice = page.slice(page.indexOf(`id="${panel}"`), page.indexOf('</section>', page.indexOf(`id="${panel}"`)));
    assert.ok(!panelSlice.includes('id="btn-qa-run-all"'), `#btn-qa-run-all is not ${panel}'s button (so it stays visible on every sub-view)`);
  }
  // it runs the three local validators, and the push into the strip is under stable sources
  // (the whole quality block of the renderer: its validators, their mappings and the
  // run-all action — everything below about the JS is about THAT code)
  const qualityJs = js.slice(js.indexOf('// ---- right pane: asset validator ----'), js.indexOf('// ---- the ONE action timeline + the danger zone (T7)'));
  assert.ok(qualityJs.length > 6000, `the quality block was located (${qualityJs.length} chars)`);
  const runAll = qualityJs.slice(qualityJs.indexOf('async function runAllQualityChecks'), qualityJs.indexOf("if (qaRunAllButton) qaRunAllButton.addEventListener"));
  assert.ok(runAll.length > 600, `the run-all block was located (${runAll.length} chars)`);
  assert.match(runAll, /source: 'assets'/, 'the catalog validator writes the "assets" source');
  assert.match(runAll, /source: 'geometry'/, 'the geometry report writes the "geometry" source');
  assert.match(runAll, /source: 'publish'/, 'the publish validation writes the "publish" source');
  assert.match(runAll, /await bridge\.assetReport\(\)/, 'the catalog validator is called (the same service the 素材校验 button calls)');
  assert.match(runAll, /await bridge\.geometryReport\(\)/, 'the frame-geometry report is called (the same service 重新测量 calls)');
  assert.match(runAll, /run: \(\) => runPublishValidation\(\)/, 'the publish validation is called through its shared runner');
  assert.match(qualityJs, /function runPublishValidation\(\)[\s\S]{0,240}bridge\.publish\(\)/, 'and that runner is the one the 发布校验 button uses — one mapping, two entry points');
  assert.match(runAll, /Promise\.allSettled\(steps\.map\(\(step\) => step\.run\(\)\)\)/, 'the three run together and one rejection cannot lose the other two');
  assert.match(runAll, /window\.__wbProblems\?\.problems\?\.set\(steps\[index\]\.source, findings\)/, 'each validator REPLACES its own source (a clean run cannot leave a stale red behind)');
  assert.match(runAll, /renderAssetReport\(rows\)/, 'the 素材校验 table is re-rendered by the run');
  assert.match(runAll, /renderGeometryReport\(report\)/, 'so is the 几何报表 table');
  // the one-line summary lives in its own span, and it is a dictionary key
  assert.match(runAll, /qaRunStatus\.textContent =/, 'the status span is written by the run');
  assert.match(runAll, /t\('qa\.result', \{ red, yellow \}\)/, 'its one line is 错误 N · 提醒 M from the dictionary');
  assert.match(qualityJs, /function collectAssetProblems/, 'the asset rows are mapped to findings');
  assert.match(qualityJs, /function collectGeometryProblems/, 'so are the frame rows');
  // the gallery is deliberately not part of "run all": it renders screenshots, not verdicts
  assert.doesNotMatch(runAll, /generateGallery/, 'the visual baseline keeps its own button (run all validates; the gallery renders)');

  // 4) THE .dshpack CONTROLS COLLAPSE BEHIND A ⋯ DISCLOSURE THAT STARTS CLOSED
  assert.match(page, /id="btn-pack-more" class="wb-more-btn" aria-expanded="false" aria-controls="pack-more-box"/, 'the ⋯ button starts collapsed and names what it reveals');
  assert.ok(page.includes('id="pack-more-box" hidden'), 'the disclosure starts closed');
  const packBox = page.slice(page.indexOf('id="pack-more-box"'), page.indexOf('</section>', page.indexOf('id="pack-more-box"')));
  for (const id of ['btn-pack-roundtrip', 'btn-pack-export', 'btn-pack-import', 'pack-import-path',
    'pack-import-dest', 'pack-import-overwrite', 'pack-roundtrip-result', 'pack-import-result']) {
    assert.ok(packBox.includes(`id="${id}"`), `${id} lives behind the disclosure`);
  }
  assert.match(js, /packMoreButton\?\.addEventListener\('click'/, 'clicking ⋯ reveals the controls');
  assert.match(js, /packMoreBox\.hidden = !open;/, 'and clicking it again hides them');
  assert.match(js, /packMoreButton\.setAttribute\('aria-expanded', String\(open\)\)/, 'the disclosure reports its own state');
  // import/export are the SAME service calls as before — only the visibility changed
  for (const call of ['studio.packRoundTrip({})', 'studio.packExport({})', 'studio.packImport({ file, dest, overwrite })']) {
    assert.ok(js.includes(call), `${call} is still the writer`);
  }
  assert.match(css, /#pack-more-box\[hidden\] \{ display: none; \}/, 'the disclosure hides without leftovers');
  assert.match(css, /\.wb-more-btn\[aria-expanded="true"\][^}]*var\(--wb-accent\)/, 'the ⋯ button marks its open state with a token');

  // 5) EVERY FINDING TARGETS {page:'quality', tab:'tab-…'} — the sub-view that explains it
  const targets = [...qualityJs.matchAll(/target: (\{ page: '[a-z]+', tab: 'tab-[a-z-]+' \}|QA_TARGET\.[a-z]+)/g)].map((match) => match[1]);
  assert.ok(targets.length >= 4, `the quality findings carry jump targets (${targets.length})`);
  assert.doesNotMatch(qualityJs, /target: \{ page: '(?!quality)[a-z]+/, 'no finding points at another page');
  assert.match(qualityJs, /assets: \{ page: 'quality', tab: 'tab-assets' \}/, 'the asset validator aims at 素材校验');
  assert.match(qualityJs, /geometry: \{ page: 'quality', tab: 'tab-geometry' \}/, 'the geometry report aims at 几何报表');
  assert.match(qualityJs, /publish: \{ page: 'quality', tab: 'tab-assets' \}/, 'and the publish validation aims at the sub-view that carries its breakdown');
  for (const key of ['qa.title', 'qa.pageHint', 'btn.qaRunAll', 'qa.run.running', 'qa.result',
    'qa.note.assets', 'qa.note.geometry', 'qa.note.gallery', 'qa.note.galleryOutput', 'qa.note.passport', 'btn.packMore']) {
    assert.ok(i18n.DICT[key], `${key} is declared`);
    assert.ok(i18n.DICT[key].zh.trim().length > 0 && i18n.DICT[key].en.trim().length > 0, `${key} carries both languages`);
    assert.notEqual(i18n.DICT[key].zh, i18n.DICT[key].en, `${key} is really translated`);
  }
  assert.match(i18n.DICT['qa.result'].zh, /错误 \{red\} · 提醒 \{yellow\}/, 'the one-line summary reads 错误 N · 提醒 M');
});

// ---- T9: the dialogue page is a full-width corpus editor ---------------------------

test('the 语料 page is a full-width corpus editor: a topics rail, an inspector editor, a hidden CSV import and a bubble on the dock', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const i18n = require(path.join(ROOT, 'src', 'workbench', 'i18n.js'));

  // the dialogue page's own slice of markup — everything below is about THAT page
  const page = html.slice(html.indexOf('id="page-view-dialogue"'), html.indexOf('id="page-view-quality"'));
  const inspector = html.slice(html.indexOf('id="wb-right"'), html.indexOf('id="wb-splitter-left"'));
  const dock = html.slice(html.indexOf('id="wb-dock"'), html.indexOf('</section>', html.indexOf('id="wb-dock"')));
  const workArea = html.slice(html.indexOf('id="wb-mainview"'), html.indexOf('id="wb-dock"'));
  // the renderer's dialogue block, sliced once (it runs from its named comment to the
  // preview-runner block that follows it)
  const dialogueBlock = js.slice(js.indexOf('the centre pane: the dialogue corpus'), js.indexOf('the centre pane: the preview runner'));
  assert.ok(dialogueBlock.length > 3000, `the dialogue block was located (${dialogueBlock.length} chars)`);

  // 1) EVERY PRE-EXISTING ID SURVIVES (the studio evidence probe reads most of them)
  for (const id of ['panel-dialogue', 'dialogue-unavailable', 'dialogue-body', 'dialogue-layer',
    'btn-dialogue-reload', 'btn-dialogue-save', 'dialogue-status', 'dialogue-topics',
    'dialogue-table', 'dialogue-entries-wrap', 'dialogue-add', 'dialogue-new-text',
    'dialogue-new-weight', 'btn-dialogue-add', 'dialogue-csv', 'btn-dialogue-csv',
    'btn-dialogue-say', 'dialogue-say-seed', 'dialogue-bubble']) {
    assert.ok(html.includes(`id="${id}"`), `${id} survives`);
  }
  assert.equal([...html.matchAll(/id="tab-[a-z-]+" class="wb-tab" data-page="[a-z]+"/g)].length, 11, 'eleven chips, each bound to a page');
  assert.equal([...html.matchAll(/class="wb-rail-tab" data-tab="tab-[a-z-]+"/g)].length, 11, 'eleven rail tabs');
  for (const tab of ['tab-scene', 'tab-preview', 'tab-actions', 'tab-bench', 'tab-graph', 'tab-dialogue', 'tab-assets', 'tab-geometry', 'tab-gallery', 'tab-passport']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `the rail has an entry for ${tab}`);
  }

  // 2) THE TOPICS RAIL sits INSIDE the page, on the LEFT, with the table after it in the
  //    same row: the chips moved out of the flow, nothing was renamed
  assert.ok(page.includes('id="dialogue-topics"'), '#dialogue-topics stays in the page');
  assert.ok(page.includes('id="dialogue-table"'), 'the entry table stays in the page');
  assert.ok(page.includes('id="dialogue-columns"'), 'the rail and the table share one row');
  const columns = page.slice(page.indexOf('id="dialogue-columns"'));
  assert.ok(columns.indexOf('id="dialogue-topics"') < columns.indexOf('id="dialogue-entries-wrap"'),
    'the topics rail comes first (the left column), the table takes the rest');
  assert.ok(columns.indexOf('id="dialogue-table"') < columns.indexOf('id="dialogue-add"'),
    'the table is inside the rail row, not beside the add row');
  // the table fills the width; the rail is a narrow column and scrolls on its own
  assert.match(css, /#dialogue-columns \{ display: flex;[\s\S]{0,120}flex: 1 1 auto/, 'the rail row grows with the work area');
  assert.match(css, /#dialogue-topics \{[\s\S]{0,120}flex: 0 0 152px/, 'the topics rail is a narrow fixed column');
  assert.match(css, /#dialogue-entries-wrap \{[\s\S]{0,80}flex: 1 1 auto/, 'the entry table takes the rest of the width');
  assert.match(css, /#dialogue-topics \.dialogue-topic \{[\s\S]{0,60}display: flex;[\s\S]{0,140}justify-content: space-between/, 'each rail row is name + count');
  assert.match(css, /\.dialogue-topic-name/, 'the rail names the topic');
  // the rail's own vocabulary is rebuilt in JS: one row per topic, count beside it, the
  // current one marked (the same ids/classes the evidence probe counts)
  assert.match(dialogueBlock, /button\.className = 'dialogue-topic'/, 'the rail is built from topic buttons');
  assert.match(dialogueBlock, /name\.className = 'dialogue-topic-name'/, 'each rail row carries its topic name');
  assert.match(dialogueBlock, /count\.className = 'dialogue-topic-count'/, 'and its entry count');
  assert.match(dialogueBlock, /button\.setAttribute\('aria-pressed', String\(topic === selectedTopic\)\)/, 'the current topic is marked');

  // 3) THE ENTRY EDITOR lives in #wb-right and nowhere else: text, weight, conditions and
  //    a read-only id, applying through the SAME service the table's inline path uses
  assert.match(html, /<section id="panel-item-dialogue" class="wb-panel" hidden/, 'the entry editor starts hidden');
  assert.ok(inspector.includes('id="panel-item-dialogue"'), '#panel-item-dialogue sits inside the inspector');
  for (const id of ['dialogue-item-none', 'dialogue-item-body', 'dialogue-item-meta', 'dialogue-item-form',
    'dialogue-item-text', 'dialogue-item-weight', 'dialogue-item-if', 'dialogue-item-id',
    'dialogue-item-apply', 'dialogue-item-refill', 'dialogue-item-status']) {
    assert.ok(inspector.includes(`id="${id}"`), `${id} lives in the inspector`);
  }
  assert.ok(!workArea.includes('id="panel-item-dialogue"'), 'the entry editor follows the page, not a tab');
  assert.ok(!workArea.includes('dialogue-item-'), 'no part of the entry editor is a work-area control');
  assert.match(html, /type="textarea" id="dialogue-item-text"|id="dialogue-item-text" rows="3"/, 'the line is a textarea');
  assert.match(html, /type="number" id="dialogue-item-weight" min="1" max="20"/, 'the weight is a stepped number');
  assert.match(html, /id="dialogue-item-if"[\s\S]{0,240}placeholder="timeOfDay=morning, peerActivity=working"/, 'conditions are typed as key=value');
  assert.match(html, /<input type="text" id="dialogue-item-id" readonly \/>/, 'the id is read-only');
  const setPageBlock = js.slice(js.indexOf('function setPage('), js.indexOf('function activateTab('));
  assert.match(setPageBlock, /dialogueItemPanel\.hidden = page !== 'dialogue'/, 'the entry editor follows the dialogue page');
  assert.match(setPageBlock, /INSPECTOR_PANELS\[page\]/, 'the inspector-empty rule names the panels a page owns');
  assert.match(js, /dialogue: \['panel-item-dialogue'\]/, 'and it says the dialogue page owns this panel');
  // selecting a row selects the entry for the inspector, and the panel refills from it
  assert.match(dialogueBlock, /row\.addEventListener\('click', \(\) => selectDialogueEntry\(entry\.id\)\)/, 'clicking a row selects that entry');
  assert.match(dialogueBlock, /function selectDialogueEntry\(/, 'the selection lives in one place');
  assert.match(dialogueBlock, /row\.classList\.toggle\('dialogue-row-selected', row\.dataset\.entry === id\)/, 'and marks the row the inspector is editing');
  assert.match(dialogueBlock, /function syncDialogueItemPanel\(/, 'the form is refilled from the selection');
  assert.match(dialogueBlock, /function selectedDialogueEntry\(/, 'the panel reads the selected entry through one door');
  assert.match(dialogueBlock, /dialogueItemMeta\.textContent = `\$\{selectedTopic\} · \$\{entry\.id\}\$\{dialogueState\.dirty \? ` · \$\{t\('dialogue\.item\.unsaved'\)\}` : ''\}`/, 'the panel says the change is staged until 保存');
  assert.match(dialogueBlock, /studio\.dialogueEdit\(\{[\s\S]{0,120}op: 'update'/, 'applying goes through the validated edit service');
  assert.match(dialogueBlock, /dialogueState\.doc = outcome\.doc;[\s\S]{0,80}dialogueState\.dirty = true;/, 'the staged document is the one 保存 writes');
      assert.match(dialogueBlock, /setDialogueItemStatus\(t\('dialogue\.item\.refused'/, 'a refused patch is reported in the panel');
      assert.match(dialogueBlock, /syncDialogueItemPanel\(\);[\s\S]{0,320}setDialogueItemStatus\(t\('dialogue\.item\.refused'/, 'and the form is refilled from what stands, so the panel never shows an unapplied value');
      assert.match(dialogueBlock, /\(outcome\.findings \|\| \[\]\)\[0\] \|\| \{\}/, 'the refusal names the guard\'s own finding code');
  assert.match(dialogueBlock, /event\.stopPropagation\(\);/, 'deleting a row does not also select it');
  // it never writes a file and never bypasses the guard
  assert.doesNotMatch(dialogueBlock, /writeFileSync|allowInvalid|save: true/, 'the entry editor writes no file and never bypasses validation');
  assert.match(dialogueBlock, /studio\.dialogueSave\(\{ layer: dialogueState\.layer, doc: dialogueState\.doc \}\)/, '保存 stays the validated writer');

  // 4) THE CSV IMPORT is behind a ⋯ disclosure that starts CLOSED (same shape as the pack menu)
  assert.match(page, /id="btn-dialogue-csv-more" class="wb-more-btn" aria-expanded="false" aria-controls="dialogue-csv-box"/, 'the ⋯ button starts collapsed and names what it reveals');
  assert.ok(page.includes('id="dialogue-csv-box" hidden'), 'the disclosure starts closed');
  const csvBox = page.slice(page.indexOf('id="dialogue-csv-box"'), page.indexOf('id="head.dialogueSay"') > 0 ? page.indexOf('id="head.dialogueSay"') : page.indexOf('id="dialogue-say"'));
  assert.ok(csvBox.includes('id="dialogue-csv"') && csvBox.includes('id="btn-dialogue-csv"'),
    'the textarea and the import button both live behind the disclosure');
  assert.match(dialogueBlock, /csvMoreButton\?\.addEventListener\('click'/, 'clicking ⋯ reveals the import');
  assert.match(dialogueBlock, /csvBox\.hidden = !open;/, 'and clicking it again hides it');
  assert.match(dialogueBlock, /csvMoreButton\.setAttribute\('aria-expanded', String\(open\)\)/, 'the disclosure reports its own state');
  assert.match(css, /#dialogue-csv-box\[hidden\] \{ display: none; \}/, 'the disclosure hides without leftovers');
  // import is the SAME service call as before — only the visibility changed
  assert.match(dialogueBlock, /studio\.dialogueImportCsv\(\{ layer: dialogueState\.layer, csv \}\)/, '导入 still calls the import service');

  // 5) THE BUBBLE IS ON THE DOCK: positioned relative to #wb-dock, over its lower edge,
  //    highlighting the dock while it is up and hiding itself on the corpus's own
  //    limits.bubbleMs — and never reaching into the dock's office frame
  assert.ok(dock.includes('id="dialogue-bubble-overlay"'), 'the bubble overlay sits inside the dock section');
  assert.ok(!workArea.includes('id="dialogue-bubble"'), 'the bubble is no longer a line of text in the work area');
  assert.ok(dock.includes('id="dialogue-bubble"'), '#dialogue-bubble survives (the evidence probe reads it)');
  assert.match(css, /#wb-dock \{ position: relative;/, 'the dock is the overlay\'s positioning context');
  assert.match(css, /\.wb-bubble-overlay \{[\s\S]{0,80}position: absolute;[\s\S]{0,160}bottom: 30px/, 'the bubble hangs off the dock\'s lower edge');
  assert.match(css, /\.wb-bubble-overlay \{[\s\S]{0,240}pointer-events: none/, 'the overlay never blocks the dock');
  assert.match(css, /#wb-dock\.wb-bubble-speaking \{ outline: 2px solid var\(--wb-accent\)/, 'the dock is highlighted while the bubble is up');
  assert.match(dialogueBlock, /dockEl\?\.classList\.add\('wb-bubble-speaking'\)/, 'and the JS marks it');
  assert.match(dialogueBlock, /bubbleOverlay\.hidden = false;/, 'the say handler shows the overlay');
  assert.match(dialogueBlock, /outcome\.limits && outcome\.limits\.bubbleMs/, 'the timeout comes from the corpus\'s own limits.bubbleMs');
  assert.match(dialogueBlock, /bubbleTimer = setTimeout\(hideDockBubble, Math\.max\(400, ms\)\);/, 'and it auto-hides after it');
  assert.match(dialogueBlock, /bubbleEl\.textContent = `「\$\{outcome\.line\.text\}」`/, 'the bubble still carries the line text');
  assert.match(dialogueBlock, /bubbleWhoEl\.textContent = character \? `\$\{outcome\.topic\} · \$\{character\}` : String\(outcome\.topic\)/, 'and says which topic (and whose character) is being spoken');
  assert.doesNotMatch(dialogueBlock, /preview-frame|contentWindow|__office/, 'the overlay never talks to the dock\'s office frame');
  // the seed keeps its behaviour: the same seed gives the same line
  assert.match(dialogueBlock, /studio\.dialogueSay\(\{ topic: selectedTopic, seed \}\)/, 'the seed is what the service gets');

  // 6) the problems strip still carries the corpus findings, aimed at this page's sub-view
  assert.match(dialogueBlock, /window\.__wbProblems\?\.problems\?\.set\('dialogue'/, "the corpus validator still feeds the 'dialogue' source");
  assert.match(dialogueBlock, /target: \{ page: 'dialogue', tab: 'tab-dialogue' \}/, 'and the findings aim at the 语料 sub-view');

  // 7) every new string is a dictionary key, in both languages
  for (const key of ['head.dialogueItem', 'head.dialogueCsv', 'head.dialogueSay', 'btn.dialogueSay',
    'btn.dialogueCsvMore', 'btn.dialogueItemApply', 'btn.dialogueItemRefill', 'dialogue.say.hint',
    'dialogue.item.none', 'dialogue.item.hint', 'dialogue.item.text', 'dialogue.item.weight',
    'dialogue.item.if', 'dialogue.item.id', 'dialogue.item.ifNote', 'dialogue.item.unsaved',
    'dialogue.item.staged', 'dialogue.item.applied', 'dialogue.item.noneSelected', 'dialogue.item.textEmpty',
    'dialogue.item.notWeight', 'dialogue.item.ifBad', 'dialogue.item.noChange', 'dialogue.item.refill',
    'dialogue.item.refused', 'dialogue.item.crashed', 'dialogue.bubble.empty']) {
    assert.ok(i18n.DICT[key], `${key} is declared`);
    assert.ok(i18n.DICT[key].zh.trim().length > 0 && i18n.DICT[key].en.trim().length > 0, `${key} carries both languages`);
    assert.notEqual(i18n.DICT[key].zh, i18n.DICT[key].en, `${key} is really translated`);
  }
  // and the new chrome is painted with tokens, not literals
  const dialogueCss = css.slice(css.indexOf('/* ---- dialogue corpus (P7 · T9'), css.indexOf('/* ---- timeline (UI #3'));
  assert.ok(dialogueCss.length > 800, `the dialogue styles were located (${dialogueCss.length} chars)`);
  assert.doesNotMatch(dialogueCss, /#[0-9a-fA-F]{3,6}\b/, 'no literal colours in the new rules: custom properties only');
});

// ---- T11: the 观测 page is a simulation observatory -------------------------------

test('the 观测 page: a full-width employee table, four collapsed console sections, and ONE host for the playback controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.css'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'src', 'workbench', 'workbench.js'), 'utf8');
  const i18n = require(path.join(ROOT, 'src', 'workbench', 'i18n.js'));

  // the observe page's own slice of markup (it is the last page, so it runs to the end of
  // the work area), the inspector, the dock, and the canvas toolbar
  const page = html.slice(html.indexOf('id="page-view-observe"'), html.indexOf('id="wb-problems"'));
  const inspector = html.slice(html.indexOf('id="wb-right"'), html.indexOf('id="wb-splitter-left"'));
  const dock = html.slice(html.indexOf('id="wb-dock"'), html.indexOf('id="stage"', html.indexOf('id="wb-dock"')));
  const stageToolbar = html.slice(html.indexOf('id="stage-toolbar"'), html.indexOf('id="stage-viewport"'));
  const workArea = html.slice(html.indexOf('id="wb-mainview"'), html.indexOf('id="wb-dock"'));

  // 1) THE EMPLOYEE TABLE BELONGS TO THE PAGE, full width — not to the inspector column.
  //    The ids and the 6 columns are the ones they have always been.
  assert.ok(page.includes('id="preview-table"'), '#preview-table lives in the observe page');
  assert.ok(!inspector.includes('id="preview-table"'), 'the employee table is no longer an inspector column');
  assert.ok(!inspector.includes('id="panel-preview"'), 'the whole run console left the inspector');
  assert.match(html, /<table id="preview-table">\s*<thead><tr><th>员工<\/th><th>活动<\/th><th>相位<\/th><th>结果<\/th><th>移动阶段<\/th><th>位置<\/th><\/tr><\/thead>/, 'the table keeps its id and its 6 columns');
  // the page's own container is the panel, inside the page's work area
  assert.ok(page.includes('id="panel-preview"'), '#panel-preview is the observe page\'s panel');
  assert.match(html, /<section id="panel-preview" class="wb-panel" hidden/, 'it keeps the panel contract (one panel starts visible)');
  assert.ok(page.indexOf('id="preview-table"') < page.indexOf('id="preview-console"'), 'the table comes before the console');
  assert.match(css, /body\[data-page="scene"\] #wb-mainview \{ display: none; \}/, 'only the 场景 page still hides the work area');
  assert.ok(!css.includes('body[data-page="observe"] #wb-mainview { display: none; }'), 'the observe page shows its work area');
  // the DOCK keeps the picture, at an enlarged share, and yields to the table when needed
  // the observe dock must keep a REAL share of the work area (the first version let it shrink
  // until a fit clamped at the 15% zoom floor — a panorama that showed nothing): fixed basis,
  // and the table scrolls instead
  assert.match(css, /body\[data-page="observe"\] #wb-center #wb-dock \{ flex: 0 0 52vh; min-height: 320px; \}/, 'the observe dock is enlarged and does not shrink away');
  assert.match(css, /#wb-dock \{ flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; \}/, 'the dock is a column: its toolbar, then the stage');
  assert.match(css, /#preview-table-wrap \{[\s\S]{0,120}flex: 1 1 auto/, 'the table takes the width and the height it can get');

  // 2) ONE HOST for the playback controls: the dock's own toolbar, exactly once each.
  for (const id of ['btn-preview-play', 'btn-preview-step', 'btn-preview-restart', 'preview-speed', 'preview-status']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${id} exists exactly once`);
    assert.ok(dock.includes(`id="${id}"`), `${id} lives on the dock's toolbar`);
    assert.ok(!stageToolbar.includes(`id="${id}"`), `${id} is no longer on the canvas toolbar`);
  }
  assert.ok(html.indexOf('id="dock-toolbar"') < html.indexOf('id="stage"'), 'the toolbar is dock chrome, above the stage');
  assert.match(html, /<div id="dock-toolbar" class="wb-dock-toolbar">/, 'the dock toolbar is its own node');
  // the stage toolbar keeps what it is for: modes, view, the edit layer's writer
  for (const id of ['btn-stage-fit', 'btn-stage-zoom-in', 'btn-stage-zoom-out', 'btn-stage-reset', 'btn-stage-mode-edit', 'btn-stage-mode-run', 'btn-canvas-save', 'btn-canvas-reload']) {
    assert.ok(stageToolbar.includes(`id="${id}"`), `${id} stays on the canvas toolbar`);
  }
  // the mode rules that scoped the moved group are gone, not left behind as dead CSS
  assert.ok(!css.includes('#stage[data-mode="edit"] #stage-run-group'), 'the run group is no longer edit-mode scoped');
  assert.ok(!css.includes('#stage[data-mode="edit"] #preview-status'), 'the status line is no longer edit-mode scoped');
  // and the wiring still finds them by id (the play/step/restart handlers bring run mode up)
  assert.match(js, /document\.getElementById\('btn-preview-step'\)\.addEventListener\('click'/, '单步 is still wired');
  assert.match(js, /document\.getElementById\('btn-preview-restart'\)\.addEventListener\('click'/, '重开 is still wired');
  assert.match(js, /document\.getElementById\('preview-speed'\)\.addEventListener\('change'/, '倍速 is still wired');
  assert.match(js, /stage\.setMode\('run', \{ silent: true \}\)/, 'pressing play still brings the run layer up');

  // 3) THE CONSOLE'S FOUR SECTIONS: 一键脚本 / 手动发送事件 / 遥测 / 诊断包, each behind its
  //    own disclosure, all starting CLOSED, so the first screen is the picture + the table
  for (const [section, head, box] of [
    ['preview-section-script', 'btn-preview-section-script', 'preview-script-box'],
    ['preview-section-events', 'btn-preview-section-events', 'preview-events-box'],
    ['preview-section-telemetry', 'btn-preview-section-telemetry', 'preview-telemetry-box'],
    ['preview-section-bundle', 'btn-preview-section-bundle', 'preview-bundle-box'],
  ]) {
    assert.ok(page.includes(`id="${section}"`), `the ${section} section exists`);
    assert.match(page, new RegExp(`id="${head}" aria-expanded="false" aria-controls="${box}"`), `${head} starts closed and names what it reveals`);
    assert.ok(page.includes(`id="${box}" hidden`), `#${box} starts closed`);
    assert.match(js, new RegExp(`'${head}'`), `${head} is wired by the renderer`);
  }
  assert.match(js, /button\.setAttribute\('aria-expanded', String\(open\)\);/, 'the disclosure reports its own state');
  assert.match(css, /\.wb-console-body\[hidden\] \{ display: none; \}/, 'the disclosure hides without leftovers');
  assert.match(css, /#preview-console \{[\s\S]{0,160}grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'the four closed sections cost two rows, not four');
  // every console id survived the move (the probe and the telemetry bundle read them)
  for (const id of ['btn-preview-scenario-complete', 'btn-preview-scenario-failed', 'btn-preview-scenario-approval',
    'preview-scenario-result', 'preview-event-type', 'preview-session', 'preview-data', 'btn-preview-inject',
    'btn-preview-telemetry', 'preview-telemetry', 'btn-preview-export', 'preview-export-result',
    'preview-unavailable', 'preview-body']) {
    assert.ok(page.includes(`id="${id}"`), `${id} survives inside the observe page`);
  }

  // 4) FOLLOW: a row click locks the dock's view onto that employee (handover §6-5)
  assert.match(page, /<button[^>]*id="btn-preview-unfollow"[^>]*hidden/, '取消跟随 exists and is hidden until a follow starts');
  assert.ok(page.includes('id="preview-follow-status"'), 'the page says which employee is being followed');
  assert.match(js, /row\.dataset\.employee = employee\.employeeId;/, 'each row carries the employee it is about');
  assert.match(js, /row\.title = t\('observe\.followTitle'/, 'the row says what clicking it does');
  assert.match(js, /row\.addEventListener\('click', toggleFollow\)/, 'clicking a row follows that employee');
  assert.match(js, /if \(followedEmployee === employee\.employeeId\) releaseFollow\(\);/, 'clicking the followed row again releases it');
  assert.match(js, /unfollowButton\.addEventListener\('click'/, 'and so does 取消跟随');
  assert.match(js, /stage\.fit\(\);/, 'releasing returns to the fit view');
  // the view is the TOOL's: it is driven through the stage's own transform API, and the
  // simulation's own frame is never reached into
  const followBlock = js.slice(js.indexOf('// ---- FOLLOW: lock the dock'), js.indexOf('function renderPreviewStatus'));
  assert.ok(followBlock.length > 900, `the follow block was located (${followBlock.length} chars)`);
  assert.match(followBlock, /stage\.state\(\)/, 'it reads the stage\'s own state');
  assert.match(followBlock, /stage\.zoomBy\(zoomNext \/ before\.zoom, \{/, 'and zooms through the stage\'s own zoom-at-a-point');
  assert.doesNotMatch(followBlock, /preview-frame|contentWindow|__office|\.style\.transform/, 'it never touches the office frame or the transform by hand');
  assert.match(css, /#preview-table tbody tr\.preview-row-followed td/, 'the followed row is marked with tokens');

  // 5) the pinned surfaces: eleven chips, eleven rail tabs, every #preview-* id
  assert.equal([...html.matchAll(/id="tab-[a-z-]+" class="wb-tab" data-page="[a-z]+"/g)].length, 11, 'eleven chips, each bound to a page');
  assert.equal([...html.matchAll(/class="wb-rail-tab" data-tab="tab-[a-z-]+"/g)].length, 11, 'eleven rail tabs');
  for (const tab of ['tab-scene', 'tab-preview', 'tab-actions', 'tab-bench', 'tab-graph', 'tab-dialogue', 'tab-assets', 'tab-geometry', 'tab-gallery', 'tab-passport']) {
    assert.match(html, new RegExp(`data-tab="${tab}"`), `the rail has an entry for ${tab}`);
  }
  for (const id of ['preview-frame', 'preview-slot', 'preview-status', 'preview-table', 'preview-telemetry',
    'preview-export-result', 'preview-speed', 'btn-preview-play', 'btn-preview-step', 'btn-preview-restart']) {
    assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, `${id} exists exactly once`);
  }
  // the observe page no longer owns an inspector panel (its console is the page's work area)
  const setPageBlock = js.slice(js.indexOf('function setPage('), js.indexOf('function activateTab('));
  assert.match(setPageBlock, /INSPECTOR_PANELS\[page\]/, 'the inspector-empty rule still names the panels a page owns');
  assert.doesNotMatch(js, /observe: \['panel-preview'\]/, '观测 no longer claims #panel-preview for the inspector');

  // 6) every new string is a dictionary key, in both languages, and the new chrome is painted
  //    with tokens only
  for (const key of ['observe.employeeHead', 'observe.pageHint', 'observe.eventHead', 'observe.telemetryHead',
    'observe.bundleHead', 'btn.previewUnfollow', 'btn.consoleScript', 'btn.consoleEvents', 'btn.consoleTelemetry',
    'btn.consoleBundle', 'observe.followTitle', 'observe.following', 'observe.released', 'observe.follow.gone',
    'observe.follow.noPosition', 'inspector.empty', 'preview.scenario.head', 'telemetry.read', 'btn.exportBundle']) {
    assert.ok(i18n.DICT[key], `${key} is declared`);
    assert.ok(i18n.DICT[key].zh.trim().length > 0 && i18n.DICT[key].en.trim().length > 0, `${key} carries both languages`);
    assert.notEqual(i18n.DICT[key].zh, i18n.DICT[key].en, `${key} is really translated`);
  }
  const observeCss = css.slice(css.indexOf('/* ---- T11: the 观测 page'), css.indexOf('/* ---- dialogue corpus (P7 · T9'));
  assert.ok(observeCss.length > 900, `the observe styles were located (${observeCss.length} chars)`);
  assert.doesNotMatch(observeCss, /#[0-9a-fA-F]{3,6}\b/, 'no literal colours in the new rules: custom properties only');
});
