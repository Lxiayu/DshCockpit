'use strict';

// src/office/office-pack-resolver.js — Task 4 production character pack
// resolution. Pure and injectable (no Electron/fs import of its own): main.js
// supplies the real packs root, the user's selected pack id and an existsSync.
//
// Contract:
// - the selected installed character pack wins when it is a safe pack id and
//   its manifest exists under packsRoot/<id>/manifest.json
// - anything else (invalid id, unpacked selection) falls back to the built-in
//   deepseek-default pack with the stable code OFFICE_PACK_SELECTION_INVALID
// - a missing built-in pack resolves ok:false with OFFICE_PACK_MISSING while
//   still naming the built-in id, so callers can raise a stable diagnostic
// - the test fixture pack (src/office/fixtures/character-pack) is never a
//   production candidate and ids never carry path separators

const BUILTIN_PACK_ID = 'deepseek-default';
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function manifestPath(packsRoot, packId) {
  return `${packsRoot.replace(/[\\/]+$/, '')}/${packId}/manifest.json`;
}

function resolveOfficeCharacterPack({ packsRoot, selectedPackId, existsSync } = {}) {
  if (!packsRoot || typeof packsRoot !== 'string') {
    throw new TypeError('resolveOfficeCharacterPack requires packsRoot');
  }
  const exists = typeof existsSync === 'function' ? existsSync : (() => false);
  const builtinInstalled = exists(manifestPath(packsRoot, BUILTIN_PACK_ID));

  const selectionPresent =
    typeof selectedPackId === 'string'
    && selectedPackId.length > 0
    && selectedPackId !== BUILTIN_PACK_ID;
  const selectionUsable = selectionPresent && PACK_ID_PATTERN.test(selectedPackId);

  if (selectionUsable && exists(manifestPath(packsRoot, selectedPackId))) {
    return { ok: true, packId: selectedPackId, builtin: false, code: null };
  }
  if (builtinInstalled) {
    return {
      ok: true,
      packId: BUILTIN_PACK_ID,
      builtin: true,
      code: selectionPresent ? 'OFFICE_PACK_SELECTION_INVALID' : null,
    };
  }
  return { ok: false, packId: BUILTIN_PACK_ID, builtin: true, code: 'OFFICE_PACK_MISSING' };
}

module.exports = {
  BUILTIN_PACK_ID,
  PACK_ID_PATTERN,
  resolveOfficeCharacterPack,
};
