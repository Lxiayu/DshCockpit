'use strict';

// src/office/runtime/employee-profile.js — Task 5 / SPEC-04.
//
// Fixed resident employee profiles plus the single collaborator seat.
// Pure data + pure functions: no Electron/Pixi/DOM/fs/network/clock/random
// access, no Harness import, no wall-clock or PRNG-global access.
//
// Contracts (SPEC-04):
// - exactly four fixed residents: orchestrator->desk-1, researcher->desk-2,
//   coder->desk-3, reviewer->desk-4
// - desk-5/desk-6 are collaborator/future seats and never auto-create
//   residents
// - exactly one collaborator profile (singleton, FIFO queue policy)
// - profiles are separated from Harness Sessions: a Harness payload can never
//   override the employee identity, the allowedOverrides permission list, or
//   (without the explicit trusted-override entry point) the character pack
// - output is frozen and JSON-replayable

const RESIDENT_EMPLOYEE_IDS = Object.freeze(['orchestrator', 'researcher', 'coder', 'reviewer']);

const RESIDENT_SEATS = Object.freeze({
  orchestrator: 'desk-1',
  researcher: 'desk-2',
  coder: 'desk-3',
  reviewer: 'desk-4',
});

const DISPLAY_NAMES = Object.freeze({
  orchestrator: '调度员',
  researcher: '研究员',
  coder: '编码员',
  reviewer: '评审员',
  collaborator: '协作者',
});

const ROLES = Object.freeze({
  orchestrator: '任务编排与分发',
  researcher: '资料检索与分析',
  coder: '编码、文件、命令',
  reviewer: '代码与结果评审',
  collaborator: '动态协作者席位',
});

const ALLOWED_OVERRIDES = Object.freeze([
  'displayName',
  'role',
  'seat',
  'characterPack',
  'variant',
]);

const DEFAULT_CHARACTER_PACK = 'deepseek-default';
const DEFAULT_VARIANT = 'base';
const COLLABORATOR_ID = 'collaborator';
const COLLABORATOR_SEAT = 'desk-5';
const FUTURE_SEATS = Object.freeze(['desk-6']);

function createProfile(employeeId, defaultSeat, extras) {
  return Object.freeze({
    employeeId,
    displayName: DISPLAY_NAMES[employeeId],
    role: ROLES[employeeId],
    defaultSeat,
    characterPack: DEFAULT_CHARACTER_PACK,
    variant: DEFAULT_VARIANT,
    allowedOverrides: ALLOWED_OVERRIDES,
    ...(extras || {}),
  });
}

const RESIDENT_PROFILES = Object.freeze(
  RESIDENT_EMPLOYEE_IDS.map((employeeId) => createProfile(employeeId, RESIDENT_SEATS[employeeId]))
);

// The single collaborator seat: singleton, FIFO queue policy. It has no fixed
// personal desk; the seat assignment (desk-5 today) is a preference, and it is
// never a resident.
const COLLABORATOR_PROFILE = Object.freeze(
  createProfile(COLLABORATOR_ID, COLLABORATOR_SEAT, {
    isSingleton: true,
    queuePolicy: 'fifo',
  })
);

const PROTECTED_FIELDS = Object.freeze(['employeeId', 'allowedOverrides']);
const OVERRIDE_TO_PROFILE_FIELD = Object.freeze({ seat: 'defaultSeat' });

function listResidentProfiles() {
  return RESIDENT_PROFILES;
}

function getResidentProfile(employeeId) {
  return RESIDENT_PROFILES.find((profile) => profile.employeeId === employeeId) || null;
}

function getCollaboratorProfile() {
  return COLLABORATOR_PROFILE;
}

function resolveProfileForSeat(seat) {
  if (typeof seat !== 'string') return null;
  // Only resident seats resolve to a resident profile; desk-5 (collaborator
  // seat) and desk-6 (future seat) never auto-map to a resident.
  return RESIDENT_PROFILES.find((profile) => profile.defaultSeat === seat) || null;
}

// Applies overrides to a profile snapshot. Fields outside allowedOverrides
// (employeeId, allowedOverrides, ...) are silently ignored, so a Harness
// payload can never rewrite the employee identity or the permission list.
// Character pack/variant/seat stay overridable ONLY through this explicit,
// trusted entry point — never implicitly from a Harness Session payload.
function applyOverrides(profile, overrides) {
  if (!profile || typeof profile !== 'object') return null;
  const next = { ...profile, allowedOverrides: [...profile.allowedOverrides] };
  if (overrides && typeof overrides === 'object') {
    for (const key of ALLOWED_OVERRIDES) {
      if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
      const value = overrides[key];
      if (value === undefined || value === null) continue;
      const field = OVERRIDE_TO_PROFILE_FIELD[key] || key;
      next[field] = value;
    }
  }
  return Object.freeze(next);
}

module.exports = {
  RESIDENT_EMPLOYEE_IDS,
  COLLABORATOR_ID,
  COLLABORATOR_SEAT,
  FUTURE_SEATS,
  DEFAULT_CHARACTER_PACK,
  listResidentProfiles,
  getResidentProfile,
  getCollaboratorProfile,
  resolveProfileForSeat,
  applyOverrides,
};
