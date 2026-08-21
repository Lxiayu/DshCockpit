'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULT_WORKER = path.join(__dirname, 'session-worker.js');

/**
 * Long-lived session worker facade. Equal requests made while one is running
 * share the same promise; a worker crash rejects pending callers and the next
 * request starts a fresh worker.
 */
function createSessionWorkerClient(options) {
  const workerPath = (options && options.workerPath) || DEFAULT_WORKER;
  let worker = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const inflight = new Map();
  const metrics = { jobs: 0 };

  function failWorker(err) {
    const e = err instanceof Error ? err : new Error(String(err || 'session worker failed'));
    for (const { reject } of pending.values()) reject(e);
    pending.clear();
    inflight.clear();
    if (worker) {
      const old = worker;
      worker = null;
      old.removeAllListeners();
      old.terminate().catch(() => {});
    }
  }

  function ensureWorker() {
    if (closed) throw new Error('session worker client is closed');
    if (worker) return worker;
    worker = new Worker(workerPath);
    worker.on('message', (msg) => {
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.ok) item.resolve(msg.result);
      else item.reject(new Error(msg.error || 'session worker operation failed'));
    });
    worker.on('error', failWorker);
    worker.on('exit', (code) => {
      if (code !== 0 && worker) failWorker(new Error(`session worker exited with code ${code}`));
      else if (worker) worker = null;
    });
    return worker;
  }

  function request(op, payload) {
    const key = JSON.stringify({ op, ...payload });
    const shared = inflight.get(key);
    if (shared) return shared;
    const promise = new Promise((resolve, reject) => {
      const w = ensureWorker();
      const id = nextId++;
      pending.set(id, { resolve, reject });
      metrics.jobs += 1;
      try { w.postMessage({ id, op, ...payload }); }
      catch (err) { pending.delete(id); reject(err); }
    }).finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return {
    collect(dshHome, options) { return request('collect', { dshHome, options: options || {} }); },
    scanCompactions(file) { return request('compact', { file }); },
    stats() { return { jobs: metrics.jobs, pending: pending.size, worker: !!worker }; },
    async close() {
      closed = true;
      const old = worker;
      worker = null;
      failWorker(new Error('session worker client closed'));
      if (old) await old.terminate().catch(() => {});
    },
  };
}

module.exports = { createSessionWorkerClient };
