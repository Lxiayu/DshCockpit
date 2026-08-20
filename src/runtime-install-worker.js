'use strict';

// This file intentionally has no Electron dependency. RuntimeManager launches
// it in a separate Node process so npm/arborist CPU and synchronous filesystem
// work cannot block Electron's main event loop.
let args;
try {
  args = JSON.parse(process.argv[2] || '{}');
} catch (err) {
  process.stderr.write(`invalid install arguments: ${err.message}\n`);
  process.exitCode = 2;
}

if (args) {
  (async () => {
    const startedAt = Date.now();
    const emit = (type, extra = {}) => {
      try { process.stdout.write(JSON.stringify({ type, ...extra }) + '\n'); } catch { /* parent may be closing */ }
    };
    const heartbeat = setInterval(() => emit('heartbeat', {
      phase: 'dependency-resolution',
      elapsedMs: Date.now() - startedAt,
    }), 1_000);
    try {
      const Arborist = require('@npmcli/arborist');
      emit('heartbeat', { phase: 'dependency-resolution', elapsedMs: 0 });
      const arb = new Arborist({
        path: args.targetDir,
        registry: args.registry,
        cache: args.cacheDir,
        fund: false,
        audit: false,
        foregroundScripts: false,
      });
      await arb.reify({ save: false });
      emit('complete', { elapsedMs: Date.now() - startedAt });
    } catch (err) {
      process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    } finally {
      clearInterval(heartbeat);
    }
  })();
}
