**English** | **[简体中文](README.md)**

<div align="center">

# 🛩️ DshCockpit

**Turn DeepSeek Harness into a resident background Agent cockpit**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Powered by](https://img.shields.io/badge/powered%20by-DeepSeek%20Harness-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

> **Harness owns the workspace. DshCockpit owns the operating layer.**

DshCockpit is an open-source desktop control plane (Electron) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): double-click to launch, tray-resident, self-updating, cost-aware. Harness keeps its 100% native workspace; all monitoring, automation, and runtime management live in the independent Cockpit layer. Bundled runtime — no Node.js install needed. Windows portable zip + macOS dmg (arm64/x64).

</div>

---

## 🚀 Features

### 🎛️ Monitoring
- **Token / Context**: always-on Edge Rail shows usage and context pressure; click for detail (input/output/cache), warnings at 60%/85%, built-in one-click compaction
- **Cost center**: per day/week/month/workspace stats, monthly budget 80%/100% alarms, peak/off-peak pricing
- **Official balance**: live DeepSeek account balance (total/granted/topped-up) and exact per-turn spend

### 📡 Remote & automation
- **Phone remote control**: full dsh UI in a phone browser (sessions, messages, approvals, questions); one-tap LAN pairing, plus Tailscale / Cloudflare tunnels for anywhere access
- **IM channel remote control**: Feishu / WeCom / DingTalk official long connections — task completion, approvals, and questions land in your chat, handled right from the conversation
- **Quick Ask**: `Ctrl+Alt+Space` global hotkey — ask anything, runs in the background, notified when done
- **Scheduled tasks**: daily/weekly/interval reports, run history included

### 🛠️ Runtime & data
- **Runtime management**: auto-update + smoke-test guard + one-click rollback, live install progress
- **Session search**: `Ctrl+K` full-text search across all sessions; auto-backup on exit
- **Long sessions**: one-click `/compact` with before/after token comparison and estimated savings; AGENTS.md memory files editable online

### 🧩 Ecosystem & experience
- **Model manager**: 6 third-party templates + custom + local Ollama, connection test before use
- **Plugin + Skills marketplaces**: 14-category community plugins and Claude Skill skills, preview before install
- Bilingual UI, dark/light themes, fully local data (no collection, no upload, backups exclude credentials)

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

> ⚠️ **First launch shows "damaged" or "unidentified developer"**: the macOS build is **not yet signed/notarized** (no Apple Developer certificate yet). This is a normal Gatekeeper block — the app is fine. Run this once in Terminal to clear it permanently:
> ```bash
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

### Option 3: from source (developers)
```bash
# Requires Node.js ≥ 22; having @deepseek-ai/dsh installed is recommended (auto-downloaded on first launch otherwise)
git clone https://github.com/Lxiayu/DshCockpit.git
cd DshCockpit
npm install
npm start
```

After first launch:
1. Configure your DeepSeek API key in the native Harness settings (gear icon, red-dot hint);
2. Choose a workspace from the Edge Rail Settings or workspace action;
3. Start chatting — the Edge Rail keeps Context status visible, while Cockpit opens the operating layer when needed.

---

## 📸 Screenshots

<div align="center">

<img src="photo/preview-1.png?v=0.2.5" width="720" alt="DshCockpit main window — native DeepSeek Harness workspace with Edge Rail and Context status" />

<table><tr>
<td><img src="photo/preview-2.png?v=0.2.5" width="280" alt="Cost center — token cost tracking & budget alerts" /></td>
<td><img src="photo/preview-3.png?v=0.2.5" width="280" alt="Settings & plugin marketplace" /></td>
</tr></table>

</div>

---

## 🤝 Contributing

PRs welcome! Please run `npm test` first. See [`DESIGN.md`](DESIGN.md) for architecture, [`PHILOSOPHY.md`](PHILOSOPHY.md) for the product philosophy, and [`FEATURES.md`](FEATURES.md) for the feature list.

## 📄 License

[MIT](LICENSE)

## 🙏 Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — the agent runtime & Web UI this project drives
- IM channel design references MIT projects such as dsh-im-bridge; balance display paradigm references dms-deepseekbalance (MIT); skills ecosystem is [Claude Skill](https://agentskills.io) compatible (Anthropic)
- Everyone building community shells and plugins for the ecosystem

---

## 💡 Product Philosophy

<details>
<summary><b>Not another Harness UI — Harness owns the workspace. DshCockpit owns the operating layer.</b></summary>

DshCockpit is not designed to replace, redesign, or modify the Harness WebUI. Harness owns the workspace (talk to agents, inspect files, write code, complete tasks); DshCockpit owns the **operating layer** around it: monitoring, Quick Ask, background tasks, cost, runtime management, session search, remote control, integrations, and desktop-level automation.

Core interaction principle:

> **Invisible when working. Obvious when needed.**

Three product disciplines:

- **The Cockpit, not the Settings page**: high-frequency capabilities stay visible (Token / Cockpit / Quick Ask / Tasks); status and actions live in the Control Center; Settings is reserved for persistent configuration — *Settings is not a feature hub, it is a configuration center*
- **Progressive disclosure**: `Default → Peek → Cockpit → Full configuration` — never open a big dashboard to answer a small question
- **Agent ≠ the current window**: the Agent is a continuously manageable desktop service — background runs, scheduled tasks, remote commands, usage accumulation, runtime updates — independent of whether the workspace is in front

Engineering stays **zero-invasive**: only stable boundaries (HTTP / WebSocket / IPC / filesystem / explicit runtime interfaces), never Harness DOM, CSS, or component internals. Compatibility is a product feature — **Harness can change. DshCockpit should remain useful.**

In one sentence:

> **DshCockpit is a desktop control plane for DeepSeek Harness.**
> Harness owns the workspace. DshCockpit owns the operating layer.

Full philosophy → [`PHILOSOPHY.md`](PHILOSOPHY.md).
</details>
