'use strict';

// scripts/compat-policy.js — thin re-export.
//
// The implementation lives in src/compat-policy.js because **that** file ships
// inside the packaged app (electron-builder's `files` whitelist is `src/**/*`),
// and the settings page must use the exact same freshness/verdict rules as the
// CI report generator. Keeping one copy prevents the write side (CI) and the
// read side (app) from drifting apart — which is exactly how the stale-ledger
// incident (Issue #21) happened.
//
// Scripts and tests may require either path; both resolve to the same object.

module.exports = require('../src/compat-policy.js');
