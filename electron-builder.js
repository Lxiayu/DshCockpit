// electron-builder.js — packaging configuration (v0.3.0 D2).
//
// Single source of truth for BOTH distribution tracks:
//   full (default)  — bundles the pinned runtime seed (resources/runtime),
//                     ~194MB-class artifact, boots offline out of the box.
//   slim            — set DSH_BUILD_SLIM=1 (build.js --slim does this): no
//                     runtime seed in extraResources; first launch runs the
//                     guided registry install or picks up a system dsh (H5).
//                     ≈100MB-class artifact.
// JS config instead of two YAML files: no drift between the variants and no
// CLI --config precedence surprises.
'use strict';

const slim = process.env.DSH_BUILD_SLIM === '1';

const runtimeSeed = slim
  ? []
  : [{ from: 'vendor/runtime', to: 'runtime' }];

const suffix = slim ? '-slim' : '';

const config = {
  appId: 'com.dshcockpit.app',
  productName: 'DshCockpit',
  directories: {
    output: 'dist',
    buildResources: 'resources',
  },
  // Whitelist packaging (v0.2.9): only what the shell reads at runtime.
  files: [
    'src/**/*',
    '!**/*.map',
  ],
  asar: true,
  // pnpm is spawned as a plain node child by the dsh CLI ("spawnSync('pnpm')"),
  // which cannot execute inside app.asar — keep its cjs entry unpacked.
  asarUnpack: ['node_modules/pnpm/bin/pnpm.cjs'],
  compression: 'normal',
  // Bundled runtime seed -> resources/runtime/<version> (full track only;
  // install-and-use, no first-run download) + the app icon.
  extraResources: [
    ...runtimeSeed,
    { from: 'resources/icon.png', to: 'icon.png' },
  ],
  win: {
    // D5: zip = portable/escape hatch; nsis = primary track with in-app
    // auto-update (electron-updater consumes latest.yml + .exe.blockmap for
    // MB-level differential upgrades).
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    icon: 'resources/icon.png',
    artifactName: `DshCockpit-\${version}${suffix}-win-\${arch}.\${ext}`,
    // NSIS posture (R10 boundary table): per-user, no UAC, one-click like
    // Slack/Discord; uninstaller never touches %APPDATA%\dsh-cockpit.
    nsis: {
      oneClick: true,
      perMachine: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false,
    },
  },
  mac: {
    target: [
      { target: 'zip', arch: ['arm64'] },
      { target: 'dmg', arch: ['arm64'] },
    ],
    icon: 'resources/icon.png',
    category: 'public.app-category.developer-tools',
    darkModeSupport: true,
    // Unsigned distribution (no Apple Developer ID yet). identity:null skips
    // code signing; hardenedRuntime MUST be false when unsigned. See README
    // "macOS 安装" for the Gatekeeper override; flip to signing+notarization
    // later via CSC_LINK/APPLE_* env vars.
    identity: null,
    hardenedRuntime: false,
    artifactName: `DshCockpit-\${version}${suffix}-mac-\${arch}.\${ext}`,
  },
  publish: {
    provider: 'github',
    owner: '${env.DSH_REPO_OWNER}',
    repo: '${env.DSH_REPO_NAME}',
  },
};

module.exports = config;
