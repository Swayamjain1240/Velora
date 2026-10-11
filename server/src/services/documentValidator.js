'use strict';

// Bounded parser pool. Runs the isolated worker (documentParser) under a hard
// time limit, a memory cap, a concurrency limit and a bounded queue, then maps
// the stable result code to a SAFE error message (control #8, #9). Parser
// internals, file paths and stacks never leave this module.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { getEnv } = require('../config/env');
const { errors, AppError } = require('./errors');

const WORKER_FILE = path.resolve(__dirname, '../workers/documentParser.js');

// Codes that mean "this file is not acceptable": deterministic, client-facing.
const REJECTION_CODES = new Set([
  'EMPTY',
  'TOO_LARGE',
  'BAD_FILENAME',
  'UNSUPPORTED_TYPE',
  'TYPE_MISMATCH',
  'TRAILING_DATA',
  'PDF_MALFORMED',
  'PDF_ENCRYPTED',
  'PDF_ACTIVE_CONTENT',
  'PDF_ATTACHMENT',
  'PDF_FORM',
  'PDF_EXTERNAL_REF',
  'PDF_TRAILING_DATA',
  'PDF_TOO_MANY_PAGES',
  'PDF_TOO_MANY_OBJECTS',
  'PDF_STREAM_TOO_LARGE',
  'IMAGE_MALFORMED',
  'IMAGE_PIXEL_BOMB',
  'IMAGE_MULTIFRAME',
]);

// Codes that mean the request never described an acceptable document at all
// (empty, oversize, wrong type/extension). These are refused WITHOUT recording
// a metadata row, so a caller cannot fill the database with junk attempts.
const PRE_PERSIST_CODES = new Set([
  'EMPTY',
  'TOO_LARGE',
  'BAD_FILENAME',
  'UNSUPPORTED_TYPE',
  'TYPE_MISMATCH',
]);

// Codes that mean the parser could not reach a verdict: the file is kept
// encrypted in quarantine for an operator, never marked ready.
const INCONCLUSIVE_CODES = new Set(['PARSER_TIMEOUT', 'PARSER_ERROR']);

const SAFE_MESSAGES = Object.freeze({
  EMPTY: 'The file is empty.',
  TOO_LARGE: 'The file exceeds the 10 MiB limit.',
  BAD_FILENAME: 'The filename is not acceptable.',
  UNSUPPORTED_TYPE: 'Only PDF, JPEG and PNG files are accepted.',
  TYPE_MISMATCH: 'The file contents do not match its declared type.',
  TRAILING_DATA: 'The file has unexpected data appended after its end.',
  PDF_MALFORMED: 'The PDF is malformed or truncated.',
  PDF_ENCRYPTED: 'Encrypted PDFs are not accepted.',
  PDF_ACTIVE_CONTENT: 'PDFs with scripts, actions or other active content are not accepted.',
  PDF_ATTACHMENT: 'PDFs with embedded files or attachments are not accepted.',
  PDF_FORM: 'PDF forms are not accepted.',
  PDF_EXTERNAL_REF: 'PDFs with external file references are not accepted.',
  PDF_TRAILING_DATA: 'The PDF has unexpected data appended after its end.',
  PDF_TOO_MANY_PAGES: 'The PDF has too many pages.',
  PDF_TOO_MANY_OBJECTS: 'The PDF is too complex.',
  PDF_STREAM_TOO_LARGE: 'The PDF declares excessively large streams.',
  IMAGE_MALFORMED: 'The image is malformed or truncated.',
  IMAGE_PIXEL_BOMB: 'The image dimensions are unreasonably large.',
  IMAGE_MULTIFRAME: 'Multi-frame images are not accepted.',
  PARSER_TIMEOUT: 'The file could not be validated in time and was quarantined.',
  PARSER_ERROR: 'The file could not be validated and was quarantined.',
});

function statusFor(code) {
  if (code === 'TOO_LARGE') return 413;
  if (code === 'UNSUPPORTED_TYPE') return 415;
  return 400;
}

function safeError(code) {
  const message = SAFE_MESSAGES[code] || 'The file could not be accepted.';
  return new AppError(statusFor(code), code, message);
}

function errorClass(code) {
  if (PRE_PERSIST_CODES.has(code)) return 'invalid';
  if (REJECTION_CODES.has(code)) return 'rejected';
  if (INCONCLUSIVE_CODES.has(code)) return 'quarantined';
  return 'quarantined';
}

// ---- bounded semaphore ---------------------------------------------------
let active = 0;
const waiters = [];

function acquire() {
  const limit = getEnv().DOCUMENT_PARSER_CONCURRENCY;
  if (active < limit) {
    active += 1;
    return Promise.resolve();
  }
  if (waiters.length >= getEnv().DOCUMENT_PARSER_QUEUE_MAX) {
    return Promise.reject(errors.busy());
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next(); // hand the slot straight over; `active` is unchanged
  else active -= 1;
}

function runWorker(payload, { timeoutMs, memoryMb }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(value);
    };

    const worker = new Worker(WORKER_FILE, {
      workerData: payload,
      // Reduced environment: NO application secrets reach the worker.
      env: { NODE_ENV: process.env.NODE_ENV === 'test' ? 'test' : 'production' },
      resourceLimits: {
        maxOldGenerationSizeMb: memoryMb,
        maxYoungGenerationSizeMb: Math.max(8, Math.floor(memoryMb / 4)),
        stackSizeMb: 4,
      },
    });

    const timer = setTimeout(() => finish({ ok: false, code: 'PARSER_TIMEOUT' }), timeoutMs);
    // Do not let the timer keep the process alive on its own.
    if (timer.unref) timer.unref();

    worker.once('message', (message) => finish(message));
    worker.once('error', () => finish({ ok: false, code: 'PARSER_ERROR' }));
    worker.once('exit', (code) => {
      if (code !== 0) finish({ ok: false, code: 'PARSER_ERROR' });
    });
  });
}

// Validates bytes. Returns { ok:true, result } or { ok:false, code, errorClass,
// error }. Throws only for saturation (503) so the caller can surface a retry.
async function validate(bytes, opts = {}) {
  const env = getEnv();
  const payload = {
    bytes,
    filename: opts.filename,
    declaredMediaType: opts.declaredMediaType,
    maxBytes: env.DOCUMENT_MAX_BYTES,
    stallMs: process.env.NODE_ENV === 'test' ? opts.stallMs : undefined,
  };

  await acquire();
  try {
    const outcome = await runWorker(payload, {
      timeoutMs: env.DOCUMENT_PARSER_TIMEOUT_MS,
      memoryMb: env.DOCUMENT_PARSER_MEMORY_MB,
    });
    if (outcome && outcome.ok) return { ok: true, result: outcome.result };
    const code = (outcome && outcome.code) || 'PARSER_ERROR';
    return { ok: false, code, errorClass: errorClass(code), error: safeError(code) };
  } finally {
    release();
  }
}

module.exports = {
  validate,
  safeError,
  errorClass,
  REJECTION_CODES,
  PRE_PERSIST_CODES,
  INCONCLUSIVE_CODES,
  SAFE_MESSAGES,
};
