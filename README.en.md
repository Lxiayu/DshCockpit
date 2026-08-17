**English** | **[简体中文](README.md)**

<div align="center">

# 🛩️ DshCockpit

**Turn DeepSeek Harness into a resident background Agent cockpit**

Cost control · Usage monitoring · Auto-update · Scheduled tasks · Quick Ask · LAN phone remote control · Data safety

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Powered by](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

*From "a browser tab you must keep open" to "a double-click, always-on, self-updating desktop console that knows what your agents cost."*

</div>

---

## ✨ Why DshCockpit?

Other shells wrap the `dsh web` UI **inside a window**. DshCockpit treats `dsh` as a **background service** and builds cockpit-grade capabilities on top of it — features no other shell in the ecosystem currently offers:

| | `dsh web` in browser | Other desktop shells | **DshCockpit** |
|---|---|---|---|
| Close the window | ❌ session dies | ✅ tray-resident | ✅ tray-resident + background tasks keep running |
| Runtime updates | ❌ manual npm | ❌ none | ✅ **auto-update pipeline + smoke-test guard + one-click rollback** |
| Token usage | ❌ flashes once | ❌ none | ✅ **live capsule + context-pressure warning** |
| What it costs | ❌ unknown | ❌ none | ✅ **cost center: per day/week/month/workspace + budget alarms** |
| Quick questions | ❌ open browser | ❌ none | ✅ **global-hotkey Quick Ask (runs in background)** |
| Scheduled tasks | ❌ none | ❌ none | ✅ **shell-level scheduler (interval/daily + notifications)** |
| History search | ❌ manual digging | ❌ none | ✅ **`Ctrl+K` full-text search across all sessions** |
| Data safety | ✅ local | ✅ local | ✅ local + **auto-backup + privacy statement + backups exclude credentials** |

**In one sentence: they build "windows", we build a "console".**

---

## 🚀 Feature Panorama

### 🎛️ Cockpit-grade monitoring (unique)
- **Live token capsule**: current-session input→output tokens, always visible in the top-right corner; hover for details (current/all sessions, cache). **Context pressure** turns yellow/red at 60%/85% — your cue to start a fresh session.
- **Cost control center**: tokens & estimated cost per day/week/month (unit prices configurable), broken down **per workspace**; **monthly budget + 80%/100% alarms** — no more scary end-of-month invoices.

### 🔄 Update system (two decoupled layers — a bad version never activates)
- **Runtime updates**: registry check → install → **`--dump-config` smoke-test guard** (a broken version is never activated) → pending → switch (DSH_HOME snapshotted automatically) → **one-click rollback**. The strongest stability guarantee while the runtime iterates fast in preview.
- **Shell self-update**: automatic checks (on start + every 4h) → **release-notes dialog** (renders the GitHub Release body) → restart now.

### ⚡ Background agent services (unique)
- **Quick Ask (global hotkey)**: default `Ctrl+Alt+Space` pops a mini window; ask anything → runs in a headless background session → completion notification. Ask without leaving your editor.
- **Scheduled tasks**: run a fixed prompt every day or at an interval (daily reports, weekly reports, cleanup) with automatic execution + system notifications.
- **Task notifications**: with the window minimized, you're notified when the agent finishes a long task, when an approval is needed, or when a question awaits your answer.

### 🔍 History & search
- **`Ctrl+K` full-text session search**: keyword search across all past sessions (highlighted snippets + one-click copy).
- **Automatic session backups**: on exit + manual, keeps the last N; DSH_HOME snapshots on upgrade/rollback.

### 🧩 Ecosystem & experience
- **Plugin marketplace**: browse the GitHub [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic (2000+ community plugins), search in a dedicated window, install/uninstall in one click.
- **Trilingual UI** (中文 / English / follow system); tray, notifications, and settings fully localized.
- Shortcuts (`Ctrl+,` settings / `Ctrl+K` search / `Ctrl+R` reload / `Ctrl+Shift+I` devtools).
- First-run guide, window-position memory, crash auto-restart (3-in-60s loop protection), **orphan-process watchdog** (cleans up the runtime if the shell crashes — no ghost processes).
- Storage management (usage visualization + one-click cleanup), crash diagnostics.

### 🛡️ Data & privacy
- **Runs fully locally.** The settings UI states it explicitly: we **do not collect, upload, or store** your personal info, API keys, session content, or usage data.
- Backups deliberately **exclude API credentials** (prevents plaintext keys from spreading); runtime downloads are sha512-verified; the harness's own file sandbox and approval mechanisms are preserved untouched.

---

## 🚀 Quick Start

### Option 1: Windows portable
Download `DshCockpit-<version>-win-x64.zip` from [Releases](https://github.com/Lxiayu/DshCockpit/releases) → **extract with 7-Zip/WinRAR** → double-click `DshCockpit.exe` in the root folder.
> **~9s to first window** (first launch may take 20–30s extra if DSH_HOME isn't initialized yet). Bundled runtime — no Node.js/dsh install, no network download. Future versions self-update.
> If the bundled runtime got truncated by your extraction tool (rare), the app falls back to installing from the npm registry and prompts you to re-extract with 7-Zip.

### Option 2: macOS (.dmg)
Download the matching `.dmg` from [Releases](https://github.com/Lxiayu/DshCockpit/releases):
- **Apple Silicon (M1/M2/M3/M4)**: `DshCockpit-<version>-mac-arm64.dmg`
- **Intel Mac**: `DshCockpit-<version>-mac-x64.dmg`

Double-click to mount → drag **DshCockpit** into **Applications** → launch.

> ⚠️ **First launch shows "damaged" or "unidentified developer"**: the macOS build is **not yet signed/notarized** (no Apple Developer certificate yet). This is a normal Gatekeeper block — the app is fine. Either:
> - **GUI**: double-click once (Cancel on the dialog) → System Settings → Privacy & Security → scroll down → "Open Anyway" → "Open".
> - **Terminal (fastest)**:
>   ```bash
>   xattr -dr com.apple.quarantine /Applications/DshCockpit.app
>   ```
>
> One clearance is permanent. This prompt disappears once signing/notarization is in place.

### Option 3: from source (developers)
```bash
# Requires Node.js ≥ 22; having @deepseek-ai/dsh installed is recommended (auto-downloaded on first launch otherwise)
git clone https://github.com/Lxiayu/DshCockpit.git
cd DshCockpit
npm install
npm start
```

After first launch:
1. Configure your DeepSeek API key in the in-window Harness settings (gear icon, red-dot hint);
2. Drag a workspace folder onto the top-right toolbar (or pick one in settings);
3. Start chatting — the capsule in the top-right tracks token usage live.

---

## 📸 Screenshots

<div align="center">

<img src="photo/preview-1.png?v=0.2.3" width="720" alt="DshCockpit main window — DeepSeek Harness (dsh) desktop cockpit with token usage capsule" />

<table><tr>
<td><img src="photo/preview-2.png?v=0.2.3" width="280" alt="Cost center — token cost tracking & budget alerts" /></td>
<td><img src="photo/preview-3.png?v=0.2.3" width="280" alt="Settings & plugin marketplace" /></td>
</tr></table>

</div>

---

## 🏗️ Architecture

```
DshCockpit (Electron)
 ├─ Runtime management: versioned dirs + update pipeline (Arborist install / smoke test / switch / rollback)
 ├─ Data layer: session parsing (zstd), cost history, full-text search, backup/snapshot
 ├─ Event stream: subscribes to the runtime WebSocket (task done / approvals / questions)
 ├─ Services: Quick Ask, task scheduler, plugin marketplace, crash watchdog
 └─ UI: shell settings window + in-window chrome (token capsule / quick entries)
```

- **Shell and runtime fully decoupled**: runtime versions coexist under `userData/runtime/` without interference;
- Deliberately small interface surface: spawn args, URL line, HTTP/WS — upstream changes don't break the shell.

---

## 🗺️ Roadmap

- [x] Two-layer auto-update (runtime + shell) with rollback
- [x] Token monitoring + cost center + budget alarms
- [x] Quick Ask + scheduled tasks + task/approval notifications
- [x] Full-text session search + auto-backup + privacy statement
- [x] Plugin marketplace + trilingual UI + portable packaging (bundled runtime)
- [x] macOS builds (CI produces arm64 + x64)
- [ ] macOS code signing & notarization
- [ ] Windows Authenticode signing
- [ ] System keychain integration (encrypted credentials)
- [ ] Mobile remote control / more workflows

---

## 🤝 Contributing

PRs welcome! Please run `npm test` first (34 unit tests). See [`DESIGN.md`](DESIGN.md) for architecture and [`FEATURES.md`](FEATURES.md) for the feature list.

## 📄 License

[MIT](LICENSE)

## 🙏 Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the agent runtime & Web UI this project drives
- Everyone building community shells and plugins for the ecosystem
