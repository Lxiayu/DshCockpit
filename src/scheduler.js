// src/scheduler.js — shell-level recurring task scheduler.
//
// Tasks live in settings.scheduledTasks: { id, name, prompt, kind,
// everySeconds? | dailyTime? ("HH:MM"), enabled, nextRunAt, lastRunAt }.
// A 30s tick dispatches due tasks to the caller (which runs headless + notifies).
'use strict';

const TICK_MS = 30_000;

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, min };
}

/** Return when this task should run next, given `now`. Mutates task.nextRunAt. */
function ensureNextRun(task, now) {
  if (task.kind === 'every') {
    const secs = Math.max(60, Number(task.everySeconds) || 60);
    if (!task.nextRunAt) {
      task.nextRunAt = now + secs * 1000; // first run: schedule ahead
    } else if (task.nextRunAt <= now - secs * 1000) {
      // missed by more than one full interval (e.g. app was closed): skip to next
      task.nextRunAt = now + secs * 1000;
    }
    return task.nextRunAt;
  }
  if (task.kind === 'daily') {
    const t = parseTime(task.dailyTime);
    if (!t) return null;
    const today = new Date(now);
    today.setHours(t.h, t.min, 0, 0);
    if (task.nextRunAt === undefined || task.nextRunAt < today.getTime() - 86_400_000) {
      // next occurrence: today at HH:MM if still ahead, else tomorrow
      task.nextRunAt = today.getTime() > now ? today.getTime() : today.getTime() + 86_400_000;
    }
    return task.nextRunAt;
  }
  return null;
}

class Scheduler {
  constructor(log) {
    this.log = log || (() => {});
    this.tasks = [];
    this.timer = null;
  }

  start(tasks, onDue) {
    this.tasks = tasks || [];
    this.onDue = onDue;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.check(), TICK_MS);
    this.check();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  check() {
    const now = Date.now();
    for (const task of this.tasks) {
      if (!task || !task.enabled) continue;
      const next = ensureNextRun(task, now);
      if (next !== null && next <= now) {
        task.lastRunAt = new Date().toISOString();
        task.nextRunAt = undefined; // recompute after firing
        this.log(`[scheduler] due: ${task.name || task.id}`);
        if (this.onDue) {
          try { this.onDue(task); } catch (e) { this.log(`[scheduler] dispatch failed: ${e.message}`); }
        }
      }
    }
  }
}

module.exports = { Scheduler, parseTime, ensureNextRun };
