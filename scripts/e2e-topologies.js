#!/usr/bin/env node
'use strict';

/**
 * The deterministic browser gate.
 *
 * Velora's extraction journeys need TWO API topologies, and they cannot share
 * one process:
 *
 *   fake — the local deterministic provider, which every AI-journey spec needs;
 *   none — the shipped default (no provider), where the extraction screen must
 *          fail closed and drafting by hand must still work.
 *
 * Running the whole suite against a single API makes the provider-disabled
 * journey either skip (hiding the assertion) or fail (it is asserting the other
 * topology). This script runs each topology against the API it belongs to and
 * returns exit code 0 only when BOTH pass:
 *
 *   npm run test:e2e:fake   fake-provider journeys only
 *   npm run test:e2e:none   the provider-disabled journey only
 *   npm run test:e2e:all    both, in order  (the merge gate)
 *
 * It owns every process it starts (MongoDB is reused if already running) and
 * never touches a port that something else is holding. Node's child_process is
 * used directly - no shell, no `&`, no `kill` builtins - so the same script runs
 * on Windows, macOS and Linux.
 *
 * Configuration (all optional):
 *   E2E_API_PORT          default 4100
 *   E2E_CLIENT_PORT       default 5173
 *   E2E_MONGODB_URI       default mongodb://127.0.0.1:<TEST_MONGO_PORT>/velora_e2e?replicaSet=rs0
 *   TEST_MONGO_PORT       default 27019 (the replica set `npm run mongo:test-rs` uses)
 *   E2E_PROJECTS          forwarded to playwright.config.js (chromium by default)
 *
 * Secrets come from the workspace .env when present; the fallbacks below are
 * disposable test values that only ever protect synthetic data.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_DIR = path.join(ROOT, 'server');
const LOG_DIR = path.join(os.tmpdir(), 'velora-e2e-logs');

const MODES = ['fake', 'none'];
const requested = (process.argv[2] || 'all').toLowerCase();
const selected = requested === 'all' ? MODES : [requested];

const API_PORT = Number(process.env.E2E_API_PORT || 4100);
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT || 5173);
const MONGO_PORT = Number(process.env.TEST_MONGO_PORT || 27019);
const REPL_SET = process.env.TEST_MONGO_REPLSET || 'rs0';
// CI already runs its own replica set, so it sets E2E_MONGODB_URI explicitly
// rather than relying on the local port below.
const MONGODB_URI =
  process.env.E2E_MONGODB_URI ||
  `mongodb://127.0.0.1:${MONGO_PORT}/velora_e2e?replicaSet=${REPL_SET}`;

const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const CLIENT_ORIGIN = `http://localhost:${CLIENT_PORT}`;

// The provider-disabled journey is the one test that asserts the OTHER topology.
const PROVIDER_JOURNEY = 'no provider enabled';

if (!['fake', 'none', 'all'].includes(requested)) {
  console.error(`[e2e] unknown topology "${requested}" (expected fake, none or all)`);
  process.exit(2);
}

// ---------------------------------------------------------------- environment

// Minimal .env reader: names and non-secret values only, never printed. An
// exported variable always wins, exactly like dotenv in the server.
function readDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const out = {};
    for (const line of raw.split(/\r?\n/)) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (match && out[match[1]] === undefined) out[match[1]] = match[2];
    }
    return out;
  } catch {
    return {};
  }
}

const dotEnv = readDotEnv();

function pick(name, fallback) {
  const exported = process.env[name];
  if (exported !== undefined && exported !== '') return exported;
  const fromFile = dotEnv[name];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return fallback;
}

// Test-only fallbacks. They are never used in production: NODE_ENV=test here.
const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: String(API_PORT),
  MONGODB_URI,
  CLIENT_ORIGIN,
  SESSION_PEPPER: pick('SESSION_PEPPER', 'localdev_session_pepper_0123456789abcdef'),
  SESSION_TTL_HOURS: pick('SESSION_TTL_HOURS', '12'),
  MFA_ENCRYPTION_KEY: pick('MFA_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64')),
  DOCUMENT_ENCRYPTION_KEY: pick(
    'DOCUMENT_ENCRYPTION_KEY',
    Buffer.alloc(32, 5).toString('base64')
  ),
  // A DEDICATED root, not the developer's `.env` one. The browser gate reseeds
  // and re-uploads documents on every run; sharing a root with the development
  // database leaves orphan objects behind and makes `documents:reconcile`
  // report drift that is really test residue. Isolation keeps both stores
  // reconcilable on their own.
  DOCUMENT_STORAGE_ROOT:
    process.env.E2E_DOCUMENT_STORAGE_ROOT || path.join(os.tmpdir(), 'velora-documents-e2e'),
  // Nothing in this script may reach a real provider or a real network.
  NOTIFICATION_PROVIDER: 'fake',
  TRUST_PROXY: 'false',
};

function envFor(mode) {
  return {
    ...process.env,
    ...BASE_ENV,
    EXTRACTION_PROVIDER: mode,
    // The Playwright process and the seed read the same values.
    E2E_BASE_URL: CLIENT_ORIGIN,
    E2E_API_URL: API_ORIGIN,
    VITE_API_PROXY: API_ORIGIN,
  };
}

// -------------------------------------------------------------------- helpers

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1500, () => finish(false));
  });
}

async function waitFor(check, { timeoutMs = 60_000, intervalMs = 400, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${label} did not become ready in ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

async function httpOk(url) {
  const res = await fetch(url);
  return res.ok;
}

async function waitForPort(port, { free, timeoutMs = 20_000, label }) {
  await waitFor(
    async () => ((await isListening(port)) === !free ? true : false),
    { timeoutMs, intervalMs: 250, label: label || `port ${port}` }
  );
}

function startProcess(name, args, options) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const logPath = path.join(LOG_DIR, `${name}.log`);
  const out = fs.openSync(logPath, 'w');
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', out, out],
  });
  child.__name = name;
  child.__logPath = logPath;
  child.__stdio = out;
  return child;
}

// Terminates a child and everything it spawned. On Windows `taskkill /T` is the
// only reliable way to take down a process tree; elsewhere SIGTERM then SIGKILL.
function stopProcess(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      if (child && child.__stdio !== undefined) {
        try {
          fs.closeSync(child.__stdio);
        } catch {
          /* already closed */
        }
      }
      resolve();
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        fs.closeSync(child.__stdio);
      } catch {
        /* already closed */
      }
      resolve();
    };
    child.once('exit', finish);
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 5_000).unref();
    }
    setTimeout(finish, 12_000).unref();
  });
}

