#!/usr/bin/env node
'use strict';

// Create, verify and prune ENCRYPTED backup sets (Phase A gate 4).
//
//   node scripts/backup.js                       # create a set in BACKUP_ROOT
//   node scripts/backup.js --dest /mnt/velora-backups
//   node scripts/backup.js --trigger schedule    # mark the run as scheduled
//   node scripts/backup.js --verify 20261019T101500Z
//   node scripts/backup.js --prune --retain 30
//
// A set is the four assets the operations runbook names. Keys and configuration
// are NOT stored in it: they belong in the owner's secret manager, and the
// manifest carries only their fingerprints.
//
// Exit codes: 0 success, 1 verification/backup failure, 2 refusal (missing key,
// destination inside the repository, unknown set).
const fs = require('node:fs');
const path = require('node:path');

const { loadEnv, getEnv } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const backup = require('../src/services/backupService');

const REPO_ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const args = {
    dest: null,
    retain: null,
    verify: null,
    prune: false,
    trigger: 'manual',
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dest') args.dest = argv[i + 1];
    else if (argv[i] === '--retain') args.retain = Number(argv[i + 1]);
    else if (argv[i] === '--verify') args.verify = argv[i + 1];
    else if (argv[i] === '--prune') args.prune = true;
    else if (argv[i] === '--trigger') args.trigger = argv[i + 1] === 'schedule' ? 'schedule' : 'manual';
    else if (argv[i] === '--json') args.json = true;
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
  const destinationRoot = backup.assertOutsideRepo(
    args.dest || env.BACKUP_ROOT || '',
    REPO_ROOT,
    'backup destination'
  );
  const key = backup.resolveKey(env);
  const retain = Number.isFinite(args.retain) && args.retain > 0 ? args.retain : env.BACKUP_RETAIN_SETS;

  if (args.verify) {
    const directory = fs.existsSync(args.verify)
      ? path.resolve(args.verify)
      : path.join(destinationRoot, backup.assertSetId(args.verify));
    const report = await backup.verifySet(directory, key);
    for (const check of report.checks) {
      process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} - ${check.detail}\n`);
    }
    process.stdout.write(`\nRESULT: ${report.ok ? 'PASSED' : 'FAILED'} (${report.manifest.setId})\n`);
    if (args.json) process.stdout.write(`${JSON.stringify(report.checks, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  if (args.prune) {
    const result = await backup.pruneSets(destinationRoot, retain);
    process.stdout.write(`kept ${result.kept.length} set(s): ${result.kept.join(', ') || 'none'}\n`);
    process.stdout.write(`deleted ${result.deleted.length} set(s): ${result.deleted.join(', ') || 'none'}\n`);
    for (const skipped of result.skipped) {
      process.stdout.write(`  skipped ${skipped.id} (${skipped.reason})\n`);
    }
    process.exit(0);
  }

  await connectDb(env.MONGODB_URI);
  const db = require('mongoose').connection.db;
  const startedAt = new Date();
  const setId = backup.setNow(startedAt);

  try {
    process.stdout.write(`Velora backup ${setId}\n  destination ${destinationRoot}\n`);
    const { manifest, directory, manifestPath } = await backup.createBackup({
      db,
      objectsRoot: path.join(env.DOCUMENT_STORAGE_ROOT, 'objects'),
      destinationRoot,
      key,
      keyFingerprints: backup.fingerprintsFor(env),
      now: startedAt,
      log: (line) => process.stdout.write(`${line}\n`),
    });

    // Read the set back immediately: a backup that cannot be verified is not a
    // backup, and finding that out now is cheaper than at restore time.
    const verification = await backup.verifySet(directory, key);
    for (const check of verification.checks) {
      process.stdout.write(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} - ${check.detail}\n`);
    }

    await backup.recordRun({
      setId,
      status: verification.ok ? 'complete' : 'failed',
      trigger: args.trigger,
      destination: destinationRoot,
      startedAt,
      finishedAt: new Date(),
      durationMs: manifest.durationMs,
      collections: manifest.mongo.collectionCount,
      documents: manifest.mongo.documents,
      objectCount: manifest.objects.count,
      objectBytes: manifest.objects.bytes,
      setBytes: fs.statSync(manifestPath).size,
      keyFingerprint: manifest.encryption.keyFingerprint,
      error: verification.ok ? null : 'set failed its own verification',
    }).catch((err) => {
      // The set exists either way; a history write failure must not turn a good
      // backup into a reported failure, but it must be visible.
      process.stderr.write(`warning: could not record the run: ${err.message}\n`);
    });

    const prune = await backup.pruneSets(destinationRoot, retain);
    if (prune.deleted.length) {
      process.stdout.write(`  pruned       ${prune.deleted.join(', ')}\n`);
    }

    process.stdout.write(
      `\nRESULT: ${verification.ok ? 'PASSED' : 'FAILED'} - ${manifest.mongo.documents} document(s), ` +
        `${manifest.objects.count} object(s), ${manifest.payloadBytes} bytes, ${manifest.durationMs} ms\n` +
        `  recovery point: ${manifest.startedAt} (start of this set)\n`
    );
    await disconnectDb();
    process.exit(verification.ok ? 0 : 1);
  } catch (err) {
    await backup
      .recordRun({
        setId,
        status: 'failed',
        trigger: args.trigger,
        destination: destinationRoot,
        startedAt,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt.getTime(),
        error: err.message,
      })
      .catch(() => {});
    await disconnectDb().catch(() => {});
    process.stderr.write(`backup failed: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`backup failed: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
