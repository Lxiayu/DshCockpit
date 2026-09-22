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

const path = require('node:path');
const slim = process.env.DSH_BUILD_SLIM === '1';
// DSH_DESKTOP_ELECTRON_DIST: point electron-builder at a locally unpacked
// Electron distribution (e.g. node_modules/electron/dist) — dev fallback for
// networks where the default TLS download keeps breaking. CI never sets it.
const localElectronDist = process.env.DSH_DESKTOP_ELECTRON_DIST
  ? path.resolve(process.env.DSH_DESKTOP_ELECTRON_DIST)
  : undefined;

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
  ...(localElectronDist ? { electronDist: localElectronDist } : {}),
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
    { from: 'resources/office', to: 'office' },
    // The office view is a first-class screen since M4 (direct start): the
    // character pack and the dialogue corpus must ship with the artifact.
    { from: 'resources/characters', to: 'characters' },
    { from: 'resources/dialogue', to: 'dialogue' },
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
  },
  // NOTE: nsis is a TOP-LEVEL key (win.nsis is invalid per schema).
  // H11: assisted wizard (welcome -> directory -> shortcuts -> progress with
  // detail log -> finish) instead of the bare one-click progress bar — users
  // asked for drive/shortcut choice and visible installation steps.
  // Posture (R10 boundary table): per-user, no UAC; uninstaller never touches
  // %APPDATA%\dsh-cockpit.
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,
    include: 'resources/installer.nsh',
  },
  mac: {
    target: [
      { target: 'zip', arch: ['arm64'] },
      { target: 'dmg', arch: ['arm64'] },
    ],
    icon: 'resources/icon.png',
    category: 'public.app-category.developer-tools',
    darkModeSupport: true,
    // H-mac-sign: identity '-' = AD-HOC signing. Skipping signing entirely
    // (identity:null) leaves the .app with a linker-signed stub whose
    // designated requirement is the cdhash itself — every rebuild changes it,
    // so Squirrel.Mac update validation AND codesign --verify both fail.
    // An ad-hoc signature gives a stable DR (identifier com.dshcockpit.app),
    // which is what Squirrel.Mac compares across versions -> in-app
    // auto-update becomes viable WITHOUT a Developer ID.
    // Developer ID signing + notarization remains the D-1 upgrade path
    // (swap identity for CSC_LINK then).
    identity: '-',
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
