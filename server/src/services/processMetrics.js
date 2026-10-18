'use strict';

// D-6: in-process operational gauges for /api/metrics.
//
// The workflow metrics answer "how is care coordination moving"; these answer
// "is this process healthy". Without them an operator can only watch the OS and
// proxy request timings, which is how the perf pass had to work.
//
// Everything here is bounded on purpose: a fixed latency bucket ladder and a
// fixed route table. An attacker cannot grow the map with random 404 URLs
// because only a matched Express route label is recorded, and the table stops
// at MAX_ROUTES. No request data, query string, or user identifier is kept.
const { monitorEventLoopDelay } = require('node:perf_hooks');

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

const STARTED_AT = Date.now();

// Upper bounds in milliseconds. Counts are cumulative per bucket.
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const MAX_ROUTES = 60;
const routes = new Map();

function labelFor(req) {
  // `req.route.path` is the pattern (`/:id`), never the concrete URL, so no
  // patient or episode identifier can leak into an operational surface.
  if (!req.route || !req.route.path) return null;
  const base = req.baseUrl || '';
  const path = req.route.path;
  // A router's own '/' route is the mounted path, not a trailing slash.
  const fullPath = path === '/' ? base || '/' : `${base}${path}`;
  return `${req.method} ${fullPath}`;
}

function record(req, res, durationMs) {
  const label = labelFor(req);
  if (!label) return;
  let entry = routes.get(label);
  if (!entry) {
    if (routes.size >= MAX_ROUTES) {
      // Keep the table bounded: the oldest label is dropped rather than letting
      // a deployment with many routes grow memory without limit.
      const oldest = routes.keys().next().value;
      if (oldest !== undefined) routes.delete(oldest);
    }
    entry = { label, count: 0, sumMs: 0, maxMs: 0, errors: 0, buckets: BUCKETS.map(() => 0) };
    routes.set(label, entry);
  }
  entry.count += 1;
  entry.sumMs += durationMs;
  entry.maxMs = Math.max(entry.maxMs, durationMs);
  if (res.statusCode >= 500) entry.errors += 1;
  const bucket = BUCKETS.findIndex((limit) => durationMs <= limit);
  entry.buckets[bucket === -1 ? BUCKETS.length - 1 : bucket] += 1;
}

function requestMetrics(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    record(req, res, durationMs);
  });
  next();
}

// Approximate p95 from the bucket ladder: the upper bound of the bucket that
// crosses 95 % of observations. Exact percentiles would need unbounded storage.
function approximateP95(entry) {
  const target = entry.count * 0.95;
  let seen = 0;
  for (let i = 0; i < entry.buckets.length; i += 1) {
    seen += entry.buckets[i];
    if (seen >= target) return BUCKETS[i];
  }
  return BUCKETS[BUCKETS.length - 1];
}

function mongoSnapshot() {
  let connection;
  try {
    // Required lazily: this module is also loaded by unit tests without a
    // database, and requiring mongoose twice is harmless.
    // eslint-disable-next-line global-require
    connection = require('mongoose').connection;
  } catch {
    return { state: 'unavailable', readyState: null, pool: null };
  }
  let pool = null;
  try {
    const driver = connection.client && connection.client.topology;
    const connectionPool = driver && driver.s && driver.s.pool;
    if (connectionPool) {
      pool = {
        total: connectionPool.totalConnectionCount ?? null,
        available: connectionPool.availableConnectionCount ?? null,
        checkedOut: connectionPool.currentCheckedOutCount ?? null,
        pending: connectionPool.pendingConnectionCount ?? null,
        waitQueue: connectionPool.waitQueueSize ?? null,
      };
    }
  } catch {
    pool = null;
  }
  const state = ['disconnected', 'connected', 'connecting', 'disconnecting'][connection.readyState] || 'unknown';
  return { state, readyState: connection.readyState, pool };
}

function snapshot() {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    process: {
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      nodeVersion: process.version,
      pid: process.pid,
    },
    eventLoop: {
      meanMs: Math.round((histogram.mean / 1e6) * 100) / 100,
      p95Ms: Math.round((histogram.percentile(95) / 1e6) * 100) / 100,
      p99Ms: Math.round((histogram.percentile(99) / 1e6) * 100) / 100,
      maxMs: Math.round((histogram.max / 1e6) * 100) / 100,
      resolutionMs: histogram.resolution / 1e6,
    },
    mongo: mongoSnapshot(),
    latency: {
      note: 'Approximate since process start, from bounded 5 ms-10 s buckets; route labels are patterns, never concrete URLs.',
      bucketsMs: BUCKETS,
      routes: [...routes.values()]
        .map((entry) => ({
          label: entry.label,
          count: entry.count,
          errorCount: entry.errors,
          averageMs: Math.round((entry.sumMs / entry.count) * 100) / 100,
          p95Ms: approximateP95(entry),
          maxMs: Math.round(entry.maxMs * 100) / 100,
        }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

// Test-only reset; the production surface is read-only.
function resetForTests() {
  routes.clear();
  histogram.reset();
}

module.exports = { requestMetrics, snapshot, resetForTests, BUCKETS };