function tailLog(child, lines = 25) {
  try {
    const content = fs.readFileSync(child.__logPath, 'utf8').trimEnd().split(/\r?\n/);
    return [
      `[e2e] last ${Math.min(lines, content.length)} line(s) of ${child.__logPath}:`,
      ...content.slice(-lines).map((line) => `    ${line}`),
    ].join('\n');
  } catch {
    return `[e2e] no log at ${child.__logPath}`;
  }
}

const children = new Set();
let shuttingDown = false;

async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) await stopProcess(child);
  children.clear();
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received - cleaning up`);
    shutdown(130);
  });
}

// ------------------------------------------------------------------- the gate

// The API writes inside transactions, so the URI must resolve to a PRIMARY.
async function mongoReachable() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const hello = await client.db('admin').command({ hello: 1 });
    return hello.isWritablePrimary === true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

async function ensureMongo() {
  if (await mongoReachable()) {
    log(`MongoDB replica set ready at ${MONGODB_URI}`);
    return;
  }

  // Locally the replica set is a one-command install step; CI starts its own, so
  // reaching this branch there means the service is genuinely down.
  log(`MongoDB is not ready at ${MONGODB_URI}; starting the local replica set on ${MONGO_PORT}`);
  spawnSync(process.execPath, ['scripts/mongo-test-rs.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, TEST_MONGO_PORT: String(MONGO_PORT), TEST_MONGO_REPLSET: REPL_SET },
    stdio: 'inherit',
  });

  await waitFor(mongoReachable, { timeoutMs: 45_000, label: 'MongoDB replica set' }).catch(() => {
    throw new Error(
      `MongoDB is unreachable at ${MONGODB_URI}; start it with: npm run mongo:test-rs -w server`
    );
  });
}

async function ensurePortFree(port, label) {
  if (await isListening(port)) {
    throw new Error(
      `${label} port ${port} is already in use. This gate owns the stack and will not ` +
        'reuse or kill an unknown process; stop it first (npm run dev, or a stale API/client).'
    );
  }
}

async function startClient() {
  const viteBin = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  const child = startProcess(
    'client',
    [
      viteBin,
      '--port',
      String(CLIENT_PORT),
      '--host',
      '127.0.0.1',
      '--strictPort',
      '--config',
      path.join(ROOT, 'client', 'vite.config.js'),
      path.join(ROOT, 'client'),
    ],
    { cwd: ROOT, env: envFor('fake') }
  );
  children.add(child);

  try {
    await waitFor(() => httpOk(`${CLIENT_ORIGIN}/`), {
      timeoutMs: 90_000,
      label: `Vite client on ${CLIENT_PORT}`,
    });
  } catch (error) {
    throw new Error(`${error.message}\n${tailLog(child)}`);
  }
  log(`client ready at ${CLIENT_ORIGIN}`);
}

async function startApi(mode) {
  const child = startProcess('api-' + mode, [path.join('server', 'src', 'index.js')], {
    cwd: ROOT,
    env: envFor(mode),
  });
  children.add(child);

  try {
    await waitFor(
      async () => {
        const res = await fetch(`${API_ORIGIN}/api/health`);
        if (!res.ok) return false;
        const body = await res.json();
        return body.ok === true;
      },
      { timeoutMs: 90_000, label: `API (EXTRACTION_PROVIDER=${mode}) on ${API_PORT}` }
    );
  } catch (error) {
    throw new Error(`${error.message}\n${tailLog(child)}`);
  }
  log(`API ready with EXTRACTION_PROVIDER=${mode}`);
  return child;
}

function seed() {
  const result = spawnSync(process.execPath, ['scripts/seed.js'], {
    cwd: SERVER_DIR,
    env: envFor('fake'),
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('synthetic seed failed (see output above)');
}

function runPlaywright(args, mode) {
  const cli = require.resolve('@playwright/test/cli');
  log(`playwright ${args.join(' ')}  (EXTRACTION_PROVIDER=${mode})`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'test', ...args], {
      cwd: ROOT,
      env: envFor(mode),
      stdio: 'inherit',
    });
    child.once('exit', (code, signal) => resolve(code === null ? (signal ? 1 : 0) : code));
  });
}

async function runTopology(mode) {
  log(`--- topology ${mode} -------------------------------------------------`);
  await ensurePortFree(API_PORT, 'API');
  seed();

  const api = await startApi(mode);
  let code = 1;
  try {
    if (mode === 'fake') {
      // Every journey that needs deterministic local extraction. The
      // provider-disabled journey is excluded, not skipped: it belongs to the
      // other topology and running it here would assert the wrong API.
      code = await runPlaywright(['--grep-invert', PROVIDER_JOURNEY], mode);
    } else {
      code = await runPlaywright(['e2e/extractions.spec.js', '--grep', PROVIDER_JOURNEY], mode);
    }
  } finally {
    await stopProcess(api);
    children.delete(api);
    await waitForPort(API_PORT, { free: true, label: `API port ${API_PORT} to be released` });
  }

  return code === 0;
}

async function main() {
  await ensureMongo();
  await ensurePortFree(CLIENT_PORT, 'client');

  const results = {};
  await startClient();
  try {
    for (const mode of selected) {
      results[mode] = await runTopology(mode);
      if (!results[mode] && requested === 'all') {
        // Still report both? No: a failed topology stops the gate, but the
        // remaining one is reported as NOT RUN rather than silently omitted.
        for (const other of MODES.filter((m) => !(m in results))) results[other] = null;
        break;
      }
    }
  } finally {
    for (const child of [...children]) {
      await stopProcess(child);
      children.delete(child);
    }
  }

  log('--- summary ----------------------------------------------------------');
  for (const mode of MODES) {
    if (!(mode in results)) continue;
    const value = results[mode];
    log(
      `${mode === 'fake' ? 'Fake-provider' : 'Provider-disabled'} E2E suite: ` +
        (value === null ? 'NOT RUN' : value ? 'PASSED' : 'FAILED')
    );
  }
  const ran = Object.values(results).filter((value) => value !== null);
  const passed = ran.length === selected.length && ran.every(Boolean);
  log(`Combined E2E gate: ${passed ? 'PASSED' : 'FAILED'} (exit ${passed ? 0 : 1})`);

  // Every spawned process is gone before the exit code is decided.
  for (const child of [...children]) await stopProcess(child);
  process.exit(passed ? 0 : 1);
}

main().catch(async (error) => {
  process.stderr.write(`[e2e] ${error.message}\n`);
  await shutdown(1);
});
