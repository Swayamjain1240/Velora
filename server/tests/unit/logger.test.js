'use strict';

// Part 10: the structured logger must never become a leak or a hazard.
//
// The assertions this file turns on: level filtering is exact, sensitive keys are
// redacted at every depth (including on Error objects), long values are bounded,
// a child logger carries its bindings on every line, and no input - however
// circular or exotic - can make logging throw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, redact, REDACTED } = require('../../src/services/logger');

function capture(level) {
  const lines = [];
  const logger = createLogger({
    level,
    sink: (line) => lines.push(JSON.parse(line)),
  });
  return { logger, lines };
}

test('the level threshold filters exactly: info is hidden at warn, warn and error are not', () => {
  const { logger, lines } = capture('warn');
  logger.debug('a.debug');
  logger.info('b.info');
  logger.warn('c.warn', { n: 1 });
  logger.error('d.error', { n: 2 });

  assert.deepEqual(
    lines.map((line) => line.event),
    ['c.warn', 'd.error']
  );
});

test('every line carries a timestamp, a level and a named event', () => {
  const { logger, lines } = capture('debug');
  logger.debug('some.event');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'debug');
  assert.equal(lines[0].event, 'some.event');
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('sensitive keys are redacted at every depth, including inside Error objects', () => {
  const { logger, lines } = capture('info');
  const err = Object.assign(new Error('provider rejected the request'), {
    apiKey: 'sk-live-should-never-appear',
    response: { authorization: 'Bearer abc.def.ghi', status: 502 },
  });

  logger.error('provider.failed', {
    err,
    sessionToken: 'token-should-never-appear',
    nested: { privacyKey: 'key-should-never-appear', patientId: 'p-1' },
  });

  const serialised = JSON.stringify(lines);
  assert.ok(!serialised.includes('should-never-appear'), serialised);
  assert.ok(!serialised.includes('Bearer abc.def.ghi'), serialised);
  assert.equal(lines[0].sessionToken, REDACTED);
  assert.equal(lines[0].nested.privacyKey, REDACTED);
  // Non-sensitive context survives: a log line that redacts everything is
  // useless for diagnosis.
  assert.equal(lines[0].nested.patientId, 'p-1');
  assert.equal(lines[0].err.message, 'provider rejected the request');
  assert.equal(lines[0].err.apiKey, REDACTED);
  assert.equal(lines[0].err.response.authorization, REDACTED);
  assert.equal(lines[0].err.response.status, 502);
});

test('no stack trace is written to a production log line', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const redacted = redact({ err: new Error('boom') });
    assert.equal(redacted.err.stack, undefined);
    assert.equal(redacted.err.message, 'boom');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('long strings are bounded and arrays are capped', () => {
  const { logger, lines } = capture('info');
  logger.info('big.payload', {
    blob: 'x'.repeat(5000),
    rows: Array.from({ length: 100 }, (_, index) => index),
  });
  assert.ok(lines[0].blob.length < 600, String(lines[0].blob.length));
  assert.match(lines[0].blob, /truncated/);
  assert.equal(lines[0].rows.length, 20);
});

test('a child logger stamps its bindings on every line', () => {
  const { logger, lines } = capture('info');
  const child = logger.child({ requestId: 'req-1', route: '/api/health' });
  child.info('one');
  child.warn('two', { extra: true });

  assert.equal(lines[0].requestId, 'req-1');
  assert.equal(lines[1].requestId, 'req-1');
  assert.equal(lines[1].route, '/api/health');
  assert.equal(lines[1].extra, true);
});

test('a circular or exotic value can never make logging throw', () => {
  const { logger, lines } = capture('info');
  const circular = { name: 'root' };
  circular.self = circular;
  circular.big = 10n;

  assert.doesNotThrow(() =>
    logger.info('circular', { circular, fn: () => {}, sym: Symbol('s') })
  );
  assert.equal(lines.length, 1);
  // Recursion is bounded by DEPTH rather than by detecting the cycle: the value
  // is rendered a few levels deep and then replaced, so the line stays small.
  const rendered = JSON.stringify(lines[0].circular);
  assert.match(rendered, /\[too-deep\]/);
  assert.ok(rendered.length < 400, `cycle must be bounded, got ${rendered.length} chars`);
  assert.equal(lines[0].circular.big, 10);
});
