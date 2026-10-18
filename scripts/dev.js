#!/usr/bin/env node
/**
 * One-command development stack: `npm run dev`.
 *
 * Starts the Express API (server workspace) and the Vite client together,
 * prefixes their output, and shuts both down if either one exits or the user
 * presses Ctrl+C. Replaces the old `&`-backgrounded script, which orphaned the
 * API on Windows and hid half the logs.
 */
'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!existsSync(path.join(root, '.env'))) {
  console.error(
    '\n[dev] .env is missing. Create one before starting the stack:\n\n' +
      '  cp .env.example .env\n' +
      '  npm run gen:env          # fills in SESSION_PEPPER and the MFA key\n\n' +
      '[dev] MongoDB must also be a replica set: npm run mongo:test-rs -w server\n'
  );
  process.exit(1);
}

const targets = [
  { name: 'api', color: '\x1b[36m', args: ['run', 'dev', '-w', 'server'] },
  { name: 'web', color: '\x1b[35m', args: ['run', 'dev', '-w', 'client'] },
];

// An inherited PORT would override .env (dotenv never overrides existing vars),
// and an unusable one (0, a name, an empty string) crashes the API with a
// confusing "Check: PORT" error. Clear it so the value in .env applies.
if (process.env.PORT !== undefined) {
  const n = Number(process.env.PORT);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(`[dev] ignoring inherited PORT="${process.env.PORT}" (not a valid port); using .env`);
    delete process.env.PORT;
  }
}

const children = [];
let shuttingDown = false;

function prefixed(target, chunk) {
  const tag = `${target.color}[${target.name}]\x1b[0m`;
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim() !== '') process.stdout.write(`${tag} ${line}\n`);
  }
}

for (const target of targets) {
  const child = spawn(npm, target.args, { cwd: root, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => prefixed(target, d));
  child.stderr.on('data', (d) => prefixed(target, d));
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`\n[dev] ${target.name} exited with code ${code ?? 'null'}; stopping the stack.`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

console.log('[dev] API on http://localhost:4000  ·  client on http://localhost:5173  ·  Ctrl+C stops both');
