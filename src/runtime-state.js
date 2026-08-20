'use strict';

const RUNTIME_STATES = Object.freeze(['starting', 'healthy', 'restarting', 'offline']);
const VALID = new Set(RUNTIME_STATES);

function createRuntimeStateController(options) {
  const opts = options || {};
  let state = VALID.has(opts.initial) ? opts.initial : 'starting';
  let generation = 0;

  function publish(next, force = false) {
    if (!VALID.has(next) || (!force && next === state)) return false;
    state = next;
    const snapshot = { state, generation };
    if (typeof opts.onInvalidate === 'function') opts.onInvalidate(snapshot);
    if (typeof opts.onState === 'function') opts.onState(state, snapshot);
    if (typeof opts.onBroadcast === 'function') opts.onBroadcast(snapshot);
    return true;
  }

  return {
    begin(next = 'starting') {
      generation += 1;
      publish(next, true);
      return generation;
    },
    transition(next, token) {
      if (token !== undefined && token !== generation) return false;
      return publish(next);
    },
    isCurrent(token) { return token === generation; },
    snapshot() { return { state, generation }; },
    state() { return state; },
    generation() { return generation; },
  };
}

module.exports = { RUNTIME_STATES, createRuntimeStateController };
