# Startup, Performance, and Cockpit Reliability Design

## Goal

Make packaged Windows and macOS first launch reliable, keep the first visible window usable, remove main-process CPU stalls caused by session logs, and make the floating Cockpit rail easy to drag without losing button clicks.

## Architecture

The Electron main process remains the owner of windows, runtime lifecycle, and IPC. A dedicated session worker owns the expensive session-log pipeline: directory enumeration, zstd decoding, usage aggregation, and compaction scanning. Requests are serialized and cached so token polling and compaction tracking share one decoded snapshot. The existing synchronous/async `token-stats` APIs remain available for unit tests and non-Electron callers.

The loading window is created early but is only surfaced after its renderer is ready; progress is buffered and startup failures keep the window visible with a useful error. Nonessential services start after the runtime window is interactive. The rail uses a larger explicit drag surface, a visible border, and clamped offset updates that cannot be overwritten by delayed main-window synchronization.

## Error Handling

Worker failures reject the current request, reset the worker, and leave the last valid usage snapshot in place. Runtime or loading-window failures are logged and reported in the loading UI; they do not silently close the only visible feedback window. Missing or invalid packaged runtime resources fail build verification before publication.

## Testing

Add worker protocol and request-deduplication tests, loading/resource contract tests, and drag-hit-area/bounds tests. Run the full Node test suite and both directory/zip artifact verification paths available on the host.
