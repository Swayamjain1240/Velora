'use strict';

// Isolated document parser worker.
//
// This thread receives ONLY the bytes and the declared type/filename. Its
// environment is deliberately reduced to NODE_ENV by the parent (documentValidator),
// so it never sees MongoDB, encryption or provider secrets. Its memory is
// capped via `resourceLimits` and its wall-clock time via a parent-side timer.
// On ANY internal failure it reports the single stable code `PARSER_ERROR`, so
// no parser path, stack or diagnostic can reach a client.
const { parentPort, workerData } = require('node:worker_threads');
const { inspect } = require('../services/documentInspector');
const { extractTextLayer } = require('../services/documentTextLayer');

// Test-only stall hook: lets the suite prove the parent's time limit and worker
// termination. It is inert unless the parent set NODE_ENV=test for this thread,
// which request handlers never do.
function stall(ms) {
  const end = Date.now() + ms;
  // eslint-disable-next-line no-empty
  while (Date.now() < end) {}
}

try {
  if (workerData && workerData.stallMs && process.env.NODE_ENV === 'test') {
    stall(workerData.stallMs);
  }
  // Two modes share this worker so untrusted bytes are always parsed in the
  // reduced environment: structural validation (Part 4) and text-layer reading
  // (Part 6). Neither mode can reach a secret, the database or the network.
  const result =
    workerData && workerData.mode === 'text'
      ? extractTextLayer(workerData.bytes, {
          mediaType: workerData.mediaType,
          maxChars: workerData.maxChars,
        })
      : inspect(workerData.bytes, {
          filename: workerData.filename,
          declaredMediaType: workerData.declaredMediaType,
          maxBytes: workerData.maxBytes,
        });
  parentPort.postMessage(result);
} catch {
  parentPort.postMessage({ ok: false, code: 'PARSER_ERROR' });
}
