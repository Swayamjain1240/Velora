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
//   node scripts/reconcile-documents.js --json                # machine-readable report
//   node scripts/reconcile-documents.js --apply --operator you@clinic.example
//
// `--apply` never runs without `--operator`: every repair is attributed and
// audited, and a refusal is a non-zero exit rather than a silent no-op.
//
// The logic lives in `reconcile()` so the integration suite can drive it against
// a real replica set and a disposable storage root; the command-line wrapper only
// handles environment, connection, printing and exit codes. Backups must treat
// MongoDB metadata, the encrypted objects AND the document key as ONE set:
// restoring only some of them produces exactly the drift this command reports.
const crypto = require('node:crypto');

function parseArgs(argv) {
  const args = { apply: false, operator: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--operator') args.operator = argv[i + 1];
    else if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Reports (and, with an operator, repairs) drift between metadata and objects.
// Returns a structured report; it never deletes a metadata row, and it never
// touches a document whose object is intact.
async function reconcile({ apply = false, operator = null, log = null } = {}) {
  if (apply && !operator) {
    const err = new Error('refusing to apply without --operator <email>');
    err.code = 'OPERATOR_REQUIRED';
    throw err;
  }

  // Required late so the module can be imported by tests without side effects.
  /* eslint-disable global-require */
  const EpisodeDocument = require('../src/models/EpisodeDocument');
  const storage = require('../src/services/documentStorage');
  const audit = require('../src/services/auditService');
  /* eslint-enable global-require */

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

  const report = {
    inspected: live.length,
    objects: objectKeys.size,
    missing: missing.map((d) => ({ id: String(d._id), status: d.status, storageKey: d.storageKey })),
    unreadable: unreadable.map((d) => ({ id: String(d._id), status: d.status })),
    integrity: integrity.map((d) => ({ id: String(d._id), status: d.status })),
    orphans,
    applied: false,
    operator: null,
    repaired: { documents: 0, orphans: 0 },
  };

  if (!apply) return report;

  report.applied = true;
  report.operator = operator;

  // A document whose bytes cannot be trusted must stop being `ready`, and the
  // reason is recorded per document so an operator can tell a lost object from a
  // tampered one. Nothing is deleted here: the metadata and any surviving object
  // are left for the next restore or a human decision.
  const toFail = [
    ...missing.map((doc) => ({ doc, reason: 'missing-object' })),
    ...unreadable.map((doc) => ({ doc, reason: 'unreadable-object' })),
    ...integrity.map((doc) => ({ doc, reason: 'integrity-mismatch' })),
  ];
  for (const { doc, reason } of toFail) {
    // eslint-disable-next-line no-await-in-loop
    await EpisodeDocument.updateOne({ _id: doc._id }, { $set: { status: 'failed' } });
    // eslint-disable-next-line no-await-in-loop
    await audit.record({
      clinic: doc.clinic,
      actorLabel: operator,
      action: 'document.reconciled.failed',
      category: 'admin',
      targetType: 'episode_document',
      targetId: String(doc._id),
      outcome: 'success',
      detail: { reason },
    });
    report.repaired.documents += 1;
    if (log) log(`    failed: ${doc._id} (${reason})`);
  }

  // An orphan object is bytes with no metadata row, which no restore can attach
  // to anything: removing it is the only repair that keeps the store and the
  // database in step.
  for (const key of orphans) {
    // eslint-disable-next-line no-await-in-loop
    await storage.remove(key);
    // eslint-disable-next-line no-await-in-loop
    await audit.record({
      actorLabel: operator,
      action: 'document.reconciled.orphan-removed',
      category: 'admin',
      targetType: 'episode_document',
      targetId: key,
      outcome: 'success',
      detail: {},
    });
    report.repaired.orphans += 1;
    if (log) log(`    orphan removed: ${key}`);
  }

  return report;
}

function printReport(report) {
  const write = (line) => process.stdout.write(`${line}\n`);
  write('Document reconciliation report');
  write(`  metadata rows (live):   ${report.inspected}`);
  write(`  stored objects:         ${report.objects}`);
  write(`  missing objects:        ${report.missing.length}`);
  write(`  unreadable objects:     ${report.unreadable.length}`);
  write(`  integrity mismatches:   ${report.integrity.length}`);
  write(`  orphan objects:         ${report.orphans.length}`);
  for (const doc of report.missing) write(`    missing: ${doc.id} (${doc.status}) key ${doc.storageKey}`);
  for (const doc of report.integrity) write(`    integrity: ${doc.id}`);
  for (const doc of report.unreadable) write(`    unreadable: ${doc.id}`);
  for (const key of report.orphans) write(`    orphan: ${key}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  /* eslint-disable global-require */
  const { loadEnv, getEnv } = require('../src/config/env');
  const { connectDb, disconnectDb } = require('../src/config/db');
  /* eslint-enable global-require */

  loadEnv();
  await connectDb(getEnv().MONGODB_URI);

  const report = await reconcile({
    apply: args.apply,
    operator: args.operator,
    log: (line) => process.stdout.write(`${line}\n`),
  });

  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printReport(report);

  if (!report.applied) {
    process.stdout.write(
      '\nDRY RUN: nothing changed. Re-run with --apply --operator <email> to repair.\n'
    );
  } else {
    process.stdout.write(
      `\nAPPLIED by ${report.operator}: ${report.repaired.documents} document(s) failed, ` +
        `${report.repaired.orphans} orphan object(s) removed, all audited.\n`
    );
  }

  await disconnectDb();
}

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`reconcile failed: ${err.message}\n`);
    try {
      // eslint-disable-next-line global-require
      await require('../src/config/db').disconnectDb();
    } catch {
      // ignore
    }
    // A refusal is not a crash: exit 2 for a missing operator, 1 for anything else.
    process.exit(err.code === 'OPERATOR_REQUIRED' ? 2 : 1);
  });
}

module.exports = { reconcile, sha256, parseArgs };
