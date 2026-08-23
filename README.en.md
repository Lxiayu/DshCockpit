**English** | **[简体中文](README.md)**

<div align="center">

# 🛩️ DshCockpit

**Not another window around `dsh` — a desktop control plane.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-blue)](#)
[![Tests](https://img.shields.io/badge/tests-311%20passing-brightgreen)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

DshCockpit turns [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) from a terminal command into a resident desktop service: it keeps the
Harness workspace 100% native, and adds the layer around it — safe runtime
updates, cost tracking, background tasks, remote access — over stable
interfaces only. Bundled runtime, no Node.js required.

</div>

---

## Why does this exist?

If you run agents through `dsh` daily, three problems never go away:

| Problem | What actually happens |
|---|---|
| **Updates are a leap of faith** | Upstream ships rc releases every few days; upgrading by hand can break your profile, and downgrading means reinstalling. |
| **You can't see what it costs** | No usage API, no spend dashboard — you find out what a debugging spree cost when the bill arrives. |
| **The agent lives in one window** | Close the window (or the laptop) and long tasks die. Approvals wait for you to come back. |

Typical desktop shells solve none of these — they wrap the same window in a
tray icon. DshCockpit treats the agent as a **service to operate**, and the
window is just where it happens to be visible.

## What you get

### 1 · A runtime that can't brick itself

New runtime versions install side-by-side, must pass a `--dump-config` smoke
test before activation, then switch atomically. A broken release never
activates. One-click rollback restores the previous version **and** a snapshot
of your data directory. Updates follow the official npm channel automatically
— no vendoring, no forks, no lag behind upstream.

### 2 · Cost & usage observability

- **Context pressure inline**: a quiet capsule tracks input/output/cache tokens
  of the current session, warns at 60%/85%, compacts in one click
- **Cost center**: per day/week/month, attributed per workspace, peak/off-peak
  pricing aware, monthly budget with 80%/100% alarms
- **Live balance**: total/granted/topped-up from the official API, exact
  per-turn spend including cache savings

All computed locally from session logs (pure-JS zstd decompression). No
telemetry, ever.

### 3 · An agent that works when you're not watching

- **Quick Ask** — `Ctrl+Alt+Space`, ask anything, runs headless, notified on completion
- **Scheduled tasks** — daily reports, interval jobs, run history
- **IM channels** — Feishu / WeCom / DingTalk: completions, approvals, and agent questions land in your group chat, handled with buttons
- **Phone remote** — full UI in your phone browser via an authenticated LAN gateway; Tailscale/Cloudflare for outside home
- **Session search** — `Ctrl+K` full-text across all history; auto-backup on exit

Plus: model manager (6 provider templates + Ollama), plugin & skills
marketplaces with previews, bilingual UI, dark/light themes.

### How it compares

| | plain `dsh web` | typical shell wrappers | **DshCockpit** |
|---|---|---|---|
| Double-click launch, bundled runtime | ❌ | ✅ | ✅ |
| Update gating + rollback + data snapshot | ❌ | ❌ | ✅ |
| Token/context pressure + budget alarms | ❌ | ❌ | ✅ |
| Per-workspace cost analytics | ❌ | ❌ | ✅ |
| Global-hotkey background asks | ❌ | ❌ | ✅ |
| Scheduled prompts | ❌ | ❌ | ✅ |
| Full-text session search | ❌ | ❌ | ✅ |
| Authenticated phone remote | ❌ | rare | ✅ |
| Runs the **unpatched official runtime** | — | often vendored/forked | ✅ always |

## Zero-intrusion by design

The shell never patches upstream source and never touches its internals. Every
integration rides a stable boundary: HTTP/WebSocket, the filesystem (session
logs), CLI flags (`--dump-config`, port discovery), and explicit IPC. That's
why "Harness can change; the cockpit stays useful" is an engineering property
here, not a slogan. Details in [`DESIGN.md`](DESIGN.md).

## Quick Start

**Windows**: grab `DshCockpit-<version>-win-x64.zip` from
[Releases](https://github.com/Lxiayu/DshCockpit/releases), extract (7-Zip/WinRAR),
double-click `DshCockpit.exe`. ~9 s to first window; future updates are automatic.

**macOS**: download the `.dmg` for your arch (Apple Silicon / Intel), drag to
Applications, launch.

> ⚠️ Not signed yet — Gatekeeper will complain once. Clear it permanently:
> ```bash
> xattr -dr com.apple.quarantine /Applications/DshCockpit.app
> ```

**From source** (Node ≥ 22):
```bash
git clone https://github.com/Lxiayu/DshCockpit.git && cd DshCockpit
npm install && npm start
```

First run: set your DeepSeek API key (red-dot hint on the gear), pick a
workspace, talk to your agent. Everything else is optional.

## Screenshots

<div align="center">
<img src="photo/preview-1.png?v=0.2.7" width="720" alt="Native DeepSeek Harness workspace with DshCockpit Edge Rail showing context status" />
<table><tr>
<td><img src="photo/preview-2.png?v=0.2.7" width="280" alt="Cost center: per-workspace spend, budgets, alerts" /></td>
<td><img src="photo/preview-3.png?v=0.2.7" width="280" alt="Control center and plugin marketplace" /></td>
</tr></table>
</div>

## Honest limitations

- macOS builds are unsigned/notarized-yet (needs the `xattr` line above);
  Windows may trigger SmartScreen for the same reason
- Solo-maintained project; battle-tested mainly on the author's machines
- Windows is the primary development target; macOS arm64/x64 builds are CI-built and smoke-tested but see less real-world mileage

## Contributing

PRs welcome — run `npm test` (311 tests) first. Architecture:
[`DESIGN.md`](DESIGN.md) · Philosophy: [`PHILOSOPHY.md`](PHILOSOPHY.md) ·
Features: [`FEATURES.md`](FEATURES.md)

<details>
<summary><b>The operating-layer principle</b></summary>

Harness owns the workspace. DshCockpit owns the operating layer.

The workspace — conversation, files, code, approvals — belongs to Harness,
unmodified. Everything around it — monitoring, cost, automation, updates,
remote access — belongs to the cockpit. High-frequency actions stay visible;
Settings holds only persistent configuration; small questions never open big
dashboards (`Default → Peek → Cockpit → Full config`). An agent is not a
window: it is a desktop service that keeps running, accumulating usage, and
accepting instructions regardless of what's in front.

Full text: [`PHILOSOPHY.md`](PHILOSOPHY.md)
</details>

## License & Acknowledgements

[MIT](LICENSE) · Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
Community project — not affiliated with or endorsed by DeepSeek.
