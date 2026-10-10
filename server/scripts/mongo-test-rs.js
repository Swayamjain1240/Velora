#!/usr/bin/env node
'use strict';

// Starts (or restarts) a single-node MongoDB replica set so the integration
// suite can use transactions. MongoDB only permits transactions on a replica
// set or mongos, and the Part 2+ invariants (invitation acceptance, assignment
// intervals, corrections) need them.
//
//   node scripts/mongo-test-rs.js          start (or reuse) on TEST_MONGO_PORT
//   node scripts/mongo-test-rs.js --stop   stop the instance this script started
//
// Configuration is by environment so it stays portable:
//   MONGOD_PATH         explicit path to the mongod binary
//   TEST_MONGO_PORT     default 27019
//   TEST_MONGO_REPLSET  default rs0
//   TEST_MONGO_DBPATH   default <repo>/.mongodb-test/rs0  (gitignored)
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MongoClient } = require('mongodb');

const PORT = Number(process.env.TEST_MONGO_PORT || 27019);
const REPL_SET = process.env.TEST_MONGO_REPLSET || 'rs0';
const DATA_DIR =
  process.env.TEST_MONGO_DBPATH || path.resolve(__dirname, '../../.mongodb-test/rs0');
const LOG_FILE = path.resolve(__dirname, '../../.mongodb-test/mongod.log');
const PID_FILE = path.resolve(__dirname, '../../.mongodb-test/mongod.pid');
const URI = `mongodb://127.0.0.1:${PORT}/velora_test?replicaSet=${REPL_SET}`;

function log(message) {
  process.stdout.write(`[test-rs] ${message}\n`);
}

function pickHighest(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => path.join(dir, name, 'bin', 'mongod.exe'))
    .filter((p) => fs.existsSync(p))
    .sort()
    .reverse();
}

function findMongod() {
  if (process.env.MONGOD_PATH && fs.existsSync(process.env.MONGOD_PATH)) {
    return process.env.MONGOD_PATH;
  }
  const candidates = [
    ...(process.platform === 'win32'
      ? pickHighest('C:/Program Files/MongoDB/Server')
      : []),
    'mongod',
    '/usr/bin/mongod',
    '/usr/local/bin/mongod',
    '/opt/homebrew/bin/mongod',
  ];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) return candidate; // PATH resolution
    if (fs.existsSync(candidate)) return candidate;
  }
  // Last resort: rely on PATH and let the spawn report a clear error.
  return 'mongod';
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1500, () => { socket.destroy(); resolve(false); });
  });
}

async function initiate() {
  const client = new MongoClient(`mongodb://127.0.0.1:${PORT}/?directConnection=true`, {
    serverSelectionTimeoutMS: 15000,
  });
  await client.connect();
  const admin = client.db('admin');
  try {
    const status = await admin.command({ replSetGetStatus: 1 });
    log(`replica set already initiated (${status.members[0].stateStr})`);
  } catch {
    await admin.command({
      replSetInitiate: { _id: REPL_SET, members: [{ _id: 0, host: `127.0.0.1:${PORT}` }] },
    });
    log('replSetInitiate issued');
  }
  await client.close();
}

async function waitForPrimary(timeoutMs = 30000) {
  const client = new MongoClient(URI, { serverSelectionTimeoutMS: timeoutMs });
  await client.connect();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await client.db('admin').command({ replSetGetStatus: 1 }).catch(() => null);
    if (status && status.members.some((m) => m.stateStr === 'PRIMARY')) break;
    if (Date.now() > deadline) throw new Error('replica set never reached PRIMARY');
    await new Promise((r) => setTimeout(r, 500));
  }
  const session = client.startSession();
  await session.withTransaction(async () => {
    await client.db('velora_preflight').collection('t').insertOne({ ok: 1 }, { session });
  });
  await client.db('velora_preflight').dropDatabase();
  await session.endSession();
  await client.close();
  log('PRIMARY ready, transactions verified');
}

function stop() {
  if (!fs.existsSync(PID_FILE)) {
    log('no pidfile; nothing to stop');
    return;
  }
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  try {
    process.kill(pid);
    log(`stopped pid ${pid}`);
  } catch (err) {
    log(`could not stop pid ${pid}: ${err.message}`);
  }
  fs.rmSync(PID_FILE, { force: true });
}

async function main() {
  if (process.argv.includes('--stop')) return stop();

  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (await isListening(PORT)) {
    log(`mongod already listening on ${PORT}`);
  } else {
    const mongod = findMongod();
    const child = spawn(
      mongod,
      ['--replSet', REPL_SET, '--port', String(PORT), '--dbpath', DATA_DIR, '--bind_ip', '127.0.0.1'],
      { detached: true, stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')] }
    );
    child.unref();
    fs.writeFileSync(PID_FILE, String(child.pid));
    log(`started mongod (${mongod}) pid ${child.pid} on port ${PORT}`);
    const deadline = Date.now() + 30000;
    while (!(await isListening(PORT))) {
      if (Date.now() > deadline) throw new Error(`mongod never opened port ${PORT}; see ${LOG_FILE}`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  await initiate();
  await waitForPrimary();
  log(`MONGODB_TEST_URI=${URI}`);
}

main().catch((err) => {
  process.stderr.write(`[test-rs] failed: ${err.message}\n`);
  process.exit(1);
});
