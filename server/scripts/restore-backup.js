#!/usr/bin/env node
'use strict';

// Restore an ENCRYPTED backup SET into an isolated database and objects root.
//
//   node scripts/restore-backup.js --set 20261019T101500Z \
//     --target mongodb://127.0.0.1:27019/velora_restored?replicaSet=rs0 \
//     --objects-root /srv/velora-restored
//
//   --force                 replace a target database that already holds rows
//   --allow-live-objects    permit writing into DOCUMENT_STORAGE_ROOT
//
// The set's own manifest is the specification: rows, index options and object
// bytes are restored from it, then the target is counted and re-digested before
// the command claims success. It refuses to target the application database and
// refuses a set whose key fingerprint does not match the configured key.
//
// Exit codes: 0 restored and verified, 1 a check failed, 2 refusal.
const fs = require('node:fs');
const path = require('node:path');

const { loadEnv, getEnv } = require('../src/config/env');
const backup = require('../src/services/backupService');

const REPO_ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = {
    set: null,
    target: null,
    objectsRoot: null,
    force: false,
    allowLiveObjects: false,
    dest: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--set') args.set = argv[i + 1];
    else if (argv[i] === '--target') args.target = argv[i + 1];
    else if (argv[i] === '--objects-root') args.objectsRoot = argv[i + 1];
    else if (argv[i] === '--dest') args.dest = argv[i + 1];
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--allow-live-objects') args.allowLiveObjects = true;
  }
  return args;
}

function refuse(message) {
  process.stderr.write(`refused: ${message}\n`);
  process.exit(2);
}

async function main() {
  loadEnv();
  const env = getEnv();
  const args = parseArgs(process.argv.slice(2));
  if (!args.set) refuse('--set <directory or set id> is required');
  if (!args.target) refuse('--target <mongodb uri> is required');
  if (!args.objectsRoot) refuse('--objects-root <absolute path> is required');

  const destinationRoot = backup.assertOutsideRepo(
    args.dest || env.BACKUP_ROOT || path.dirname(path.resolve(args.set)),
    REPO_ROOT,
    'backup destination'
  );
  const directory = fs.existsSync(args.set)
    ? path.resolve(args.set)
    : path.join(destinationRoot, backup.assertSetId(args.set));
  const objectsRoot = backup.assertOutsideRepo(args.objectsRoot, REPO_ROOT, 'objects root');

  if (
    !args.allowLiveObjects &&
    env.DOCUMENT_STORAGE_ROOT &&
    path.resolve(env.DOCUMENT_STORAGE_ROOT) === objectsRoot
  ) {
    refuse(
      'the objects root is the LIVE document store; restore somewhere else first, or pass --allow-live-objects deliberately'
    );
  }

  const key = backup.resolveKey(env);
  process.stdout.write(`Velora restore from ${path.basename(directory)}\n`);

  const result = await backup.restoreSet({
    directory,
    targetUri: args.target,
    objectsRoot,
    key,
    env,
    force: args.force,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  process.stdout.write(
    `  ${result.rowMismatches === 0 ? 'PASS' : 'FAIL'}  rows match the manifest - ` +
      `${result.documents} document(s), ${result.rowMismatches} collection mismatch(es)\n`
  );
  process.stdout.write(
    `  ${result.objectsOk ? 'PASS' : 'FAIL'}  objects match the manifest - ${result.objects} file(s)\n`
  );
  process.stdout.write(
    `\nRESULT: ${result.ok ? 'PASSED' : 'FAILED'} into ${result.targetDatabase}\n` +
      `  recovery point: ${result.recoveryPoint}\n` +
      `  observed restore time: ${result.timings.totalMs} ms ` +
      `(rows ${result.timings.mongoMs} ms, objects ${result.timings.objectsMs} ms)\n` +
      '  NOT proved by a restore: the deployment configuration and keys (restore them from the secret ' +
      'manager) and provider-level durability.\n'
  );
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`restore failed: ${err.message}\n`);
    process.exit(err.code === 'RESTORE_TARGET_REFUSED' || err.code === 'RESTORE_TARGET_NOT_EMPTY' ? 2 : 1);
  });
}

module.exports = { parseArgs };
