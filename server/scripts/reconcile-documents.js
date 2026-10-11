#!/usr/bin/env node
'use strict';

// Document reconciliation.
//
// MongoDB metadata and the encrypted object store are NOT one transaction, so
// they can drift (a crash between the metadata insert and the object write, a
// manual file change, a partial restore). This command reports the drift, and -
// only with an EXPLICIT operator attribution - repairs it.
//
//   node scripts/reconcile-documents.js                       # dry run (default)
//   node scripts/reconcile-documents.js --apply --operator you@clinic.example
//
// `--apply` never runs without `--operator`: every repair is attributed and
// audited. Backups must treat MongoDB metadata, the encrypted objects AND the
// document key as ONE set; restoring only some of them produces drift that this
// command will then report.
const crypto = require('node:crypto');
const { loadEnv, getEnv } = require('../src/config/env');
const { connectDb, disconnectDb } = require('../src/config/db');
const EpisodeDocument = require('../src/models/EpisodeDocument');
const storage = require('../src/services/documentStorage');
const audit = require('../src/services/auditService');

function parseArgs(argv) {
  const args = { apply: false, operator: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--operator') args.operator = argv[i + 1];
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply && !args.operator) {
    process.stderr.write('refused: --apply requires --operator <email>\n');
    process.exit(2);
  }

  loadEnv();
  await connectDb(getEnv().MONGODB_URI);

  const live = await EpisodeDocument.find({
    status: { $in: ['uploading', 'ready', 'quarantined'] },
  }).lean();
  const objectKeys = new Set(await storage.listKeys());
  const referenced = new Set(live.map((d) => d.storageKey));

  const missing = [];
  const unreadable = [];
  const integrity = [];

  for (const doc of live) {
    if (!objectKeys.has(doc.storageKey)) {
      missing.push(doc);
      continue;
    }
    if (doc.status === 'ready') {
      try {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await storage.get(doc.storageKey);
        if (bytes.length !== doc.byteSize || sha256(bytes) !== doc.sha256) integrity.push(doc);
      } catch {
        unreadable.push(doc);
      }
    }
  }

  const orphans = [...objectKeys].filter((key) => !referenced.has(key));

  process.stdout.write('Document reconciliation report\n');
  process.stdout.write(`  metadata rows (live):   ${live.length}\n`);
  process.stdout.write(`  stored objects:         ${objectKeys.size}\n`);
  process.stdout.write(`  missing objects:        ${missing.length}\n`);
  process.stdout.write(`  unreadable objects:     ${unreadable.length}\n`);
  process.stdout.write(`  integrity mismatches:   ${integrity.length}\n`);
  process.stdout.write(`  orphan objects:         ${orphans.length}\n`);
  for (const doc of missing) {
    process.stdout.write(`    missing: ${doc._id} (${doc.status}) key ${doc.storageKey}\n`);
  }
  for (const doc of integrity) process.stdout.write(`    integrity: ${doc._id}\n`);
  for (const doc of unreadable) process.stdout.write(`    unreadable: ${doc._id}\n`);
  for (const key of orphans) process.stdout.write(`    orphan: ${key}\n`);

  if (!args.apply) {
    process.stdout.write('\nDRY RUN: nothing changed. Re-run with --apply --operator <email> to repair.\n');
    await disconnectDb();
    return;
  }

  let repaired = 0;
  for (const doc of [...missing, ...unreadable, ...integrity]) {
    // eslint-disable-next-line no-await-in-loop
    await EpisodeDocument.updateOne({ _id: doc._id }, { $set: { status: 'failed' } });
    // eslint-disable-next-line no-await-in-loop
    await audit.record({
      clinic: doc.clinic,
      actorLabel: args.operator,
      action: 'document.reconciled.failed',
      targetType: 'episode_document',
      targetId: String(doc._id),
      outcome: 'success',
      detail: { reason: 'missing-or-unreadable-object' },
    });
    repaired += 1;
  }
  for (const key of orphans) {
    // eslint-disable-next-line no-await-in-loop
    await storage.remove(key);
    // eslint-disable-next-line no-await-in-loop
    await audit.record({
      actorLabel: args.operator,
      action: 'document.reconciled.orphan-removed',
      targetType: 'episode_document',
      targetId: key,
      outcome: 'success',
      detail: {},
    });
    repaired += 1;
  }

  process.stdout.write(`\nAPPLIED by ${args.operator}: ${repaired} repair(s), all audited.\n`);
  await disconnectDb();
}

main().catch(async (err) => {
  process.stderr.write(`reconcile failed: ${err.message}\n`);
  try {
    await disconnectDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
