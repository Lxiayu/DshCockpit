// 中英双语词典 — zh 为默认语言（HTML 内置），en 由 JS 切换注入
export const REPO = 'https://github.com/Lxiayu/DshCockpit';
export const RELEASES = 'https://github.com/Lxiayu/DshCockpit/releases/latest';
export const VERSION = 'v0.2.2';

export const dict = {
  en: {
    // nav
    'nav.features': 'Features',
    'nav.compare': 'Compare',
    'nav.download': 'Download',
    'nav.faq': 'FAQ',
    'nav.downloadBtn': 'Download',

    // hero
    'hero.eyebrow': 'OPEN SOURCE · MIT LICENSE · SYSTEMS ONLINE',
    'hero.h1a': 'Turn DeepSeek Harness into a',
    'hero.h1b': 'resident <i class="accent">Agent cockpit</i>',
    'hero.sub': 'DshCockpit turns DeepSeek Harness into a background service that keeps flying for you — cost control, usage monitoring, auto-update, scheduled tasks, quick ask and data safety, ready out of the box.',
    'hero.pill1': 'Cost Control',
    'hero.pill2': 'Usage Monitor',
    'hero.pill3': 'Auto Update',
    'hero.pill4': 'Scheduled Tasks',
    'hero.pill5': 'Quick Ask',
    'hero.pill6': 'Data Safety',
    'hero.cta': 'Download for',
    'hero.ctaGH': 'Star on GitHub',
    'hero.micro': 'Windows portable · macOS dmg (arm64/x64) · Bundled runtime — no Node.js needed',

    // stats
    'stat.1n': '92+',
    'stat.1l': 'Unit tests guarding every release',
    'stat.2n': '2,000+',
    'stat.2l': 'Community plugins in the marketplace',
    'stat.3n': '3',
    'stat.3l': 'Fully localized interface languages',
    'stat.4n': '100%',
    'stat.4l': 'Local execution — zero cloud upload',

    // bento
    'bento.tag': '// FLIGHT SYSTEMS · CORE DIFFERENTIATORS',
    'bento.h2': 'Four flagship systems, one full cockpit',
    'bento.sub': 'A set of instruments that keep working while you focus elsewhere — tasks, monitoring and alerts, running quietly in the background.',

    'b1.tag': 'SYS.01 · TOKEN MONITOR',
    'b1.h': 'Live token capsule & context-pressure alerts',
    'b1.p': 'A capsule lives in the top-right corner showing input → output tokens of the current session. Hover for details. Context pressure turns amber at 60% and red at 85% — a gentle nudge to open a fresh session.',
    'b1.ctxLabel': 'CONTEXT PRESSURE',
    'b1.state': 'STATE',

    'b2.tag': 'SYS.02 · COST CENTER',
    'b2.h': 'Cost tracking with budget alarms',
    'b2.p': 'Per-day / week / month token stats and estimated cost — see which workspace is burning money. Monthly budget with 80% / 100% dual-level alarms. No scary bills at month-end anymore.',
    'b2.budget': 'MONTHLY BUDGET',
    'b2.used': 'USED',
    'b2.over': '80% ALERT',

    'b3.tag': 'SYS.03 · UPDATE PIPELINE',
    'b3.h': 'Auto-update with smoke-test guard & rollback',
    'b3.p': 'Registry check → install → --dump-config smoke test → staged apply → switch. A broken version never goes live. One-click rollback with automatic DSH_HOME snapshots.',
    'b3.s1': 'CHECK',
    'b3.s2': 'INSTALL',
    'b3.s3': 'SMOKE',
    'b3.s4': 'STAGE',
    'b3.s5': 'LIVE',

    'b4.tag': 'SYS.04 · QUICK ASK',
    'b4.h': 'Global-hotkey Quick Ask',
    'b4.p': 'Press Ctrl+Alt+Space anywhere to pop a mini window, ask away — a headless session runs in the background and notifies you when done. No window-switching while coding.',
    'b4.hint': 'PRESS TO SUMMON · RUNS HEADLESS · NOTIFIES ON DONE',

    // compare
    'cmp.tag': '// RADAR CONTRAST · WHY THIS COCKPIT',
    'cmp.h2': 'From a window, to a console',
    'cmp.sub': 'An objective look at how DshCockpit compares with the browser version and other desktop shells.',
    'cmp.col1': 'Capability',
    'cmp.col2': 'Browser dsh web',
    'cmp.col3': 'Other desktop shells',
    'cmp.col4': 'DshCockpit',
    'cmp.r1': 'Close the window',
    'cmp.r1a': 'Session dies',
    'cmp.r1b': 'Tray resident',
    'cmp.r1c': 'Tray resident + background tasks keep running',
    'cmp.r2': 'Runtime updates',
    'cmp.r2a': 'Manual npm',
    'cmp.r2b': 'None',
    'cmp.r2c': 'Auto pipeline + smoke guard + one-click rollback',
    'cmp.r3': 'Token usage',
    'cmp.r3a': 'Flashes once',
    'cmp.r3b': 'None',
    'cmp.r3c': 'Live capsule + context-pressure alerts',
    'cmp.r4': 'Spend awareness',
    'cmp.r4a': 'Unknown',
    'cmp.r4b': 'None',
    'cmp.r4c': 'Cost center: day/week/month/workspace + budget alarms',
    'cmp.r5': 'Quick questions',
    'cmp.r5a': 'Open browser',
    'cmp.r5b': 'None',
    'cmp.r5c': 'Global-hotkey Quick Ask (headless)',
    'cmp.r6': 'Scheduled tasks',
    'cmp.r6a': 'None',
    'cmp.r6b': 'None',
    'cmp.r6c': 'Interval/daily agent tasks + notifications',
    'cmp.r7': 'History search',
    'cmp.r7a': 'Scroll manually',
    'cmp.r7b': 'None',
    'cmp.r7c': 'Ctrl+K full-text search across all sessions',
    'cmp.r8': 'Data safety',
    'cmp.r8a': 'Local',
    'cmp.r8b': 'Local',
    'cmp.r8c': 'Local + auto-backup + privacy pledge + key-free backups',

    // more features
    'more.tag': '// INSTRUMENT CLUSTER · MORE ONBOARD',
    'more.h2': 'Everything a resident agent service needs',
    'more.sub': 'The details that shape daily experience — none missing.',

    'm1.h': 'Scheduled agent tasks',
    'm1.p': 'Run fixed prompts every day or at intervals — daily reports, weekly reviews, cleanup routines. Auto-executes on schedule with system notifications.',

    'm2.h': 'Ctrl+K session search',
    'm2.p': 'Full-text search across all historical sessions. Snippet highlighting with one-click copy. Your conversation history becomes a searchable archive.',

    'm3.h': 'Plugin marketplace',
    'm3.p': 'Browse 2,000+ community plugins via the dsh-plugin topic on GitHub. One-click install/uninstall, takes effect after automatic restart.',

    'm4.h': 'Trilingual interface',
    'm4.p': 'Chinese / English / follow-system. Tray, notifications and settings fully localized. First-run onboarding with red-dot API key guidance.',

    'm5.h': 'Privacy by design',
    'm5.p': 'Fully local: no collecting, no uploading, no storing of personal info, API keys, sessions or usage data. Backups deliberately exclude credentials. sha512-verified runtime downloads.',

    'm6.h': 'Battle-tested engineering',
    'm6.p': 'Crash auto-restart with loop protection, orphan-process watchdog, window position memory, storage management with one-click cleanup, 92+ unit tests.',

    // screenshots
    'shot.tag': '// UI PREVIEW · WHAT YOU SEE IS WHAT YOU GET',
    'shot.h2': 'Real interface, at a glance',
    'shot.sub': 'Actual screenshots of the main window, feature panels and settings center.',

    // download
    'dl.tag': '// MISSION READY · GET ONBOARD',
    'dl.h2': 'Download & lift off',
    'dl.sub': 'Bundled runtime — no Node.js, no dsh install, no network download on first run. About 9 seconds to first window.',
    'dl.win.os': 'Windows Portable',
    'dl.win.arch': 'WIN-X64 · ZIP PORTABLE',
    'dl.win.desc': 'Unzip with 7-Zip/WinRAR and double-click DshCockpit.exe. Fully portable — carry it on a USB stick.',
    'dl.win.btn': 'Download .zip',
    'dl.mac.arm.os': 'macOS Apple Silicon',
    'dl.mac.arm.arch': 'MAC-ARM64 · M1/M2/M3/M4 · DMG',
    'dl.mac.arm.desc': 'Drag to Applications and launch. For MacBook Air / Pro / mini / Studio with Apple chips.',
    'dl.mac.x64.os': 'macOS Intel',
    'dl.mac.x64.arch': 'MAC-X64 · INTEL · DMG',
    'dl.mac.x64.desc': 'Drag to Applications and launch. For Intel-based Macs.',
    'dl.mac.btn': 'Download .dmg',
    'dl.mac.btn2': 'Download .dmg',
    'dl.gk.t': 'macOS says “damaged” or “unverified developer”? Normal.',
    'dl.gk.p': 'The package is not yet notarized (no Apple Developer certificate yet) — this is Gatekeeper doing its job, the app itself is fine. Fastest fix, one line in Terminal:',
    'dl.gk.after': 'After running it once, launches normally forever.',
    'dl.all': 'All versions & release notes',
    'dl.src': 'Running from source (developers):',
    'dl.srcHint': 'Requires Node.js ≥ 22',

    // roadmap
    'rm.tag': '// FLIGHT PLAN · WHERE WE HEAD NEXT',
    'rm.h2': 'Roadmap',
    'rm.done.h': 'Delivered',
    'rm.plan.h': 'Planned',
    'rm.d1': 'Dual-layer auto-update (shell + runtime) with rollback',
    'rm.d2': 'Token monitoring + cost center + budget alarms',
    'rm.d3': 'Quick Ask + scheduled tasks + completion notifications',
    'rm.d4': 'Full-text search + auto-backup + privacy pledge',
    'rm.d5': 'Plugin marketplace + trilingual UI + portable bundling',
    'rm.d6': 'macOS CI builds (arm64 + x64)',
    'rm.p1': 'macOS code signing & notarization',
    'rm.p2': 'Windows Authenticode signing',
    'rm.p3': 'System keychain integration (credential encryption)',
    'rm.p4': 'Mobile remote control / more workflows',

    // faq
    'faq.tag': '// COMMS · QUESTIONS FROM THE TOWER',
    'faq.h2': 'FAQ',
    'q1': 'Is DshCockpit free?',
    'a1': 'Yes — 100% free and open source under the MIT license. All code is public on GitHub and auditable.',
    'q2': 'Is my data safe?',
    'a2': 'DshCockpit runs fully locally: it does not collect, upload or store your personal info, API keys, sessions or usage data. Backups deliberately exclude API credentials, and runtime downloads are sha512-verified. The harness file-sandbox and approval mechanism is preserved as-is.',
    'q3': 'Do I need Node.js or dsh preinstalled?',
    'a3': 'No. Official packages bundle the runtime — double-click and fly. Building from source requires Node.js ≥ 22 (dsh auto-downloads on first launch if missing).',
    'q4': 'macOS warns the app is “damaged”?',
    'a4': 'The package is not notarized yet, so Gatekeeper blocks it. Run this once in Terminal:',
    'a4b': 'then launch normally. This notice will disappear once notarization is in place.',
    'q5': 'How do updates work?',
    'a5': 'Two layers, fully decoupled: the shell self-checks on start and every 4 hours (with release-note dialog); the runtime updates through the pipeline with a --dump-config smoke-test guard — a bad version never activates, and one click rolls back to the previous runtime.',

    // community section
    'com.tag': '// COMM CHANNEL · JOIN THE SQUADRON',
    'com.h': 'Join the community group',
    'com.p': 'Scan the code and talk directly with the developer — usage questions, feedback and ideas, or where agent-on-desktop should fly next.',
    'com.i1': 'New release announcements, first in the group',
    'com.i2': 'Fast troubleshooting for issues and edge cases',
    'com.i3': 'Feature requests that actually shape the roadmap',
    'com.i4': 'Home base for plugin authors and power users',
    'com.scan': 'WeChat scan to join',
    'foot.join': 'Join the community group',

    // final cta
    'cta.h': 'Ready for takeoff?',
    'cta.p': 'Download, configure your API key, drop in a workspace folder — and let your agent fly resident.',
    'cta.btn': 'Download now',
    'cta.btn2': 'View on GitHub',

    // footer
    'foot.desc': 'An open-source, free desktop cockpit that turns DeepSeek Harness into a resident background agent service — keep your agent always flying.',
    'foot.res': 'Resources',
    'foot.res1': 'GitHub Repository',
    'foot.res2': 'Releases & Changelog',
    'foot.res3': 'Design Doc (DESIGN.md)',
    'foot.res4': 'Features (FEATURES.md)',
    'foot.eco': 'Ecosystem',
    'foot.eco1': 'DeepSeek Harness',
    'foot.eco2': 'awesome-dsh-plugin',
    'foot.eco3': 'dsh-plugin topic',
    'foot.group': 'Community',
    'foot.qr': 'Scan to join the chat group — feedback, ideas, agent-on-desktop talk.',
    'foot.rights': '© 2026 Lxiayu · MIT License',
    'foot.made': 'Built for DeepSeek Harness · dshcockpit.site',

    // toast
    'toast.copied': 'Copied to clipboard ✓',

    // os names
    'os.mac': 'macOS',
    'os.win': 'Windows',
  },
};
