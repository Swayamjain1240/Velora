'use strict';

// Structured logging with redaction (Part 10, controls #9 and #12).
//
// Two rules make this safe to use anywhere in the server:
//
//   1. A log line is a JSON object with a NAMED event. Free text never carries
//      clinical content or a credential, because only the values passed by the
//      caller are written and sensitive keys are replaced before serialisation.
//   2. Redaction is applied to the whole field tree, including nested objects and
//      error properties, so `logger.error('x', { err })` cannot leak a token that
//      happened to be hanging off an error object.
//
// No dependency is added for this: it is a few dozen lines over console.log and
// is fully unit-testable (control #14 - remove/avoid unnecessary packages).

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const REDACTED = '[redacted]';
// Key names that must never reach a log line, whatever they contain.
const SENSITIVE_KEY =
  /(pass|passwd|password|secret|token|pepper|credential|authorization|cookie|apikey|api_key|private|otp|totp|recovery|mfa|signature|hash|key)/i;
const MAX_DEPTH = 4;
const MAX_STRING = 512;
const MAX_ARRAY = 20;

function redactValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return '[too-deep]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) => redactValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    // Errors: keep the name, the message and the code. Stack traces are
    // diagnostics, never a payload, and are only kept outside production.
    if (value instanceof Error) {
      const out = {
        name: value.name,
        message: redactValue(value.message, depth + 1),
      };
      if (value.code !== undefined) out.code = value.code;
      if (process.env.NODE_ENV !== 'production' && value.stack) out.stack = value.stack;
      // An error often carries its own enumerable context (a provider response,
      // a request id). Dropping it would hide real diagnostics, so it is kept -
      // but redacted field by field, exactly like any other object.
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'name' || key === 'message' || key === 'stack') continue;
        out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(entry, depth + 1);
      }
      return out;
    }
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(entry, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

// Field values whose key is sensitive are replaced even at the top level.
function redact(fields) {
  return redactValue(fields || {});
}

function createLogger({ level = 'info', sink } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = sink || ((line) => process.stdout.write(`${line}\n`));

  function logAt(levelName, event, fields) {
    if (LEVELS[levelName] < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: levelName,
      event: String(event),
      ...redact(fields),
    };
    try {
      write(JSON.stringify(record));
    } catch {
      // A logger must never take the process down.
      write(JSON.stringify({ ts: record.ts, level: levelName, event: 'log.serialize_failed' }));
    }
  }

  const logger = {
    level,
    debug: (event, fields) => logAt('debug', event, fields),
    info: (event, fields) => logAt('info', event, fields),
    warn: (event, fields) => logAt('warn', event, fields),
    error: (event, fields) => logAt('error', event, fields),
    // A child carries constant context (service name, request id) so every line
    // from one request can be correlated without the caller repeating itself.
    child(bindings) {
      const childLogger = createLogger({ level, sink: write });
      for (const name of Object.keys(LEVELS)) {
        childLogger[name] = (event, fields) => logAt(name, event, { ...bindings, ...fields });
      }
      return childLogger;
    },
  };
  return logger;
}

// Process-wide logger built from the validated environment. The environment is
// loaded lazily so importing this module can never fail startup.
let rootLogger = null;

function getLogger() {
  if (rootLogger) return rootLogger;
  let level = 'info';
  try {
    // eslint-disable-next-line global-require
    level = require('../config/env').getEnv().LOG_LEVEL;
  } catch {
    level = 'info';
  }
  rootLogger = createLogger({ level });
  return rootLogger;
}

function resetLogger() {
  rootLogger = null;
}

module.exports = { createLogger, getLogger, resetLogger, redact, LEVELS, REDACTED };
